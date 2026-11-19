import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { pick } from '../test/engine';
import { ext, type Tab } from '../test/ext';
import { tempDir } from '../test/serve';
import { CANDIDATES_JS } from './picker';

const FIXTURE = `<meta charset="utf-8"><body style="margin:40px 300px 300px 40px">
<h1 id="tt">제목</h1>
<div class="article body">본문입니다</div>
<div class="article">다른 article</div>
<div class="article">또 다른 article</div>
<div id="gallery"><img class="cut" src="a.png"><img class="cut" src="b.png"></div>
<a class="next" href="https://example.com/next">다음</a>
</body>`;

type Cand = { sel: string; n: number };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fixture(html = FIXTURE, name = 'p.html') {
  const d = tempDir();
  fs.writeFileSync(path.join(d, name), html);
  return { d, url: pathToFileURL(path.join(d, name)).href };
}

/** 대상 탭을 흉내 낸다. 선택기 없이 열면 일반 페이지, picker 면 확장 선택기를 그 탭에 세운다. */
interface On {
  url(): string;
  eval<T>(code: string): Promise<T>;
  click(selector: string): Promise<void>;
  goto(name: string): Promise<void>;
  frameEval<T>(code: string): Promise<T>;
}

/** 픽스처를 열고 fn(page, got) 를 돌린다. picker 를 주면 확장 선택기를 세운다. */
async function on<T>(fn: (page: On, got: unknown[]) => Promise<T>, picker = false, url = fixture().url): Promise<T> {
  const x = await ext();
  const got: unknown[] = [];
  const wrap = (pg: Tab['page'], tab: Tab | null): On => ({
    url: () => pg.url(),
    eval: code => pg.evaluate(code),
    // 선택기는 사람이 누른 클릭만 받는다 → 신뢰된 마우스 이벤트로 누른다.
    click: async sel => {
      if (tab) await x.clickAt(tab, sel);
      else await pg.click(sel);
    },
    goto: async name => { await pg.goto(new URL(name, pg.url()).href); },
    frameEval: code => pg.frames().find(f => f !== pg.mainFrame())!.evaluate(code),
  });
  if (!picker) {
    const pg = await x.ctx.newPage();
    try {
      await pg.goto(url);
      return await fn(wrap(pg, null), got);
    } finally {
      await pg.close();
    }
  }
  const ctl = new AbortController();
  let opened!: (t: Tab) => void;
  const tabReady = new Promise<Tab>(r => { opened = r; });
  const running = pick(url, p => got.push(p), { signal: ctl.signal, onTab: opened, targets: ['본문', 'next', '제목'], timeout: 5000 });
  const tab = await Promise.race([tabReady, running.then(() => { throw new Error('선택기가 서기 전에 끝났습니다'); })]);
  try {
    await tab.page.waitForFunction(() => !!document.querySelector('[data-ariadne-ui] button'), undefined, { timeout: 10000, polling: 50 });
    const result = await fn(wrap(tab.page, tab), got);
    // 선택값은 짧은 간격으로 읽어 온다 → 끝내기 전에 한 번 더 기다린다.
    await sleep(200);
    return result;
  } finally {
    ctl.abort();
    await running.catch(() => {});
  }
}

const candidates = (page: On, selector: string) =>
  page.eval<Cand[]>(`(${CANDIDATES_JS})(document.querySelector(${JSON.stringify(selector)}))`);
const bySel = (cs: Cand[]) => Object.fromEntries(cs.map(c => [c.sel, c.n]));
const uiCount = `document.querySelectorAll('[data-ariadne-ui]').length`;
async function clickToolbar(page: On, label: string) {
  await page.eval(`[...document.querySelectorAll('[data-ariadne-ui] button')].find(b => b.textContent === ${JSON.stringify(label)}).setAttribute('data-test-target', '')`);
  await page.click('[data-test-target]');
  await page.eval(`document.querySelector('[data-test-target]')?.removeAttribute('data-test-target')`);
}

async function waitUi(page: On) {
  for (let i = 0; i < 50 && !(await page.eval<number>(uiCount)); i++) await sleep(50);
}

test('TC#35 pickerPrefersId', async () => {
  // id 가 있으면 첫 후보로 낸다. 가장 짧고 깨지지 않는다.
  const got = await on(page => candidates(page, '#tt'));
  assert.deepEqual(got[0], { sel: '#tt', n: 1 });
});

test('TC#35 pickerShowsMatchCountForEachCandidate', async () => {
  // 클래스를 줄인 후보가 몇 개를 잡는지 보여 준다 → 상태 클래스가 섞였는지 드러난다.
  const got = bySel(await on(page => candidates(page, 'div.article.body')));
  assert.equal(got['div.article.body'], 1);
  assert.equal(got['div.article'], 3);
});

test('TC#35 pickerSuggestsContainerForImage', async () => {
  const got = bySel(await on(page => candidates(page, '#gallery img')));
  assert.equal(got['#gallery img'], 2);
});

