import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { charsetWarning } from './charset';
import { Page, pickPolicy, type PageOptions } from './page';
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
  /** 텍스트 모드에서 본문 안에서 뺄 요소. */
  exclude?: string | null;
  /** 텍스트 모드에서 받은 본문 전체를 {접두사}_all.txt 로도 남긴다. */
  merge?: boolean;
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'];
const MIME_EXTS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
};
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(r => {
  if (signal?.aborted) return r();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); r(); }
  signal?.addEventListener('abort', done, { once: true });
});
const pad = (n: number, digits: number) => String(n).padStart(digits, '0');
const q = JSON.stringify;
const firstLine = (e: unknown) => String(e instanceof Error ? e.message : e).split('\n')[0];

// 숨긴 요소의 innerText 는 글자 전체를 돌려준다 → 대상까지 가리면 무엇을 받았는지 알 수 없다.
const coverMessage = (exclude: string) => `제외 셀렉터 '${exclude}' 가 수집 대상까지 가립니다.`;
class CoverError extends Error {}

/**
 * 제외 요소를 숨겨 innerText 가 화면에 보이는 줄바꿈대로 나머지를 읽게 한다. 수집 대상까지 가리면 숨기지 않고 true 를 돌려준다.
 * 인라인 <style> 은 페이지 CSP 에 막힐 수 있다 → CSP 와 무관한 CSSOM 으로 요소마다 숨기고, 늦게 붙은 요소를 위해 읽을 때마다 다시 한다.
 */
function hideExcluded(page: Page, selector: string, exclude: string): Promise<boolean> {
  return page.eval<boolean>(`(() => {
    const ex = ${q(exclude)};
    if ([...document.querySelectorAll(${q(selector)})].some(e => e.closest(ex))) return true;
    document.querySelectorAll(ex).forEach(e => e.style.setProperty('display', 'none', 'important'));
    return false;
  })()`);
}

/** selector 에 걸리는 모든 요소의 보이는 텍스트를 합쳐서 돌려준다. */
async function readText(page: Page, selector: string, timeout: number, exclude: string | null = null): Promise<string> {
  await page.waitFor(selector, timeout);
  if (exclude && await hideExcluded(page, selector, exclude)) throw new CoverError(coverMessage(exclude));
  return page.eval<string>(`[...document.querySelectorAll(${q(selector)})].map(e => e.innerText.trim()).join('\\n').trim()`);
}

/** selector 에 걸리는 이미지들의 주소를 줄바꿈으로 이어 돌려준다. 페이지 변경 판정도 이 문자열로 한다. */
async function readSrcs(page: Page, selector: string, timeout: number): Promise<string> {
  // 지연 로딩 이미지는 주소가 붙기 전까지 크기가 0 이라 visible 로는 기다릴 수 없다.
  await page.waitFor(selector, timeout, 'attached');
  // 지연 로딩 사이트는 src 에 placeholder 를 넣고 실제 주소를 data-* 에 둔다.
  const srcs = await page.eval<string[]>(`[...document.querySelectorAll(${q(selector)})].map(${SRC_OF})`);
  return [...new Set(srcs.filter(s => s && !s.startsWith('data:')))].join('\n');
}

const SRC_OF = `e => e.getAttribute('data-src') || e.getAttribute('data-original') || e.getAttribute('data-lazy-src') || e.currentSrc || e.src || ''`;

