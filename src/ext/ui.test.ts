import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Page as PwPage } from 'playwright-core';
import type { RunResult } from './api';
import { ext, type Tab } from '../test/ext';
import { serve, tempDir } from '../test/serve';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PAGE = (n: number, next: string | null) =>
  `<meta charset="utf-8"><title>p${n}</title><body><div id=c>본문 ${n}</div>${next ? `<a id=next href="${next}">다음</a>` : ''}</body>`;

/** 페이지를 서버에 올린다. */
async function server(pages: Record<string, string>) {
  const d = tempDir();
  for (const [name, body] of Object.entries(pages)) fs.writeFileSync(path.join(d, name), body);
  return serve(d);
}

const TWO = { 'a.html': PAGE(1, 'b.html'), 'b.html': PAGE(2, null) };
const THREE = { 'a.html': PAGE(1, 'b.html'), 'b.html': PAGE(2, 'c.html'), 'c.html': PAGE(3, null) };

/** 서버와 대상 탭, 그 창의 패널 화면을 연다. */
async function setup(pages: Record<string, string>, o: Parameters<Awaited<ReturnType<typeof ext>>['openUi']>[1] = {}) {
  const x = await ext();
  const srv = await server(pages);
  const tab = await x.newTab(`${srv.base}/a.html`);
  const ui = await x.openUi(tab, o);
  return {
    x, tab, ui, base: srv.base,
    close: async () => {
      await ui.close();
      await x.closeTab(tab);
      await srv.close();
    },
  };
}

// 뒤쪽 탭은 그리지 않는다 → 마우스 대신 요소의 click 으로 누른다.
const click = (ui: PwPage, sel: string) => ui.evaluate(s => (document.querySelector(s) as HTMLElement).click(), sel);
const fill = (ui: PwPage, values: Record<string, string>) => ui.evaluate(v => {
  for (const [k, val] of Object.entries(v)) {
    const i = document.querySelector(`[name="${k}"]`) as HTMLInputElement;
    i.value = val;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, values);
const value = (ui: PwPage, name: string) => ui.evaluate(n => (document.querySelector(`[name="${n}"]`) as HTMLInputElement).value, name);
const text = (ui: PwPage, sel: string) => ui.evaluate(s => document.querySelector(s)!.textContent ?? '', sel);
const until = (ui: PwPage, sel: string, pattern: RegExp, timeout = 15000) =>
  ui.waitForFunction(([s, p]) => new RegExp(p).test(document.querySelector(s)!.textContent ?? ''), [sel, pattern.source] as const, { timeout, polling: 50 });
const ended = (ui: PwPage) => until(ui, '#st-state', /완료|실패|중지됨|입력 확인/);
const stored = (x: Awaited<ReturnType<typeof ext>>) => x.panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings as Record<string, unknown>);

async function goto(tab: Tab, url: string) {
  await tab.page.goto(url);
}

test('TC#78 extPanelMarksInvalidInputAndHasNoAppOnlyControls', async () => {
  const s = await setup(TWO, { folder: 'ui-78a' });
  try {
    assert.equal(await s.ui.evaluate(() => document.querySelectorAll('[name="headful"], #open-dir, #result-open').length), 0);
    await fill(s.ui, { sel: '', next: '#next' });
    await click(s.ui, '#run');
    await ended(s.ui);
    assert.match(await text(s.ui, '#result-text'), /^입력 확인 · 수집 대상과 next 셀렉터가 필요합니다/);
    assert.match(await text(s.ui, '#log'), /실패: 수집 대상과 next 셀렉터가 필요합니다/);
    assert.equal(await s.ui.evaluate(() => document.querySelector('[name="sel"]')!.getAttribute('aria-invalid')), 'true');
    assert.equal(await s.ui.evaluate(() => (document.activeElement as HTMLInputElement).name), 'sel');
    assert.equal(await s.ui.evaluate(() => (document.querySelector('#run') as HTMLButtonElement).disabled), false);
    await fill(s.ui, { sel: '#c', timeout: 'abc' });
    await click(s.ui, '#run');
    await until(s.ui, '#result-text', /타임아웃 ms 은 숫자여야 합니다/);
    assert.equal(await s.ui.evaluate(() => (document.querySelector('.advanced') as HTMLDetailsElement).open), true);
    assert.equal(await s.ui.evaluate(() => (document.activeElement as HTMLInputElement).name), 'timeout');
    // 입력값이 결과·알림 문구에 섞여도 마크업으로 해석하지 않는다.
    await fill(s.ui, { timeout: '15000', charset: '<b id=evil>nope-enc</b>' });
    await click(s.ui, '#run');
    await until(s.ui, '#result-text', /^입력 확인 · .*<b id=evil>nope-enc/);
    assert.equal(await s.ui.evaluate(() => document.querySelectorAll('#result b, #announce b, #log b').length), 0);
    assert.equal(await s.ui.evaluate(() => (document.activeElement as HTMLInputElement).name), 'charset');
    const url = await value(s.ui, 'url');
    await fill(s.ui, { charset: '', url: '' });
    await click(s.ui, '#probe');
    await until(s.ui, '#result-text', /^입력 확인 · URL 을 입력해 주세요\.$/);
    assert.equal(await s.ui.evaluate(() => (document.activeElement as HTMLInputElement).name), 'url');
    // 수집 대상이 비어도 probe 는 진행한다.
    await fill(s.ui, { url, sel: '' });
    await click(s.ui, '#probe');
    await until(s.ui, '#st-state', /완료/);
    assert.match(await text(s.ui, '#log'), /next '#next' -> 1개 매치/);
    // 셀렉터 문법이 틀리면 실패로 끝나고 요약에 사유가 붙는다.
    await s.ui.evaluate(() => { (document.querySelector('.advanced') as HTMLDetailsElement).open = true; });
    await fill(s.ui, { sel: '#c', exclude: '.ad[' });
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /실패/);
    assert.equal(await s.ui.evaluate(() => (document.querySelector('.advanced') as HTMLDetailsElement).open), false);
    assert.match(await text(s.ui, '#result-text'), /^실패 · 0페이지 · \d\d:\d\d · .+/);
    assert.equal(await text(s.ui, '#announce'), await text(s.ui, '#result-text'));
    assert.ok(await s.ui.evaluate(() => !!document.querySelector('#log .error')));
    await s.ui.evaluate(() => (document.querySelector('[data-mode="image"]') as HTMLButtonElement).click());
    assert.deepEqual(await s.ui.evaluate(() => ['title', 'exclude', 'merge'].map(n => (document.querySelector(`[name="${n}"]`) as HTMLInputElement).disabled)), [true, true, true]);
  } finally {
    await s.close();
  }
});

