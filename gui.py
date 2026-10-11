"""scrape 를 tkinter 창에서 돌린다. 수집 로직은 scrape.py 에 있고 여기는 입력·로그·중지만 맡는다."""

import queue
import threading
import tkinter as tk
from tkinter import filedialog, scrolledtext, ttk

import scrape as core

TEXT_FIELDS = [
    ("url", "URL"),
    ("sel", "수집 대상 셀렉터"),
    ("next", "next 버튼 셀렉터"),
    ("title", "제목 셀렉터 (텍스트 모드, 선택)"),
    ("prefix", "저장 경로 접두사"),
]

NUM_FIELDS = [
    ("max", "최대 페이지 (0=끝까지)", "0"),
    ("start", "시작 번호", "1"),
    ("digits", "자릿수", "4"),
    ("timeout", "타임아웃 ms", "15000"),
    ("delay", "페이지 간 대기 ms", "0"),
]

# 선택기 툴바의 대상 이름을 입력란에 잇는다. 이미지 모드는 같은 칸에 이미지 셀렉터를 받는다.
PICK_TARGETS = {"본문": "sel", "이미지": "sel", "next": "next", "제목": "title"}


def pick_update(payload):
    """선택기가 보낸 값을 (입력란 키, 셀렉터, 로그 줄) 로 바꾼다. 맞지 않으면 None.

    `expose_function` 으로 연 창구라 대상 페이지의 스크립트도 호출할 수 있다 → 형태를 전부 확인한다.
    """
    if not isinstance(payload, dict):
        return None
    target = payload.get("target")
    key = PICK_TARGETS.get(target) if isinstance(target, str) else None
    sel = payload.get("sel")
    if not key or not isinstance(sel, str) or not sel.strip():
        return None
    raw = payload.get("candidates")
    cands = raw if isinstance(raw, list) else []
    parts = [f"{c['sel']}({c['n']})" for c in cands
             if isinstance(c, dict) and isinstance(c.get("sel"), str) and isinstance(c.get("n"), int)]
    tail = f"   후보: {'  '.join(parts)}" if parts else ""
    return key, sel.strip(), f"[{target}] {sel.strip()}{tail}"

HINT = {
    "text": "본문이 들어 있는 컨테이너 (예: #articleBody)",
    "image": "이미지 요소까지 지정한다 (예: #articleBody img)",
}


def parse_inputs(raw, probe):
    """입력 문자열을 코어 인자로 바꾼다. 비면 사유를 ValueError 로 올려 로그에 띄운다."""
    text = {k: raw[k].strip() for k, _ in TEXT_FIELDS}
    if not text["url"]:
        raise ValueError("URL 을 입력하라.")
    if not probe and not (text["sel"] and text["next"]):
        raise ValueError("수집 대상과 next 셀렉터가 필요하다. 모르면 probe 로 후보를 먼저 보라.")
    nums = {}
    for key, label, _ in NUM_FIELDS:
        value = raw[key].strip() or "0"
        try:
            nums[key] = int(value)
        except ValueError:
            raise ValueError(f"{label} 은 숫자여야 한다: {value!r}") from None
    return text, nums


