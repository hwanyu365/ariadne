import { BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pick, probe, scrape } from './engine';
import { cleanSettings, DEFAULTS, HINT, loadSettings, logLevel, parseInputs, pickUpdate, progress, saveSettings, windowHeight, type Raw } from './form';

export type Kind = 'scrape' | 'probe' | 'pick';
export interface StartRequest { kind: Kind; values: Raw; mode: 'text' | 'image'; headful: boolean }

const ROOT = path.join(__dirname, '..', '..');
const firstLine = (e: unknown) => String(e instanceof Error ? e.message : e).split('\n')[0];

/** 화면과 엔진을 잇는다. 실행은 한 번에 하나다 → 같은 창이 두 수집을 섞어 쓰지 않는다. */
export function registerIpc(opts: { settingsPath: string; defaultPrefix: string }) {
  let running: AbortController | null = null;

  ipcMain.handle('app:init', () => ({
    settings: { ...DEFAULTS, prefix: opts.defaultPrefix, mode: 'text', headful: false, ...loadSettings(opts.settingsPath) },
    hint: HINT,
    mac: process.platform === 'darwin',
  }));

  ipcMain.on('settings:save', (_e, values: unknown) => {
    try {
      saveSettings(opts.settingsPath, cleanSettings(values));
    } catch {
      // 설정을 못 남겨도 수집은 계속돼야 한다
    }
  });

  ipcMain.handle('folder:pick', async e => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const got = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }));
    return got.canceled || !got.filePaths[0] ? null : path.join(got.filePaths[0], 'page');
  });

  ipcMain.handle('folder:open', async (_e, prefix: string) => {
    const dir = path.dirname(path.resolve(prefix.trim() || opts.defaultPrefix));
    if (!fs.existsSync(dir)) return `아직 폴더가 없다: ${dir}`;
    return (await shell.openPath(dir)) || null;
  });

  ipcMain.on('run:stop', () => running?.abort());

  ipcMain.handle('run:start', (e, req: StartRequest) => {
    if (running) return { error: '이미 실행 중이다.' };
    let args: ReturnType<typeof parseInputs>;
    try {
      args = parseInputs(req.values, req.kind !== 'scrape');
    } catch (err) {
      return { error: firstLine(err) };
    }
    const wc = e.sender;
    const send = (channel: string, data?: unknown) => { if (!wc.isDestroyed()) wc.send(channel, data); };
    const log = (text: string) => send('run:log', { text, level: logLevel(text), progress: progress(text) });
    const ctl = new AbortController();
    running = ctl;
    void run(req, args, ctl.signal, log, u => send('run:pick', u)).finally(() => {
      running = null;
      send('run:done', { stopped: ctl.signal.aborted });
    });
    return { error: null };
  });
}

async function run(req: StartRequest, { text, nums }: ReturnType<typeof parseInputs>, signal: AbortSignal,
  log: (text: string) => void, onPick: (u: NonNullable<ReturnType<typeof pickUpdate>>) => void) {
  try {
    if (req.kind === 'scrape') {
      const n = await scrape(text.url, text.sel, text.next, text.prefix, {
        maxPages: nums.max, timeout: nums.timeout, headful: req.headful, delay: nums.delay, digits: nums.digits,
        start: nums.start, titleSel: text.title || null, mode: req.mode, onLog: log, signal, charset: text.charset,
      });
      log(`완료: ${n}개 페이지`);
    } else if (req.kind === 'probe') {
      log('probe 중... 브라우저 창을 띄웠으면 확인한 뒤 [중지] 를 누르면 닫힌다.');
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
      }, { timeout: nums.timeout, targets: [req.mode === 'image' ? '이미지' : '본문', 'next', '제목'], onLog: log, signal, charset: text.charset });
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
