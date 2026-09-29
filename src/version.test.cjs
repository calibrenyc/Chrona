const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('./main.js'), 'utf8');
function harness(games, latest) {
  const writes = [];
  const context = vm.createContext({ URL, store: { games }, fs: { writeFile: async (...args) => writes.push(args) }, path: require('node:path'), saveStore: async () => {} });
  vm.runInContext(source.slice(source.indexOf('const VERSION_FILE'), source.indexOf('let checkingUpdates')), context);
  context.latest = latest;
  vm.runInContext('readAnkerVersion = async () => latest', context);
  return { context, writes };
}
const metadata = { provider: 'ankergames.net', sourceUrl: 'https://ankergames.net/game/example/', version: '1.0', build: '100' };
test('leaves untracked and non-portable games alone', async () => {
  for (const game of [{ id: 'a', source: 'Portable' }, { id: 'b', source: 'Steam', ankerVersion: metadata }]) {
    const { context } = harness([game], { ...metadata, version: '2.0' });
    assert.equal((await context.checkPortableUpdate(game)).hasUpdate, false);
    assert.equal(game.updateInfo, undefined);
  }
});
test('compares installed version and downloadable build', async () => {
  const game = { id: 'a', source: 'Portable', ankerVersion: metadata };
  const { context } = harness([game], { ...metadata, version: 'v1.0' });
  assert.equal((await context.checkPortableUpdate(game)).hasUpdate, false);
  context.latest = { ...metadata, build: '101' };
  assert.equal((await context.checkPortableUpdate(game)).hasUpdate, true);
  assert.equal(game.ankerVersion.version, '1.0');
});
test('successful installation writes a version file and clears notification', async () => {
  const game = { installPath: 'C:\\Games\\Example', updateInfo: { hasUpdate: true } };
  const { context, writes } = harness([], metadata);
  await context.recordInstalledVersion(game, metadata);
  assert.equal(writes.length, 1);
  assert.ok(writes[0][0].endsWith('.chrona-version.json'));
  assert.equal(JSON.parse(writes[0][1]).version, '1.0');
  assert.equal(game.currentVersion, '1.0');
  assert.equal(game.updateInfo, undefined);
});
test('rejects unrelated source URLs', () => {
  const { context } = harness([], metadata);
  assert.equal(context.ankerPage('https://ankergames.net.evil.test/game/example'), '');
  assert.equal(context.ankerPage('https://example.com/game/example'), '');
});
