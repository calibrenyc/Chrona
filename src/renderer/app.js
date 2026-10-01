let store = null;
let selectedId = null;
let activeSource = 'All';
let query = '';
let activePage = 'home';
let contextGameId = null;
let coverResults = [];
let storeInfo = null;
let storeInfoGameId = null;
let detectedSteamAccounts = [];
let selectedSteamAccountId = '';
let wallpaperDebugMinutes = new Date().getHours() * 60 + new Date().getMinutes();
let activeWallpaperKey = '';

const sourceLabels = ['All', 'Most Recent', 'Steam', 'Epic', 'Ubisoft', 'Xbox', 'Portable', 'Manual'];
const grid = document.querySelector('#grid');
const filters = document.querySelector('#filters');
const contextMenu = document.querySelector('#contextMenu');
const coverModal = document.querySelector('#coverModal');
const catalogModal = document.querySelector('#catalogModal');
const accountModal = document.querySelector('#accountModal');
const gameModal = document.querySelector('#gameModal');
const linksModal = document.querySelector('#linksModal');
const storeDetailModal = document.querySelector('#storeDetailModal');
let activeStoreGame = null;
let linksRequest = 0;
const artGrid = document.querySelector('#artGrid');
const launcherCandidates = document.querySelector('#launcherCandidates');
const importSteamButton = document.querySelector('#importSteamLibrary');
const cancelSteamImportButton = document.querySelector('#cancelSteamImport');
const mainScroller = document.querySelector('main');

document.querySelector('#windowMaximize').textContent = '□';
document.querySelector('#windowClose').textContent = '×';

function currentGames() {
  const games = store.games.filter((game) => {
    const matchesSource = activeSource === 'All' || activeSource === 'Most Recent' || game.source === activeSource;
    const matchesQuery = game.name.toLowerCase().includes(query.toLowerCase());
    return matchesSource && matchesQuery;
  });
  if (activeSource === 'Most Recent') {
    return games
      .filter((game) => game.lastPlayed || game.lastSeen)
      .sort((a, b) => new Date(b.lastPlayed || b.lastSeen) - new Date(a.lastPlayed || a.lastSeen))
      .slice(0, 24);
  }
  return games;
}

function groupedGames() {
  const games = currentGames();
  if (activeSource === 'Most Recent') {
    return [{ title: 'Most Recent', games }];
  }
  const sources = sourceLabels.filter((source) => !['All', 'Most Recent'].includes(source));
  const orderedSources = activeSource === 'All' ? sources : [activeSource];
  const sections = [];
  for (const source of orderedSources) {
    const sourceGames = games.filter((game) => game.source === source);
    const installed = sourceGames
      .filter((game) => game.status !== 'installable')
      .sort((a, b) => a.name.localeCompare(b.name));
    const installable = sourceGames
      .filter((game) => game.status === 'installable')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (installed.length) sections.push({ title: `${source} Installed`, source, status: 'installed', games: installed });
    if (installable.length) sections.push({ title: `${source} Ready To Install`, source, status: 'installable', games: installable });
  }
  return sections;
}

function coverStyle(game) {
  return game.coverUrl ? `style="background-image:url('${game.coverUrl.replaceAll("'", '%27')}')"` : '';
}

function wallpaperPeriod(minutes) {
  const hour = minutes / 60;
  if (hour >= 5 && hour < 11) return 'dawn';
  if (hour >= 11 && hour < 17) return 'day';
  return 'dusk';
}

function bundledWallpaper(period) {
  return `wallpapers/${period}.png`;
}

function setHomeWallpaper(settings, minutes = wallpaperDebugMinutes) {
  const homeArt = document.querySelector('#homeArt');
  const featured = store.games.find(game => game.coverUrl && game.backgroundUrl) || store.games.find(game => game.coverUrl);
  const period = wallpaperPeriod(minutes);
  const fallback = featured?.backgroundUrl || featured?.coverUrl || '';
  const image = settings.homeBackgroundSource === 'transparent'
    ? ''
    : settings.homeBackgroundSource === 'dynamic'
    ? `url("${bundledWallpaper(period)}")${fallback ? `, url("${fallback}")` : ''}`
    : settings.homeBackgroundSource === 'custom' && settings.homeBackgroundPath
      ? `url("file:///${settings.homeBackgroundPath.replaceAll('\\', '/')}")`
      : (settings.homeBackgroundSource === 'game' ? `url("${featured?.backgroundUrl || featured?.coverUrl || ''}")` : `url("${featured?.backgroundUrl || ''}")`);
  const nextImage = settings.homeBackgroundEnabled !== false ? image : '';
  const wallpaperKey = `${settings.homeBackgroundEnabled !== false}|${settings.homeBackgroundSource}|${settings.homeBackgroundPath || ''}|${period}|${fallback}`;
  if (wallpaperKey === activeWallpaperKey) {
    return;
  }
  activeWallpaperKey = wallpaperKey;
  homeArt.style.opacity = '0';
  window.setTimeout(() => {
    homeArt.style.backgroundImage = nextImage ? nextImage : '';
    document.body.style.backgroundImage = nextImage ? nextImage : '';
    const mainSurface = document.querySelector('main');
    mainSurface.style.backgroundImage = nextImage ? nextImage : '';
    mainSurface.style.backgroundPosition = 'center';
    mainSurface.style.backgroundSize = 'cover';
    mainSurface.style.backgroundAttachment = 'fixed';
    homeArt.style.opacity = '1';
  }, 120);
}

function ownerLabel(game) {
  return `Owner: ${game.ownerName || 'Local'}`;
}

function statusLabel(game) {
  return game.status === 'installable' ? 'Ready to install' : 'Installed';
}

function fallbackInitials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function renderFilters() {
  filters.innerHTML = sourceLabels
    .map((source) => {
      const count =
        source === 'All'
          ? store.games.length
          : source === 'Most Recent'
            ? store.games.filter((game) => game.lastPlayed || game.lastSeen).length
            : store.games.filter((game) => game.source === source).length;
      return `<button class="${activePage === 'library' && activeSource === source ? 'active' : ''}" data-source="${source}">
        <span>${source}</span><b>${count}</b>
      </button>`;
    })
    .join('');
}

function renderLocations() {
  document.querySelector('#locationsList').innerHTML = store.addedLocations.length
    ? store.addedLocations.map((location) => `<p title="${location}">${location}</p>`).join('')
    : '<p>Add folders that hold portable installs.</p>';
}

function renderPage() {
  document.body.dataset.page = activePage;
  document.body.classList.toggle('is-browsing', activePage !== 'home');
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === `${activePage}Page`));
  document.querySelectorAll('.app-nav button, .compact-brand').forEach((button) => button.classList.toggle('active', button.dataset.page === activePage));
  if (activePage === 'downloads') document.dispatchEvent(new Event('chrona:downloads-page'));
}

function renderGrid() {
  const games = currentGames();
  const sections = groupedGames();
  const view = ['list', 'compact'].includes(store.settings.defaultView) ? 'list' : 'grid';
  grid.classList.toggle('list-view', view === 'list');
  document.querySelectorAll('[data-library-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.libraryView === view));
  });
  document.querySelector('#count').textContent = `${games.length} game${games.length === 1 ? '' : 's'}`;
  grid.classList.toggle('all-focused', activeSource === 'All' || activeSource === 'Most Recent');
  grid.innerHTML = sections.length
    ? sections
        .map((section) => `<section class="library-group ${section.source === activeSource ? 'focused' : ''}">
          <div class="library-group-head">
            <h3>${section.title}</h3>
            <span>${section.games.length}</span>
          </div>
          <div class="library-row">
          ${section.games
            .map(
          (game) => `<article class="game-card ${game.id === selectedId ? 'selected' : ''}" data-id="${game.id}">
            <div class="poster library-cover ${game.coverUrl ? 'has-cover' : ''}" ${coverStyle(game)}><span>${game.coverUrl ? '' : fallbackInitials(game.name)}</span></div>
            ${cardVersion(game)}
            <div class="game-row">
              <div>
                <h3>${game.name}</h3>
                <p>${game.source} - ${statusLabel(game)}</p>
                <small>${ownerLabel(game)}</small>
              </div>
              <button class="play" data-play="${game.id}" title="${game.status === 'installable' ? 'Install' : 'Play'}">${game.status === 'installable' ? '+' : '▶'}</button>
            </div>
          </article>`
            )
            .join('')}
          </div>
        </section>`)
        .join('')
    : '<div class="empty">No games found yet. Add a folder or run a scan.</div>';
}

