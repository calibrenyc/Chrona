// Run with Electron, not Node. All writes are confined to .qa/profiles.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const version = require('../package.json').version;
const mode = process.argv[2] || 'fresh';
const root = path.resolve('.qa', 'profiles', `${mode}-${Date.now()}`);
const data = path.join(root, 'chrona-game-launcher');
app.setPath('appData', root);
app.getVersion = () => require('../package.json').version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await fs.mkdir(data, { recursive: true });
  if (mode !== 'fresh') {
    await fs.writeFile(path.join(data, 'library.json'), JSON.stringify({ version: 1, games: [], addedLocations: [], settings: { darkMode: true }, lastRunVersion: '1.1.0' }));
    await fs.writeFile(path.join(data, 'pending-release.json'), JSON.stringify({ version: version, title: `Chrona ${version}`, published: '2026-09-19T12:00:00Z', notes: '## New\n- GitHub release updates\n- Guided setup\n\n## Improved\n- Your settings stay with you\n\n## Fixed\n- Safe application replacement\n<script>throw new Error("unsafe")</script>' }));
  }
  // Deterministic offline release lookup, no network requests from update checks.
  require('../src/distribution/releases').latest = async () => ({ current: version, available: false });
  require('../src/main');
  await app.whenReady();
  let win;
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await pause(100); }
  assert.ok(win);
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  for (let i = 0; i < 150; i++) {
    if (await win.webContents.executeJavaScript('document.querySelector("#welcomeScreen")?.classList.contains("is-done")').catch(() => false)) break;
    await pause(100);
  }
  await pause(800);
  const run = js => win.webContents.executeJavaScript(js);
  const title = await run('document.querySelector("#distributionTitle").textContent');
  assert.equal(title, mode === 'fresh' ? 'Welcome to Chrona' : "What's new");
  assert.equal(await run('document.querySelector(".app-shell").inert'), true);
  await fs.mkdir(path.resolve('.qa', 'screenshots'), { recursive: true });
  await fs.writeFile(path.resolve('.qa', 'screenshots', `${mode}.png`), (await win.webContents.capturePage()).toPNG());
  if (mode === 'fresh') {
    for (let step = 0; step < 3; step++) { await run('Array.from(document.querySelectorAll("#distributionActions button")).find(b => b.textContent === "Continue").click()'); await pause(150); }
    await fs.writeFile(path.resolve('.qa', 'screenshots', 'preferences.png'), (await win.webContents.capturePage()).toPNG());
    await run('document.querySelectorAll(".setup-preference input")[2].click()');
    await run('Array.from(document.querySelectorAll("#distributionActions button")).find(b => b.textContent === "Launch Chrona").click()');
  } else await run('document.querySelector("#distributionActions button").click()');
  await pause(700);
  if (!(await run('document.querySelector("#distributionGate").hidden'))) console.log(await run('document.querySelector("#distributionBody").innerText'));
  assert.equal(await run('document.querySelector("#distributionGate").hidden'), true);
  const saved = JSON.parse(await fs.readFile(path.join(data, 'library.json'), 'utf8'));
  assert.equal(saved.setupCompleted, true);
  assert.equal(saved.lastSeenReleaseNotes, version);
  assert.equal((await run('window.launcher.chronaStartup()')).release, null);
  assert.deepEqual(errors, []);
  console.log(`PASS ${mode}: splash, gate, persistence, acknowledgement, renderer errors`);
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
