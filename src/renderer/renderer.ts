// preload 가 열어 준 통로만 쓴다. 입력 검증과 실행은 메인 프로세스가 한다.
type Mode = 'text' | 'image';
type Kind = 'scrape' | 'probe' | 'pick';
type Level = 'error' | 'warn' | 'info' | null;

interface Api {
  init(): Promise<{ settings: Record<string, string | boolean>; hint: Record<Mode, string>; mac: boolean }>;
  save(values: Record<string, string | boolean>): void;
  start(req: { kind: Kind; values: Record<string, string>; mode: Mode; headful: boolean }): Promise<{ error: string | null }>;
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
  const LABEL: Record<Kind, string> = { scrape: '수집 중', probe: 'probe 중', pick: '요소 선택 중' };
  let mode: Mode = 'text';
  let hint: Record<Mode, string> = { text: '', image: '' };
  let running = false, failed = false, started = 0, timer = 0, saveTimer = 0;

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
    line.textContent = `${text}\n`;      // 페이지가 정한 셀렉터·텍스트가 섞여 온다 → 마크업으로 해석하지 않는다
    log.append(line);
    log.scrollTop = log.scrollHeight;
  }

  function tick() {
    const s = Math.floor((Date.now() - started) / 1000);
    st.time.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function setRunning(on: boolean) {
    running = on;
    document.querySelectorAll<HTMLButtonElement>('.busy').forEach(b => { b.disabled = on; });
    $<HTMLButtonElement>('#stop').disabled = !on;
    clearInterval(timer);
    if (on) timer = window.setInterval(tick, 1000);
    tick();
  }

  async function start(kind: Kind) {
    if (running) return;
    running = true;                      // 응답을 기다리는 사이에 다시 눌러도 두 번 시작하지 않는다
    const got = await api.start({ kind, values: values(), mode, headful: headful.checked });
    log.textContent = '';
    if (got.error) {
      running = false;
      write(`실패: ${got.error}`, 'error');
      setState('입력 확인', 'check');
      return;
    }
    failed = false;
    started = Date.now();
    st.pages.textContent = '';
    st.file.textContent = '';
    setState(LABEL[kind], 'running');
    setRunning(true);
  }

  api.onLog(({ text, level, progress }) => {
    if (level === 'error') failed = true;
    if (progress) {
      st.pages.textContent = `${progress.pages}페이지`;
      st.file.textContent = progress.file;
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
    if (failed) setState('실패', 'failed');
    else setState(stopped ? '중지됨' : '완료');
  });

  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.addEventListener('click', () => { setMode(b.dataset.mode as Mode); save(); }));
  inputs.forEach(i => i.addEventListener('input', save));
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
  $('#open-dir').addEventListener('click', async () => {
    const err = await api.openFolder($<HTMLInputElement>('[name="prefix"]').value);
    if (err) write(err, 'warn');
  });
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
