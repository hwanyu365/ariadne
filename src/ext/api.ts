import type { ScrapeOptions } from '../core/engine.js';

export type RunOptions = Omit<ScrapeOptions, 'signal' | 'onLog' | 'headful'>;

export interface RunInput {
  tabId: number;
  url: string;
  sel: string;
  nextSel: string;
  prefix: string;
  opts: RunOptions;
}

export interface RunResult {
  pages: number;
  /** 예외로 끝났으면 그 첫 줄. */
  error: string | null;
  logs: string[];
}

/** 패널이 여는 수집 입구. 패널 화면과 테스트가 같이 쓴다. */
export interface PanelApi {
  run(input: RunInput, root: FileSystemDirectoryHandle): Promise<RunResult>;
  stop(): void;
  /** 진행 중이거나 마지막 수집의 로그. */
  readonly logs: string[];
}

declare global {
  var ariadne: PanelApi;
}
