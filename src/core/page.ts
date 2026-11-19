export type Send = (method: string, params?: object) => Promise<any>;

export interface PickerHooks {
  targets: readonly string[];
  onPick: (payload: unknown) => void;
  onDone: () => void;
}

export interface OpenOptions {
  charset?: string | null;
  picker?: PickerHooks;
}

/** 엔진이 다루는 수집 대상 페이지 하나. 플랫폼마다 이 계약으로 구현한다. */
export interface Page {
  url(): string;
  /** 마지막으로 받은 메인 문서의 HTTP 상태. 아직 없으면 0 이다. */
  status(): number;
  /** 지금까지 받은 메인 문서 수. 값이 바뀌었으면 새 문서로 넘어간 것이다. */
  documents(): number;
  /** 마지막으로 받은 메인 문서의 원래 바이트. 못 얻었으면 비어 있다 → 인코딩 판정을 건너뛴다. */
  docBytes(): Uint8Array;
  /** 마지막으로 받은 메인 문서의 Referrer-Policy 응답 헤더. */
  referrerPolicy(): string;
  goto(url: string, timeout: number): Promise<void>;
  eval<T = unknown>(code: string, ms?: number): Promise<T>;
  evalSoon<T>(code: string, ms?: number): Promise<T | undefined>;
  waitFor(selector: string, timeout: number, state?: 'visible' | 'attached'): Promise<void>;
  click(selector: string, timeout?: number): Promise<void>;
  /** policy 는 그 이미지에 걸린 Referer 정책이다. */
  fetch(url: string, timeout: number, signal?: AbortSignal, policy?: string): Promise<Response>;
  childFrames(): { url: string }[];
  closed(): boolean;
  whenClosed(): Promise<void>;
  close(): void;
  /** 플랫폼이 페이지를 잃으면 멈춘 사유 문장을 reason 으로 중단한다. */
  readonly interrupted?: AbortSignal;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  // 인자 개수 상한을 넘지 않게 나눠 바꾼다.
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** CDP 로 조작하는 페이지의 공통 동작. 창·탭을 여는 일과 이동·요청은 플랫폼이 맡는다. */
export abstract class CdpPage implements Page {
  private raw: Uint8Array = new Uint8Array(0);
  private lastStatus = 0;
  private policy = '';
  private docs = 0;

  protected constructor(protected send: Send) {}

  abstract url(): string;
  abstract goto(url: string, timeout: number): Promise<void>;
  abstract fetch(url: string, timeout: number, signal?: AbortSignal, policy?: string): Promise<Response>;
  abstract childFrames(): { url: string }[];
  abstract closed(): boolean;
  abstract whenClosed(): Promise<void>;
  abstract close(): void;

  /** 메인 프레임 문서의 원래 바이트를 남기고, charset 을 주면 그 값으로 바꿔 넘긴다. Fetch.requestPaused 마다 부른다. */
  protected async onRequestPaused(ev: any, main: string, charset: string | null): Promise<void> {
    const rid = ev.requestId;
    // 이번 문서의 바이트를 못 얻으면 지난 문서로 판정하게 된다 → 먼저 비운다.
    if (ev.frameId === main) {
      this.raw = new Uint8Array(0);
      this.lastStatus = ev.responseStatusCode ?? 0;
      this.policy = (ev.responseHeaders ?? []).find((h: { name: string }) => h.name.toLowerCase() === 'referrer-policy')?.value ?? '';
      this.docs++;
    }
    try {
      if (ev.frameId === main && ev.responseStatusCode >= 200 && ev.responseStatusCode < 300) {
        const got = await this.send('Fetch.getResponseBody', { requestId: rid });
        // 바꿔 넘긴 응답은 다시 인코딩된 값이라 원래 바이트는 여기서만 얻는다.
        const raw = got.base64Encoded ? fromBase64(got.body) : new TextEncoder().encode(got.body);
        this.raw = raw;
        if (charset) {
          await this.send('Fetch.fulfillRequest', forced(ev, raw, charset));
          return;
        }
      }
    } catch {
      // 멈춘 요청은 풀어 주지 않으면 타임아웃까지 매달린다 → 실패 종류와 무관하게 원래대로 보낸다.
    }
    await this.send('Fetch.continueRequest', { requestId: rid }).catch(() => {});
  }

  docBytes(): Uint8Array {
    return this.raw;
  }

  status(): number {
    return this.lastStatus;
  }

  documents(): number {
    return this.docs;
  }

  referrerPolicy(): string {
    return this.policy;
  }