function escapeVersion(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function cardVersion(game) {
  const version = game.currentVersion || game.currentBuild;
  const update = game.source === 'Portable' && game.ankerVersion && game.updateInfo?.hasUpdate;
  return `<div class="card-version">${version ? `<span title="Installed version">${escapeVersion(version)}</span>` : ''}${update ? `<button class="update-badge" data-update="${game.id}" title="Update available" aria-label="Download update for ${escapeVersion(game.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4-4 4 4 4-4M5 16v4h14v-4" /></svg></button>` : ''}</div>`;
}
function selectedGame() {
  return store.games.find((game) => game.id === selectedId) || currentGames()[0] || store.games[0];
}

async function renderLauncherCandidates(game) {
  launcherCandidates.innerHTML = '<option value="">Choose detected launcher...</option>';
  if (!game?.id || !game.installPath) return;
  try {
    const launchers = await window.launcher.listLaunchers(game.id);
    launcherCandidates.innerHTML =
      '<option value="">Choose detected launcher...</option>' +
      launchers
        .map((launcher) => `<option value="${launcher.path}" data-type="${launcher.type}">${launcher.name}</option>`)
        .join('');
    launcherCandidates.value = game.executablePath || '';
  } catch {
    launcherCandidates.innerHTML = '<option value="">No launcher files found</option>';
  }
}

function renderHeroAndInspector() {
  const game = selectedGame();
  if (!game) return;
  selectedId = game.id;
  if (storeInfoGameId !== game.id) {
    storeInfoGameId = game.id;
    storeInfo = null;
  }
  document.querySelector('#detailCover').style.backgroundImage = game.coverUrl ? `url('${game.coverUrl.replaceAll("'", '%27')}')` : '';
  document.querySelector('#detailCover').textContent = game.coverUrl ? '' : fallbackInitials(game.name);
  document.querySelector('#gameName').value = game.name;
  document.querySelector('#detailMeta').textContent = `${ownerLabel(game)}\nStatus: ${statusLabel(game)}\nLibrary: ${game.libraryPath || game.source}\n${game.installPath || game.source}`;
  document.querySelector('#launchType').value = game.launchType || 'exe';
  document.querySelector('#launcherPath').value = game.launcherUri || game.executablePath || '';
  document.querySelector('#coverUrl').value = game.coverUrl || '';
  document.querySelector('#workingDirectory').value = game.workingDirectory || '';
  document.querySelector('#installGame').style.display = game.status === 'installable' ? 'block' : 'none';
  renderLauncherCandidates(game);
  const updatePanel = document.querySelector('#updatePanel');
  updatePanel.hidden = game.source !== 'Portable' || game.status === 'installable';
  document.querySelector('#currentVersion').value = game.currentVersion || '';
  document.querySelector('#currentBuild').value = game.currentBuild || '';
  renderStorePanel();
  if (!storeInfo) loadStorePanel(game.id);
}
document.querySelector('#updateGame').addEventListener('click', async () => {
  const game = selectedGame();
  if (!game) return;
  if (game.source !== 'Portable' || game.status === 'installable') return;
  const button = document.querySelector('#updateGame');
  button.disabled = true;
  try { await openStoreLinks({ ...game, updateGameId: game.id }); }
  catch (error) { showDownloadStatus(error.message); }
  finally { button.disabled = false; }
});

function renderStorePanel() {
  document.querySelector('#storeTitle').textContent = storeInfo?.title || 'Loading store details';
  document.querySelector('#storeSummary').textContent = storeInfo?.summary || 'Looking for store information and matched metadata.';
  const game = selectedGame();
  const tags = [ownerLabel(game), game?.libraryPath ? `Library: ${game.libraryPath}` : '', ...(storeInfo?.tags || [])].filter(Boolean);
  document.querySelector('#storeTags').innerHTML = tags.map((tag) => `<span>${tag}</span>`).join('');
  document.querySelector('#openStorePage').disabled = !storeInfo?.actionUrl;
}

let storeProvider = 'All'; let storeGenre = 'All'; let storeQuery = '';
let activeStoreTag = '';
function ensureStoreTagControl() {
  const search = document.querySelector('.store-search');
  if (document.querySelector('#storeTagButton')) return;
  const button = document.createElement('button'); button.id = 'storeTagButton'; button.type = 'button'; button.textContent = 'Tags';
  const menu = document.createElement('div'); menu.id = 'storeTagMenu'; menu.className = 'store-tag-menu'; menu.innerHTML = '<div class="store-tag-menu-head"><strong>Filter by tag</strong><button id="clearStoreTag" type="button">Clear</button></div><div id="storeTagItems"></div>';
  search.insertBefore(button, document.querySelector('#storeSearchButton')); search.appendChild(menu);
  button.addEventListener('click', () => { const open = menu.classList.toggle('open'); button.setAttribute('aria-expanded', open); });
  menu.addEventListener('click', e => { const tag = e.target.dataset.storeTagFilter; if (tag) { activeStoreTag = activeStoreTag === tag ? '' : tag; renderStorePage(); } if (e.target.id === 'clearStoreTag') { activeStoreTag = ''; renderStorePage(); } });
}
async function renderStorePage() {
  ensureStoreTagControl();
  document.querySelector('#storeLoading').classList.add('open');
  document.querySelector('#storeResults').innerHTML = '';
  const browseTags = ['New Releases', 'Action', 'RPG', 'Co-op', 'Indie', 'Strategy', 'Simulation', 'Adventure', 'Free to Play'];
  document.querySelector('#storeTagItems').innerHTML = browseTags.filter(tag => tag !== 'New Releases').map(tag => `<button class="${activeStoreTag === tag ? 'active' : ''}" data-store-tag-filter="${tag}" aria-pressed="${activeStoreTag === tag}">${tag}</button>`).join('');
  document.querySelector('#storeTagButton').textContent = activeStoreTag ? `Tag: ${activeStoreTag}` : 'Tags';
  const providers = ['All', 'Steam', 'Epic', 'Xbox', 'EA', 'Ubisoft'];
  const genres = ['All', 'Co-op', 'RPG', 'Action', 'Strategy', 'Indie'];
  document.querySelector('#storeProviders').innerHTML = '';
  document.querySelector('#storeGenres').innerHTML = '';
  const [catalogResults] = await Promise.all([
    window.launcher.searchStore(storeQuery, {}),
    new Promise(resolve => setTimeout(resolve, 700))
  ]);
  const results = catalogResults.filter(game => !activeStoreTag || [game.name, game.genre, ...(game.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(activeStoreTag.toLowerCase()));
  document.querySelector('#storeResultsTitle').textContent = storeQuery ? `Results for “${storeQuery}”` : 'New & featured games';
  document.querySelector('#storeCount').textContent = `${results.length} results`;
  document.querySelector('#storeResults').innerHTML = results.length ? results.map(game => `<article class="store-card" data-store-game='${JSON.stringify(game).replaceAll("'", '&apos;')}'><div class="store-poster" style="${game.coverUrl ? `background-image:url('${game.coverUrl}')` : ''}"><span>${game.coverUrl ? '' : (game.name || '?').slice(0, 2).toUpperCase()}</span></div><div class="store-card-body"><div><span class="platform-pill">${game.provider}</span><h3>${game.name}</h3><p>${game.description}</p></div><div class="store-card-actions"><button data-store-action="links">Find Links</button><button class="secondary" data-store-action="source">Original Source</button></div></div></article>`).join('') : '<div class="empty">No games matched your search.</div>';
  document.querySelector('#storeLoading').classList.remove('open');
  updateStoreCardFade();
}

function updateStoreCardFade() {
  const toolbar = document.querySelector('.store-search');
  if (!toolbar || activePage !== 'store') return;
  const fadeStart = toolbar.getBoundingClientRect().bottom;
  const fadeLead = 90;
  document.querySelectorAll('#storeResults .store-card').forEach(card => {
    const rect = card.getBoundingClientRect();
    // Begin fading when the card's top approaches the toolbar, then fade it
    // out over its full height as it scrolls behind and beyond the toolbar.
    const fade = Math.max(0, Math.min(1, (rect.top - fadeStart + rect.height - fadeLead) / rect.height));
    card.style.setProperty('--scroll-card-opacity', fade.toFixed(3));
  });
}

mainScroller.addEventListener('scroll', () => {
  if (activePage === 'store') window.requestAnimationFrame(updateStoreCardFade);
}, { passive: true });
window.addEventListener('resize', updateStoreCardFade);

async function loadStorePanel(gameId) {
  storeInfo = null;
  renderStorePanel();
  try {
    storeInfo = await window.launcher.getStoreInfo(gameId);
  } catch {
    storeInfo = { title: 'No store details', summary: 'Store information could not be loaded.', tags: [], actionUrl: '' };
  }
  if (selectedId === gameId) renderStorePanel();
}

function renderSettings() {
  const settings = store.settings;
  document.querySelector('#downloadPath').value = settings.downloadPath || '';
  document.querySelector('#defaultInstallPath').value = settings.defaultInstallPath || '';
  document.querySelector('#excludeFolders').checked = !!store.defenderFoldersExcluded;
  document.querySelector('#excludeFoldersLabel').textContent = store.defenderFoldersExcluded ? 'Folders are excluding' : 'Exclude these folders';
  document.querySelector('#downloadPathDisplay').textContent = settings.downloadPath || 'Windows Downloads folder';
  document.querySelector('#installPathDisplay').textContent = settings.defaultInstallPath || 'Games folder in your user profile';
  const defenderFolders = [settings.downloadPath || 'Windows Downloads folder', settings.defaultInstallPath || 'Games folder in your user profile'];
  document.querySelector('#defenderFolderList').innerHTML = defenderFolders.map(folder => `<div class="settings-folder-path">${folder.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`).join('');
  const activeSteamId = store.accounts?.activeSteamId || settings.steamId64 || '';
  const activeAccount = store.accounts?.steam?.[activeSteamId] || {};
  document.body.dataset.theme = settings.darkMode ? 'dark' : 'light';
  document.documentElement.dataset.theme = document.body.dataset.theme;
  document.body.dataset.glass = settings.glassIntensity || 'high';
  document.body.dataset.mica = settings.micaTransparency ? 'on' : 'off';
  document.body.dataset.background = settings.homeBackgroundEnabled === false || settings.homeBackgroundSource === 'transparent' ? 'off' : 'on';
  document.body.dataset.backgroundSource = settings.homeBackgroundSource || 'dynamic';
  setHomeWallpaper(settings);
  const hour = new Date().getHours();
  const greeting = hour >= 5 && hour < 12 ? 'Good Morning,' : hour >= 12 && hour < 17 ? 'Good Afternoon,' : 'Good Evening,';
  const displayName = settings.displayName?.trim() || 'Player';
  document.querySelector('#homeGreeting').innerHTML = `${greeting}<br /><strong>${displayName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</strong>`;
  document.querySelector('#homeBackgroundEnabled').checked = settings.homeBackgroundEnabled !== false && settings.homeBackgroundSource !== 'transparent';
  document.querySelector('#homeBackgroundSource').value = settings.homeBackgroundSource || 'dynamic';
  document.querySelector('#displayName').value = settings.displayName || '';
  document.querySelector('#customBackgroundName').textContent = settings.homeBackgroundPath ? settings.homeBackgroundPath.split(/[\\/]/).at(-1) : 'Choose an image from this PC.';
  document.querySelector('#darkMode').checked = !!settings.darkMode;
  document.querySelector('#micaTransparency').checked = !!settings.micaTransparency;
  document.querySelector('#glassIntensity').value = settings.glassIntensity || 'high';
  document.querySelector('#scanOnStartup').checked = !!settings.scanOnStartup;
  document.querySelector('#coverLookup').checked = !!settings.coverLookup;
  document.querySelector('#steamCoverLookup').checked = !!settings.steamCoverLookup;
  document.querySelector('#steamGridDbKey').value = settings.steamGridDbKey || '';
  document.querySelector('#activeSteamName').textContent = activeAccount.personaName || activeAccount.accountName || 'No account selected';
  document.querySelector('#activeSteamId').textContent = activeSteamId ? `SteamID64: ${activeSteamId}` : 'Detect local Steam users to import owned games.';
  document.querySelector('#keepLaunchersQuiet').checked = !!settings.keepLaunchersQuiet;
  document.querySelector('#closeToTray').checked = !!settings.closeToTray;
  document.querySelector('#defaultView').value = settings.defaultView === 'compact' ? 'list' : settings.defaultView || 'grid';
  document.querySelector('#steamLibrariesList').innerHTML = (settings.steamLibraryFolders || []).map(folder => `<div class="location-row"><span>${folder}</span><button data-remove-steam-library="${folder.replaceAll('"', '&quot;')}">Remove</button></div>`).join('') || '<p class="settings-help">No additional Steam folders.</p>';
  document.querySelector('#settingsLocationsList').innerHTML = store.addedLocations.length
    ? store.addedLocations.map(folder => `<div class="location-row"><span title="${folder}">${folder}</span><div><button data-open-location="${folder.replaceAll('"', '&quot;')}">Open</button><button data-remove-location="${folder.replaceAll('"', '&quot;')}">Remove</button></div></div>`).join('')
    : '<p class="settings-help">No game folders added.</p>';
}

function render() {
  renderPage();
  renderFilters();
  renderLocations();
  renderGrid();
  renderHeroAndInspector();
  renderSettings();
}

async function refresh(nextStore) {
  store = nextStore || (await window.launcher.getStore());
  render();
  window.requestAnimationFrame(() => document.querySelector('#welcomeScreen').classList.add('is-done'));
}

async function saveSelected() {
  const game = selectedGame();
  if (!game) return;
  const launchType = document.querySelector('#launchType').value;
  const launcherValue = document.querySelector('#launcherPath').value.trim();
  const updated = {
    ...game,
    name: document.querySelector('#gameName').value.trim() || game.name,
    currentVersion: document.querySelector('#currentVersion').value.trim(),
    currentBuild: document.querySelector('#currentBuild').value.trim(),
    launchType,
    launcherUri: ['steam', 'epic', 'xbox', 'ubisoft', 'uri'].includes(launchType) ? launcherValue : '',
    executablePath: ['exe', 'bat'].includes(launchType) ? launcherValue : '',
    coverUrl: document.querySelector('#coverUrl').value.trim(),
    workingDirectory: document.querySelector('#workingDirectory').value.trim()
  };
  await refresh(await window.launcher.updateGame(updated));
}

async function deleteSelected(gameId = selectedId) {
  if (!gameId) return;
  selectedId = null;
  await refresh(await window.launcher.deleteGame(gameId));
}

async function uninstallSelected(gameId = selectedId) {
  if (!gameId) return;
  selectedId = null;
  await refresh(await window.launcher.uninstallGame(gameId));
}

function settingsFromForm() {
  return {
    darkMode: document.querySelector('#darkMode').checked,
    micaTransparency: document.querySelector('#micaTransparency').checked,
    glassIntensity: document.querySelector('#glassIntensity').value,
    homeBackgroundEnabled: document.querySelector('#homeBackgroundEnabled').checked && document.querySelector('#homeBackgroundSource').value !== 'transparent',
    homeBackgroundSource: document.querySelector('#homeBackgroundSource').value,
    displayName: document.querySelector('#displayName').value.trim(),
    scanOnStartup: document.querySelector('#scanOnStartup').checked,
    coverLookup: document.querySelector('#coverLookup').checked,
    steamCoverLookup: document.querySelector('#steamCoverLookup').checked,
    steamGridDbKey: document.querySelector('#steamGridDbKey').value.trim(),
    keepLaunchersQuiet: document.querySelector('#keepLaunchersQuiet').checked,
    closeToTray: document.querySelector('#closeToTray').checked,
    defaultView: document.querySelector('#defaultView').value
  };
}

function hideContextMenu() {
  contextMenu.classList.remove('open');
  contextGameId = null;
}

async function applyCoverUrl(url) {
  const game = selectedGame();
  if (!game || !url) return;
  await refresh(await window.launcher.updateGame({ ...game, coverUrl: url.trim() }));
  closeCoverPicker();
}

function closeCoverPicker() {
  coverModal.classList.remove('open');
  artGrid.innerHTML = '';
  document.querySelector('#manualCoverUrl').value = '';
}

function closeCatalogModal() {
  catalogModal.classList.remove('open');
}

function closeAccountModal() {
  accountModal.classList.remove('open');
  selectedSteamAccountId = '';
  document.querySelector('#accountKeyPrompt').classList.remove('show');
}

function closeGameModal() {
  gameModal.classList.remove('open');
}

function renderSteamAccountList() {
  const activeSteamId = selectedSteamAccountId;
  document.querySelector('#steamAccountList').innerHTML = detectedSteamAccounts.length
    ? detectedSteamAccounts
        .map(
          (account) => `<button class="account-option ${account.steamId64 === activeSteamId ? 'selected' : ''}" data-steamid="${account.steamId64}">
            <strong>${account.personaName || account.accountName}</strong>
            <span>${account.accountName || account.steamId64}</span>
            <small>${account.steamId64}${account.mostRecent ? ' - most recent' : ''}</small>
          </button>`
        )
        .join('')
    : '<div class="art-empty">No local Steam users were found. Open Steam once, sign in, then try again.</div>';
  const account = detectedSteamAccounts.find((item) => item.steamId64 === activeSteamId);
  document.querySelector('#accountSteamApiKey').value = store.accounts?.steam?.[activeSteamId]?.apiKey || account?.apiKey || '';
  document.querySelector('#accountKeyPrompt').classList.toggle('show', !!activeSteamId);
}

async function openAccountModal() {
  const response = await window.launcher.detectSteamAccounts();
  store = response;
  detectedSteamAccounts = response.detectedSteamAccounts || [];
  selectedSteamAccountId = '';
  renderSteamAccountList();
  accountModal.classList.add('open');
  render();
}

function catalogDraftFromForm() {
  return {
    name: document.querySelector('#catalogName').value.trim(),
    source: document.querySelector('#catalogSource').value,
    ownerName: document.querySelector('#catalogOwner').value.trim(),
    externalId: document.querySelector('#catalogExternalId').value.trim(),
    installUri: document.querySelector('#catalogInstallUri').value.trim(),
    storeUrl: document.querySelector('#catalogStoreUrl').value.trim(),
    installPath: document.querySelector('#catalogInstallPath').value.trim(),
    coverUrl: document.querySelector('#catalogCoverUrl').value.trim()
  };
}

async function openCoverPicker(gameId = selectedId, searchTerm = '') {
  selectedId = gameId;
  render();
  const game = selectedGame();
  if (!game) return;
  coverModal.classList.add('open');
  if (!searchTerm) document.querySelector('#manualCoverUrl').value = game.name || '';
  const query = searchTerm || game.name;
  artGrid.innerHTML = `<div class="art-empty">Searching artwork channels for "${query}"...</div>`;
  coverResults = await window.launcher.searchCoverArt(game.id, query);
  artGrid.innerHTML = coverResults.length
    ? coverResults
        .map(
          (art, index) => `<button class="art-option" data-index="${index}">
            <div class="art-thumb" style="background-image:url('${art.preview.replaceAll("'", '%27')}')"></div>
            <span>${art.provider}</span>
            <small>${art.title}</small>
          </button>`
        )
        .join('')
    : '<div class="art-empty">No portrait covers found. Try the full game title, paste an image link, or add a SteamGridDB API key in Settings for more artwork. Steam and GOG work without a key.</div>';
}

document.querySelector('#scan').addEventListener('click', async () => {
  document.querySelector('#scan').textContent = 'Scanning';
  await refresh(await window.launcher.scan());
  document.querySelector('#scan').textContent = 'Scan';
});

function renderCurrentlyPlaying(game) {
  const title = game ? `Currently Playing: ${game.name}` : 'Chrona';
  const label = document.querySelector('.titlebar-title');
  label.textContent = title;
  label.title = title;
  document.title = title;
  document.querySelector('.titlebar').classList.toggle('is-playing', Boolean(game));
}
let playingEventReceived = false;
window.launcher.onCurrentlyPlaying(game => {
  playingEventReceived = true;
  renderCurrentlyPlaying(game);
});
window.launcher.getCurrentlyPlaying().then(game => {
  if (!playingEventReceived) renderCurrentlyPlaying(game);
}).catch(console.error);

document.querySelector('#windowMinimize').addEventListener('click', () => window.launcher.minimize());
document.querySelector('#windowMaximize').addEventListener('click', async () => {
  const isMaximized = await window.launcher.maximize();
  document.querySelector('#windowMaximize').textContent = isMaximized ? '❐' : '□';
});
document.querySelector('#windowClose').addEventListener('click', () => window.launcher.close());
document.querySelector('.titlebar').hidden = true;

window.launcher.appVersion()
  .then((version) => { document.querySelector('#chronaVersion').textContent = `Version ${version}`; })
  .catch(() => { document.querySelector('#chronaVersion').textContent = 'Version unavailable'; });

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
  activePage = button.dataset.page;
  hideContextMenu(); render(); if (activePage === 'store') renderStorePage();
}));
for (const [button, action] of [['compactMinimize', 'minimize'], ['compactMaximize', 'maximize'], ['compactClose', 'close']]) {
  document.querySelector(`#${button}`).addEventListener('click', async () => {
    if (action === 'minimize') return window.launcher.minimize();
    if (action === 'close') return window.launcher.close();
    const isMaximized = await window.launcher.maximize();
    document.querySelector('#compactMaximize').textContent = isMaximized ? '❐' : '□';
  });
}
document.querySelector('#chooseHomeBackground').addEventListener('click', async () => {
  const imagePath = await window.launcher.chooseHomeBackground();
  if (imagePath) {
    store.settings.homeBackgroundPath = imagePath;
    store.settings.homeBackgroundSource = 'custom';
    store.settings.homeBackgroundEnabled = true;
    await refresh(store);
  }
});
document.querySelector('#homeBackgroundEnabled').addEventListener('change', async () => {
  await refresh(await window.launcher.updateSettings(settingsFromForm()));
});
document.querySelector('#homeBackgroundSource').addEventListener('change', async () => {
  if (document.querySelector('#homeBackgroundSource').value !== 'transparent') document.querySelector('#homeBackgroundEnabled').checked = true;
  await refresh(await window.launcher.updateSettings(settingsFromForm()));
});
document.querySelector('#displayName').addEventListener('input', () => {
  const value = document.querySelector('#displayName').value.trim() || 'Player';
  const hour = new Date().getHours();
  const greeting = hour >= 5 && hour < 12 ? 'Good Morning,' : hour >= 12 && hour < 17 ? 'Good Afternoon,' : 'Good Evening,';
  document.querySelector('#homeGreeting').innerHTML = `${greeting}<br /><strong>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</strong>`;
});

