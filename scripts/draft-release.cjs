const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { version, chronaUpdates } = require('../package.json');
const { hash } = require('../src/distribution/package');
(async () => {
  const files = [`ChronaSetup-${version}.exe`, `Chrona-Update-${version}-win-x64.zip`];
  const checksums = [];
  for (const file of files) checksums.push(`${await hash(path.resolve('dist', file))}  ${file}`);
  const checksumFile = path.resolve('dist', `Chrona-${version}-SHA256SUMS.txt`);
  await fs.writeFile(checksumFile, checksums.join('\n') + '\n');
  const notes = path.resolve('docs', `release-${version}.md`);
  await fs.access(notes);
  execFileSync('gh', ['release', 'create', `v${version}`, ...files.map(file => path.resolve('dist', file)), checksumFile,
    '--repo', chronaUpdates.repository, '--draft', '--title', `Chrona ${version}`, '--notes-file', notes], { stdio: 'inherit' });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
