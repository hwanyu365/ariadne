import { BrowserWindow, dialog, ipcMain, Notification, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pick, probe, scrape } from './engine';
import { cleanSettings, DEFAULTS, HINT, InputError, loadSettings, logLevel, parseInputs, pickUpdate, progress, remember, saveSettings, siteFor, windowHeight, type Raw } from './form';

export type Kind = 'scrape' | 'probe' | 'pick';
export interface StartRequest { kind: Kind; values: Raw; mode: 'text' | 'image'; headful: boolean; merge?: boolean }

const ROOT = path.join(__dirname, '..', '..');
const firstLine = (e: unknown) => String(e instanceof Error ? e.message : e).split('\n')[0];

/** 화면과 엔진을 잇는다. 실행은 한 번에 하나다 → 같은 창이 두 수집을 섞어 쓰지 않는다. */
export function registerIpc(opts: { settingsPath: string; defaultPrefix: string; notify?: (title: string, body: string) => void }) {
  let running: AbortController | null = null;
  const notify = opts.notify ?? ((title: string, body: string) => { if (Notification.isSupported()) new Notification({ title, body }).show(); });
  const keep = (update: (s: ReturnType<typeof loadSettings>) => ReturnType<typeof loadSettings>) => {
    try {
      saveSettings(opts.settingsPath, update(loadSettings(opts.settingsPath)));
    } catch {
      // 설정을 못 남겨도 수집은 계속돼야 한다
    }
  };

  ipcMain.handle('app:init', () => ({
    settings: { ...DEFAULTS, prefix: opts.defaultPrefix, mode: 'text', headful: false, ...loadSettings(opts.settingsPath) },
    hint: HINT,
    mac: process.platform === 'darwin',
  }));

  // 화면은 입력값만 보낸다 → 최근 URL·사이트 설정은 파일에 있던 것을 그대로 둔다.
  ipcMain.on('settings:save', (_e, values: unknown) => keep(s => ({ ...cleanSettings(values), recent: s.recent, sites: s.sites })));
  ipcMain.handle('site:get', (_e, url: unknown) => typeof url === 'string' ? siteFor(loadSettings(opts.settingsPath), url) : null);
  ipcMain.handle('recent:get', () => loadSettings(opts.settingsPath).recent ?? []);

  ipcMain.handle('folder:pick', async e => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const got = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }));
    return got.canceled || !got.filePaths[0] ? null : path.join(got.filePaths[0], 'page');
  });

  ipcMain.handle('folder:open', async (_e, prefix: string) => {
    const dir = path.dirname(path.resolve(prefix.trim() || opts.defaultPrefix));
    if (!fs.existsSync(dir)) return `아직 폴더가 없습니다: ${dir}`;
    return (await shell.openPath(dir)) || null;
  });

  ipcMain.on('run:stop', () => running?.abort());

  ipcMain.handle('run:start', (e, req: StartRequest) => {
    if (running) return { error: '이미 실행 중입니다.', field: null };
    let args: ReturnType<typeof parseInputs>;
    try {
      args = parseInputs(req.values, req.kind !== 'scrape');
    } catch (err) {
      return { error: firstLine(err), field: err instanceof InputError ? err.field : null };
    }
    if (req.kind === 'scrape') keep(s => ({ ...s, ...remember(s, req.values, req.mode) }));
    const wc = e.sender;
    const send = (channel: string, data?: unknown) => { if (!wc.isDestroyed()) wc.send(channel, data); };
    let pages = 0, failed = false;
    const log = (text: string) => {
      const level = logLevel(text), got = progress(text);
      if (level === 'error') failed = true;
      if (got) pages = got.pages;
      send('run:log', { text, level, progress: got });
    };
    const ctl = new AbortController();
    running = ctl;
    // 창이 사라지면 결과를 받을 곳도 없다 → 숨은 수집과 선택기 창을 남기지 않는다.
    wc.once('destroyed', () => ctl.abort());
    void run(req, args, ctl.signal, log, u => send('run:pick', u)).finally(() => {
      running = null;
      send('run:done', { stopped: ctl.signal.aborted });
      // 창을 보고 있으면 화면이 이미 알린다. probe·선택기는 사용자가 지켜보는 작업이다.
      const win = wc.isDestroyed() ? null : BrowserWindow.fromWebContents(wc);
      if (req.kind === 'scrape' && win && !win.isFocused())
        notify(`ariadne 수집 ${failed ? '실패' : ctl.signal.aborted ? '중지' : '완료'}`, `${pages}페이지를 받았습니다.`);
    });
    return { error: null, field: null };
  });
}

async function run(req: StartRequest, { text, nums }: ReturnType<typeof parseInputs>, signal: AbortSignal,
  log: (text: string) => void, onPick: (u: NonNullable<ReturnType<typeof pickUpdate>>) => void) {
  try {
    if (req.kind === 'scrape') {
      const n = await scrape(text.url, text.sel, text.next, text.prefix, {
        maxPages: nums.max, timeout: nums.timeout, headful: req.headful, delay: nums.delay, digits: nums.digits,
        start: nums.start, titleSel: text.title || null, mode: req.mode, onLog: log, signal, charset: text.charset,
        exclude: req.mode === 'text' ? text.exclude || null : null, merge: req.mode === 'text' && req.merge === true,
      });
      log(`완료: ${n}개 페이지`);
    } else if (req.kind === 'probe') {
      log('probe 중... 브라우저 창을 띄웠으면 확인한 뒤 [중지] 를 누르면 닫힙니다.');
      await probe(text.url, text.sel || null, text.next || null, {
        timeout: nums.timeout, headful: req.headful, titleSel: text.title || null, delay: nums.delay, onLog: log, charset: text.charset,
        pause: () => new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
      });
    } else {
      await pick(text.url, payload => {
        const u = pickUpdate(payload);
        if (!u) return;
        onPick(u);
        log(u.line);
      }, { timeout: nums.timeout, targets: req.mode === 'image' ? ['이미지', 'next', '제목'] : ['본문', 'next', '제목', '제외'], onLog: log, signal, charset: text.charset });
    }
  } catch (err) {
    // 엔진에서 죽으면 창이 멈춘 것처럼 보인다 → 사유를 로그로 돌려주고 버튼을 되살린다.
    log(`실패: ${firstLine(err)}`);
  }
}

export function createMainWindow(opts: { show?: boolean } = {}): BrowserWindow {
  const height = windowHeight(screen.getPrimaryDisplay().workAreaSize.height);
  const win = new BrowserWindow({
    width: 800,
    height,
    minWidth: 680,
    minHeight: Math.min(700, height),
    show: opts.show ?? true,
    title: 'ariadne',
    icon: process.platform === 'darwin' ? undefined : path.join(ROOT, 'assets', process.platform === 'win32' ? 'ariadne.ico' : 'ariadne.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'app.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // 화면은 앱이 가진 파일만 연다 → 링크·새 창으로 다른 문서가 이 권한을 얻지 못하게 한다.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  void win.loadFile(path.join(ROOT, 'static', 'index.html'));
  return win;
}
