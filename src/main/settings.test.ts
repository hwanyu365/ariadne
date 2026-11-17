import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../test/serve';
import { loadSettings, saveSettings, windowHeight } from './settings';

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

test('TC#52 windowFitsScreen', () => {
  // 작업 영역(작업 표시줄 제외)보다 큰 창은 아래가 잘린다.
  assert.equal(windowHeight(1040), 900);
  for (const area of [720, 600, 1000.5]) assert.ok(windowHeight(area) <= area - 40, String(area));
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
