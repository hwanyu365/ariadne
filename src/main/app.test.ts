import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { serve, tempDir } from '../test/serve';
import { createMainWindow, registerIpc } from './app';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fixture(d: string) {
  for (let i = 1; i <= 3; i++) {
    const nxt = i < 3 ? `<a class="next" href="p${i + 1}.html">next</a>` : '<a class="next" aria-disabled="true">next</a>';
    fs.writeFileSync(path.join(d, `p${i}.html`), `<meta charset="utf-8"><body><div id=c>본문 ${i}</div>${nxt}</body>`);
  }
  return pathToFileURL(path.join(d, 'p1.html')).href;
}

async function until<T>(win: BrowserWindow, code: string, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  let v: T = await win.webContents.executeJavaScript(code);
  while (!ok(v) && Date.now() < deadline) {
    await sleep(100);
    v = await win.webContents.executeJavaScript(code);
  }
  return v;
}

const settingsFile = path.join(tempDir(), 'settings.json');
const notices: { title: string; body: string }[] = [];
registerIpc({ settingsPath: settingsFile, defaultPrefix: path.join(tempDir(), 'page'), notify: (title, body) => notices.push({ title, body }) });

async function open(): Promise<BrowserWindow> {
  const win = createMainWindow({ show: false });
  await until<boolean>(win, `!!document.querySelector('#run') && document.body.dataset.ready === '1'`, v => v);
  return win;
}

// 앞 테스트가 저장한 설정이 다음 창에 복원된다 → 모드는 텍스트에서 시작한다.
const fill = (win: BrowserWindow, values: Record<string, string>) => win.webContents.executeJavaScript(`(() => {
  document.querySelector('[data-mode="text"]').click();
  for (const [k, v] of Object.entries(${JSON.stringify(values)})) {
    const e = document.querySelector('[name="' + k + '"]');
    e.value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`);

test('windowRunsScrapeAndShowsProgress', async () => {
  const d = tempDir();
  const win = await open();
  try {
    await fill(win, { url: fixture(d), sel: '#c', next: '.next', prefix: path.join(d, 'out', 'p') });
    await win.webContents.executeJavaScript(`document.querySelector('#run').click()`);
    const state = await until<string>(win, `document.querySelector('#st-state').textContent`, v => v.includes('완료') || v.includes('실패'));
    assert.match(state, /완료/);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#st-pages').textContent`), '3페이지');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#st-file').textContent`), 'p_0003.txt');
    assert.deepEqual(fs.readdirSync(path.join(d, 'out')).sort(), ['p_0001.txt', 'p_0002.txt', 'p_0003.txt']);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#run').disabled`), false);
  } finally {
    win.destroy();
  }
});

test('windowRejectsBadInputBeforeStart', async () => {
  const win = await open();
  try {
    await fill(win, { url: '', sel: '', next: '' });
    await win.webContents.executeJavaScript(`document.querySelector('#run').click()`);
    const log = await until<string>(win, `document.querySelector('#log').textContent`, v => v.length > 0, 3000);
    assert.match(log, /URL 을 입력해 주세요/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('#log .error') ? 'error' : ''`), /error/);
  } finally {
    win.destroy();
  }
});

test('windowRestoresSavedInputs', async () => {
  // 입력은 바뀔 때마다 저장되고 다음 창에 채워진다.
  const first = await open();
  try {
    await fill(first, { url: 'http://example.invalid/ep?no=7', sel: '#article' });
    await first.webContents.executeJavaScript(`document.querySelector('[data-mode="image"]').click()`);
    await until<boolean>(first, 'true', () => fs.existsSync(settingsFile) && fs.readFileSync(settingsFile, 'utf8').includes('no=7') && fs.readFileSync(settingsFile, 'utf8').includes('"image"'), 3000);
  } finally {
    first.destroy();
  }
  const second = await open();
  try {
    const got = await second.webContents.executeJavaScript(`[document.querySelector('[name="url"]').value, document.querySelector('[name="sel"]').value,
      document.querySelector('[data-mode="image"]').getAttribute('aria-pressed'), document.querySelector('[name="title"]').disabled]`);
    assert.deepEqual(got, ['http://example.invalid/ep?no=7', '#article', 'true', true]);
  } finally {
    second.destroy();
  }
});

test('doubleStartKeepsRunState', async () => {
  // 응답을 기다리는 사이에 다시 눌러도 진행 중인 수집의 로그와 상태를 지우지 않는다.
  const d = tempDir();
  const win = await open();
  try {
    await fill(win, { url: fixture(d), sel: '#c', next: '.next', prefix: path.join(d, 'out', 'p') });
    await win.webContents.executeJavaScript(`document.querySelector('#run').click(); document.querySelector('#run').click();`);
    const state = await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패|입력 확인/.test(v));
    assert.match(state, /완료/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('#log').textContent`), /\[3\]/);
  } finally {
    win.destroy();
  }
});

