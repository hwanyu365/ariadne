import type { logLevel } from '../core/form.js';

export type Level = ReturnType<typeof logLevel>;

const MAX_LINES = 2000;

/** 로그 줄을 붙이고 최근 줄만 남긴다. */
export function appendLog(log: HTMLElement, text: string, level: Level): void {
  const line = document.createElement('span');
  if (level) line.className = level;
  // 페이지가 정한 셀렉터·텍스트가 섞여 온다 → 마크업으로 해석하지 않는다.
  line.textContent = text;
  log.append(line);
  while (log.childElementCount > MAX_LINES) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
}
