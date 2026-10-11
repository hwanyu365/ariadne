"""로컬 HTML 픽스처로 scrape 를 검증한다. `python test_scrape.py` 또는 pytest 로 실행."""

import contextlib
import functools
import gzip
import http.server
import tempfile
import threading
from pathlib import Path

from scrape import check_charset, probe, scrape

PNG = b"\x89PNG\r\n\x1a\n" + b"fixture" * 4


def _fixture_link(d: Path, n=3):
    """a[href] 로 넘어가는 평범한 페이지네이션."""
    for i in range(1, n + 1):
        nxt = f'<a class="next" href="p{i + 1}.html">next</a>' if i < n else '<a class="next" aria-disabled="true">next</a>'
        (d / f"p{i}.html").write_text(
            f"<body><h1 id=tt>제목 {i}</h1><div id=c>본문 {i}</div>{nxt}</body>", encoding="utf-8")
    return (d / "p1.html").as_uri()


def _fixture_disabled_but_href(d: Path, n=3):
    """마지막이 아닌데도 next 를 aria-disabled 로 죽여둔 사이트. href 는 살아 있다."""
    for i in range(1, n + 1):
        href = f' href="q{i + 1}.html"' if i < n else ""
        (d / f"q{i}.html").write_text(
            f'<body><div id=c>본문 {i}</div><a class="next" aria-disabled="true"{href}>next</a></body>',
            encoding="utf-8")
    return (d / "q1.html").as_uri()


def _fixture_spa(d: Path, n=3):
    """URL 이 바뀌지 않고 JS 로 본문만 교체하는 경우."""
    (d / "spa.html").write_text(
        f"""<body><div id=c>본문 1</div><button class=next>next</button>
<script>let i=1,N={n};document.querySelector('.next').onclick=()=>{{
  if(i>=N)return; i++; setTimeout(()=>{{document.querySelector('#c').textContent='본문 '+i;
  if(i>=N)document.querySelector('.next').disabled=true;}},300);}}</script></body>""",
        encoding="utf-8",
    )
    return (d / "spa.html").as_uri()


def _write_image_pages(d: Path, n, attr):
    for i in range(1, n + 1):
        for name in ("a", "b"):
            (d / f"{name}{i}.png").write_bytes(PNG)
        nxt = f'<a class="next" href="i{i + 1}.html">next</a>' if i < n else '<a class="next" aria-disabled="true">next</a>'
        (d / f"i{i}.html").write_text(
            f'<body><div id=c><img {attr}="a{i}.png"><img {attr}="b{i}.png"></div>{nxt}</body>',
            encoding="utf-8")


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class _GzipHandler(_QuietHandler):
    """실제 사이트처럼 gzip 으로 보낸다. 디렉터리 주소의 301 은 그대로 둔다."""

    def do_GET(self):
        path = Path(self.translate_path(self.path))
        if path.is_dir() and not self.path.endswith("/"):
            return super().do_GET()
        if path.is_dir():
            path = path / "index.html"
        body = gzip.compress(path.read_bytes())
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextlib.contextmanager
def _serve(directory: Path, handler_cls=_QuietHandler):
    """이미지 다운로드는 실제 HTTP 응답으로 확인한다. file:// 로는 브라우저 request 가 본문을 받지 못한다."""
    handler = functools.partial(handler_cls, directory=str(directory))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _write_undeclared_utf8(d: Path):
    """charset 선언 없는 UTF-8 페이지. 디렉터리 주소로 열면 서버가 슬래시를 붙이는 301 을 먼저 돌려준다."""
    ep = d / "ep"
    ep.mkdir()
    (ep / "index.html").write_bytes(
        '<body><div id=c>본문 1 가나다</div><a class="next" href="p2.html">next</a></body>'.encode())
    (ep / "p2.html").write_bytes(
        '<body><div id=c>본문 2 가나다</div><a class="next" aria-disabled="true">next</a></body>'.encode())


