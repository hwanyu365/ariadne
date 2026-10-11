"""로컬 HTML 픽스처로 scrape 를 검증한다. `python test_scrape.py` 또는 pytest 로 실행."""

import contextlib
import functools
import http.server
import tempfile
import threading
from pathlib import Path

from scrape import scrape

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


@contextlib.contextmanager
def _serve(directory: Path):
    """이미지 다운로드는 실제 HTTP 응답으로 확인한다. file:// 로는 브라우저 request 가 본문을 받지 못한다."""
    handler = functools.partial(_QuietHandler, directory=str(directory))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


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


def test_image_mode_max_pages():
    pages, names, _ = _run_images("src", max_pages=1)
    assert pages == 1 and names == ["p_0001_001.png", "p_0001_002.png"], (pages, names)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok {t.__name__}")
    print(f"{len(tests)}개 통과")
