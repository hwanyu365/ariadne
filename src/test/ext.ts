import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium, type Page as PwPage } from 'playwright-core';
import type { RunOptions, RunResult } from '../ext/api';

export const EXT_DIR = path.join(__dirname, '..', '..', 'ext');

/** 테스트 창을 띄울 Chrome 화면 좌표 'x,y'. 모니터 배율이 있으면 OS 픽셀 좌표와 다르다. 로컬에서 작업 화면을 가리지 않게 다른 모니터로 보낼 때 쓴다. */
const at = /^(-?\d+),(-?\d+)$/.exec(process.env.ARIADNE_TEST_WINDOW ?? '');

export interface Tab {
  id: number;
  page: PwPage;
}

let launched: Promise<Ext> | null = null;
let runs = 0;

/** 확장을 올린 Chromium 하나를 테스트 파일 전체가 같이 쓴다. */
export function ext(): Promise<Ext> {
  launched ??= Ext.launch();
  return launched;
}

export class Ext {
  private constructor(readonly ctx: BrowserContext, readonly id: string, readonly panel: PwPage) {}

  static async launch(): Promise<Ext> {
    // Playwright 가 띄운 브라우저는 페이지마다 포커스를 흉내 내 가려진 탭도 보이는 상태가 된다.
    // 직접 띄우고 기본 설정 없이 붙는다 → 가려진 탭·패널의 동작을 실제처럼 시험한다.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-ext-'));
    const proc = spawn(chromium.executablePath(), [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      ...(at ? [`--window-position=${at[1]},${at[2]}`] : []),
      `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, 'about:blank',
    ], { stdio: 'ignore' });
    process.once('exit', () => proc.kill());
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n')) {
      if (Date.now() > deadline) throw new Error('확장을 올린 Chromium 이 뜨지 않았습니다.');
      await new Promise(r => setTimeout(r, 100));
    }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const ctx = browser.contexts()[0];
    // 브라우저에 내장된 확장의 서비스 워커도 보인다 → 이 확장의 것을 고른다.
    const ours = (w: { url(): string }) => w.url().endsWith('/dist/ext/sw.js');
    const sw = ctx.serviceWorkers().find(ours) ?? await ctx.waitForEvent('serviceworker', { predicate: ours });
    const id = new URL(sw.url()).host;
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${id}/panel.html`);
    await panel.waitForFunction(() => 'ariadne' in globalThis);
    return new Ext(ctx, id, panel);
  }

  /** 패널 주소의 페이지를 하나 더 연다. */
  async openPanel(): Promise<PwPage> {
    const p = await this.ctx.newPage();
    await p.goto(`chrome-extension://${this.id}/panel.html`);
    await p.waitForFunction(() => 'ariadne' in globalThis);
    return p;
  }

  /** 새 창에 대상 탭을 만든다. 패널과 다른 창이라 둘 다 보이는 상태로 시작한다. */
  async newTab(url = 'about:blank'): Promise<Tab> {
    const opened = this.ctx.waitForEvent('page');
    // 화면 좌표는 모니터 배율에 따라 Chrome 의 좌표와 다르다 → 새 창은 패널 창이 놓인 자리에 띄운다.
    const id = await this.panel.evaluate(async ([u, follow]) => {
      const w = await chrome.windows.getCurrent();
      return (await chrome.windows.create({ url: u, focused: false, ...(follow ? { left: w.left, top: w.top } : {}) }))!.tabs![0].id!;
    }, [url, !!at] as const);
    const page = await opened;
    await page.waitForLoadState();
    return { id, page };
  }

  /** 대상 탭에서 수집하고, 결과 폴더를 root 디스크 폴더로 내려받는다. root 의 기존 파일은 먼저 올린다. */
  /** started 는 수집을 보낸 직후에 부른다. 그 뒤의 패널 호출은 이번 수집의 로그만 본다. */
  async scrape(tab: Tab, url: string, sel: string, nextSel: string, root: string, prefix: string, opts: RunOptions = {}, panel = this.panel, started?: () => void): Promise<RunResult> {
    const dir = `run-${++runs}`;
    await panel.evaluate(async ([dir, files]) => {
      const base = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir, { create: true });
      for (const [rel, b64] of Object.entries(files)) {
        const parts = rel.split('/');
        let d = base;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
        await w.close();
      }
    }, [dir, readTree(root)] as const);
    const running = panel.evaluate(async ([dir, input]) => {
      // 지난 수집의 로그로 이번 수집의 진행을 판정하지 않게 먼저 비운다.
      ariadne.logs.length = 0;
      const base = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir);
      return ariadne.run(input, base);
    }, [dir, { tabId: tab.id, url, sel, nextSel, prefix, opts }] as const);
    started?.();
    const got = await running;
    const files = await panel.evaluate(async dir => {
      const root = await navigator.storage.getDirectory();
      const out: Record<string, string> = {};
      const walk = async (d: FileSystemDirectoryHandle, at: string) => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, `${at}${name}/`);
          else {
            const b = new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
            let s = '';
            for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
            out[at + name] = btoa(s);
          }
        }
      };
      await walk(await root.getDirectoryHandle(dir), '');
      await root.removeEntry(dir, { recursive: true });
      return out;
    }, dir);
    for (const [rel, b64] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), Buffer.from(b64, 'base64'));
    }
    return got;
  }

  /** 진행 중인 수집의 로그에 pattern 이 나올 때까지 기다린다. */
  async waitLog(pattern: RegExp, panel = this.panel, timeout = 10000): Promise<void> {
    await panel.waitForFunction(p => ariadne.logs.some(l => new RegExp(p).test(l)), pattern.source, { timeout, polling: 50 });
  }

  /** 확장이 그 탭에 디버거를 붙이고 있는지. */
  attached(tabId: number, panel = this.panel): Promise<boolean> {
    return panel.evaluate(t => chrome.debugger.sendCommand({ tabId: t }, 'Runtime.evaluate', { expression: '1' }).then(() => true, () => false), tabId);
  }

  tabExists(tabId: number): Promise<boolean> {
    return this.panel.evaluate(t => chrome.tabs.get(t).then(() => true, () => false), tabId);
  }

  async closeTab(tab: Tab): Promise<void> {
    await this.panel.evaluate(t => chrome.tabs.remove(t).catch(() => {}), tab.id);
  }
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}
