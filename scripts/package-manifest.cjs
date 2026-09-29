const fs = require('node:fs/promises');
const path = require('node:path');
const { listFiles, hash, MANIFEST, safeRelative } = require('../src/distribution/package');
module.exports = async context => {
  const root = context.appOutDir;
  await fs.copyFile(path.join(root, 'Chrona.exe'), path.join(root, 'ChronaUpdater.exe'));
  const files = {};
  for (const file of await listFiles(root)) {
    if (file === MANIFEST) continue;
    safeRelative(file); files[file] = await hash(path.join(root, file));
  }
  await fs.writeFile(path.join(root, MANIFEST), JSON.stringify({ version: context.packager.appInfo.version, platform: 'win32', arch: ['ia32', 'x64', 'armv7l', 'arm64'][context.arch], files }, null, 2));
};
