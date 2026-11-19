import './panel.js';
import { cleanSettings, DEFAULTS, HINT, InputError, logLevel, parseInputs, progress, remember, siteFor, type Mode, type Raw, type Settings } from '../core/form.js';
import type { RunResult } from './api.js';
import { loadFolder, saveFolder } from './folder.js';
import { appendLog, type Level } from './view.js';

type Kind = 'scrape' | 'probe' | 'pick';
type Permissioned = FileSystemDirectoryHandle & {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
};

const api = globalThis.ariadne;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const inputs = [...document.querySelectorAll<HTMLInputElement>('input[name]:not([type=checkbox])')];
const merge = $<HTMLInputElement>('[name="merge"]');
const url = $<HTMLInputElement>('[name="url"]');
const prefix = $<HTMLInputElement>('[name="prefix"]');
const log = $<HTMLPreElement>('#log');
const st = { state: $('#st-state'), pages: $('#st-pages'), file: $('#st-file'), time: $('#st-time') };
const bar = $<HTMLProgressElement>('#progress');
const result = { box: $('#result'), text: $('#result-text') };
const LABEL: Record<Kind, string> = { scrape: '수집 중', probe: 'probe 중', pick: '요소 선택 중' };
const STORE = 'settings';
let mode: Mode = 'text';
let running = false, failed = false, stopped = false, started = 0, timer = 0, saveTimer = 0;
let kind: Kind = 'scrape', pages = 0, reason = '', host = '';
let root: FileSystemDirectoryHandle | null = null;
let windowId: number | undefined, selfTab: number | undefined;

const values = () => Object.fromEntries(inputs.map(i => [i.name, i.value])) as Raw;
const hostOf = (u: string) => URL.parse(u.trim())?.host ?? '';

async function stored(): Promise<Settings> {
  try {
    return cleanSettings((await chrome.storage.local.get(STORE))[STORE]);
  } catch {
    return {};
  }
}

// 읽고 고쳐 쓰는 저장이 겹치면 늦게 쓴 쪽이 앞의 변경을 지운다 → 한 줄로 세운다.
let saving = Promise.resolve();
function keep(update: (s: Settings) => Settings): Promise<void> {
  saving = saving.then(async () => {
    try {
      await chrome.storage.local.set({ [STORE]: update(await stored()) });
    } catch {
      // 설정을 못 남겨도 수집은 계속돼야 한다
    }
  });
  return saving;
}

// 화면은 입력값만 바꾼다 → 최근 URL·사이트 설정은 수집을 시작할 때만 바뀐다.
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void keep(s => ({ ...cleanSettings({ ...values(), mode, merge: merge.checked }), recent: s.recent, sites: s.sites })), 300);
}

function fillRecent(urls: string[]) {
  $('#recent').replaceChildren(...urls.map(u => Object.assign(document.createElement('option'), { value: u })));
}

function setMode(m: Mode) {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#hint').textContent = HINT[m];
  // 제목 헤더·제외·합치기는 텍스트 파일에만 쓴다.
  for (const name of ['title', 'exclude', 'merge']) $<HTMLInputElement>(`[name="${name}"]`).disabled = m === 'image';
}

function showFolder() {
  $('#dir-name').textContent = root ? root.name : '선택 안 됨';
}

function setState(text: string, cls = '') {
  st.state.textContent = `● ${text}`;
  st.state.className = cls || 'muted';
}

