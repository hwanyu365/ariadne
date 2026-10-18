import { contextBridge, ipcRenderer } from 'electron';

const on = (channel: string) => (cb: (data: any) => void) => { ipcRenderer.on(channel, (_e, data) => cb(data)); };

contextBridge.exposeInMainWorld('ariadne', {
  init: () => ipcRenderer.invoke('app:init'),
  save: (values: unknown) => ipcRenderer.send('settings:save', values),
  start: (req: unknown) => ipcRenderer.invoke('run:start', req),
  stop: () => ipcRenderer.send('run:stop'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  openFolder: (prefix: string) => ipcRenderer.invoke('folder:open', prefix),
  onLog: on('run:log'),
  onPick: on('run:pick'),
  onDone: on('run:done'),
});
