"""페이지네이션된 웹 페이지를 끝까지 넘기며 본문 텍스트나 이미지를 로컬 파일로 저장한다."""

import argparse
import base64
import json
import mimetypes
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.sync_api import Error as PWError
from playwright.sync_api import sync_playwright

# 윈도우 콘솔 기본 cp949 에서 한글 로그가 깨진다.
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp")


def _stderr(msg):
    print(msg, file=sys.stderr)


def check_charset(name):
    """비었으면 None. 이름이 응답 헤더에 그대로 들어가므로 모르는 이름은 여기서 막는다."""
    name = name.strip()
    if not name:
        return None
    # codecs 는 이름의 공백·개행을 _ 로 정규화해 받아 준다 → 헤더에 넣기 전에 문자 집합부터 거른다.
    if not re.fullmatch(r"[A-Za-z0-9._:-]+", name):
        raise ValueError(f"알 수 없는 인코딩: {name!r} (예: utf-8, euc-kr)")
    try:
        "".encode(name)                     # 모르는 이름과 base64 같은 비텍스트 코덱을 함께 거부한다
    except LookupError:
        raise ValueError(f"알 수 없는 인코딩: {name!r} (예: utf-8, euc-kr)") from None
    return name


def charset_warning(page, body, charset=None):
    """틀린 인코딩으로 읽어도 수집은 깨진 채 성공한다 → 조용히 지나가지 않게 로그 문구를 만든다."""
    # 브라우저가 고른 인코딩 이름으로는 판정할 수 없다. 선언이 없을 때 쓰는 기본값이 창 모드·OS 로캘에 따라 바뀐다.
    # 비ASCII 를 담은 올바른 UTF-8 바이트가 다른 인코딩의 글이기는 어렵다 → 원래 바이트로 판정한다.
    actual = page.evaluate("document.characterSet")
    if actual == "UTF-8" or body.isascii():
        return None
    try:
        body.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if charset:
        return f"  경고: 페이지는 utf-8 로 보이는데 지정한 인코딩 {charset!r} 로 받아 {actual} 로 읽었다. 인코딩을 utf-8 로 지정하라."
    return f"  경고: 페이지는 utf-8 로 보이는데 브라우저가 {actual} 로 읽었다. 글자가 깨졌으면 인코딩을 utf-8 로 지정해 다시 받아라."


def new_page(browser, charset=None):
    """(페이지, 메인 문서의 원래 바이트를 돌려주는 함수). charset 을 주면 문서 응답의 charset 을 바꿔 브라우저의 인코딩 추정을 건너뛴다."""
    page = browser.new_page()
    docs = []

    def keep(read):
        docs[:] = [read]              # 수백 페이지를 넘기는 동안 지난 문서를 쥐고 있지 않는다

    def doc():
        try:
            return docs[-1]() if docs else b""
        except PWError:
            return b""                # 본문을 못 얻으면 판정하지 않는다. 경고는 부가 정보라 수집을 멈출 이유가 못 된다

    if not charset:
        page.on("response", lambda r: r.request.is_navigation_request() and r.frame == page.main_frame
                and keep(r.body))
        return page, doc
    # page.route 는 리다이렉트 체인의 첫 요청만 가로챈다 → 리다이렉트를 거친 문서가 빠진다.
    # CDP Fetch 는 체인의 요청마다 응답 단계에서 멈춘다. 헤더만 바꾸는 continueResponse 는 디코딩에 반영되지 않아 본문째 넘긴다.
    cdp = page.context.new_cdp_session(page)
    # 인코딩이 다른 iframe 까지 덮으면 그쪽이 깨진다 → 메인 프레임 문서만 바꾼다.
    main = cdp.send("Page.getFrameTree")["frameTree"]["frame"]["id"]

    def paused(ev):
        rid = ev["requestId"]
        try:
            if ev.get("frameId") == main and 200 <= (ev.get("responseStatusCode") or 0) < 300:
                cdp.send("Fetch.fulfillRequest", forced(rid, ev))
                return
        except Exception:
            pass                      # 멈춘 요청은 풀어 주지 않으면 타임아웃까지 매달린다 → 실패 종류와 무관하게 원래대로 보낸다
        cdp.send("Fetch.continueRequest", {"requestId": rid})

    def forced(rid, ev):
        got = cdp.send("Fetch.getResponseBody", {"requestId": rid})
        body = got["body"] if got["base64Encoded"] else base64.b64encode(got["body"].encode()).decode()
        # 바꿔 넘긴 응답의 response.body() 는 디코딩 뒤 다시 인코딩한 값이라 원래 바이트를 여기서 남긴다.
        raw = base64.b64decode(body)
        keep(lambda: raw)
        headers, mime = [], "text/html"
        for h in ev.get("responseHeaders", []):
            name = h["name"].lower()
            if name == "content-type":
                mime = h["value"].split(";")[0].strip() or mime
            elif name not in ("content-encoding", "content-length"):   # 받은 본문은 이미 압축이 풀려 있다
                headers.append(h)
        headers.append({"name": "Content-Type", "value": f"{mime}; charset={charset}"})
        return {"requestId": rid, "responseCode": ev["responseStatusCode"], "responseHeaders": headers, "body": body}

    cdp.on("Fetch.requestPaused", paused)
    cdp.send("Fetch.enable", {"patterns": [{"resourceType": "Document", "requestStage": "Response"}]})
    return page, doc


