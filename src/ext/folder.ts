// chrome.storage 는 JSON 만 담는다 → 폴더 핸들은 IndexedDB 에 둔다.
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ariadne', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = body(d.transaction('handles', mode).objectStore('handles'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

/** 고른 폴더. 없거나 읽지 못하면 null 이다. */
export async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const got = await tx('readonly', s => s.get('root'));
    return got instanceof FileSystemDirectoryHandle ? got : null;
  } catch {
    return null;
  }
}

export async function saveFolder(handle: FileSystemDirectoryHandle | null): Promise<void> {
  if (handle) await tx('readwrite', s => s.put(handle, 'root'));
  else await tx('readwrite', s => s.delete('root'));
}
