// preload 가 열어 준 통로만 쓴다. 입력 검증과 실행은 메인 프로세스가 한다.
type Mode = 'text' | 'image';
type Kind = 'scrape' | 'probe' | 'pick';
type Level = 'error' | 'warn' | 'info' | 'ok' | null;

interface Api {
  init(): Promise<{ settings: Record<string, string | boolean>; hint: Record<Mode, string>; mac: boolean }>;
  save(values: Record<string, string | boolean>): void;
  start(req: { kind: Kind; values: Record<string, string>; mode: Mode; headful: boolean }): Promise<{ error: string | null; field: string | null }>;
  stop(): void;
  pickFolder(): Promise<string | null>;
  openFolder(prefix: string): Promise<string | null>;
  onLog(cb: (d: { text: string; level: Level; progress: { pages: number; file: string } | null }) => void): void;
  onPick(cb: (d: { key: string; sel: string }) => void): void;
  onDone(cb: (d: { stopped: boolean }) => void): void;
}

(() => {
  const api = (window as unknown as { ariadne: Api }).ariadne;
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[name]:not([type=checkbox])')];
  const headful = $<HTMLInputElement>('[name="headful"]');
  const log = $<HTMLPreElement>('#log');
  const st = { state: $('#st-state'), pages: $('#st-pages'), file: $('#st-file'), time: $('#st-time') };
  const bar = $<HTMLProgressElement>('#progress');
  const result = { box: $('#result'), text: $('#result-text'), open: $<HTMLButtonElement>('#result-open') };
  const MAX_LINES = 2000;
  const LABEL: Record<Kind, string> = { scrape: '수집 중', probe: 'probe 중', pick: '요소 선택 중' };
  let mode: Mode = 'text';
  let hint: Record<Mode, string> = { text: '', image: '' };
  let running = false, failed = false, started = 0, timer = 0, saveTimer = 0;
  let kind: Kind = 'scrape', pages = 0, reason = '';

  const values = () => Object.fromEntries(inputs.map(i => [i.name, i.value]));
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => api.save({ ...values(), mode, headful: headful.checked }), 300);
  };

  function setMode(m: Mode) {
    mode = m;
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('#hint').textContent = hint[m];
    // 제목 헤더는 텍스트 파일에만 붙는다.
    $<HTMLInputElement>('[name="title"]').disabled = m === 'image';
  }

  function setState(text: string, cls = '') {
    st.state.textContent = `● ${text}`;
    st.state.className = cls || 'muted';
  }

  function write(text: string, level: Level = null) {
    const line = document.createElement('span');
    if (level) line.className = level;
    line.textContent = text;      // 페이지가 정한 셀렉터·텍스트가 섞여 온다 → 마크업으로 해석하지 않는다
    log.append(line);
    while (log.childElementCount > MAX_LINES) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  function elapsed() {
    const s = Math.floor((Date.now() - started) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function tick() {
    st.time.textContent = elapsed();
  }

  function showResult(text: string, cls: string, folder = false) {
    result.text.textContent = text;
    result.box.className = `result ${cls}`;
    result.open.hidden = !folder;
    result.box.hidden = false;
  }

  function markInvalid(field: string | null) {
    const input = field ? document.querySelector<HTMLInputElement>(`[name="${field}"]`) : null;
    if (!input) return;
    input.setAttribute('aria-invalid', 'true');
    const fold = input.closest('details');
    if (fold) fold.open = true;
    input.focus();
  }

  function setRunning(on: boolean) {
    running = on;
    document.querySelectorAll<HTMLButtonElement>('.busy').forEach(b => { b.disabled = on; });
    $<HTMLButtonElement>('#stop').disabled = !on;
    clearInterval(timer);
    if (on) timer = window.setInterval(tick, 1000);
    tick();
  }

  async function start(k: Kind) {
    if (running) return;
    // 엔진이 곧바로 실패하면 로그·종료 알림이 시작 응답보다 먼저 온다 → 화면을 먼저 실행 상태로 바꾸고, 거부될 때만 되돌린다.
    log.textContent = '';
    failed = false;
    kind = k;
    pages = 0;
    reason = '';
    started = Date.now();
    $('#guide').hidden = true;
    // 실행 중에는 로그가 볼 거리다 → 고급 옵션이 로그 자리를 차지하지 않게 접는다.
    $<HTMLDetailsElement>('.advanced').open = false;
    result.box.hidden = true;
    inputs.forEach(i => i.removeAttribute('aria-invalid'));
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
    const got = await api.start({ kind: k, values: values(), mode, headful: headful.checked });
    if (got.error) {
      setRunning(false);
      bar.hidden = true;
      write(`실패: ${got.error}`, 'error');
      setState('입력 확인', 'check');
      showResult(`입력 확인 · ${got.error}`, 'check');
      markInvalid(got.field);
    }
  }

  api.onLog(({ text, level, progress }) => {
    if (level === 'error') failed = true;
    const s = text.trimStart();
    if (s.startsWith('중단:') || s.startsWith('실패:')) reason = s.slice(3).trim();
    if (progress) {
      pages = progress.pages;
      st.pages.textContent = `${progress.pages}페이지`;
      st.file.textContent = progress.file;
      if (bar.hasAttribute('value')) bar.value = progress.pages;
    }
    write(text, level);
  });

  api.onPick(({ key, sel }) => {
    const input = $<HTMLInputElement>(`[name="${key}"]`);
    if (!input) return;
    input.value = sel;
    save();
  });

  api.onDone(({ stopped }) => {
    setRunning(false);
    bar.hidden = true;
    const files = kind === 'scrape' && pages > 0;
    const got = kind === 'scrape' ? ` · ${pages}페이지` : '';
    if (failed) {
      setState('실패', 'failed');
      showResult(`실패${got} · ${elapsed()}${reason ? ` · ${reason}` : ''}`, 'failed', files);
    } else if (stopped) {
      setState('중지됨');
      showResult(`중지됨${got} · ${elapsed()}${files ? ' · 그때까지 받은 파일은 남아 있습니다.' : ''}`, 'stopped', files);
    } else {
      setState('완료');
      showResult(`완료${got} · ${elapsed()}${reason ? ` · ${reason}` : ''}`, 'ok', files);
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.addEventListener('click', () => { setMode(b.dataset.mode as Mode); save(); }));
  inputs.forEach(i => i.addEventListener('input', () => { i.removeAttribute('aria-invalid'); save(); }));
  headful.addEventListener('change', save);
  $('#run').addEventListener('click', () => start('scrape'));
  $('#probe').addEventListener('click', () => start('probe'));
  $('#pick').addEventListener('click', () => start('pick'));
  $('#stop').addEventListener('click', () => api.stop());
  $('#pick-dir').addEventListener('click', async () => {
    const got = await api.pickFolder();
    if (!got) return;
    $<HTMLInputElement>('[name="prefix"]').value = got;
    save();
  });
  const openFolder = async () => {
    const err = await api.openFolder($<HTMLInputElement>('[name="prefix"]').value);
    if (err) write(err, 'warn');
  };
  result.open.addEventListener('click', openFolder);
  $('#open-dir').addEventListener('click', openFolder);
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void start('scrape');
    } else if (e.key === 'Escape' && running) {
      api.stop();
    }
  });

  api.init().then(init => {
    hint = init.hint;
    for (const i of inputs) i.value = String(init.settings[i.name] ?? '');
    headful.checked = init.settings.headful === true;
    setMode(init.settings.mode === 'image' ? 'image' : 'text');
    if (init.mac) $('#run-key').textContent = '⌘↵';
    document.body.dataset.ready = '1';
  });
})();