  /** 이동 중인 문서에 걸린 평가는 끝나지 않을 수 있다 → 상한을 넘기면 실패로 돌린다. */
  eval<T = unknown>(code: string, ms = 30000): Promise<T> {
    // webContents.executeJavaScript 는 load 가 끝날 때까지 미뤄진다 → 응답이 멈춘 이미지 하나가 모든 평가를 막는다.
    const run = this.send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }).then(r => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value as T;
    });
    return withTimeout(run, ms, `${ms}ms 안에 페이지 평가가 끝나지 않았습니다.`);
  }

  /** 페이지가 이동 중이면 평가가 끝나지 않거나 실패한다 → 정해진 시간 안의 결과만 쓴다. */
  async evalSoon<T>(code: string, ms = 1000): Promise<T | undefined> {
    try {
      return await this.eval<T>(code, ms);
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
    throw new Error(`${timeout}ms 동안 셀렉터 ${sel} 에 걸리는 요소가 없습니다.`);
  }

  /** 신뢰된 마우스 이벤트로 누른다. JS click() 은 isTrusted 를 보는 사이트에서 무시된다. */
  async click(selector: string, timeout = 2000): Promise<void> {
    // 이미지가 늦게 그려지면 레이아웃이 밀린다 → 위치가 50ms 간격으로 같고, 그 좌표에 실제로 이 요소가 있을 때만 누른다.
    const measure = `new Promise(done => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return done(null);
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = () => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
      const a = rect();
      // requestAnimationFrame 은 가려진 창에서 멈춘다 → 타이머로 잰다.
      setTimeout(() => {
        const b = rect();
        const x = b[0] + b[2] / 2, y = b[1] + b[3] / 2;
        const hit = document.elementFromPoint(x, y);
        const moving = a.join() !== b.join();
        const covered = !hit || !(hit === e || e.contains(hit));
        const what = hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : '화면 밖';
        done({ x, y, ready: !moving && !covered, why: moving ? '위치가 멈추지 않았습니다' : covered ? '그 자리에 ' + what + ' 이(가) 있습니다' : '' });
      }, 50);
    })`;
    const deadline = Date.now() + timeout;
    type At = { x: number; y: number; ready: boolean; why: string } | null;
    let at: At | undefined;
    // 평가가 실패하면(undefined) 문서가 바뀌는 중일 수 있다 → 요소가 없는 것(null)과 달리 기한 안에서 다시 잰다.
    do {
      at = await this.evalSoon<At>(measure);
      if (at === null) throw new Error(`셀렉터 ${JSON.stringify(selector)} 에 걸리는 요소가 없습니다.`);
    } while (!at?.ready && Date.now() < deadline);
    // 덮은 요소를 누르면 엉뚱한 곳이 반응하고 원인이 가려진다 → 못 누른 사유로 돌려준다.
    if (!at?.ready) throw new Error(`${timeout}ms 동안 ${JSON.stringify(selector)} 를 누를 수 없었습니다: ${at?.why ?? '페이지를 평가하지 못했습니다'}.`);
    // 사람처럼 포인터를 먼저 올린 뒤 누른다 → hover 를 거쳐야 클릭을 받는 페이지가 있다.
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
}

const POLICIES = ['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];

/** 여러 값이면 마지막의 아는 값을 쓴다 (브라우저와 같다). */
const knownPolicy = (v: string) => v.split(',').map(t => t.trim().toLowerCase()).filter(t => POLICIES.includes(t)).at(-1);

/** 요소 속성 → 문서 meta → 응답 헤더 순으로 아는 값이 든 첫 단계의 정책. 모르는 값만 있는 단계는 브라우저처럼 건너뛴다. */
export function pickPolicy(...stages: string[]): string {
  return stages.map(knownPolicy).find(Boolean) ?? '';
}

/**
 * 페이지가 그 주소를 그릴 때 브라우저가 보내는 Referer.
 * 브라우저보다 많이 보내면 차단 회피가 되고, 덜 보내면 핫링크 판정에서 거부된다.
 */
export function referrerFor(pageUrl: string, target: string, policy = ''): string | null {
  const from = URL.parse(pageUrl), to = URL.parse(target);
  if (!from || !to || !/^https?:$/.test(from.protocol)) return null;
  from.username = from.password = from.hash = '';
  const full = from.href, origin = `${from.origin}/`;
  const same = from.origin === to.origin, down = from.protocol === 'https:' && to.protocol !== 'https:';
  const p = knownPolicy(policy);
  switch (p) {
    case 'no-referrer': return null;
    case 'unsafe-url': return full;
    case 'origin': return origin;
    case 'same-origin': return same ? full : null;
    case 'origin-when-cross-origin': return same ? full : origin;
    case 'strict-origin': return down ? null : origin;
    case 'no-referrer-when-downgrade': return down ? null : full;
    default: return down ? null : same ? full : origin;
  }
}

/** 받은 본문은 이미 압축이 풀려 있다 → 압축·길이 헤더를 빼고 charset 만 바꿔 넘긴다. */
function forced(ev: any, raw: Uint8Array, charset: string) {
  let mime = 'text/html';
  const headers: { name: string; value: string }[] = [];
  for (const h of ev.responseHeaders ?? []) {
    const name = h.name.toLowerCase();
    if (name === 'content-type') mime = h.value.split(';')[0].trim() || mime;
    else if (name !== 'content-encoding' && name !== 'content-length') headers.push(h);
  }
  headers.push({ name: 'Content-Type', value: `${mime}; charset=${charset}` });
  return { requestId: ev.requestId, responseCode: ev.responseStatusCode, responseHeaders: headers, body: toBase64(raw) };
}
