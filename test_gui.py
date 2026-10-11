"""gui 의 입력 검증을 tk.Tk() 없이 검증한다. test_scrape.py 가 함께 돌린다."""

from gui import NUM_FIELDS, parse_inputs, pick_update


def _raw(**over):
    raw = {"url": "http://x", "sel": "#c", "next": ".next", "title": "", "charset": "", "prefix": "out/page"}
    raw.update({k: d for k, _, d in NUM_FIELDS})
    raw.update(over)
    return raw


def _reason(raw, probe):
    try:
        parse_inputs(raw, probe)
    except ValueError as e:
        return str(e)
    return None


def test_gui_empty_url_rejected():
    for probe in (True, False):
        assert _reason(_raw(url="  "), probe) == "URL 을 입력하라.", probe


def test_gui_selectors_required_only_for_run():
    for over in ({"sel": ""}, {"next": ""}, {"sel": " ", "next": " "}):
        assert "셀렉터가 필요" in _reason(_raw(**over), probe=False), over
        text, _ = parse_inputs(_raw(**over), probe=True)
        assert text["url"] == "http://x", over


def test_gui_non_numeric_rejected():
    for key, label, _ in NUM_FIELDS:
        for probe in (True, False):
            assert _reason(_raw(**{key: "abc"}), probe) == f"{label} 은 숫자여야 한다: 'abc'", (key, probe)


def test_gui_pick_fills_matching_field():
    """선택기가 보낸 대상이 그에 맞는 입력란으로 간다."""
    for target, key in (("본문", "sel"), ("이미지", "sel"), ("next", "next"), ("제목", "title")):
        got = pick_update({"target": target, "sel": " #c ", "candidates": [{"sel": "#c", "n": 1}]})
        assert got[0] == key, (target, got)
        assert got[1] == "#c", got
        assert "#c(1)" in got[2], got


def test_gui_pick_rejects_bad_payload():
    """페이지 스크립트도 이 창구를 호출할 수 있다 → 형태가 맞지 않으면 입력란을 건드리지 않는다."""
    for bad in (None, "x", 1, {}, {"target": "본문"}, {"target": "없는대상", "sel": "#c"},
                {"target": "본문", "sel": ""}, {"target": "본문", "sel": 123}):
        assert pick_update(bad) is None, bad


def test_gui_pick_tolerates_broken_candidates():
    """후보 목록이 망가져도 셀렉터는 반영한다. 로그 한 줄 때문에 선택을 버리지 않는다."""
    for cands in ("엉뚱", None, [{"sel": ".n"}, {"n": 1}, "x"]):
        got = pick_update({"target": "next", "sel": ".n", "candidates": cands})
        assert got[:2] == ("next", ".n"), (cands, got)


def test_gui_charset_checked():
    """비우면 브라우저 추정, 모르는 이름은 시작 전에 거부한다."""
    assert parse_inputs(_raw(), probe=False)[0]["charset"] is None
    assert parse_inputs(_raw(charset=" utf-8 "), probe=True)[0]["charset"] == "utf-8"
    for probe in (True, False):
        assert "인코딩" in _reason(_raw(charset="nope"), probe), probe


def test_gui_valid_input_parsed():
    text, nums = parse_inputs(_raw(url=" http://x ", max=" 5 ", delay=""), probe=False)
    assert text["url"] == "http://x", text
    assert nums == {"max": 5, "start": 1, "digits": 4, "timeout": 15000, "delay": 0}, nums
