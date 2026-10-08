const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DownloadHistory } = require('./download-history');
async function fixture(t, install) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-download-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); return fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'game.zip'); await fs.writeFile(file, 'downloaded archive');
  let store = { pendingDownloads: [], downloadHistory: [{ id: 'saved', file, complete: true, status: 'failed', expectedBytes: 18, installRoot: root,
    game: { name: 'Example', downloadVersion: { provider: 'ankergames.net', sourceUrl: 'https://ankergames.net/game/example', version: '1.3', build: '100' } } }] };
  const state = path.join(root, 'history.json');
  const history = new DownloadHistory({ getStore: () => store, save: () => fs.writeFile(state, JSON.stringify(store)), install });
  return { history, file, state, get store() { return store; }, restart: async () => { store = JSON.parse(await fs.readFile(state)); await history.initialize(); } };
}
test('failed installation survives restart and reuses original file and Anker version', async t => {
  const attempts = [];
  const f = await fixture(t, async (file, game) => { attempts.push({ file, metadata: game.downloadVersion }); if (attempts.length === 1) throw new Error('Disk temporarily unavailable'); });
  await assert.rejects(f.history.installSaved('saved'), /Disk temporarily unavailable/);
  await f.restart(); await f.history.installSaved('saved');
  assert.equal(attempts[0].file, attempts[1].file);
  assert.deepEqual(attempts[1].metadata, { provider: 'ankergames.net', sourceUrl: 'https://ankergames.net/game/example', version: '1.3', build: '100' });
  assert.equal(f.history.find('saved').status, 'installed');
  assert.equal(await fs.readFile(f.file, 'utf8'), 'downloaded archive');
});
test('partial and missing files cannot be installed', async t => {
  let attempts = 0; const f = await fixture(t, async () => { attempts++; });
  f.history.find('saved').complete = false;
  await assert.rejects(f.history.installSaved('saved'), /incomplete/);
  f.history.find('saved').complete = true; await fs.unlink(f.file);
  await assert.rejects(f.history.installSaved('saved'), /missing/);
  assert.equal(attempts, 0);
});
test('legacy pending installs migrate without losing metadata or duplicating entries', async t => {
  const f = await fixture(t, async () => {});
  const original = f.history.find('saved');
  f.store.downloadHistory = [];
  f.store.pendingDownloads = [{ ...original, retryId: 'saved' }];
  await f.history.initialize(); await f.history.initialize();
  assert.equal(f.history.entries.length, 1);
  assert.deepEqual(f.history.find('saved').game.downloadVersion, original.game.downloadVersion);
  assert.equal(f.history.find('saved').complete, true);
});
test('concurrent retry clicks do not launch multiple installations', async t => {
  let finish; const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const first = f.history.installSaved('saved');
  await assert.rejects(f.history.installSaved('saved'), /already running/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(); await first;
});
test('restart recovers an exact-size provider file saved under its original name', async t => {
  const f = await fixture(t, async () => {});
  const entry = f.history.find('saved');
  const providerFile = path.join(path.dirname(f.file), 'provider-game.zip');
  await fs.writeFile(providerFile, 'downloaded archive');
  entry.file = path.join(path.dirname(f.file), 'missing-managed-game.zip');
  entry.downloadRoot = path.dirname(f.file); entry.filename = 'provider-game.zip';
  entry.complete = false; entry.status = 'downloading'; entry.receivedBytes = 0;
  await f.history.initialize();
  assert.equal(entry.file, providerFile);
  assert.equal(entry.complete, true);
  assert.equal(entry.status, 'ready');
  assert.equal(entry.receivedBytes, 18);
});
test('retry recovers a complete record whose managed file was removed', async t => {
  const attempts = []; const f = await fixture(t, async file => attempts.push(file));
  const entry = f.history.find('saved');
  const providerFile = path.join(path.dirname(f.file), 'provider-game.zip');
  await fs.writeFile(providerFile, 'downloaded archive');
  entry.file = path.join(path.dirname(f.file), 'deleted-managed-game.zip');
  entry.downloadRoot = path.dirname(f.file); entry.filename = 'provider-game.zip';
  entry.complete = true; entry.status = 'failed'; entry.error = 'The saved download is missing.';
  await f.history.installSaved('saved');
  assert.deepEqual(attempts, [providerFile]);
  assert.equal(entry.status, 'installed');
});