test('TC#78 extPanelRunsAndSummarizesWithFolderName', async () => {
  const s = await setup(TWO, { folder: 'ui-78b' });
  try {
    assert.equal(await s.ui.evaluate(() => document.querySelector('#guide')!.hasAttribute('hidden')), false);
    await fill(s.ui, { sel: '#c', next: '#next', prefix: 'novel/page', max: '5' });
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    assert.equal(await s.ui.evaluate(() => (document.querySelector('#guide') as HTMLElement).hidden), true);
    assert.equal(await text(s.ui, '#st-pages'), '2페이지');
    assert.match(await text(s.ui, '#st-file'), /page_0002\.txt$/);
    assert.match(await text(s.ui, '#result-text'), /^완료 · 2페이지 · \d\d:\d\d · .+ · 저장: ui-78b\/novel\/page$/);
    assert.equal(await text(s.ui, '#announce'), await text(s.ui, '#result-text'));
    assert.match(await s.ui.evaluate(() => document.querySelector('#log .ok')?.textContent ?? ''), /^완료: 2개 페이지$/);
    const files = await s.x.opfsFiles('ui-78b');
    assert.deepEqual(Object.keys(files).sort(), ['novel/page_0001.txt', 'novel/page_0002.txt']);
    assert.match(files['novel/page_0002.txt'], /본문 2/);
    assert.equal(await s.x.attached(s.tab.id), false);
  } finally {
    await s.close();
  }
});