document.querySelector('#storeSearchButton').addEventListener('click', () => { storeQuery = document.querySelector('#storeSearch').value; renderStorePage(); });
document.querySelector('#storeSearch').addEventListener('keydown', e => { if (e.key === 'Enter') document.querySelector('#storeSearchButton').click(); });
document.querySelector('#storeProviders').addEventListener('click', e => { if (e.target.dataset.provider) { storeProvider = e.target.dataset.provider; renderStorePage(); } });
document.querySelector('#storeGenres').addEventListener('click', e => { if (e.target.dataset.genre) { storeGenre = e.target.dataset.genre; renderStorePage(); } });
document.querySelector('#storeResults').addEventListener('click', async e => { const card = e.target.closest('.store-card'); const action = e.target.dataset.storeAction; if (!card || !action) return; const game = JSON.parse(card.dataset.storeGame.replaceAll('&apos;', "'")); if (action === 'source') return window.launcher.openStore(game.sourceUrl); await openStoreLinks(game); });
document.querySelector('#storeResults').addEventListener('click', async e => { if (e.target.closest('button')) return; const card = e.target.closest('.store-card'); if (!card) return; activeStoreGame = JSON.parse(card.dataset.storeGame.replaceAll('&apos;', "'")); storeDetailModal.classList.add('open'); document.querySelector('#storeDetailTitle').textContent = activeStoreGame.name; document.querySelector('#storeDetailCrumb').textContent = activeStoreGame.name; document.querySelector('#storeDetailPlatform').textContent = activeStoreGame.provider; document.querySelector('#storeDetailDescription').textContent = 'Loading game details…'; const paintTags = tags => { const safe = [...new Set((tags || []).filter(Boolean))]; document.querySelector('#storeDetailTags').innerHTML = (safe.length ? safe : [activeStoreGame.provider, 'Featured']).map(tag => `<button data-store-tag="${tag}">${tag}</button>`).join(''); }; paintTags(activeStoreGame.tags); try { const details = await window.launcher.getStoreGameDetails(activeStoreGame); activeStoreGame = { ...activeStoreGame, ...details }; document.querySelector('#storeDetailTitle').textContent = details.title || details.name; document.querySelector('#storeDetailCrumb').textContent = details.title || details.name; document.querySelector('#storeDetailDescription').textContent = details.description; document.querySelector('#storeDetailHero').style.backgroundImage = details.coverUrl ? `url('${details.coverUrl}')` : ''; paintTags(details.tags); document.querySelector('#storeDetailRelease').textContent = details.releaseDate; document.querySelector('#storeDetailDeveloper').textContent = details.developer; document.querySelector('#storeDetailPublisher').textContent = details.publisher; document.querySelector('#storeDetailStorage').textContent = details.storage; } catch { document.querySelector('#storeDetailDescription').textContent = activeStoreGame.description || 'Details are unavailable, but you can still open the original source or find links.'; } });
document.querySelector('#storeDetailTags').addEventListener('click', e => { const tag = e.target.dataset.storeTag; if (!tag) return; activeStoreTag = tag; storeQuery = ''; document.querySelector('#storeSearch').value = ''; storeDetailModal.classList.remove('open'); activePage = 'store'; renderStorePage(); });
async function openStoreLinks(game) {
  const request = ++linksRequest;
  downloadLinkGame = { ...game };
  storeDetailModal.classList.remove('open');
  linksModal.classList.add('open');
  document.querySelector('#linksLoading').classList.add('open');
  document.querySelector('#linksResults').innerHTML = '';
  document.querySelector('#linksTitle').textContent = `Links for ${game.name}`;
  try {
    const links = await window.launcher.findGameLinks(game);
    if (request !== linksRequest) return;
    document.querySelector('#linksLoading').classList.remove('open');
    if (!links.length) {
      document.querySelector('#linksResults').innerHTML = `<div class="links-empty" role="status"><span aria-hidden="true">⚠</span><div><strong>No links found</strong><p>Try again later or search for a different title.</p></div><button data-retry-links>Check again</button></div>`;
      return;
    }
      const isOnlineFix = link => /online[ -]?fix/i.test(link.provider);
    const mainLinks = links.filter(link => !isOnlineFix(link));
    const fixLinks = links.filter(isOnlineFix);
    const otherLinks = [];
    const attribute = value => String(value || '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const renderLink = (link, packageType, required) => `<button class="link-result link-result-primary" data-link-url="${attribute(link.url)}" data-package-type="${packageType}" data-package-required="${required}"><strong>${attribute(link.provider)}</strong><span>${attribute(link.title)}</span><small>${required ? 'Required' : 'Optional'} package · Open in Chrona</small></button>`;
    const mainRequired = mainLinks.map(link => renderLink(link, 'MAIN_GAME', true)).join('');
    const fixRequired = (downloadLinkGame.requiresOnlineFix === true && downloadLinkGame.onlineFixOptional !== true) || (Array.isArray(downloadLinkGame.requiredPackages) && downloadLinkGame.requiredPackages.some(item => String(item?.type).toUpperCase() === 'ONLINE_FIX' && item.required));
    const fixOptions = fixLinks.map(link => renderLink(link, 'ONLINE_FIX', fixRequired)).join('');
    document.querySelector('#linksResults').innerHTML = `${mainLinks.length ? '<h3 class="links-group-title">MAIN GAME · REQUIRED</h3>' : ''}${mainRequired}${fixLinks.length ? `<h3 class="links-group-title">ONLINE FIX · ${fixRequired ? 'REQUIRED' : 'OPTIONAL'}</h3>${fixOptions}` : ''}${otherLinks.length ? '<h3 class="links-group-title">Other links</h3>' : ''}${otherLinks.map(link => renderLink(link, 'MAIN_GAME', true)).join('')}`;
  } catch (error) {
    if (request !== linksRequest) return;
    document.querySelector('#linksLoading').classList.remove('open');
    document.querySelector('#linksResults').innerHTML = `<div class="links-empty" role="alert"><span aria-hidden="true">⚠</span><div><strong>Could not check links</strong><p>${error.message}</p></div><button data-retry-links>Check again</button></div>`;
  }
}
document.querySelector('#linksResults').addEventListener('click', async e => { const retry = e.target.closest('[data-retry-links]'); if (retry) return openStoreLinks(downloadLinkGame); const result = e.target.closest('[data-link-url]'); if (!result || result.disabled) return; result.disabled = true; const url = result.dataset.linkUrl; try { const sourceProvider = result.querySelector('strong')?.textContent || ''; const packageType = result.dataset.packageType || 'MAIN_GAME'; const packageRequired = result.dataset.packageRequired === 'true'; const openResult = await window.launcher.openDownloadBrowser(url, { ...downloadLinkGame, sourceProvider, packageType, packageRequired }); if (openResult === 'choose-count') { window.pendingMultipart = { game: downloadLinkGame, url }; document.querySelector('#multipartCountModal').classList.add('open'); } else if (openResult !== false) { linksModal.classList.remove('open'); document.querySelector('#downloadBrowserUrl').value = url; document.querySelector('#downloadBrowserBar').hidden = false; } } catch (error) { result.disabled = false; showDownloadStatus(error.message); } });
document.querySelector('#closeLinksModal').addEventListener('click', () => linksModal.classList.remove('open'));
document.querySelector('#storeDetailLinks').addEventListener('click', () => openStoreLinks(activeStoreGame));
document.querySelector('#storeDetailSource').addEventListener('click', () => window.launcher.openStore(activeStoreGame.sourceUrl));
document.querySelector('#closeStoreDetail').addEventListener('click', () => storeDetailModal.classList.remove('open'));

document.querySelector('#addLocation').addEventListener('click', async () => {
  await refresh(await window.launcher.addLocation());
});
document.querySelector('#addSettingsLocation').addEventListener('click', async () => {
  await refresh(await window.launcher.addLocation());
});
document.querySelector('#settingsLocationsList').addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open-location]');
  const remove = event.target.closest('[data-remove-location]');
  if (open) return window.launcher.openLocation(open.dataset.openLocation);
  if (remove) await refresh(await window.launcher.removeLocation(remove.dataset.removeLocation));
});