def read_text(page, selector, timeout):
    """selector 에 걸리는 모든 요소의 보이는 텍스트를 합쳐서 돌려준다."""
    page.wait_for_selector(selector, timeout=timeout)
    return "\n".join(t.strip() for t in page.locator(selector).all_inner_texts()).strip()


def read_srcs(page, selector, timeout):
    """selector 에 걸리는 이미지들의 주소를 줄바꿈으로 이어 돌려준다. 페이지 변경 판정도 이 문자열로 한다."""
    # 지연 로딩 이미지는 주소가 붙기 전까지 크기가 0 이라 visible 로는 기다릴 수 없다.
    page.wait_for_selector(selector, timeout=timeout, state="attached")
    srcs = page.locator(selector).evaluate_all(
        # 지연 로딩 사이트는 src 에 placeholder 를 넣고 실제 주소를 data-src 에 둔다.
        "els => els.map(e => e.dataset.src || e.getAttribute('data-src') || e.currentSrc || e.src || '')"
    )
    return "\n".join(s for s in srcs if s and not s.startswith("data:"))


def scroll_all(page, step=800, pause=120):
    """지연 로딩 이미지는 화면에 들어와야 주소가 채워지므로 한 번 훑어 내린다."""
    page.evaluate(
        """async o => {
            for (let y = 0; y < document.body.scrollHeight; y += o.step) {
              window.scrollTo(0, y);
              await new Promise(r => setTimeout(r, o.pause));
            }
            window.scrollTo(0, 0);
        }""",
        {"step": step, "pause": pause},
    )


def read_title(page, selector):
    """제목 셀렉터가 비었거나 안 걸려도 빈 문자열을 돌려준다. 헤더는 부가 정보라 본문 수집을 멈출 이유가 못 된다."""
    if not selector:
        return ""
    loc = page.locator(selector)
    if loc.count() == 0:
        return ""
    return " ".join((loc.first.inner_text() or "").split())


def wait_change(page, selector, old, timeout, read=read_text):
    """SPA 는 next 클릭 후에도 URL·DOM 이 그대로일 수 있어, 수집 대상이 실제로 바뀔 때까지 폴링한다."""
    deadline = time.time() + timeout / 1000
    while time.time() < deadline:
        try:
            cur = read(page, selector, timeout=1000)
        except Exception:
            cur = ""
        if cur and cur != old:
            return cur
        page.wait_for_timeout(200)
    return None


def is_clickable(locator):
    if locator.count() == 0:
        return False
    first = locator.first
    # 마지막 페이지에서 next 를 숨기는 사이트와 비활성화만 하는 사이트가 반반이라 둘 다 본다.
    return (
        first.is_visible()
        and first.is_enabled()
        and first.get_attribute("aria-disabled") != "true"
    )


