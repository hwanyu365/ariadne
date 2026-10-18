import { ipcRenderer } from 'electron';

// preload 의 격리 world 전역에만 생긴다 → 대상 페이지의 스크립트는 이 통로를 부를 수 없다.
Object.assign(window, {
  __ariadne_pick: (payload: unknown) => ipcRenderer.send('ariadne:pick', payload),
  __ariadne_done: () => ipcRenderer.send('ariadne:done'),
});
