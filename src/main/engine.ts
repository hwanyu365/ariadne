import fs from 'node:fs';
import path from 'node:path';
import { charsetWarning } from './charset';
import { Page, type PageOptions } from './page';
import { IMAGE_CANDIDATES_JS, NEXT_CANDIDATES_JS, TEXT_CANDIDATES_JS } from './picker';

export type Log = (msg: string) => void;

export interface ScrapeOptions {
  maxPages?: number;
  timeout?: number;
  headful?: boolean;
  delay?: number;
  digits?: number;
  start?: number;
  titleSel?: string | null;
  mode?: 'text' | 'image';
  onLog?: Log;
  signal?: AbortSignal;
  charset?: string | null;
  cdp?: PageOptions['cdp'];
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'];
const MIME_EXTS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pad = (n: number, digits: number) => String(n).padStart(digits, '0');
const q = JSON.stringify;
const firstLine = (e: unknown) => String(e instanceof Error ? e.message : e).split('\n')[0];

/** selector 에 걸리는 모든 요소의 보이는 텍스트를 합쳐서 돌려준다. */
async function readText(page: Page, selector: string, timeout: number): Promise<string> {
  await page.waitFor(selector, timeout);
  return page.eval<string>(`[...document.querySelectorAll(${q(selector)})].map(e => e.innerText.trim()).join('\\n').trim()`);
}

/** selector 에 걸리는 이미지들의 주소를 줄바꿈으로 이어 돌려준다. 페이지 변경 판정도 이 문자열로 한다. */
async function readSrcs(page: Page, selector: string, timeout: number): Promise<string> {
  // 지연 로딩 이미지는 주소가 붙기 전까지 크기가 0 이라 visible 로는 기다릴 수 없다.
  await page.waitFor(selector, timeout, 'attached');
  // 지연 로딩 사이트는 src 에 placeholder 를 넣고 실제 주소를 data-src 에 둔다.
  const srcs = await page.eval<string[]>(`[...document.querySelectorAll(${q(selector)})]
    .map(e => e.dataset.src || e.getAttribute('data-src') || e.currentSrc || e.src || '')`);
  return srcs.filter(s => s && !s.startsWith('data:')).join('\n');
}

/** 지연 로딩 이미지는 화면에 들어와야 주소가 채워지므로 한 번 훑어 내린다. */
function scrollAll(page: Page, step = 800, pause = 120) {
  return page.eval(`(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += ${step}) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, ${pause}));
    }
    window.scrollTo(0, 0);
  })()`, 120000);                       // 아주 긴 페이지는 평가 기본 상한보다 오래 걸린다
}

/** 제목 셀렉터가 안 걸려도 빈 문자열을 돌려준다. 헤더는 부가 정보라 본문 수집을 멈출 이유가 못 된다. */
async function readTitle(page: Page, selector: string): Promise<string> {
  const t = await page.eval<string | null>(`document.querySelector(${q(selector)})?.innerText ?? null`);
  return (t ?? '').split(/\s+/).filter(Boolean).join(' ');
}

/** SPA 는 next 클릭 후에도 URL·DOM 이 그대로일 수 있어, 수집 대상이 실제로 바뀔 때까지 폴링한다. */
async function waitChange(page: Page, selector: string, old: string, timeout: number, read: typeof readText) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const cur = await read(page, selector, 1000).catch(() => '');
    if (cur && cur !== old) return cur;
    await sleep(200);
  }
  return null;
}

/** 주소는 원격 페이지가 정한다 → 웹 주소이거나 지금 페이지와 같은 스킴일 때만 따라간다. 원격 페이지가 로컬 파일을 가리키게 하지 않는다. */
function reachable(url: URL, pageUrl: string): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === new URL(pageUrl).protocol;
}

/** 다음 페이지로 넘긴다. 성공하면 null, 못 넘기면 사유 문자열. */
async function gotoNext(page: Page, nextSel: string, timeout: number): Promise<string | null> {
  const state = await page.eval<{ clickable: boolean; href: string } | null>(`(() => {
    const e = document.querySelector(${q(nextSel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    // 마지막 페이지에서 next 를 숨기는 사이트와 비활성화만 하는 사이트가 반반이라 둘 다 본다.
    const clickable = visible && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
    return { clickable, href: e.getAttribute('href') || '' };
  })()`);
  if (!state) return `next 셀렉터 '${nextSel}' 에 걸리는 요소가 없다.`;
  if (state.clickable) {
    try {
      await page.click(nextSel);
    } catch (e) {
      return `next 를 누르지 못했다: ${firstLine(e)}`;
    }
    return null;
  }
  // 숨김·비활성이어도 href 가 살아 있으면 직접 이동한다.
  // 마지막이 아닌 페이지에서도 next 를 CSS 로만 죽여두는 사이트가 있어서, 여기서 포기하면 1페이지만 받고 끝난다.
  if (state.href && !state.href.startsWith('#') && !state.href.startsWith('javascript:')) {
    const to = URL.parse(state.href, page.url());
    if (!to) return `next 의 주소 ${state.href.slice(0, 80)} 를 해석할 수 없다.`;
    if (!reachable(to, page.url())) return `next 의 주소 ${to.href.slice(0, 80)} 는 따라가지 않는다.`;
    await page.goto(to.href, timeout);
    return null;
  }
  return 'next 요소는 있으나 숨김/비활성이고 href 도 없다. 마지막 페이지로 본다.';
}