/** 주소마다 걸린 Referer 정책. 요소의 referrerpolicy 가 문서의 meta 보다, meta 가 응답 헤더보다 앞선다. */
async function imagePolicies(page: Page, selector: string): Promise<Map<string, string>> {
  const got = await page.eval<[string, string, string][]>(`(() => {
    const meta = document.querySelector('meta[name="referrer" i]')?.content ?? '';
    return [...document.querySelectorAll(${q(selector)})].map(e => [(${SRC_OF})(e), e.getAttribute('referrerpolicy') ?? '', meta]);
  })()`);
  const map = new Map<string, string>();
  for (const [src, attr, meta] of got) if (!map.has(src)) map.set(src, pickPolicy(attr, meta, page.referrerPolicy()));
  return map;
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
async function waitChange(page: Page, selector: string, old: string, timeout: number, read: typeof readText, signal?: AbortSignal) {
  const deadline = Date.now() + timeout;
  let seen = '';
  while (Date.now() < deadline && !signal?.aborted) {
    // 아직 안 그려진 페이지의 실패는 기다리면 풀린다. 제외가 대상을 가리는 것은 기다려도 풀리지 않는다.
    const cur = await read(page, selector, 1000).catch(e => { if (e instanceof CoverError) throw e; return ''; });
    // 나눠 그려지는 본문은 첫 변화가 일부일 수 있다 → 잠시 뒤 다시 읽어 같을 때 확정한다.
    if (cur && cur !== old && cur === seen) return cur;
    seen = cur;
    await sleep(cur && cur !== old ? 300 : 200, signal);
  }
  return null;
}

/** 스크롤은 지연 이미지를 채우는 보조 단계다 → 끝나지 않는 페이지에서도 수집은 계속한다. */
async function scrollFor(page: Page, log: Log) {
  await scrollAll(page).catch(e => log(`  경고: 페이지 끝까지 스크롤하지 못했습니다 (${firstLine(e).slice(0, 60)})`));
}

/** 주소는 원격 페이지가 정한다 → 웹 주소이거나 지금 페이지와 같은 스킴일 때만 따라간다. 원격 페이지가 로컬 파일을 가리키게 하지 않는다. */
export function reachable(url: URL, pageUrl: string): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === new URL(pageUrl).protocol;
}

/** 다음 페이지로 넘긴다. 성공하면 null, 못 넘기면 사유 문자열. */
async function gotoNext(page: Page, nextSel: string, timeout: number): Promise<string | null> {
  const state = await page.eval<{ clickable: boolean; href: string; blank: boolean } | null>(`(() => {
    const e = document.querySelector(${q(nextSel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    // 마지막 페이지에서 next 를 숨기는 사이트와 비활성화만 하는 사이트가 반반이라 둘 다 본다.
    const clickable = visible && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
    // 셀렉터가 링크 안쪽 아이콘을 가리키는 사이트가 있다 → 감싼 링크의 주소를 쓴다.
    // 버튼을 감싼 링크는 카드 전체 링크일 수 있다 → 링크 자신이나 링크 안 장식 요소일 때만 그 주소를 쓴다.
    const a = e.hasAttribute('href') ? e : e.closest('button, input, select, textarea') ? null : e.closest('a[href]');
    const h = a?.getAttribute('href') || '';
    const t = (a?.target || '').toLowerCase();
    return {
      clickable,
      href: h.startsWith('#') || /^\\s*javascript:/i.test(h) ? '' : h,
      blank: !!t && !['_self', '_parent', '_top'].includes(t),
    };
  })()`);
  if (!state) return `next 셀렉터 '${nextSel}' 에 걸리는 요소가 없습니다.`;
  let clickError = '';
  // 새 탭 링크는 눌러도 새 창이 거부돼 아무 일도 없다 → 주소로 넘어간다.
  if (state.clickable && !(state.blank && state.href)) {
    try {
      await page.click(nextSel);
      return null;
    } catch (e) {
      clickError = `next 를 누르지 못했습니다: ${firstLine(e)}`;
      if (!state.href) return clickError;
    }
  }
  // 숨김·비활성이어도 href 가 살아 있으면 직접 이동한다.
  // 마지막이 아닌 페이지에서도 next 를 CSS 로만 죽여두는 사이트가 있어서, 여기서 포기하면 1페이지만 받고 끝난다.
  if (state.href) {
    const to = URL.parse(state.href, page.url());
    if (!to) return `next 의 주소 ${state.href.slice(0, 80)} 를 해석할 수 없습니다.`;
    if (!reachable(to, page.url())) return `next 의 주소 ${to.href.slice(0, 80)} 는 따라가지 않습니다.`;
    try {
      await page.goto(to.href, timeout);
    } catch (e) {
      return `${clickError ? `${clickError} ` : ''}next 의 주소로 이동하지 못했습니다: ${firstLine(e)}`;
    }
    return null;
  }
  return clickError || 'next 요소는 있으나 숨김/비활성이고 href 도 없습니다. 마지막 페이지로 봅니다.';
}