def goto_next(page, next_sel, timeout):
    """다음 페이지로 넘긴다. 성공하면 None, 못 넘기면 사유 문자열."""
    nxt = page.locator(next_sel)
    if nxt.count() == 0:
        return f"next 셀렉터 {next_sel!r} 에 걸리는 요소가 없다."
    if is_clickable(nxt):
        nxt.first.click()
        return None
    # 숨김·비활성이어도 href 가 살아 있으면 직접 이동한다.
    # 마지막이 아닌 페이지에서도 next 를 CSS 로만 죽여두는 사이트가 있어서, 여기서 포기하면 1페이지만 받고 끝난다.
    href = nxt.first.get_attribute("href") or ""
    if href and not href.startswith(("#", "javascript:")):
        page.goto(urljoin(page.url, href), wait_until="domcontentloaded", timeout=timeout)
        return None
    return "next 요소는 있으나 숨김/비활성이고 href 도 없다. 마지막 페이지로 본다."


def _image_ext(url, content_type):
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in IMAGE_EXTS:
        return suffix
    return mimetypes.guess_extension((content_type or "").split(";")[0].strip()) or ".bin"


def save_images(page, srcs, prefix, num, digits, log):
    """한 페이지의 이미지를 받아 저장하고 저장한 장수를 돌려준다."""
    saved = 0
    for i, src in enumerate(srcs, 1):
        url = urljoin(page.url, src)
        try:
            # 브라우저 컨텍스트로 받아야 쿠키와 referer 가 실려, 핫링크를 막는 사이트에서도 통한다.
            resp = page.request.get(url, headers={"referer": page.url})
            if not resp.ok:
                log(f"  건너뜀 HTTP {resp.status} {url[:80]}")
                continue
            body = resp.body()
            ext = _image_ext(url, resp.headers.get("content-type"))
            out = prefix.with_name(f"{prefix.name}_{num:0{digits}d}_{i:03d}{ext}")
            out.write_bytes(body)
            saved += 1
        except PWError as e:
            log(f"  건너뜀 {url[:80]} ({str(e).splitlines()[0][:60]})")
    return saved


def save_text(page, text, prefix, num, digits, title_sel, log):
    """본문을 파일로 쓰고 (길이, 파일명) 을 돌려준다."""
    body = text
    if title_sel:
        # 제목을 본문에 싣지 않는 사이트가 있어, "{n}화. {제목}" 헤더를 직접 붙인다.
        title = read_title(page, title_sel)
        if not title:
            log(f"  경고: 제목 셀렉터 {title_sel!r} 에 걸리는 요소가 없다.")
        head = f"{num}화. {title}" if title else f"{num}화."
        body = f"{head}\n\n{text}"
    out = prefix.with_name(f"{prefix.name}_{num:0{digits}d}.txt")
    out.write_text(body, encoding="utf-8")
    return len(body), out.name


def scrape(url, sel, next_sel, prefix, max_pages=0, timeout=15000, headful=False, delay=0,
           digits=4, start=1, title_sel=None, mode="text", on_log=None, stop=None, charset=None):
    log = on_log or _stderr
    images = mode == "image"
    read = read_srcs if images else read_text
    prefix = Path(prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    pages = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headful)
        page, doc = new_page(browser, charset)
        page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        if images:
            scroll_all(page)
        current = read(page, sel, timeout)
        warned = images                  # 이미지는 인코딩과 무관하다

        while True:
            pages += 1
            num = start + pages - 1
            # 중간에 끊겨도 여기까지 받은 건 남도록 페이지마다 바로 쓴다.
            if images:
                n = save_images(page, current.splitlines(), prefix, num, digits, log)
                log(f"[{pages}] 이미지 {n}장 -> {prefix.name}_{num:0{digits}d}_*")
            else:
                size, name = save_text(page, current, prefix, num, digits, title_sel, log)
                log(f"[{pages}] {size}자 -> {name}")
                if not warned:
                    # 페이지마다 선언이 다를 수 있어 매번 보되, 같은 경고로 로그를 덮지 않게 한 번만 낸다.
                    warn = charset_warning(page, doc(), charset)
                    if warn:
                        log(warn)
                        warned = True

            if stop is not None and stop.is_set():
                log("  중단: 사용자 중지.")
                break
            if max_pages and pages >= max_pages:
                break
            # 왜 멈췄는지 남긴다. 셀렉터 오타로 1페이지만 받고 끝나는 게 가장 흔한 사고다.
            why = goto_next(page, next_sel, timeout)
            if why:
                hint = " 셀렉터를 --probe 로 확인하라." if pages == 1 else ""
                log(f"  중단: {why}{hint}")
                break
            new = wait_change(page, sel, current, timeout, read)
            if new is None:
                log(f"  중단: next 클릭 후 {timeout}ms 동안 수집 대상이 바뀌지 않았다."
                    " 마지막 페이지거나, 로딩이 느리면 --timeout 을 늘려야 한다.")
                break
            if images:
                # 바뀐 것만 보고 넘어가면 아직 주소가 안 붙은 지연 이미지를 놓친다.
                scroll_all(page)
                new = read(page, sel, timeout)
            current = new
            if delay:
                page.wait_for_timeout(delay)
        browser.close()
    return pages


