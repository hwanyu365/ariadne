"""scrape 를 창에서 돌린다. 수집 로직은 scrape.py 에 있고 여기는 입력·로그·진행 상태·중지만 맡는다."""

import json
import os
import queue
import re
import sys
import threading
import time
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog

import customtkinter as ctk

import scrape as core

TEXT_FIELDS = [
    ("url", "URL"),
    ("sel", "수집 대상 셀렉터"),
    ("next", "next 버튼 셀렉터"),
    ("title", "제목 셀렉터 (텍스트 모드, 선택)"),
    ("charset", "인코딩 (비우면 브라우저 추정)"),
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
    text["charset"] = core.check_charset(text["charset"])
    nums = {}
    for key, label, _ in NUM_FIELDS:
        value = raw[key].strip() or "0"
        try:
            nums[key] = int(value)
        except ValueError:
            raise ValueError(f"{label} 은 숫자여야 한다: {value!r}") from None
    return text, nums


SETTINGS_PATH = Path(os.environ.get("APPDATA") or Path.home()) / "ariadne" / "settings.json"
STR_SETTINGS = [k for k, _ in TEXT_FIELDS] + [k for k, _, _ in NUM_FIELDS]


def load_settings(path):
    """저장된 입력값 중 아는 키·맞는 타입만 돌려준다. 파일 때문에 앱이 안 켜지는 일은 없어야 한다."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    got = {k: data[k] for k in STR_SETTINGS if isinstance(data.get(k), str)}
    if data.get("mode") in HINT:
        got["mode"] = data["mode"]
    if isinstance(data.get("headful"), bool):
        got["headful"] = data["headful"]
    return got


def save_settings(path, values):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")


PAGE_LINE = re.compile(r"^\[(\d+)\] .* -> (.+)$")


def progress(line):
    """코어의 페이지 저장 로그에서 (받은 페이지 수, 파일명) 을 읽는다."""
    m = PAGE_LINE.match(line)
    return (int(m[1]), m[2]) if m else None


def log_level(line):
    s = line.lstrip()
    if s.startswith("실패"):
        return "error"
    if s.startswith(("경고", "주의", "건너뜀")):
        return "warn"
    if s.startswith("중단"):
        return "info"
    return None


MODES = {"텍스트": "text", "이미지": "image"}
DEFAULT_PREFIX = str(Path.home() / "Downloads" / "ariadne" / "page")
ICON = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "assets" / "ariadne.ico"
# 라이트·다크 양쪽 배경에서 읽히는 중간 톤을 쓴다.
LOG_COLORS = {"warn": "#d4a017", "error": "#e5534b", "info": "#4c8ed9"}
MUTED = ("gray40", "gray65")


class App:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.stop = threading.Event()
        self.running = False
        self.failed = False
        self.started = 0.0
        self.vars = {}
        saved = load_settings(SETTINGS_PATH)

        root.title("ariadne")
        root.geometry("800x900")
        root.minsize(680, 700)
        if sys.platform == "win32" and ICON.exists():
            root.iconbitmap(str(ICON))
        root.columnconfigure(0, weight=1)
        root.rowconfigure(5, weight=1)

        for key, _ in TEXT_FIELDS:
            self.vars[key] = tk.StringVar(value=saved.get(key, DEFAULT_PREFIX if key == "prefix" else ""))
        for key, _, default in NUM_FIELDS:
            self.vars[key] = tk.StringVar(value=saved.get(key, default))
        self.mode = tk.StringVar(value=saved.get("mode", "text"))
        self.headful = tk.BooleanVar(value=saved.get("headful", False))

        self._header(root).grid(row=0, column=0, sticky="ew", padx=16, pady=(14, 6))
        self._selectors(root).grid(row=1, column=0, sticky="ew", padx=16, pady=6)
        self._output(root).grid(row=2, column=0, sticky="ew", padx=16, pady=6)
        self._advanced(root).grid(row=3, column=0, sticky="ew", padx=16, pady=6)
        self._actions(root).grid(row=4, column=0, sticky="ew", padx=16, pady=(6, 8))

        self.log = ctk.CTkTextbox(root, wrap="word", font=ctk.CTkFont(family="Consolas", size=12))
        self.log.grid(row=5, column=0, sticky="nsew", padx=16)
        self.log.configure(state="disabled")
        for tag, color in LOG_COLORS.items():
            self.log.tag_config(tag, foreground=color)

        self._statusbar(root).grid(row=6, column=0, sticky="ew", padx=16, pady=(6, 10))

        root.bind("<Control-Return>", lambda e: self._start(probe=False))
        root.bind("<Escape>", lambda e: self.stop.set())
        root.protocol("WM_DELETE_WINDOW", self._close)
        root.after(100, self._drain)
        self._on_mode()

    # ---- 화면 구성

    def _card(self, parent, title, buttons=()):
        card = ctk.CTkFrame(parent)
        card.columnconfigure(1, weight=1)
        head = ctk.CTkFrame(card, fg_color="transparent")
        head.grid(row=0, column=0, columnspan=3, sticky="ew", padx=12, pady=(10, 4))
        ctk.CTkLabel(head, text=title, font=ctk.CTkFont(size=14, weight="bold")).pack(side="left")
        for text, cmd in reversed(buttons):
            b = ctk.CTkButton(head, text=text, command=cmd, width=84, height=28,
                              fg_color="transparent", border_width=1, text_color=("gray10", "gray90"))
            b.pack(side="right", padx=(6, 0))
            self.busy_buttons.append(b)
        return card

    def _field(self, card, row, label, key, caption=None):
        ctk.CTkLabel(card, text=label, anchor="w").grid(row=row, column=0, sticky="w", padx=(12, 8), pady=4)
        entry = ctk.CTkEntry(card, textvariable=self.vars[key])
        entry.grid(row=row, column=1, sticky="ew", padx=(0, 12), pady=4)
        if caption is not None:
            caption.grid(row=row + 1, column=1, sticky="w", padx=(2, 12), pady=(0, 4))
        return entry

    def _header(self, root):
        self.busy_buttons = []
        box = ctk.CTkFrame(root, fg_color="transparent")
        box.columnconfigure(0, weight=1)
        ctk.CTkLabel(box, text="ariadne", font=ctk.CTkFont(size=22, weight="bold")).grid(row=0, column=0, sticky="w")
        ctk.CTkLabel(box, text="페이지네이션을 끝까지 넘기며 본문과 이미지를 받아 둡니다",
                     text_color=MUTED).grid(row=1, column=0, sticky="w")
        url = ctk.CTkEntry(box, textvariable=self.vars["url"], height=36,
                           font=ctk.CTkFont(size=14))
        url.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        self.mode_btn = ctk.CTkSegmentedButton(
            box, values=list(MODES), command=lambda v: self._set_mode(MODES[v]), height=36)
        self.mode_btn.grid(row=2, column=1, padx=(8, 0), pady=(10, 0))
        url.focus_set()
        return box

    def _selectors(self, root):
        card = self._card(root, "셀렉터", buttons=(("요소 선택", self._start_pick),
                                                 ("probe", lambda: self._start(probe=True))))
        self.hint = ctk.CTkLabel(card, text="", text_color=MUTED, font=ctk.CTkFont(size=11))
        self._field(card, 1, "수집 대상", "sel", caption=self.hint)
        self._field(card, 3, "next 버튼", "next")
        self.title_label = ctk.CTkLabel(card, text="제목 (선택)", anchor="w")
        self.title_label.grid(row=4, column=0, sticky="w", padx=(12, 8), pady=(4, 12))
        self.title_entry = ctk.CTkEntry(card, textvariable=self.vars["title"])
        self.title_entry.grid(row=4, column=1, sticky="ew", padx=(0, 12), pady=(4, 12))
        return card

    def _output(self, root):
        card = self._card(root, "저장")
        self._field(card, 1, "경로 접두사", "prefix",
                    caption=ctk.CTkLabel(card, text="…/page → page_0001.txt", text_color=MUTED,
                                         font=ctk.CTkFont(size=11)))
        btns = ctk.CTkFrame(card, fg_color="transparent")
        btns.grid(row=1, column=2, padx=(0, 12))
        ctk.CTkButton(btns, text="폴더 선택", width=78, command=self._pick_dir).pack(side="left")
        ctk.CTkButton(btns, text="열기", width=56, command=self._open_dir, fg_color="transparent",
                      border_width=1, text_color=("gray10", "gray90")).pack(side="left", padx=(6, 0))
        return card

    def _advanced(self, root):
        box = ctk.CTkFrame(root, fg_color="transparent")
        box.columnconfigure(0, weight=1)
        self.adv_toggle = ctk.CTkButton(box, text="고급 옵션 ▸", anchor="w", width=120, height=26,
                                        fg_color="transparent", text_color=MUTED,
                                        hover_color=("gray85", "gray25"), command=self._toggle_advanced)
        self.adv_toggle.grid(row=0, column=0, sticky="w")
        self.adv = ctk.CTkFrame(box)
        enc = ctk.CTkFrame(self.adv, fg_color="transparent")
        enc.grid(row=0, column=0, columnspan=6, sticky="ew", padx=12, pady=(10, 4))
        ctk.CTkLabel(enc, text="인코딩").pack(side="left")
        ctk.CTkEntry(enc, textvariable=self.vars["charset"], width=110).pack(side="left", padx=8)
        ctk.CTkLabel(enc, text="비우면 브라우저가 추정. 한글이 깨지면 utf-8", text_color=MUTED,
                     font=ctk.CTkFont(size=11)).pack(side="left")
        ctk.CTkSwitch(enc, text="브라우저 창 띄우기", variable=self.headful).pack(side="right")
        for i, (key, label, _) in enumerate(NUM_FIELDS):
            r, c = 1 + i // 3, (i % 3) * 2
            ctk.CTkLabel(self.adv, text=label, anchor="w").grid(row=r, column=c, sticky="w", padx=(12, 6), pady=4)
            ctk.CTkEntry(self.adv, textvariable=self.vars[key], width=80).grid(row=r, column=c + 1, sticky="w", pady=4)
        ctk.CTkFrame(self.adv, fg_color="transparent", height=6).grid(row=3, column=0)
        return box

    def _actions(self, root):
        box = ctk.CTkFrame(root, fg_color="transparent")
        box.columnconfigure(0, weight=1)
        self.btn_run = ctk.CTkButton(box, text="수집 시작   Ctrl+Enter", height=42,
                                     font=ctk.CTkFont(size=15, weight="bold"),
                                     command=lambda: self._start(probe=False))
        self.btn_run.grid(row=0, column=0, sticky="ew")
        self.btn_stop = ctk.CTkButton(box, text="중지   Esc", height=42, width=120, state="disabled",
                                      fg_color=("gray75", "gray30"), hover_color=("gray65", "gray35"),
                                      text_color=("gray10", "gray90"), text_color_disabled=("gray45", "gray55"),
                                      command=self.stop.set)
        self.btn_stop.grid(row=0, column=1, padx=(8, 0))
        self.busy_buttons.append(self.btn_run)
        return box

    def _statusbar(self, root):
        bar = ctk.CTkFrame(root, fg_color="transparent")
        bar.columnconfigure(2, weight=1)
        self.st_state = ctk.CTkLabel(bar, text="● 대기", text_color=MUTED)
        self.st_pages = ctk.CTkLabel(bar, text="", text_color=MUTED)
        self.st_file = ctk.CTkLabel(bar, text="", text_color=MUTED, anchor="w")
        self.st_time = ctk.CTkLabel(bar, text="", text_color=MUTED)
        for i, w in enumerate((self.st_state, self.st_pages, self.st_file, self.st_time)):
            w.grid(row=0, column=i, sticky="ew" if i == 2 else "w", padx=(0, 16))
        return bar

    # ---- 동작

    def _set_mode(self, mode):
        self.mode.set(mode)
        self._on_mode()

    def _on_mode(self):
        mode = self.mode.get()
        self.mode_btn.set(next(k for k, v in MODES.items() if v == mode))
        self.hint.configure(text=HINT[mode])
        state = "normal" if mode == "text" else "disabled"
        self.title_entry.configure(state=state)
        self.title_label.configure(text_color=("gray10", "gray90") if mode == "text" else MUTED)

    def _toggle_advanced(self):
        if self.adv.winfo_ismapped():
            self.adv.grid_remove()
            self.adv_toggle.configure(text="고급 옵션 ▸")
        else:
            self.adv.grid(row=1, column=0, sticky="ew", pady=(4, 0))
            self.adv_toggle.configure(text="고급 옵션 ▾")

    def _pick_dir(self):
        d = filedialog.askdirectory()
        if d:
            self.vars["prefix"].set(str(Path(d) / "page"))

    def _open_dir(self):
        d = Path(self.vars["prefix"].get().strip() or DEFAULT_PREFIX).expanduser().absolute().parent
        if not d.is_dir():
            self._write(f"아직 폴더가 없다: {d}")
            return
        if hasattr(os, "startfile"):
            os.startfile(d)
        else:
            webbrowser.open(d.as_uri())

    def _write(self, msg):
        got = progress(msg)
        if got:
            pages, name = got
            self.st_pages.configure(text=f"{pages}페이지")
            self.st_file.configure(text=name)
        level = log_level(msg)
        if level == "error":
            self.failed = True
        self.log.configure(state="normal")
        self.log.insert("end", f"{msg}\n", level or ())
        self.log.configure(state="disabled")
        self.log.see("end")

    def _clear(self):
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    def _drain(self):
        try:
            while True:
                msg = self.q.get_nowait()
                if msg is None:
                    self._set_running(None)
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

    def _set_running(self, label):
        """label 이 있으면 그 작업을 시작한 상태로, None 이면 끝난 상태로 바꾼다."""
        self.running = label is not None
        state = "disabled" if self.running else "normal"
        for b in self.busy_buttons:
            b.configure(state=state)
        self.btn_stop.configure(state="normal" if self.running else "disabled")
        if self.running:
            self.failed = False
            self.started = time.monotonic()
            self.st_state.configure(text=f"● {label}", text_color=LOG_COLORS["info"])
            self.st_pages.configure(text="")
            self.st_file.configure(text="")
            self._tick()
            return
        self._tick()
        if self.failed:
            self.st_state.configure(text="● 실패", text_color=LOG_COLORS["error"])
        else:
            self.st_state.configure(text="● 중지됨" if self.stop.is_set() else "● 완료", text_color=MUTED)

    def _tick(self):
        s = int(time.monotonic() - self.started)
        self.st_time.configure(text=f"{s // 60:02d}:{s % 60:02d}")
        if self.running:
            self.root.after(1000, self._tick)

    def _args(self, probe):
        return parse_inputs({k: v.get() for k, v in self.vars.items()}, probe)

    def _apply_pick(self, payload):
        got = pick_update(payload)
        if not got:
            return
        key, sel, line = got
        self.vars[key].set(sel)
        self._write(line)

    def _begin(self, label, probe):
        """입력을 검증하고 작업 상태로 바꾼다. 실패하면 사유를 로그에 쓰고 None."""
        if self.running:
            return None
        self._clear()
        try:
            args = self._args(probe)
        except ValueError as e:
            self._write(f"실패: {e}")
            self.st_state.configure(text="● 입력 확인", text_color=LOG_COLORS["warn"])
            return None
        self.stop.clear()
        self._set_running(label)
        return args

    def _start_pick(self):
        args = self._begin("요소 선택 중", probe=True)        # 선택기는 URL 만 있으면 된다
        if args:
            first = "이미지" if self.mode.get() == "image" else "본문"
            threading.Thread(target=self._run_pick, args=(*args, first), daemon=True).start()

    def _run_pick(self, text, nums, first):
        log = self.q.put
        try:
            core.pick(text["url"], self.q.put, timeout=nums["timeout"],
                      targets=(first, "next", "제목"), on_log=log,
                      should_stop=self.stop.is_set, charset=text["charset"])
        except Exception as e:
            log(f"실패: {type(e).__name__}: {str(e).splitlines()[0]}")
        finally:
            log(None)

    def _start(self, probe):
        args = self._begin("probe 중" if probe else "수집 중", probe)
        if args:
            opts = {"probe": probe, "headful": self.headful.get(), "mode": self.mode.get()}
            threading.Thread(target=self._run, args=(*args, opts), daemon=True).start()

    def _run(self, text, nums, opts):
        log = self.q.put
        try:
            if opts["probe"]:
                log("probe 중... 브라우저 창을 띄웠으면 확인한 뒤 [중지] 를 누르면 닫힌다.")
                core.probe(text["url"], text["sel"] or None, text["next"] or None,
                           timeout=nums["timeout"], headful=opts["headful"],
                           title_sel=text["title"] or None, delay=nums["delay"],
                           on_log=log, pause=self.stop.wait, charset=text["charset"])
            else:
                n = core.scrape(text["url"], text["sel"], text["next"], text["prefix"],
                                max_pages=nums["max"], timeout=nums["timeout"],
                                headful=opts["headful"], delay=nums["delay"],
                                digits=nums["digits"], start=nums["start"],
                                title_sel=text["title"] or None, mode=opts["mode"],
                                on_log=log, stop=self.stop, charset=text["charset"])
                log(f"완료: {n}개 페이지")
        except Exception as e:
            # 워커에서 죽으면 창이 멈춘 것처럼 보인다. 사유를 로그로 돌려주고 버튼을 되살린다.
            log(f"실패: {type(e).__name__}: {str(e).splitlines()[0]}")
        finally:
            log(None)

    def _close(self):
        self.stop.set()
        values = {k: v.get() for k, v in self.vars.items()}
        values.update(mode=self.mode.get(), headful=self.headful.get())
        try:
            save_settings(SETTINGS_PATH, values)
        except OSError:
            pass                  # 설정을 못 남겨도 창은 닫혀야 한다
        self.root.destroy()


def main():
    ctk.set_appearance_mode("system")
    if sys.platform == "win32":
        # 기본 글꼴(Roboto)에는 한글이 없어 글자마다 대체 글꼴이 섞인다.
        ctk.ThemeManager.theme["CTkFont"]["family"] = "Malgun Gothic"
    root = ctk.CTk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