function elapsed() {
  const s = Math.floor((Date.now() - started) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function showResult(text: string, cls: string) {
  result.text.textContent = text;
  result.box.className = `result ${cls}`;
  result.box.hidden = false;
  // 숨겨져 있다 나타난 영역은 낭독되지 않을 수 있다 → 항상 렌더링된 알림 영역으로 전한다.
  $('#announce').textContent = text;
}

function markInvalid(field: string | null) {
  const el = field ? document.getElementById(field) ?? document.querySelector<HTMLElement>(`[name="${field}"]`) : null;
  if (!el) return;
  el.setAttribute('aria-invalid', 'true');
  const fold = el.closest('details');
  if (fold) fold.open = true;
  el.focus();
}

function setRunning(on: boolean) {
  running = on;
  document.querySelectorAll<HTMLButtonElement>('.busy').forEach(b => { b.disabled = on; });
  $<HTMLButtonElement>('#stop').disabled = !on;
  clearInterval(timer);
  if (on) timer = window.setInterval(() => { st.time.textContent = elapsed(); }, 1000);
  st.time.textContent = elapsed();
}

function onLine(text: string) {
  const level: Level = logLevel(text);
  if (level === 'error') failed = true;
  const s = text.trimStart();
  if (s.startsWith('중단:') || s.startsWith('실패:')) reason = s.slice(3).trim();
  const got = progress(text);
  if (got) {
    pages = got.pages;
    st.pages.textContent = `${got.pages}페이지`;
    st.file.textContent = got.file;
    if (bar.hasAttribute('value')) bar.value = got.pages;
  }
  appendLog(log, text, level);
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab && tab.id !== selfTab ? tab : null;
}

// 다른 사이트로 바꿀 때만 채운다 → 같은 사이트에서 고쳐 쓰던 셀렉터를 덮지 않는다.
async function fillSite() {
  const next = hostOf(url.value);
  if (!next || next === host) return;
  host = next;
  const site = siteFor(await stored(), url.value);
  if (!site || hostOf(url.value) !== next) return;
  for (const i of inputs) if (Object.hasOwn(site, i.name)) i.value = site[i.name as keyof typeof site];
  setMode(site.mode);
  save();
}

/** 대기 중에는 주소 칸이 지금 탭을 따라간다. 실행 중에는 엔진이 탭을 옮기므로 따라가지 않는다. */
function follow(tab: chrome.tabs.Tab | null) {
  // 확장 자신의 페이지는 주소가 보이지만 받을 대상이 아니다. 사이트 접근 권한 밖의 탭은 주소가 보이지 않는다.
  if (running || !tab?.url || !/^https?:/i.test(tab.url)) return;
  url.value = tab.url;
  url.removeAttribute('aria-invalid');
  save();
  void fillSite();
}

/** 시작 전에 필요한 것을 모은다. 거부되면 사유와 표시할 칸을 던진다. */
async function prepare(k: Kind) {
  const raw = values();
  const args = parseInputs(raw, k !== 'scrape');
  const tab = await activeTab();
  if (tab?.id === undefined) throw new InputError('수집할 탭이 없습니다. 받을 페이지를 이 창의 탭에 띄워 주세요.', 'url');
  if (k !== 'scrape') return { args, tabId: tab.id, root: null };
  if (!root) throw new InputError('저장할 폴더를 골라 주세요.', 'pick-dir');
  const h = root as Permissioned;
  // 권한 요청은 사용자 동작 안에서만 뜬다 → 시작 버튼을 누른 이 자리에서 묻는다.
  if (await h.queryPermission({ mode: 'readwrite' }) !== 'granted' && await h.requestPermission({ mode: 'readwrite' }) !== 'granted')
    throw new InputError('폴더에 쓸 권한이 없습니다. [폴더 선택] 으로 다시 골라 주세요.', 'pick-dir');
  await keep(s => ({ ...s, ...remember(s, raw, mode) }));
  return { args, tabId: tab.id, root };
}

async function start(k: Kind) {
  if (running) return;
  log.textContent = '';
  failed = false;
  stopped = false;
  kind = k;
  pages = 0;
  reason = '';
  started = Date.now();
  $('#guide').hidden = true;
  // 실행 중에는 로그가 볼 거리다 → 고급 옵션이 로그 자리를 차지하지 않게 접는다.
  $<HTMLDetailsElement>('.advanced').open = false;
  result.box.hidden = true;
  document.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid'));
  const max = Number.parseInt(values().max ?? '', 10);
  // 끝을 모르면 비율을 만들 수 없다 → value 를 비워 진행 중임만 보인다.
  if (k === 'scrape' && max > 0) {
    bar.max = max;
    bar.value = 0;
  } else {
    bar.removeAttribute('value');
  }
  bar.hidden = false;
  st.pages.textContent = '';
  st.file.textContent = '';
  setState(LABEL[k], 'running');
  setRunning(true);
  let ready: Awaited<ReturnType<typeof prepare>>;
  try {
    ready = await prepare(k);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setRunning(false);
    bar.hidden = true;
    appendLog(log, `실패: ${msg}`, 'error');
    setState('입력 확인', 'check');
    showResult(`입력 확인 · ${msg}`, 'check');
    markInvalid(e instanceof InputError ? e.field : null);
    return;
  }
  // 준비하는 동안에는 멈출 실행이 아직 없다 → 그 사이 누른 중지는 여기서 반영한다.
  if (stopped) {
    finish({ pages: 0, error: null, logs: [] }, ready.root, ready.args.text.prefix);
    return;
  }
  const { args: { text, nums }, tabId } = ready;
  const exclude = mode === 'text' ? text.exclude || null : null;
  let got: RunResult;
  if (k === 'scrape') {
    got = await api.run({
      tabId, url: text.url, sel: text.sel, nextSel: text.next, prefix: text.prefix,
      opts: {
        maxPages: nums.max, timeout: nums.timeout, delay: nums.delay, digits: nums.digits, start: nums.start,
        titleSel: text.title || null, mode, charset: text.charset, exclude, merge: mode === 'text' && merge.checked,
      },
    }, ready.root!);
    if (!got.error) onLine(`완료: ${got.pages}개 페이지`);
  } else if (k === 'probe') {
    got = await api.probe({ tabId, url: text.url, sel: text.sel || null, nextSel: text.next || null, opts: { timeout: nums.timeout, delay: nums.delay, titleSel: text.title || null, charset: text.charset, exclude } });
  } else {
    got = await api.pick({ tabId, url: text.url, opts: { timeout: nums.timeout, mode, charset: text.charset } });
  }
  finish(got, ready.root, text.prefix);
}

function finish(got: RunResult, folder: FileSystemDirectoryHandle | null, at: string) {
  if (got.error && !failed) onLine(`실패: ${got.error}`);
  setRunning(false);
  if (kind === 'scrape') void stored().then(s => fillRecent(s.recent ?? []));
  bar.hidden = true;
  const files = kind === 'scrape' && pages > 0;
  const n = kind === 'scrape' ? ` · ${pages}페이지` : '';
  const where = files && folder ? ` · 저장: ${folder.name}/${at}` : '';
  const outcome = failed ? '실패' : stopped ? '중지' : '완료';
  if (failed) {
    setState('실패', 'failed');
    showResult(`실패${n} · ${elapsed()}${reason ? ` · ${reason}` : ''}${where}`, 'failed');
  } else if (stopped) {
    setState('중지됨');
    showResult(`중지됨${n} · ${elapsed()}${files ? ' · 그때까지 받은 파일은 남아 있습니다.' : ''}${where}`, 'stopped');
  } else {
    setState('완료');
    showResult(`완료${n} · ${elapsed()}${reason ? ` · ${reason}` : ''}${where}`, 'ok');
  }
  // 패널을 보고 있으면 화면이 이미 알린다. probe·선택기는 사용자가 지켜보는 작업이다.
  if (kind === 'scrape' && !document.hasFocus())
    void chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icon.png'), title: `ariadne 수집 ${outcome}`, message: `${pages}페이지를 받았습니다.` }).catch(() => {});
}

function stop() {
  if (!running) return;
  stopped = true;
  api.stop();
}

api.on('log', line => { if (running) onLine(line); });
api.on('pick', ({ key, sel }) => {
  if (!running || kind !== 'pick') return;
  const input = $<HTMLInputElement>(`[name="${key}"]`);
  if (!input) return;
  input.value = sel;
  save();
});

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.addEventListener('click', () => { setMode(b.dataset.mode as Mode); save(); }));
inputs.forEach(i => i.addEventListener('input', () => { i.removeAttribute('aria-invalid'); save(); }));
merge.addEventListener('change', save);
url.addEventListener('change', () => void fillSite());
$('#run').addEventListener('click', () => void start('scrape'));
$('#probe').addEventListener('click', () => void start('probe'));
$('#pick').addEventListener('click', () => void start('pick'));
$('#stop').addEventListener('click', stop);
$('#pick-dir').addEventListener('click', async () => {
  let got: FileSystemDirectoryHandle;
  try {
    got = await (window as unknown as { showDirectoryPicker(o: { mode: 'readwrite' }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return;
  }
  root = got;
  $('#pick-dir').removeAttribute('aria-invalid');
  showFolder();
  await saveFolder(got).catch(() => {});
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void start('scrape');
  } else if (e.key === 'Escape') {
    stop();
  }
});

chrome.tabs.onActivated.addListener(info => {
  if (info.windowId === windowId) chrome.tabs.get(info.tabId).then(t => follow(t.id === selfTab ? null : t), () => {});
});
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url && tab.active && tab.windowId === windowId && id !== selfTab) follow(tab);
});

void (async () => {
  const s = await stored();
  const init: Raw = { ...DEFAULTS, prefix: 'page', ...s };
  for (const i of inputs) i.value = init[i.name as keyof Raw] ?? '';
  merge.checked = s.merge === true;
  host = hostOf(url.value);
  fillRecent(s.recent ?? []);
  setMode(s.mode === 'image' ? 'image' : 'text');
  if (/mac/i.test(navigator.platform)) $('#run-key').textContent = '⌘↵';
  root = await loadFolder();
  showFolder();
  windowId = (await chrome.windows.getCurrent()).id;
  selfTab = (await chrome.tabs.getCurrent())?.id;
  follow(await activeTab());
  document.body.dataset.ready = '1';
})();
