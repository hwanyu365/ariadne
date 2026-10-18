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

const fill = (win: BrowserWindow, values: Record<string, string>) => win.webContents.executeJavaScript(`(() => {
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
