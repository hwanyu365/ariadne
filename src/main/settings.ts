import fs from 'node:fs';
import path from 'node:path';
import { cleanSettings, type Settings } from '../core/form';

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

export function saveSettings(file: string, values: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values, null, 2), 'utf8');
}

/** 작업 영역(작업 표시줄 제외) 안에 들어오는 창 높이. 화면이 작으면 레이아웃보다 화면을 우선한다. */
export function windowHeight(workAreaHeight: number): number {
  return Math.floor(Math.min(900, workAreaHeight - 40));
}
