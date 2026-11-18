import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { RunOptions, RunResult } from './api';
import { ext, type Tab } from '../test/ext';
import { type Handler, serve, staticFile, tempDir } from '../test/serve';

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('fixture'.repeat(4))]);
const write = (file: string, body: string | Buffer) => fs.writeFileSync(file, body);
const pageHtml = (body: string, next: string) => `<meta charset="utf-8"><body><div id=c>${body}</div>${next}</body>`;
const LAST = '<a class="next" aria-disabled="true">next</a>';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function writeLink(d: string, n = 3) {
  for (let i = 1; i <= n; i++) write(path.join(d, `p${i}.html`), pageHtml(`본문 ${i}`, i < n ? `<a class="next" href="p${i + 1}.html">next</a>` : LAST));
}

function writeImagePages(d: string, n: number, attr = 'src') {
  for (let i = 1; i <= n; i++) {
    for (const name of ['a', 'b']) write(path.join(d, `${name}${i}.png`), PNG);
    const nxt = i < n ? `<a class="next" href="i${i + 1}.html">next</a>` : LAST;
    write(path.join(d, `i${i}.html`), `<body><div id=c><img ${attr}="a${i}.png"><img ${attr}="b${i}.png"></div>${nxt}</body>`);
  }
}

const files = (root: string, sub = 'out') => {
  const d = path.join(root, sub);
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => fs.statSync(path.join(d, f)).isFile()).sort() : [];
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const joined = (r: RunResult) => r.logs.join('\n');

interface Site {
  base: string;
  close: () => Promise<void>;
}

/** 서버 하나와 새 대상 탭으로 수집한다. 결과 파일은 out 아래 root 에 내려받는다. */
async function collect(site: (d: string) => Promise<Site>, start: string, sel: string, opts: RunOptions = {}, prepare?: (root: string) => void,
  during?: (tab: Tab, done: Promise<RunResult>) => Promise<void>) {
  const x = await ext();
  const d = tempDir();
  const root = tempDir();
  prepare?.(root);
  const srv = await site(d);
  const tab = await x.newTab();
  try {
    let go!: () => void;
    const started = new Promise<void>(r => { go = r; });
    const done = x.scrape(tab, `${srv.base}${start}`, sel, '.next', root, 'out/p', { timeout: 5000, ...opts }, undefined, go);
    if (during) {
      await started;
      await during(tab, done);
    }
    const r = await done;
    // 완료·실패·중지 어느 쪽으로 끝나도 디버거는 떨어진다. 탭이 닫혔으면 볼 것이 없다.
    if (await x.tabExists(tab.id)) assert.equal(await x.attached(tab.id), false, joined(r));
    return { r, root, tab, base: srv.base, out: files(root) };
  } finally {
    await x.closeTab(tab);
    await srv.close();
  }
}

const served = (write: (d: string) => void, handler?: Handler) => async (d: string) => {
  write(d);
  return serve(d, handler);
};

// 앱과 같은 순회·저장 규칙을 확장의 Page·Sink 로 다시 본다.

test('TC#1 extLinkPagination', async () => {
  const { r, root, out } = await collect(served(writeLink), '/p1.html', '#c');
  assert.equal(r.pages, 3, joined(r));
  assert.deepEqual(out, ['p_0001.txt', 'p_0002.txt', 'p_0003.txt']);
  assert.deepEqual(out.map(f => read(root, `out/${f}`)), ['본문 1', '본문 2', '본문 3']);
});

test('TC#1 extSpaPagination', async () => {
  const { r, out } = await collect(served(d => write(path.join(d, 'spa.html'), `<meta charset="utf-8"><body><div id=c>본문 1</div><button class=next>next</button>
<script>let i=1;document.querySelector('.next').onclick=()=>{ if(i>=3)return; i++; setTimeout(()=>{c.textContent='본문 '+i; if(i>=3)document.querySelector('.next').disabled=true;},300);}</script></body>`)), '/spa.html', '#c');
  assert.equal(r.pages, 3, joined(r));
  assert.equal(out.length, 3);
});

