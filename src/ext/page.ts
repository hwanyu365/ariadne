import { checkCharset } from '../core/charset.js';
import type { Log } from '../core/engine.js';
import { CdpPage, type OpenOptions, type PickerHooks, referrerFor, type Send } from '../core/page.js';
import { pickerSetupJs } from '../core/picker.js';
import { setTimer } from './timers.js';

const RULE_IDS = [1, 2, 3];
const LINK = new Set(['link', 'form_submit']);
const NULL_BODY = [101, 204, 205, 304];
// 선택기를 세우는 격리 world 이름이다. 통로 바인딩은 이 이름의 world 에만 생긴다.
const WORLD = 'ariadne';
const BIND = '__ariadneBind';
const ALIVE_EVERY = 1000;
const ALIVE_GAP = 3000;

/** 사용자가 대상 탭을 직접 옮긴 이동인지. 페이지 안 링크를 사람이 누른 것은 next 누르기와 가를 수 없다. */
function userNavigation(transitionType: string, qualifiers: string[]): boolean {
  return !LINK.has(transitionType) || qualifiers.includes('forward_back');
}

/** 사용자가 보고 있는 탭에 디버거를 붙여 조작한다. 탭은 사용자의 것이라 닫지 않는다. */
export class DebuggerPage extends CdpPage {
  private href = '';
  private frames = new Map<string, string>();
  private main = '';
  private detached = false;
  private fetching = false;
  private readonly lost = new AbortController();
  private readonly gone: Promise<void>;
  private markGone!: () => void;
  private cleanup: (() => void)[] = [];
  private loaded: (() => void) | null = null;
  private pickerWorld = 0;

  readonly interrupted = this.lost.signal;

  private constructor(private readonly tabId: number, private readonly log: Log, private readonly onAttach: (attached: boolean) => void) {
    super((method, params) => chrome.debugger.sendCommand({ tabId }, method, params) as Promise<any>);
    this.gone = new Promise(r => { this.markGone = r; });
  }

  static async open(tabId: number, opts: OpenOptions, log: Log, onAttach: (attached: boolean) => void = () => {}): Promise<DebuggerPage> {
    const charset = checkCharset(opts.charset ?? '');
    await chrome.debugger.attach({ tabId }, '1.3');
    const page = new DebuggerPage(tabId, log, onAttach);
    onAttach(true);
    try {
      page.listen(charset);
      const send: Send = page.send;
      await send('Page.enable');
      const tree = (await send('Page.getFrameTree')).frameTree;
      page.main = tree.frame.id;
      page.href = tree.frame.url;
      // 가려진 탭은 타이머가 늘어지고 지연 로딩이 멈춘다 → 보이는 탭처럼 동작하게 한다.
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await send('Page.setWebLifecycleState', { state: 'active' });
      await send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
      if (opts.picker) await page.installPicker(opts.picker);
      return page;
    } catch (e) {
      page.close();
      throw e;
    }
  }

  /** 문서마다 격리 world 에 선택기를 세우고, 그 world 에서만 부를 수 있는 바인딩으로 선택을 받는다. */
  private async installPicker(picker: PickerHooks) {
    const tabId = this.tabId;
    const onEvent = (src: chrome.debugger.Debuggee, method: string, ev?: any) => {
      if (src.tabId !== tabId) return;
      if (method === 'Runtime.executionContextCreated' && ev.context.name === WORLD && ev.context.auxData?.frameId === this.main) this.pickerWorld = ev.context.id;
      else if (method === 'Runtime.bindingCalled' && ev.name === BIND) {
        const msg = JSON.parse(ev.payload);
        if (msg.kind === 'done') picker.onDone();
        else picker.onPick(msg.payload);
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    this.cleanup.push(() => chrome.debugger.onEvent.removeListener(onEvent));
    await this.send('Runtime.enable');
    await this.send('Runtime.addBinding', { name: BIND, executionContextName: WORLD });
    // 선택기 스크립트는 선택·완료를 전역 함수로 부른다 → 이 world 안에서만 바인딩으로 잇는다.
    const bridge = `window.__ariadne_pick = p => ${BIND}(JSON.stringify({ kind: 'pick', payload: p })); window.__ariadne_done = () => ${BIND}('{"kind":"done"}');`;
    // 디버거가 밖에서 떨어지면 패널은 이 탭에 아무것도 실행할 수 없다 → 패널의 신호가 끊기면 선택기가 스스로 걷는다.
    const alive = `window.__ariadneAlive = Date.now(); setInterval(() => { if (Date.now() - window.__ariadneAlive > ${ALIVE_GAP} && window.__ariadnePickerOff) window.__ariadnePickerOff(); }, 1000);`;
    // 새 문서 스크립트는 문서가 만들어지기 전에 돈다 → 선택기 UI 는 DOM 이 준비된 뒤 세운다.
    const setup = `const setup = () => ${pickerSetupJs(picker.targets)}; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true }); else setup();`;
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `${bridge}\n${alive}\n${setup}`, worldName: WORLD });
    this.keepAlive();
  }

