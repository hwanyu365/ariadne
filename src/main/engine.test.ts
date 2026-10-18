import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';
import { type Handler, serve, staticFile, tempDir } from '../test/serve';
import { probe, scrape, type ScrapeOptions } from './engine';
import { Page } from './page';

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('fixture'.repeat(4))]);
const write = (file: string, body: string | Buffer) => fs.writeFileSync(file, body);
const quiet = { onLog: () => {} };

/** a[href] 로 넘어가는 평범한 페이지네이션. */
function fixtureLink(d: string, n = 3) {
  for (let i = 1; i <= n; i++) {
    const nxt = i < n ? `<a class="next" href="p${i + 1}.html">next</a>` : '<a class="next" aria-disabled="true">next</a>';
    write(path.join(d, `p${i}.html`), `<meta charset="utf-8"><body><h1 id=tt>제목 ${i}</h1><div id=c>본문 ${i}</div>${nxt}</body>`);
  }
  return pathToFileURL(path.join(d, 'p1.html')).href;
}

/** 마지막이 아닌데도 next 를 aria-disabled 로 죽여둔 사이트. href 는 살아 있다. */
function fixtureDisabledButHref(d: string, n = 3) {
  for (let i = 1; i <= n; i++) {
    const href = i < n ? ` href="q${i + 1}.html"` : '';
    write(path.join(d, `q${i}.html`), `<meta charset="utf-8"><body><div id=c>본문 ${i}</div><a class="next" aria-disabled="true"${href}>next</a></body>`);
  }
  return pathToFileURL(path.join(d, 'q1.html')).href;
}

/** URL 이 바뀌지 않고 JS 로 본문만 교체하는 경우. */
function fixtureSpa(d: string, n = 3) {
  write(path.join(d, 'spa.html'), `<meta charset="utf-8"><body><div id=c>본문 1</div><button class=next>next</button>
<script>let i=1,N=${n};document.querySelector('.next').onclick=()=>{
  if(i>=N)return; i++; setTimeout(()=>{document.querySelector('#c').textContent='본문 '+i;
  if(i>=N)document.querySelector('.next').disabled=true;},300);}</script></body>`);
  return pathToFileURL(path.join(d, 'spa.html')).href;
}

function writeImagePages(d: string, n: number, attr: string) {
  for (let i = 1; i <= n; i++) {
    for (const name of ['a', 'b']) write(path.join(d, `${name}${i}.png`), PNG);
    const nxt = i < n ? `<a class="next" href="i${i + 1}.html">next</a>` : '<a class="next" aria-disabled="true">next</a>';
    write(path.join(d, `i${i}.html`), `<body><div id=c><img ${attr}="a${i}.png"><img ${attr}="b${i}.png"></div>${nxt}</body>`);
  }
}

const outFiles = (d: string, pattern = /^p_.*\.txt$/) =>
  fs.existsSync(path.join(d, 'out')) ? fs.readdirSync(path.join(d, 'out')).filter(f => pattern.test(f)).sort() : [];
const read = (d: string, name: string) => fs.readFileSync(path.join(d, 'out', name), 'utf8');

async function run(make: (d: string) => string, opts: ScrapeOptions = {}) {
  const d = tempDir();
  const n = await scrape(make(d), '#c', '.next', path.join(d, 'out', 'p'), { timeout: 5000, ...quiet, ...opts });
  const names = outFiles(d);
  return { n, names, texts: names.map(f => read(d, f)) };
}

async function runImages(attr: string, n = 3, opts: ScrapeOptions = {}) {
  const d = tempDir();
  writeImagePages(d, n, attr);
  const srv = await serve(d);
  const logs: string[] = [];
  try {
    const pages = await scrape(`${srv.base}/i1.html`, '#c img', '.next', path.join(d, 'out', 'p'), { timeout: 5000, mode: 'image', onLog: m => logs.push(m), ...opts });
    const names = outFiles(d, /./);
    return { pages, names, blobs: names.map(f => fs.readFileSync(path.join(d, 'out', f))), log: logs.join('|') };
  } finally {
    await srv.close();
  }
}