test('TC#78 extPanelLogKeepsRecentLinesMarksLevelsAndShowsText', async () => {
  const s = await setup(TWO);
  try {
    await s.ui.evaluate(`import('./dist/ext/view.js').then(m => {
      const log = document.querySelector('#log');
      for (let i = 1; i <= 2005; i++) m.appendLog(log, '줄 ' + i, null);
      for (const l of ['warn', 'error', 'ok']) m.appendLog(log, l, l);
      m.appendLog(log, '중단: <img id=evil src=x>', 'info');
    })`);
    assert.equal(await s.ui.evaluate(() => document.querySelector('#log')!.childElementCount), 2000);
    assert.equal(await s.ui.evaluate(() => document.querySelector('#log')!.firstElementChild!.textContent), '줄 10');
    const marks = await s.ui.evaluate(() => ['warn', 'error', 'ok'].map(l => getComputedStyle(document.querySelector('#log .' + l)!, '::before').content));
    assert.deepEqual(marks, ['"! "', '"× "', '"✓ "']);
    assert.equal(await s.ui.evaluate(() => document.querySelectorAll('#log img').length), 0);
    assert.match(await text(s.ui, '#log'), /<img id=evil/);
  } finally {
    await s.close();
  }
});

test('TC#78 extPanelKeyboardStartsAndStops', async () => {
  const s = await setup(THREE, { folder: 'ui-78d' });
  try {
    await fill(s.ui, { sel: '#c', next: '#next', delay: '3000' });
    await s.ui.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    await until(s.ui, '#st-pages', /1페이지/);
    assert.match(await text(s.ui, '#st-state'), /수집 중/);
    assert.equal(await s.ui.evaluate(() => { const b = document.querySelector('#progress') as HTMLProgressElement; return !b.hidden && !b.hasAttribute('value'); }), true);
    await s.ui.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until(s.ui, '#st-state', /중지됨/);
    assert.match(await text(s.ui, '#result-text'), /^중지됨 · 1페이지 · .* 그때까지 받은 파일은 남아 있습니다\. · 저장: ui-78d\/page$/);
    assert.match(await text(s.ui, '#st-time'), /^\d\d:\d\d$/);
    // macOS 의 ⌘↵ 도 시작한다.
    await s.ui.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })));
    await until(s.ui, '#st-pages', /1페이지/);
    await s.ui.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until(s.ui, '#st-state', /중지됨/);
  } finally {
    await s.close();
  }
});

