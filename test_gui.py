"""gui 의 입력 검증을 tk.Tk() 없이 검증한다. test_scrape.py 가 함께 돌린다."""

from gui import NUM_FIELDS, parse_inputs


def _raw(**over):
    raw = {"url": "http://x", "sel": "#c", "next": ".next", "title": "", "prefix": "out/page"}
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


def test_gui_valid_input_parsed():
    text, nums = parse_inputs(_raw(url=" http://x ", max=" 5 ", delay=""), probe=False)
    assert text["url"] == "http://x", text
    assert nums == {"max": 5, "start": 1, "digits": 4, "timeout": 15000, "delay": 0}, nums
