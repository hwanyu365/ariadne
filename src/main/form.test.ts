import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../test/serve';
import { DEFAULTS, InputError, loadSettings, logLevel, parseInputs, pickUpdate, progress, remember, saveSettings, siteFor, windowHeight, type Raw, type Settings } from './form';

const raw = (over: Partial<Raw> = {}): Raw => ({ ...DEFAULTS, url: 'http://x', sel: '#c', next: '.next', ...over });

function reason(r: Raw, probe: boolean): string | null {
  try {
    parseInputs(r, probe);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

test('TC#41 emptyUrlRejected', () => {
  for (const probe of [true, false]) assert.equal(reason(raw({ url: '  ' }), probe), 'URL 을 입력해 주세요.');
});

test('TC#41 selectorsRequiredOnlyForRun', () => {
  for (const over of [{ sel: '' }, { next: '' }, { sel: ' ', next: ' ' }]) {
    assert.match(reason(raw(over), false) ?? '', /셀렉터가 필요/);
    assert.equal(parseInputs(raw(over), true).text.url, 'http://x');
  }
});

test('TC#41 nonNumericRejected', () => {
  for (const key of ['max', 'start', 'digits', 'timeout', 'delay'] as const)
    for (const probe of [true, false]) assert.match(reason(raw({ [key]: 'abc' }), probe) ?? '', /숫자여야 합니다: 'abc'/, key);
});

test('TC#23 charsetChecked', () => {
  assert.equal(parseInputs(raw(), false).text.charset, null);
  assert.equal(parseInputs(raw({ charset: ' utf-8 ' }), true).text.charset, 'utf-8');
  for (const probe of [true, false]) assert.match(reason(raw({ charset: 'nope' }), probe) ?? '', /인코딩/);
});

test('TC#41 validInputParsed', () => {
  const { text, nums } = parseInputs(raw({ url: ' http://x ', max: ' 5 ', delay: '' }), false);
  assert.equal(text.url, 'http://x');
  assert.deepEqual(nums, { max: 5, start: 1, digits: 4, timeout: 15000, delay: 0 });
});

test('TC#40 pickFillsMatchingField', () => {
  // 선택기가 보낸 대상이 그에 맞는 입력란으로 간다.
  for (const [target, key] of [['본문', 'sel'], ['이미지', 'sel'], ['next', 'next'], ['제목', 'title']]) {
    const got = pickUpdate({ target, sel: ' #c ', candidates: [{ sel: '#c', n: 1 }] });
    assert.equal(got?.key, key, target);
    assert.equal(got?.sel, '#c');
    assert.match(got?.line ?? '', /#c\(1\)/);
  }
});

test('TC#40 pickRejectsBadPayload', () => {
  // 페이지가 정한 값이 섞여 온다 → 형태가 맞지 않으면 입력란을 건드리지 않는다.
  for (const bad of [null, 'x', 1, {}, { target: '본문' }, { target: '없는대상', sel: '#c' }, { target: '본문', sel: '' }, { target: '본문', sel: 123 }])
    assert.equal(pickUpdate(bad), null, JSON.stringify(bad));
});

test('TC#40 pickRejectsInheritedTargetNames', () => {
  for (const target of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.equal(pickUpdate({ target, sel: '#c' }), null, target);
});

test('TC#40 pickToleratesBrokenCandidates', () => {
  // 후보 목록이 망가져도 셀렉터는 반영한다. 로그 한 줄 때문에 선택을 버리지 않는다.
  for (const candidates of ['엉뚱', null, [{ sel: '.n' }, { n: 1 }, 'x']]) {
    const got = pickUpdate({ target: 'next', sel: '.n', candidates });
    assert.deepEqual([got?.key, got?.sel], ['next', '.n']);
  }
});

test('TC#48 settingsRoundtrip', () => {
  const file = path.join(tempDir(), 'sub', 'settings.json');
  const values = { url: 'http://x', sel: '#c', max: '5', mode: 'image' as const, headful: true };
  saveSettings(file, values);
  assert.deepEqual(loadSettings(file), values);
});

test('TC#48 settingsTolerateBrokenFile', () => {
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

test('TC#43 progressReadsPageLines', () => {
  assert.deepEqual(progress('[3] 1200자 -> page_0003.txt'), { pages: 3, file: 'page_0003.txt' });
  assert.deepEqual(progress('[12] 이미지 4장 -> img_0012_*'), { pages: 12, file: 'img_0012_*' });
  for (const other of ['  중단: 사용자 중지.', '완료: 3개 페이지', '[본문] #c   후보: #c(1)', '    [0] \'본문\'', ''])
    assert.equal(progress(other), null, other);
});

test('TC#46 logLevelClassifiesLines', () => {
  assert.equal(logLevel("  경고: 제목 셀렉터 '#t' 에 걸리는 요소가 없다."), 'warn');
  assert.equal(logLevel('실패: TimeoutError: x'), 'error');
  assert.equal(logLevel('  중단: 사용자 중지.'), 'info');
  assert.equal(logLevel('\n주의: iframe 2개.'), 'warn');
  assert.equal(logLevel('  건너뜀 HTTP 404 http://x/a.png'), 'warn');
  assert.equal(logLevel('[1] 10자 -> page_0001.txt'), null);
});

test('TC#52 windowFitsScreen', () => {
  // 작업 영역(작업 표시줄 제외)보다 큰 창은 아래가 잘린다.
  assert.equal(windowHeight(1040), 900);
  for (const area of [720, 600, 1000.5]) assert.ok(windowHeight(area) <= area - 40, String(area));
});

test('TC#41 inputErrorNamesField', () => {
  // 화면이 오류를 해당 입력란에 표시하도록 어느 칸인지 함께 올린다.
  const field = (r: Raw, probe: boolean) => {
    try {
      parseInputs(r, probe);
      return null;
    } catch (e) {
      return e instanceof InputError ? e.field : 'not InputError';
    }
  };
  assert.equal(field(raw({ url: '' }), true), 'url');
  assert.equal(field(raw({ sel: '' }), false), 'sel');
  assert.equal(field(raw({ next: '' }), false), 'next');
  assert.equal(field(raw({ timeout: 'x' }), true), 'timeout');
  assert.equal(field(raw({ charset: 'nope' }), true), 'charset');
});

test('TC#45 doneLineIsSuccess', () => {
  assert.equal(logLevel('완료: 3개 페이지'), 'ok');
});

test('TC#40 pickFillsExcludeField', () => {
  assert.equal(pickUpdate({ target: '제외', sel: '.ad' })?.key, 'exclude');
});

test('TC#49 rememberKeepsRecentUrlsAndSitePresets', () => {
  // 수집을 시작한 URL 은 최근 10개, 셀렉터 묶음은 호스트별로 남긴다.
  let s: Settings = {};
  for (let i = 1; i <= 12; i++) s = { ...s, ...remember(s, raw({ url: `http://a.test/ep/${i}`, sel: `#c${i}`, exclude: '.ad' }), 'text') };
  s = { ...s, ...remember(s, raw({ url: 'http://a.test/ep/3', sel: '#c3' }), 'image') };
  assert.equal(s.recent?.length, 10);
  assert.equal(s.recent?.[0], 'http://a.test/ep/3');
  assert.equal(new Set(s.recent).size, 10);
  assert.deepEqual(siteFor(s, 'http://a.test/other'), { sel: '#c3', next: '.next', title: '', exclude: '', charset: '', mode: 'image' });
  assert.equal(siteFor(s, 'http://b.test/'), null);
  assert.equal(siteFor(s, 'not a url'), null);
});

test('TC#49 siteListIsBounded', () => {
  let s: Settings = {};
  for (let i = 1; i <= 55; i++) s = { ...s, ...remember(s, raw({ url: `http://h${i}.test/` }), 'text') };
  assert.equal(Object.keys(s.sites ?? {}).length, 50);
  assert.equal(siteFor(s, 'http://h1.test/'), null);
  assert.notEqual(siteFor(s, 'http://h55.test/'), null);
});

test('TC#49 settingsKeepOnlyValidSitesAndRecent', () => {
  // 사이트 설정도 파일에서 읽은 값이다 → 형태가 맞는 것만 살리고, 호스트 이름이 객체의 내부 키와 겹쳐도 안전하다.
  const file = path.join(tempDir(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    merge: true,
    recent: ['http://a', 3, null, 'http://b'],
    sites: { 'a.test': { sel: '#c', next: 1, mode: 'video', extra: 'x' }, bad: 'x', __proto__: { sel: '#p' } },
  }));
  const got = loadSettings(file);
  assert.equal(got.merge, true);
  assert.deepEqual(got.recent, ['http://a', 'http://b']);
  assert.deepEqual(got.sites?.['a.test'], { sel: '#c', next: '', title: '', exclude: '', charset: '', mode: 'text' });
  assert.equal(Object.hasOwn(got.sites ?? {}, 'bad'), false);
  assert.equal(({} as Record<string, unknown>).sel, undefined);
  fs.writeFileSync(file, '{"sites": {"__proto__": {"sel": "#p"}}}');
  const sites = loadSettings(file).sites ?? {};
  assert.equal(Object.getPrototypeOf(sites), Object.prototype);
  assert.equal(({} as Record<string, unknown>).sel, undefined);
});
