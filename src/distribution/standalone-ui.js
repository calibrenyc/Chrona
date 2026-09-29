const updaterStatus = document.querySelector('#status');
const installButton = document.querySelector('#install');
async function check() {
  updaterStatus.textContent = 'Checking GitHub Releases…';
  const result = await window.chronaUpdater.check();
  updaterStatus.textContent = result.error || (result.available ? `Current ${result.current} → New ${result.release.version}` : `Chrona ${result.current} is up to date.`);
  document.querySelector('#notes').textContent = result.available ? result.release.notes : '';
  installButton.hidden = !result.available || !result.release.asset;
  if (result.available && !result.release.asset) updaterStatus.textContent += ' The Windows update package is not available yet.';
}
installButton.onclick = async () => {
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  document.querySelector('#progress').hidden = false;
  const result = await window.chronaUpdater.install();
  if (result.error) {
    updaterStatus.textContent = result.error;
    document.querySelector('#details').hidden = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
};
window.chronaUpdater.onProgress(value => { updaterStatus.textContent = value.stage; document.querySelector('#progress').value = value.percent; });
document.querySelector('#check').onclick = check;
document.querySelector('#launch').onclick = () => window.chronaUpdater.launch();
document.querySelector('#details').onclick = () => window.chronaUpdater.details();
void check();
