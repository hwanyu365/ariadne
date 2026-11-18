let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, () => void>();

function tick(): Worker {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('tick.js'));
    worker.onmessage = (e: MessageEvent<number>) => {
      const run = waiting.get(e.data);
      waiting.delete(e.data);
      run?.();
    };
  }
  return worker;
}

/** 가려진 패널에서도 늘어지지 않는 타이머. 돌려준 함수로 취소한다. */
export function setTimer(run: () => void, ms: number): () => void {
  const id = ++next;
  waiting.set(id, run);
  tick().postMessage({ id, ms });
  return () => { waiting.delete(id); };
}

/**
 * 패널의 setTimeout 을 Worker 타이머로 바꾼다.
 * 엔진은 플랫폼과 무관한 코드라 전역 타이머로 기다린다 → 패널에서는 전역을 바꿔야 엔진의 대기도 늘어지지 않는다.
 */
export function installTimers(): void {
  const cancels = new Map<number, () => void>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
    const id = ++next;
    cancels.set(id, setTimer(() => { cancels.delete(id); fn(...args); }, ms));
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id === undefined) return;
    cancels.get(id)?.();
    cancels.delete(id);
  }) as typeof clearTimeout;
}
