import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PickOptions, ProbeOptions, ScrapeOptions as CoreScrapeOptions } from '../core/engine';
import { ext, type Tab } from './ext';
import { serve } from './serve';

/**
 * 엔진 테스트가 쓰는 입구. 엔진을 확장 패널에서 지금 탭(DebuggerPage)과 고른 폴더(OPFS)로 돌린다.
 * 콜백(onLog·onPick)과 중지(signal)는 테스트 프로세스 쪽 함수라 패널로 넘길 수 없다 → 로그·선택값을 짧게 읽어 와 부르고, 중지는 패널의 신호로 옮긴다.
 */
export interface ScrapeOptions extends Omit<CoreScrapeOptions, 'onLog' | 'signal'> {
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  /** CDP 호출을 가로채는 함수의 소스 (`send => (method, params) => …`). 패널에서 평가하므로 바깥 변수를 쓰지 못한다. */
  cdp?: string;
}

type Kind = 'scrape' | 'probe' | 'pick';

// 확장은 file: 문서에 디버거를 붙이지 못한다 → 픽스처 폴더를 http 로 띄워 같은 상대 경로로 연다.
async function reachableUrl(url: string) {
  if (!url.startsWith('file:')) return { url, close: async () => {} };
  const file = fileURLToPath(url);
  const srv = await serve(path.dirname(file));
  return { url: `${srv.base}/${path.basename(file)}`, close: srv.close };
}

type CallOptions = ScrapeOptions & { onPick?: (p: unknown) => void; onTab?: (tab: Tab) => void };

async function call(kind: Kind, url: string, args: Record<string, unknown>, o: CallOptions, disk?: string): Promise<number> {
  const x = await ext();
  const target = await reachableUrl(url);
  const tab: Tab = await x.newTab();
  const dir = disk ? await x.upload(disk) : null;
  const { onLog, signal, onPick, onTab, cdp, ...opts } = o;
  onTab?.(tab);
  const input = { kind, tabId: tab.id, url: target.url, dir, opts, ...args };
  let seenLogs = 0, seenPicks = 0, draining = Promise.resolve();
  // 읽어 오기가 겹치면 같은 줄을 두 번 넘기거나 건너뛴다 → 한 번에 하나씩 읽는다.
  const drain = () => (draining = draining.then(pull));
  const pull = async () => {
    const got = await x.panel.evaluate(([l, p]) => {
      const g = globalThis as unknown as { __logs?: string[]; __picks?: unknown[] };
      return [(g.__logs ?? []).slice(l), (g.__picks ?? []).slice(p)] as const;
    }, [seenLogs, seenPicks] as const).catch(() => [[], []] as const);
    seenLogs += got[0].length;
    seenPicks += got[1].length;
    for (const line of got[0]) onLog?.(line);
    for (const p of got[1]) onPick?.(p);
  };
  const stop = () => { void x.panel.evaluate('globalThis.__ctl?.abort()'); };
  signal?.addEventListener('abort', stop, { once: true });
  // tsc 가 import() 를 require 로 바꾼다 → 패널 문서에서 모듈을 부를 때는 식을 글자로 넘긴다.
  const running = x.panel.evaluate(`(async () => {
    const A = ${JSON.stringify(input)};
    const [core, env, sink] = await Promise.all([import('./dist/core/engine.js'), import('./dist/ext/env.js'), import('./dist/ext/sink.js')]);
    const g = globalThis;
    g.__logs = []; g.__picks = []; g.__ctl = new AbortController();
    const onLog = m => g.__logs.push(m);
    const opener = env.tabOpener(A.tabId, onLog, () => {});
    const hook = ${cdp ?? 'null'};
    const open = async o => { const p = await opener.open(o); if (hook) p.send = hook(p.send); return p; };
    const root = A.dir ? await (await navigator.storage.getDirectory()).getDirectoryHandle(A.dir) : null;
    const e = { open, sink: prefix => sink.fsaSink(root, prefix) };
    const o = { ...A.opts, onLog, signal: g.__ctl.signal };
    try {
      if (A.kind === 'scrape') return { pages: await core.scrape(e, A.url, A.sel, A.nextSel, A.prefix, o) };
      if (A.kind === 'probe') { await core.probe(e, A.url, A.sel, A.nextSel, o); return { pages: 0 }; }
      await core.pick(e, A.url, p => g.__picks.push(p), o);
      return { pages: 0 };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      await opener.settled();
    }
  })()`) as Promise<{ pages?: number; error?: string }>;
  const poll = setInterval(() => { void drain(); }, 50);
  try {
    const got = await running;
    clearInterval(poll);
    await drain();
    if (got.error !== undefined) throw new Error(got.error);
    return got.pages ?? 0;
  } finally {
    clearInterval(poll);
    signal?.removeEventListener('abort', stop);
    if (dir && disk) await x.download(dir, disk);
    await x.closeTab(tab);
    await target.close();
  }
}

/** prefix 는 디스크 경로다. 그 폴더를 고른 폴더로 삼아 마지막 이름을 접두사로 쓴다. */
export function scrape(url: string, sel: string, nextSel: string, prefix: string, o: ScrapeOptions = {}): Promise<number> {
  return call('scrape', url, { sel, nextSel, prefix: path.basename(prefix) }, o, path.dirname(prefix));
}

export async function probe(url: string, sel: string | null, nextSel: string | null, o: Omit<ProbeOptions, 'onLog'> & { onLog?: (line: string) => void; cdp?: string } = {}): Promise<void> {
  await call('probe', url, { sel, nextSel }, o);
}

/** onTab 은 선택기를 세울 대상 탭을 연 직후에 받는다 → 테스트가 그 탭을 사람처럼 누른다. */
export async function pick(url: string, onPick: (payload: unknown) => void, o: Omit<PickOptions, 'onLog' | 'signal'> & { onLog?: (line: string) => void; signal?: AbortSignal; onTab?: (tab: Tab) => void } = {}): Promise<void> {
  await call('pick', url, {}, { ...o, onPick });
}