/** charset 선언 없는 UTF-8 페이지. 디렉터리 주소로 열면 서버가 슬래시를 붙이는 301 을 먼저 돌려준다. */
function writeUndeclaredUtf8(d: string) {
  fs.mkdirSync(path.join(d, 'ep'));
  write(path.join(d, 'ep', 'index.html'), Buffer.from('<body><div id=c>본문 1 가나다</div><a class="next" href="p2.html">next</a></body>'));
  write(path.join(d, 'ep', 'p2.html'), Buffer.from('<body><div id=c>본문 2 가나다</div><a class="next" aria-disabled="true">next</a></body>'));
}

async function runUndeclared(opts: ScrapeOptions = {}, handler?: Handler) {
  const d = tempDir();
  writeUndeclaredUtf8(d);
  const logs: string[] = [];
  const srv = await serve(d, handler);
  try {
    const n = await scrape(`${srv.base}/ep`, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 5000, onLog: m => logs.push(m), ...opts });
    return { n, texts: outFiles(d).map(f => read(d, f)), logs };
  } finally {
    await srv.close();
  }
}

/** 한 페이지짜리 문서를 HTTP 로 받아 (본문, 로그) 를 돌려준다. */
async function runPage(raw: Buffer, opts: ScrapeOptions = {}) {
  const d = tempDir();
  write(path.join(d, 'x.html'), raw);
  const logs: string[] = [];
  const srv = await serve(d);
  try {
    await scrape(`${srv.base}/x.html`, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 5000, onLog: m => logs.push(m), ...opts });
    return { got: read(d, 'p_0001.txt'), logs };
  } finally {
    await srv.close();
  }
}

test('linkPagination', async () => {
  const { n, names, texts } = await run(fixtureLink);
  assert.equal(n, 3);
  assert.deepEqual(names, ['p_0001.txt', 'p_0002.txt', 'p_0003.txt']);
  assert.deepEqual(texts, ['본문 1', '본문 2', '본문 3']);
});

test('spaPagination', async () => {
  const { n, texts } = await run(fixtureSpa);
  assert.equal(n, 3);
  assert.deepEqual(texts, ['본문 1', '본문 2', '본문 3']);
});

test('maxPages', async () => {
  const { n, names } = await run(fixtureLink, { maxPages: 2 });
  assert.equal(n, 2);
  assert.deepEqual(names, ['p_0001.txt', 'p_0002.txt']);
});

test('disabledNextFollowsHref', async () => {
  const { n, texts } = await run(fixtureDisabledButHref);
  assert.equal(n, 3);
  assert.deepEqual(texts, ['본문 1', '본문 2', '본문 3']);
});

test('digitsAndStart', async () => {
  const { names } = await run(fixtureLink, { digits: 3, start: 65 });
  assert.deepEqual(names, ['p_065.txt', 'p_066.txt', 'p_067.txt']);
});

test('clickWaitsUntilNextReceivesIt', async () => {
  // 로딩 막이 잠시 next 를 덮는 동안 누르면 막이 클릭을 받는다 → 그 자리에 next 가 드러날 때 누른다.
  const { n } = await run(d => {
    write(path.join(d, 'm1.html'), `<meta charset="utf-8"><body><div id=c>본문 1</div><a class="next" href="m2.html">next</a>
<div id=veil style="position:fixed;inset:0;background:rgba(0,0,0,.01)"></div>
<script>setTimeout(() => veil.remove(), 600);</script></body>`);
    write(path.join(d, 'm2.html'), '<meta charset="utf-8"><body><div id=c>본문 2</div><a class="next" aria-disabled="true">next</a></body>');
    return pathToFileURL(path.join(d, 'm1.html')).href;
  });
  assert.equal(n, 2);
});

test('missingNextSelector', async () => {
  // next 셀렉터가 안 맞으면 1페이지만 받고 이유를 로그로 남긴다.
  const d = tempDir();
  const logs: string[] = [];
  const n = await scrape(fixtureLink(d), '#c', '.nope', path.join(d, 'out', 'p'), { timeout: 3000, onLog: m => logs.push(m) });
  assert.equal(n, 1);
  assert.ok(logs.some(l => l.includes('중단') && l.includes('.nope')), logs.join('\n'));
});

