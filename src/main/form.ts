import fs from 'node:fs';
import path from 'node:path';
import { checkCharset } from './charset';

export const TEXT_KEYS = ['url', 'sel', 'next', 'title', 'exclude', 'charset', 'prefix'] as const;
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
  url: '', sel: '', next: '', title: '', exclude: '', charset: '', prefix: '',
  ...(Object.fromEntries(NUM_FIELDS.map(([k, , d]) => [k, d])) as Record<NumKey, string>),
};

export const HINT: Record<Mode, string> = {
  text: '본문이 들어 있는 컨테이너 (예: #articleBody)',
  image: '이미지 요소까지 지정합니다 (예: #articleBody img)',
};

/** 화면이 오류를 해당 입력란에 표시하도록 어느 칸인지 함께 올린다. */
export class InputError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

/** 입력 문자열을 엔진 인자로 바꾼다. 비면 사유를 Error 로 올려 로그에 띄운다. */
export function parseInputs(raw: Raw, probe: boolean) {
  const t = Object.fromEntries(TEXT_KEYS.map(k => [k, (raw[k] ?? '').trim()])) as Record<TextKey, string>;
  if (!t.url) throw new InputError('URL 을 입력해 주세요.', 'url');
  if (!probe && !(t.sel && t.next))
    throw new InputError('수집 대상과 next 셀렉터가 필요합니다. 모르면 [요소 선택] 이나 probe 로 후보를 먼저 확인하세요.', t.sel ? 'next' : 'sel');
  const nums = {} as Record<NumKey, number>;
  for (const [key, label] of NUM_FIELDS) {
    const value = (raw[key] ?? '').trim() || '0';
    if (!/^-?\d+$/.test(value)) throw new InputError(`${label} 은 숫자여야 합니다: '${value}'`, key);
    nums[key] = Number(value);
  }
  let charset: string | null;
  try {
    charset = checkCharset(t.charset);
  } catch (e) {
    throw new InputError(e instanceof Error ? e.message : String(e), 'charset');
  }
  return { text: { ...t, charset }, nums };
}

// 선택기 툴바의 대상 이름을 입력란에 잇는다. 이미지 모드는 같은 칸에 이미지 셀렉터를 받는다.
const PICK_TARGETS: Record<string, TextKey> = { 본문: 'sel', 이미지: 'sel', next: 'next', 제목: 'title', 제외: 'exclude' };

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

const SITE_KEYS = ['sel', 'next', 'title', 'exclude', 'charset'] as const;
export type Site = Record<(typeof SITE_KEYS)[number], string> & { mode: Mode };
export type Settings = Partial<Raw> & { mode?: Mode; headful?: boolean; merge?: boolean; recent?: string[]; sites?: Record<string, Site> };

const MAX_RECENT = 10;
const MAX_SITES = 50;

const hostOf = (url: string) => URL.parse(url.trim())?.host ?? '';

function cleanSite(v: unknown): Site | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const site = Object.fromEntries(SITE_KEYS.map(k => [k, typeof o[k] === 'string' ? o[k] : ''])) as Site;
  site.mode = o.mode === 'image' ? 'image' : 'text';
  return site;
}

/** 수집을 시작한 URL 과 그 호스트의 셀렉터 묶음을 남긴다. 최근 것이 앞이고, 개수는 상한까지만 둔다. */
export function remember(s: Settings, values: Raw, mode: Mode): Pick<Settings, 'recent' | 'sites'> {
  const url = values.url.trim();
  const recent = [url, ...(s.recent ?? []).filter(u => u !== url)].slice(0, MAX_RECENT);
  const host = hostOf(url);
  if (!host) return { recent, sites: s.sites ?? {} };
  const site = { ...Object.fromEntries(SITE_KEYS.map(k => [k, (values[k] ?? '').trim()])), mode } as Site;
  // 객체 키 순서가 쓴 순서다 → 다시 쓴 호스트를 맨 뒤로 보내고 앞에서부터 버린다.
  const rest = Object.entries(s.sites ?? {}).filter(([h]) => h !== host);
  return { recent, sites: Object.fromEntries([...rest, [host, site]].slice(-MAX_SITES)) };
}

export function siteFor(s: Settings, url: string): Site | null {
  const host = hostOf(url);
  return host && s.sites && Object.hasOwn(s.sites, host) ? s.sites[host] : null;
}

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
  if (typeof d.merge === 'boolean') got.merge = d.merge;
  if (Array.isArray(d.recent)) got.recent = d.recent.filter((u): u is string => typeof u === 'string').slice(0, MAX_RECENT);
  if (d.sites && typeof d.sites === 'object' && !Array.isArray(d.sites)) {
    // fromEntries 는 '__proto__' 같은 이름도 자기 키로 만든다 → 파일 내용이 객체의 원형을 바꾸지 못한다.
    got.sites = Object.fromEntries(Object.entries(d.sites).flatMap(([h, v]) => {
      const site = cleanSite(v);
      return site ? [[h, site]] : [];
    }).slice(-MAX_SITES));
  }
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

export function logLevel(line: string): 'error' | 'warn' | 'info' | 'ok' | null {
  const s = line.trimStart();
  if (s.startsWith('완료')) return 'ok';
  if (s.startsWith('실패')) return 'error';
  if (/^(경고|주의|건너뜀)/.test(s)) return 'warn';
  if (s.startsWith('중단')) return 'info';
  return null;
}

/** 작업 영역(작업 표시줄 제외) 안에 들어오는 창 높이. 화면이 작으면 레이아웃보다 화면을 우선한다. */
export function windowHeight(workAreaHeight: number): number {
  return Math.floor(Math.min(900, workAreaHeight - 40));
}