test('TC#65 pickerPutsImageContainerFirst', async () => {
  const html = `<meta charset="utf-8"><body>
<div id="g"><img id="x" class="cut" src="a.png"><img class="cut" src="b.png"></div>
<section class="list wide"><p><img class="cut" id="y" src="c.png"></p><p><img src="d.png"></p></section>
<span><img id="z" src="e.png"></span><img src="f.png">
</body>`;
  const got = await on(async page => [
    await candidates(page, '#x'), await candidates(page, '#y'), await candidates(page, '#z'),
  ], false, fixture(html).url);
  assert.deepEqual(got[0][0], { sel: '#g img', n: 2 });
  assert.ok(got[0].findIndex(c => c.sel === '#x') > 0, '한 장짜리 후보가 빠졌다');
  assert.deepEqual(got[1][0], { sel: 'section.list.wide img', n: 2 });
  assert.deepEqual(got[2][0], { sel: 'img', n: 6 });
  assert.ok(got[2].some(c => c.sel === '#z'), '한 장짜리 후보가 빠졌다');
});

test('TC#65 pickerFillsImageContainerOnClick', async () => {
  const html = `<meta charset="utf-8"><body style="margin:40px 300px 300px 40px">
<div id="g"><img id="x" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80" height="80"><img src="b.png"></div>
</body>`;
  const got = await on(async (page, got) => {
    await waitUi(page);
    await page.click('#x');
    await sleep(300);
    return got as { sel: string }[];
  }, true, fixture(html).url);
  assert.equal(got[0]?.sel, '#g img');
});

test('TC#36 pickerExcludesOwnUiFromCount', async () => {
  // 선택기가 붙인 요소는 매치 수에 들어가지 않는다 → 태그만 쓴 후보에서 드러난다.
  const [before, after, ui] = await on(async page => {
    const b = await candidates(page, 'div.article.body');
    await waitUi(page);
    return [b, await candidates(page, 'div.article.body'), await page.eval<number>(uiCount)] as const;
  }, true);
  assert.ok(ui > 0, '선택기가 붙지 않았다');
  assert.equal(bySel(before).div, 4);                 // 픽스처의 div 수
  assert.equal(bySel(after).div, bySel(before).div);
  assert.equal(bySel(after)['div.article'], 3);
});

test('TC#37 pickerClickReportsAndBlocksNavigation', async () => {
  // 클릭하면 후보를 돌려주고 링크 이동은 막는다.
  const [got, before, after] = await on(async (page, got) => {
    await waitUi(page);
    const before = page.url();
    await page.click('.next');
    await sleep(300);
    return [got as { candidates: Cand[]; text: string }[], before, page.url()] as const;
  }, true);
  assert.equal(after, before);
  assert.ok(got.length, '클릭이 콜백으로 전달되지 않았다');
  assert.equal(got[0].candidates[0].sel, 'a.next');
  assert.equal(got[0].text, '다음');
});

test('TC#37 pickerSwitchesTargetFromToolbar', async () => {
  // 툴바에서 대상을 바꾸면 그 뒤의 클릭이 바뀐 대상으로 전달된다.
  const got = await on(async (page, got) => {
    await waitUi(page);
    await page.click('div.article.body');
    await clickToolbar(page, 'next');
    await page.click('.next');
    await sleep(300);
    return got as { target: string; sel: string }[];
  }, true);
  assert.deepEqual(got.map(g => g.target), ['본문', 'next']);
  assert.equal(got[1].sel, 'a.next');
});

test('TC#37 pickerToolbarClickIsNotTreatedAsSelection', async () => {
  const got = await on(async (page, got) => {
    await waitUi(page);
    await clickToolbar(page, '제목');
    await sleep(300);
    return got;
  }, true);
  assert.deepEqual(got, [], '툴바 버튼 클릭이 선택으로 전달됐다');
});

test('TC#38 pickerReinstallsOnEveryDocument', async () => {
  // 문서가 바뀔 때마다 다시 선다. 리다이렉트·새로고침 뒤에도 선택기가 남아야 한다.
  const { d, url } = fixture();
  fs.writeFileSync(path.join(d, 'second.html'), FIXTURE);
  const got = await on(async (page, got) => {
    await waitUi(page);
    await page.goto('second.html');
    await waitUi(page);
    await page.click('div.article.body');
    await sleep(300);
    return got as { sel: string }[];
  }, true, url);
  assert.equal(got[0]?.sel, 'div.article.body');
});

test('TC#38 pickerSkipsIframes', async () => {
  // iframe 에는 붙지 않는다. 광고마다 툴바가 뜨면 페이지를 쓸 수 없다.
  const { d } = fixture('<meta charset="utf-8"><body><a id="ad" href="/x">광고</a></body>', 'inner.html');
  fs.writeFileSync(path.join(d, 'outer.html'), FIXTURE.replace('</body>', '<iframe src="inner.html" width="200" height="80"></iframe></body>'));
  const [main, frame] = await on(async page => {
    await waitUi(page);
    await sleep(300);
    return [await page.eval<number>(uiCount), await page.frameEval<number>(uiCount)] as const;
  }, true, pathToFileURL(path.join(d, 'outer.html')).href);
  assert.ok(main > 0, '메인 프레임에 붙지 않았다');
  assert.equal(frame, 0, 'iframe 에 붙었다');
});