document.querySelector('#addGame').addEventListener('click', async () => {
  await refresh(await window.launcher.addManualGame());
  activeSource = 'All';
  activePage = 'library';
  render();
});

document.querySelector('#addCatalog').addEventListener('click', () => {
  catalogModal.classList.add('open');
});

document.querySelector('#chooseSteamAccount').addEventListener('click', openAccountModal);

document.querySelector('#search').addEventListener('input', (event) => {
  query = event.target.value;
  render();
});

filters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-source]');
  if (!button) return;
  activeSource = button.dataset.source;
  activePage = 'library';
  selectedId = null;
  render();
});

document.querySelector('.library-view-switch').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-library-view]');
  if (!button) return;
  const buttons = document.querySelectorAll('[data-library-view]');
  buttons.forEach((item) => { item.disabled = true; });
  try {
    await refresh(await window.launcher.updateSettings({ defaultView: button.dataset.libraryView }));
  } catch (error) {
    window.alert(`Could not save library layout: ${error.message}`);
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
});

grid.addEventListener('click', async (event) => {
  const playButton = event.target.closest('button[data-play]');
  if (playButton) {
    await window.launcher.launchGame(playButton.dataset.play);
    return;
  }
  const card = event.target.closest('.game-card');
  if (!card) return;
  selectedId = card.dataset.id;
  render();
  gameModal.classList.add('open');
});

