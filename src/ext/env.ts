import type { Env, Log } from '../core/engine.js';
import { DebuggerPage } from './page.js';
import { fsaSink } from './sink.js';

/** 지금 탭을 연다. attached 는 디버거를 붙이고 뗄 때 알리고, settled 는 연 페이지의 디버거가 모두 떨어지면 풀린다. */
export function tabOpener(tabId: number, log: Log, attached: (on: boolean) => void): Pick<Env, 'open'> & { settled(): Promise<void> } {
  const pages: DebuggerPage[] = [];
  return {
    open: async o => {
      const page = await DebuggerPage.open(tabId, o, log, attached);
      pages.push(page);
      return page;
    },
    settled: async () => { await Promise.all(pages.map(p => p.whenClosed())); },
  };
}

/** 지금 탭과 고른 폴더로 수집한다. */
export function extEnv(opener: Pick<Env, 'open'>, root: FileSystemDirectoryHandle): Env {
  return { open: opener.open, sink: prefix => fsaSink(root, prefix) };
}
