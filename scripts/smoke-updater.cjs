// End-to-end real Electron helper test. Does not register an installation or use
// the real user's profile. Fixture and backup are retained under .qa for review.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const assert = require('node:assert/strict');
const { atomicJson, readJson } = require('../src/distribution/storage');
const { validate, MANIFEST } = require('../src/distribution/package');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const root = path.resolve('.qa', `updater-${Date.now()}`);
  const install = path.join(root, 'installed'), workspace = path.join(root, 'workspace'), data = path.join(root, 'profile');
  const token = crypto.randomUUID();
  for (const dest of [install, path.join(workspace, 'staged'), path.join(workspace, 'helper')]) await fs.cp(path.resolve('dist/win-unpacked'), dest, { recursive: true });
  const old = await readJson(path.join(install, MANIFEST)); old.version = '1.1.0'; await atomicJson(path.join(install, MANIFEST), old);
  await atomicJson(path.join(data, 'library.json'), { version: 1, games: [], settings: { darkMode: true, scanOnStartup: false }, addedLocations: [], setupCompleted: true, lastRunVersion: '1.1.0', customSentinel: 'preserve-me' });
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const job = { install, workspace, staged: path.join(workspace, 'staged'), backup: path.join(workspace, 'backup'), journal: path.join(workspace, 'journal.json'), data,
    logFile: path.join(data, 'logs/updater.log'), parentPid: parent.pid, release: { version: require('../package.json').version, title: 'Chrona update smoke test', notes: '## Fixed\n- Safe updates', published: '2026-09-19T12:00:00Z' }, token, health: path.join(data, `update-health-${token}.json`) };
  const jobFile = path.join(workspace, 'job.json'); await atomicJson(jobFile, job);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(workspace, 'helper/ChronaUpdater.exe'), ['--chrona-updater', jobFile], { env, windowsHide: true, stdio: 'pipe' });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  let exitCode; child.on('exit', code => { exitCode = code; });
  try {
    const readyDeadline = Date.now() + 30000;
    while (!(await readJson(path.join(workspace, 'ready.json')))) { if (Date.now() > readyDeadline || exitCode !== undefined) throw new Error('Updater failed to become ready'); await pause(200); }
    assert.equal(await readJson(job.journal), null, 'must not replace a running launcher');
    parent.kill();
    const deadline = Date.now() + 120000;
    while (exitCode === undefined) {
      const log = await fs.readFile(job.logFile, 'utf8').catch(() => '');
      if (log.includes('Error:')) throw new Error(log);
      if (Date.now() > deadline) throw new Error(`Updater timeout: ${JSON.stringify(await readJson(job.journal))}`);
      await pause(300);
    }
    assert.equal(exitCode, 0);
    assert.equal((await readJson(job.journal)).status, 'committed');
    await validate(install, job.release.version, false);
    const store = await readJson(path.join(data, 'library.json'));
    assert.equal(store.customSentinel, 'preserve-me'); assert.equal(store.setupCompleted, true);
    assert.equal((await readJson(job.health)).version, job.release.version);
    console.log(`PASS packaged updater: parent exit, replacement, health receipt, relaunch, data preservation. Fixture: ${root}`);
  } finally {
    parent.kill();
    // Stop only executables in this test fixture, never the user's Chrona.
    await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:CHRONA_TEST_ROOT + '\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, env: { ...process.env, CHRONA_TEST_ROOT: root } }, resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