test('stopsAfterCurrentPageWhenAborted', async () => {
  // 중지는 현재 페이지를 마친 뒤 반영한다. 그때까지 받은 파일은 남는다.
  const ctl = new AbortController();
  const logs: string[] = [];
  const { n, names } = await run(fixtureLink, {
    signal: ctl.signal,
    onLog: m => { logs.push(m); if (m.startsWith('[1]')) ctl.abort(); },
  });
  assert.equal(n, 1);
  assert.deepEqual(names, ['p_0001.txt']);
  assert.ok(logs.some(l => l.includes('사용자 중지')), logs.join('\n'));
});

test('titleHeader', async () => {
  const { n, texts } = await run(fixtureLink, { titleSel: '#tt', digits: 3, start: 1920 });
  assert.equal(n, 3);
  assert.deepEqual(texts[0].split('\n'), ['1920화. 제목 1', '', '본문 1']);
  assert.ok(texts[2].startsWith('1922화. 제목 3'), texts[2]);
});

test('titleSelectorMissing', async () => {
  const { n, texts } = await run(fixtureLink, { titleSel: '#nope' });
  assert.equal(n, 3);
  assert.deepEqual(texts[0].split('\n'), ['1화.', '', '본문 1']);
});

test('imageModeSavesEveryPage', async () => {
  const { pages, names, blobs, log } = await runImages('src');
  assert.equal(pages, 3, log);
  assert.deepEqual(names, [1, 2, 3].flatMap(p => [1, 2].map(i => `p_${String(p).padStart(4, '0')}_${String(i).padStart(3, '0')}.png`)));
  assert.ok(blobs.every(b => b.equals(PNG)), blobs.map(b => b.length).join(','));
});

test('imageModeReadsDataSrc', async () => {
  // 주소가 data-src 에만 있어도 받는다. src 가 비어 크기가 0 인 img 도 대상이다.
  const { pages, names, blobs, log } = await runImages('data-src', 2);
  assert.equal(pages, 2, log);
  assert.deepEqual(names, ['p_0001_001.png', 'p_0001_002.png', 'p_0002_001.png', 'p_0002_002.png']);
  assert.ok(blobs.every(b => b.equals(PNG)));
});

test('imageModeMaxPages', async () => {
  const { pages, names } = await runImages('src', 3, { maxPages: 1 });
  assert.equal(pages, 1);
  assert.deepEqual(names, ['p_0001_001.png', 'p_0001_002.png']);
});

test('charsetUndeclaredUtf8Warns', async () => {
  // 선언 없는 UTF-8 은 깨진 채 받아진다 → 조용히 끝나지 않고 로그로 알린다.
  const { n, texts, logs } = await runUndeclared();
  assert.equal(n, 2);
  assert.notEqual(texts[0], '본문 1 가나다');          // 픽스처가 실제로 추정을 틀리게 만드는지
  assert.ok(logs.some(l => l.includes('windows-1252')), logs.join('\n'));
});

test('charsetWarnsWhenLaterPageUndeclared', async () => {
  // 첫 페이지가 정상이어도 이후 페이지에서 추정이 틀리면 한 번 알린다.
  const d = tempDir();
  write(path.join(d, 'a.html'), Buffer.from('<meta charset="utf-8"><div id=c>본문 1</div><a class="next" href="b.html">n</a>'));
  write(path.join(d, 'b.html'), Buffer.from('<div id=c>본문 2</div><a class="next" aria-disabled="true">n</a>'));
  const logs: string[] = [];
  const srv = await serve(d);
  try {
    const n = await scrape(`${srv.base}/a.html`, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 5000, onLog: m => logs.push(m) });
    assert.equal(n, 2);
  } finally {
    await srv.close();
  }
  assert.equal(logs.filter(l => l.includes('windows-1252')).length, 1, logs.join('\n'));
});

test('charsetForcedReadsUndeclaredUtf8', async () => {
  // 인코딩을 지정하면 리다이렉트와 링크 이동을 거쳐도 모든 페이지를 그 인코딩으로 읽는다.
  const { n, texts, logs } = await runUndeclared({ charset: 'utf-8' });
  assert.equal(n, 2);
  assert.deepEqual(texts, ['본문 1 가나다', '본문 2 가나다']);
  assert.ok(!logs.some(l => l.includes('windows-1252')), logs.join('\n'));
});