test('TC#2 extClickWaitsUntilNextReceivesIt', async () => {
  const { r } = await collect(served(d => {
    write(path.join(d, 'm1.html'), `<meta charset="utf-8"><body><div id=c>본문 1</div><a class="next" href="m2.html">next</a>
<div id=veil style="position:fixed;inset:0;background:rgba(0,0,0,.01)"></div><script>setTimeout(() => veil.remove(), 600);</script></body>`);
    write(path.join(d, 'm2.html'), pageHtml('본문 2', LAST));
  }), '/m1.html', '#c');
  assert.equal(r.pages, 2, joined(r));
});

test('TC#11 extErrorPagesAreNotSaved', async () => {
  const start = await collect(served(() => {}, (_q, res) => { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pageHtml('없음', '')); }), '/a.html', '#c');
  assert.equal(start.r.pages, 0, joined(start.r));
  assert.deepEqual(start.out, []);
  assert.match(joined(start.r), /중단.*HTTP 404/);
  const next = await collect(served(d => write(path.join(d, 'a.html'), pageHtml('본문 1', '<a class="next" href="b.html">next</a>')), (q, res) => {
    if (q.url === '/b.html') { res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pageHtml('점검 중', LAST)); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pageHtml('본문 1', '<a class="next" href="b.html">next</a>'));
  }), '/a.html', '#c');
  assert.deepEqual(next.out, ['p_0001.txt']);
  assert.match(joined(next.r), /중단.*HTTP 503/);
});

const stuck = served(d => write(path.join(d, 'stuck.html'), pageHtml('본문 1', '<button class=next>next</button>')));

test('TC#12 extStopWhileWaitingStopsAtOnce', async () => {
  const x = await ext();
  const started = Date.now();
  const { r } = await collect(stuck, '/stuck.html', '#c', { timeout: 10000 }, undefined, async () => {
    await x.waitLog(/^\[1\]/);
    await x.panel.evaluate(() => ariadne.stop());
  });
  assert.equal(r.pages, 1);
  assert.ok(Date.now() - started < 8000, String(Date.now() - started));
  assert.match(joined(r), /중단: 사용자 중지/);
});

test('TC#14 extDigitsAndStart', async () => {
  const { out } = await collect(served(writeLink), '/p1.html', '#c', { digits: 3, start: 65 });
  assert.deepEqual(out, ['p_065.txt', 'p_066.txt', 'p_067.txt']);
});

test('TC#15 extWarnsWhenFirstFileExists', async () => {
  const { r } = await collect(served(writeLink), '/p1.html', '#c', { maxPages: 1 }, root => {
    fs.mkdirSync(path.join(root, 'out'));
    write(path.join(root, 'out', 'P_0001.txt'), 'old');
  });
  assert.match(joined(r), /경고: 이미 같은 이름의 파일이 있어/);
});

test('TC#19 extMergeAppendsWhenResuming', async () => {
  const { root } = await collect(served(writeLink), '/p2.html', '#c', { merge: true, start: 2 }, root => {
    fs.mkdirSync(path.join(root, 'out'));
    write(path.join(root, 'out', 'p_all.txt'), '본문 1');
  });
  assert.equal(read(root, 'out/p_all.txt'), '본문 1\n\n본문 2\n\n본문 3');
});

const undeclared = served(d => {
  write(path.join(d, 'a.html'), '<body><div id=c>본문 1 가나다</div><a class="next" href="b.html">next</a></body>');
  write(path.join(d, 'b.html'), '<body><div id=c>본문 2 가나다</div><a class="next" aria-disabled="true">next</a></body>');
});

test('TC#20 extCharsetUndeclaredUtf8Warns', async () => {
  const { r, root, out } = await collect(undeclared, '/a.html', '#c');
  assert.equal(r.pages, 2, joined(r));
  assert.notEqual(read(root, `out/${out[0]}`), '본문 1 가나다');
  assert.equal(r.logs.filter(l => l.includes('경고: 페이지는 utf-8 로 보이는데')).length, 1, joined(r));
});

