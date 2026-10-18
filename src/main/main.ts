import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import { createMainWindow, registerIpc } from './app';

// macOS 는 앱 메뉴가 있어야 복사·붙여넣기 단축키가 동작한다 → 다른 OS 에서만 메뉴 막대를 없앤다.
if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  registerIpc({
    settingsPath: path.join(app.getPath('userData'), 'settings.json'),
    defaultPrefix: path.join(app.getPath('downloads'), 'ariadne', 'page'),
  });
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
