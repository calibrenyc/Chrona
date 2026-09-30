const { app, ipcMain, shell } = require('electron');
const fs = require('./disk').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const releases = require('./releases');
const pkg = require('./package');
const { atomicJson, readJson } = require('./storage');
let busy = false;
function registerUpdates(getWindow, save, getSettings, profile = app.getPath('userData')) {
  const data = profile;
  const logFile = path.join(data, 'logs', 'updater.log');
  async function log(error) { await fs.mkdir(path.dirname(logFile), { recursive: true }); await fs.appendFile(logFile, `${new Date().toISOString()} ${error.stack || error}\n`); }
  const progress = value => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('chrona:progress', value); };
  ipcMain.handle('chrona:check', async () => {
    try { return await releases.latest(app.getVersion()); }
    catch (error) { await log(error); return { error: error.message, current: app.getVersion() }; }
  });
  ipcMain.handle('chrona:logs', () => shell.openPath(logFile));
  ipcMain.handle('chrona:install', async () => {
    if (busy) return { error: 'An update is already running.' };
    busy = true;
    try {
      if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) throw new Error('Use the Chrona setup installer to enable application updates.');
      const result = await releases.latest(app.getVersion());
      if (!result.available) throw new Error('You already have the latest stable version.');
      if (!result.release.asset) throw new Error('This release does not yet have an update package for your computer.');
      const install = path.dirname(process.execPath);
      if (!(await readJson(path.join(install, pkg.MANIFEST)))) throw new Error('Please install Chrona with the setup installer first.');
      const workspace = await fs.mkdtemp(path.join(path.dirname(install), '.chrona-update-'));
      const staged = path.join(workspace, 'staged');
      await pkg.download(result.release.asset, path.join(workspace, 'update.zip'), progress);
      progress({ stage: 'Extracting and verifying update', percent: 100 });
      await pkg.unpack(path.join(workspace, 'update.zip'), staged);
      await pkg.validate(staged, result.release.version);
      // Copy the known running application, not untrusted new code, for the helper.
      progress({ stage: 'Preparing separate updater', percent: 100 });
      const helper = path.join(workspace, 'helper');
      const manifest = await readJson(path.join(install, pkg.MANIFEST));
      for (const file of [...Object.keys(manifest.files), pkg.MANIFEST]) {
        pkg.safeRelative(file); const dest = path.join(helper, file);
        await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(path.join(install, file), dest);
      }
      await pkg.validate(helper, app.getVersion());
      const token = crypto.randomUUID();
      const launcherPids = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='Chrona.exe'\" | Where-Object { $_.ExecutablePath -eq $env:CHRONA_LAUNCHER_PATH } | Select-Object -ExpandProperty ProcessId"],
        { windowsHide: true, env: { ...process.env, CHRONA_LAUNCHER_PATH: path.join(install, 'Chrona.exe') } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim().split(/\s+/).map(Number).filter(value => value > 0))));
      const job = { install, workspace, staged, backup: path.join(workspace, 'backup'), journal: path.join(workspace, 'journal.json'),
        data, logFile, parentPid: process.pid, waitPids: [...new Set([process.pid, ...launcherPids])], release: result.release, token, health: path.join(data, `update-health-${token}.json`), darkMode: !!getSettings().darkMode };
      const jobFile = path.join(workspace, 'job.json'); await atomicJson(jobFile, job);
      await save();
      const child = spawn(path.join(helper, 'ChronaUpdater.exe'), ['--chrona-updater', jobFile], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      // Do not close until the helper has successfully initialized its UI.
      const deadline = Date.now() + 20000;
      let exit = null;
      child.once('exit', (code, signal) => { exit = { code, signal }; });
      while (!(await readJson(path.join(workspace, 'ready.json')))) {
        if (exit) {
          const detail = (await fs.readFile(logFile, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).at(-1);
          throw new Error(detail || `The updater process exited before starting (code ${exit.code ?? 'unknown'}${exit.signal ? `, ${exit.signal}` : ''}).`);
        }
        if (Date.now() > deadline) throw new Error('The updater could not start. Your installation has not changed.');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      progress({ stage: 'Restarting to install update', percent: 100 });
      if (launcherPids.some(pid => pid !== process.pid)) {
        const closer = spawn(path.join(install, 'Chrona.exe'), ['--chrona-quit-for-update', `--user-data-dir=${data}`], { detached: true, stdio: 'ignore', windowsHide: true });
        await new Promise((resolve, reject) => { closer.once('spawn', resolve); closer.once('error', reject); }); closer.unref();
      }
      setTimeout(() => app.quit(), 300);
      return { started: true };
    } catch (error) { busy = false; await log(error); return { error: error.message }; }
  });
}
module.exports = { registerUpdates };