test('TC#21 extCharsetForcedReadsUndeclaredUtf8', async () => {
  const { r, root, out } = await collect(undeclared, '/a.html', '#c', { charset: 'utf-8' });
  assert.deepEqual(out.map(f => read(root, `out/${f}`)), ['본문 1 가나다', '본문 2 가나다'], joined(r));
});

test('TC#22 extCharsetForcedLeavesIframeAlone', async () => {
  const { r } = await collect(served(d => {
    write(path.join(d, 'outer.html'), Buffer.from('<body><div id=c>본문 가나다</div><iframe src="inner.html"></iframe></body>'));
    write(path.join(d, 'inner.html'), Buffer.concat([Buffer.from('<meta charset="euc-kr"><body><div id=i>'),
      Buffer.from([0xb1, 0xa4, 0xb0, 0xed, 0x20, 0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9]), Buffer.from('</div></body>')]));
  }), '/outer.html', '#c', { charset: 'utf-8' }, undefined, async (t, done) => {
    await done;
    const inner = await t.page.frames().find(f => f.url().endsWith('inner.html'))!.evaluate(() => document.querySelector('#i')!.textContent);
    assert.equal(inner, '광고 가나다');
  });
  assert.equal(r.pages, 1, joined(r));
});

test('TC#26 extImageModeChecksResponseIsImage', async () => {
  const { r, out } = await collect(served(d => {
    write(path.join(d, 'a.jpg'), PNG);
    write(path.join(d, 'i.html'), '<body><div id=c><img src="a.jpg"><img src="blocked.png"></div></body>');
  }, (q, res, dir) => {
    if (q.url!.endsWith('blocked.png')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hotlink</html>'); return; }
    staticFile()(q, res, dir);
  }), '/i.html', '#c img', { mode: 'image' });
  assert.deepEqual(out, ['p_0001_001.png'], joined(r));
  assert.match(joined(r), /건너뜀.*blocked\.png/);
});

test('TC#27 extImageModeSkipsStalledImage', async () => {
  const { r, out } = await collect(served(d => writeImagePages(d, 2), (q, res, dir) => { if (!q.url!.endsWith('b1.png')) staticFile()(q, res, dir); }),
    '/i1.html', '#c img', { mode: 'image', timeout: 1500 });
  assert.equal(r.pages, 2, joined(r));
  assert.deepEqual(out, ['p_0001_001.png', 'p_0002_001.png', 'p_0002_002.png']);
  assert.match(joined(r), /건너뜀.*b1\.png/);
});

/** 이미지 서버를 따로 띄워 요청마다 Referer 를 남긴다. */
async function imageServer(names: string[], extra?: (q: http.IncomingMessage, res: http.ServerResponse, dir: string) => boolean) {
  const dir = tempDir();
  for (const n of names) write(path.join(dir, n), PNG);
  const seen: [string, string | undefined][] = [];
  const srv = await serve(dir, (q, res, d) => {
    seen.push([q.url!, q.headers.referer]);
    if (!extra?.(q, res, d)) staticFile()(q, res, d);
  });
  return { ...srv, seen };
}

test('TC#27 extOverlappingFetchIsRejected', async () => {
  // Referer 규칙은 요청 하나의 정책만 담는다 → 겹친 요청은 거부한다.
  const x = await ext();
  const d = tempDir();
  write(path.join(d, 'a.png'), PNG);
  const srv = await serve(d, (q, res, dir) => { setTimeout(() => staticFile()(q, res, dir), 400); });
  const tab = await x.newTab();
  try {
    // 확장 모듈을 패널에서 직접 불러야 한다 → 테스트 빌드가 import() 를 require 로 바꾸지 않게 식을 문자열로 보낸다.
    const got = await x.panel.evaluate(`(async () => {
      const { DebuggerPage } = await import('./dist/ext/page.js');
      const page = await DebuggerPage.open(${tab.id}, {}, () => {});
      try {
        const url = ${JSON.stringify(`${srv.base}/a.png`)};
        const first = page.fetch(url, 3000);
        const second = await page.fetch(url, 3000).then(() => 'ok', e => e.message);
        return [(await first).status, second];
      } finally {
        page.close();
      }
    })()`) as [number, string];
    assert.equal(got[0], 200);
    assert.match(String(got[1]), /동시에 받지 않습니다/);
  } finally {
    await x.closeTab(tab);
    await srv.close();
  }
});

test('TC#28 extRefererSameAndCrossOrigin', async () => {
  const images = await imageServer(['x.png']);
  try {
    const { r, out, base } = await collect(served(d => {
      write(path.join(d, 'a.png'), PNG);
      write(path.join(d, 'i.html'), `<body><div id=c><img src="a.png"><img src="${images.base}/x.png"></div></body>`);
    }, (q, res, dir) => { if (q.url!.endsWith('a.png')) sameSeen.push(q.headers.referer); staticFile()(q, res, dir); }), '/i.html?q=1#f', '#c img', { mode: 'image' });
    assert.deepEqual(out, ['p_0001_001.png', 'p_0001_002.png'], joined(r));
    // 그리기 1건 + 수집 1건이다 → 수집 요청이 서버에 오지 않으면 공허하다.
    assert.deepEqual(sameSeen, [`${base}/i.html?q=1`, `${base}/i.html?q=1`]);
    assert.deepEqual(images.seen.map(s => s[1]), [`${base}/`, `${base}/`]);
  } finally {
    sameSeen.length = 0;
    await images.close();
  }
});
const sameSeen: (string | undefined)[] = [];

test('TC#28 extPageReferrerPolicyDecidesReferer', async () => {
  const images = await imageServer(['plain.png', 'attr.png']);
  try {
    const { r, base } = await collect(served(() => {}, (_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<meta name="referrer" content="unsafe-url"><body><div id=c><img src="${images.base}/plain.png"><img referrerpolicy="no-referrer" src="${images.base}/attr.png"></div></body>`);
    }), '/m/page.html', '#c img', { mode: 'image' });
    // 그리기 2건 + 수집 2건. 수집 요청이 그리기 뒤에 오므로 경로마다 마지막 값이 수집 요청의 Referer 다.
    assert.equal(images.seen.length, 4, joined(r));
    assert.deepEqual(Object.fromEntries(images.seen), { '/plain.png': `${base}/m/page.html`, '/attr.png': undefined });
  } finally {
    await images.close();
  }
});

test('TC#28 extRedirectedImageGetsRefererPerHop', async () => {
  const cdn = await imageServer(['a.png']);
  const hops: (string | undefined)[] = [];
  try {
    const { r, out, base } = await collect(served(() => {}, (q, res) => {
      if (q.url!.startsWith('/img')) { hops.push(q.headers.referer); res.writeHead(302, { Location: `${cdn.base}/a.png` }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<body><div id=c><img src="/img/a.png"></div></body>');
    }), '/ep/1?no=2', '#c img', { mode: 'image' });
    assert.deepEqual(out, ['p_0001_001.png'], joined(r));
    assert.deepEqual(hops, [`${base}/ep/1?no=2`, `${base}/ep/1?no=2`]);
    assert.deepEqual(cdn.seen.map(s => s[1]), [`${base}/`, `${base}/`]);
  } finally {
    await cdn.close();
  }
});

test('TC#28 extRefererRulesLeavePageRequestsAlone', async () => {
  const images = await imageServer(['a.png'], (q, res, dir) => {
    // 수집 요청을 늦게 끝내 그동안 페이지 요청이 섞이게 한다.
    if (q.url === '/a.png') { setTimeout(() => staticFile()(q, res, dir), 400); return true; }
    return false;
  });
  try {
    await collect(served(() => {}, (_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<body><div id=c><img src="${images.base}/a.png"></div>
<script>let n = 0; setInterval(() => { const i = new Image(); i.referrerPolicy = 'no-referrer'; i.src = '${images.base}/own.png?' + n++;
  fetch('${images.base}/own-fetch?' + n, { referrerPolicy: 'no-referrer' }).catch(() => {}); }, 20);</script></body>`);
    }), '/p.html', '#c img', { mode: 'image' });
    const own = images.seen.filter(s => s[0].startsWith('/own'));
    // 그림과 스크립트 요청이 둘 다 수집 요청과 겹쳐야 확인이 공허하지 않다.
    assert.ok(own.filter(s => s[0].startsWith('/own-fetch')).length > 5, String(own.length));
    assert.ok(own.filter(s => s[0].startsWith('/own.png')).length > 5, String(own.length));
    assert.deepEqual([...new Set(own.map(s => s[1]))], [undefined]);
  } finally {
    await images.close();
  }
});