test('TC#40 extPanelPickFillsFields', async () => {
  const s = await setup(TWO, { folder: 'ui-78e' });
  try {
    await click(s.ui, '#pick');
    await s.tab.page.waitForFunction(() => !!document.querySelector('[data-ariadne-ui] button'), undefined, { timeout: 10000, polling: 50 });
    await s.x.clickAt(s.tab, '#c');
    await s.ui.waitForFunction(() => (document.querySelector('[name="sel"]') as HTMLInputElement).value === '#c', undefined, { timeout: 5000, polling: 50 });
    assert.deepEqual(await s.ui.evaluate(() => ['#run', '#probe', '#pick', '#stop'].map(q => (document.querySelector(q) as HTMLButtonElement).disabled)), [true, true, true, false]);
    const busy = await s.ui.evaluate(i => ariadne.probe({ ...i, sel: null, nextSel: null, opts: {} }), { tabId: s.tab.id, url: `${s.base}/a.html` });
    assert.equal(busy.error, '이미 실행 중입니다.');
    assert.deepEqual(await s.ui.evaluate(() => ariadne.picks), [{ key: 'sel', sel: '#c' }]);
    await s.x.clickAt(s.tab, '[data-ariadne-ui] button:nth-last-of-type(1)');
    await until(s.ui, '#st-state', /완료/);
    assert.match(await text(s.ui, '#log'), /\[본문\] #c/);
    assert.equal(await s.x.attached(s.tab.id), false);
  } finally {
    await s.close();
  }
});

test('TC#79 extPanelAllowsOneRunAtATime', async () => {
  const s = await setup(THREE, { folder: 'ui-79' });
  try {
    await fill(s.ui, { sel: '#c', next: '#next', delay: '3000', max: '3' });
    await click(s.ui, '#run');
    await until(s.ui, '#st-pages', /1페이지/);
    assert.deepEqual(await s.ui.evaluate(() => { const b = document.querySelector('#progress') as HTMLProgressElement; return [b.value, b.max]; }), [1, 3]);
    const disabled = await s.ui.evaluate(() => ['#run', '#probe', '#pick', '#stop'].map(q => (document.querySelector(q) as HTMLButtonElement).disabled));
    assert.deepEqual(disabled, [true, true, true, false]);
    const input = { tabId: s.tab.id, url: `${s.base}/a.html` };
    const other = await s.ui.evaluate(i => Promise.all([
      ariadne.probe({ ...i, sel: null, nextSel: null, opts: {} }),
      ariadne.pick({ ...i, opts: {} }),
      navigator.storage.getDirectory().then(d => ariadne.run({ ...i, sel: '#c', nextSel: '#next', prefix: 'x', opts: {} }, d)),
    ]), input) as RunResult[];
    assert.deepEqual(other.map(r => r.error), ['이미 실행 중입니다.', '이미 실행 중입니다.', '이미 실행 중입니다.']);
    assert.ok(await s.ui.evaluate(() => ariadne.logs.some(l => /^\[1\] /.test(l))), '진행 중인 실행의 로그가 남아 있어야 합니다');
    await click(s.ui, '#stop');
    await until(s.ui, '#st-state', /중지됨/);
    assert.equal(await s.x.attached(s.tab.id), false);
    assert.deepEqual(await s.ui.evaluate(() => ['#run', '#probe', '#pick', '#stop'].map(q => (document.querySelector(q) as HTMLButtonElement).disabled)), [false, false, false, true]);
  } finally {
    await s.close();
  }
});

test('TC#80 extPanelUrlFollowsCurrentTab', async () => {
  const x = await ext();
  const other = await server({ 'o.html': PAGE(9, null) });
  const host2 = new URL(other.base).host;
  const s = await setup(TWO, {
    folder: 'ui-80',
    settings: { sites: { [host2]: { sel: '#x', next: '#y', title: '', exclude: '', charset: '', mode: 'image' } } },
  });
  try {
    assert.equal(await value(s.ui, 'url'), `${s.base}/a.html`);
    // 같은 호스트 안에서 옮기면 사이트 설정이 있어도 고쳐 쓰던 셀렉터를 덮지 않는다.
    const here = new URL(s.base).host;
    await x.panel.evaluate(async h => {
      const cur = ((await chrome.storage.local.get('settings')).settings ?? {}) as { sites?: Record<string, unknown> };
      await chrome.storage.local.set({ settings: { ...cur, sites: { ...cur.sites, [h]: { sel: '#preset', next: '', title: '', exclude: '', charset: '', mode: 'text' } } } });
    }, here);
    await fill(s.ui, { sel: '#edited' });
    await goto(s.tab, `${s.base}/b.html`);
    await s.ui.waitForFunction(u => (document.querySelector('[name="url"]') as HTMLInputElement).value === u, `${s.base}/b.html`, { polling: 50 });
    await sleep(300);
    assert.equal(await value(s.ui, 'sel'), '#edited');
    await fill(s.ui, { url: `${s.base}/a.html?resume=1` });
    await goto(s.tab, 'about:blank');
    await sleep(500);
    assert.equal(await value(s.ui, 'url'), `${s.base}/a.html?resume=1`);
    // 주소가 보이지 않는 탭으로 옮겨도 칸을 그대로 둔다.
    const blank = await x.panel.evaluate(async t => (await chrome.tabs.create({ windowId: (await chrome.tabs.get(t)).windowId, url: 'about:blank', active: true })).id!, s.tab.id);
    await sleep(500);
    assert.equal(await value(s.ui, 'url'), `${s.base}/a.html?resume=1`);
    await x.panel.evaluate(async ([b, t]) => { await chrome.tabs.remove(b); await chrome.tabs.update(t, { active: true }); }, [blank, s.tab.id] as const);
    // 확장 페이지는 주소가 보이지만 받을 대상이 아니다.
    const own = await x.panel.evaluate(async t => (await chrome.tabs.create({ windowId: (await chrome.tabs.get(t)).windowId, url: chrome.runtime.getURL('manifest.json'), active: true })).id!, s.tab.id);
    await sleep(500);
    assert.equal(await value(s.ui, 'url'), `${s.base}/a.html?resume=1`);
    await x.panel.evaluate(async ([b, t]) => { await chrome.tabs.remove(b); await chrome.tabs.update(t, { active: true }); }, [own, s.tab.id] as const);
    await goto(s.tab, `${other.base}/o.html`);
    await s.ui.waitForFunction(u => (document.querySelector('[name="url"]') as HTMLInputElement).value === u, `${other.base}/o.html`, { polling: 50 });
    await s.ui.waitForFunction(() => (document.querySelector('[name="sel"]') as HTMLInputElement).value === '#x', undefined, { polling: 50 });
    assert.equal(await value(s.ui, 'next'), '#y');
    assert.equal(await s.ui.evaluate(() => document.querySelector('[data-mode="image"]')!.getAttribute('aria-pressed')), 'true');
    // 같은 창의 다른 탭으로 옮기면 그 탭 주소를 따른다.
    const second = await x.panel.evaluate(async ([t, u]) => (await chrome.tabs.create({ windowId: (await chrome.tabs.get(t)).windowId, url: u, active: true })).id!, [s.tab.id, `${s.base}/a.html`] as const);
    await s.ui.waitForFunction(u => (document.querySelector('[name="url"]') as HTMLInputElement).value === u, `${s.base}/a.html`, { polling: 50 });
    // 실행 중에는 엔진이 탭을 옮겨도 주소 칸이 그대로다.
    await s.ui.evaluate(() => (document.querySelector('[data-mode="text"]') as HTMLButtonElement).click());
    await fill(s.ui, { sel: '#c', next: '#next' });
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    assert.equal(await value(s.ui, 'url'), `${s.base}/a.html`);
    assert.match((await s.x.opfsFiles('ui-80'))['page_0002.txt'], /본문 2/);
    await x.panel.evaluate(t => chrome.tabs.remove(t), second);
    // 패널 화면 자신이 지금 탭이면 받을 탭이 없다.
    await s.ui.bringToFront();
    await s.ui.evaluate(async () => { await chrome.tabs.update((await chrome.tabs.getCurrent())!.id!, { active: true }); });
    await click(s.ui, '#run');
    await until(s.ui, '#result-text', /^입력 확인 · 수집할 탭이 없습니다\./);
  } finally {
    await s.close();
    await other.close();
  }
});

/** 폴더 권한 질의를 바꿔 끼운다. query 는 지금 권한, request 는 요청에 대한 사용자 답이다. hold 면 요청 답을 release() 까지 미룬다. */
const stubPermission = (ui: PwPage, query: PermissionState, request: PermissionState, hold = false) => ui.evaluate(([q, r, h]) => {
  const w = window as unknown as { asked: number; release?: () => void };
  w.asked = 0;
  const proto = FileSystemDirectoryHandle.prototype as unknown as Record<string, unknown>;
  proto.queryPermission = async () => q;
  proto.requestPermission = () => {
    w.asked++;
    return h ? new Promise(res => { w.release = () => res(r); }) : Promise.resolve(r);
  };
}, [query, request, hold] as const);

test('TC#81 extPanelAsksFolderPermissionAgain', async () => {
  const s = await setup(TWO, { folder: 'ui-81p' });
  try {
    await fill(s.ui, { sel: '#c', next: '#next' });
    await stubPermission(s.ui, 'prompt', 'denied');
    await click(s.ui, '#run');
    await until(s.ui, '#result-text', /^입력 확인 · 폴더에 쓸 권한이 없습니다\. \[폴더 선택\] 으로 다시 골라 주세요\.$/);
    assert.equal(await s.ui.evaluate(() => document.activeElement!.id), 'pick-dir');
    assert.equal(await s.ui.evaluate(() => (window as unknown as { asked: number }).asked), 1);
    await stubPermission(s.ui, 'prompt', 'granted');
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    assert.deepEqual(Object.keys(await s.x.opfsFiles('ui-81p')).sort(), ['page_0001.txt', 'page_0002.txt']);
    // 이미 허용된 폴더는 다시 묻지 않는다.
    await stubPermission(s.ui, 'granted', 'denied');
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    assert.equal(await s.ui.evaluate(() => (window as unknown as { asked: number }).asked), 0);
  } finally {
    await s.close();
  }
});

test('TC#78 extPanelStopWhilePreparingDoesNotRun', async () => {
  const s = await setup(TWO, { folder: 'ui-78s' });
  try {
    await fill(s.ui, { sel: '#c', next: '#next' });
    await stubPermission(s.ui, 'prompt', 'granted', true);
    await click(s.ui, '#run');
    await s.ui.waitForFunction(() => (window as unknown as { asked: number }).asked === 1, undefined, { polling: 50 });
    await s.ui.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await s.ui.evaluate(() => (window as unknown as { release: () => void }).release());
    await until(s.ui, '#st-state', /중지됨|완료/);
    assert.match(await text(s.ui, '#st-state'), /중지됨/);
    assert.match(await text(s.ui, '#result-text'), /^중지됨 · 0페이지/);
    assert.deepEqual(Object.keys(await s.x.opfsFiles('ui-78s')), []);
    assert.equal(await s.x.attached(s.tab.id), false);
  } finally {
    await s.close();
  }
});

test('TC#83 extPanelKeepsRecentWhenSavesOverlap', async () => {
  const x = await ext();
  const s = await setup(TWO, { folder: 'ui-83o' });
  try {
    // 입력 저장이 읽기를 늦게 마치는 사이 수집 시작이 최근 URL 을 남긴다.
    await s.ui.evaluate(() => {
      const area = chrome.storage.local as unknown as { get: (...a: unknown[]) => Promise<unknown> };
      const get = area.get.bind(area);
      let slow = true;
      area.get = async (...a: unknown[]) => {
        const got = await get(...a);
        if (slow) { slow = false; await new Promise(r => setTimeout(r, 1500)); }
        return got;
      };
    });
    await fill(s.ui, { sel: '#c', next: '#next' });
    await sleep(400);
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    await sleep(2000);
    assert.deepEqual((await stored(x)).recent, [`${s.base}/a.html`]);
  } finally {
    await s.close();
  }
});

test('TC#81 extPanelRemembersFolderAndRequiresOne', async () => {
  const s = await setup(TWO, { folder: null });
  try {
    assert.equal(await text(s.ui, '#dir-name'), '선택 안 됨');
    await fill(s.ui, { sel: '#c', next: '#next' });
    await click(s.ui, '#run');
    await until(s.ui, '#result-text', /^입력 확인 · 저장할 폴더를 골라 주세요\.$/);
    assert.equal(await s.ui.evaluate(() => document.activeElement!.id), 'pick-dir');
    await click(s.ui, '#probe');
    await until(s.ui, '#st-state', /완료/);
    assert.match(await text(s.ui, '#log'), /수집 대상 '#c' -> 1개 매치/);
    await s.ui.evaluate(`(async () => {
      const m = await import('./dist/ext/folder.js');
      await m.saveFolder(await (await navigator.storage.getDirectory()).getDirectoryHandle('ui-81', { create: true }));
    })()`);
    await s.ui.reload();
    await s.ui.waitForFunction(() => document.body.dataset.ready === '1', undefined, { polling: 50 });
    assert.equal(await text(s.ui, '#dir-name'), 'ui-81');
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    assert.deepEqual(Object.keys(await s.x.opfsFiles('ui-81')).sort(), ['page_0001.txt', 'page_0002.txt']);
  } finally {
    await s.close();
  }
});

test('TC#83 extPanelSavesAndRestoresSettings', async () => {
  const x = await ext();
  const s = await setup(TWO, { folder: 'ui-83', settings: { sel: 5, next: '#n', foo: 1, recent: 'x', sites: [], merge: 'yes' } });
  try {
    assert.equal(await value(s.ui, 'sel'), '');
    assert.equal(await value(s.ui, 'next'), '#n');
    assert.equal(await value(s.ui, 'prefix'), 'page');
    await fill(s.ui, { title: 'h1', sel: '#c', next: '#next' });
    await s.ui.evaluate(() => (document.querySelector('[name="merge"]') as HTMLInputElement).click());
    await s.ui.evaluate(() => (document.querySelector('[data-mode="image"]') as HTMLButtonElement).click());
    await sleep(800);
    const saved = await stored(x);
    assert.equal(saved.title, 'h1');
    assert.equal(saved.mode, 'image');
    assert.equal(saved.merge, true);
    assert.equal(saved.foo, undefined);
    await s.ui.reload();
    await s.ui.waitForFunction(() => document.body.dataset.ready === '1', undefined, { polling: 50 });
    assert.equal(await value(s.ui, 'title'), 'h1');
    assert.equal(await s.ui.evaluate(() => document.querySelector('[data-mode="image"]')!.getAttribute('aria-pressed')), 'true');
    await s.ui.evaluate(() => (document.querySelector('[data-mode="text"]') as HTMLButtonElement).click());
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    const after = await stored(x);
    assert.deepEqual(after.recent, [`${s.base}/a.html`]);
    assert.equal((after.sites as Record<string, { sel: string; mode: string }>)[new URL(s.base).host].sel, '#c');
    await s.ui.waitForFunction(() => document.querySelectorAll('#recent option').length === 1, undefined, { polling: 50 });
  } finally {
    await s.close();
  }
});

test('TC#84 extPanelNotifiesOnlyWhenUnfocusedScrapeEnds', async () => {
  const s = await setup(TWO, { folder: 'ui-84' });
  try {
    assert.equal(await s.ui.evaluate(() => typeof chrome.notifications?.create), 'function');
    await s.ui.evaluate(() => {
      const w = window as unknown as { notes: unknown[]; focused: boolean };
      w.notes = [];
      w.focused = false;
      chrome.notifications.create = ((o: unknown) => { w.notes.push(o); return Promise.resolve('n'); }) as typeof chrome.notifications.create;
      document.hasFocus = () => w.focused;
    });
    const notes = () => s.ui.evaluate(() => (window as unknown as { notes: { title: string; message: string; iconUrl: string }[] }).notes);
    await fill(s.ui, { sel: '#c', next: '#next' });
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    const got = await notes();
    assert.equal(got.length, 1);
    assert.equal(got[0].title, 'ariadne 수집 완료');
    assert.equal(got[0].message, '2페이지를 받았습니다.');
    assert.match(got[0].iconUrl, /^chrome-extension:\/\/.+\/icon\.png$/);
    await fill(s.ui, { exclude: '.ad[' });
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /실패/);
    await fill(s.ui, { exclude: '', delay: '3000' });
    await click(s.ui, '#run');
    await until(s.ui, '#st-pages', /1페이지/);
    await click(s.ui, '#stop');
    await until(s.ui, '#st-state', /중지됨/);
    assert.deepEqual((await notes()).map(n => n.title), ['ariadne 수집 완료', 'ariadne 수집 실패', 'ariadne 수집 중지']);
    await fill(s.ui, { delay: '0' });
    await click(s.ui, '#probe');
    await until(s.ui, '#st-state', /완료/);
    await click(s.ui, '#pick');
    await s.tab.page.waitForFunction(() => !!document.querySelector('[data-ariadne-ui] button'), undefined, { timeout: 10000, polling: 50 });
    await click(s.ui, '#stop');
    await until(s.ui, '#st-state', /중지됨/);
    assert.equal((await notes()).length, 3);
    await s.ui.evaluate(() => { (window as unknown as { focused: boolean }).focused = true; });
    await click(s.ui, '#run');
    await until(s.ui, '#st-state', /완료/);
    assert.equal((await notes()).length, 3);
  } finally {
    await s.close();
  }
});

test('TC#85 extActionOpensSidePanel', async () => {
  const x = await ext();
  const got = await x.panel.evaluate(async () => ({ behavior: await chrome.sidePanel.getPanelBehavior(), action: chrome.runtime.getManifest().action, panel: chrome.runtime.getManifest().side_panel }));
  assert.equal(got.behavior.openPanelOnActionClick, true);
  assert.ok(got.action);
  assert.equal(got.panel?.default_path, 'panel.html');
});