# 셀렉터를 맞추는 게 이 도구의 유일한 삽질 지점이라, 후보를 찾아주는 진단 모드를 둔다.
_NEXT_CANDIDATES_JS = """() => {
  const sel = el => el.id ? '#' + el.id
    : (typeof el.className === 'string' && el.className.trim()
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase());
  const pat = /다음|next|더보기|▶|›|»|→|>>/i;
  return [...document.querySelectorAll('a, button, input[type=button], input[type=submit]')]
    .filter(e => pat.test((e.innerText || '') + ' ' + (e.title || '') + ' ' + (e.className || '') + ' ' + (e.value || '')))
    .slice(0, 10)
    .map(e => ({ sel: sel(e), text: (e.innerText || e.value || '').trim().slice(0, 20), href: (e.getAttribute('href') || '').slice(0, 60) }));
}"""

_TEXT_CANDIDATES_JS = """() => {
  const sel = el => el.id ? '#' + el.id
    : (typeof el.className === 'string' && el.className.trim()
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase());
  return [...document.querySelectorAll('div, article, section, td, p')]
    .map(e => ({ sel: sel(e), len: (e.innerText || '').trim().length }))
    .filter(x => x.len > 200)
    .sort((a, b) => a.len - b.len)   // 가장 짧은 쪽이 본문에 가장 가까운 컨테이너다
    .slice(0, 6);
}"""

_IMAGE_CANDIDATES_JS = """() => {
  const sel = el => el.id ? '#' + el.id
    : (typeof el.className === 'string' && el.className.trim()
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase());
  const byParent = new Map();
  for (const img of document.querySelectorAll('img')) {
    const p = img.parentElement;
    if (!p) continue;
    const k = sel(p);
    const v = byParent.get(k) || { sel: k + ' img', n: 0, big: 0 };
    v.n++;
    if (img.naturalWidth >= 300) v.big++;
    byParent.set(k, v);
  }
  return [...byParent.values()].sort((a, b) => b.big - a.big || b.n - a.n).slice(0, 6);
}"""


# 아래 두 JS 는 `data-ariadne-ui` 를 공유한다. 선택기가 붙인 요소를 매치 수와 선택 대상에서 빼는 표식이다.
# 클릭한 요소 하나에서 셀렉터 후보를 만든다. 매치 수를 함께 내어 상태 클래스가 섞였는지 드러낸다.
CANDIDATES_JS = """el => {
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
  const classesOf = e => (typeof e.className === 'string'
    ? e.className.trim().split(/\\s+/).filter(Boolean) : []);
  const out = [];
  const add = s => { if (s && out.indexOf(s) < 0) out.push(s); };
  const tag = el.tagName.toLowerCase();

  if (el.id) add('#' + esc(el.id));
  const cs = classesOf(el);
  if (cs.length) {
    add(tag + '.' + cs.map(esc).join('.'));
    if (cs.length > 1) add(tag + '.' + esc(cs[0]));   // 상태 클래스가 섞였을 때를 위한 짧은 쪽
  }
  if (tag === 'img') {
    // 이미지는 그 한 장이 아니라 컨테이너를 집어야 다음 페이지에서도 맞는다.
    const p = el.parentElement;
    if (p) {
      if (p.id) add('#' + esc(p.id) + ' img');
      const pcs = classesOf(p);
      if (pcs.length) add(p.tagName.toLowerCase() + '.' + pcs.map(esc).join('.') + ' img');
    }
  }
  add(tag);

  const count = s => {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(s))
        .filter(e => !e.closest('[data-ariadne-ui]')).length;
    } catch (_) { return 0; }
  };
  return out.map(sel => ({ sel: sel, n: count(sel) }));
}"""