test('TC#30 extClickableNextToLocalFileIsNotFollowed', async () => {
  const secret = path.join(tempDir(), 'secret.html');
  write(secret, pageHtml('비밀', ''));
  const { r, root, out } = await collect(served(d => write(path.join(d, 'a.html'), pageHtml('본문 1', `<a class="next" href="${pathToFileURL(secret).href}">n</a>`))),
    '/a.html', '#c', { timeout: 1500 });
  assert.deepEqual(out.map(f => read(root, `out/${f}`)), ['본문 1'], joined(r));
});

// 확장에서만 생기는 동작

test('TC#66 extCollectsInTabAndDetachesAfterwards', async () => {
  const x = await ext();
  const { r, tab, base } = await collect(served(writeLink), '/p1.html', '#c', {}, undefined, async (t, done) => {
    await done;
    assert.equal(await x.attached(t.id), false);
    assert.equal(await x.tabExists(t.id), true);
    assert.equal(t.page.url().endsWith('/p3.html'), true, t.page.url());
  });
  assert.equal(r.pages, 3, joined(r));
  assert.ok(tab && base);
});

test('TC#66 extRefusesTabAlreadyAttached', async () => {
  const x = await ext();
  const d = tempDir();
  writeLink(d);
  const srv = await serve(d);
  const tab = await x.newTab();
  try {
    await x.panel.evaluate(t => chrome.debugger.attach({ tabId: t }, '1.3'), tab.id);
    const r = await x.scrape(tab, `${srv.base}/p1.html`, '#c', '.next', tempDir(), 'out/p');
    assert.equal(r.pages, 0);
    assert.match(r.error ?? '', /already attached/i, joined(r));
    // 남이 붙인 디버거는 떼지 않는다.
    assert.equal(await x.attached(tab.id), true);
  } finally {
    await x.panel.evaluate(t => chrome.debugger.detach({ tabId: t }).catch(() => {}), tab.id);
    await x.closeTab(tab);
    await srv.close();
  }
});

