import fs from 'node:fs';
import path from 'node:path';
import * as core from '../core/engine';
import { Page, type PageOptions } from './page';

export { reachable } from '../core/engine';
export type { PickOptions, ProbeOptions } from '../core/engine';

export interface ScrapeOptions extends core.ScrapeOptions {
  cdp?: PageOptions['cdp'];
}

/** 접두사(경로 + 파일 이름 앞부분)의 폴더에 쓴다. */
export function fsSink(prefix: string): core.Sink {
  // 접두사가 구분자로 끝나면('out/') 이름 앞부분은 비고 파일은 그 폴더 안에 생긴다 → 파일 이름 자리를 채워 나눈다.
  const dir = path.dirname(`${prefix}x`);
  fs.mkdirSync(dir, { recursive: true });
  const at = (name: string) => path.join(dir, name);
  return {
    base: path.basename(`${prefix}x`).slice(0, -1),
    list: async () => fs.readdirSync(dir),
    exists: async name => fs.existsSync(at(name)),
    size: async name => fs.statSync(at(name)).size,
    write: async (name, data) => fs.writeFileSync(at(name), data),
    append: async (name, text) => fs.appendFileSync(at(name), text, 'utf8'),
  };
}

const env = (cdp?: PageOptions['cdp']): core.Env => ({
  open: o => Page.open({ ...o, cdp }),
  sink: async prefix => fsSink(prefix),
});

export function scrape(url: string, sel: string, nextSel: string, prefix: string, o: ScrapeOptions = {}): Promise<number> {
  return core.scrape(env(o.cdp), url, sel, nextSel, prefix, o);
}

export function probe(url: string, sel: string | null, nextSel: string | null, o: core.ProbeOptions = {}): Promise<void> {
  return core.probe(env(), url, sel, nextSel, o);
}

export function pick(url: string, onPick: (payload: unknown) => void, o: core.PickOptions = {}): Promise<void> {
  return core.pick(env(), url, onPick, o);
}
