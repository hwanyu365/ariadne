import { scrape } from '../core/engine.js';
import type { PanelApi } from './api.js';
import { extEnv } from './env.js';
import { installTimers } from './timers.js';

installTimers();

// 패널이 닫히면 이 연결이 끊긴다 → 서비스 워커가 남은 디버거를 뗀다.
// 서비스 워커가 내려가도 연결이 끊긴다 → 다시 이어 붙인 탭을 다시 알린다.
const held = new Set<number>();
let port: chrome.runtime.Port;
function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  for (const tabId of held) port.postMessage({ tabId, attached: true });
  port.onDisconnect.addListener(connect);
}
connect();
const logs: string[] = [];
let ctl: AbortController | null = null;

globalThis.ariadne = {
  async run(input, root) {
    logs.length = 0;
    ctl = new AbortController();
    const onLog = (m: string) => { logs.push(m); };
    const attached = (on: boolean) => {
      if (on) held.add(input.tabId);
      else held.delete(input.tabId);
      port.postMessage({ tabId: input.tabId, attached: on });
    };
    try {
      const pages = await scrape(extEnv(input.tabId, root, onLog, attached), input.url, input.sel, input.nextSel, input.prefix, { ...input.opts, signal: ctl.signal, onLog });
      return { pages, error: null, logs: [...logs] };
    } catch (e) {
      const error = String(e instanceof Error ? e.message : e).split('\n')[0];
      return { pages: 0, error, logs: [...logs, `실패: ${error}`] };
    } finally {
      ctl = null;
    }
  },
  stop() {
    ctl?.abort();
  },
  logs,
} satisfies PanelApi;
