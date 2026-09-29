const path = require('path');
const { execFile } = require('child_process');

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
const literal = (value) => `'${value.replace(/'/g, "''")}'`;

async function offerDefenderExclusion(dialog, parent, folders, enabled = true) {
  if (process.platform !== 'win32' || !folders.length) return;
  const selected = [...new Set(folders.map(folder => path.resolve(folder)))];
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'Microsoft Defender exclusion',
    message: enabled ? 'Exclude these folders from Microsoft Defender scanning?' : 'Remove Defender exclusions for these folders?',
    detail: `${selected.join('\n')}\n\n${enabled ? 'Defender will no longer scan files in these folders, including future downloads and subfolders. Only exclude folders you trust.' : 'The exact exclusions for these folders will be removed.'} Windows will ask for administrator approval.`,
    buttons: [enabled ? 'Keep scanning' : 'Cancel', enabled ? 'Exclude folders' : 'Remove exclusions'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (response !== 1) return;

  // Encode the script and quote paths as PowerShell literals so folder names
  // cannot become commands. Only this short-lived helper is elevated.
  const script = encode(`$ErrorActionPreference = 'Stop'
try {
  $folders = @(${selected.map(literal).join(', ')})
  ${enabled ? 'Add' : 'Remove'}-MpPreference -ExclusionPath $folders
  $actual = @((Get-MpPreference).ExclusionPath)
  foreach ($folder in $folders) {
    if ($actual ${enabled ? '-notcontains' : '-contains'} $folder) { throw 'Exclusion change was not confirmed.' }
  }
  exit 0
} catch { exit 1 }`);
  const command = encode(`$ErrorActionPreference = 'Stop'
try {
  $child = Start-Process -FilePath "$PSHOME\\powershell.exe" -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${script}' -Wait -PassThru
  exit $child.ExitCode
} catch { exit 1 }`);
  try {
    await new Promise((resolve, reject) => {
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', command],
        { windowsHide: true }, error => error ? reject(error) : resolve());
    });
    await dialog.showMessageBox(parent, {
      type: 'info', title: 'Defender exclusions updated',
      message: enabled ? 'Microsoft Defender exclusions were added.' : 'Microsoft Defender exclusions were removed.',
      detail: selected.join('\n')
    });
    return true;
  } catch {
    await dialog.showMessageBox(parent, {
      type: 'warning', title: 'Defender exclusions not confirmed',
      message: 'Could not confirm the Defender exclusions.',
      detail: 'Administrator approval may have been canceled, or Windows security settings may prevent changes. Your folder selection was saved. Check Windows Security → Virus & threat protection → Manage settings → Exclusions for the current exclusions.'
    });
  }
}

async function foldersAreExcluded(folders) {
  if (process.platform !== 'win32' || !folders.length) return false;
  const script = encode(`$ErrorActionPreference = 'Stop'; try { $actual = @((Get-MpPreference).ExclusionPath); $folders = @(${folders.map(folder => literal(path.resolve(folder))).join(', ')}); foreach ($folder in $folders) { if ($actual -notcontains $folder) { exit 1 } }; exit 0 } catch { exit 1 }`);
  return new Promise(resolve => {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', script],
      { windowsHide: true, timeout: 15000 }, error => resolve(!error));
  });
}

module.exports = { offerDefenderExclusion, foldersAreExcluded };
