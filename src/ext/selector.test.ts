import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { RunResult } from './api';
import { ext, type Tab } from '../test/ext';
import { serve, tempDir } from '../test/serve';

const write = (file: string, body: string | Buffer) => fs.writeFileSync(file, body);
const joined = (r: RunResult) => r.logs.join('\n');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 페이지 몇 개를 서버에 올리고 새 대상 탭을 연다. */
async function site(pages: Record<string, string | Buffer>) {
  const x = await ext();
  const d = tempDir();
  for (const [name, body] of Object.entries(pages)) write(path.join(d, name), body);
  const srv = await serve(d);
  const tab = await x.newTab();
  return {
    x, tab, base: srv.base,
    close: async () => {
      await x.closeTab(tab);
      await srv.close();
    },
  };
}

const PAGE = `<meta charset="utf-8"><body><div id=c>본문 가나다<span class=ad>광고</span></div>
<a id=next href="b.html">다음</a><a id=away href="away.html">밖으로</a></body>`;
const pickable = { 'a.html': PAGE, 'b.html': PAGE, 'away.html': '<meta charset="utf-8"><body><div id=c>다른 문서</div></body>' };
const off = (tab: Tab) => tab.page.waitForFunction(() => !document.querySelector('[data-ariadne-ui]'), undefined, { timeout: 8000, polling: 100 });

const uiCount = (tab: Tab) => tab.page.evaluate(() => document.querySelectorAll('[data-ariadne-ui]').length);