test('charsetAliasAppliedNotWarned', async () => {
  // 브라우저가 다른 이름으로 정규화해 적용한 지정은 경고하지 않는다.
  const cases: [string, Buffer, string][] = [
    ['gb2312', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x20, 0xb1, 0xbe, 0xce, 0xc4]), '中文 本文'],
    ['latin1', Buffer.from('café', 'latin1'), 'café'],
    ['us-ascii', Buffer.from('plain'), 'plain'],
  ];
  for (const [name, bytes, text] of cases) {
    const { got, logs } = await runPage(Buffer.concat([Buffer.from('<div id=c>'), bytes, Buffer.from('</div>')]), { charset: name });
    assert.equal(got, text, name);
    assert.ok(!logs.some(l => l.includes('경고')), `${name}: ${logs.join('\n')}`);
  }
});

test('charsetWarnsWhenUtf8ReadAsOther', async () => {
  // UTF-8 바이트를 다른 인코딩으로 읽으면 그 인코딩이 무엇이든 알린다.
  const raw = Buffer.from('<meta charset="euc-kr"><div id=c>érkezik 가나다</div>');
  let { got, logs } = await runPage(raw);
  assert.notEqual(got, 'érkezik 가나다');               // 선언을 따라 실제로 깨지는지
  assert.ok(logs.some(l => l.includes('경고') && l.includes('EUC-KR')), logs.join('\n'));
  ({ got, logs } = await runPage(raw, { charset: 'utf-8' }));
  assert.equal(got, 'érkezik 가나다');
  assert.ok(!logs.some(l => l.includes('경고')), logs.join('\n'));
  ({ logs } = await runPage(raw, { charset: 'euc-kr' }));   // 지정을 틀리게 한 경우
  assert.ok(logs.some(l => l.includes('경고') && l.includes('euc-kr')), logs.join('\n'));
});

test('charsetForcedOverridesWrongDeclaration', async () => {
  // EUC-KR 바이트를 utf-8 로 잘못 선언한 페이지도 지정한 인코딩으로 읽는다. 원본 바이트가 그대로 넘어가야 맞는다.
  const eucKr = Buffer.from([0xba, 0xbb, 0xb9, 0xae, 0x20, 0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9]);   // "본문 가나다"
  const d = tempDir();
  write(path.join(d, 'w.html'), Buffer.concat([Buffer.from('<meta charset="utf-8"><body><div id=c>'), eucKr, Buffer.from('</div></body>')]));
  const texts: Record<string, string> = {};
  const srv = await serve(d);
  try {
    for (const cs of [null, 'euc-kr']) {
      const prefix = path.join(d, String(cs), 'p');
      await scrape(`${srv.base}/w.html`, '#c', '.next', prefix, { timeout: 5000, charset: cs, ...quiet });
      texts[String(cs)] = fs.readFileSync(`${prefix}_0001.txt`, 'utf8');
    }
  } finally {
    await srv.close();
  }
  assert.notEqual(texts.null, '본문 가나다');           // 선언을 따르면 실제로 깨지는지
  assert.equal(texts['euc-kr'], '본문 가나다');
});

test('charsetForcedLeavesIframeAlone', async () => {
  // 지정은 메인 문서에만 건다. 인코딩이 다른 iframe 까지 덮으면 그쪽이 깨진다.
  const d = tempDir();
  write(path.join(d, 'outer.html'), Buffer.from('<body><div id=c>본문 가나다</div><iframe src="inner.html"></iframe></body>'));
  write(path.join(d, 'inner.html'), Buffer.concat([Buffer.from('<meta charset="euc-kr"><body><div id=i>'),
    Buffer.from([0xb1, 0xa4, 0xb0, 0xed, 0x20, 0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9]), Buffer.from('</div></body>')]));   // "광고 가나다"
  const srv = await serve(d);
  const page = await Page.open({ charset: 'utf-8' });
  try {
    await page.goto(`${srv.base}/outer.html`, 5000);
    await page.waitFor('#c', 5000);
    const outer = await page.eval<string>(`document.querySelector('#c').innerText`);
    const frame = await page.waitForChildFrame(5000);
    const inner = await frame.executeJavaScript(`new Promise(r => { const f = () => document.querySelector('#i') ? r(document.querySelector('#i').innerText) : setTimeout(f, 50); f(); })`);
    assert.equal(outer, '본문 가나다');
    assert.equal(inner, '광고 가나다');
  } finally {
    page.close();
    await srv.close();
  }
});

