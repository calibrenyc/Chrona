// Use credentials from the environment/Windows store; never write private keys
// or certificate passwords to the repository or print them in build arguments.
const { build, Platform, Arch } = require('electron-builder');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
(async () => {
  if (!process.env.WIN_CSC_LINK && !process.env.CSC_LINK && !process.env.CHRONA_CERT_THUMBPRINT) {
    throw new Error('Configure WIN_CSC_LINK / CSC_LINK or CHRONA_CERT_THUMBPRINT before building a signed release.');
  }
  const thumbprint = process.env.CHRONA_CERT_THUMBPRINT;
  if (thumbprint && !/^[a-f0-9]{40}$/i.test(thumbprint)) throw new Error('CHRONA_CERT_THUMBPRINT must be a 40-character certificate thumbprint.');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'installer-art.ps1')], { stdio: 'inherit' });
  await build({ targets: Platform.WINDOWS.createTarget(['nsis', 'zip'], Arch.x64), config: {
    extends: null,
    ...require('../package.json').build,
    forceCodeSigning: true,
    win: { ...require('../package.json').build.win, signExecutable: true,
      signtoolOptions: { signingHashAlgorithms: ['sha256'], ...(thumbprint ? { certificateSha1: thumbprint } : {}) } }
  }, publish: 'never' });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
