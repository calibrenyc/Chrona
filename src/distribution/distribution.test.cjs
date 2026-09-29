const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const semver = require('semver');
const { stableVersion, normalizeRelease } = require('./releases');
const { safeRelative, hash, validate, download, unpack, MANIFEST } = require('./package');
const { atomicJson, validStore, recoverLibraryFromBackup } = require('./storage');
const { replace, rollback } = require('./transaction');
test('stable semantic versions exclude previews and compare numerically', () => {
  assert.equal(stableVersion('v1.10.0'), '1.10.0');
  for (const version of ['1.0', '1.2.0-beta.1', 'garbage', '01.0.0']) assert.equal(stableVersion(version), null);
  assert.ok(semver.gt(stableVersion('v1.10.0'), '1.9.0'));
  assert.ok(!semver.gt('1.0.0', '2.0.0'));
});
test('release selection rejects drafts and uses exact platform architecture asset', () => {
  const release = { tag_name: 'v1.2.0', assets: [{ name: 'Chrona-Update-1.2.0-win-x64.zip', state: 'uploaded', size: 10 }] };
  assert.ok(normalizeRelease(release, 'x64').asset);
  assert.equal(normalizeRelease(release, 'arm64').asset, null);
  assert.equal(normalizeRelease({ ...release, prerelease: true }), null);
  assert.equal(normalizeRelease({ ...release, draft: true }), null);
});
test('package paths protect traversal, user data, links and Windows aliases', () => {
  for (const file of ['../Chrona.exe', '/tmp/a', 'C:/a', 'resources/../data', 'user-data/library.json', 'library.json', 'data/games.json', 'a\\b', 'a/CON.txt', 'a/b.', 'a/file:stream']) assert.throws(() => safeRelative(file));
  assert.equal(safeRelative('resources/app.asar'), 'resources/app.asar');
});
test('only a valid legacy configuration counts as an existing user', () => {
  assert.ok(validStore({ games: [], settings: {} }));
  for (const value of [null, [], {}, { games: {}, settings: {} }, { games: [], settings: [] }]) assert.ok(!validStore(value));
});
test('a null-byte library is replaced with the newest valid backup and re-backed up', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-library-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const library = path.join(directory, 'library.json');
  const older = path.join(directory, 'library.json.older.bak');
  const newest = path.join(directory, 'library.json.newest.bak');
  await fs.writeFile(library, Buffer.alloc(1024));
  await atomicJson(older, { games: [{ id: 'old' }], settings: {} });
  await atomicJson(newest, { games: [{ id: 'new' }], settings: {} });
  await fs.utimes(older, new Date(Date.now() - 10000), new Date(Date.now() - 10000));

  const recovery = await recoverLibraryFromBackup(library);
  assert.equal(path.basename(recovery.restoredFrom), path.basename(newest));
  assert.deepEqual(JSON.parse(await fs.readFile(library, 'utf8')).games, [{ id: 'new' }]);
  assert.deepEqual(JSON.parse(await fs.readFile(recovery.recoveryBackup, 'utf8')).games, [{ id: 'new' }]);
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-test-'));
  t.after(async () => {
    // Only remove the exact fixture directory produced by mkdtemp.
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('chrona-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const install = path.join(root, 'installed'), workspace = path.join(root, 'workspace');
  const job = { install, workspace, staged: path.join(workspace, 'staged'), backup: path.join(workspace, 'backup'), journal: path.join(workspace, 'journal.json'), release: { version: '1.2.0' } };
  for (const [dir, version] of [[install, '1.1.0'], [job.staged, '1.2.0']]) {
    const files = {};
    for (const file of ['Chrona.exe', 'resources/app.asar', ...(version === '1.1.0' ? ['obsolete.dll'] : ['new.dll'])]) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), version);
      files[file] = await hash(path.join(dir, file));
    }
    await atomicJson(path.join(dir, MANIFEST), { version, arch: process.arch, platform: 'win32', files });
  }
  await fs.mkdir(path.join(install, 'user-data')); await fs.writeFile(path.join(install, 'user-data/library.json'), 'precious');
  return job;
}
test('full replacement removes obsolete files and preserves unmanaged data', async t => {
  const job = await fixture(t);
  await replace(job, () => {}, async () => {});
  assert.equal(await fs.readFile(path.join(job.install, 'Chrona.exe'), 'utf8'), '1.2.0');
  assert.equal(await fs.readFile(path.join(job.install, 'user-data/library.json'), 'utf8'), 'precious');
  await assert.rejects(fs.access(path.join(job.install, 'obsolete.dll')));
  assert.equal(await fs.readFile(path.join(job.backup, 'Chrona.exe'), 'utf8'), '1.1.0');
});
test('startup failure restores the complete previous installation and can retry', async t => {
  const job = await fixture(t);
  await assert.rejects(replace(job, () => {}, async () => { throw new Error('health timeout'); }), /health timeout/);
  await validate(job.install, '1.1.0', false);
  assert.equal(await fs.readFile(path.join(job.install, 'user-data/library.json'), 'utf8'), 'precious');
  await replace(job, () => {}, async () => {});
  await validate(job.install, '1.2.0', false);
});
test('corrupt package never changes the working installation', async t => {
  const job = await fixture(t); await fs.writeFile(path.join(job.staged, 'Chrona.exe'), 'truncated');
  await assert.rejects(replace(job, () => {}, async () => {}), /integrity/);
  await validate(job.install, '1.1.0', false);
});
test('an unmanaged file conflict is never overwritten', async t => {
  const job = await fixture(t); await fs.writeFile(path.join(job.install, 'new.dll'), 'user-owned');
  await assert.rejects(replace(job, () => {}, async () => {}), /unmanaged/);
  assert.equal(await fs.readFile(path.join(job.install, 'new.dll'), 'utf8'), 'user-owned');
});
test('journal recovers a move interrupted before acknowledgement', async t => {
  const job = await fixture(t); await fs.mkdir(job.backup);
  await fs.rename(path.join(job.install, 'Chrona.exe'), path.join(job.backup, 'Chrona.exe'));
  await rollback(job, { status: 'replacing', operations: [{ kind: 'backup', file: 'Chrona.exe' }] });
  await validate(job.install, '1.1.0', false);
});
test('download rejects truncated and mismatched hash responses', async t => {
  const job = await fixture(t);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const asset = { url: 'https://github.com/calibrenyc/Chrona/releases/download/v1.2.0/update.zip', size: 10 };
  global.fetch = async () => new Response('short');
  await assert.rejects(download(asset, path.join(job.workspace, 'short.zip'), () => {}), /incomplete/);
  global.fetch = async () => new Response('0123456789');
  await assert.rejects(download({ ...asset, sha256: '0'.repeat(64) }, path.join(job.workspace, 'checksum.zip'), () => {}), /checksum/);
  await assert.rejects(download({ ...asset, url: 'https://example.com/update.zip' }, path.join(job.workspace, 'bad.zip'), () => {}), /Untrusted/);
});
test('corrupted archives are rejected during extraction', async t => {
  const job = await fixture(t); const archive = path.join(job.workspace, 'bad.zip');
  await fs.writeFile(archive, 'not a ZIP');
  await assert.rejects(unpack(archive, path.join(job.workspace, 'extracted')));
});
test('symlinked application directories are rejected before replacement', async t => {
  const job = await fixture(t);
  const external = path.join(job.workspace, 'outside');
  await fs.mkdir(external);
  await fs.rename(path.join(job.install, 'resources/app.asar'), path.join(external, 'app.asar'));
  await fs.rmdir(path.join(job.install, 'resources'));
  await fs.symlink(external, path.join(job.install, 'resources'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(replace(job, () => {}, async () => {}), /link/);
  assert.equal(await fs.readFile(path.join(external, 'app.asar'), 'utf8'), '1.1.0');
});