test('charsetFailureFallsBackToOriginal', async () => {
  // 가로챈 응답을 바꾸다 실패해도 요청을 풀어 원래 응답으로 로드한다. 매달리면 수집이 타임아웃으로 끝난다.
  const { n, texts } = await runUndeclared({
    charset: 'utf-8',
    cdp: send => (method, params) => method === 'Fetch.getResponseBody' ? Promise.reject(new Error('고장')) : send(method, params),
  });
  assert.equal(n, 2);
  assert.notEqual(texts[0], '본문 1 가나다');           // 지정이 빠진 원래 응답이다
});

/** 첫 페이지가 쿠키 둘을 내리고, 다음 페이지는 받은 쿠키를 본문에 보여 준다. */
const cookieHandler: Handler = (req, res) => {
  const second = (req.url ?? '').endsWith('p2.html');
  const body = second
    ? `<div id=c>${req.headers.cookie}</div><a class="next" aria-disabled="true">n</a>`
    : '<div id=c>본문 1</div><a class="next" href="p2.html">n</a>';
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'text/html' };
  if (!second) headers['Set-Cookie'] = ['a=1; Path=/', 'b=2; Path=/'];
  res.writeHead(200, headers);
  res.end(Buffer.from(body));
};

test('charsetForcedKeepsCookies', async () => {
  // 지정해도 응답이 내린 쿠키가 모두 남아 다음 페이지 요청에 실린다.
  const d = tempDir();
  const srv = await serve(d, cookieHandler);
  try {
    await scrape(`${srv.base}/p1.html`, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 5000, charset: 'utf-8', ...quiet });
  } finally {
    await srv.close();
  }
  assert.equal(read(d, 'p_0002.txt'), 'a=1; b=2');
});

test('charsetForcedReadsGzipResponse', async () => {
  const { n, texts } = await runUndeclared({ charset: 'utf-8' }, staticFile(true));
  assert.equal(n, 2);
  assert.deepEqual(texts, ['본문 1 가나다', '본문 2 가나다']);
});

test('probeReportsCharset', async () => {
  // probe 는 추정 인코딩을 보여 주고, 지정하면 미리보기부터 바로 읽힌다.
  const d = tempDir();
  writeUndeclaredUtf8(d);
  const guessed: string[] = [];
  const forced: string[] = [];
  const srv = await serve(d);
  try {
    await probe(`${srv.base}/ep`, '#c', null, { timeout: 5000, onLog: m => guessed.push(m) });
    await probe(`${srv.base}/ep`, '#c', null, { timeout: 5000, onLog: m => forced.push(m), charset: 'utf-8' });
  } finally {
    await srv.close();
  }
  assert.ok(guessed.some(l => l.includes('인코딩: windows-1252')), guessed.join('\n'));
  assert.ok(guessed.some(l => l.includes('경고') && l.includes('windows-1252')), guessed.join('\n'));
  assert.ok(forced.some(l => l.includes('인코딩: UTF-8')), forced.join('\n'));
  assert.ok(forced.some(l => l.includes('본문 1 가나다')), forced.join('\n'));
  assert.ok(!forced.some(l => l.includes('경고')), forced.join('\n'));
});