function imageExt(url: string, contentType: string | null): string {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return ext;
  return MIME_EXTS[(contentType ?? '').split(';')[0].trim()] ?? '.bin';
}

/** 한 페이지의 이미지를 받아 저장하고 저장한 장수를 돌려준다. */
async function saveImages(page: Page, srcs: string[], prefix: string, num: number, digits: number, log: Log, timeout: number, signal?: AbortSignal) {
  let saved = 0;
  for (const [i, src] of srcs.entries()) {
    const parsed = URL.parse(src, page.url());
    if (!parsed || !reachable(parsed, page.url())) {
      log(`  건너뜀 받지 않는 주소 ${src.slice(0, 80)}`);
      continue;
    }
    const url = parsed.href;
    try {
      const resp = await page.fetch(url, timeout, signal);
      if (!resp.ok) {
        log(`  건너뜀 HTTP ${resp.status} ${url.slice(0, 80)}`);
        continue;
      }
      const out = `${prefix}_${pad(num, digits)}_${pad(i + 1, 3)}${imageExt(url, resp.headers.get('content-type'))}`;
      fs.writeFileSync(out, Buffer.from(await resp.arrayBuffer()));
      saved++;
    } catch (e) {
      log(`  건너뜀 ${url.slice(0, 80)} (${firstLine(e).slice(0, 60)})`);
    }
  }
  return saved;
}

/** 본문을 파일로 쓰고 (길이, 파일명) 을 돌려준다. */
async function saveText(page: Page, text: string, prefix: string, num: number, digits: number, titleSel: string | null, log: Log) {
  let body = text;
  if (titleSel) {
    // 제목을 본문에 싣지 않는 사이트가 있어, "{n}화. {제목}" 헤더를 직접 붙인다.
    const title = await readTitle(page, titleSel);
    if (!title) log(`  경고: 제목 셀렉터 '${titleSel}' 에 걸리는 요소가 없다.`);
    body = `${title ? `${num}화. ${title}` : `${num}화.`}\n\n${text}`;
  }
  const out = `${prefix}_${pad(num, digits)}.txt`;
  fs.writeFileSync(out, body, 'utf8');
  return { size: [...body].length, name: path.basename(out) };
}

export async function scrape(url: string, sel: string, nextSel: string, prefix: string, o: ScrapeOptions = {}): Promise<number> {
  const { maxPages = 0, timeout = 15000, delay = 0, digits = 4, start = 1, titleSel = null, charset = null } = o;
  const log = o.onLog ?? console.error;
  const images = o.mode === 'image';
  const read = images ? readSrcs : readText;
  const base = prefix;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  let pages = 0;
  const page = await Page.open({ show: !!o.headful, charset, cdp: o.cdp });
  try {
    await page.goto(url, timeout);
    if (images) await scrollAll(page);
    let current = await read(page, sel, timeout);
    let warned = images;                 // 이미지는 인코딩과 무관하다

    while (true) {
      pages++;
      const num = start + pages - 1;
      // 중간에 끊겨도 여기까지 받은 건 남도록 페이지마다 바로 쓴다.
      if (images) {
        const n = await saveImages(page, current.split('\n'), base, num, digits, log, timeout, o.signal);
        log(`[${pages}] 이미지 ${n}장 -> ${path.basename(base)}_${pad(num, digits)}_*`);
      } else {
        const { size, name } = await saveText(page, current, base, num, digits, titleSel, log);
        log(`[${pages}] ${size}자 -> ${name}`);
        if (!warned) {
          // 페이지마다 선언이 다를 수 있어 매번 보되, 같은 경고로 로그를 덮지 않게 한 번만 낸다.
          const warn = charsetWarning(await page.eval<string>('document.characterSet'), page.docBytes(), charset);
          if (warn) {
            log(warn);
            warned = true;
          }
        }
      }

      if (o.signal?.aborted) {
        log('  중단: 사용자 중지.');
        break;
      }
      if (maxPages && pages >= maxPages) break;
      // 왜 멈췄는지 남긴다. 셀렉터 오타로 1페이지만 받고 끝나는 게 가장 흔한 사고다.
      const why = await gotoNext(page, nextSel, timeout);
      if (why) {
        log(`  중단: ${why}${pages === 1 ? ' 셀렉터를 probe 로 확인하라.' : ''}`);
        break;
      }
      let next = await waitChange(page, sel, current, timeout, read);
      if (next === null) {
        log(`  중단: next 클릭 후 ${timeout}ms 동안 수집 대상이 바뀌지 않았다. 마지막 페이지거나, 로딩이 느리면 타임아웃을 늘려야 한다.`);
        break;
      }
      if (images) {
        // 바뀐 것만 보고 넘어가면 아직 주소가 안 붙은 지연 이미지를 놓친다.
        await scrollAll(page);
        next = await read(page, sel, timeout);
      }
      current = next;
      if (delay) await sleep(delay);
    }
  } finally {
    page.close();
  }
  return pages;
}

