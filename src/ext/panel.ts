import { pick, probe, scrape } from '../core/engine.js';
import { pickUpdate } from '../core/form.js';
import type { PanelApi, Picked, RunResult } from './api.js';
import { extEnv, tabOpener } from './env.js';
import { installTimers } from './timers.js';

installTimers();

// 패널이 닫히면 이 연결이 끊긴다 → 서비스 워커가 남은 디버거를 뗀다.
// 서비스 워커가 내려가도 연결이 끊긴다 → 다시 이어 붙인 탭을 다시 알린다.
const held = new Set<number>();
let port: chrome.runtime.Port;
// 워커가 내려간 뒤 끊김 알림이 오기 전까지는 포트가 던진다 → 붙인 탭 목록은 held 에 남고 다시 이을 때 보낸다.
function tell(m: { tabId: number; attached: boolean }) {
  try {
    port.postMessage(m);
  } catch {
    // 다시 이을 때 held 로 알린다
  }
}
function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  for (const tabId of held) tell({ tabId, attached: true });
  port.onDisconnect.addListener(connect);
}
connect();
const logs: string[] = [];
const picks: Picked[] = [];
const logListeners: ((line: string) => void)[] = [];
const pickListeners: ((p: Picked) => void)[] = [];
let ctl: AbortController | null = null;

const onLog = (m: string) => {
  logs.push(m);
  for (const cb of logListeners) cb(m);
};

/** 엔진 호출 하나를 감싼다. 로그를 비우고, 중지 신호를 주고, 예외를 실패 줄로 바꾸고, 디버거가 떨어진 뒤에 끝난다. */
async function session(tabId: number, body: (opener: ReturnType<typeof tabOpener>, signal: AbortSignal) => Promise<number>, reset = () => {}): Promise<RunResult> {
  // 로그·선택값·중지 신호를 패널 전체가 같이 쓴다 → 진행 중인 실행의 것을 다른 실행이 덮지 못하게 한다.
  if (ctl) return { pages: 0, error: '이미 실행 중입니다.', logs: [] };
  const own = ctl = new AbortController();
  logs.length = 0;
  reset();
  const attached = (on: boolean) => {
    if (on) held.add(tabId);
    else held.delete(tabId);
    tell({ tabId, attached: on });
  };
  const opener = tabOpener(tabId, onLog, attached);
  try {
    const pages = await body(opener, own.signal);
    return { pages, error: null, logs: [...logs] };
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e).split('\n')[0];
    onLog(`실패: ${error}`);
    return { pages: 0, error, logs: [...logs] };
  } finally {
    // 엔진은 페이지를 닫고 바로 돌아온다 → 디버거가 실제로 떨어진 뒤에 끝났다고 알린다.
    await opener.settled();
    ctl = null;
  }
}

globalThis.ariadne = {
  run(input, root) {
    return session(input.tabId, (opener, signal) =>
      scrape(extEnv(opener, root), input.url, input.sel, input.nextSel, input.prefix, { ...input.opts, signal, onLog }));
  },
  probe(input) {
    return session(input.tabId, async opener => {
      await probe(opener, input.url, input.sel, input.nextSel, { ...input.opts, onLog });
      return 0;
    });
  },
  pick(input) {
    const { mode, ...opts } = input.opts;
    return session(input.tabId, async (opener, signal) => {
      // 선택값은 대상 페이지가 정한 값이다 → 검사를 거친 것만 입력란 값으로 넘긴다.
      await pick(opener, input.url, payload => {
        const u = pickUpdate(payload);
        if (!u) return;
        const got = { key: u.key, sel: u.sel };
        picks.push(got);
        for (const cb of pickListeners) cb(got);
        onLog(u.line);
      }, { ...opts, signal, onLog, targets: mode === 'image' ? ['이미지', 'next', '제목'] : ['본문', 'next', '제목', '제외'] });
      return 0;
    }, () => { picks.length = 0; });
  },
  stop() {
    ctl?.abort();
  },
  logs,
  picks,
  on(event: 'log' | 'pick', cb: ((line: string) => void) | ((p: Picked) => void)) {
    if (event === 'log') logListeners.push(cb as (line: string) => void);
    else pickListeners.push(cb as (p: Picked) => void);
  },
} satisfies PanelApi;
