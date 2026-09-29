const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function validStore(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Array.isArray(value.games) && value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings);
}
async function recoverLibraryFromBackup(libraryFile) {
  const directory = path.dirname(libraryFile);
  const libraryName = path.basename(libraryFile);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const backups = (await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.startsWith(`${libraryName}.`) && entry.name.endsWith('.bak'))
    .map(async entry => ({ file: path.join(directory, entry.name), modified: (await fs.stat(path.join(directory, entry.name))).mtimeMs }))))
    .sort((left, right) => right.modified - left.modified);

  for (const backup of backups) {
    try {
      const saved = JSON.parse(await fs.readFile(backup.file, 'utf8'));
      if (!validStore(saved)) continue;

      // Remove the bad primary file before restoring, then use atomic writes so
      // an interrupted recovery cannot leave a partially-written library.
      await fs.unlink(libraryFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await atomicJson(libraryFile, saved);
      const recoveryBackup = `${libraryFile}.recovered-${Date.now()}.bak`;
      await atomicJson(recoveryBackup, saved);
      return { restoredFrom: backup.file, recoveryBackup };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return null;
}
module.exports = { atomicJson, readJson, validStore, recoverLibraryFromBackup };
