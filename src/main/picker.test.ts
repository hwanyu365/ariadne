import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tempDir } from '../test/serve';
import { Page } from './page';
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

/** 픽스처를 열고 fn(page, got) 를 돌린다. picker 를 주면 선택기 창으로 연다. */
async function on<T>(fn: (page: Page, got: unknown[]) => Promise<T>, picker = false, url = fixture().url): Promise<T> {
  const got: unknown[] = [];
  const page = await Page.open(picker ? { picker: { targets: ['본문', 'next', '제목'], onPick: p => got.push(p), onDone: () => {} } } : {});
  try {
    await page.goto(url, 5000);
    await page.waitFor('body', 5000, 'attached');
    return await fn(page, got);
  } finally {
    page.close();
  }
}

const candidates = (page: Page, selector: string) =>
  page.eval<Cand[]>(`(${CANDIDATES_JS})(document.querySelector(${JSON.stringify(selector)}))`);
const bySel = (cs: Cand[]) => Object.fromEntries(cs.map(c => [c.sel, c.n]));
const uiCount = `document.querySelectorAll('[data-ariadne-ui]').length`;
const clickToolbar = (page: Page, label: string) =>
  page.eval(`[...document.querySelectorAll('[data-ariadne-ui] button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);

async function waitUi(page: Page) {
  for (let i = 0; i < 50 && !(await page.eval<number>(uiCount)); i++) await sleep(50);
}

test('pickerPrefersId', async () => {
  // id 가 있으면 첫 후보로 낸다. 가장 짧고 깨지지 않는다.
  const got = await on(page => candidates(page, '#tt'));
  assert.deepEqual(got[0], { sel: '#tt', n: 1 });
});

test('pickerShowsMatchCountForEachCandidate', async () => {
  // 클래스를 줄인 후보가 몇 개를 잡는지 보여 준다 → 상태 클래스가 섞였는지 드러난다.
  const got = bySel(await on(page => candidates(page, 'div.article.body')));
  assert.equal(got['div.article.body'], 1);
  assert.equal(got['div.article'], 3);
});

test('pickerSuggestsContainerForImage', async () => {
  const got = bySel(await on(page => candidates(page, '#gallery img')));
  assert.equal(got['#gallery img'], 2);
});

test('pickerExcludesOwnUiFromCount', async () => {
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

test('pickerClickReportsAndBlocksNavigation', async () => {
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

test('pickerSwitchesTargetFromToolbar', async () => {
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

test('pickerToolbarClickIsNotTreatedAsSelection', async () => {
  const got = await on(async (page, got) => {
    await waitUi(page);
    await clickToolbar(page, '제목');
    await sleep(300);
    return got;
  }, true);
  assert.deepEqual(got, [], '툴바 버튼 클릭이 선택으로 전달됐다');
});

test('pickerReinstallsOnEveryDocument', async () => {
  // 문서가 바뀔 때마다 다시 선다. 리다이렉트·새로고침 뒤에도 선택기가 남아야 한다.
  const { d, url } = fixture();
  fs.writeFileSync(path.join(d, 'second.html'), FIXTURE);
  const got = await on(async (page, got) => {
    await waitUi(page);
    await page.goto(pathToFileURL(path.join(d, 'second.html')).href, 5000);
    await waitUi(page);
    await page.click('div.article.body');
    await sleep(300);
    return got as { sel: string }[];
  }, true, url);
  assert.equal(got[0]?.sel, 'div.article.body');
});

test('pickerSkipsIframes', async () => {
  // iframe 에는 붙지 않는다. 광고마다 툴바가 뜨면 페이지를 쓸 수 없다.
  const { d } = fixture('<meta charset="utf-8"><body><a id="ad" href="/x">광고</a></body>', 'inner.html');
  fs.writeFileSync(path.join(d, 'outer.html'), FIXTURE.replace('</body>', '<iframe src="inner.html" width="200" height="80"></iframe></body>'));
  const [main, frame] = await on(async page => {
    await waitUi(page);
    const f = await page.waitForChildFrame(5000);
    await sleep(300);
    return [await page.eval<number>(uiCount), await f.executeJavaScript(uiCount)] as const;
  }, true, pathToFileURL(path.join(d, 'outer.html')).href);
  assert.ok(main > 0, '메인 프레임에 붙지 않았다');
  assert.equal(frame, 0, 'iframe 에 붙었다');
});

test('pickerChannelHiddenFromPageScripts', async () => {
  // 선택 결과 통로는 격리 world 에만 있다 → 대상 페이지의 스크립트가 가짜 선택을 보낼 수 없다.
  const seen = await on(async page => {
    await waitUi(page);
    return page.eval<string>(`typeof window.__ariadne_pick + ',' + typeof window.__ariadneCandidates`);
  }, true);
  assert.equal(seen, 'undefined,undefined');
});