def _run_undeclared(handler_cls=_QuietHandler, **kw):
    logs = []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_undeclared_utf8(d)
        with _serve(d, handler_cls) as base:
            n = scrape(f"{base}/ep", "#c", ".next", str(d / "out" / "p"), timeout=5000,
                       on_log=logs.append, **kw)
        texts = [f.read_text(encoding="utf-8") for f in sorted((d / "out").glob("p_*.txt"))]
        return n, texts, logs


def _run(make, **kw):
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        n = scrape(make(d), "#c", ".next", str(d / "out" / "p"), timeout=5000, **kw)
        files = sorted((d / "out").glob("p_*.txt"))
        return n, [f.name for f in files], [f.read_text(encoding="utf-8") for f in files]


def _run_images(attr, n=3, **kw):
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_image_pages(d, n, attr)
        with _serve(d) as base:
            pages = scrape(f"{base}/i1.html", "#c img", ".next", str(d / "out" / "p"),
                           timeout=5000, mode="image", **kw)
        files = sorted((d / "out").iterdir()) if (d / "out").exists() else []
        return pages, [f.name for f in files], [f.read_bytes() for f in files]


def test_link_pagination():
    n, names, texts = _run(_fixture_link)
    assert n == 3, n
    assert names == ["p_0001.txt", "p_0002.txt", "p_0003.txt"], names
    assert texts == ["본문 1", "본문 2", "본문 3"], texts


def test_spa_pagination():
    n, names, texts = _run(_fixture_spa)
    assert n == 3, n
    assert texts == ["본문 1", "본문 2", "본문 3"], texts


def test_max_pages():
    n, names, texts = _run(_fixture_link, max_pages=2)
    assert n == 2 and names == ["p_0001.txt", "p_0002.txt"], (n, names)


def test_disabled_next_follows_href():
    n, names, texts = _run(_fixture_disabled_but_href)
    assert n == 3, n
    assert texts == ["본문 1", "본문 2", "본문 3"], texts


def test_digits_and_start():
    n, names, _ = _run(_fixture_link, digits=3, start=65)
    assert names == ["p_065.txt", "p_066.txt", "p_067.txt"], names


def test_missing_next_selector():
    """next 셀렉터가 안 맞으면 1페이지만 받고 이유를 로그로 남긴다."""
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        n = scrape(_fixture_link(d), "#c", ".nope", str(d / "out" / "p"), timeout=3000)
        assert n == 1, n


def test_title_header():
    """-T 를 주면 첫 줄에 "{n}화. {제목}" + 빈 줄이 붙는다."""
    n, _, texts = _run(_fixture_link, title_sel="#tt", digits=3, start=1920)
    assert n == 3, n
    assert texts[0].splitlines() == ["1920화. 제목 1", "", "본문 1"], texts[0]
    assert texts[2].startswith("1922화. 제목 3"), texts[2]


def test_title_selector_missing():
    """제목 셀렉터가 안 맞아도 본문은 그대로 받고 번호만 남긴다."""
    n, _, texts = _run(_fixture_link, title_sel="#nope")
    assert n == 3, n
    assert texts[0].splitlines() == ["1화.", "", "본문 1"], texts[0]


def test_image_mode_saves_every_page():
    """페이지마다 이미지를 번호 순서대로 받아 저장한다."""
    pages, names, blobs = _run_images("src")
    assert pages == 3, pages
    assert names == [f"p_{p:04d}_{i:03d}.png" for p in (1, 2, 3) for i in (1, 2)], names
    assert all(b == PNG for b in blobs), [len(b) for b in blobs]


def test_image_mode_reads_data_src():
    """주소가 data-src 에만 있어도 받는다. src 가 비어 크기가 0 인 img 도 대상이다."""
    pages, names, blobs = _run_images("data-src", n=2)
    assert pages == 2, pages
    assert names == ["p_0001_001.png", "p_0001_002.png", "p_0002_001.png", "p_0002_002.png"], names
    assert all(b == PNG for b in blobs), [len(b) for b in blobs]