  /** 선택기에 살아 있다는 신호를 보낸다. 디버거가 밖에서 떨어졌으면 페이지를 잃은 것으로 끝낸다. */
  private keepAlive() {
    const tick = async () => {
      if (this.detached) return;
      if (this.pickerWorld) {
        await this.send('Runtime.evaluate', { expression: 'window.__ariadneAlive = Date.now()', contextId: this.pickerWorld }).catch(async () => {
          // 문서가 바뀌는 중에도 이 평가는 실패한다 → 디버거가 떨어졌는지는 따로 본다.
          await this.send('Runtime.evaluate', { expression: '0' }).catch(() => {
            this.lose('디버깅 연결이 해제되었습니다.');
            this.finish();
          });
        });
      }
      if (!this.detached) cancel = setTimer(() => void tick(), ALIVE_EVERY);
    };
    let cancel = setTimer(() => void tick(), ALIVE_EVERY);
    this.cleanup.push(() => cancel());
  }

  private listen(charset: string | null) {
    const tabId = this.tabId;
    const onEvent = (src: chrome.debugger.Debuggee, method: string, ev?: any) => {
      if (src.tabId !== tabId) return;
      if (method === 'Fetch.requestPaused') void this.onRequestPaused(ev, this.main, charset);
      else if (method === 'Page.frameNavigated') {
        if (!ev.frame.parentId) this.href = ev.frame.url;
        else this.frames.set(ev.frame.id, ev.frame.url);
      } else if (method === 'Page.navigatedWithinDocument' && ev.frameId === this.main) this.href = ev.url;
      else if (method === 'Page.frameDetached') this.frames.delete(ev.frameId);
      else if (method === 'Page.domContentEventFired') this.loaded?.();
    };
    const onDetach = (src: chrome.debugger.Debuggee, reason: string) => {
      if (src.tabId !== tabId) return;
      this.lose(reason === 'target_closed' ? '대상 탭이 닫혔습니다.' : '디버깅 연결이 해제되었습니다.');
      this.finish();
    };
    const onRemoved = (id: number) => { if (id === tabId) this.lose('대상 탭이 닫혔습니다.'); };
    const onCommitted = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (d.tabId === tabId && d.frameId === 0 && userNavigation(d.transitionType, d.transitionQualifiers)) this.lose('대상 탭이 다른 페이지로 이동했습니다.');
    };
    const onPopup = (d: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
      if (d.sourceTabId !== tabId) return;
      chrome.tabs.remove(d.tabId).catch(() => {});
      this.log(`  주의: 대상 탭이 연 새 탭을 닫았습니다: ${d.url}`);
    };
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.onDetach.addListener(onDetach);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onCreatedNavigationTarget.addListener(onPopup);
    this.cleanup.push(() => {
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.onDetach.removeListener(onDetach);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      chrome.webNavigation.onCreatedNavigationTarget.removeListener(onPopup);
    });
  }

  private lose(why: string) {
    if (!this.lost.signal.aborted) this.lost.abort(why);
  }

  /** released 가 풀리면 디버거가 떨어진 것으로 알린다. */
  private finish(released: Promise<unknown> = Promise.resolve()) {
    if (this.detached) return;
    this.detached = true;
    this.cleanup.forEach(f => f());
    void released.then(() => {
      this.onAttach(false);
      this.markGone();
    });
  }

  url(): string {
    return this.href;
  }

  closed(): boolean {
    return this.detached;
  }

  async goto(url: string, timeout: number): Promise<void> {
    let timer = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      this.loaded = resolve;
      timer = setTimer(() => reject(new Error(`${timeout}ms 안에 페이지를 열지 못했습니다: ${url}`)), timeout);
    });
    try {
      // 사용자가 옮긴 이동과 가르려고 엔진의 이동은 링크 이동으로 보낸다.
      const r = await this.send('Page.navigate', { url, transitionType: 'link' });
      if (r.errorText) throw new Error(`${r.errorText} ${url}`);
      await ready;
    } finally {
      this.loaded = null;
      timer();
    }
  }

  /**
   * 패널에서 받는다 → 탭의 쿠키가 실린다.
   * Referer 는 리디렉션 단계마다 규칙이 다시 맞아 그 주소 기준으로 정해진다.
   */
  async fetch(url: string, timeout: number, signal?: AbortSignal, policy = ''): Promise<Response> {
    if (this.fetching) throw new Error('이미지를 동시에 받지 않습니다. 앞의 요청이 끝난 뒤 받으세요.');
    this.fetching = true;
    const limit = new AbortController();
    const stop = setTimer(() => limit.abort(new Error(`${timeout}ms 안에 받지 못했습니다.`)), timeout);
    try {
      // 규칙은 확장 전체에 걸린다 → 다른 패널의 수집과 겹치지 않게 한 번에 하나만 받는다.
      return await navigator.locks.request('ariadne-referer', async () => {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: RULE_IDS, addRules: refererRules(this.href, policy) });
        try {
          const resp = await fetch(url, { credentials: 'include', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([limit.signal, signal]) : limit.signal });
          // 본문을 다 받기 전에 규칙을 지우면 남은 리디렉션이 다른 Referer 로 간다 → 여기서 다 받는다.
          const body = await resp.arrayBuffer();
          // 본문이 없어야 하는 상태 코드에 본문을 주면 Response 를 만들지 못한다.
          return new Response(NULL_BODY.includes(resp.status) ? null : body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        } finally {
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: RULE_IDS });
        }
      });
    } finally {
      stop();
      this.fetching = false;
    }
  }

  childFrames(): { url: string }[] {
    return [...this.frames.values()].map(url => ({ url }));
  }

  whenClosed(): Promise<void> {
    return this.gone;
  }

  close(): void {
    if (this.detached) return;
    // 탭은 사용자가 계속 쓴다 → 떼기 전에 선택기를 걷는다.
    const off = this.pickerWorld
      ? this.send('Runtime.evaluate', { expression: 'window.__ariadnePickerOff && window.__ariadnePickerOff()', contextId: this.pickerWorld }).catch(() => {})
      : Promise.resolve();
    this.finish(off.then(() => chrome.debugger.detach({ tabId: this.tabId }).catch(() => {})));
  }
}

