import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium, type Page as PwPage } from 'playwright-core';
import type { PickInput, ProbeRunOptions, RunOptions, RunResult } from '../ext/api';

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
  private constructor(readonly ctx: BrowserContext, readonly id: string, readonly panel: PwPage, private readonly proc: ReturnType<typeof spawn>) {}

  /** dir 의 확장을 올린 Chromium 을 띄운다. 공유 인스턴스는 ext() 로 얻고, 따로 띄운 것은 close() 로 끈다. */
  static async launch(dir = EXT_DIR): Promise<Ext> {
    // Playwright 가 띄운 브라우저는 페이지마다 포커스를 흉내 내 가려진 탭도 보이는 상태가 된다.
    // 직접 띄우고 기본 설정 없이 붙는다 → 가려진 탭·패널의 동작을 실제처럼 시험한다.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-ext-'));
    const proc = spawn(chromium.executablePath(), [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      ...(at ? [`--window-position=${at[1]},${at[2]}`] : []),
      `--disable-extensions-except=${dir}`, `--load-extension=${dir}`, 'about:blank',
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
    return new Ext(ctx, id, panel, proc);
  }

  close(): void {
    this.proc.kill();
  }

  /** 패널 주소의 페이지를 하나 더 연다. */
  async openPanel(): Promise<PwPage> {
    const p = await this.ctx.newPage();
    await p.goto(`chrome-extension://${this.id}/panel.html`);
    await p.waitForFunction(() => 'ariadne' in globalThis);
    return p;
  }

  /**
   * 대상 탭의 창에 패널 화면을 뒤쪽 탭으로 연다 → 그 창의 지금 탭은 대상 탭 그대로다.
   * settings 는 미리 넣을 저장 설정(undefined 면 비운다), folder 는 고른 폴더로 둘 OPFS 폴더 이름(null 이면 고른 폴더 없음)이다.
   */
  async openUi(tab: Tab, o: { settings?: unknown; folder?: string | null } = {}): Promise<PwPage> {
    await this.panel.evaluate(s => s === undefined ? chrome.storage.local.remove('settings') : chrome.storage.local.set({ settings: s }), o.settings);
    // tsc 가 import() 를 require 로 바꾼다 → 패널 문서에서 모듈을 부를 때는 식을 글자로 넘긴다.
    await this.panel.evaluate(`(async () => {
      const m = await import('./dist/ext/folder.js');
      const name = ${JSON.stringify(o.folder ?? null)};
      await m.saveFolder(name ? await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true }) : null);
    })()`);
    const opened = this.ctx.waitForEvent('page');
    await this.panel.evaluate(async ([t, u]) => {
      await chrome.tabs.create({ windowId: (await chrome.tabs.get(t)).windowId, url: u, active: false });
    }, [tab.id, `chrome-extension://${this.id}/panel.html`] as const);
    const ui = await opened;
    await ui.waitForFunction(() => document.body.dataset.ready === '1', undefined, { timeout: 10000, polling: 50 });
    return ui;
  }

  /** OPFS 폴더 안 파일의 글자 내용. */
  opfsFiles(dir: string): Promise<Record<string, string>> {
    return this.panel.evaluate(async dir => {
      const out: Record<string, string> = {};
      const walk = async (d: FileSystemDirectoryHandle, at: string) => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, `${at}${name}/`);
          else out[at + name] = await (await (h as FileSystemFileHandle).getFile()).text();
        }
      };
      await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(dir), '');
      return out;
    }, dir);
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

  /** started 는 probe 를 보낸 직후에 부른다. */
  async probe(tab: Tab, url: string, sel: string | null, nextSel: string | null, opts: ProbeRunOptions = {}, started?: () => void): Promise<RunResult> {
    const running = this.panel.evaluate(input => { ariadne.logs.length = 0; return ariadne.probe(input); }, { tabId: tab.id, url, sel, nextSel, opts });
    started?.();
    return running;
  }

  /** 선택기를 열고, 툴바가 그 탭에 뜰 때까지 기다린다. done 은 선택기가 끝날 때 풀린다. */
  async pick(tab: Tab, url: string, opts: PickInput['opts'] = {}, panel = this.panel): Promise<{ done: Promise<RunResult> }> {
    const done = panel.evaluate(input => { ariadne.logs.length = 0; ariadne.picks.length = 0; return ariadne.pick(input); }, { tabId: tab.id, url, opts });
    await Promise.race([tab.page.waitForFunction(() => !!document.querySelector('[data-ariadne-ui] button'), undefined, { timeout: 10000, polling: 50 }), done]);
    // promise 를 그대로 돌려주면 await 가 풀어 버린다 → 끝날 때를 기다릴 수 있게 감싼다.
    return { done };
  }

  /** 사람이 누른 것처럼 요소의 가운데를 누른다. 가려진 창은 그리기가 멈춰 Playwright 의 누를 수 있는지 판정을 쓰지 않는다. */
  async clickAt(tab: Tab, selector: string): Promise<void> {
    const r = await tab.page.evaluate(s => { const e = document.querySelector(s)!; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, selector);
    await tab.page.mouse.click(r[0], r[1]);
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