test('TC#67 extRequestsCarryTabCookies', async () => {
  const x = await ext();
  const cookies: (string | undefined)[] = [];
  const d = tempDir();
  write(path.join(d, 'a.png'), PNG);
  const srv = await serve(d, (q, res, dir) => {
    if (q.url === '/login') { res.writeHead(200, { 'Set-Cookie': 'sid=abc; Path=/', 'Content-Type': 'text/html' }); res.end('ok'); return; }
    if (q.url !== '/favicon.ico') cookies.push(`${q.url} ${q.headers.cookie}`);
    if (q.url === '/i.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<body><div id=c><img src="a.png"></div></body>'); return; }
    staticFile()(q, res, dir);
  });
  const tab = await x.newTab();
  try {
    await tab.page.goto(`${srv.base}/login`);
    const root = tempDir();
    const r = await x.scrape(tab, `${srv.base}/i.html`, '#c img', '.next', root, 'out/p', { mode: 'image', timeout: 5000 });
    assert.deepEqual(files(root), ['p_0001_001.png'], joined(r));
  } finally {
    await x.closeTab(tab);
    await srv.close();
  }
  assert.deepEqual(cookies, ['/i.html sid=abc', '/a.png sid=abc', '/a.png sid=abc']);
});

test('TC#68 extClosesTabsOpenedByTargetOnly', async () => {
  const x = await ext();
  const bystander = await x.newTab();
  const opened: string[] = [];
  try {
    const { r } = await collect(served(d => {
      write(path.join(d, 'ad.html'), 'ad');
      write(path.join(d, 'spa.html'), `<meta charset="utf-8"><body><div id=c>본문 1</div><button class=next>next</button>
<a id=ad target=_blank href="/ad.html?link">ad</a>
<script>let i=1;document.querySelector('.next').onclick=()=>{
  // 사람의 클릭 한 번으로는 새 창을 하나만 연다 → 누를 때마다 다른 방법으로 연다.
  if (i === 1) window.open('/ad.html'); else ad.click();
  if(i>=3)return; i++; setTimeout(()=>{c.textContent='본문 '+i; if(i>=3)document.querySelector('.next').disabled=true;},300);}</script></body>`);
    }), '/spa.html', '#c', {}, undefined, async (_t, done) => {
      await x.waitLog(/^\[1\]/);
      // 대상 탭이 아닌 탭이 연 창은 닫지 않는다.
      const popup = bystander.page.waitForEvent('popup');
      await bystander.page.evaluate(() => { document.body.innerHTML = '<button id=o onclick="window.open(\'about:blank#keep\')">o</button>'; });
      // 가려진 창은 그리기를 멈춰 Playwright 가 누를 수 있는지 판정하지 못한다 → 판정 없이 사람의 클릭으로 누른다.
      await bystander.page.bringToFront();
      await bystander.page.click('#o', { force: true });
      const p = await popup;
      await done;
      await sleep(300);
      opened.push(p.isClosed() ? 'closed' : 'open');
      await p.close();
    });
    assert.equal(r.pages, 3, joined(r));
    assert.match(joined(r), /주의: 대상 탭이 연 새 탭을 닫았습니다: .*\/ad\.html$/m);
    assert.match(joined(r), /주의: 대상 탭이 연 새 탭을 닫았습니다: .*\/ad\.html\?link/);
    const ads = x.ctx.pages().filter(p => p.url().includes('/ad.html'));
    assert.deepEqual(ads, []);
    assert.deepEqual(opened, ['open']);
  } finally {
    await x.closeTab(bystander);
  }
});

