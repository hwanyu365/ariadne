import { BrowserWindow, ipcMain, type IpcMainEvent, type WebFrameMain } from 'electron';
import path from 'node:path';
import { checkCharset } from '../core/charset';
import { CdpPage, type OpenOptions, type PickerHooks, referrerFor, type Send, withTimeout } from '../core/page';
import { pickerSetupJs } from '../core/picker';

export interface PageOptions extends OpenOptions {
  /** 테스트에서 CDP 호출을 가로채는 자리. */
  cdp?: (send: Send) => Send;
}

// preload 가 선택기 통로를 여는 격리 world 다. 같은 world 에 선택기를 넣어야 그 통로를 쓴다.
const PRELOAD_WORLD = 999;
let runs = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 수집 대상 페이지 하나. Playwright 의 page 에 해당하는 것을 BrowserWindow 와 CDP 로 만든다. */
export class Page extends CdpPage {
  private fetchPolicy: string | null = null;
  private cleanup: (() => void)[] = [];

  private constructor(readonly win: BrowserWindow, send: Send) {
    super(send);
  }

  /** charset 을 주면 메인 문서 응답의 charset 을 바꿔 브라우저의 인코딩 추정을 건너뛴다. */
  static async open(opts: PageOptions = {}): Promise<Page> {
    // 이름이 응답 헤더에 그대로 들어간다 → 어느 호출자를 거쳐 와도 여기서 한 번 더 거른다.
    const charset = checkCharset(opts.charset ?? '');
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
    // 수집은 원래 탭만 읽는다 → 새 창은 만들지 않는다.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // 수집에 권한·다운로드는 필요 없다 → 원격 페이지가 알림·위치·미디어를 얻거나 파일을 내려받지 못하게 한다.
    const ses = win.webContents.session;
    ses.setPermissionRequestHandler((_wc, _perm, grant) => grant(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', e => e.preventDefault());
    try {
      // CDP 는 렌더러가 생긴 뒤에야 프레임 트리를 준다.
      await win.loadURL('about:blank');
      const dbg = win.webContents.debugger;
      dbg.attach('1.3');
      const raw: Send = (method, params) => dbg.sendCommand(method, params);
      const page = new Page(win, opts.cdp ? opts.cdp(raw) : raw);
      // 브라우저는 리디렉션마다 Referer 를 다시 정한다 → 첫 값을 그대로 다른 서버로 넘기지 않게 단계마다 정한다.
      // 창이 보낸 요청이 아니면 수집이 보낸 것이다. 수집은 한 번에 한 장씩 받아 정책 하나만 들고 있으면 된다.
      ses.webRequest.onBeforeSendHeaders((d, cb) => {
        if (d.webContentsId !== undefined || page.fetchPolicy === null) return cb({});
        const headers = Object.fromEntries(Object.entries(d.requestHeaders).filter(([k]) => k.toLowerCase() !== 'referer'));
        const referer = referrerFor(page.url(), d.url, page.fetchPolicy);
        cb({ requestHeaders: referer ? { ...headers, Referer: referer } : headers });
      });
      await page.interceptDocuments(charset);
      if (opts.picker) page.installPicker(opts.picker);
      return page;
    } catch (e) {
      win.destroy();                    // 호출자는 Page 를 받지 못해 닫을 수 없다
      throw e;
    }
  }

  /** 메인 프레임 문서의 원래 바이트를 남기고, charset 을 주면 그 값으로 바꿔 넘긴다. */
  private async interceptDocuments(charset: string | null) {
    // 인코딩이 다른 iframe 까지 덮으면 그쪽이 깨진다 → 메인 프레임 문서만 다룬다.
    const main = (await this.send('Page.getFrameTree')).frameTree.frame.id;
    const onMessage = (_e: unknown, method: string, ev: any) => {
      if (method === 'Fetch.requestPaused') void this.onRequestPaused(ev, main, charset);
    };
    this.win.webContents.debugger.on('message', onMessage);
    await this.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
  }

  private installPicker(picker: PickerHooks) {
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
    await withTimeout(ready, timeout, `${timeout}ms 안에 페이지를 열지 못했습니다: ${url}`).finally(off);
  }

  /**
   * 페이지와 같은 세션으로 받는다 → 쿠키와 referer 가 실려 핫링크를 막는 사이트에서도 통한다.
   * policy 는 그 이미지에 걸린 Referer 정책이다.
   */
  async fetch(url: string, timeout: number, signal?: AbortSignal, policy = ''): Promise<Response> {
    // 응답이 멈춘 이미지 한 장이 수집과 중지를 함께 막지 않게 한다.
    const limit = AbortSignal.timeout(timeout);
    if (this.fetchPolicy !== null) throw new Error('이미지를 동시에 받지 않습니다. 앞의 요청이 끝난 뒤 받으세요.');
    this.fetchPolicy = policy;
    try {
      // Referer 는 요청 단계마다 훅이 정한다 → Chromium 이 기본 정책으로 다시 판정해 막지 않게 한다.
      return await this.win.webContents.session.fetch(url, { referrerPolicy: 'unsafe-url', signal: signal ? AbortSignal.any([limit, signal]) : limit });
    } finally {
      this.fetchPolicy = null;
    }
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
    throw new Error('iframe 이 없습니다');
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
