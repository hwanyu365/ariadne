import fs from 'node:fs';
import path from 'node:path';
import { checkCharset } from './charset';

export const TEXT_KEYS = ['url', 'sel', 'next', 'title', 'charset', 'prefix'] as const;
export const NUM_FIELDS = [
  ['max', '최대 페이지 (0=끝까지)', '0'],
  ['start', '시작 번호', '1'],
  ['digits', '자릿수', '4'],
  ['timeout', '타임아웃 ms', '15000'],
  ['delay', '페이지 간 대기 ms', '0'],
] as const;

type TextKey = (typeof TEXT_KEYS)[number];
type NumKey = (typeof NUM_FIELDS)[number][0];
export type Raw = Record<TextKey | NumKey, string>;
export type Mode = 'text' | 'image';

export const DEFAULTS: Raw = {
  url: '', sel: '', next: '', title: '', charset: '', prefix: '',
  ...(Object.fromEntries(NUM_FIELDS.map(([k, , d]) => [k, d])) as Record<NumKey, string>),
};

export const HINT: Record<Mode, string> = {
  text: '본문이 들어 있는 컨테이너 (예: #articleBody)',
  image: '이미지 요소까지 지정한다 (예: #articleBody img)',
};

/** 입력 문자열을 엔진 인자로 바꾼다. 비면 사유를 Error 로 올려 로그에 띄운다. */
export function parseInputs(raw: Raw, probe: boolean) {
  const t = Object.fromEntries(TEXT_KEYS.map(k => [k, (raw[k] ?? '').trim()])) as Record<TextKey, string>;
  if (!t.url) throw new Error('URL 을 입력하라.');
  if (!probe && !(t.sel && t.next)) throw new Error('수집 대상과 next 셀렉터가 필요하다. 모르면 probe 로 후보를 먼저 보라.');
  const nums = {} as Record<NumKey, number>;
  for (const [key, label] of NUM_FIELDS) {
    const value = (raw[key] ?? '').trim() || '0';
    if (!/^-?\d+$/.test(value)) throw new Error(`${label} 은 숫자여야 한다: '${value}'`);
    nums[key] = Number(value);
  }
  return { text: { ...t, charset: checkCharset(t.charset) }, nums };
}

// 선택기 툴바의 대상 이름을 입력란에 잇는다. 이미지 모드는 같은 칸에 이미지 셀렉터를 받는다.
const PICK_TARGETS: Record<string, TextKey> = { 본문: 'sel', 이미지: 'sel', next: 'next', 제목: 'title' };

/** 선택기가 보낸 값을 입력란 키·셀렉터·로그 줄로 바꾼다. 셀렉터와 텍스트는 대상 페이지가 정한 값이라 형태를 전부 확인한다. */
export function pickUpdate(payload: unknown): { key: TextKey; sel: string; line: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const key = typeof p.target === 'string' && Object.hasOwn(PICK_TARGETS, p.target) ? PICK_TARGETS[p.target] : undefined;
  if (!key || typeof p.sel !== 'string' || !p.sel.trim()) return null;
  const sel = p.sel.trim();
  const parts = (Array.isArray(p.candidates) ? p.candidates : [])
    .filter((c): c is { sel: string; n: number } => !!c && typeof c === 'object' && typeof c.sel === 'string' && Number.isInteger(c.n))
    .map(c => `${c.sel}(${c.n})`);
  return { key, sel, line: `[${p.target}] ${sel}${parts.length ? `   후보: ${parts.join('  ')}` : ''}` };
}

export type Settings = Partial<Raw> & { mode?: Mode; headful?: boolean };

/** 저장된 입력값 중 아는 키·맞는 타입만 돌려준다. 파일 때문에 앱이 안 켜지는 일은 없어야 한다. */
export function loadSettings(file: string): Settings {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  return cleanSettings(data);
}

/** 아는 키·맞는 타입만 남긴다. 파일에서 읽은 값과 화면이 보낸 값 모두 이 형태로만 다룬다. */
export function cleanSettings(data: unknown): Settings {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const d = data as Record<string, unknown>;
  const got: Settings = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Raw)[]) if (typeof d[k] === 'string') got[k] = d[k] as string;
  if (d.mode === 'text' || d.mode === 'image') got.mode = d.mode;
  if (typeof d.headful === 'boolean') got.headful = d.headful;
  return got;
}

export function saveSettings(file: string, values: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values, null, 2), 'utf8');
}

/** 엔진의 페이지 저장 로그에서 받은 페이지 수와 파일명을 읽는다. */
export function progress(line: string): { pages: number; file: string } | null {
  const m = /^\[(\d+)\] .* -> (.+)$/.exec(line);
  return m ? { pages: Number(m[1]), file: m[2] } : null;
}

export function logLevel(line: string): 'error' | 'warn' | 'info' | null {
  const s = line.trimStart();
  if (s.startsWith('실패')) return 'error';
  if (/^(경고|주의|건너뜀)/.test(s)) return 'warn';
  if (s.startsWith('중단')) return 'info';
  return null;
}

/** 작업 영역(작업 표시줄 제외) 안에 들어오는 창 높이. 화면이 작으면 레이아웃보다 화면을 우선한다. */
export function windowHeight(workAreaHeight: number): number {
  return Math.floor(Math.min(900, workAreaHeight - 40));
}
