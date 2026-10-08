const historyList = document.querySelector('#downloadHistoryList');
const installationJobsList = document.querySelector('#installationJobsList');
let savedDownloads = [];
let installationJobs = [];
const historyLabels = { downloading: 'Downloading', ready: 'Ready to install', installing: 'Installing', installed: 'Installed · file kept', applied: 'Applied to game', failed: 'Installation failed', interrupted: 'Incomplete download', cancelled: 'Download cancelled' };
function historyElement(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function historyButton(row, label, handler, disabled = false) {
  const button = historyElement('button', label); button.disabled = disabled;
  button.onclick = async () => {
    button.disabled = true; document.querySelector('#downloadHistoryMessage').textContent = '';
    try { await handler(); } catch (error) { document.querySelector('#downloadHistoryMessage').textContent = error.message; }
    finally { await refreshDownloadHistory(); }
  };
  row.append(button);
}
async function refreshDownloadHistory() {
  try { savedDownloads = await window.launcher.getDownloadHistory(); }
  catch (error) { document.querySelector('#downloadHistoryMessage').textContent = error.message; return; }
  historyList.replaceChildren();
  if (!savedDownloads.length) historyList.append(historyElement('div', 'Your downloaded games will appear here. Completed files stay available for installation, even after restarting Chrona.', 'empty'));
  for (const entry of savedDownloads) {
    const card = document.createElement('article'); card.className = 'saved-download';
    const heading = document.createElement('div'); heading.className = 'saved-download-heading';
    heading.append(historyElement('h3', entry.game?.name || 'Downloaded game'), historyElement('span', historyLabels[entry.status] || entry.status, 'platform-pill'));
    card.append(heading, historyElement('p', entry.file, 'saved-download-path'));
    const version = entry.game?.downloadVersion;
    card.append(historyElement('p', version?.provider === 'ankergames.net' ? `AnkerGames · Version ${version.version || 'unknown'}${version.build ? ` · Build ${version.build}` : ''}` : 'Saved game download', 'saved-download-meta'));
    if (entry.error) card.append(historyElement('p', entry.error, 'saved-download-error'));
    if (!entry.fileExists && entry.status !== 'downloading') card.append(historyElement('p', 'File not found. Restore it to the location above to install it.', 'saved-download-error'));
    const actions = document.createElement('div'); actions.className = 'saved-download-actions';
    const busy = ['downloading', 'installing'].includes(entry.status);
    if (entry.complete && !entry.multipartPart && !['installed', 'applied'].includes(entry.status)) historyButton(actions, entry.status === 'failed' ? 'Retry installation' : 'Install saved file', () => window.launcher.retryDownload(entry.id), busy || !entry.fileExists);
    historyButton(actions, 'Show file', () => window.launcher.revealDownload(entry.id), !entry.fileExists);
    if (!entry.complete && entry.game?.downloadSourceUrl) historyButton(actions, 'Open download source', async () => {
      await window.launcher.openDownloadBrowser(entry.game.downloadSourceUrl, entry.game);
      document.querySelector('#downloadBrowserBar').hidden = false;
    }, busy);
    historyButton(actions, 'Delete file', async () => {
      if (!window.confirm(`Delete ${entry.filename || 'this downloaded file'} from your computer and remove it from Chrona?`)) return;
      await window.launcher.dismissDownload(entry.id);
    }, busy);
    card.append(actions); historyList.append(card);
  }
}
const jobLabels = { WAITING_FOR_FILES: 'Waiting for required files', DOWNLOADING: 'Downloading', DOWNLOADED: 'Ready to install', INSTALLING: 'Installing', APPLYING: 'Applying add-on', COMPLETE: 'Installed', FAILED: 'Installation failed' };
const packageLabels = { WAITING: 'Waiting', DOWNLOADING: 'Downloading', DOWNLOADED: 'Downloaded', EXTRACTING: 'Extracting', READY: 'Ready', INSTALLING: 'Installing', APPLYING: 'Applying', COMPLETE: 'Complete', FAILED: 'Failed' };
async function refreshInstallationJobs() {
  let jobs = [];
  try { jobs = await window.launcher.getInstallationJobs(); }
  catch (error) { installationJobsList.textContent = error.message; return; }
  installationJobs = jobs;
  installationJobsList.replaceChildren();
  if (!jobs.length) { installationJobsList.append(historyElement('p', 'Your game packages will be grouped here as you download them.', 'empty')); return; }
  for (const job of jobs) {
    const card = document.createElement('article'); card.className = 'installation-job';
    const heading = document.createElement('div'); heading.className = 'saved-download-heading';
    heading.append(historyElement('h3', job.gameName || 'Game'), historyElement('span', jobLabels[job.status] || job.status || 'Waiting', 'platform-pill'));
    card.append(heading);
    const packages = document.createElement('div'); packages.className = 'installation-job-packages';
    for (const pkg of job.packages || []) {
      const row = document.createElement('div'); row.className = 'installation-job-package';
      const label = document.createElement('div'); label.className = 'installation-job-package-label';
      label.append(historyElement('strong', pkg.name || pkg.type), historyElement('span', pkg.required ? 'Required' : 'Optional', `package-requirement${pkg.required ? ' required' : ''}`));
      row.append(label, historyElement('span', packageLabels[pkg.status] || pkg.status || 'Waiting', 'installation-job-status'));
      if (pkg.status === 'DOWNLOADING' && Number.isFinite(pkg.progress)) {
        const progress = document.createElement('div'); progress.className = 'installation-package-progress';
        const fill = document.createElement('i'); fill.style.width = `${Math.max(0, Math.min(100, pkg.progress))}%`; progress.append(fill); row.append(progress);
        row.append(historyElement('small', `${pkg.progress}% downloaded`));
      }
      if (pkg.expectedParts) row.append(historyElement('small', `${(pkg.parts || []).filter(part => part.status === 'DOWNLOADED').length} / ${pkg.expectedParts} parts`));
      else if (pkg.files?.length) row.append(historyElement('small', `${pkg.files.length} file${pkg.files.length === 1 ? '' : 's'}`));
      if (pkg.files?.length) {
        const fileList = document.createElement('ul'); fileList.className = 'installation-job-files';
        for (const file of pkg.files) fileList.append(historyElement('li', file.name || file.path || 'Downloaded file'));
        row.append(fileList);
      }
      packages.append(row);
    }
    card.append(packages);
    const required = (job.packages || []).filter(pkg => pkg.required);
    if (required.length) {
      const values = required.map(pkg => ['DOWNLOADED', 'READY', 'INSTALLING', 'APPLYING', 'COMPLETE'].includes(pkg.status) ? 100 : Number(pkg.progress) || 0);
      const overall = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
      card.append(historyElement('p', `Overall · ${overall}%`, 'installation-overall-label'));
      const progress = document.createElement('div'); progress.className = 'installation-package-progress overall';
      const fill = document.createElement('i'); fill.style.width = `${overall}%`; progress.append(fill); card.append(progress);
    }
    if (job.installationTarget) card.append(historyElement('p', job.installationTarget, 'saved-download-path'));
    installationJobsList.append(card);
  }
}
window.launcher.onDownloadHistoryChanged(() => { void refreshDownloadHistory(); void refreshInstallationJobs(); });
window.launcher.onInstallationJobsChanged(() => { void refreshInstallationJobs(); });
document.addEventListener('chrona:downloads-page', () => { void refreshDownloadHistory(); });
document.querySelector('#refreshDownloadHistory').onclick = () => refreshDownloadHistory();
document.querySelector('#clearDownloadHistory').onclick = async () => {
  if (!savedDownloads.length && !installationJobs.length) return;
  const detail = savedDownloads.length
    ? `Delete all ${savedDownloads.length} saved download${savedDownloads.length === 1 ? '' : 's'} from your computer and clear all installation entries?`
    : 'Clear all installation entries?';
  if (!window.confirm(detail)) return;
  const button = document.querySelector('#clearDownloadHistory');
  button.disabled = true;
  document.querySelector('#downloadHistoryMessage').textContent = '';
  try { await window.launcher.clearDownloadHistory(); }
  catch (error) { document.querySelector('#downloadHistoryMessage').textContent = error.message; }
  finally { button.disabled = false; await refreshDownloadHistory(); await refreshInstallationJobs(); }
};
void refreshDownloadHistory();
void refreshInstallationJobs();