grid.addEventListener('contextmenu', (event) => {
  const card = event.target.closest('.game-card');
  if (!card) return;
  event.preventDefault();
  selectedId = card.dataset.id;
  contextGameId = card.dataset.id;
  contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 210)}px`;
  contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 130)}px`;
  contextMenu.classList.add('open');
});

contextMenu.addEventListener('click', async (event) => {
  const action = event.target.closest('button')?.dataset.action;
  if (!action || !contextGameId) return;
  const gameId = contextGameId;
  hideContextMenu();
  if (action === 'play') await window.launcher.launchGame(gameId);
  if (action === 'install') await window.launcher.installGame(gameId);
  if (action === 'browse') await window.launcher.browseGame(gameId);
  if (action === 'verify') await window.launcher.verifyGame(gameId);
  if (action === 'cover') await openCoverPicker(gameId);
  if (action === 'delete') await deleteSelected(gameId);
  if (action === 'uninstall') await uninstallSelected(gameId);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#contextMenu')) hideContextMenu();
});

document.querySelector('#openStorePage').addEventListener('click', async () => {
  if (storeInfo?.actionUrl) await window.launcher.openStore(storeInfo.actionUrl);
});

document.querySelector('#pickExecutable').addEventListener('click', async () => {
  const picked = await window.launcher.pickExecutable();
  if (!picked) return;
  document.querySelector('#launcherPath').value = picked;
  document.querySelector('#launchType').value = /\.(bat|cmd)$/i.test(picked) ? 'bat' : 'exe';
});

