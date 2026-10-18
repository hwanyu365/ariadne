import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../test/serve';
import { DEFAULTS, loadSettings, logLevel, parseInputs, pickUpdate, progress, saveSettings, windowHeight, type Raw } from './form';

const raw = (over: Partial<Raw> = {}): Raw => ({ ...DEFAULTS, url: 'http://x', sel: '#c', next: '.next', ...over });

function reason(r: Raw, probe: boolean): string | null {
  try {
    parseInputs(r, probe);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

test('emptyUrlRejected', () => {
  for (const probe of [true, false]) assert.equal(reason(raw({ url: '  ' }), probe), 'URL 을 입력하라.');
});

test('selectorsRequiredOnlyForRun', () => {
  for (const over of [{ sel: '' }, { next: '' }, { sel: ' ', next: ' ' }]) {
    assert.match(reason(raw(over), false) ?? '', /셀렉터가 필요/);
    assert.equal(parseInputs(raw(over), true).text.url, 'http://x');
  }
});

test('nonNumericRejected', () => {
  for (const key of ['max', 'start', 'digits', 'timeout', 'delay'] as const)
    for (const probe of [true, false]) assert.match(reason(raw({ [key]: 'abc' }), probe) ?? '', /숫자여야 한다: 'abc'/, key);
});

test('charsetChecked', () => {
  assert.equal(parseInputs(raw(), false).text.charset, null);
  assert.equal(parseInputs(raw({ charset: ' utf-8 ' }), true).text.charset, 'utf-8');
  for (const probe of [true, false]) assert.match(reason(raw({ charset: 'nope' }), probe) ?? '', /인코딩/);
});

test('validInputParsed', () => {
  const { text, nums } = parseInputs(raw({ url: ' http://x ', max: ' 5 ', delay: '' }), false);
  assert.equal(text.url, 'http://x');
  assert.deepEqual(nums, { max: 5, start: 1, digits: 4, timeout: 15000, delay: 0 });
});

test('pickFillsMatchingField', () => {
  // 선택기가 보낸 대상이 그에 맞는 입력란으로 간다.
  for (const [target, key] of [['본문', 'sel'], ['이미지', 'sel'], ['next', 'next'], ['제목', 'title']]) {
    const got = pickUpdate({ target, sel: ' #c ', candidates: [{ sel: '#c', n: 1 }] });
    assert.equal(got?.key, key, target);
    assert.equal(got?.sel, '#c');
    assert.match(got?.line ?? '', /#c\(1\)/);
  }
});

test('pickRejectsBadPayload', () => {
  // 페이지가 정한 값이 섞여 온다 → 형태가 맞지 않으면 입력란을 건드리지 않는다.
  for (const bad of [null, 'x', 1, {}, { target: '본문' }, { target: '없는대상', sel: '#c' }, { target: '본문', sel: '' }, { target: '본문', sel: 123 }])
    assert.equal(pickUpdate(bad), null, JSON.stringify(bad));
});

test('pickToleratesBrokenCandidates', () => {
  // 후보 목록이 망가져도 셀렉터는 반영한다. 로그 한 줄 때문에 선택을 버리지 않는다.
  for (const candidates of ['엉뚱', null, [{ sel: '.n' }, { n: 1 }, 'x']]) {
    const got = pickUpdate({ target: 'next', sel: '.n', candidates });
    assert.deepEqual([got?.key, got?.sel], ['next', '.n']);
  }
});

test('settingsRoundtrip', () => {
  const file = path.join(tempDir(), 'sub', 'settings.json');
  const values = { url: 'http://x', sel: '#c', max: '5', mode: 'image' as const, headful: true };
  saveSettings(file, values);
  assert.deepEqual(loadSettings(file), values);
});

test('settingsTolerateBrokenFile', () => {
  // 설정 파일 때문에 앱이 안 켜지면 안 된다 → 아는 키·맞는 타입만 살린다.
  const file = path.join(tempDir(), 'settings.json');
  assert.deepEqual(loadSettings(file), {});
  for (const broken of ['{', '[]', '"x"', 'null']) {
    fs.writeFileSync(file, broken);
    assert.deepEqual(loadSettings(file), {}, broken);
  }
  fs.writeFileSync(file, '{"url": "http://x", "sel": 1, "모름": "x", "mode": "video", "headful": "yes"}');
  assert.deepEqual(loadSettings(file), { url: 'http://x' });
});

test('progressReadsPageLines', () => {
  assert.deepEqual(progress('[3] 1200자 -> page_0003.txt'), { pages: 3, file: 'page_0003.txt' });
  assert.deepEqual(progress('[12] 이미지 4장 -> img_0012_*'), { pages: 12, file: 'img_0012_*' });
  for (const other of ['  중단: 사용자 중지.', '완료: 3개 페이지', '[본문] #c   후보: #c(1)', '    [0] \'본문\'', ''])
    assert.equal(progress(other), null, other);
});

test('logLevelClassifiesLines', () => {
  assert.equal(logLevel("  경고: 제목 셀렉터 '#t' 에 걸리는 요소가 없다."), 'warn');
  assert.equal(logLevel('실패: TimeoutError: x'), 'error');
  assert.equal(logLevel('  중단: 사용자 중지.'), 'info');
  assert.equal(logLevel('\n주의: iframe 2개.'), 'warn');
  assert.equal(logLevel('  건너뜀 HTTP 404 http://x/a.png'), 'warn');
  assert.equal(logLevel('[1] 10자 -> page_0001.txt'), null);
});

test('windowFitsScreen', () => {
  // 작업 영역(작업 표시줄 제외)보다 큰 창은 아래가 잘린다.
  assert.equal(windowHeight(1040), 900);
  for (const area of [720, 600, 1000.5]) assert.ok(windowHeight(area) <= area - 40, String(area));
});
