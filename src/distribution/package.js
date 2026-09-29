const disk = require('./disk');
const fs = disk.promises;
const { createReadStream, createWriteStream } = disk;
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const extract = require('extract-zip');
const { readJson } = require('./storage');
const MANIFEST = 'chrona-package.json';
const reserved = /^(user-data|userdata|data|logs|\.update|\.backup|library\.json|settings\.json|profile\.json|uninstall.*)(\/|$)/i;
function safeRelative(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes(':') || file.includes('\0') || path.posix.isAbsolute(file) || file.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || reserved.test(file)) throw new Error(`Unsafe application package path: ${file}`);
  return file;
}
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const part of createReadStream(file)) digest.update(part);
  return digest.digest('hex');
}
async function listFiles(root, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Application packages cannot contain links.');
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error('Unsupported package entry.');
  }
  return files;
}
async function validate(root, version, exact = true) {
  const manifest = await readJson(path.join(root, MANIFEST));
  if (!manifest || manifest.version !== version || manifest.platform !== 'win32' || manifest.arch !== process.arch || !manifest.files || Array.isArray(manifest.files)) throw new Error('The update package does not match this Chrona version or architecture.');
  if (!manifest.files['Chrona.exe'] || !manifest.files['resources/app.asar']) throw new Error('The update package is missing Chrona.');
  const seen = new Set();
  for (const [file, expected] of Object.entries(manifest.files)) {
    safeRelative(file);
    if (seen.has(file.toLowerCase()) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid application file manifest.');
    seen.add(file.toLowerCase());
    const target = path.join(root, file);
    // Reject junctions/symlinks at every level, including parent directories.
    let cursor = root;
    for (const part of file.split('/')) {
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Linked application files are not supported.');
    }
    if (await hash(target) !== expected) throw new Error(`Application integrity check failed: ${file}`);
  }
  if (exact) {
    const actual = await listFiles(root);
    if (actual.some(file => file !== MANIFEST && !Object.hasOwn(manifest.files, file))) throw new Error('The package contains unlisted files.');
  }
  return manifest;
}
async function download(asset, target, progress) {
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(`/${require('../../package.json').chronaUpdates.repository}/releases/download/`)) throw new Error('Untrusted release download URL.');
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 4 * 1024 ** 3) throw new Error('Invalid release download size.');
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error('Could not download the update.');
  let received = 0;
  const digest = crypto.createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > asset.size) return callback(new Error('Download exceeds its expected size.'));
    digest.update(chunk); progress({ stage: 'Downloading update', percent: Math.round(received / asset.size * 100) });
    callback(null, chunk);
  } }), createWriteStream(target, { flags: 'wx' }));
  if (received !== asset.size) throw new Error('The update download is incomplete.');
  if (asset.sha256 && digest.digest('hex') !== asset.sha256) throw new Error('The update checksum did not match.');
}
async function unpack(archive, destination) {
  let expanded = 0; const seen = new Set();
  await extract(archive, { dir: destination, onEntry(entry) {
    const name = entry.fileName.replace(/\/$/, '');
    safeRelative(name);
    if (seen.has(name.toLowerCase())) throw new Error('Duplicate archive entry.');
    seen.add(name.toLowerCase());
    if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('Archive links are not allowed.');
    expanded += entry.uncompressedSize;
    if (expanded > 8 * 1024 ** 3 || seen.size > 50000) throw new Error('The expanded update is too large.');
  } });
}
module.exports = { MANIFEST, safeRelative, hash, listFiles, validate, download, unpack };