export interface ProbeOptions {
  timeout?: number;
  headful?: boolean;
  titleSel?: string | null;
  delay?: number;
  onLog?: Log;
  /** 창을 띄웠을 때 사용자가 확인을 마칠 때까지 기다린다. */
  pause?: () => Promise<void>;
  charset?: string | null;
}

export async function probe(url: string, sel: string | null, nextSel: string | null, o: ProbeOptions = {}): Promise<void> {
  const { timeout = 15000, delay = 0, charset = null } = o;
  const log = o.onLog ?? console.log;
  const page = await Page.open({ show: !!o.headful, charset });
  try {
    await page.goto(url, timeout);
    await sleep(1500 + delay);          // 지연 렌더되는 본문을 놓치지 않도록. 더 느리면 대기 시간을 늘린다.
    await scrollAll(page);

    const actual = await page.eval<string>('document.characterSet');
    log(`인코딩: ${actual}`);
    const warn = charsetWarning(actual, page.docBytes(), charset);
    if (warn) log(warn);

    for (const [name, s] of [['수집 대상', sel], ['next', nextSel], ['제목', o.titleSel ?? null]] as const) {
      if (!s) continue;
      const found = await page.eval<{ n: number; previews: string[] }>(`(() => {
        const els = [...document.querySelectorAll(${q(s)})];
        return { n: els.length, previews: els.slice(0, 3).map(e => e.getAttribute('src') || e.innerText || '') };
      })()`);
      log(`\n${name} '${s}' -> ${found.n}개 매치`);
      found.previews.forEach((p, i) => log(`    [${i}] '${p.split(/\s+/).filter(Boolean).join(' ').slice(0, 70)}'`));
    }

    const frames = page.childFrames();
    if (frames.length) {
      log(`\n주의: iframe ${frames.length}개. 본문이 그 안에 있으면 수집할 수 없다.`);
      frames.slice(0, 5).forEach(f => log(`    ${f.url.slice(0, 90)}`));
    }

    log('\n[next 버튼 후보]');
    for (const c of await page.eval<{ sel: string; text: string; href: string }[]>(`(${NEXT_CANDIDATES_JS})()`))
      log(`    ${c.sel.padEnd(40)} text='${c.text}' href='${c.href}'`);
    log('\n[본문 후보 - 짧은 쪽이 본문일 확률이 높다]');
    for (const c of await page.eval<{ sel: string; len: number }[]>(`(${TEXT_CANDIDATES_JS})()`))
      log(`    ${c.sel.padEnd(40)} ${c.len}자`);
    log('\n[이미지 후보 - 큰 이미지가 많은 쪽이 본문일 확률이 높다]');
    for (const c of await page.eval<{ sel: string; n: number; big: number }[]>(`(${IMAGE_CANDIDATES_JS})()`))
      log(`    ${c.sel.padEnd(40)} ${c.n}장 (300px 이상 ${c.big}장)`);

    if (o.headful && o.pause) {
      log('\n창을 확인한 뒤 [중지] 를 누르면 닫힌다.');
      await Promise.race([o.pause(), page.whenClosed()]);
    }
  } finally {
    page.close();
  }
}

export interface PickOptions {
  timeout?: number;
  targets?: readonly string[];
  onLog?: Log;
  signal?: AbortSignal;
  charset?: string | null;
}

/** 창을 띄우고 사용자가 클릭한 요소의 셀렉터 후보를 onPick 으로 넘긴다. 완료·중지·창 닫기 중 먼저 오는 것에서 끝난다. */
export async function pick(url: string, onPick: (payload: unknown) => void, o: PickOptions = {}): Promise<void> {
  const log = o.onLog ?? console.error;
  let done = false;
  const page = await Page.open({
    charset: o.charset ?? null,
    picker: { targets: o.targets ?? ['본문', 'next', '제목'], onPick, onDone: () => { done = true; } },
  });
  try {
    await page.goto(url, o.timeout ?? 15000);
    log("요소를 클릭하면 셀렉터 후보가 뜬다. 다 고르면 툴바의 '완료' 또는 [중지] 를 누른다.");
    while (!done && !o.signal?.aborted && !page.closed()) await sleep(200);
  } finally {
    page.close();
  }
}