test('closingWindowStopsRun', async () => {
  // 창이 사라지면 결과를 받을 곳이 없다 → 수집을 멈추고 다음 창에서 다시 시작할 수 있다.
  const d = tempDir();
  for (let i = 1; i <= 20; i++) {
    const nxt = i < 20 ? `<a class="next" href="q${i + 1}.html">next</a>` : '<a class="next" aria-disabled="true">next</a>';
    fs.writeFileSync(path.join(d, `q${i}.html`), `<meta charset="utf-8"><body><div id=c>본문 ${i}</div>${nxt}</body>`);
  }
  const first = await open();
  await fill(first, { url: pathToFileURL(path.join(d, 'q1.html')).href, sel: '#c', next: '.next', prefix: path.join(d, 'out', 'q'), delay: '300' });
  await first.webContents.executeJavaScript(`document.querySelector('#run').click()`);
  await until<string>(first, `document.querySelector('#log').textContent`, v => v.includes('[1]'));
  first.destroy();
  const second = await open();
  try {
    await fill(second, { url: fixture(tempDir()), sel: '#c', next: '.next', delay: '0' });
    const deadline = Date.now() + 5000;
    let state = '';
    while (Date.now() < deadline) {
      await second.webContents.executeJavaScript(`document.querySelector('#run').click()`);
      await sleep(200);
      state = await second.webContents.executeJavaScript(`document.querySelector('#st-state').textContent`);
      if (!state.includes('입력 확인')) break;
      await sleep(300);
    }
    assert.doesNotMatch(state, /입력 확인/, '앞 창의 수집이 계속 돌아 새 창에서 시작하지 못했다');
    await until<string>(second, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v));
  } finally {
    second.destroy();
  }
  assert.ok(fs.readdirSync(path.join(d, 'out')).length < 20, '창을 닫은 뒤에도 끝까지 받았다');
});

test('windowShowsImmediateFailure', async () => {
  // 엔진이 곧바로 실패해 종료 알림이 시작 응답보다 먼저 와도 화면이 '실행 중' 으로 굳지 않는다.
  const d = tempDir();
  fs.writeFileSync(path.join(d, 'blocker'), '');      // 폴더가 있어야 할 자리에 파일 → 저장 폴더를 만들지 못한다
  const win = await open();
  try {
    await fill(win, { url: fixture(d), sel: '#c', next: '.next', prefix: path.join(d, 'blocker', 'sub', 'p') });
    await win.webContents.executeJavaScript(`document.querySelector('#run').click()`);
    const state = await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v), 5000);
    await sleep(300);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('#st-state').textContent`), /실패/, state);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#run').disabled`), false);
  } finally {
    win.destroy();
  }
});