class App:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.stop = threading.Event()
        self.vars = {}
        root.title("pagenation")
        root.columnconfigure(0, weight=1)
        root.rowconfigure(1, weight=1)

        form = ttk.Frame(root, padding=8)
        form.grid(row=0, column=0, sticky="ew")
        form.columnconfigure(1, weight=1)

        for i, (key, label) in enumerate(TEXT_FIELDS):
            ttk.Label(form, text=label).grid(row=i, column=0, sticky="w", pady=2)
            self.vars[key] = tk.StringVar(value="out/page" if key == "prefix" else "")
            ttk.Entry(form, textvariable=self.vars[key]).grid(row=i, column=1, sticky="ew", padx=6)
        ttk.Button(form, text="폴더...", command=self._pick_dir, width=8).grid(
            row=len(TEXT_FIELDS) - 1, column=2)

        self.hint = ttk.Label(form, text=HINT["text"], foreground="#666")
        self.hint.grid(row=1, column=2, sticky="w")

        opts = ttk.Frame(form)
        opts.grid(row=len(TEXT_FIELDS), column=0, columnspan=3, sticky="w", pady=(8, 0))
        for key, label, default in NUM_FIELDS:
            self.vars[key] = tk.StringVar(value=default)
            ttk.Label(opts, text=label).pack(side="left")
            ttk.Entry(opts, textvariable=self.vars[key], width=7).pack(side="left", padx=(4, 12))

        row = ttk.Frame(form)
        row.grid(row=len(TEXT_FIELDS) + 1, column=0, columnspan=3, sticky="w", pady=(8, 0))
        self.mode = tk.StringVar(value="text")
        ttk.Label(row, text="모드").pack(side="left")
        for value, label in (("text", "텍스트"), ("image", "이미지")):
            ttk.Radiobutton(row, text=label, value=value, variable=self.mode,
                            command=self._on_mode).pack(side="left", padx=4)
        self.headful = tk.BooleanVar(value=False)
        ttk.Checkbutton(row, text="브라우저 창 띄우기", variable=self.headful).pack(side="left", padx=12)

        self.btn_pick = ttk.Button(row, text="요소 선택", command=self._start_pick)
        self.btn_probe = ttk.Button(row, text="probe", command=lambda: self._start(probe=True))
        self.btn_run = ttk.Button(row, text="수집 시작", command=lambda: self._start(probe=False))
        self.btn_stop = ttk.Button(row, text="중지", command=self.stop.set, state="disabled")
        for b in (self.btn_pick, self.btn_probe, self.btn_run, self.btn_stop):
            b.pack(side="left", padx=4)

        self.log = scrolledtext.ScrolledText(root, height=20, wrap="word")
        self.log.grid(row=1, column=0, sticky="nsew", padx=8, pady=(0, 8))

        root.protocol("WM_DELETE_WINDOW", self._close)
        root.after(100, self._drain)

    def _on_mode(self):
        self.hint.config(text=HINT[self.mode.get()])

    def _pick_dir(self):
        d = filedialog.askdirectory()
        if d:
            self.vars["prefix"].set(f"{d}/page")

    def _write(self, msg):
        self.log.insert("end", f"{msg}\n")
        self.log.see("end")

    def _drain(self):
        try:
            while True:
                msg = self.q.get_nowait()
                if msg is None:
                    self._set_running(False)
                elif isinstance(msg, dict):
                    self._apply_pick(msg)
                else:
                    self._write(msg)
        except queue.Empty:
            pass
        except Exception as e:
            self._write(f"로그 처리 실패: {type(e).__name__}: {e}")
        finally:
            # 여기서 끊기면 이후 로그가 영영 안 뜬다. 무슨 일이 있어도 다시 건다.
            self.root.after(100, self._drain)

    def _set_running(self, running):
        state = "disabled" if running else "normal"
        self.btn_pick.config(state=state)
        self.btn_probe.config(state=state)
        self.btn_run.config(state=state)
        self.btn_stop.config(state="normal" if running else "disabled")

    def _args(self, probe):
        return parse_inputs({k: v.get() for k, v in self.vars.items()}, probe)

    def _apply_pick(self, payload):
        got = pick_update(payload)
        if not got:
            return
        key, sel, line = got
        self.vars[key].set(sel)
        self._write(line)

    def _start_pick(self):
        self.log.delete("1.0", "end")
        try:
            text, nums = self._args(probe=True)        # 선택기는 URL 만 있으면 된다
        except ValueError as e:
            self._write(str(e))
            return
        self.stop.clear()
        self._set_running(True)
        threading.Thread(target=self._run_pick, args=(text, nums), daemon=True).start()

    def _run_pick(self, text, nums):
        log = self.q.put
        first = "이미지" if self.mode.get() == "image" else "본문"
        try:
            core.pick(text["url"], self.q.put, timeout=nums["timeout"],
                      targets=(first, "next", "제목"), on_log=log,
                      should_stop=self.stop.is_set)
        except Exception as e:
            log(f"실패: {type(e).__name__}: {str(e).splitlines()[0]}")
        finally:
            log(None)

    def _start(self, probe):
        self.log.delete("1.0", "end")
        try:
            text, nums = self._args(probe)
        except ValueError as e:
            self._write(str(e))
            return
        self.stop.clear()
        self._set_running(True)
        threading.Thread(target=self._run, args=(probe, text, nums), daemon=True).start()

    def _run(self, probe, text, nums):
        log = self.q.put
        try:
            if probe:
                log("probe 중... 브라우저 창을 띄웠으면 확인한 뒤 [중지] 를 누르면 닫힌다.")
                core.probe(text["url"], text["sel"] or None, text["next"] or None,
                           timeout=nums["timeout"], headful=self.headful.get(),
                           title_sel=text["title"] or None, delay=nums["delay"],
                           on_log=log, pause=self.stop.wait)
            else:
                n = core.scrape(text["url"], text["sel"], text["next"], text["prefix"],
                                max_pages=nums["max"], timeout=nums["timeout"],
                                headful=self.headful.get(), delay=nums["delay"],
                                digits=nums["digits"], start=nums["start"],
                                title_sel=text["title"] or None, mode=self.mode.get(),
                                on_log=log, stop=self.stop)
                log(f"완료: {n}개 페이지")
        except Exception as e:
            # 워커에서 죽으면 창이 멈춘 것처럼 보인다. 사유를 로그로 돌려주고 버튼을 되살린다.
            log(f"실패: {type(e).__name__}: {str(e).splitlines()[0]}")
        finally:
            log(None)

    def _close(self):
        self.stop.set()
        self.root.destroy()


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