test('TC#74 extProbeShowsResultsAndDetaches', async () => {
  const s = await site({
    'p.html': Buffer.from('<body><div id=c>본문 가나다<span class=ad>광고</span></div><a class="next" href="q.html">다음</a><iframe src="f.html"></iframe><div id=g><img src="x.png" width=400 height=400></div></body>'),
    'f.html': 'frame',
  });
  try {
    const r = await s.x.probe(s.tab, `${s.base}/p.html`, '#c', '.next', { exclude: '.ad' });
    const log = joined(r);
    assert.equal(r.error, null, log);
    assert.match(log, /인코딩: /);
    assert.match(log, /경고: 페이지는 utf-8 로 보이는데/);
    assert.match(log, /수집 대상 '#c' -> 1개 매치\n    \[0\] '.+'/);
    assert.doesNotMatch(log, /광고/);
    assert.match(log, /next '\.next' -> 1개 매치/);
    assert.match(log, /주의: iframe 1개/);
    assert.match(log, /\[next 버튼 후보\]\n    a\.next/);
    assert.match(log, /\[본문 후보 /);
    assert.match(log, /\[이미지 후보 [^\n]*\]\n    #g /);
    assert.match(s.tab.page.url(), /\/p\.html$/);
    assert.equal(await s.x.attached(s.tab.id), false);
    assert.equal(await s.x.tabExists(s.tab.id), true);
  } finally {
    await s.close();
  }
});

test('TC#74 extProbeStopsWhenTabCloses', async () => {
  const s = await site({ 'p.html': PAGE });
  try {
    let go!: () => void;
    const started = new Promise<void>(r => { go = r; });
    // probe 는 지연 렌더를 기다린다 → 그 사이에 탭을 닫는다.
    const done = s.x.probe(s.tab, `${s.base}/p.html`, '#c', null, { delay: 5000 }, go);
    await started;
    await s.tab.page.waitForURL(/p\.html/, { waitUntil: 'commit' });
    await s.x.closeTab(s.tab);
    const r = await done;
    assert.equal(r.error, null, joined(r));
    assert.match(joined(r), /중단: 대상 탭이 닫혔습니다\./);
  } finally {
    await s.close();
  }
});

test('TC#75 extPickerSendsPicksAndCleansUp', async () => {
  const s = await site(pickable);
  try {
    const { done: done } = await s.x.pick(s.tab, `${s.base}/a.html`);
    await s.x.clickAt(s.tab, '#c');
    await s.x.panel.waitForFunction(() => ariadne.picks.length > 0, undefined, { timeout: 5000 });
    // 선택기 링크 클릭은 이동하지 않는다.
    await s.x.clickAt(s.tab, '#next');
    await sleep(500);
    assert.match(s.tab.page.url(), /a\.html$/);
    // 툴바의 완료 버튼을 사람처럼 누른다.
    await s.x.clickAt(s.tab, '[data-ariadne-ui] button:nth-last-of-type(1)');
    const r = await done;
    assert.equal(r.error, null, joined(r));
    assert.deepEqual(await s.x.panel.evaluate(() => ariadne.picks[0]), { key: 'sel', sel: '#c' });
    assert.match(joined(r), /\[본문\] #c/);
    assert.equal(await s.x.attached(s.tab.id), false);
    assert.equal(await uiCount(s.tab), 0);
    // 걷힌 뒤에는 링크가 원래대로 이동한다.
    await s.x.clickAt(s.tab, '#next');
    await s.tab.page.waitForURL(/b\.html$/, { waitUntil: 'commit', timeout: 5000 });
  } finally {
    await s.close();
  }
});

test('TC#75 extPickerEndsOnStopAndTabClose', async () => {
  const s = await site(pickable);
  try {
    const { done: stopped } = await s.x.pick(s.tab, `${s.base}/a.html`);
    await s.x.panel.evaluate(() => ariadne.stop());
    assert.equal((await stopped).error, null);
    assert.equal(await s.x.attached(s.tab.id), false);
    assert.equal(await uiCount(s.tab), 0);
    const { done: closed } = await s.x.pick(s.tab, `${s.base}/a.html`);
    await s.x.closeTab(s.tab);
    const r = await Promise.race([closed, sleep(5000).then(() => null)]);
    assert.ok(r, '탭을 닫아도 선택기가 끝나지 않았습니다.');
    assert.equal(r.error, null, joined(r));
  } finally {
    await s.close();
  }
});

test('TC#75 extPickerCleansUpWhenDebuggerIsDetachedOutside', async () => {
  // 디버깅 배너의 취소처럼 디버거가 밖에서 떨어지면 패널은 탭에 아무것도 실행할 수 없다 → 선택기가 스스로 걷힌다.
  const s = await site(pickable);
  try {
    const { done } = await s.x.pick(s.tab, `${s.base}/a.html`);
    await s.x.panel.evaluate(t => chrome.debugger.detach({ tabId: t }), s.tab.id);
    await off(s.tab);
    const r = await Promise.race([done, sleep(5000).then(() => null)]);
    assert.ok(r, '디버거가 떨어져도 선택기가 끝나지 않았습니다.');
    assert.equal(r.error, null, joined(r));
    await s.x.clickAt(s.tab, '#next');
    await s.tab.page.waitForURL(/b\.html$/, { waitUntil: 'commit', timeout: 5000 });
  } finally {
    await s.close();
  }
});

test('TC#75 extPickerComesBackWhenRemovedWhileConnected', async () => {
  // 탭이 몇 초 멈추거나 시계가 뛰면 연결이 살아 있어도 선택기가 스스로 걷힐 수 있다 → 그 상태를 직접 만든다.
  const s = await site(pickable);
  try {
    const { done } = await s.x.pick(s.tab, `${s.base}/a.html`);
    await s.x.panel.evaluate(async t => {
      const contexts: { id: number; name: string; auxData?: { frameId?: string } }[] = [];
      const on = (src: chrome.debugger.Debuggee, method: string, ev?: any) => { if (src.tabId === t && method === 'Runtime.executionContextCreated') contexts.push(ev.context); };
      chrome.debugger.onEvent.addListener(on);
      const send = (m: string, p?: object) => chrome.debugger.sendCommand({ tabId: t }, m, p) as Promise<any>;
      const main = (await send('Page.getFrameTree')).frameTree.frame.id;
      // 이미 켜진 Runtime 을 다시 켜면 있는 world 를 다시 알린다.
      await send('Runtime.disable');
      await send('Runtime.enable');
      chrome.debugger.onEvent.removeListener(on);
      const world = contexts.find(c => c.name === 'ariadne' && c.auxData?.frameId === main)!;
      await send('Runtime.evaluate', { contextId: world.id, expression: 'window.__ariadnePickerOff()' });
    }, s.tab.id);
    assert.equal(await uiCount(s.tab), 0);
    await s.tab.page.waitForFunction(() => !!document.querySelector('[data-ariadne-ui] button'), undefined, { timeout: 5000, polling: 100 });
    await s.x.clickAt(s.tab, '#c');
    await s.x.panel.waitForFunction(() => ariadne.picks.length > 0, undefined, { timeout: 5000 });
    await s.x.panel.evaluate(() => ariadne.stop());
    assert.equal((await done).error, null);
  } finally {
    await s.x.panel.evaluate(() => ariadne.stop());
    await s.close();
  }
});

test('TC#76 extPickerFollowsUserNavigationAndCharset', async () => {
  const s = await site({
    ...pickable,
    'u.html': Buffer.from('<body><div id=c>본문 가나다</div></body>'),
    'v.html': Buffer.from('<body><div id=c>옮긴 문서 가나다</div></body>'),
  });
  try {
    const { done: done } = await s.x.pick(s.tab, `${s.base}/u.html`, { charset: 'utf-8' });
    assert.equal(await s.tab.page.evaluate(() => document.querySelector('#c')!.textContent), '본문 가나다');
    // 사용자가 주소를 옮겨도 선택기는 끝나지 않고 새 문서에 다시 선다.
    await s.tab.page.goto(`${s.base}/v.html`, { waitUntil: 'commit' });
    await s.tab.page.waitForFunction(() => !!document.querySelector('[data-ariadne-ui] button'), undefined, { timeout: 5000, polling: 50 });
    assert.equal(await s.tab.page.evaluate(() => document.querySelector('#c')!.textContent), '옮긴 문서 가나다');
    await s.x.clickAt(s.tab, '#c');
    await s.x.panel.waitForFunction(() => ariadne.picks.length > 0, undefined, { timeout: 5000 });
    await s.x.panel.evaluate(() => ariadne.stop());
    assert.equal((await done).error, null);
  } finally {
    await s.close();
  }
});

test('TC#77 extPickChannelIsHiddenFromPageAndIgnoresSyntheticClicks', async () => {
  const s = await site(pickable);
  try {
    const { done: done } = await s.x.pick(s.tab, `${s.base}/a.html`);
    const seen = await s.tab.page.evaluate(() => [typeof (window as any).__ariadne_pick, typeof (window as any).__ariadne_done, typeof (window as any).__ariadneCandidates, typeof (window as any).__ariadneBind]);
    assert.deepEqual(seen, ['undefined', 'undefined', 'undefined', 'undefined']);
    // 페이지가 합성한 클릭은 선택·완료가 아니다.
    await s.tab.page.evaluate(() => {
      (document.querySelector('#c') as HTMLElement).click();
      document.querySelectorAll<HTMLButtonElement>('[data-ariadne-ui] button').forEach(b => b.click());
    });
    await sleep(500);
    assert.equal(await s.x.panel.evaluate(() => ariadne.picks.length), 0);
    const still = await Promise.race([done.then(() => 'ended'), sleep(300).then(() => 'running')]);
    assert.equal(still, 'running');
    // 사람이 한 번 고른 뒤 생기는 후보 버튼도 합성 클릭으로는 선택되지 않는다.
    await s.x.clickAt(s.tab, '#c');
    await s.x.panel.waitForFunction(() => ariadne.picks.length === 1, undefined, { timeout: 5000 });
    await s.tab.page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('[data-ariadne-ui] button').forEach(b => b.click()));
    await sleep(500);
    assert.equal(await s.x.panel.evaluate(() => ariadne.picks.length), 1);
    await s.x.panel.evaluate(() => ariadne.stop());
    await done;
  } finally {
    await s.close();
  }
});

test('TC#77 extPickKeepsOnlyCheckedValues', async () => {
  // 선택값은 대상 페이지가 정한 값이다 → 통로로 들어와도 형태가 틀린 값은 입력란 값이 되지 않는다.
  const s = await site(pickable);
  try {
    const { done } = await s.x.pick(s.tab, `${s.base}/a.html`);
    // 선택기와 같은 이름의 격리 world 를 하나 더 만들면 통로 바인딩이 그 world 에도 생긴다.
    const sent = await s.x.panel.evaluate(async t => {
      const send = (m: string, p?: object) => chrome.debugger.sendCommand({ tabId: t }, m, p) as Promise<any>;
      const frame = (await send('Page.getFrameTree')).frameTree.frame.id;
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame, worldName: 'ariadne' });
      const bad = [{ target: 'constructor', sel: '#x' }, { target: '__proto__', sel: '#x' }, { target: '본문', sel: '  ' }, { target: '본문', sel: 7 }, null, 'text'];
      const good = { target: 'next', sel: '#next', candidates: [{ sel: '#next', n: 1 }, { sel: 3 }] };
      for (const payload of [...bad, good])
        await send('Runtime.evaluate', { contextId: executionContextId, expression: `__ariadneBind(${JSON.stringify(JSON.stringify({ kind: 'pick', payload }))})` });
      return bad.length + 1;
    }, s.tab.id);
    assert.equal(sent, 7);
    await s.x.panel.waitForFunction(() => ariadne.picks.length > 0, undefined, { timeout: 5000 });
    await sleep(300);
    assert.deepEqual(await s.x.panel.evaluate(() => ariadne.picks), [{ key: 'next', sel: '#next' }]);
    assert.match(await s.x.panel.evaluate(() => ariadne.logs.join('\n')), /\[next\] #next {3}후보: #next\(1\)$/m);
    await s.x.panel.evaluate(() => ariadne.stop());
    await done;
  } finally {
    await s.close();
  }
});

test('TC#77 extPickGoesOnlyToItsOwnPanel', async () => {
  const a = await site(pickable);
  const b = await site(pickable);
  const other = await a.x.openPanel();
  try {
    const { done: doneA } = await a.x.pick(a.tab, `${a.base}/a.html`);
    const { done: doneB } = await b.x.pick(b.tab, `${b.base}/a.html`, {}, other);
    await b.x.clickAt(b.tab, '#c');
    await other.waitForFunction(() => ariadne.picks.length > 0, undefined, { timeout: 5000 });
    await b.x.clickAt(b.tab, '[data-ariadne-ui] button:nth-last-of-type(1)');
    await doneB;
    await sleep(300);
    assert.equal(await a.x.panel.evaluate(() => ariadne.picks.length), 0);
    const still = await Promise.race([doneA.then(() => 'ended'), sleep(300).then(() => 'running')]);
    assert.equal(still, 'running');
    await a.x.panel.evaluate(() => ariadne.stop());
    await doneA;
  } finally {
    await other.close();
    await a.close();
    await b.close();
  }
});
