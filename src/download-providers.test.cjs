const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyProvider, packageDefinition, isSupportedGamePackage } = require('./download-providers');

test('accepts game archives and multipart archive names', () => {
  for (const name of ['game.zip', 'GAME.RAR', 'release.7z', 'game.part01.rar', 'game.7z.001']) {
    assert.equal(isSupportedGamePackage(name), true, name);
  }
});

test('rejects setup programs and unrelated downloads', () => {
  for (const name of ['OperaGXSetup.exe', 'setup.msi', 'download.exe', 'offer.crx', 'readme.pdf', '']) {
    assert.equal(isSupportedGamePackage(name), false, name);
  }
});

test('Zeigames uses the standard single-package workflow', () => {
  const provider = classifyProvider('Zeigames');
  assert.equal(provider.packageType, 'MAIN_GAME');
  assert.equal(provider.installBehavior, 'EXTRACT');
  assert.equal(provider.supportsMultipart, false);
});

test('Online Fix remains source-independent and applies after the main game', () => {
  for (const sourceProvider of ['Online-Fix', 'Zeigames', 'ankergames.net', 'Custom Provider']) {
    const definition = packageDefinition({
      packageType: 'ONLINE_FIX', packageRequired: true, installBehavior: 'OVERLAY'
    }, sourceProvider);
    assert.equal(definition.packageType, 'ONLINE_FIX');
    assert.equal(definition.installBehavior, 'OVERLAY');
    assert.equal(definition.dependsOn, 'MAIN_GAME');
    assert.equal(definition.required, true);
  }
});