def test_charset_undeclared_utf8_warns():
    """선언 없는 UTF-8 은 깨진 채 받아진다 → 조용히 끝나지 않고 로그로 알린다."""
    n, texts, logs = _run_undeclared()
    assert n == 2, n
    assert texts[0] != "본문 1 가나다", texts      # 픽스처가 실제로 추정을 틀리게 만드는지
    assert any("windows-1252" in line for line in logs), logs


def test_charset_forced_reads_undeclared_utf8():
    """인코딩을 지정하면 리다이렉트와 링크 이동을 거쳐도 모든 페이지를 그 인코딩으로 읽는다."""
    n, texts, logs = _run_undeclared(charset="utf-8")
    assert n == 2, n
    assert texts == ["본문 1 가나다", "본문 2 가나다"], texts
    assert not any("windows-1252" in line for line in logs), logs


def test_charset_ignored_by_browser_warns():
    """파이썬은 알지만 브라우저는 모르는 이름이면 지정이 무시된다 → 조용히 추정으로 돌아가지 않고 알린다."""
    _, texts, logs = _run_undeclared(charset="u8")
    assert texts[0] != "본문 1 가나다", texts      # 브라우저가 실제로 지정을 무시하는지
    assert any("u8" in line and "windows-1252" in line for line in logs), logs


def test_charset_forced_reads_gzip_response():
    """압축된 응답도 지정한 인코딩으로 읽는다."""
    n, texts, _ = _run_undeclared(_GzipHandler, charset="utf-8")
    assert n == 2, n
    assert texts == ["본문 1 가나다", "본문 2 가나다"], texts


def test_probe_reports_charset():
    """probe 는 추정 인코딩을 보여 주고, 지정하면 미리보기부터 바로 읽힌다."""
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _write_undeclared_utf8(d)
        with _serve(d) as base:
            guessed, forced = [], []
            probe(f"{base}/ep", "#c", None, timeout=5000, on_log=guessed.append)
            probe(f"{base}/ep", "#c", None, timeout=5000, on_log=forced.append, charset="utf-8")
    assert any("인코딩: windows-1252" in line for line in guessed), guessed
    assert any("경고" in line and "windows-1252" in line for line in guessed), guessed
    assert any("인코딩: UTF-8" in line for line in forced), forced
    assert any("본문 1 가나다" in line for line in forced), forced
    assert not any("경고" in line for line in forced), forced


def test_charset_name_checked():
    assert check_charset("  ") is None
    assert check_charset(" utf-8 ") == "utf-8"
    assert check_charset("euc-kr") == "euc-kr"
    for bad in ("nope", "utf-8\r\nx-evil: 1"):
        try:
            check_charset(bad)
        except ValueError as e:
            assert "인코딩" in str(e), e
        else:
            raise AssertionError(bad)


def test_image_mode_max_pages():
    pages, names, _ = _run_images("src", max_pages=1)
    assert pages == 1 and names == ["p_0001_001.png", "p_0001_002.png"], (pages, names)


if __name__ == "__main__":
    def collect(ns):
        return {k: v for k, v in ns.items() if k.startswith("test_") and callable(v)}

    found = collect(globals())

    def merge(mod):
        extra = collect(vars(mod))
        dup = sorted(found.keys() & extra.keys())
        assert not dup, f"테스트 이름 중복: {dup}"
        found.update(extra)

    import test_picker          # 필수. skip 하면 이름이 바뀌거나 지워져도 통과한다
    merge(test_picker)
    try:
        import test_gui         # tkinter 가 없는 환경을 위해 이것만 선택적이다
    except ImportError as e:
        print(f"  skip test_gui: {e}")
    else:
        merge(test_gui)
    tests = [v for _, v in sorted(found.items())]
    for t in tests:
        t()
        print(f"  ok {t.__name__}")
    print(f"{len(tests)}개 통과")
