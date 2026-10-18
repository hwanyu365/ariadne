import { BrowserWindow, ipcMain, type IpcMainEvent, type WebFrameMain } from 'electron';
import path from 'node:path';
import { pickerSetupJs } from './picker';

export type Send = (method: string, params?: object) => Promise<any>;

export interface PageOptions {
  charset?: string | null;
  show?: boolean;
  /** 테스트에서 CDP 호출을 가로채는 자리. */
  cdp?: (send: Send) => Send;
  picker?: { targets: readonly string[]; onPick: (payload: unknown) => void; onDone: () => void };
}

// preload 가 선택기 통로를 여는 격리 world 다. 같은 world 에 선택기를 넣어야 그 통로를 쓴다.
const PRELOAD_WORLD = 999;
let runs = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** 수집 대상 페이지 하나. Playwright 의 page 에 해당하는 것을 BrowserWindow 와 CDP 로 만든다. */
export class Page {
  private raw = Buffer.alloc(0);
  private cleanup: (() => void)[] = [];

  private constructor(readonly win: BrowserWindow, private send: Send) {}

  /** charset 을 주면 메인 문서 응답의 charset 을 바꿔 브라우저의 인코딩 추정을 건너뛴다. */
  static async open(opts: PageOptions = {}): Promise<Page> {
    const win = new BrowserWindow({
      show: opts.show ?? !!opts.picker,
      width: 1280,
      height: 800,
      webPreferences: {
        // 실행마다 비영속 세션을 새로 만든다 → 쿠키가 다음 실행으로 넘어가지 않는다. 이름에 '.' 이 들어가면 로드가 실패한다.
        partition: `ariadne-run-${++runs}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 숨긴 창도 타이머와 지연 로딩이 멈추지 않게 한다.
        backgroundThrottling: false,
        preload: opts.picker ? path.join(__dirname, '..', 'preload', 'picker.js') : undefined,
      },
    });
    // 수집은 원래 탭만 읽는다 (docs/specification.md NFR#9).
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // CDP 는 렌더러가 생긴 뒤에야 프레임 트리를 준다.
    await win.loadURL('about:blank');
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const raw: Send = (method, params) => dbg.sendCommand(method, params);
    const page = new Page(win, opts.cdp ? opts.cdp(raw) : raw);
    await page.interceptDocuments(opts.charset ?? null);
    if (opts.picker) page.installPicker(opts.picker);
    return page;
  }

  /** 메인 프레임 문서의 원래 바이트를 남기고, charset 을 주면 그 값으로 바꿔 넘긴다. */
  private async interceptDocuments(charset: string | null) {
    // 인코딩이 다른 iframe 까지 덮으면 그쪽이 깨진다 → 메인 프레임 문서만 다룬다.
    const main = (await this.send('Page.getFrameTree')).frameTree.frame.id;
    const onMessage = async (_e: unknown, method: string, ev: any) => {
      if (method !== 'Fetch.requestPaused') return;
      const rid = ev.requestId;
      try {
        if (ev.frameId === main && ev.responseStatusCode >= 200 && ev.responseStatusCode < 300) {
          const got = await this.send('Fetch.getResponseBody', { requestId: rid });
          // 바꿔 넘긴 응답은 다시 인코딩된 값이라 원래 바이트는 여기서만 얻는다.
          const raw = Buffer.from(got.body, got.base64Encoded ? 'base64' : 'utf8');
          this.raw = raw;               // 수백 페이지를 넘기는 동안 지난 문서를 쥐고 있지 않는다
          if (charset) {
            await this.send('Fetch.fulfillRequest', forced(ev, raw, charset));
            return;
          }
        }
      } catch {
        // 멈춘 요청은 풀어 주지 않으면 타임아웃까지 매달린다 → 실패 종류와 무관하게 원래대로 보낸다.
      }
      await this.send('Fetch.continueRequest', { requestId: rid }).catch(() => {});
    };
    this.win.webContents.debugger.on('message', onMessage);
    await this.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
  }

  private installPicker(picker: NonNullable<PageOptions['picker']>) {
    const wc = this.win.webContents;
    const mine = (e: IpcMainEvent) => e.sender === wc;
    const onPick = (e: IpcMainEvent, payload: unknown) => mine(e) && picker.onPick(payload);
    const onDone = (e: IpcMainEvent) => mine(e) && picker.onDone();
    ipcMain.on('ariadne:pick', onPick);
    ipcMain.on('ariadne:done', onDone);
    // 문서가 바뀔 때마다 다시 세운다. 한 번만 넣으면 리다이렉트·새로고침에서 선택기가 사라진다.
    const install = () => { wc.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD, [{ code: pickerSetupJs(picker.targets) }]).catch(() => {}); };
    wc.on('dom-ready', install);
    this.cleanup.push(() => {
      ipcMain.off('ariadne:pick', onPick);
      ipcMain.off('ariadne:done', onDone);
    });
  }

  /** 마지막으로 받은 메인 문서의 원래 바이트. 못 얻었으면 비어 있다 → 인코딩 판정을 건너뛴다. */
  docBytes(): Buffer {
    return this.raw;
  }

  url(): string {
    return this.win.webContents.getURL();
  }

  closed(): boolean {
    return this.win.isDestroyed();
  }

  async goto(url: string, timeout: number): Promise<void> {
    const wc = this.win.webContents;
    let off = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      const ok = () => { off(); resolve(); };
      const fail = (_e: unknown, code: number, desc: string, failedUrl: string, isMain: boolean) => {
        if (isMain && code !== -3) { off(); reject(new Error(`${desc} (${code}) ${failedUrl}`)); }   // -3 은 다른 이동이 앞지른 것
      };
      off = () => { wc.off('dom-ready', ok); wc.off('did-fail-load', fail); };
      wc.on('dom-ready', ok);
      wc.on('did-fail-load', fail);
    });
    wc.loadURL(url).catch(() => {});   // 실패는 did-fail-load 가 알린다
    await withTimeout(ready, timeout, `${timeout}ms 안에 페이지를 열지 못했다: ${url}`).finally(off);
  }

  eval<T = unknown>(code: string): Promise<T> {
    return this.win.webContents.executeJavaScript(code);
  }

  /** 페이지가 이동 중이면 평가가 끝나지 않거나 실패한다 → 정해진 시간 안의 결과만 쓴다. */
  async evalSoon<T>(code: string, ms = 1000): Promise<T | undefined> {
    try {
      return await withTimeout(this.eval<T>(code), ms, 'eval timeout');
    } catch {
      return undefined;
    }
  }

  async waitFor(selector: string, timeout: number, state: 'visible' | 'attached' = 'visible'): Promise<void> {
    const sel = JSON.stringify(selector);
    const check = state === 'attached'
      ? `!!document.querySelector(${sel})`
      : `(() => { const e = document.querySelector(${sel}); if (!e) return false;
          const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evalSoon<boolean>(check)) return;
      await sleep(100);
    }
    throw new Error(`${timeout}ms 동안 셀렉터 ${sel} 에 걸리는 요소가 없다.`);
  }

  /** 신뢰된 마우스 이벤트로 누른다. JS click() 은 isTrusted 를 보는 사이트에서 무시된다. */
  async click(selector: string): Promise<void> {
    const at = await this.eval<{ x: number; y: number } | null>(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!at) throw new Error(`셀렉터 ${JSON.stringify(selector)} 에 걸리는 요소가 없다.`);
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }

  /** 페이지와 같은 세션으로 받는다 → 쿠키와 referer 가 실려 핫링크를 막는 사이트에서도 통한다. */
  fetch(url: string): Promise<Response> {
    return this.win.webContents.session.fetch(url, { headers: { Referer: this.url() } });
  }

  childFrames(): WebFrameMain[] {
    return this.win.webContents.mainFrame.framesInSubtree.filter(f => f !== this.win.webContents.mainFrame);
  }

  async waitForChildFrame(timeout: number): Promise<WebFrameMain> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const [f] = this.childFrames();
      if (f) return f;
      await sleep(50);
    }
    throw new Error('iframe 이 없다');
  }

  async whenClosed(): Promise<void> {
    if (this.closed()) return;
    await new Promise<void>(resolve => this.win.once('closed', () => resolve()));
  }

  close(): void {
    this.cleanup.forEach(f => f());
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

/** 받은 본문은 이미 압축이 풀려 있다 → 압축·길이 헤더를 빼고 charset 만 바꿔 넘긴다. */
function forced(ev: any, raw: Buffer, charset: string) {
  let mime = 'text/html';
  const headers: { name: string; value: string }[] = [];
  for (const h of ev.responseHeaders ?? []) {
    const name = h.name.toLowerCase();
    if (name === 'content-type') mime = h.value.split(';')[0].trim() || mime;
    else if (name !== 'content-encoding' && name !== 'content-length') headers.push(h);
  }
  headers.push({ name: 'Content-Type', value: `${mime}; charset=${charset}` });
  return { requestId: ev.requestId, responseCode: ev.responseStatusCode, responseHeaders: headers, body: raw.toString('base64') };
}