test('mainWindowStaysOnItsOwnPage', async () => {
  // 화면 창은 앱이 가진 파일만 연다 → 새 창이나 다른 문서로 넘어가 preload 통로를 내주지 않는다.
  const { BrowserWindow } = await import('electron');
  const win = await open();
  try {
    const before = BrowserWindow.getAllWindows().length;
    await win.webContents.executeJavaScript(`window.open('https://example.com/'); location.href = 'https://example.com/'; void 0`);
    await sleep(800);
    assert.equal(BrowserWindow.getAllWindows().length, before, '새 창이 열렸다');
    assert.match(win.webContents.getURL(), /static\/index\.html$/, '다른 문서로 이동했다');
  } finally {
    win.destroy();
  }
});

const js = <T = unknown>(win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code) as Promise<T>;

test('windowMarksInvalidField', async () => {
  // 입력 오류는 해당 입력란에 표시되고 포커스가 그 칸으로 간다. 접힌 고급 옵션은 펼친다.
  const win = await open();
  try {
    await fill(win, { url: 'http://x', sel: '#c', next: '.n', timeout: 'abc' });
    await js(win, `document.querySelector('.advanced').open = false; document.querySelector('#run').click()`);
    await until<string>(win, `document.querySelector('#log').textContent`, v => v.length > 0, 3000);
    const got = await js(win, `[document.querySelector('[name="timeout"]').getAttribute('aria-invalid'), document.activeElement?.getAttribute('name'), document.querySelector('.advanced').open]`);
    assert.deepEqual(got, ['true', 'timeout', true]);
    await fill(win, { timeout: '1000' });
    assert.equal(await js(win, `document.querySelector('[name="timeout"]').getAttribute('aria-invalid')`), null);
  } finally {
    win.destroy();
  }
});

test('windowGuidesBeforeFirstRun', async () => {
  // 실행 전에는 빈 로그 자리에 안내가 보이고, 실행하면 사라진다.
  const d = tempDir();
  const win = await open();
  try {
    assert.equal(await js(win, `document.querySelector('#guide').hidden`), false);
    await fill(win, { url: fixture(d), sel: '#c', next: '.next', prefix: path.join(d, 'out', 'p') });
    await js(win, `document.querySelector('#run').click()`);
    assert.equal(await js(win, `document.querySelector('#guide').hidden`), true);
    await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v));
  } finally {
    win.destroy();
  }
});

test('windowSummarizesResult', async () => {
  // 끝나면 결과·페이지 수·멈춘 사유를 요약하고, 받은 파일이 있으면 폴더 열기를 둔다. 수집 중에는 진행 막대가 보인다.
  const d = tempDir();
  const win = await open();
  try {
    await fill(win, { url: fixture(d), sel: '#c', next: '.next', prefix: path.join(d, 'out', 'p'), max: '0' });
    const during = await js(win, `document.querySelector('#run').click(); [document.querySelector('#progress').hidden, document.querySelector('#result').hidden]`);
    assert.deepEqual(during, [false, true]);
    await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v));
    const got = await js<[boolean, boolean, string, string, boolean]>(win, `[document.querySelector('#progress').hidden, document.querySelector('#result').hidden,
      document.querySelector('#result').className, document.querySelector('#result-text').textContent, document.querySelector('#result-open').hidden]`);
    assert.equal(got[0], true);
    assert.equal(got[1], false);
    assert.match(got[2], /ok/);
    assert.match(got[3], /완료.*3페이지/);
    assert.match(got[3], /마지막 페이지/);
    assert.equal(got[4], false);
    // 숨겨져 있다 나타나는 영역은 낭독되지 않을 수 있다 → 항상 렌더링된 알림 영역에 같은 문구를 넣는다.
    assert.equal(await js(win, `document.querySelector('#announce').textContent`), got[3]);
  } finally {
    win.destroy();
  }
});

test('windowProgressUsesMaxPages', async () => {
  // 최대 페이지가 있으면 받은 비율을 보인다.
  const d = tempDir();
  const win = await open();
  try {
    await fill(win, { url: fixture(d), sel: '#c', next: '.next', prefix: path.join(d, 'out', 'p'), max: '2' });
    assert.equal(await js(win, `document.querySelector('#run').click(); document.querySelector('#progress').max`), 2);
    const value = await until<number>(win, `document.querySelector('#progress').value`, v => v >= 1);
    assert.ok(value >= 1, String(value));
    await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v));
  } finally {
    win.destroy();
  }
});