async function lost(act: (tab: Tab) => Promise<void>) {
  const x = await ext();
  return collect(stuck, '/stuck.html', '#c', { timeout: 15000 }, undefined, async tab => {
    await x.waitLog(/^\[1\]/);
    await act(tab);
  });
}

test('TC#69 extStopsWhenTargetTabCloses', async () => {
  const x = await ext();
  const { r, out } = await lost(tab => x.closeTab(tab));
  assert.equal(r.error, null, joined(r));
  assert.equal(r.pages, 1);
  assert.deepEqual(out, ['p_0001.txt']);
  assert.match(joined(r), /중단: 대상 탭이 닫혔습니다\.[\s\S]*마지막으로 받은 페이지: 1번/);
});

test('TC#69 extStopsWhenUserNavigates', async () => {
  for (const act of [(t: Tab) => t.page.goto('about:blank#typed', { waitUntil: 'commit' }).then(() => {}), (t: Tab) => t.page.reload({ waitUntil: 'commit' }).then(() => {})]) {
    const { r } = await lost(act);
    assert.equal(r.error, null, joined(r));
    assert.match(joined(r), /중단: 대상 탭이 다른 페이지로 이동했습니다\.[\s\S]*마지막으로 받은 페이지: 1번/);
  }
  // 둘째 페이지에서 오래 기다리게 해 뒤로 가기가 수집이 끝나기 전에 일어나게 한다.
  const twoPages = served(d => {
    write(path.join(d, 'p1.html'), pageHtml('본문 1', '<a class="next" href="p2.html">next</a>'));
    write(path.join(d, 'p2.html'), pageHtml('본문 2', '<button class=next>next</button>'));
  });
  const back = await collect(twoPages, '/p1.html', '#c', { timeout: 15000 }, undefined, async tab => {
    const x = await ext();
    await x.waitLog(/^\[2\]/);
    await tab.page.goBack({ waitUntil: 'commit' });
  });
  assert.match(joined(back.r), /중단: 대상 탭이 다른 페이지로 이동했습니다\./);
});