launcherCandidates.addEventListener('change', () => {
  const option = launcherCandidates.selectedOptions[0];
  if (!option?.value) return;
  document.querySelector('#launcherPath').value = option.value;
  document.querySelector('#launchType').value = option.dataset.type || 'exe';
});

document.querySelector('#saveGame').addEventListener('click', saveSelected);
document.querySelector('#installGame').addEventListener('click', async () => {
  const game = selectedGame();
  if (game) await window.launcher.installGame(game.id);
});
document.querySelector('#deleteGame').addEventListener('click', () => deleteSelected());
document.querySelector('#uninstallGame').addEventListener('click', () => uninstallSelected());
document.querySelector('#findCoverArt').addEventListener('click', () => openCoverPicker());
document.querySelector('#closeCoverModal').addEventListener('click', closeCoverPicker);
document.querySelector('#closeGameModal').addEventListener('click', closeGameModal);
document.querySelector('#applyManualCover').addEventListener('click', () => applyCoverUrl(document.querySelector('#manualCoverUrl').value));
document.querySelector('#searchCoverQuery').addEventListener('click', async () => {
  await openCoverPicker(selectedId, document.querySelector('#manualCoverUrl').value);
});
document.querySelector('#closeCatalogModal').addEventListener('click', closeCatalogModal);
document.querySelector('#closeAccountModal').addEventListener('click', closeAccountModal);
document.querySelector('#saveCatalogGame').addEventListener('click', async () => {
  await refresh(await window.launcher.addCatalogGame(catalogDraftFromForm()));
  activeSource = 'All';
  activePage = 'library';
  closeCatalogModal();
});
document.querySelector('#steamAccountList').addEventListener('click', (event) => {
  const option = event.target.closest('.account-option');
  if (!option) return;
  selectedSteamAccountId = option.dataset.steamid;
  renderSteamAccountList();
});
document.querySelector('#saveSteamAccount').addEventListener('click', async () => {
  const account = detectedSteamAccounts.find((item) => item.steamId64 === selectedSteamAccountId) || { steamId64: selectedSteamAccountId };
  await refresh(
    await window.launcher.updateSteamAccount({
      ...account,
      apiKey: document.querySelector('#accountSteamApiKey').value.trim()
    })
  );
  closeAccountModal();
});
coverModal.addEventListener('click', (event) => {
  if (event.target === coverModal) closeCoverPicker();
});
gameModal.addEventListener('click', (event) => {
  if (event.target === gameModal) closeGameModal();
});
catalogModal.addEventListener('click', (event) => {
  if (event.target === catalogModal) closeCatalogModal();
});
accountModal.addEventListener('click', (event) => {
  if (event.target === accountModal) closeAccountModal();
});
linksModal.addEventListener('click', event => { if (event.target === linksModal) linksModal.classList.remove('open'); });
storeDetailModal.addEventListener('click', event => { if (event.target === storeDetailModal) storeDetailModal.classList.remove('open'); });
artGrid.addEventListener('click', async (event) => {
  const option = event.target.closest('.art-option');
  if (!option) return;
  await applyCoverUrl(coverResults[Number(option.dataset.index)]?.url);
});
document.querySelector('#saveSettings').addEventListener('click', async () => {
  await refresh(await window.launcher.updateSettings(settingsFromForm()));
});
document.querySelector('#checkChronaUpdateSettings').addEventListener('click', async () => {
  const button = document.querySelector('#checkChronaUpdateSettings');
  const status = document.querySelector('#chronaUpdateStatus');
  const install = document.querySelector('#installChronaUpdateSettings');
  button.disabled = true; status.textContent = 'Checking for updates…'; install.hidden = true;
  try {
    const result = await window.launcher.checkChronaUpdate();
    if (result.error) status.textContent = result.error;
    else if (result.available) { status.textContent = `Chrona ${result.release.version} is available.`; install.hidden = false; }
    else status.textContent = `You’re running the latest version (${result.current}).`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#installChronaUpdateSettings').addEventListener('click', async () => {
  const status = document.querySelector('#chronaUpdateStatus');
  const progress = document.querySelector('#chronaUpdateProgressSettings');
  const button = document.querySelector('#installChronaUpdateSettings');
  button.disabled = true; progress.hidden = false; status.textContent = 'Preparing update…';
  const result = await window.launcher.installChronaUpdate();
  if (result?.error) { status.textContent = result.error; button.disabled = false; }
});
window.launcher.onChronaProgress(value => {
  const progress = document.querySelector('#chronaUpdateProgressSettings');
  const status = document.querySelector('#chronaUpdateStatus');
  if (!progress || progress.hidden) return;
  progress.value = Number(value.percent) || 0;
  status.textContent = `${value.stage || 'Updating'} · ${progress.value}%`;
});
document.querySelector('#addSteamLibrary').addEventListener('click', async () => { await refresh(await window.launcher.addSteamLibraryFolder()); await window.launcher.scan(); });
document.querySelector('#steamLibrariesList').addEventListener('click', async event => { const button = event.target.closest('[data-remove-steam-library]'); if (!button) return; await refresh(await window.launcher.removeSteamLibraryFolder(button.dataset.removeSteamLibrary)); });

document.querySelector('#importSteamLibrary').addEventListener('click', async () => {
  importSteamButton.disabled = true;
  importSteamButton.classList.add('loading-clock');
  importSteamButton.textContent = 'Importing';
  cancelSteamImportButton.classList.add('show');
  try {
    await refresh(await window.launcher.updateSettings(settingsFromForm()));
    await refresh(await window.launcher.importSteamLibrary());
    activeSource = 'Steam';
    activePage = 'library';
  } catch (error) {
    console.warn(error);
  } finally {
    importSteamButton.disabled = false;
    importSteamButton.classList.remove('loading-clock');
    importSteamButton.textContent = 'Import Steam Library';
    cancelSteamImportButton.classList.remove('show');
    render();
  }
});

cancelSteamImportButton.addEventListener('click', async () => {
  cancelSteamImportButton.textContent = 'Canceling';
  await window.launcher.cancelSteamImport();
  cancelSteamImportButton.textContent = 'Cancel Import';
});

['darkMode', 'glassIntensity', 'micaTransparency'].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener('change', () => {
    const settings = settingsFromForm();
    document.body.dataset.theme = settings.darkMode ? 'dark' : 'light';
    document.body.dataset.glass = settings.glassIntensity;
    document.body.dataset.mica = settings.micaTransparency ? 'on' : 'off';
  });
});

refresh();