/**
 * 같은 출처·다운그레이드·그 밖으로 나눠 규칙 하나씩 둔다.
 * 규칙은 요청 단계의 주소로 맞으므로 리디렉션되면 다음 단계는 그 주소 기준으로 다시 맞는다.
 */
function refererRules(pageUrl: string, policy: string): chrome.declarativeNetRequest.Rule[] {
  const origin = URL.parse(pageUrl)?.origin;
  const rule = (id: number, priority: number, urlFilter: string, value: string | null): chrome.declarativeNetRequest.Rule => ({
    id, priority,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [value === null
        ? { header: 'referer', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }
        : { header: 'referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value }],
    },
    // 페이지가 보낸 요청은 시작 주체가 페이지다 → 확장이 보낸 요청에만 건다.
    condition: { urlFilter, initiatorDomains: [chrome.runtime.id] },
  });
  // 페이지와 출처가 다른 대표 주소다. 규칙 값은 출처 관계와 스킴으로만 갈린다.
  const other = (scheme: string) => `${scheme}://ariadne-other.invalid/`;
  const rules = [
    rule(RULE_IDS[0], 1, '|https:', referrerFor(pageUrl, other('https'), policy)),
    rule(RULE_IDS[1], 2, '|http:', referrerFor(pageUrl, other('http'), policy)),
  ];
  if (origin && origin !== 'null') rules.push(rule(RULE_IDS[2], 3, `|${origin}/`, referrerFor(pageUrl, `${origin}/`, policy)));
  return rules;
}