test('TC#69 extEngineMovesDoNotStop', async () => {
  // 주소 이동·페이지 스크립트의 이동·서버 리디렉션은 사용자 이동이 아니다.
  const { r } = await collect(served(d => {
    write(path.join(d, 'a.html'), pageHtml('본문 1', '<button class=next onclick="location.href=\'/r\'">n</button>'));
    write(path.join(d, 'b.html'), pageHtml('본문 2', '<button class=next onclick="location.reload()">n</button><script>if (sessionStorage.r) c.textContent = "본문 3"; sessionStorage.r = 1;</script>'));
  }, (q, res, dir) => {
    if (q.url === '/r') { res.writeHead(302, { Location: '/b.html' }); res.end(); return; }
    staticFile()(q, res, dir);
  }), '/a.html', '#c', { maxPages: 3 });
  assert.equal(r.pages, 3, joined(r));
  // 폼 제출로 넘어가는 next 도 사용자 이동이 아니다.
  const form = await collect(served(d => {
    write(path.join(d, 'c.html'), pageHtml('본문 1', '<form action="d.html"><button class=next>n</button></form>'));
    write(path.join(d, 'd.html'), pageHtml('본문 2', LAST));
  }), '/c.html', '#c');
  assert.equal(form.r.pages, 2, joined(form.r));
});

test('TC#69 extOtherTabsDoNotStop', async () => {
  // 대상이 아닌 탭의 이동·닫힘은 수집과 무관하다.
  const x = await ext();
  const other = await x.newTab();
  const { r } = await collect(stuck, '/stuck.html', '#c', { timeout: 3000 }, undefined, async () => {
    await x.waitLog(/^\[1\]/);
    await other.page.goto('about:blank#typed', { waitUntil: 'commit' });
    await other.page.reload({ waitUntil: 'commit' });
    await x.closeTab(other);
  });
  assert.match(joined(r), /중단: next 클릭 후 3000ms 동안 수집 대상이 바뀌지 않았습니다/);
});