test('probeListsCandidatesAndIframes', async () => {
  const d = tempDir();
  write(path.join(d, 'p.html'), `<meta charset="utf-8"><body><div id=c>${'본문 '.repeat(80)}</div>
<a class="next" href="p2.html">다음</a><iframe src="about:blank"></iframe></body>`);
  const logs: string[] = [];
  await probe(pathToFileURL(path.join(d, 'p.html')).href, '#c', '.next', { timeout: 5000, onLog: m => logs.push(m) });
  const all = logs.join('\n');
  assert.match(all, /'#c' -> 1개 매치/);
  assert.match(all, /\[next 버튼 후보\][\s\S]*a\.next/);
  assert.match(all, /\[본문 후보[\s\S]*#c/);
  assert.match(all, /주의: iframe 1개/);
});

test('newWindowsAreDenied', async () => {
  // 수집은 원래 탭만 읽는다 → target=_blank 링크와 window.open 이 창을 만들지 않는다.
  const d = tempDir();
  write(path.join(d, 'w.html'), `<meta charset="utf-8"><body><div id=c>본문</div>
<a id=blank target="_blank" href="w.html">새 탭</a><script>setTimeout(() => window.open('w.html'), 100)</script></body>`);
  const page = await Page.open();
  const before = BrowserWindow.getAllWindows().length;
  try {
    await page.goto(pathToFileURL(path.join(d, 'w.html')).href, 5000);
    await page.click('#blank');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(BrowserWindow.getAllWindows().length, before);
  } finally {
    page.close();
  }
});

test('charsetNameCheckedAtEngineEntry', async () => {
  // 호출자가 검증을 빠뜨려도 응답 헤더에 모르는 이름이 들어가지 않는다.
  const d = tempDir();
  for (const bad of ['u8', 'utf-8\r\nx-evil: 1'])
    await assert.rejects(scrape(fixtureLink(d), '#c', '.next', path.join(d, 'out', 'p'), { charset: bad, ...quiet }), /인코딩/, bad);
});

test('imageModeSkipsStalledImage', async () => {
  // 응답이 멈춘 이미지 한 장 때문에 수집이 멈추지 않는다 → 건너뛰고 나머지와 다음 페이지를 받는다.
  const d = tempDir();
  writeImagePages(d, 2, 'src');
  const files = staticFile();
  const stall: Handler = (req, res, dir) => { if (!(req.url ?? '').endsWith('b1.png')) files(req, res, dir); };
  const logs: string[] = [];
  const srv = await serve(d, stall);
  try {
    const pages = await scrape(`${srv.base}/i1.html`, '#c img', '.next', path.join(d, 'out', 'p'), { timeout: 1500, mode: 'image', onLog: m => logs.push(m) });
    assert.equal(pages, 2);
  } finally {
    await srv.close();
  }
  assert.deepEqual(outFiles(d, /./), ['p_0001_001.png', 'p_0002_001.png', 'p_0002_002.png']);
  assert.ok(logs.some(l => l.includes('건너뜀') && l.includes('b1.png')), logs.join('\n'));
});

test('charsetNotJudgedFromPreviousDocument', async () => {
  // 오류 응답처럼 바이트를 남기지 않는 문서에서 지난 문서의 바이트로 판정하지 않는다.
  const errorPage: Handler = (req, res) => {
    if ((req.url ?? '').endsWith('a.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(Buffer.from('<meta charset="utf-8"><div id=c>본문 1 가나다</div><a class="next" href="b.html">n</a>'));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<div id=c>not found</div><a class="next" aria-disabled="true">n</a>');
    }
  };
  const d = tempDir();
  const logs: string[] = [];
  const srv = await serve(d, errorPage);
  try {
    const n = await scrape(`${srv.base}/a.html`, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 5000, onLog: m => logs.push(m) });
    assert.equal(n, 2);
  } finally {
    await srv.close();
  }
  assert.ok(!logs.some(l => l.includes('경고')), logs.join('\n'));
});

test('charsetForcedAcrossSites', async () => {
  // 다른 사이트로 넘어가면 렌더러 프로세스가 바뀐다 → 그 뒤 문서에도 지정이 적용된다.
  const d = tempDir();
  writeUndeclaredUtf8(d);
  const target = await serve(d);
  const hop = await serve(d, (_req, res) => { res.writeHead(302, { Location: target.base.replace('127.0.0.1', 'localhost') + '/ep/' }); res.end(); });
  try {
    const n = await scrape(`${hop.base}/go`, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 5000, charset: 'utf-8', ...quiet });
    assert.equal(n, 2);
  } finally {
    await hop.close();
    await target.close();
  }
  assert.deepEqual(outFiles(d).map(f => read(d, f)), ['본문 1 가나다', '본문 2 가나다']);
});