const MAGIC: [string, (b: Buffer) => boolean][] = [
  ['.png', b => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  ['.jpg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['.gif', b => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['.webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['.avif', b => b.subarray(4, 12).toString('latin1') === 'ftypavif'],
  // 'BM' 두 글자로 시작하는 글자 응답도 있다 → DIB 헤더 크기까지 맞아야 BMP 로 본다.
  ['.bmp', b => b.length >= 26 && b.subarray(0, 2).toString('latin1') === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14))],
];

/** 받은 내용이 이미지면 확장자를, 아니면 null 을 돌려준다. CDN 은 주소의 확장자와 다른 형식을 보내기도 한다. */
function imageExt(url: string, contentType: string | null, body: Buffer): string | null {
  if (!body.length) return null;
  const sniffed = MAGIC.find(([, is]) => is(body))?.[0];
  if (sniffed) return sniffed;
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  // 차단 페이지를 image/* 로 내려주는 CDN 도 있다 → 마크업으로 시작하면 SVG 만 이미지로 본다.
  if (/^(\xef\xbb\xbf)?\s*</.test(body.subarray(0, 64).toString('latin1')) && mime !== 'image/svg+xml') return null;
  if (mime.startsWith('image/')) return IMAGE_EXTS.includes(ext) ? ext : MIME_EXTS[mime] ?? '.bin';
  // 핫링크 차단은 200 과 HTML 로 답한다 → 형식을 밝히지 않은 응답만 주소의 확장자를 믿는다.
  const untyped = !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream';
  return untyped && IMAGE_EXTS.includes(ext) ? ext : null;
}