test('TC#71 extPanelCloseDetachesDebugger', async () => {
  const x = await ext();
  const d = tempDir();
  stuck(d);
  const srv = await serve(d);
  const tab = await x.newTab();
  const other = await x.openPanel();
  try {
    await new Promise<void>(go => { void x.scrape(tab, `${srv.base}/stuck.html`, '#c', '.next', tempDir(), 'out/p', { timeout: 30000 }, other, go).catch(() => {}); });
    await x.waitLog(/^\[1\]/, other);
    assert.equal(await x.attached(tab.id), true);
    // 서비스 워커는 Chrome 이 수시로 내린다 → 다시 뜬 워커도 패널이 붙인 탭을 알아야 뗀다.
    const cdp = await x.ctx.newCDPSession(x.panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(500);
    await other.close();
    const deadline = Date.now() + 3000;
    while (await x.attached(tab.id) && Date.now() < deadline) await sleep(100);
    assert.equal(await x.attached(tab.id), false);
  } finally {
    await x.closeTab(tab);
    await srv.close();
  }
});

test('TC#72 extHiddenTabLoadsLazyImages', async () => {
  const x = await ext();
  const d = tempDir();
  for (const n of ['a', 'b']) write(path.join(d, `${n}.png`), PNG);
  write(path.join(d, 'i.html'), `<body><div style="height:3000px"></div><div id=c><img data-real="a.png"><img data-real="b.png"></div>
<script>const o = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) e.target.src = e.target.dataset.real; }));
document.querySelectorAll('img').forEach(i => o.observe(i));</script></body>`);
  const srv = await serve(d);
  const tab = await x.newTab(`${srv.base}/i.html`);
  try {
    await x.panel.evaluate(async t => { const { windowId } = await chrome.tabs.get(t); await chrome.tabs.create({ windowId, url: 'about:blank', active: true }); }, tab.id);
    // 픽스처가 가려진 탭에서 실제로 지연 로딩을 멈추는지 먼저 본다 → 아니면 확인이 공허하다.
    assert.equal(await tab.page.evaluate(() => document.visibilityState), 'hidden');
    const root = tempDir();
    const r = await x.scrape(tab, `${srv.base}/i.html`, '#c img', '.next', root, 'out/p', { mode: 'image', timeout: 5000 });
    assert.deepEqual(files(root), ['p_0001_001.png', 'p_0001_002.png'], joined(r));
  } finally {
    await x.panel.evaluate(async t => { const { windowId } = await chrome.tabs.get(t); await chrome.windows.remove(windowId); }, tab.id).catch(() => {});
    await srv.close();
  }
});

test('TC#72 extHiddenPanelTimersKeepPace', async () => {
  const x = await ext();
  const panel = await x.openPanel();
  try {
    await panel.evaluate(async () => { const me = await chrome.tabs.getCurrent(); await chrome.tabs.create({ windowId: me!.windowId, url: 'about:blank', active: true }); });
    // 가려진 패널이어야 확인이 공허하지 않다.
    assert.equal(await panel.evaluate(() => document.visibilityState), 'hidden');
    const took = await panel.evaluate(() => new Promise<number>(done => {
      const t0 = performance.now();
      let n = 0;
      const tick = () => (++n < 20 ? setTimeout(tick, 50) : done(performance.now() - t0));
      setTimeout(tick, 50);
    }));
    // 가려진 페이지의 기본 타이머는 1초 단위로 늘어진다 → 20번이면 20초 가까이 걸린다.
    assert.ok(took < 5000, String(took));
  } finally {
    await panel.close();
  }
});

test('TC#73 extSinkWritesUnderPrefixPath', async () => {
  const x = await ext();
  const d = tempDir();
  writeLink(d, 2);
  const srv = await serve(d);
  const tab = await x.newTab();
  try {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    write(path.join(root, 'a', 'b', 'p_all.txt'), '앞');
    await x.scrape(tab, `${srv.base}/p1.html`, '#c', '.next', root, 'a/b/p', { merge: true, start: 2, timeout: 5000 });
    assert.deepEqual(files(root, 'a/b'), ['p_0002.txt', 'p_0003.txt', 'p_all.txt']);
    assert.equal(read(root, 'a/b/p_all.txt'), '앞\n\n본문 1\n\n본문 2');
    const dirOnly = tempDir();
    await x.scrape(tab, `${srv.base}/p1.html`, '#c', '.next', dirOnly, 'a/', { maxPages: 1, timeout: 5000 });
    assert.deepEqual(files(dirOnly, 'a'), ['_0001.txt']);
    const slashes = tempDir();
    await x.scrape(tab, `${srv.base}/p1.html`, '#c', '.next', slashes, 'x\\y\\q', { maxPages: 1, timeout: 5000 });
    assert.deepEqual(files(slashes, 'x/y'), ['q_0001.txt']);
    for (const bad of ['', '/abs/p', '\\abs\\p', '..\\p', 'C:\\x\\p', '../p', 'a/../p', 'a//p', './p', 'a/./p', 'a/..', 'a/.']) {
      const out = tempDir();
      const r = await x.scrape(tab, `${srv.base}/p1.html`, '#c', '.next', out, bad, { maxPages: 1, timeout: 5000 });
      assert.match(r.error ?? '', /저장 폴더를 만들지 못했습니다: .* 고른 폴더 안의 경로가 아닙니다/, `${bad}: ${joined(r)}`);
      assert.deepEqual(fs.readdirSync(out), [], bad);
    }
  } finally {
    await x.closeTab(tab);
    await srv.close();
  }
});
