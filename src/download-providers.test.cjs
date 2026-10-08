const test = require('node:test');
const assert = require('node:assert/strict');
const { isSupportedGamePackage } = require('./download-providers');

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
