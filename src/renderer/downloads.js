const historyList = document.querySelector('#downloadHistoryList');
let savedDownloads = [];
const historyLabels = { downloading: 'Downloading', ready: 'Ready to install', installing: 'Installing', installed: 'Installed · file kept', failed: 'Installation failed', interrupted: 'Incomplete download', cancelled: 'Download cancelled' };
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
    if (entry.complete && entry.status !== 'installed') historyButton(actions, entry.status === 'failed' ? 'Retry installation' : 'Install saved file', () => window.launcher.retryDownload(entry.id), busy || !entry.fileExists);
    historyButton(actions, 'Show file', () => window.launcher.revealDownload(entry.id), !entry.fileExists);
    if (!entry.complete && entry.game?.downloadSourceUrl) historyButton(actions, 'Open download source', async () => {
      await window.launcher.openDownloadBrowser(entry.game.downloadSourceUrl, entry.game);
      document.querySelector('#downloadBrowserBar').hidden = false;
    }, busy);
    historyButton(actions, 'Remove from list', () => window.launcher.dismissDownload(entry.id), busy);
    card.append(actions); historyList.append(card);
  }
}
window.launcher.onDownloadHistoryChanged(() => { void refreshDownloadHistory(); });
document.addEventListener('chrona:downloads-page', () => { void refreshDownloadHistory(); });
document.querySelector('#refreshDownloadHistory').onclick = () => refreshDownloadHistory();
void refreshDownloadHistory();