# 하이라이트·툴바를 붙이고 클릭을 가로챈다. 페이지 동작을 바꾸지 않도록 전부 fixed 로 띄운다.
PICKER_JS = """function install(opts) {
  // add_init_script 는 모든 프레임에서 돈다. 광고·임베드마다 툴바가 붙으면 페이지를 쓸 수 없고,
  // iframe 안은 수집 대상도 아니다 (docs/specification.md 제외 범위).
  if (window !== window.top) return;
  const targets = (opts && opts.targets) || ['본문', 'next', '제목'];
  const UI = 'data-ariadne-ui';
  let current = targets[0];

  // add_init_script 는 문서가 생기기 전에 돈다 → 그때는 기다렸다가 붙인다.
  // 가드는 설치가 끝난 뒤에 세운다. 앞에 두면 실패한 설치가 재설치를 막는다.
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', () => install(opts), {once: true});
    return;
  }
  if (window.__ariadnePicker) return;

  const mk = (tag, css) => {
    const e = document.createElement(tag);
    e.setAttribute(UI, '');
    Object.assign(e.style, css);
    return e;
  };

  const box = mk('div', {position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
    border: '2px solid #e11', background: 'rgba(238,17,17,.12)', display: 'none'});
  const bar = mk('div', {position: 'fixed', zIndex: '2147483647',
    maxWidth: '520px', padding: '8px 10px', font: '13px/1.5 sans-serif', color: '#111',
    background: '#fff', border: '1px solid #888', borderRadius: '6px',
    boxShadow: '0 2px 10px rgba(0,0,0,.25)'});
  // 툴바가 고르려는 요소를 덮으면 클릭이 툴바로 간다. 기본은 아래쪽, 겹치면 사용자가 옮긴다.
  let atTop = false;
  const place = () => Object.assign(bar.style, atTop
    ? {left: '12px', right: 'auto', top: '12px', bottom: 'auto'}
    : {left: 'auto', right: '12px', top: 'auto', bottom: '12px'});
  place();
  const head = mk('div', {marginBottom: '4px'});
  const list = mk('div', {});
  bar.appendChild(head); bar.appendChild(list);
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(bar);

  const btn = (label, on, active) => {
    const b = mk('button', {margin: '0 4px 0 0', padding: '2px 8px', cursor: 'pointer',
      font: 'inherit', border: '1px solid #888', borderRadius: '4px',
      background: active ? '#135' : '#eee', color: active ? '#fff' : '#111'});
    b.textContent = label;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); on(); }, true);
    return b;
  };

  const send = payload => { if (window.__ariadne_pick) window.__ariadne_pick(payload); };

  const drawHead = () => {
    head.textContent = '';
    head.appendChild(document.createTextNode('고를 대상: '));
    targets.forEach(t => head.appendChild(btn(t, () => { current = t; drawHead(); }, t === current)));
    head.appendChild(btn('↕ 위치', () => { atTop = !atTop; place(); }, false));
    head.appendChild(btn('완료', () => { if (window.__ariadne_done) window.__ariadne_done(); }, false));
  };

  const drawList = (cands, text) => {
    list.textContent = '';
    if (!cands.length) { list.textContent = '후보를 만들지 못했다.'; return; }
    const t = mk('div', {color: '#555', marginBottom: '2px'});
    t.textContent = text ? '"' + text.slice(0, 40) + '"' : '';
    list.appendChild(t);
    cands.forEach((c, i) => {
      const mark = c.n === 1 ? ' \\u2713' : ' \\u26a0';
      const row = btn(c.sel + ' \\u2014 ' + c.n + '개' + mark,
        () => send({target: current, sel: c.sel, candidates: cands, text: text}), i === 0);
      Object.assign(row.style, {display: 'block', width: '100%', textAlign: 'left', margin: '2px 0'});
      list.appendChild(row);
    });
  };

  document.addEventListener('mouseover', e => {
    if (e.target.closest('[' + UI + ']')) return;
    const r = e.target.getBoundingClientRect();
    Object.assign(box.style, {display: 'block', left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px'});
  }, true);

  document.addEventListener('click', e => {
    if (e.target.closest('[' + UI + ']')) return;   // 툴바 자신의 클릭은 그대로 둔다
    e.preventDefault(); e.stopPropagation();        // 링크 이동과 폼 전송을 막는다
    const el = e.target;
    const cands = window.__ariadneCandidates(el);
    const text = (el.innerText || el.getAttribute('src') || '').trim();
    drawList(cands, text);
    send({target: current, sel: cands.length ? cands[0].sel : '', candidates: cands, text: text});
  }, true);

  drawHead();
  window.__ariadnePicker = true;
}"""