// distribution.js selects first-run setup or release notes before revealing home.
let downloadLinkGame = null;
document.querySelector('#excludeFolders').addEventListener('change', async (event) => {
  const toggle = event.target;
  const enabled = toggle.checked;
  toggle.checked = !!store.defenderFoldersExcluded;
  toggle.disabled = true;
  document.querySelector('#excludeFoldersLabel').textContent = 'Updating exclusions…';
  try { await refresh(await window.launcher.setFolderExclusions(enabled)); }
  catch (error) { showDownloadStatus(error.message); }
  finally { toggle.disabled = false; renderSettings(); }
});
for (const button of document.querySelectorAll('[data-folder-setting]')) {
  button.addEventListener('click', async () => {
    try { await refresh(await window.launcher.pickDownloadFolder(button.dataset.folderSetting)); }
    catch (error) { showDownloadStatus(error.message); }
  });
}
let currentDownloadId = null;
function showDownloadStatus(payload, retryId = null) {
  const downloadId = payload && typeof payload === 'object' ? payload.downloadId : null;
  const message = payload && typeof payload === 'object' ? payload.message : payload;
  if (message === 'Popup blocked') {
    const toast = document.querySelector('#downloadBrowserToast');
    toast.textContent = message; toast.hidden = false;
    clearTimeout(window.downloadBrowserToastTimer);
    window.downloadBrowserToastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
    return;
  }
  if (downloadId) currentDownloadId = downloadId;
  const status = document.querySelector('#downloadStatus');
  status.hidden = false;
  status.textContent = message;
  if (retryId || /added to Portable|updated successfully|Could not prepare|Retry failed/i.test(message)) addNotification(message, retryId);
  const match = message.match(/(\d+)%/);
  if (match) document.querySelector('#downloadProgressBar').style.width = `${match[1]}%`;
  if (currentDownloadId && downloads.has(currentDownloadId)) { const item = downloads.get(currentDownloadId); item.status = message.replace(/^Downloading:\s*/i, ''); item.stage = item.status; item.progress = match ? Number(match[1]) : item.progress || 0; item.rate = (message.match(/—\s*([^—]+download,\s*[^—]+upload)/i) || [])[1] || item.rate || ''; }
  if (/added to Portable|updated successfully/i.test(message) && currentDownloadId && downloads.has(currentDownloadId)) { downloads.get(currentDownloadId).done = true; downloads.get(currentDownloadId).progress = 100; }
  document.querySelector('#downloadOverlayText').textContent = message.replace(/^Downloading:\s*/i, '');
  const transfer = message.match(/—\s*([^—]+download,\s*[^—]+upload)/i);
  if (transfer) document.querySelector('#downloadOverlayTransfer').textContent = transfer[1];
  const row = currentDownloadId && document.querySelector(`[data-download-row="${currentDownloadId}"]`);
  if (row) { row.querySelector('small').textContent = downloads.get(currentDownloadId)?.status || ''; row.style.setProperty('--download-progress', `${downloads.get(currentDownloadId)?.progress || 0}%`); row.querySelector('.download-hover span').textContent = `${downloads.get(currentDownloadId)?.progress || 0}%`; row.querySelector('.download-hover em').textContent = downloads.get(currentDownloadId)?.rate || ''; }
  if (/added to Portable|updated successfully|Could not prepare|Download (cancelled|interrupted)/i.test(message)) document.querySelector('#downloadOverlay').hidden = true;
}
const notifications = [];
function addNotification(message, retryId = null) { notifications.unshift({ message, retryId, time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }); renderNotifications(); }
function renderNotifications() { const list = document.querySelector('#notificationsList'); list.innerHTML = notifications.map((item, index) => `<div class="notification-item"><span>${item.message}${item.retryId ? `<button class="notification-retry" data-retry-index="${index}">Retry extraction</button><button class="notification-retry" data-cancel-index="${index}">Cancel</button>` : ''}</span><small>${item.time} <button data-dismiss-index="${index}" aria-label="Clear notification">✓</button></small></div>`).join('') || '<p class="notifications-empty">No notifications</p>'; document.querySelector('#notificationBadge').textContent = notifications.length; }
document.querySelector('#notificationsList').addEventListener('click', async event => { const button = event.target.closest('[data-retry-index]'); if (!button) return; const index = Number(button.dataset.retryIndex); const item = notifications[index]; button.disabled = true; button.textContent = 'Retrying…'; try { const ok = await window.launcher.retryDownload(item.retryId); if (ok) { notifications.splice(index, 1); renderNotifications(); } } catch (error) { showDownloadStatus(error.message); } });
document.querySelector('#notificationsList').addEventListener('click', async event => { const dismiss = event.target.closest('[data-dismiss-index]'); if (dismiss) { notifications.splice(Number(dismiss.dataset.dismissIndex), 1); renderNotifications(); return; } const cancel = event.target.closest('[data-cancel-index]'); if (cancel) { const item = notifications[Number(cancel.dataset.cancelIndex)]; await window.launcher.dismissDownload(item.retryId); notifications.splice(Number(cancel.dataset.cancelIndex), 1); renderNotifications(); } });
document.querySelector('#notificationsButton').addEventListener('click', () => { const panel = document.querySelector('#notificationsPanel'); panel.hidden = !panel.hidden; });
document.addEventListener('click', event => { const panel = document.querySelector('#notificationsPanel'); const button = document.querySelector('#notificationsButton'); if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) panel.hidden = true; });
document.querySelector('#clearNotifications').addEventListener('click', () => { for (let i = notifications.length - 1; i >= 0; i--) if (!notifications[i].retryId) notifications.splice(i, 1); renderNotifications(); });
document.querySelector('#downloadBrowserBar').addEventListener('click', async event => {
  const closeTab = event.target.closest('[data-close-browser-tab]');
  if (closeTab) { event.stopPropagation(); await window.launcher.browserControl('close-tab', closeTab.dataset.closeBrowserTab); return; }
  const tab = event.target.closest('[data-browser-tab]');
  if (tab) { await window.launcher.browserControl('select-tab', tab.dataset.browserTab); return; }
  const action = event.target.dataset.browserControl;
  if (!action) return;
  await window.launcher.browserControl(action);
  if (action === 'close') document.querySelector('#downloadBrowserBar').hidden = true;
});
document.querySelector('#downloadBrowserUrl').addEventListener('keydown', async event => {
  if (event.key !== 'Enter') return;
  let value = event.currentTarget.value.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try { await window.launcher.browserControl('navigate', value); }
  catch (error) { showDownloadStatus(error.message); }
});
window.launcher.onDownloadBrowserTabs(state => {
  const strip = document.querySelector('#downloadBrowserTabs');
  strip.replaceChildren();
  for (const tab of state.tabs || []) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `download-browser-tab${tab.active ? ' active' : ''}`; button.dataset.browserTab = tab.id;
    button.title = tab.url || tab.title; button.setAttribute('aria-selected', String(!!tab.active));
    const title = document.createElement('span'); title.textContent = tab.title || 'Download page'; button.append(title);
    if (tab.loading) { const loading = document.createElement('small'); loading.textContent = '…'; button.append(loading); }
    else if (tab.activity) { const activity = document.createElement('small'); activity.textContent = tab.activity.startsWith('Downloading') ? '↓' : tab.activity === 'Download ready' ? '✓' : '!'; activity.title = tab.activity; button.append(activity); }
    const close = document.createElement('span'); close.className = 'download-browser-tab-close'; close.dataset.closeBrowserTab = tab.id; close.textContent = '×'; close.setAttribute('role', 'button'); close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`); button.append(close);
    strip.append(button);
  }
  document.querySelector('#downloadBlockedPopups').hidden = !state.blockedPopupCount;
  document.querySelector('#downloadBlockedPopups').textContent = state.blockedPopupCount ? `Shield · ${state.blockedPopupCount} popups blocked` : '';
  document.querySelector('#downloadSourceNotice').hidden = !state.tabs?.find(tab => tab.id === state.activeTabId)?.sourceRestricted;
  document.querySelector('#downloadBrowserBar').hidden = !state.visible;
});
window.launcher.onDownloadStatus(showDownloadStatus);
const downloads = new Map();
function renderDownloads() {
  const list = document.querySelector('#downloadsList'); list.replaceChildren();
  document.querySelector('#activeDownloadCount').textContent = String([...downloads.values()].filter(item => !item.done).length);
  for (const item of downloads.values()) {
    const row = document.createElement('div'); row.className = 'download-item'; row.dataset.downloadRow = item.id;
    row.style.setProperty('--download-progress', (item.progress || 0) + '%');
    row.innerHTML = '<strong></strong><small></small><div class="download-item-progress"><i></i></div><div class="download-hover"><span></span><em></em></div><div class="download-controls"></div>';
    row.querySelector('strong').textContent = item.name;
    row.querySelector('small').textContent = item.status || 'Starting';
    row.querySelector('.download-hover span').textContent = (item.progress || 0) + '%';
    row.querySelector('em').textContent = item.rate || '';
    const actions = item.done ? [['dismiss', 'Delete file']] : item.saved ? [['history', 'View in Downloads']] : [[item.paused ? 'resume' : 'pause', item.paused ? 'Resume' : 'Pause'], ['cancel', 'Cancel']];
    for (const [action, label] of actions) {
      const button = document.createElement('button'); button.textContent = label; button.dataset.downloadAction = item.id; button.dataset.action = action; row.querySelector('.download-controls').append(button);
    }
    list.append(row);
  }
  if (!downloads.size) { const empty = document.createElement('p'); empty.className = 'downloads-empty'; empty.textContent = 'No active downloads'; list.append(empty); }
}
document.querySelector('#downloadsList').addEventListener('click', async event => {
  const button = event.target.closest('[data-download-action]'); if (!button) return;
  const id = button.dataset.downloadAction, action = button.dataset.action, item = downloads.get(id);
  if (action === 'history') { document.querySelector('[data-page="downloads"]').click(); return; }
  if (action === 'dismiss') {
    if (!window.confirm('Delete this downloaded file from your computer and remove it from Chrona?')) return;
    try { await window.launcher.dismissDownload(id); downloads.delete(id); renderDownloads(); }
    catch (error) { showDownloadStatus(error.message); }
    return;
  }
  try {
    if (!(await window.launcher.controlDownload(id, action))) return;
    if (action === 'pause') item.paused = true;
    if (action === 'resume') item.paused = false;
    if (action === 'cancel') downloads.delete(id);
    renderDownloads();
  } catch (error) { showDownloadStatus(error.message); }
});
window.launcher.onDownloadHistoryChanged(async () => {
  try {
    for (const entry of await window.launcher.getDownloadHistory()) {
      const item = downloads.get(entry.id); if (!item) continue;
      item.saved = entry.status !== 'downloading'; item.done = entry.status === 'installed';
      if (item.saved) item.status = entry.status === 'installed' ? 'Installed ? file kept in Downloads' : entry.status === 'installing' ? 'Installing?' : 'Saved in Downloads';
      if (entry.complete) item.progress = 100;
    }
    renderDownloads();
  } catch (error) { showDownloadStatus(error.message); }
});
document.querySelector('#toggleDownloads').addEventListener('click', event => { const list = document.querySelector('#downloadsList'); list.hidden = !list.hidden; event.currentTarget.textContent = list.hidden ? '+' : '?'; event.currentTarget.setAttribute('aria-expanded', String(!list.hidden)); });
document.querySelector('#minimizeDownload').addEventListener('click', () => { document.querySelector('#downloadOverlay').hidden = true; });
document.querySelector('#minimizeDownloadOverlay').addEventListener('click', () => { document.querySelector('#downloadOverlay').hidden = true; });
window.launcher.onDownloadStarted(payload => {
  const item = typeof payload === 'string' ? { id: payload, name: payload } : payload;
  item.progress = 0; item.status = 'Starting…'; currentDownloadId = item.id; downloads.set(item.id, item);
  document.querySelector('#downloadBrowserBar').hidden = true;
  activePage = 'downloads'; renderPage(); renderDownloads();
  document.querySelector('#downloadOverlay').hidden = false;
  document.querySelector('#downloadOverlayTitle').textContent = 'Downloading';
  document.querySelector('#downloadOverlayText').textContent = item.name;
  document.querySelector('#downloadProgressBar').style.width = '0%';
});
let multipartSessions = [];
let currentMultipartId = null;
async function refreshMultipart() { multipartSessions = await window.launcher.listMultipart(); renderMultipart(); }
function renderMultipart() {
  const session = multipartSessions.find(item => item.id === currentMultipartId) || multipartSessions.find(item => ['collecting_parts', 'missing_parts', 'ready_to_extract'].includes(item.status));
  if (!session) return;
  currentMultipartId = session.id;
  const parts = session.downloadedParts || [];
  document.querySelector('#multipartSummary').textContent = `Part ${parts.length} of ${session.expectedParts} downloaded · ${parts.length} / ${session.expectedParts} Parts`;
  document.querySelector('#multipartFiles').innerHTML = Array.from({ length: session.expectedParts }, (_, index) => {
    const part = parts.find(item => item.partNumber === index + 1) || parts[index];
    return `<div class="multipart-file"><span>Part ${index + 1} — ${part ? part.related ? 'Downloaded ✓' : 'Check file' : 'Waiting'}</span><small>${part ? part.name : ''}</small></div>`;
  }).join('') + (parts.filter(part => !part.related).map(part => `<p class="multipart-warning">Possibly unrelated file: ${part.name}</p>`).join(''));
  document.querySelector('#multipartConfirm').hidden = parts.length < session.expectedParts || session.status === 'missing_parts';
  document.querySelector('#multipartMissing').hidden = parts.length < session.expectedParts || session.status === 'missing_parts';
  document.querySelector('#multipartOpenPage').onclick = async () => { await window.launcher.openDownloadBrowser(session.originalUrl, { ...session.game, sourceProvider: 'Zeigames', downloadType: 'multi', multipartSessionId: session.id }); document.querySelector('#downloadBrowserBar').hidden = false; };
  document.querySelector('#multipartModal').classList.add('open');
}
window.launcher.onMultipartChanged(async session => { await refreshMultipart(); currentMultipartId = session.id; renderMultipart(); });
window.launcher.onMultipartChooseType(async payload => { const type = await window.launcher.chooseDownloadType(); if (!type) return; window.pendingMultipart = { game: payload.game, url: payload.url, type }; if (type === 'multi') document.querySelector('#multipartCountModal').classList.add('open'); else { const result = await window.launcher.resumeMultipartType(payload.game, payload.url, type, 0); await window.launcher.openDownloadBrowser(result.url, result.game); } });
window.launcher.onMultipartRequestCount(payload => { window.pendingMultipart = { ...payload, type: 'multi' }; document.querySelector('#multipartCountModal').classList.add('open'); });
document.querySelector('#multipartCountConfirm').addEventListener('click', async () => { const pending = window.pendingMultipart; const count = Number(document.querySelector('#multipartCountInput').value); if (!pending || !Number.isInteger(count) || count < 2 || count > 100) return; try { const modal = document.querySelector('#multipartCountModal'); modal.classList.remove('open'); const result = await window.launcher.resumeMultipartType(pending.game, pending.url, 'multi', count); currentMultipartId = result.session.id; await refreshMultipart(); const opened = await window.launcher.openDownloadBrowser(result.url, result.game); if (opened !== false) { linksModal.classList.remove('open'); document.querySelector('#downloadBrowserBar').hidden = false; } } catch (error) { showDownloadStatus(error.message); } });
document.querySelector('#multipartConfirm').addEventListener('click', async () => { try { await window.launcher.confirmMultipart(currentMultipartId, true); await refreshMultipart(); } catch (error) { showDownloadStatus(error.message); } });
document.querySelector('#multipartCountCancel').addEventListener('click', () => document.querySelector('#multipartCountModal').classList.remove('open'));
document.querySelector('#multipartMissing').addEventListener('click', async () => { try { const session = await window.launcher.confirmMultipart(currentMultipartId, false); currentMultipartId = session.id; renderMultipart(); await window.launcher.openDownloadBrowser(session.originalUrl, { ...session.game, sourceProvider: 'Zeigames', downloadType: 'multi', multipartSessionId: session.id }); document.querySelector('#downloadBrowserBar').hidden = false; } catch (error) { showDownloadStatus(error.message); } });
document.querySelector('#closeMultipart').addEventListener('click', () => document.querySelector('#multipartModal').classList.remove('open'));
void refreshMultipart();
window.launcher.onDownloadUrl(url => { document.querySelector('#downloadBrowserUrl').value = url; });
window.launcher.onLibraryChanged(async () => { await refresh(await window.launcher.getStore()); });

// Handle the badge before the card's normal selection action.
grid.addEventListener('click', async event => {
  const badge = event.target.closest('[data-update]');
  if (!badge) return;
  event.stopImmediatePropagation();
  const game = store.games.find(item => item.id === badge.dataset.update);
  if (!game || game.source !== 'Portable') return;
  try { await openStoreLinks({ ...game, updateGameId: game.id }); }
  catch (error) { showDownloadStatus(error.message); }
}, true);
