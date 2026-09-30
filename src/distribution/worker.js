const { app, BrowserWindow, ipcMain, shell } = require('electron');
// The update archive contains resources/app.asar. Disable Electron's virtual
// ASAR filesystem before extract-zip opens that destination for writing.
process.noAsar = true;
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { readJson, atomicJson } = require('./storage');
const { replace } = require('./transaction');
let win, job, running = false, recoverySafe = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = value => { if (win && !win.isDestroyed()) win.webContents.send('updater:status', { darkMode: !!job?.darkMode, ...value }); };
const jobFile = process.argv[process.argv.indexOf('--chrona-updater') + 1];
try {
  job = JSON.parse(require('node:fs').readFileSync(jobFile, 'utf8'));
  if (!job || path.resolve(job.workspace) !== path.dirname(path.resolve(jobFile)) || path.dirname(process.execPath) !== path.join(job.workspace, 'helper')) throw new Error('Invalid updater workspace.');
  // Electron initializes its profile paths during startup, so select the isolated
  // helper profile before app.whenReady() rather than after Chromium is running.
  app.setPath('userData', path.join(job.workspace, 'helper-profile'));
} catch (error) { console.error(error); }
async function launch(args = []) {
  const child = spawn(path.join(job.install, 'Chrona.exe'), [`--user-data-dir=${job.data}`, ...args], { detached: true, stdio: 'ignore', cwd: job.install });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); return child;
}
async function run() {
  if (running) return; running = true; recoverySafe = false;
  try {
    status({ stage: 'Waiting for Chrona to close', percent: 0 });
    const deadline = Date.now() + 60000;
    while (true) {
      let alive = false;
      for (const pid of job.waitPids || [job.parentPid]) {
        try { process.kill(pid, 0); alive = true; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (!alive) break;
      if (Date.now() > deadline) throw new Error('Chrona is still running. Close it, then retry the update.');
      await pause(250);
    }
    await replace(job, status, async () => {
      status({ stage: 'Starting your updated launcher', percent: 95 });
      await atomicJson(path.join(job.data, 'pending-release.json'), job.release);
      const child = await launch(['--chrona-update-health', job.token]);
      const deadline = Date.now() + 60000;
      try {
        while (Date.now() < deadline) {
          const receipt = await readJson(job.health);
          if (receipt?.version === job.release.version && receipt.token === job.token) return;
          await pause(300);
        }
        throw new Error('The new launcher did not finish starting.');
      } catch (error) {
        // Terminate only the exact process tree we just started before rollback.
        await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, async killError => {
          if (killError) { try { process.kill(child.pid, 0); reject(killError); return; } catch (e) { if (e.code !== 'ESRCH') { reject(e); return; } } }
          resolve();
        }));
        await fs.unlink(path.join(job.data, 'pending-release.json')).catch(() => {});
        throw error;
      }
    });
    // Keep Windows Installed Apps metadata in sync after a ZIP update.
    await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; Get-ChildItem -LiteralPath $root | ForEach-Object { $entry = Get-ItemProperty -LiteralPath $_.PSPath; if ($entry.InstallLocation -and $entry.InstallLocation.TrimEnd('\\') -eq $env:CHRONA_INSTALL_ROOT.TrimEnd('\\')) { Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $env:CHRONA_NEW_VERSION } }"],
      { windowsHide: true, env: { ...process.env, CHRONA_INSTALL_ROOT: job.install, CHRONA_NEW_VERSION: job.release.version } }, resolve));
    await fs.appendFile(job.logFile, `${new Date().toISOString()} Updated to ${job.release.version}; backup: ${job.backup}\n`);
    // Keep the recovery workspace. No recursive deletion on the failure path.
    await pause(800); running = false; app.quit();
  } catch (error) {
    const journal = await readJson(job.journal).catch(() => null);
    recoverySafe = !journal || journal.status === 'restored';
    await fs.mkdir(path.dirname(job.logFile), { recursive: true });
    await fs.appendFile(job.logFile, `${new Date().toISOString()} ${error.stack}\n`);
    status({ error: true, safe: recoverySafe, stage: "Chrona couldn't finish updating.",
      message: recoverySafe ? 'Your previous installation is available. You can retry or launch it.' : 'Your backup has been preserved. View details for recovery information.' });
  } finally { running = false; }
}
ipcMain.handle('updater:action', async (_event, action) => {
  if (action === 'retry') return run();
  if (action === 'details') return shell.openPath(job.logFile);
  if (action === 'launch' && !running && recoverySafe) { await launch(); app.quit(); }
});
app.whenReady().then(async () => {
  if (!job) job = await readJson(jobFile);
  if (!job || path.resolve(job.workspace) !== path.dirname(path.resolve(jobFile)) || path.dirname(process.execPath) !== path.join(job.workspace, 'helper')) throw new Error('Invalid updater workspace.');
  await fs.mkdir(path.dirname(job.logFile), { recursive: true });
  win = new BrowserWindow({ width: 600, height: 440, resizable: false, backgroundColor: '#edf1f5', title: 'Chrona Update',
    autoHideMenuBar: true, icon: path.join(__dirname, '../renderer/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'worker-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.on('close', event => { if (running) event.preventDefault(); });
  await win.loadFile(path.join(__dirname, 'worker.html'));
  await atomicJson(path.join(job.workspace, 'ready.json'), { ready: true });
  await run();
}).catch(async error => {
  console.error(error);
  if (job?.logFile) {
    await fs.mkdir(path.dirname(job.logFile), { recursive: true }).catch(() => {});
    await fs.appendFile(job.logFile, `${new Date().toISOString()} Updater startup failed: ${error.stack || error}\n`).catch(() => {});
  }
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