/** 한 페이지의 이미지를 받아 저장하고 저장한 장수를 돌려준다. */
async function saveImages(page: Page, srcs: string[], policies: Map<string, string>, prefix: string, num: number, digits: number, log: Log, timeout: number, signal?: AbortSignal) {
  let saved = 0;
  for (const [i, src] of srcs.entries()) {
    const parsed = URL.parse(src, page.url());
    if (!parsed || !reachable(parsed, page.url())) {
      log(`  건너뜀 받지 않는 주소 ${src.slice(0, 80)}`);
      continue;
    }
    const url = parsed.href;
    try {
      const resp = await page.fetch(url, timeout, signal, policies.get(src) ?? page.referrerPolicy());
      if (!resp.ok) {
        log(`  건너뜀 HTTP ${resp.status} ${url.slice(0, 80)}`);
        continue;
      }
      const type = resp.headers.get('content-type');
      const body = Buffer.from(await resp.arrayBuffer());
      const ext = imageExt(url, type, body);
      if (!ext) {
        log(`  건너뜀 이미지가 아닌 응답(${type || '형식 없음'}) ${url.slice(0, 80)}`);
        continue;
      }
      fs.writeFileSync(`${prefix}_${pad(num, digits)}_${pad(i + 1, 3)}${ext}`, body);
      saved++;
    } catch (e) {
      if (signal?.aborted) break;      // 사용자 중지는 남은 장을 하나씩 실패로 남기지 않는다
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
    if (!title) log(`  경고: 제목 셀렉터 '${titleSel}' 에 걸리는 요소가 없습니다.`);
    body = `${title ? `${num}화. ${title}` : `${num}화.`}\n\n${text}`;
  }
  const out = `${prefix}_${pad(num, digits)}.txt`;
  fs.writeFileSync(out, body, 'utf8');
  return { size: [...body].length, name: path.basename(out), body };
}

export async function scrape(url: string, sel: string, nextSel: string, prefix: string, o: ScrapeOptions = {}): Promise<number> {
  const { maxPages = 0, timeout = 15000, delay = 0, digits = 4, start = 1, titleSel = null, charset = null } = o;
  const log = o.onLog ?? console.error;
  const images = o.mode === 'image';
  const exclude = o.exclude?.trim() || null;
  const read: typeof readText = images ? readSrcs : (p, s, t) => readText(p, s, t, exclude);
  const base = prefix;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const first = `${path.basename(base)}_${pad(start, digits)}`;
  // Windows·macOS 파일시스템은 대소문자를 가리지 않는다.
  const lower = first.toLowerCase();
  const clash = fs.readdirSync(path.dirname(base)).find(f => images ? f.toLowerCase().startsWith(`${lower}_`) : f.toLowerCase() === `${lower}.txt`);
  if (clash) log(`경고: 이미 같은 이름의 파일이 있어 덮어쓰거나 섞일 수 있습니다: ${clash}`);
  const all = o.merge && !images ? `${base}_all.txt` : null;
  // 이어 받기(시작 번호 2 이상)는 앞서 합친 본문 뒤에 붙인다.
  if (all && start > 1 && fs.existsSync(all)) log(`  이어 씁니다: ${path.basename(all)}`);
  else if (all) {
    if (fs.existsSync(all)) log(`경고: 이미 있는 파일을 새로 씁니다: ${path.basename(all)}`);
    fs.writeFileSync(all, '', 'utf8');
  }
  let pages = 0;
  let last = '';
  // 장편은 본문 전체를 쌓으면 메모리가 커진다 → 해시만 남긴다.
  const seen = new Set<string>();
  const digest = (v: string) => createHash('sha1').update(v).digest('hex');
  const page = await Page.open({ show: !!o.headful, charset, cdp: o.cdp });
  try {
    await page.goto(url, timeout);
    if (images) await scrollFor(page, log);
    let current = await read(page, sel, timeout);
    let warned = images;                 // 이미지는 인코딩과 무관하다

    while (true) {
      pages++;
      const num = start + pages - 1;
      // 주소까지 보아야 다른 페이지의 같은 본문(삽화·휴재 공지)에서 멈추지 않는다. 주소가 그대로인 SPA 는 본문만 남는다.
      seen.add(digest(`${page.url()}\n${current}`));
      const here = `${num}번 ${page.url()}`;
      // 중간에 끊겨도 여기까지 받은 건 남도록 페이지마다 바로 쓴다.
      if (images) {
        const n = await saveImages(page, current.split('\n').filter(Boolean), await imagePolicies(page, sel), base, num, digits, log, timeout, o.signal);
        log(`[${pages}] 이미지 ${n}장 -> ${path.basename(base)}_${pad(num, digits)}_*`);
      } else {
        const { size, name, body } = await saveText(page, current, base, num, digits, titleSel, log);
        if (all) fs.appendFileSync(all, fs.statSync(all).size ? `\n\n${body}` : body, 'utf8');
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
      // 이어 받기 기준이므로 저장을 마친 페이지만 남긴다.
      last = here;

      if (o.signal?.aborted) {
        log('  중단: 사용자 중지.');
        break;
      }
      if (maxPages && pages >= maxPages) break;
      // 왜 멈췄는지 남긴다. 셀렉터 오타로 1페이지만 받고 끝나는 게 가장 흔한 사고다.
      const docs = page.documents();
      const why = await gotoNext(page, nextSel, timeout);
      if (why) {
        log(`  중단: ${why}${pages === 1 ? ' 셀렉터를 probe 로 확인하세요.' : ''}`);
        break;
      }
      let next = await waitChange(page, sel, current, timeout, read, o.signal);
      if (o.signal?.aborted) {
        log('  중단: 사용자 중지.');
        break;
      }
      if (next === null) {
        // 문서가 그대로인 SPA 는 지난 문서의 상태를 들고 있다 → 새 문서를 받았을 때만 상태를 본다.
        const status = page.documents() !== docs ? page.status() : 0;
        log(status >= 400
          ? `  중단: next 로 넘어간 페이지가 HTTP ${status} 로 응답했습니다.`
          : `  중단: next 클릭 후 ${timeout}ms 동안 수집 대상이 바뀌지 않았습니다. 마지막 페이지거나, 로딩이 느리면 타임아웃을 늘려 주세요.`);
        break;
      }
      if (images) {
        // 바뀐 것만 보고 넘어가면 아직 주소가 안 붙은 지연 이미지를 놓친다.
        await scrollFor(page, log);
        next = await read(page, sel, timeout);
      }
      if (seen.has(digest(`${page.url()}\n${next}`))) {
        log('  중단: next 가 이미 받은 페이지로 돌아왔습니다. 마지막 페이지로 봅니다.');
        break;
      }
      current = next;
      if (delay) await sleep(delay, o.signal);
      if (o.signal?.aborted) {
        log('  중단: 사용자 중지.');
        break;
      }
    }
  } finally {
    if (last) log(`  마지막으로 받은 페이지: ${last}`);
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
  exclude?: string | null;
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

    // 미리보기가 수집 결과와 같아야 제외 셀렉터가 맞는지 판단할 수 있다.
    const exclude = o.exclude?.trim() || null;
    if (sel && exclude && await hideExcluded(page, sel, exclude)) log(`\n경고: ${coverMessage(exclude)}`);
    for (const [name, s] of [['수집 대상', sel], ['next', nextSel], ['제목', o.titleSel ?? null], ['제외', exclude]] as const) {
      if (!s) continue;
      const found = await page.eval<{ n: number; previews: string[] }>(`(() => {
        const els = [...document.querySelectorAll(${q(s)})];
        return { n: els.length, previews: els.slice(0, 3).map(e => e.getAttribute('data-src') || e.getAttribute('data-original') || e.getAttribute('data-lazy-src') || e.getAttribute('src') || e.innerText || '') };
      })()`);
      log(`\n${name} '${s}' -> ${found.n}개 매치`);
      found.previews.forEach((p, i) => log(`    [${i}] '${p.split(/\s+/).filter(Boolean).join(' ').slice(0, 70)}'`));
    }

    const frames = page.childFrames();
    if (frames.length) {
      log(`\n주의: iframe ${frames.length}개. 본문이 그 안에 있으면 수집할 수 없습니다.`);
      frames.slice(0, 5).forEach(f => log(`    ${f.url.slice(0, 90)}`));
    }

    log('\n[next 버튼 후보]');
    for (const c of await page.eval<{ sel: string; text: string; href: string }[]>(`(${NEXT_CANDIDATES_JS})()`))
      log(`    ${c.sel.padEnd(40)} text='${c.text}' href='${c.href}'`);
    log('\n[본문 후보 - 짧은 쪽이 본문일 확률이 높습니다]');
    for (const c of await page.eval<{ sel: string; len: number }[]>(`(${TEXT_CANDIDATES_JS})()`))
      log(`    ${c.sel.padEnd(40)} ${c.len}자`);
    log('\n[이미지 후보 - 큰 이미지가 많은 쪽이 본문일 확률이 높습니다]');
    for (const c of await page.eval<{ sel: string; n: number; big: number }[]>(`(${IMAGE_CANDIDATES_JS})()`))
      log(`    ${c.sel.padEnd(40)} ${c.n}장 (300px 이상 ${c.big}장)`);

    if (o.headful && o.pause) {
      log('\n창을 확인한 뒤 [중지] 를 누르면 닫힙니다.');
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
    log("요소를 클릭하면 셀렉터 후보가 뜹니다. 다 고르면 툴바의 '완료' 또는 [중지] 를 누르세요.");
    while (!done && !o.signal?.aborted && !page.closed()) await sleep(200);
  } finally {
    page.close();
  }
}