def picker_setup_js(targets=("본문", "next", "제목")):
    """후보 생성 함수와 선택기를 한 번에 세우는 스크립트. 둘을 따로 넣으면 클릭 핸들러가 조용히 죽는다."""
    opts = json.dumps({"targets": list(targets)}, ensure_ascii=False)
    return (f"(() => {{ window.__ariadneCandidates = {CANDIDATES_JS};"
            f" ({PICKER_JS})({opts}); }})()")


def install_picker(page, targets=("본문", "next", "제목")):
    """이미 열려 있는 페이지에 선택기를 세운다."""
    page.evaluate(f"() => {{ {picker_setup_js(targets)} }}")


def pick(url, on_pick, timeout=15000, targets=("본문", "next", "제목"), on_log=None,
         should_stop=None, charset=None):
    """브라우저를 띄우고 사용자가 클릭한 요소의 셀렉터 후보를 on_pick 으로 넘긴다."""
    log = on_log or _stderr
    done = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)   # 사람이 보고 고르는 기능이라 headful 고정
        page, _ = new_page(browser, charset)
        page.expose_function("__ariadne_pick", on_pick)
        page.expose_function("__ariadne_done", lambda: done.append(True))
        # 문서가 바뀔 때마다 다시 세운다. goto 후 한 번만 넣으면 리다이렉트·새로고침에서 선택기가 사라진다.
        page.add_init_script(picker_setup_js(targets))
        page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        install_picker(page, targets)          # add_init_script 가 늦게 걸리는 경우를 위한 보강
        log("요소를 클릭하면 셀렉터 후보가 뜬다. 다 고르면 툴바의 '완료' 또는 [중지] 를 누른다.")
        # 콜백은 페이지를 기다리는 동안에만 들어온다. 그냥 sleep 으로 막으면 클릭이 전달되지 않는다.
        while not done and not (should_stop and should_stop()):
            try:
                page.wait_for_timeout(200)
            except PWError:
                break                                 # 사용자가 창을 직접 닫은 경우
        browser.close()


