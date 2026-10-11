"""선택기의 셀렉터 후보 생성을 로컬 픽스처로 검증한다. test_scrape.py 가 함께 돌린다."""

import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from scrape import CANDIDATES_JS, install_picker, picker_setup_js

FIXTURE = """<meta charset="utf-8"><body style="margin:40px 300px 300px 40px">
<h1 id="tt">제목</h1>
<div class="article body">본문입니다</div>
<div class="article">다른 article</div>
<div class="article">또 다른 article</div>
<div id="gallery"><img class="cut" src="a.png"><img class="cut" src="b.png"></div>
<a class="next" href="https://example.com/next">다음</a>
</body>"""


def _on(fn):
    """픽스처를 열고 fn(page) 를 돌린다."""
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "p.html"
        f.write_text(FIXTURE, encoding="utf-8")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(f.as_uri())
            try:
                return fn(page)
            finally:
                browser.close()


def _candidates(page, selector):
    return page.locator(selector).first.evaluate(CANDIDATES_JS)


def test_picker_prefers_id():
    """id 가 있으면 첫 후보로 낸다. 가장 짧고 깨지지 않는다."""
    got = _on(lambda page: _candidates(page, "#tt"))
    assert got[0]["sel"] == "#tt", got
    assert got[0]["n"] == 1, got


def test_picker_shows_match_count_for_each_candidate():
    """클래스를 줄인 후보가 몇 개를 잡는지 보여 준다 → 상태 클래스가 섞였는지 드러난다."""
    got = _on(lambda page: _candidates(page, "div.article.body"))
    by_sel = {c["sel"]: c["n"] for c in got}
    assert by_sel.get("div.article.body") == 1, got
    assert by_sel.get("div.article") == 3, got


def test_picker_suggests_container_for_image():
    """이미지는 그 한 장이 아니라 컨테이너 기준 후보가 필요하다."""
    got = _on(lambda page: _candidates(page, "#gallery img"))
    sels = [c["sel"] for c in got]
    assert "#gallery img" in sels, got
    assert {c["sel"]: c["n"] for c in got}["#gallery img"] == 2, got


def test_picker_excludes_own_ui_from_count():
    """선택기가 붙인 요소는 매치 수에 들어가지 않는다 → 태그만 쓴 후보에서 드러난다."""
    def run(page):
        before = _candidates(page, "div.article.body")
        install_picker(page)
        return before, _candidates(page, "div.article.body")

    before, after = _on(run)
    n = lambda cs: {c["sel"]: c["n"] for c in cs}
    assert n(before)["div"] == 4, before          # 픽스처의 div 수
    assert n(after)["div"] == n(before)["div"], (before, after)
    assert n(after)["div.article"] == 3, after


def test_picker_click_reports_and_blocks_navigation():
    """클릭하면 후보를 돌려주고 링크 이동은 막는다."""
    def run(page):
        got = []
        page.expose_function("__ariadne_pick", lambda payload: got.append(payload))
        install_picker(page)
        before = page.url
        page.click(".next")
        page.wait_for_timeout(200)
        return got, before, page.url

    got, before, after = _on(run)
    assert before == after, (before, after)
    assert got, "클릭이 콜백으로 전달되지 않았다"
    assert [c["sel"] for c in got[0]["candidates"]][0] == "a.next", got
    assert got[0]["text"] == "다음", got


def test_picker_switches_target_from_toolbar():
    """툴바에서 대상을 바꾸면 그 뒤의 클릭이 바뀐 대상으로 전달된다."""
    def run(page):
        got = []
        page.expose_function("__ariadne_pick", lambda payload: got.append(payload))
        install_picker(page)
        page.click("div.article.body")
        page.evaluate("""() => [...document.querySelectorAll('[data-ariadne-ui] button')]
            .find(b => b.textContent === 'next').click()""")
        page.click(".next")
        page.wait_for_timeout(200)
        return got

    got = _on(run)
    assert [g["target"] for g in got] == ["본문", "next"], got
    assert got[1]["sel"] == "a.next", got


def test_picker_toolbar_click_is_not_treated_as_selection():
    """툴바 자신을 클릭한 것은 선택으로 세지 않는다."""
    def run(page):
        got = []
        page.expose_function("__ariadne_pick", lambda payload: got.append(payload))
        install_picker(page)
        page.evaluate("""() => [...document.querySelectorAll('[data-ariadne-ui] button')]
            .find(b => b.textContent === '제목').click()""")
        page.wait_for_timeout(200)
        return got

    assert _on(run) == [], "툴바 버튼 클릭이 선택으로 전달됐다"


def test_picker_installs_when_injected_before_document():
    """문서가 생기기 전에 주입돼도 결국 설치된다. `pick()` 은 `add_init_script` 로 넣는다."""
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "p.html"
        f.write_text(FIXTURE, encoding="utf-8")
        got, errs = [], []
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.on("pageerror", lambda e: errs.append(str(e)[:120]))
            page.expose_function("__ariadne_pick", lambda payload: got.append(payload))
            page.add_init_script(picker_setup_js())
            page.goto(f.as_uri())
            ui = page.evaluate("() => document.querySelectorAll('[data-ariadne-ui]').length")
            page.click("div.article.body")
            page.wait_for_timeout(200)
            browser.close()
    assert not errs, errs
    assert ui > 0, "툴바와 하이라이트가 붙지 않았다"
    assert got and got[0]["sel"] == "div.article.body", got


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok {t.__name__}")
    print(f"{len(tests)}개 통과")
