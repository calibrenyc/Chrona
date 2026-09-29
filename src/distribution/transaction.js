const fs = require('./disk').promises;
const path = require('node:path');
const { atomicJson, readJson } = require('./storage');
const { MANIFEST, safeRelative, validate } = require('./package');
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function inside(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Update path escapes its workspace.');
}
async function safeTarget(root, relative) {
  safeRelative(relative);
  const target = path.join(root, relative); inside(root, target);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) throw new Error('An update path contains a filesystem link.');
  }
  return target;
}
// Each intent is persisted before its rename. Recovery also handles a power loss
// between the rename and its acknowledgement by inspecting both locations.
async function rollback(job, journal) {
  const errors = [];
  for (const operation of [...journal.operations].reverse()) {
    try {
      const target = await safeTarget(job.install, operation.file);
      const saved = await safeTarget(operation.kind === 'backup' ? job.backup : job.staged, operation.file);
      if (operation.kind === 'install') {
        if (await exists(target) && !(await exists(saved))) { await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.rename(target, saved); }
      } else if (await exists(saved)) {
        if (await exists(target)) throw new Error(`Recovery destination is occupied: ${operation.file}`);
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(saved, target);
      }
    } catch (error) { errors.push(error.message); }
  }
  journal.status = errors.length ? 'recovery-required' : 'restored';
  await atomicJson(job.journal, journal);
  if (errors.length) throw new Error(`Backup retained at ${job.backup}. Recovery needs attention: ${errors.join('; ')}`);
}
async function replace(job, progress, launchAndVerify) {
  inside(job.workspace, job.backup); inside(job.workspace, job.staged); inside(job.workspace, job.journal);
  if (path.resolve(job.install) === path.parse(path.resolve(job.install)).root) throw new Error('Cannot update a drive root.');
  const previous = await readJson(job.journal);
  if (previous && !['committed', 'restored'].includes(previous.status)) await rollback(job, previous);
  const incoming = await validate(job.staged, job.release.version);
  const current = await readJson(path.join(job.install, MANIFEST));
  if (!current?.files || !current.files['Chrona.exe']) throw new Error('Install Chrona using its setup program before updating.');
  const oldFiles = [...Object.keys(current.files), MANIFEST];
  const newFiles = [...Object.keys(incoming.files), MANIFEST];
  for (const file of new Set([...oldFiles, ...newFiles])) await safeTarget(job.install, file);
  // Never overwrite files that were not owned by the previous package.
  for (const file of newFiles) if (!oldFiles.includes(file) && await exists(path.join(job.install, file))) throw new Error(`An unmanaged file conflicts with the update: ${file}`);
  await fs.mkdir(job.backup, { recursive: true });
  const journal = { status: 'replacing', operations: [] };
  await atomicJson(job.journal, journal);
  let count = 0;
  async function move(kind, file, from, to) {
    journal.operations.push({ kind, file }); await atomicJson(job.journal, journal);
    await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to);
    progress({ stage: kind === 'backup' ? 'Backing up Chrona' : 'Installing Chrona', percent: Math.round(++count / (oldFiles.length + newFiles.length) * 80) });
  }
  try {
    for (const file of oldFiles) if (await exists(path.join(job.install, file))) await move('backup', file, path.join(job.install, file), path.join(job.backup, file));
    for (const file of newFiles) await move('install', file, path.join(job.staged, file), path.join(job.install, file));
    progress({ stage: 'Verifying installation', percent: 85 });
    await validate(job.install, job.release.version, false);
    await launchAndVerify();
    journal.status = 'committed'; await atomicJson(job.journal, journal);
    progress({ stage: 'Chrona is ready', percent: 100 });
  } catch (error) {
    progress({ stage: 'Restoring your previous installation', percent: 0 });
    try { await rollback(job, journal); } catch (recovery) { throw new Error(`${error.message}\n${recovery.message}`); }
    throw error;
  }
}
module.exports = { replace, rollback, inside, safeTarget };
