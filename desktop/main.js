// Desktop wrapper: serves the game from a custom app:// protocol so fetch() of model files works.
const { app, BrowserWindow, protocol, net, Menu, ipcMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.whenReady().then(() => {
  const root = path.join(__dirname, 'game');
  protocol.handle('app', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname); if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ width: 1600, height: 900, backgroundColor: '#1b140e', title: 'Mushroom Hollow', autoHideMenuBar: true, fullscreen: true, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') } });
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('fullscreen', () => win.setFullScreen(!win.isFullScreen()));
  win.loadURL('app://game/index.html');
  win.webContents.on('before-input-event', (e, input) => { if (input.key === 'F11' && input.type === 'keyDown') win.setFullScreen(!win.isFullScreen()); });
});
app.on('window-all-closed', () => app.quit());
