import type { Env, Log } from '../core/engine.js';
import { DebuggerPage } from './page.js';
import { fsaSink } from './sink.js';

/** 지금 탭과 고른 폴더로 엔진을 돌린다. attached 는 디버거를 붙이고 뗄 때 알린다. */
export function extEnv(tabId: number, root: FileSystemDirectoryHandle, log: Log, attached: (on: boolean) => void): Env {
  return {
    open: o => DebuggerPage.open(tabId, o, log, attached),
    sink: prefix => fsaSink(root, prefix),
  };
}
