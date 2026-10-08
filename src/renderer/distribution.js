/* The splash stays in front until this gate has chosen setup, notes, or home. */
const distributionGate = document.querySelector('#distributionGate');
const distributionBody = document.querySelector('#distributionBody');
const distributionTitle = document.querySelector('#distributionTitle');
const distributionSubtitle = document.querySelector('#distributionSubtitle');
const distributionActions = document.querySelector('#distributionActions');
let setupDraft, setupStep = 0;
const textNode = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
function action(label, handler, primary = false) {
  const button = textNode('button', label, primary ? 'primary' : '');
  button.onclick = async () => { button.disabled = true; try { await handler(); } catch (error) { distributionBody.append(textNode('p', error.message, 'distribution-error')); } finally { button.disabled = false; } };
  distributionActions.append(button); return button;
}
function gate(title, subtitle) {
  distributionTitle.textContent = title; distributionSubtitle.textContent = subtitle;
  distributionBody.replaceChildren(); distributionActions.replaceChildren();
  distributionGate.hidden = false; document.querySelector('.app-shell').inert = true;
}
function closeGate() { distributionGate.hidden = true; document.querySelector('.app-shell').inert = false; }
function notes(release, afterUpdate = false, current = '') {
  gate(afterUpdate ? "What's new" : 'An update is ready', `CHRONA ${release.version} · ${release.title}`);
  if (current) distributionBody.append(textNode('p', `Current version ${current} → New version ${release.version}`, 'release-date'));
  if (release.published) distributionBody.append(textNode('p', new Date(release.published).toLocaleDateString(), 'release-date'));
  // Release bodies are untrusted. Render Markdown headings/lists as text, never HTML.
  const body = document.createElement('div'); body.className = 'release-notes';
  for (const line of release.notes.split('\n')) {
    body.append(textNode(/^#{1,6}\s/.test(line) ? 'h3' : 'p', line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '• ')));
  }
  distributionBody.append(body);
  if (afterUpdate) action('Continue to Chrona', async () => { await window.launcher.acknowledgeRelease(); closeGate(); }, true);
  else {
    action('Later', closeGate);
    action('Download and update', installUpdate, true);
  }
}
async function installUpdate() {
  gate('Updating Chrona', 'Your library, accounts, and preferences will be preserved.');
  const progress = document.createElement('progress'); progress.id = 'chronaUpdateProgress'; progress.max = 100; progress.value = 0;
  distributionBody.append(progress, textNode('p', 'Preparing download…', 'update-stage'));
  const result = await window.launcher.installChronaUpdate();
  if (result.error) {
    gate("Chrona couldn't finish updating", 'Your existing installation has not been changed.');
    distributionBody.append(textNode('p', result.error, 'distribution-error'));
    action('Launch Current Version', closeGate); action('View Details', () => window.launcher.openUpdateLog()); action('Retry Update', installUpdate, true);
  }
}
window.launcher.onChronaProgress(value => {
  const progress = document.querySelector('#chronaUpdateProgress');
  if (progress) { progress.value = value.percent; document.querySelector('.update-stage').textContent = `${value.stage} · ${value.percent}%`; }
});
async function checkChronaUpdate(automatic = false) {
  const result = await window.launcher.checkChronaUpdate();
  if (result.available && distributionGate.hidden) {
    if (result.release.asset) notes(result.release, false, result.current);
    else if (!automatic) { gate('Update package is not ready', `Chrona ${result.release.version} has been published, but the Windows package is still missing.`); action('Continue to Chrona', closeGate, true); }
  } else if (!automatic) {
    gate(result.error ? 'Could not check for updates' : 'You’re up to date', result.error || `You’re running Chrona ${result.current}.`);
    action('Continue to Chrona', closeGate, true);
  }
}
function setupCheckbox(label, key, initial) {
  const row = document.createElement('label'); row.className = 'setup-preference';
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = initial;
  input.onchange = () => { setupDraft[key] = input.checked; if (key === 'darkMode') document.body.dataset.theme = input.checked ? 'dark' : 'light'; };
  row.append(input, document.createTextNode(label)); distributionBody.append(row);
}
function drawSetup() {
  const steps = ['Welcome to Chrona', 'Game locations', 'Steam libraries', 'Your preferences'];
  gate(steps[setupStep], `SETUP ${setupStep + 1} OF ${steps.length} · Your games, together.`);
  if (setupStep === 0) distributionBody.append(textNode('p', 'Choose your libraries and make Chrona yours. You can change these choices in Settings at any time.'));
  if (setupStep === 1 || setupStep === 2) {
    const key = setupStep === 2 ? 'steam' : 'folders';
    distributionBody.append(textNode('p', key === 'steam' ? 'Steam and its configured libraries are detected automatically. Select the Steam installation or a Steam library root to add another.' : 'Add folders containing your games. Chrona also detects Epic installations during its library scan.'));
    const list = document.createElement('div'); list.className = 'setup-folders';
    setupDraft[key].forEach(folder => {
      const row = document.createElement('div'); row.append(textNode('span', folder));
      const remove = textNode('button', 'Remove'); remove.onclick = () => { setupDraft[key] = setupDraft[key].filter(item => item !== folder); drawSetup(); }; row.append(remove); list.append(row);
    });
    if (!setupDraft[key].length) list.append(textNode('p', 'No folders selected. You can add one now or continue.'));
    distributionBody.append(list);
    action('+ Add Folder', async () => { const folder = await window.launcher.pickSetupFolder(); if (folder && !setupDraft[key].includes(folder)) setupDraft[key].push(folder); drawSetup(); });
    action('Rescan', async () => { const found = await window.launcher.detectSetupLibraries(); setupDraft[key] = [...new Set([...setupDraft[key], ...found[key]])]; drawSetup(); });
  }
  if (setupStep === 3) {
    setupCheckbox('Use dark appearance', 'darkMode', setupDraft.darkMode);
    setupCheckbox('Scan libraries when Chrona starts', 'scanOnStartup', setupDraft.scanOnStartup);
    setupCheckbox('Find my games after setup', 'scanNow', setupDraft.scanNow);
  }
  if (setupStep > 0) action('Back', () => { setupStep--; drawSetup(); });
  action(setupStep === 3 ? 'Launch Chrona' : 'Continue', async () => {
    if (setupStep < 3) { setupStep++; drawSetup(); }
    else { await refresh(await window.launcher.completeSetup(setupDraft)); closeGate(); void checkChronaUpdate(true); }
  }, true);
}
document.querySelector('#checkChronaUpdate')?.addEventListener('click', () => checkChronaUpdate().catch(error => { gate('Could not check for updates', error.message); action('Continue to Chrona', closeGate); }));
async function startChrona() {
  try {
    const startup = await window.launcher.chronaStartup();
    document.querySelector('#chronaVersion').textContent = `Version ${startup.version}`;
    document.body.dataset.theme = startup.settings.darkMode ? 'dark' : 'light';
    if (startup.setupRequired) {
      setupDraft = { folders: [...startup.locations], steam: [...startup.settings.steamLibraryFolders], darkMode: startup.settings.darkMode, scanOnStartup: startup.settings.scanOnStartup, scanNow: true };
      const detected = await window.launcher.detectSetupLibraries().catch(() => ({ steam: [], folders: [] }));
      setupDraft.steam = [...new Set([...setupDraft.steam, ...detected.steam])];
      drawSetup();
    } else if (startup.release) notes(startup.release, true);
    await window.launcher.chronaReady();
    await new Promise(resolve => setTimeout(resolve, 1800));
    document.querySelector('#welcomeScreen').classList.add('is-done');
    document.body.classList.add('has-entered');
    if (!startup.setupRequired && !startup.release) void checkChronaUpdate(true);
  } catch (error) {
    gate('Chrona needs your attention', error.message);
    action('Try again', startChrona, true);
    document.querySelector('#welcomeScreen').classList.add('is-done');
  }
}
void startChrona();
