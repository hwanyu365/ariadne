import type { Sink } from '../core/engine.js';

/** 접두사를 폴더 단계와 파일 이름 앞부분으로 나눈다. 고른 폴더 밖을 가리키면 null 이다. */
export function splitPrefix(prefix: string): { dirs: string[]; base: string } | null {
  const parts = prefix.split(/[\\/]/);
  const base = parts.pop()!;
  if (!prefix || /^[a-z]:/i.test(prefix) || parts.some(p => !p || p === '.' || p === '..') || base === '.' || base === '..') return null;
  return { dirs: parts, base };
}

/** 고른 폴더 안의 접두사 경로에 쓴다. */
export async function fsaSink(root: FileSystemDirectoryHandle, prefix: string): Promise<Sink> {
  const at = splitPrefix(prefix);
  if (!at) throw new Error(`저장 폴더를 만들지 못했습니다: '${prefix}' 는 고른 폴더 안의 경로가 아닙니다.`);
  let dir = root;
  try {
    for (const name of at.dirs) dir = await dir.getDirectoryHandle(name, { create: true });
  } catch (e) {
    throw new Error(`저장 폴더를 만들지 못했습니다: ${prefix} (${e instanceof Error ? e.message : e})`);
  }
  const file = (name: string, create = false) => dir.getFileHandle(name, { create });
  const put = async (name: string, data: string | Uint8Array, keep: boolean) => {
    const h = await file(name, true);
    const w = await h.createWritable({ keepExistingData: keep });
    if (keep) await w.seek((await h.getFile()).size);
    await w.write(data as FileSystemWriteChunkType);
    await w.close();
  };
  return {
    base: at.base,
    list: async () => {
      const names: string[] = [];
      for await (const name of dir.keys()) names.push(name);
      return names;
    },
    exists: name => file(name).then(() => true, () => false),
    size: async name => (await (await file(name)).getFile()).size,
    write: (name, data) => put(name, data, false),
    append: (name, text) => put(name, text, true),
  };
}