def probe(url, sel, next_sel, timeout=15000, headful=False, title_sel=None, delay=0,
          on_log=None, pause=input, charset=None):
    log = on_log or print
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headful)
        page, doc = new_page(browser, charset)
        page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        page.wait_for_timeout(1500 + delay)  # 지연 렌더되는 본문을 놓치지 않도록. 더 느리면 --delay 로 늘린다.
        scroll_all(page)

        log(f"인코딩: {page.evaluate('document.characterSet')}")
        warn = charset_warning(page, doc(), charset)
        if warn:
            log(warn)

        for name, s in (("-t 수집 대상", sel), ("-n next", next_sel), ("-T 제목", title_sel)):
            if not s:
                continue
            loc = page.locator(s)
            cnt = loc.count()
            log(f"\n{name} {s!r} -> {cnt}개 매치")
            for i in range(min(cnt, 3)):
                el = loc.nth(i)
                preview = el.get_attribute("src") or el.inner_text() or ""
                log(f"    [{i}] {' '.join(preview.split())[:70]!r}")

        frames = [f for f in page.frames if f != page.main_frame]
        if frames:
            log(f"\n주의: iframe {len(frames)}개. 본문이 그 안에 있으면 이 스크립트로는 못 잡는다.")
            for f in frames[:5]:
                log(f"    {f.url[:90]}")

        log("\n[next 버튼 후보]")
        for c in page.evaluate(_NEXT_CANDIDATES_JS):
            log(f"    {c['sel']:<40} text={c['text']!r} href={c['href']!r}")

        log("\n[본문 후보 - 짧은 쪽이 본문일 확률이 높다]")
        for c in page.evaluate(_TEXT_CANDIDATES_JS):
            log(f"    {c['sel']:<40} {c['len']}자")

        log("\n[이미지 후보 - 큰 이미지가 많은 쪽이 본문일 확률이 높다]")
        for c in page.evaluate(_IMAGE_CANDIDATES_JS):
            log(f"    {c['sel']:<40} {c['n']}장 (300px 이상 {c['big']}장)")

        if headful:
            log("\n창을 확인한 뒤 계속...")
            pause()
        browser.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url")
    ap.add_argument("-m", "--mode", choices=("text", "image"), default="text",
                    help="text=본문을 txt 로 저장, image=이미지를 받아 저장")
    ap.add_argument("-t", "--text", dest="sel",
                    help="수집 대상 셀렉터. text 모드는 본문, image 모드는 이미지 (예: #c img)")
    ap.add_argument("-n", "--next", help="next 버튼 셀렉터")
    ap.add_argument("-T", "--title", help='제목 셀렉터. text 모드에서 첫 줄에 "{n}화. {제목}" + 빈 줄을 붙인다')
    ap.add_argument("-o", "--prefix", default="page", help="저장 경로 접두사, {prefix}_0001.txt 로 쓴다")
    ap.add_argument("--max", type=int, default=0, help="최대 페이지 수 (0=끝까지)")
    ap.add_argument("--timeout", type=int, default=15000, help="ms")
    ap.add_argument("--delay", type=int, default=0, help="페이지 간 대기 ms (--probe 에서는 렌더 추가 대기)")
    ap.add_argument("--headful", action="store_true", help="브라우저 창을 띄운다")
    ap.add_argument("--digits", type=int, default=4, help="번호 자릿수 (기본 4 -> _0001)")
    ap.add_argument("--start", type=int, default=1, help="시작 번호 (기본 1)")
    ap.add_argument("--charset", default="", help="페이지 인코딩을 강제한다 (예: utf-8). 비우면 브라우저 추정")
    ap.add_argument("--probe", action="store_true", help="저장하지 않고 셀렉터 매치 수와 후보만 출력")
    a = ap.parse_args()

    if not a.probe and (not a.sel or not a.next):
        ap.error("-t 와 -n 이 필요하다. 셀렉터를 모르면 --probe 로 먼저 찾아라.")
    try:
        charset = check_charset(a.charset)
    except ValueError as e:
        ap.error(str(e))

    try:
        if a.probe:
            probe(a.url, a.sel, a.next, a.timeout, a.headful, a.title, a.delay, charset=charset)
            return
        n = scrape(a.url, a.sel, a.next, a.prefix, a.max, a.timeout, a.headful, a.delay,
                   a.digits, a.start, a.title, a.mode, charset=charset)
    except PWError as e:
        # 스택트레이스보다 "무엇을 확인하라"가 쓸모 있다. 대부분 셀렉터 오타 아니면 접속 실패다.
        print("실패:", str(e).splitlines()[0], file=sys.stderr)
        print("  - --probe 로 셀렉터가 몇 개 잡히는지 먼저 확인", file=sys.stderr)
        print("  - 페이지가 느리면 --timeout 60000", file=sys.stderr)
        print("  - 접속 자체가 안 되면 브라우저에서 URL 이 열리는지 확인", file=sys.stderr)
        print("  - CONNECTION_RESET 은 스크립트 문제가 아니다. 그 도메인이 차단된 것일 수 있다.", file=sys.stderr)
        sys.exit(1)
    first, last = a.start, a.start + n - 1
    tail = "_*" if a.mode == "image" else ".txt"
    print(f"{n}개 페이지 -> {a.prefix}_{first:0{a.digits}d}{tail} ~ {a.prefix}_{last:0{a.digits}d}{tail}")


if __name__ == "__main__":
    main()
