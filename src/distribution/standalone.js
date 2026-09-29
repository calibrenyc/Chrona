const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { registerUpdates } = require('./service');
const { readJson } = require('./storage');
const { spawn } = require('node:child_process');
const flag = process.argv.find(value => value.startsWith('--user-data-dir='));
const data = flag ? path.resolve(flag.slice('--user-data-dir='.length)) : path.join(app.getPath('appData'), 'chrona-game-launcher');
app.setPath('userData', path.join(data, 'updater-profile'));
let win;
app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  const settings = (await readJson(path.join(data, 'library.json')))?.settings || {};
  registerUpdates(() => win, async () => {}, () => settings, data);
  ipcMain.handle('updater:launchCurrent', async () => {
    const child = spawn(path.join(path.dirname(process.execPath), 'Chrona.exe'), [`--user-data-dir=${data}`], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); app.quit();
  });
  win = new BrowserWindow({ width: 720, height: 640, minWidth: 600, minHeight: 440,
    title: 'Chrona Updater', autoHideMenuBar: true, icon: path.join(__dirname, '../renderer/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'standalone-preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, 'standalone.html'));
}).catch(error => { require('electron').dialog.showErrorBox('Chrona Updater', error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());
