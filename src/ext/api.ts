import type { ProbeOptions, ScrapeOptions } from '../core/engine.js';
import type { TextKey } from '../core/form.js';

export type RunOptions = Omit<ScrapeOptions, 'signal' | 'onLog' | 'headful'>;
export type ProbeRunOptions = Pick<ProbeOptions, 'timeout' | 'delay' | 'titleSel' | 'charset' | 'exclude'>;

export interface ProbeInput {
  tabId: number;
  url: string;
  sel: string | null;
  nextSel: string | null;
  opts: ProbeRunOptions;
}

export interface PickInput {
  tabId: number;
  url: string;
  opts: { timeout?: number; mode?: 'text' | 'image'; charset?: string | null };
}

/** 검사를 거친 선택값. key 는 채울 입력란이다. */
export interface Picked {
  key: TextKey;
  sel: string;
}

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
  probe(input: ProbeInput): Promise<RunResult>;
  /** 선택기가 끝날 때까지 기다린다. 선택값은 끝나기 전에도 picks 에 쌓인다. */
  pick(input: PickInput): Promise<RunResult>;
  /** 진행 중이거나 마지막 선택기의 선택값. */
  readonly picks: Picked[];
  stop(): void;
  /** 진행 중이거나 마지막 수집의 로그. */
  readonly logs: string[];
}

declare global {
  var ariadne: PanelApi;
}