test('remotePageCannotPointAtLocalFiles', async () => {
  // 이미지 주소와 next 주소는 원격 페이지가 정한다 → 웹 페이지가 로컬 파일을 받게 하거나 그쪽으로 넘기지 못한다.
  const d = tempDir();
  const secret = path.join(d, 'secret.png');
  write(secret, PNG);
  write(path.join(d, 'a1.png'), PNG);
  const local = pathToFileURL(secret).href;
  write(path.join(d, 'i1.html'), `<body><div id=c><img src="a1.png"><img src="${local}"></div><a class="next" aria-disabled="true" href="${local}">n</a></body>`);
  const logs: string[] = [];
  const srv = await serve(d);
  try {
    const pages = await scrape(`${srv.base}/i1.html`, '#c img', '.next', path.join(d, 'out', 'p'), { timeout: 3000, mode: 'image', onLog: m => logs.push(m) });
    assert.equal(pages, 1);
  } finally {
    await srv.close();
  }
  assert.deepEqual(outFiles(d, /./), ['p_0001_001.png']);
  assert.ok(logs.some(l => l.includes('건너뜀') && l.includes('secret.png')), logs.join('\n'));
  assert.ok(logs.some(l => l.includes('중단') && l.includes('따라가지 않는다')), logs.join('\n'));
});

test('permissionsAndDownloadsDenied', async () => {
  // 수집 창의 원격 페이지는 권한을 얻거나 파일을 내려받지 못한다.
  const d = tempDir();
  write(path.join(d, 'x.bin'), 'payload');
  write(path.join(d, 'p.html'), '<meta charset="utf-8"><body><a id=dl download href="x.bin">받기</a></body>');
  const srv = await serve(d);
  const page = await Page.open();
  const prevented: boolean[] = [];
  page.win.webContents.session.on('will-download', e => prevented.push(e.defaultPrevented));
  try {
    await page.goto(`${srv.base}/p.html`, 5000);
    const perms = await page.eval<string[]>(`Promise.all([
      Notification.requestPermission(),
      navigator.permissions.query({ name: 'geolocation' }).then(s => s.state),
    ])`);
    assert.deepEqual(perms, ['denied', 'denied']);
    await page.click('#dl');
    await new Promise(r => setTimeout(r, 500));
    assert.deepEqual(prevented, [true]);
  } finally {
    page.close();
    await srv.close();
  }
});

test('stopsWithReasonWhenNextStaysCovered', async () => {
  // next 를 계속 다른 요소가 덮고 있으면 덮은 요소를 누르지 않고 이유를 남기고 멈춘다.
  const d = tempDir();
  const logs: string[] = [];
  write(path.join(d, 'v.html'), `<meta charset="utf-8"><body><div id=c>본문 1</div><a class="next" href="v2.html">next</a>
<div id=veil style="position:fixed;inset:0;background:rgba(0,0,0,.01)" onclick="document.title='veil'"></div></body>`);
  const n = await scrape(pathToFileURL(path.join(d, 'v.html')).href, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 3000, onLog: m => logs.push(m) });
  assert.equal(n, 1);
  assert.ok(logs.some(l => l.includes('중단') && l.includes('div#veil')), logs.join('\n'));
});

test('stopsWithReasonOnBrokenNextHref', async () => {
  // 숨겨진 next 의 href 를 해석할 수 없으면 예외로 끝내지 않고 이유를 남긴다.
  const d = tempDir();
  const logs: string[] = [];
  write(path.join(d, 'h.html'), '<meta charset="utf-8"><body><div id=c>본문 1</div><a class="next" aria-disabled="true" href="https://[">n</a></body>');
  const n = await scrape(pathToFileURL(path.join(d, 'h.html')).href, '#c', '.next', path.join(d, 'out', 'p'), { timeout: 3000, onLog: m => logs.push(m) });
  assert.equal(n, 1);
  assert.ok(logs.some(l => l.includes('중단') && l.includes('해석할 수 없다')), logs.join('\n'));
});