test('windowLogKeepsRecentLinesAndMarksLevels', async () => {
  // 화면의 로그는 최근 2000줄만 두고, 경고·실패·완료 줄은 색 외에 줄 앞 표시로도 구분한다.
  const win = await open();
  try {
    for (let i = 1; i <= 2005; i++) win.webContents.send('run:log', { text: `줄 ${i}`, level: null, progress: null });
    for (const level of ['warn', 'error', 'ok']) win.webContents.send('run:log', { text: level, level, progress: null });
    await until<boolean>(win, `!!document.querySelector('#log .ok')`, v => v, 5000);
    assert.equal(await js(win, `document.querySelector('#log').childElementCount`), 2000);
    assert.equal(await js(win, `document.querySelector('#log').firstElementChild.textContent`), '줄 9');
    const marks = await js<string[]>(win, `['warn', 'error', 'ok'].map(l => getComputedStyle(document.querySelector('#log .' + l), '::before').content)`);
    assert.deepEqual(marks, ['"! "', '"× "', '"✓ "']);
  } finally {
    win.destroy();
  }
});

test('windowNotifiesWhenRunEndsUnfocused', async () => {
  // 창을 보고 있지 않을 때 수집이 끝나면 OS 알림으로 결과를 알린다. probe 는 알리지 않는다.
  const d = tempDir();
  const win = await open();
  try {
    notices.length = 0;
    await fill(win, { url: fixture(d), sel: '#c', next: '.next', prefix: path.join(d, 'out', 'p'), max: '0' });
    await js(win, `document.querySelector('#run').click()`);
    await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v));
    await until<boolean>(win, 'true', () => notices.length > 0, 2000);
    assert.equal(notices.length, 1);
    assert.match(notices[0].title, /완료/);
    assert.match(notices[0].body, /3페이지/);
    await js(win, `document.querySelector('#probe').click()`);
    await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v));
    await sleep(300);
    assert.equal(notices.length, 1);
  } finally {
    win.destroy();
  }
});

test('windowFillsSitePresetForAnotherHost', async () => {
  // 수집을 시작한 호스트의 셀렉터를 기억했다가, URL 을 그 호스트로 바꾸면 채운다. 같은 호스트 안에서는 덮지 않는다.
  const d = tempDir();
  fixture(d);
  const site = await serve(d);
  const other = site.base.replace('127.0.0.1', 'localhost');
  const win = await open();
  const setUrl = (u: string) => js(win, `(() => { const e = document.querySelector('[name="url"]'); e.value = ${JSON.stringify(u)}; e.dispatchEvent(new Event('change')); })()`);
  try {
    await fill(win, { url: `${site.base}/p1.html`, sel: '#c', next: '.next', exclude: '.ad', prefix: path.join(d, 'out', 'p') });
    await js(win, `document.querySelector('#run').click()`);
    await until<string>(win, `document.querySelector('#st-state').textContent`, v => /완료|실패/.test(v));
    await setUrl(`${other}/p1.html`);
    await fill(win, { sel: '#other', next: '.other', exclude: '' });
    await setUrl(`${site.base}/p2.html`);
    const got = await until<string[]>(win, `['sel', 'next', 'exclude'].map(k => document.querySelector('[name="' + k + '"]').value)`, v => v[0] === '#c');
    assert.deepEqual(got, ['#c', '.next', '.ad']);
    await fill(win, { sel: '#edited' });
    await setUrl(`${site.base}/p3.html`);
    await sleep(300);
    assert.equal(await js(win, `document.querySelector('[name="sel"]').value`), '#edited');
    const recent = await js<string[]>(win, `[...document.querySelectorAll('#recent option')].map(o => o.value)`);
    assert.equal(recent[0], `${site.base}/p1.html`);
  } finally {
    win.destroy();
    await site.close();
  }
});
