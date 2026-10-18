import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { tempDir } from '../test/serve';
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
registerIpc({ settingsPath: settingsFile, defaultPrefix: path.join(tempDir(), 'page') });

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
    assert.match(log, /URL 을 입력하라/);
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
