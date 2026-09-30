const { app, BrowserWindow, WebContentsView, session, dialog, ipcMain, shell } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { offerDefenderExclusion, foldersAreExcluded } = require('./defender');
const { PlayingTracker } = require('./playing');
const { atomicJson, readJson: readDistributionJson, validStore, recoverLibraryFromBackup } = require('./distribution/storage');
const { registerUpdates } = require('./distribution/service');
const releaseService = require('./distribution/releases');
const { DownloadHistory } = require('./download-history');
const { packageDefinition } = require('./download-providers');
const downloadHistory = new DownloadHistory({ getStore: () => store, save: () => saveStore(),
  install: (...args) => finishDownload(...args), changed: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:changed');
  } });

// ChronaUpdater.exe is a copied Electron runtime. Route it to the updater UI
// (or its isolated replacement worker) instead of starting the game launcher.
if (path.basename(process.execPath).toLowerCase() === 'chronaupdater.exe') {
  require(process.argv.includes('--chrona-updater') ? './distribution/worker' : './distribution/standalone');
  return;
}
// Preserve the data location used by the original portable application.
const explicitProfile = process.argv.find(argument => argument.startsWith('--user-data-dir='));
app.setPath('userData', explicitProfile ? path.resolve(explicitProfile.slice('--user-data-dir='.length)) : path.join(app.getPath('appData'), 'chrona-game-launcher'));
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
else app.on('second-instance', async (_event, argv) => {
  if (argv.includes('--chrona-quit-for-update')) { if (store && storePath) await saveStore(); app.quit(); return; }
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

const STORE_VERSION = 1;
const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.lnk', '.url']);
const SKIP_DIRS = new Set([
  '$recycle.bin',
  '.git',
  'appdata',
  'common files',
  'directx',
  'dotnet',
  'microsoft',
  'nvidia',
  'redist',
  'redistributable',
  'support',
  'temp',
  'tmp',
  'uninstall'
]);

let mainWindow;
const playingTracker = new PlayingTracker(game => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game:playing', game);
  }
});
app.on('before-quit', () => playingTracker.stop());
ipcMain.handle('game:playing', () => playingTracker.current);
let storePath;
let store;
let steamImportAbortController = null;

function defaultStore() {
  return {
    version: STORE_VERSION,
    setupCompleted: false,
    addedLocations: [],
    games: [],
    coverCache: {},
    coverSearchCache: {},
    storeInfoCache: {},
    storeSearchCache: {},
    pendingDownloads: [],
    downloadHistory: [],
    downloadSessions: [],
    installationJobs: [],
    accounts: {
      activeSteamId: '',
      steam: {}
    },
    settings: {
      darkMode: false,
      micaTransparency: false,
      glassIntensity: 'high',
      homeBackgroundEnabled: true,
      homeBackgroundSource: 'dynamic',
      homeBackgroundPath: '',
      displayName: '',
      scanOnStartup: false,
      closeToTray: false,
      coverLookup: true,
      steamCoverLookup: true,
      steamApiKey: '',
      steamId64: '',
      steamGridDbKey: '',
      keepLaunchersQuiet: true,
      defaultView: 'grid',
      defaultInstallSource: 'Steam',
      downloadPath: app.getPath('downloads'),
      defaultInstallPath: path.join(app.getPath('home'), 'Games')
      ,steamLibraryFolders: []
    }
  };
}

async function loadStore() {
  const userData = app.getPath('userData');
  await fs.mkdir(userData, { recursive: true });
  storePath = path.join(userData, 'library.json');
  try {
    store = JSON.parse(await fs.readFile(storePath, 'utf8'));
    if (!validStore(store)) throw new Error('Chrona library.json is not valid. It has been preserved for recovery.');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const recovery = await recoverLibraryFromBackup(storePath);
      if (!recovery) throw error;
      store = JSON.parse(await fs.readFile(storePath, 'utf8'));
    } else {
      store = defaultStore();
      const seedPath = path.join(userData, 'installer-setup.ini');
      try {
        const raw = await fs.readFile(seedPath);
        const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
        const seed = Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
        if (seed.complete === '1') {
          store.setupCompleted = true;
          store.lastRunVersion = app.getVersion();
          store.lastSeenReleaseNotes = app.getVersion();
          store.settings.darkMode = seed.darkMode === '1';
          store.settings.scanOnStartup = seed.scanOnStartup === '1';
          store.settings.steamLibraryFolders = seed.steam ? [seed.steam] : [];
          store.addedLocations = (seed.folders || '').split('|').filter(Boolean);
        }
      } catch (seedError) { if (seedError.code !== 'ENOENT') throw seedError; }
      await saveStore();
      await fs.unlink(seedPath).catch(() => {});
      return;
    }
  }
  // Legacy users already configured Chrona; do not onboard them again.
  if (store.setupCompleted === undefined) store.setupCompleted = true;
  store.settings = { ...defaultStore().settings, ...store.settings };
  store.addedLocations ||= [];
  store.games ||= [];
  store.coverCache ||= {};
  store.coverSearchCache ||= {};
  store.storeInfoCache ||= {};
  store.storeSearchCache ||= {};
  store.pendingDownloads ||= [];
  store.downloadSessions ||= [];
  store.installationJobs ||= [];
  store.accounts ||= { activeSteamId: '', steam: {} };
  store.accounts.steam ||= {};
}

let storeWrite = Promise.resolve();
async function saveStore() {
  const snapshot = JSON.parse(JSON.stringify(store));
  const write = storeWrite.catch(() => {}).then(() => atomicJson(storePath, snapshot));
  storeWrite = write;
  await write;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    // Keep the native client area transparent so DWM's Acrylic backdrop can
    // render through the renderer when the user enables it.
    backgroundColor: '#00000000',
    transparent: true,
    // Acrylic is the translucent Windows backdrop; Mica itself is opaque and
    // only tints from the wallpaper, which is not visible through transparent UI.
    backgroundMaterial: store.settings.micaTransparency ? 'acrylic' : 'none',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { theme: store.settings.darkMode ? 'dark' : 'light' }
  });
  mainWindow.once('ready-to-show', async () => {
    if (store.setupCompleted && store.settings.scanOnStartup) await scanAll();
  });
}

function normalizeGameName(input) {
  return path
    .basename(input, path.extname(input))
    .replace(/\b(win64|win32|x64|x86|shipping|launcher|start|play|setup|install|unins\d*|eac|battleye)\b/gi, ' ')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableId(parts) {
  return Buffer.from(parts.join('|')).toString('base64url').slice(0, 48);
}

async function steamImageCandidates(appId, title) {
  const legacy = [
    ['Steam Cover', 'library_600x900.jpg'],
    ['Steam Cover Alt', 'library_600x900_2x.jpg']
  ].map(([provider, file]) => ({
    provider,
    title,
    url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${file}`,
    preview: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${file}`
  }));
  try {
    const input = { ids: [{ appid: Number(appId) }], context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } };
    const response = await fetch(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return legacy;
    const payload = await response.json();
    const assets = payload.response?.store_items?.find(item => String(item.appid) === String(appId))?.assets;
    if (!assets?.asset_url_format) return legacy;
    const modern = ['library_capsule_2x', 'library_capsule'].filter(key => assets[key]).map(key => {
      const url = new URL(assets.asset_url_format.replace('${FILENAME}', assets[key]), 'https://shared.akamai.steamstatic.com/store_item_assets/').href;
      return { provider: 'Steam Cover', title, url, preview: url };
    });
    return [...modern, ...legacy];
  } catch {
    return legacy;
  }
}

function steamBannerAppId(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)(steamstatic\.com|steamcdn-a\.akamaihd\.net|steamusercontent\.com)$/.test(parsed.hostname)) return '';
    return parsed.pathname.match(/\/(?:steam\/)?apps\/(\d+)\/(?:header|library_hero|capsule_[\dx]+)\.[a-z]+$/i)?.[1] || '';
  } catch {
    return '';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function availableDriveRoots() {
  if (process.platform !== 'win32') return ['/'];
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((letter) => `${letter}:\\`)
    .filter((root) => {
      try {
        return require('fs').existsSync(root);
      } catch {
        return false;
      }
    });
}

async function imageExists(url) {
  try {
    const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-128' } });
    const type = response.headers.get('content-type') || '';
    return response.ok && type.startsWith('image/');
  } catch {
    return false;
  }
}

async function firstWorkingImage(candidates) {
  for (const candidate of candidates) {
    if (await imageExists(candidate.url)) return candidate.url;
    await delay(80);
  }
  return '';
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

async function readText(target) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return '';
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((item) => {
    if (!item) return false;
    const normalized = path.normalize(item);
    if (seen.has(normalized.toLowerCase())) return false;
    seen.add(normalized.toLowerCase());
    return true;
  });
}

function commonLocations() {
  const home = os.homedir();
  const drives = availableDriveRoots().map((drive) => drive.slice(0, 2));
  const locations = [];

  for (const drive of drives) {
    locations.push(
      `${drive}\\Program Files (x86)\\Steam\\steamapps\\common`,
      `${drive}\\Program Files\\Steam\\steamapps\\common`,
      `${drive}\\SteamLibrary\\steamapps\\common`,
      `${drive}\\Games`,
      `${drive}\\Game`,
      `${drive}\\Portable Games`,
      `${drive}\\GOG Games`,
      `${drive}\\XboxGames`,
      `${drive}\\Program Files\\Epic Games`,
      `${drive}\\Program Files (x86)\\GOG Galaxy\\Games`,
      `${drive}\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games`,
      `${drive}\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\games`,
      `${drive}\\Ubisoft Games`
    );
  }

  locations.push(path.join(home, 'Games'), path.join(home, 'Desktop'), ...store.addedLocations);
  return uniquePaths(locations);
}

async function discoverSteamLibraries() {
  const registryRoot = await new Promise(resolve => childProcess.execFile('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (error, stdout) => resolve(error ? '' : (stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i)?.[1] || '').trim())));
  const drives = availableDriveRoots().map((drive) => drive.slice(0, 2));
  const candidates = uniquePaths([
    ...(registryRoot ? [path.join(registryRoot, 'steamapps', 'libraryfolders.vdf')] : []),
    ...(store.settings.steamLibraryFolders || []).map(folder => path.join(folder, 'steamapps', 'libraryfolders.vdf')),
    'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
    'C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf',
    ...drives.map((drive) => `${drive}\\SteamLibrary\\steamapps\\libraryfolders.vdf`)
  ]);
  const libraries = [];
  for (const folder of store.settings.steamLibraryFolders || []) libraries.push(path.join(folder, 'steamapps'));
  for (const candidate of candidates) {
    const text = await readText(candidate);
    if (!text) continue;
    const matches = text.matchAll(/"path"\s+"([^"]+)"/g);
    for (const match of matches) {
      libraries.push(path.join(match[1].replace(/\\/g, '\\'), 'steamapps'));
    }
    libraries.push(path.dirname(candidate));
  }
  return uniquePaths(libraries);
}

async function steamOwnerMap() {
  const accounts = await detectSteamAccounts();
  return new Map(accounts.map((account) => [account.steamId64, account.personaName || account.accountName || account.steamId64]));
}

async function detectSteamAccounts() {
  const drives = availableDriveRoots().map((drive) => drive.slice(0, 2));
  const candidates = [
    ...(await discoverSteamLibraries()).map(folder => path.join(path.dirname(folder), 'config', 'loginusers.vdf')),
    'C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf',
    'C:\\Program Files\\Steam\\config\\loginusers.vdf',
    ...drives.map((drive) => `${drive}\\SteamLibrary\\config\\loginusers.vdf`)
  ];
  const owners = new Map();
  for (const candidate of candidates) {
    const text = await readText(candidate);
    if (!text) continue;
    const blocks = text.matchAll(/"(\d{12,})"\s*\{([\s\S]*?)\n\s*\}/g);
    for (const block of blocks) {
      const accountName = block[2].match(/"AccountName"\s+"([^"]+)"/)?.[1];
      const personaName = block[2].match(/"PersonaName"\s+"([^"]+)"/)?.[1];
      const mostRecent = block[2].match(/"MostRecent"\s+"([^"]+)"/)?.[1] === '1';
      owners.set(block[1], {
        steamId64: block[1],
        accountName: accountName || block[1],
        personaName: personaName || accountName || block[1],
        mostRecent,
        sourcePath: candidate,
        apiKey: store.accounts?.steam?.[block[1]]?.apiKey || ''
      });
    }
  }
  const accounts = [...owners.values()].sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent) || a.personaName.localeCompare(b.personaName));
  for (const account of accounts) {
    store.accounts.steam[account.steamId64] = {
      ...store.accounts.steam[account.steamId64],
      steamId64: account.steamId64,
      accountName: account.accountName,
      personaName: account.personaName
    };
  }
  if (!store.accounts.activeSteamId && accounts[0]) store.accounts.activeSteamId = accounts[0].steamId64;
  return accounts;
}

async function scanSteam() {
  const libraries = await discoverSteamLibraries();
  const owners = await steamOwnerMap();
  const games = [];
  for (const steamapps of libraries) {
    let entries = [];
    try {
      entries = await fs.readdir(steamapps, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^appmanifest_\d+\.acf$/i.test(entry.name)) continue;
      const manifest = await readText(path.join(steamapps, entry.name));
      const appId = entry.name.match(/\d+/)?.[0];
      const name = manifest.match(/"name"\s+"([^"]+)"/)?.[1] || `Steam App ${appId}`;
      const installDir = manifest.match(/"installdir"\s+"([^"]+)"/)?.[1] || name;
      const ownerId = manifest.match(/"LastOwner"\s+"([^"]+)"/)?.[1] || '';
      games.push({
        id: stableId(['steam', appId]),
        name,
        source: 'Steam',
        status: 'installed',
        installPath: path.join(steamapps, 'common', installDir),
        launchType: 'steam',
        launcherUri: `steam://rungameid/${appId}`,
        steamAppId: appId,
        executablePath: '',
        workingDirectory: path.join(steamapps, 'common', installDir),
        coverUrl: await firstWorkingImage(await steamImageCandidates(appId, name)),
        libraryPath: steamapps,
        ownerId,
        ownerName: owners.get(ownerId) || ownerId || 'Unknown'
      });
    }
  }
  return games;
}

async function scanEpic() {
  const manifestDirs = [
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
    path.join(os.homedir(), 'AppData\\Local\\EpicGamesLauncher\\Saved\\Config\\Windows')
  ];
  const games = [];
  for (const manifestDir of manifestDirs) {
    let entries = [];
    try {
      entries = await fs.readdir(manifestDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.item') continue;
      const manifest = await readJson(path.join(manifestDir, entry.name));
      if (!manifest?.DisplayName || !manifest?.InstallLocation) continue;
      games.push({
        id: stableId(['epic', manifest.CatalogNamespace || '', manifest.CatalogItemId || manifest.DisplayName]),
        name: manifest.DisplayName,
        source: 'Epic',
        status: 'installed',
        installPath: manifest.InstallLocation,
        launchType: 'epic',
        launcherUri: `com.epicgames.launcher://apps/${manifest.CatalogNamespace || ''}%3A${manifest.CatalogItemId || ''}%3A${manifest.AppName || ''}?action=launch&silent=true`,
        executablePath: '',
        workingDirectory: manifest.InstallLocation,
        coverUrl: '',
        libraryPath: manifestDir,
        ownerName: manifest.InstallationGuid ? 'Epic Local' : 'Local'
      });
    }
  }
  return games;
}

async function scanUbisoft() {
  const drives = availableDriveRoots().map((drive) => drive.slice(0, 2));
  const roots = uniquePaths([
    'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games',
    'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\games',
    ...drives.flatMap((drive) => [
      `${drive}\\Ubisoft Games`,
      `${drive}\\Games\\Ubisoft`,
      `${drive}\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games`
    ])
  ]);
  const games = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const installPath = path.join(root, entry.name);
      const launchers = await findLaunchers(installPath);
      const preferred = launchers.find((launcher) => /launcher|start|play/i.test(launcher.name)) || launchers[0];
      games.push({
        id: stableId(['ubisoft', installPath]),
        name: normalizeGameName(entry.name),
        source: 'Ubisoft',
        status: preferred ? 'installed' : 'installable',
        installPath,
        launchType: preferred?.type || 'ubisoft',
        launcherUri: '',
        executablePath: preferred?.path || '',
        workingDirectory: installPath,
        coverUrl: '',
        libraryPath: root,
        ownerName: 'Ubisoft Local'
      });
    }
  }
  return games;
}

async function scanPortableLocation(root) {
  const games = [];
  const maxDepth = 3;

  async function walk(current, depth) {
    // Steam libraries are owned by the Steam scanner, even when this folder is also selected as a portable location.
    if (/(?:^|[\\/])steamapps[\\/]common(?:[\\/]|$)/i.test(current)) return;
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    const launchers = entries
      .filter((entry) => entry.isFile() && EXECUTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .filter((entry) => !/unins|setup|install|crash|report|vcredist|dxsetup/i.test(entry.name));

    if (launchers.length) {
      const preferred =
        launchers.find((entry) => /\.(bat|cmd)$/i.test(entry.name)) ||
        launchers.find((entry) => /launcher|start|play/i.test(entry.name)) ||
        launchers[0];
      const exePath = path.join(current, preferred.name);
      const recordedVersion = await readJson(path.join(current, VERSION_FILE));
      const ankerVersion = recordedVersion && ankerPage(recordedVersion.sourceUrl) ? recordedVersion : null;
      games.push({
        id: stableId(['portable', exePath]),
        name: normalizeGameName(path.basename(current)) || normalizeGameName(preferred.name),
        source: 'Portable',
        status: 'installed',
        installPath: current,
        launchType: /\.(bat|cmd)$/i.test(preferred.name) ? 'bat' : 'exe',
        launcherUri: '',
        executablePath: exePath,
        workingDirectory: current,
        coverUrl: '',
        libraryPath: root,
        ownerName: 'Local',
        ankerVersion,
        currentVersion: ankerVersion?.version || '',
        currentBuild: ankerVersion?.build || ''
      });
      return;
    }

    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      await walk(path.join(current, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return games;
}

async function findLaunchers(root) {
  const launchers = [];
  const maxDepth = 3;

  async function walk(current, depth) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && EXECUTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (!/unins|setup|install|crash|report|vcredist|dxsetup/i.test(entry.name)) {
          launchers.push({
            name: path.relative(root, fullPath),
            path: fullPath,
            type: /\.(bat|cmd)$/i.test(entry.name) ? 'bat' : 'exe'
          });
        }
      }
      if (entry.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(entry.name.toLowerCase())) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return launchers.sort((a, b) => a.name.localeCompare(b.name));
}

async function addManualGame() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the game launcher file',
    properties: ['openFile'],
    filters: [{ name: 'Game launchers', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] }]
  });
  if (result.canceled || !result.filePaths[0]) return store;

  const executablePath = result.filePaths[0];
  const installPath = path.dirname(executablePath);
  const name = normalizeGameName(path.basename(installPath)) || normalizeGameName(path.basename(executablePath));
  const game = {
    id: stableId(['manual', executablePath, Date.now().toString()]),
    name,
    source: 'Manual',
    status: 'installed',
    installPath,
    launchType: /\.(bat|cmd)$/i.test(executablePath) ? 'bat' : 'exe',
    launcherUri: '',
    executablePath,
    workingDirectory: installPath,
    coverUrl: await findSteamCoverByName(name),
    libraryPath: installPath,
    ownerName: 'Local',
    manuallyAdded: true,
    lastSeen: new Date().toISOString()
  };

  store.games = [game, ...store.games].sort((a, b) => a.name.localeCompare(b.name));
  await saveStore();
  return store;
}

async function addCatalogGame(_event, draft) {
  const source = draft.source || 'Manual';
  const externalId = draft.externalId || draft.name || Date.now().toString();
  const installUri =
    draft.installUri ||
    (source === 'Steam' && draft.externalId ? `steam://install/${draft.externalId}` : '') ||
    (source === 'Ubisoft' && draft.externalId ? `uplay://launch/${draft.externalId}/0` : '');
  const game = {
    id: stableId(['catalog', source, externalId, Date.now().toString()]),
    name: draft.name || `${source} Game`,
    source,
    status: 'installable',
    installPath: draft.installPath || store.settings.defaultInstallPath || '',
    launchType: source.toLowerCase(),
    launcherUri: installUri,
    installUri,
    storeUrl: draft.storeUrl || '',
    externalId,
    executablePath: '',
    workingDirectory: draft.installPath || store.settings.defaultInstallPath || '',
    coverUrl: draft.coverUrl || '',
    libraryPath: draft.installPath || store.settings.defaultInstallPath || source,
    ownerName: draft.ownerName || 'Unknown',
    lastSeen: new Date().toISOString()
  };
  game.coverUrl ||= await findBestCoverForGame(game);
  store.games = [game, ...store.games].sort((a, b) => a.name.localeCompare(b.name));
  await saveStore();
  return store;
}

async function importSteamOwnedGames() {
  if (steamImportAbortController) throw new Error('Steam import is already running.');
  steamImportAbortController = new AbortController();
  const signal = steamImportAbortController.signal;
  const steamId = store.accounts.activeSteamId || store.settings.steamId64?.trim();
  const activeAccount = store.accounts.steam[steamId] || {};
  const key = activeAccount.apiKey || store.settings.steamApiKey?.trim();
  if (!key || !steamId) {
    steamImportAbortController = null;
    throw new Error('Select a Steam account and add its Steam Web API key in Settings first.');
  }

  try {
    const response = await fetch(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1`,
      { signal }
    );
    if (!response.ok) throw new Error('Steam library import failed.');
    const payload = await response.json();
    const owned = payload.response?.games || [];
    const installedSteamIds = new Set(store.games.filter((game) => game.source === 'Steam' && game.steamAppId).map((game) => String(game.steamAppId)));
    const existingCatalogIds = new Set(store.games.filter((game) => game.source === 'Steam' && game.externalId).map((game) => String(game.externalId)));
    const ownerName = activeAccount.personaName || activeAccount.accountName || steamId;
    const additions = [];

    for (const item of owned) {
      if (signal.aborted) throw new Error('Steam import was canceled.');
      const appId = String(item.appid);
      if (installedSteamIds.has(appId) || existingCatalogIds.has(appId)) continue;
      additions.push({
        id: stableId(['catalog', 'Steam', appId]),
        name: item.name || `Steam App ${appId}`,
        source: 'Steam',
        status: 'installable',
        installPath: store.settings.defaultInstallPath || '',
        launchType: 'steam',
        launcherUri: `steam://install/${appId}`,
        installUri: `steam://install/${appId}`,
        storeUrl: `https://store.steampowered.com/app/${appId}`,
        externalId: appId,
        steamAppId: appId,
        executablePath: '',
        workingDirectory: store.settings.defaultInstallPath || '',
        coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
        libraryPath: 'Steam account library',
        ownerId: steamId,
        ownerName,
        lastSeen: new Date().toISOString()
      });
      if (additions.length % 20 === 0) await delay(100);
    }

    store.games = [...store.games, ...additions].sort((a, b) => a.name.localeCompare(b.name));
    await saveStore();
    return store;
  } finally {
    steamImportAbortController = null;
  }
}

async function updateSteamAccount(_event, account) {
  const steamId = account.steamId64;
  if (!steamId) throw new Error('SteamID64 is required.');
  store.accounts.activeSteamId = steamId;
  store.accounts.steam[steamId] = {
    ...store.accounts.steam[steamId],
    ...account
  };
  await saveStore();
  return store;
}

async function scanAll() {
  const roots = [];
  for (const candidate of commonLocations()) {
    if (await pathExists(candidate)) roots.push(candidate);
  }
  const scanned = [...(await scanSteam()), ...(await scanEpic()), ...(await scanUbisoft())];
  for (const root of roots) {
    scanned.push(...(await scanPortableLocation(root)));
  }

  const existingById = new Map(store.games.map((game) => [game.id, game]));
  const scannedPortableRoots = new Set(roots.map(root => path.resolve(root).toLowerCase()));
  const existingSteamCatalogByAppId = new Map(
    store.games
      .filter((game) => game.source === 'Steam' && game.status === 'installable' && game.steamAppId)
      .map((game) => [String(game.steamAppId), game])
  );
  const merged = [];
  const seen = new Set();
  const seenLocations = new Set();
  const scannedSteamAppIds = new Set(scanned.filter((game) => game.source === 'Steam' && game.steamAppId).map((game) => String(game.steamAppId)));
  for (const game of scanned) {
    const locationKey = `${game.source}|${path.resolve(game.installPath || game.executablePath || '').toLowerCase()}`;
    if (seen.has(game.id) || (game.installPath && seenLocations.has(locationKey))) continue;
    seen.add(game.id);
    if (game.installPath) seenLocations.add(locationKey);
    const existing = existingById.get(game.id) || (game.source === 'Steam' ? existingSteamCatalogByAppId.get(String(game.steamAppId)) : null);
    const mergedGame = { ...game, ...existing, lastSeen: new Date().toISOString() };
    mergedGame.status = game.status;
    mergedGame.installPath = game.installPath;
    mergedGame.launcherUri = game.launcherUri;
    mergedGame.installUri = game.installUri;
    mergedGame.executablePath = game.executablePath;
    mergedGame.workingDirectory = game.workingDirectory;
    mergedGame.libraryPath = game.libraryPath;
    if (game.ankerVersion) {
      mergedGame.ankerVersion = game.ankerVersion;
      mergedGame.currentVersion = game.currentVersion;
      mergedGame.currentBuild = game.currentBuild;
      delete mergedGame.updateInfo;
    }
    if (!existing?.coverUrl) mergedGame.coverUrl = game.coverUrl;
    merged.push(mergedGame);
  }
  for (const game of store.games) {
    if (game.source === 'Steam' && game.status === 'installable' && scannedSteamAppIds.has(String(game.steamAppId))) continue;
    const locationKey = `${game.source}|${path.resolve(game.installPath || game.executablePath || '').toLowerCase()}`;
    const scannedPortableRoot = game.source === 'Portable' && game.libraryPath && scannedPortableRoots.has(path.resolve(game.libraryPath).toLowerCase());
    // Do not retain a portable game when its reachable scan root no longer finds it.
    // A root on an unplugged drive is intentionally not in scannedPortableRoots, so its library entry stays safe.
    if (scannedPortableRoot && !seen.has(game.id) && !(game.installPath && seenLocations.has(locationKey))) continue;
    if (!seen.has(game.id) && !(game.installPath && seenLocations.has(locationKey))) { merged.push(game); if (game.installPath) seenLocations.add(locationKey); }
  }
  store.games = await hydrateCoverArt(merged.sort((a, b) => a.name.localeCompare(b.name)));
  await saveStore();
  return store;
}

async function findSteamCoverByName(name) {
  if (!store.settings.coverLookup || !store.settings.steamCoverLookup) return '';
  const cacheKey = name.toLowerCase();
  if (store.coverCache[cacheKey] && !steamBannerAppId(store.coverCache[cacheKey])) return store.coverCache[cacheKey];
  try {
    const response = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=en&cc=US`);
    if (!response.ok) return '';
    const payload = await response.json();
    const cleaned = normalizeGameName(name).toLowerCase();
    const exact =
      payload.items?.find((item) => item.name?.toLowerCase() === cacheKey) ||
      payload.items?.find((item) => item.name?.toLowerCase() === cleaned) ||
      payload.items?.find((item) => item.name?.toLowerCase().includes(cleaned) || cleaned.includes(item.name?.toLowerCase()));
    if (!exact?.id) return '';
    const cover = await firstWorkingImage(await steamImageCandidates(exact.id, exact.name));
    if (!cover) return '';
    store.coverCache[cacheKey] = cover;
    return cover;
  } catch {
    return '';
  }
}

async function searchSteamArt(name) {
  if (!store.settings.coverLookup || !store.settings.steamCoverLookup) return [];
  try {
    const response = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=en&cc=US`);
    if (!response.ok) return [];
    const payload = await response.json();
    return (await Promise.all((payload.items || []).slice(0, 10).filter(item => item.id).map(item => steamImageCandidates(item.id, item.name)))).flat();
  } catch {
    return [];
  }
}

async function findBestCoverForGame(game) {
  if (!store.settings.coverLookup || game.coverUrl) return game.coverUrl || '';
  if (game.steamAppId && store.settings.steamCoverLookup) {
    const cover = await firstWorkingImage(await steamImageCandidates(game.steamAppId, game.name));
    if (cover) return cover;
  }
  const terms = coverSearchTerms(game, '').slice(0, 3);
  for (const term of terms) {
    const cover = await findSteamCoverByName(term);
    if (cover) return cover;
    await delay(180);
  }
  for (const term of terms) {
    const candidates = await searchGogArt(term);
    const matching = candidates.filter(item => artworkTitleKey(item.title) === artworkTitleKey(term));
    const cover = await firstWorkingImage(matching);
    if (cover) return cover;
  }
  return '';
}

function artworkTitleKey(title) {
  return title.toLowerCase().replace(/[™®]/g, '').replace(/[^a-z0-9]+/g, '');
}

async function searchGogArt(name) {
  if (!store.settings.coverLookup || !name.trim()) return [];
  try {
    const params = new URLSearchParams({ query: name, limit: '8', productType: 'in:game' });
    const response = await fetch(`https://catalog.gog.com/v1/catalog?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.products || [])
      .filter(item => item.title && /^https:\/\/images[^/]*\.gog-statics\.com\//.test(item.coverVertical || ''))
      .map(item => ({ provider: 'GOG', title: item.title, url: item.coverVertical, preview: item.coverVertical }));
  } catch {
    return [];
  }
}

async function steamGridDbFetch(endpoint) {
  const key = store.settings.steamGridDbKey?.trim();
  if (!key) return null;
  const response = await fetch(`https://www.steamgriddb.com/api/v2/${endpoint}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!response.ok) return null;
  return response.json();
}

async function searchSteamGridDbArt(name, steamAppId) {
  if (!store.settings.coverLookup) return [];
  try {
    const games = [];
    if (steamAppId) {
      const bySteam = await steamGridDbFetch(`games/steam/${steamAppId}`);
      if (bySteam?.data) games.push(bySteam.data);
    }
    const search = await steamGridDbFetch(`search/autocomplete/${encodeURIComponent(name)}`);
    games.push(...(search?.data || []).slice(0, 5));
    const candidates = [];
    const seenGames = new Set();
    for (const game of games) {
      if (seenGames.has(game.id)) continue;
      seenGames.add(game.id);
      const grids = await steamGridDbFetch(`grids/game/${game.id}?dimensions=600x900,342x482,660x930`);
      for (const grid of (grids?.data || []).slice(0, 8)) {
        candidates.push({
          provider: 'SteamGridDB',
          title: game.name,
          url: grid.url,
          preview: grid.thumb || grid.url
        });
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

function coverSearchTerms(game, query) {
  return uniquePaths([
    /^https?:\/\//i.test(query?.trim() || '') ? '' : query?.trim(),
    game.name,
    normalizeGameName(game.name),
    normalizeGameName(game.installPath || ''),
    normalizeGameName(game.executablePath || '')
  ]).slice(0, 4);
}

async function searchCoverArt(gameId, query = '') {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  const cacheKey = `portrait-v3|${game.id}|${query.trim().toLowerCase()}|${!!store.settings.steamGridDbKey}|${!!store.settings.steamCoverLookup}`;
  if (!store.settings.coverLookup) return [];
  const cached = store.coverSearchCache[cacheKey];
  if (cached?.results?.length && Date.now() - cached.cachedAt < 86400000) return cached.results;
  const results = [];
  const appId = game.steamAppId || steamBannerAppId(game.coverUrl);
  if (appId && store.settings.steamCoverLookup) results.push(...await steamImageCandidates(appId, game.name));
  for (const term of coverSearchTerms(game, query)) {
    const providers = await Promise.allSettled([
      searchSteamArt(term), searchGogArt(term), searchSteamGridDbArt(term, game.steamAppId)
    ]);
    for (const provider of providers) {
      if (provider.status === 'fulfilled') results.push(...provider.value);
    }
  }
  const seen = new Set();
  const unique = results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
  const filtered = [];
  for (const result of unique) {
    if (await imageExists(result.preview || result.url)) filtered.push(result);
    if (filtered.length >= 36) break;
    await delay(60);
  }
  if (filtered.length) store.coverSearchCache[cacheKey] = { cachedAt: Date.now(), results: filtered };
  await saveStore();
  return filtered;
}

async function hydrateCoverArt(games) {
  const hydrated = [];
  for (const game of games) {
    const bannerAppId = steamBannerAppId(game.coverUrl);
    if (bannerAppId && store.settings.coverLookup && store.settings.steamCoverLookup) {
      const portrait = await firstWorkingImage(await steamImageCandidates(bannerAppId, game.name))
        || await findBestCoverForGame({ ...game, coverUrl: '' });
      hydrated.push({ ...game, coverUrl: portrait || game.coverUrl });
      continue;
    }
    if (game.coverUrl) {
      hydrated.push(game);
      continue;
    }
    hydrated.push({ ...game, coverUrl: await findBestCoverForGame(game) });
  }
  return hydrated;
}

async function getStoreInfo(gameId) {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  const cacheKey = game.steamAppId ? `steam:${game.steamAppId}` : `search:${game.name.toLowerCase()}`;
  if (store.storeInfoCache[cacheKey]) return store.storeInfoCache[cacheKey];

  let appId = game.steamAppId;
  let matchedTitle = game.name;
  if (!appId && store.settings.steamCoverLookup) {
    const response = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(game.name)}&l=en&cc=US`);
    if (response.ok) {
      const payload = await response.json();
      const match = payload.items?.[0];
      appId = match?.id;
      matchedTitle = match?.name || matchedTitle;
    }
  }

  if (!appId) {
    const fallback = {
      provider: game.source,
      title: game.name,
      summary: 'No store details found yet.',
      actionUrl: '',
      tags: [game.source, game.launchType || 'local'].filter(Boolean)
    };
    store.storeInfoCache[cacheKey] = fallback;
    await saveStore();
    return fallback;
  }

  const details = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=en&cc=US`);
  const payload = details.ok ? await details.json() : null;
  const data = payload?.[appId]?.data;
  const info = {
    provider: game.source === 'Steam' ? 'Steam Store' : 'Steam Store Match',
    title: data?.name || matchedTitle,
    summary: (data?.short_description || 'Store details are available for this game.').replace(/<[^>]+>/g, ''),
    actionUrl: `https://store.steampowered.com/app/${appId}`,
    tags: [data?.genres?.[0]?.description, data?.developers?.[0], data?.release_date?.date].filter(Boolean).slice(0, 3)
  };
  store.storeInfoCache[cacheKey] = info;
  await saveStore();
  return info;
}

const STORE_PROVIDERS = ['All', 'Steam', 'Epic', 'Xbox', 'EA', 'Ubisoft'];
const STORE_GENRES = ['All', 'Co-op', 'RPG', 'Action', 'Strategy', 'Indie'];
const STORE_LINKS = {
  Steam: q => `https://store.steampowered.com/search/?term=${encodeURIComponent(q)}`,
  Epic: q => `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(q)}`,
  Xbox: q => `https://www.xbox.com/en-US/search?q=${encodeURIComponent(q)}`,
  EA: q => `https://www.ea.com/search?q=${encodeURIComponent(q)}`,
  Ubisoft: q => `https://store.ubisoft.com/us/search?q=${encodeURIComponent(q)}`
};

function storeFallback(query) {
  return STORE_PROVIDERS.slice(1).map((provider, index) => ({
    id: `store-${provider}-${query}-${index}`, name: query, provider,
    genre: ['Action', 'RPG', 'Co-op', 'Strategy', 'Indie'][index],
    description: `Search ${provider}'s catalog for ${query}.`, coverUrl: '',
    sourceUrl: STORE_LINKS[provider](query), tags: [provider]
  }));
}

async function searchStore(query = '', filters = {}) {
  const term = query.trim();
  const key = `${term.toLowerCase()}|${filters.provider || 'All'}|${filters.genre || 'All'}`;
  const cached = store.storeSearchCache[key];
  if (cached && Date.now() - cached.cachedAt < 7 * 24 * 60 * 60 * 1000) {
    const validCached = term ? cached.results : cached.results.filter(item => item.provider === 'Steam' && item.coverUrl);
    if (validCached.length) return validCached;
  }
  let results = storeFallback(term || 'featured games');
  try {
    const endpoint = term ? `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=en&cc=US` : 'https://store.steampowered.com/api/featuredcategories/';
    const response = await fetch(endpoint, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const payload = response.ok ? await response.json() : null;
    const items = term ? (payload?.items || []) : [...(payload?.new_releases?.items || []), ...(payload?.specials?.items || []), ...(payload?.top_sellers?.items || [])];
    const steam = items.slice(0, 24).map(item => ({ id: `steam-${item.id}`, name: item.name, provider: 'Steam', genre: 'Action', description: term ? 'Available on the Steam Store.' : 'Featured on Steam.', coverUrl: item.large_capsule_image || item.tiny_image || '', sourceUrl: `https://store.steampowered.com/app/${item.id}`, tags: ['Steam', term ? 'Search result' : 'New & featured'] }));
    results = steam.length ? steam : (term ? results : []);
  } catch { /* official provider links remain available offline */ }
  results = results.filter(item => (filters.provider === 'All' || !filters.provider || item.provider === filters.provider) && (filters.genre === 'All' || !filters.genre || item.genre === filters.genre));
  store.storeSearchCache[key] = { cachedAt: Date.now(), results }; await saveStore(); return results;
}

async function findGameLinks(game) {
  const title = String(game?.name || '').trim();
  if (!title) return [];
  const query = encodeURIComponent(title);
  const providers = [
    ['ankergames.net', `https://ankergames.net/?s=${query}`],
    ['Online-Fix', `https://online-fix.me/index.php?do=search&subaction=search&story=${query}`],
    ['Zeigames', `https://zeigames.com/search/?q=${query}`],
    ['Steam Store', `https://store.steampowered.com/search/?term=${query}`],
    ['Epic Games Store', `https://store.epicgames.com/en-US/browse?q=${query}`],
    ['GOG', `https://www.gog.com/en/games?query=${query}`],
    ['Xbox', `https://www.xbox.com/en-US/search?q=${query}`],
    ['Ubisoft Store', `https://store.ubisoft.com/us/search?q=${query}`]
  ];
  const normalize = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const queryTitle = normalize(title);
  const terms = queryTitle.split(/\s+/).filter(Boolean);
  const primary = [];
  const ankerSlug = queryTitle.replace(/\s+/g, '-');
  if (ankerSlug) primary.push({ provider: 'ankergames.net', title, url: `https://ankergames.net/game/${ankerSlug}`, fallback: true });
  primary.push({ provider: 'Zeigames', title: `Search ${title} on Zeigames`, url: `https://zeigames.com/search/?q=${query}`, fallback: true });
  // Zeigames uses forum topic URLs and does not support the WordPress-style
  // `?s=` search route. Use a site-restricted search to resolve the topic URL.
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`site:zeigames.com/topic ${title}`)}`;
    const response = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    const html = response.ok ? await response.text() : '';
    const topicPattern = /https?:\/\/(?:www\.)?zeigames\.com\/topic\/[^\"'&<>\s]+/gi;
    const seen = new Set();
    for (const match of html.matchAll(topicPattern)) {
      const url = match[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/[),.;]+$/, '');
      if (seen.has(url) || /\/topic\/(?:search|page\/)/i.test(url)) continue;
      seen.add(url);
      primary.push({ provider: 'Zeigames', title: url.split('/topic/')[1].replace(/-/g, ' ').replace(/\/$/, ''), url });
      if (seen.size >= 5) break;
    }
  } catch { /* search engines may be unavailable or challenge automated requests */ }
  // Do not fabricate hits from generic search pages. These sites may challenge
  // requests, so only show results when a title link can be verified in HTML.
  for (const [provider, searchUrl] of providers.slice(0, 3)) {
    try {
      const response = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const html = await response.text();
      if (!html || /enable javascript and cookies to continue|just a moment|access denied/i.test(html)) continue;
      const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      const seen = new Set();
      let match;
      while ((match = linkPattern.exec(html))) {
        const url = new URL(match[1].replace(/&amp;/g, '&'), searchUrl);
        const linkTitle = match[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
        const normalized = normalize(linkTitle);
        const score = terms.filter(term => normalized.split(' ').includes(term)).length;
        if (!linkTitle || score < Math.max(1, Math.ceil(terms.length * 0.75))) continue;
        if (provider === 'ankergames.net') {
          if (!/^(www\.)?ankergames\.net$/i.test(url.hostname) || !/^\/game\/[^/]+\/?$/.test(url.pathname)) continue;
        } else if (provider === 'Online-Fix') {
          if (!/^(www\.)?online-fix\.me$/i.test(url.hostname) || url.pathname === '/' || /search|index\.php/i.test(url.pathname + url.search)) continue;
        } else if (!/^(www\.)?zeigames\.com$/i.test(url.hostname) || url.pathname === '/' || /search/i.test(url.pathname + url.search)) continue;
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        primary.push({ provider, title: linkTitle, url: url.href });
      }
    } catch { /* blocked or unavailable providers return no matches */ }
  }
  const secondary = providers.slice(2).map(([provider, url]) => ({
    provider, title: `Search ${title} on ${provider}`, url, fallback: true
  }));
  const ankerResults = primary.filter(link => link.provider === 'ankergames.net');
  const onlineFixResults = primary.filter(link => link.provider === 'Online-Fix');
  const zeigamesResults = primary.filter(link => link.provider === 'Zeigames').sort((a, b) => Number(!!a.fallback) - Number(!!b.fallback));
  return [...ankerResults, ...onlineFixResults, ...zeigamesResults, ...secondary.filter(link => link.provider !== 'Zeigames')];
}
const VERSION_FILE = '.chrona-version.json';
const UPDATE_INTERVAL = 12 * 60 * 60 * 1000;
function ankerPage(url) {
  try { const parsed = new URL(url); return /^(www\.)?ankergames\.net$/i.test(parsed.hostname) && /^\/game\/[^/]+\/?$/.test(parsed.pathname) ? parsed.href : ''; }
  catch { return ''; }
}
async function readAnkerVersion(url) {
  if (!ankerPage(url)) throw new Error('Invalid AnkerGames game page.');
  const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  let timeout;
  try {
    return await Promise.race([(async () => {
      await page.loadURL(url);
      await new Promise(resolve => setTimeout(resolve, 1200));
      const data = await page.webContents.executeJavaScript(`({ text: document.body?.innerText || '', badge: [...document.querySelectorAll('span.animate-glow')].map(node => node.innerText.trim()).find(value => /^V\\s*\\S+/i.test(value)) || '' })`);
      if (!data.text || /access denied|just a moment|error 403/i.test(data.text)) throw new Error('AnkerGames is unavailable.');
      const read = label => data.text.match(new RegExp('(?:' + label + ')\\s*[:\\-]?\\s*([^\\r\\n]+)', 'i'))?.[1]?.trim() || '';
      const version = data.badge.replace(/^V\s*/i, '') || read('current version');
      const build = read('current build');
      if (!version && !build) throw new Error('No downloadable version found on AnkerGames.');
      return { provider: 'ankergames.net', sourceUrl: url, version, build };
    })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Update check timed out.')), 30000); })]);
  } finally { clearTimeout(timeout); if (!page.isDestroyed()) page.destroy(); }
}
async function recordInstalledVersion(game, metadata) {
  if (!metadata || !ankerPage(metadata.sourceUrl)) return;
  const installed = { ...metadata, installedAt: new Date().toISOString() };
  await fs.writeFile(path.join(game.installPath, VERSION_FILE), JSON.stringify(installed, null, 2), 'utf8');
  game.ankerVersion = installed;
  game.currentVersion = installed.version;
  game.currentBuild = installed.build;
  delete game.updateInfo;
}
async function checkPortableUpdate(game) {
  if (game.source !== 'Portable' || !game.ankerVersion) return { gameId: game.id, hasUpdate: false };
  const installed = game.ankerVersion;
  const latest = await readAnkerVersion(installed.sourceUrl);
  // Compare the site's downloadable release, never its latest Steam build.
  const normalize = value => String(value || '').trim().replace(/^v\s*/i, '').toLowerCase();
  const hasUpdate = !!((installed.version && latest.version && normalize(installed.version) !== normalize(latest.version)) || (installed.build && latest.build && normalize(installed.build) !== normalize(latest.build)));
  const result = { ...latest, hasUpdate, checkedAt: new Date().toISOString() };
  const current = store.games.find(item => item.id === game.id);
  if (current && current.ankerVersion === installed) {
    current.updateInfo = result;
    await saveStore();
  }
  return { ...result, gameId: game.id };
}
let checkingUpdates = false;
async function checkTrackedUpdates() {
  if (checkingUpdates) return;
  checkingUpdates = true;
  try {
    for (const game of [...store.games]) {
      if (game.source !== 'Portable' || !game.ankerVersion) continue;
      try { await checkPortableUpdate(game); } catch { /* Keep the last known result when offline. */ }
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed');
  } finally { checkingUpdates = false; }
}

async function getStoreGameDetails(game) {
  const base = { ...game, description: game.description || 'Game details are available from the original store.', tags: game.tags || [game.provider], storage: 'Not listed', releaseDate: 'TBA', developer: 'Not listed', publisher: 'Not listed' };
  const appId = String(game.id || '').replace(/^steam-/, '');
  if (game.provider !== 'Steam' || !/^\d+$/.test(appId)) return base;
  try {
    const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=en&cc=US`);
    const data = response.ok ? (await response.json())?.[appId]?.data : null;
    if (!data) return base;
    const requirements = data.pc_requirements?.minimum || '';
    return { ...base, title: data.name, description: (data.detailed_description || data.short_description || base.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), coverUrl: data.header_image || data.background || base.coverUrl, backgroundUrl: data.background, tags: [...(data.genres || []).map(item => item.description), ...(data.categories || []).slice(0, 4).map(item => item.description)], releaseDate: data.release_date?.date || base.releaseDate, developer: data.developers?.join(', ') || base.developer, publisher: data.publishers?.join(', ') || base.publisher, storage: requirements.match(/(?:storage|hard drive space)[^\d]*(\d+(?:\.\d+)?\s*(?:GB|MB))/i)?.[1] || 'See system requirements' };
  } catch { return base; }
}

async function launchGame(game) {
  if (game.status === 'installable') {
    await installGame(game);
    return;
  }

  const options = {
    cwd: game.workingDirectory || path.dirname(game.executablePath || game.installPath || app.getPath('home')),
    detached: true,
    stdio: 'ignore',
    // Games need a visible window, including those started by batch launchers.
    windowsHide: false
  };

  if (game.launchType === 'steam' || game.launchType === 'epic' || game.launchType === 'xbox' || game.launchType === 'ubisoft' || game.launchType === 'uri') {
    await shell.openExternal(game.launcherUri);
    playingTracker.track(game);
    return;
  }

  if (!game.executablePath) throw new Error('No executable or batch file is assigned.');
  if (/\.(lnk|url)$/i.test(game.executablePath)) {
    const error = await shell.openPath(game.executablePath);
    if (error) throw new Error(error);
    playingTracker.track(game);
    return;
  }
  const isBatch = /\.(bat|cmd)$/i.test(game.executablePath) || game.launchType === 'bat';
  await new Promise((resolve, reject) => {
    const child = childProcess.spawn(isBatch ? 'cmd.exe' : game.executablePath,
      isBatch ? ['/c', game.executablePath] : [], options);
    child.once('error', reject);
    child.once('spawn', () => {
      playingTracker.track(game, child.pid);
      child.unref();
      resolve();
    });
  });
}

async function installGame(game) {
  const uri = game.installUri || game.launcherUri;
  if (uri) {
    await shell.openExternal(uri);
    return;
  }
  if (game.storeUrl) {
    await shell.openExternal(game.storeUrl);
    return;
  }
  throw new Error('No install action is configured for this game.');
}

async function browseGameFiles(game) {
  const target = game.installPath || game.workingDirectory || path.dirname(game.executablePath || '');
  if (!target) throw new Error('No local folder is assigned for this game.');
  await shell.openPath(target);
}

function isDangerousDeleteTarget(target) {
  if (!target) return true;
  const parsed = path.parse(path.resolve(target));
  const resolved = path.resolve(target).toLowerCase();
  const dangerous = [
    parsed.root.toLowerCase(),
    os.homedir().toLowerCase(),
    app.getPath('desktop').toLowerCase(),
    app.getPath('documents').toLowerCase(),
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\users',
    'c:\\windows'
  ];
  return dangerous.includes(resolved);
}

function removeGameFromStore(gameId) {
  store.games = store.games.filter((game) => game.id !== gameId);
}

async function uninstallGame(game) {
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 0,
    cancelId: 0,
    title: `Uninstall ${game.name}`,
    message: `Uninstall ${game.name}?`,
    detail:
      game.source === 'Steam'
        ? 'Steam will open its uninstall flow. Chrona will remove this game from your local library list.'
        : game.source === 'Epic'
          ? 'Epic Games Launcher will be asked to uninstall this game. Chrona will remove this game from your local library list.'
        : `The folder below will be permanently deleted:\n\n${game.installPath || game.workingDirectory || path.dirname(game.executablePath || '')}`
  });
  if (choice.response !== 1) return store;

  if (game.source === 'Steam' && game.steamAppId) {
    await shell.openExternal(`steam://uninstall/${game.steamAppId}`);
    removeGameFromStore(game.id);
    await saveStore();
    return store;
  }

  if (game.source === 'Epic' && game.launcherUri) {
    await shell.openExternal(game.launcherUri.replace('action=launch', 'action=uninstall'));
    removeGameFromStore(game.id);
    await saveStore();
    return store;
  }

  const target = game.installPath || game.workingDirectory || path.dirname(game.executablePath || '');
  if (isDangerousDeleteTarget(target)) {
    throw new Error('Chrona refused to uninstall because the target folder is too broad.');
  }
  await fs.rm(target, { recursive: true, force: true });
  removeGameFromStore(game.id);
  await saveStore();
  return store;
}

async function verifyGame(game) {
  if (game.launchType === 'steam' && game.steamAppId) {
    await shell.openExternal(`steam://validate/${game.steamAppId}`);
    return 'Opened Steam file verification.';
  }

  if (game.launchType === 'epic' && game.launcherUri) {
    await shell.openExternal(game.launcherUri.replace('action=launch', 'action=verify'));
    return 'Opened Epic Games verification.';
  }

  if (game.installPath) {
    await shell.openPath(game.installPath);
    return 'Portable games do not have a standard verification API, so the local folder was opened.';
  }

  throw new Error('This game does not support automatic verification yet.');
}

async function refreshDefenderStatus() {
  store.defenderFoldersExcluded = await foldersAreExcluded([store.settings.downloadPath, store.settings.defaultInstallPath].filter(Boolean));
  return store;
}
ipcMain.handle('store:get', refreshDefenderStatus);
ipcMain.handle('downloads:exclusions', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Invalid exclusion setting.');
  await offerDefenderExclusion(dialog, mainWindow, [store.settings.downloadPath, store.settings.defaultInstallPath].filter(Boolean), enabled);
  return refreshDefenderStatus();
});
ipcMain.handle('library:scan', scanAll);
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('locations:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
  if (result.canceled) return store;
  store.addedLocations = uniquePaths([...store.addedLocations, ...result.filePaths]);
  await saveStore();
  await offerDefenderExclusion(dialog, mainWindow, result.filePaths);
  return scanAll();
});
ipcMain.handle('locations:remove', async (_event, folder) => {
  const resolved = path.resolve(String(folder || '')).toLowerCase();
  store.addedLocations = store.addedLocations.filter(item => path.resolve(item).toLowerCase() !== resolved);
  await saveStore();
  return store;
});
ipcMain.handle('locations:open', async (_event, folder) => {
  const target = path.resolve(String(folder || ''));
  if (!store.addedLocations.some(item => path.resolve(item).toLowerCase() === target.toLowerCase())) throw new Error('Folder is not in your library list.');
  return shell.openPath(target);
});
ipcMain.handle('game:addManual', addManualGame);
ipcMain.handle('game:addCatalog', addCatalogGame);
ipcMain.handle('library:importSteam', importSteamOwnedGames);
ipcMain.handle('library:cancelSteamImport', () => {
  if (steamImportAbortController) steamImportAbortController.abort();
  return store;
});
ipcMain.handle('steam:detectAccounts', async () => {
  const accounts = await detectSteamAccounts();
  await saveStore();
  return { ...store, detectedSteamAccounts: accounts };
});
ipcMain.handle('steam:updateAccount', updateSteamAccount);
ipcMain.handle('game:update', async (_event, updated) => {
  const existing = store.games.find(game => game.id === updated.id);
  if (existing?.source === 'Portable' && existing.ankerVersion &&
      (updated.currentVersion !== existing.currentVersion || updated.currentBuild !== existing.currentBuild)) {
    const edited = { ...existing, ...updated };
    await recordInstalledVersion(edited, { ...existing.ankerVersion, version: updated.currentVersion || '', build: updated.currentBuild || '' });
    updated = edited;
  }
  store.games = store.games.map((game) => (game.id === updated.id ? { ...game, ...updated } : game));
  await saveStore();
  return store;
});
ipcMain.handle('game:delete', async (_event, gameId) => {
  removeGameFromStore(gameId);
  await saveStore();
  return store;
});
ipcMain.handle('game:uninstall', async (_event, gameId) => {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  return uninstallGame(game);
});
ipcMain.handle('game:listLaunchers', async (_event, gameId) => {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  return findLaunchers(game.installPath || game.workingDirectory || path.dirname(game.executablePath || ''));
});
ipcMain.handle('game:pickExecutable', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Launchers', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('game:launch', async (_event, gameId) => {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  await launchGame(game);
  game.lastPlayed = new Date().toISOString();
  await saveStore();
  return store;
});
ipcMain.handle('game:install', async (_event, gameId) => {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  await installGame(game);
  return store;
});
ipcMain.handle('game:browse', async (_event, gameId) => {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  await browseGameFiles(game);
});
ipcMain.handle('game:verify', async (_event, gameId) => {
  const game = store.games.find((item) => item.id === gameId);
  if (!game) throw new Error('Game was not found.');
  return verifyGame(game);
});
ipcMain.handle('cover:search', async (_event, gameId, query) => searchCoverArt(gameId, query));
ipcMain.handle('store:info', async (_event, gameId) => getStoreInfo(gameId));
ipcMain.handle('store:search', async (_event, query, filters) => searchStore(query, filters || {}));
ipcMain.handle('store:catalog', async (_event, filters) => searchStore('', filters || {}));
ipcMain.handle('store:links', async (_event, game) => findGameLinks(game));
ipcMain.handle('zeigames:warning', async () => {
  const result = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Continue', 'Go Back'], defaultId: 0, cancelId: 1, title: 'Zeigames', message: 'Zeigames commonly uses multi-part downloads. Do you want to continue?' });
  return result.response === 0;
});
ipcMain.handle('multipart:chooseType', async () => {
  const result = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['Single File', 'Multi-Part', 'Cancel'], defaultId: 0, cancelId: 2, title: 'Download type', message: 'Is this game a single-file download or a multi-part download?' });
  return result.response === 0 ? 'single' : result.response === 1 ? 'multi' : null;
});
ipcMain.handle('multipart:resumeType', async (_event, game, url, type, count) => {
  if (!game?.name || !/^https:\/\/zeigames\.com\//i.test(url || '')) throw new Error('A Zeigames game page is required.');
  if (type === 'single') return { game: { ...game, sourceProvider: 'Zeigames', downloadType: 'single' }, url };
  if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('Enter a number of parts from 2 to 100.');
  const session = { id: require('crypto').randomUUID(), source: 'Zeigames', gameTitle: game.name, game: { ...game }, installationJobId: game.installationJobId || null, packageId: game.packageId || 'main-game', originalUrl: url, downloadType: 'multi', expectedParts: count, downloadedPartsCount: 0, downloadedParts: [], status: 'collecting_parts', createdAt: new Date().toISOString() };
  store.downloadSessions ||= []; store.downloadSessions.unshift(session); await saveStore();
  return { session, game: { ...game, sourceProvider: 'Zeigames', downloadType: 'multi', multipartSessionId: session.id }, url };
});
ipcMain.handle('multipart:start', async (_event, game, url, type, count) => {
  if (!game?.name || !/^https:\/\/zeigames\.com\//i.test(url || '')) throw new Error('A Zeigames game page is required.');
  if (type === 'single') return { game: { ...game, sourceProvider: 'Zeigames', downloadType: 'single' }, url };
  if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('Enter a number of parts from 2 to 100.');
  const session = { id: require('crypto').randomUUID(), source: 'Zeigames', gameTitle: game.name, game: { ...game }, installationJobId: game.installationJobId || null, packageId: game.packageId || 'main-game', originalUrl: url, downloadType: 'multi', expectedParts: count, downloadedPartsCount: 0, downloadedParts: [], status: 'collecting_parts', createdAt: new Date().toISOString() };
  store.downloadSessions ||= []; store.downloadSessions.unshift(session); await saveStore();
  return { session, game: { ...game, sourceProvider: 'Zeigames', downloadType: 'multi', multipartSessionId: session.id }, url };
});
ipcMain.handle('multipart:list', () => store.downloadSessions || []);
ipcMain.handle('multipart:confirm', async (_event, id, complete) => {
  const session = store.downloadSessions?.find(item => item.id === id);
  if (!session) throw new Error('Multi-part session was not found.');
  if (!complete) { session.status = 'missing_parts'; await saveStore(); return session; }
  return completeMultipartSession(session);
});
async function completeMultipartSession(session) {
  if (session.installationRecordId) return session;
  const parts = session.downloadedParts || [];
  const existing = [];
  for (const part of parts) if (part.complete && part.related && await fs.stat(part.file).then(s => s.isFile()).catch(() => false)) existing.push(part);
  if (existing.length !== session.expectedParts) throw new Error(`Expected ${session.expectedParts} files, but found ${existing.length}.`);
  const numbers = existing.map(part => part.partNumber).filter(Number.isInteger);
  if (numbers.length > 0) {
    const missing = Array.from({ length: session.expectedParts }, (_, i) => i + 1).filter(number => !numbers.includes(number));
    if (missing.length) throw new Error(`Part ${missing.join(', ')} appears to be missing.`);
    if (new Set(numbers).size !== session.expectedParts) throw new Error('Duplicate part numbers were detected. Remove the duplicate file before continuing.');
  }
  const ordered = [...existing].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
  const first = ordered.find(part => /\.part0*1\.rar$/i.test(part.name) || /\.7z\.001$/i.test(part.name)) || ordered[0];
  if (ordered.some(part => !part.related)) throw new Error('One or more files appear unrelated to this archive set.');
  session.status = 'extracting'; await saveStore();
  const installRoot = store.settings.defaultInstallPath || path.join(app.getPath('home'), 'Games');
  const job = store.installationJobs?.find(item => item.id === session.installationJobId);
  const packageRecord = job?.packages.find(item => item.id === session.packageId);
  const record = { id: require('crypto').randomUUID(), file: first.file, game: { ...session.game, downloadVersion: null }, installRoot, installationJobId: job?.id || null, packageId: packageRecord?.id || null, multipartSessionId: session.id, multipartPackage: true, status: 'ready', complete: true, multiPartFiles: ordered.map(part => part.file), expectedBytes: (await Promise.all(ordered.map(part => fs.stat(part.file)))).reduce((total, stat) => total + stat.size, 0), createdAt: new Date().toISOString() };
  if (packageRecord) {
    packageRecord.status = 'DOWNLOADED'; packageRecord.expectedParts = session.expectedParts;
    packageRecord.file = first.file; packageRecord.files = ordered.map(part => ({ path: part.file, name: part.name, status: 'DOWNLOADED' }));
    packageRecord.parts = ordered.map(part => ({ file: part.file, name: part.name, partNumber: part.partNumber, status: 'DOWNLOADED' }));
    packageRecord.downloadRecordId = record.id; job.status = 'DOWNLOADED'; job.updatedAt = new Date().toISOString();
  }
  session.installationRecordId = record.id;
  downloadHistory.entries.unshift(record); await saveStore(); downloadHistory.changed();
  const pending = job?.packages.find(item => item.required && item.id !== 'main-game' && !['DOWNLOADED', 'COMPLETE'].includes(item.status));
  if (packageRecord && packageRecord.type !== 'MAIN_GAME' && packageRecord.installBehavior === 'OVERLAY') {
    if (!job.installationTarget) {
      const mainPackage = job.packages.find(item => item.id === 'main-game');
      if (mainPackage?.downloadRecordId && !pending) await downloadHistory.installSaved(mainPackage.downloadRecordId);
      else { job.status = 'WAITING_FOR_FILES'; session.status = 'waiting_for_files'; await saveStore(); return session; }
    } else {
      await waitForInstallQueue();
      if (packageRecord.status !== 'COMPLETE') await downloadHistory.installSaved(record.id);
    }
  } else if (packageRecord?.type === 'MAIN_GAME' && pending) {
    job.status = 'WAITING_FOR_FILES'; session.status = 'waiting_for_files'; await saveStore(); return session;
  } else { await waitForInstallQueue(); await downloadHistory.installSaved(record.id); }
  session.status = 'completed'; await saveStore(); return session;
}
ipcMain.handle('game:checkUpdate', async (_event, game) => {
  try { const installed = store.games.find(item => item.id === game.id); if (!installed) throw new Error('Game not found.'); return await checkPortableUpdate(installed); }
  catch (error) { return { gameId: game.id, error: `Update check unavailable: ${error.message}` }; }
});
ipcMain.handle('store:gameDetails', async (_event, game) => getStoreGameDetails(game));
ipcMain.handle('store:open', async (_event, url) => {
  if (!/^https?:\/\//i.test(url)) return;
  await shell.openExternal(url);
});
ipcMain.handle('settings:update', async (_event, settings) => {
  store.settings = { ...store.settings, ...settings };
  if (typeof settings.micaTransparency === 'boolean' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundMaterial(settings.micaTransparency ? 'acrylic' : 'none');
  }
  await saveStore();
  return store;
});
ipcMain.handle('settings:homeBackground', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose Home artwork', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  store.settings.homeBackgroundPath = result.filePaths[0];
  store.settings.homeBackgroundSource = 'custom';
  store.settings.homeBackgroundEnabled = true;
  await saveStore();
  return store.settings.homeBackgroundPath;
});

app.whenReady().then(async () => {
  if (process.argv.includes('--chrona-quit-for-update')) { app.quit(); return; }
  await loadStore();
  await downloadHistory.initialize();
  for (const job of store.installationJobs || []) {
    for (const pkg of job.packages || []) {
      if (!['DOWNLOADING', 'EXTRACTING', 'APPLYING', 'INSTALLING'].includes(pkg.status)) continue;
      if (pkg.status === 'DOWNLOADING' && pkg.expectedParts && (pkg.parts || []).length < pkg.expectedParts) { pkg.status = 'WAITING'; continue; }
      const record = pkg.downloadRecordId && downloadHistory.entries.find(item => item.id === pkg.downloadRecordId);
      const exists = record?.complete && await fs.stat(record.file).then(stat => stat.isFile()).catch(() => false);
      if (exists) { pkg.status = ['EXTRACTING', 'APPLYING', 'INSTALLING'].includes(pkg.status) ? 'FAILED' : 'DOWNLOADED'; pkg.file ||= record.file; }
      else pkg.status = 'FAILED';
    }
    if (['DOWNLOADING', 'INSTALLING', 'APPLYING'].includes(job.status)) {
      job.status = job.packages.some(pkg => pkg.required && pkg.status === 'FAILED') ? 'FAILED' : 'WAITING_FOR_FILES';
      job.updatedAt = new Date().toISOString();
    }
  }
  await saveStore();
  registerUpdates(() => mainWindow, saveStore, () => store.settings);
  createWindow();
  void checkTrackedUpdates();
  setInterval(() => void checkTrackedUpdates(), UPDATE_INTERVAL).unref();
}).catch(error => {
  dialog.showErrorBox('Chrona could not open your library', `${error.message}\nYour existing files have not been reset. Data folder: ${app.getPath('userData')}`);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let downloadBrowser;
let browserGame;
let downloadAllowedOrigin = '';
let downloadPageOrigin = '';
let downloadBrowserSession;
const downloadBrowserTabs = new Map();
let activeDownloadTabId = null;
let blockedPopupCount = 0;
const downloadJobs = new Set();
const activeDownloads = new Map();
const MAX_DOWNLOAD_BROWSER_TABS = 8;
const blockedAdHosts = /(^|\.)(doubleclick|googlesyndication|googleadservices|googletagmanager|google-analytics|adnxs|adsrvr|taboola|outbrain|popads|popcash|propellerads|exoclick|trafficjunky|juicyads|adsterra|hilltopads|onclickads)(\.|$)/i;
const blockedAdPaths = /(?:^|[\/_?&=.-])(ads?|advert(?:isement)?s?|popup|popunder|banner|clickunder|sponsor)(?:[\/_?&=.-]|$)/i;
function isBlockedAdUrl(value) {
  try {
    const parsed = new URL(value);
    return blockedAdHosts.test(parsed.hostname) || /(^|\.)(ad|ads|advert|popup|popunder|banner|tracker|track|analytics)[0-9-]*\./i.test(parsed.hostname) || blockedAdPaths.test(parsed.pathname);
  } catch { return true; }
}
function publishDownloadBrowserTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tabs = [...downloadBrowserTabs.values()].map(tab => ({ id: tab.id, title: tab.title, url: tab.url, loading: tab.loading, activity: tab.activity || '', active: tab.id === activeDownloadTabId, canGoBack: tab.view.webContents.canGoBack(), canGoForward: tab.view.webContents.canGoForward() }));
  mainWindow.webContents.send('download:tabs', { tabs, activeTabId: activeDownloadTabId, blockedPopupCount, visible: downloadBrowserTabs.size > 0 });
}
function activateDownloadBrowserTab(id) {
  const tab = downloadBrowserTabs.get(id);
  if (!tab) return false;
  for (const candidate of downloadBrowserTabs.values()) candidate.view.setVisible(candidate.id === id);
  activeDownloadTabId = id;
  downloadBrowser = tab.view;
  browserGame = tab.game;
  downloadAllowedOrigin = tab.allowedOrigin;
  downloadPageOrigin = tab.pageOrigin;
  resizeDownloadBrowser();
  mainWindow.webContents.send('download:url', tab.url);
  publishDownloadBrowserTabs();
  return true;
}
function removeDownloadBrowserTab(id) {
  const tab = downloadBrowserTabs.get(id);
  if (!tab) return;
  downloadBrowserTabs.delete(id);
  mainWindow.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (activeDownloadTabId === id) {
    const next = [...downloadBrowserTabs.values()].at(-1);
    if (next) activateDownloadBrowserTab(next.id);
    else { activeDownloadTabId = null; downloadBrowser = null; browserGame = null; publishDownloadBrowserTabs(); }
  } else publishDownloadBrowserTabs();
}
async function confirmExternalProtocol(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['steam:', 'mailto:', 'discord:', 'epicgames:', 'com.epicgames.launcher:'].includes(parsed.protocol)) return false;
  const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Open another application?', message: 'This download page wants to open another application.', detail: url.slice(0, 500), buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response !== 1) return false;
  await shell.openExternal(url);
  return true;
}
function downloadStatus(message, downloadId = null) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('download:status', { message, downloadId });
  if (message === 'Popup blocked') void appendDownloadDebugLog('BROWSER', 'Popup blocked');
}
async function appendDownloadDebugLog(category, message) {
  const file = path.join(app.getPath('userData'), 'logs', 'download-install.log');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${new Date().toISOString()} [${category}] ${message.replace(/[\r\n]+/g, ' ').slice(0, 1000)}\n`).catch(() => {});
}
function publishInstallationJobs() {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('installation-jobs:changed');
}
async function waitForInstallQueue() {
  while (downloadHistory.installing.size) await new Promise(resolve => setTimeout(resolve, 250));
}
function safeFolderName(name) {
  const clean = String(name || 'Game').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'Game';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean) ? `_${clean}` : clean;
}
function ensureInstallationPackage(game, installRoot) {
  store.installationJobs ||= [];
  const normalizedName = String(game.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const gameKey = String(game.id || stableId(['download-game', normalizedName]));
  const definition = packageDefinition(game, game.sourceProvider);
  let job = store.installationJobs.find(item => item.gameKey === gameKey && item.status !== 'COMPLETE');
  if (!job && definition.packageType !== 'MAIN_GAME') job = store.installationJobs.find(item => item.gameKey === gameKey && item.status === 'COMPLETE' && item.installationTarget && item.gameRecordId);
  if (!job) {
    job = { id: require('crypto').randomUUID(), gameId: game.id || null, gameKey, gameName: game.name,
      installDirectory: installRoot, packages: [], status: 'DOWNLOADING', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.installationJobs.unshift(job);
  }
  let pkg = job.packages.find(item => item.id === definition.packageId);
  if (!pkg) {
    pkg = { id: definition.packageId, name: definition.packageType === 'ONLINE_FIX' ? 'Online Fix' : 'Main Game',
      type: definition.packageType, source: game.sourceProvider || '', downloadUrl: game.downloadSourceUrl || '',
      status: 'WAITING', required: definition.required, optional: definition.optional, dependsOn: definition.dependsOn,
      installOrder: definition.packageType === 'ONLINE_FIX' ? 2 : 1, installBehavior: definition.installBehavior,
      extractionRequired: definition.extractionRequired, fileType: definition.fileType, overlayTarget: definition.overlayTarget,
      archiveGroup: definition.packageId, expectedParts: null, parts: [], files: [] };
    job.packages.push(pkg);
  }
  if (definition.packageType !== 'MAIN_GAME' && !job.packages.some(item => item.id === 'main-game')) {
    job.packages.unshift({ id: 'main-game', name: 'Main Game', type: 'MAIN_GAME', source: '', downloadUrl: '',
      status: 'WAITING', required: true, optional: false, dependsOn: null, installOrder: 1, installBehavior: 'EXTRACT',
      extractionRequired: true, fileType: null, overlayTarget: null, archiveGroup: 'main-game', expectedParts: null, parts: [], files: [] });
  }
  const declaredPackages = Array.isArray(game.requiredPackages) ? [...game.requiredPackages] : [];
  if (game.requiresOnlineFix === true && !declaredPackages.some(item => String(item?.type).toUpperCase() === 'ONLINE_FIX')) {
    declaredPackages.push({ type: 'ONLINE_FIX', required: game.onlineFixOptional !== true, name: 'Online Fix', installAfter: 'MAIN_GAME', installBehavior: 'OVERLAY' });
  }
  for (const declaration of declaredPackages) {
    const type = String(declaration?.type || '').toUpperCase();
    if (!['ONLINE_FIX', 'PREREQUISITE', 'DLC', 'PATCH', 'OPTIONAL'].includes(type)) continue;
    const id = type.toLowerCase().replaceAll('_', '-');
    if (job.packages.some(item => item.id === id)) continue;
    const required = !!declaration.required;
    job.packages.push({ id, name: declaration.name || (type === 'ONLINE_FIX' ? 'Online Fix' : type.replaceAll('_', ' ')), type,
      source: declaration.source || '', downloadUrl: declaration.downloadUrl || '', status: 'WAITING', required, optional: !required,
      dependsOn: declaration.installAfter || 'MAIN_GAME', installOrder: Number(declaration.installOrder) || (type === 'ONLINE_FIX' ? 2 : 3),
      installBehavior: declaration.installBehavior || 'OVERLAY', extractionRequired: declaration.extractionRequired !== false,
      fileType: declaration.fileType || null, overlayTarget: declaration.overlayTarget || (type === 'ONLINE_FIX' ? 'MAIN_GAME' : null), archiveGroup: id,
      expectedParts: null, parts: [], files: [] });
  }
  pkg.source = game.sourceProvider || pkg.source;
  pkg.downloadUrl = game.downloadSourceUrl || pkg.downloadUrl;
  pkg.required = pkg.required || definition.required;
  pkg.optional = !pkg.required;
  pkg.status = ['DOWNLOADED', 'READY', 'COMPLETE', 'EXTRACTING', 'APPLYING'].includes(pkg.status) ? pkg.status : 'WAITING';
  job.installDirectory = installRoot;
  job.status = job.packages.some(item => item.status === 'DOWNLOADING') ? 'DOWNLOADING' : 'WAITING_FOR_FILES';
  job.updatedAt = new Date().toISOString();
  return { job, pkg };
}
async function detectOverlayRoot(staging, target, gameName) {
  const candidates = [];
  const allFiles = [];
  async function inspect(directory, relative = '', depth = 0) {
    candidates.push({ directory, relative });
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 5) await inspect(child, childRelative, depth + 1);
      else if (entry.isFile() || entry.isSymbolicLink()) allFiles.push(child);
    }
  }
  await inspect(staging);
  const normalizedGame = String(gameName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ranked = [];
  for (const candidate of candidates) {
    const files = allFiles.filter(file => !candidate.relative || path.relative(candidate.directory, file).split(path.sep)[0] !== '..');
    if (!files.length) continue;
    let overlap = 0;
    const previews = [];
    for (const file of files.slice(0, 4000)) {
      const relative = path.relative(candidate.directory, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      previews.push(relative.split(path.sep).join('/'));
      if (await fs.lstat(path.join(target, relative)).then(stat => stat.isFile()).catch(() => false)) overlap++;
    }
    const folderName = path.basename(candidate.directory).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const gameMatch = normalizedGame && (folderName === normalizedGame || folderName.startsWith(normalizedGame) || normalizedGame.startsWith(folderName));
    const generic = /^(fix|online fix|onlinefix|game|data|files|release)$/.test(folderName);
    const score = overlap * 10 + (gameMatch ? 6 : 0) + (generic ? 1 : 0) - Math.max(0, candidate.relative.split(path.sep).filter(Boolean).length) * 0.01;
    ranked.push({ ...candidate, files: previews, overlap, gameMatch: !!gameMatch, score,
      label: candidate.relative ? candidate.relative.split(path.sep).join('/') : 'Archive root' });
  }
  ranked.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  if (!ranked.length) throw new Error('The Online Fix archive has no files to apply.');
  if (ranked[0].overlap > 0 || (ranked[0].gameMatch && ranked.filter(item => item.gameMatch).length === 1) || ranked.length === 1) return ranked[0].directory;
  const choices = ranked.slice(0, 4);
  const labels = choices.map(item => `${item.label} (${item.files.length} files)`);
  const detail = choices.map((item, index) => `${labels[index]}: ${item.files.slice(0, 3).join(', ')}`).join('\n');
  const cancelId = labels.length;
  const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Choose Online Fix folder',
    message: 'Chrona could not confidently identify the game files in this archive.', detail,
    buttons: [...labels, 'Cancel'], defaultId: cancelId, cancelId });
  if (choice.response === cancelId) throw new Error('Online Fix was not applied. The downloaded archive is saved in Downloads.');
  return choices[choice.response].directory;
}
async function applyOnlineFixOverlay(target, archive, packageRecord, job, multiPartFiles = []) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-overlay-'));
  const overlayName = safeFolderName(packageRecord.id || packageRecord.type || 'package').toLowerCase();
  const overlayRoot = path.join(target, '.chrona', 'overlays', overlayName);
  const backupRoot = path.join(overlayRoot, 'backup');
  const manifestPath = path.join(overlayRoot, 'manifest.json');
  const operations = [];
  let previousManifest = null;
  try {
    await extractGameArchive(archive, staging, multiPartFiles);
    const sourceRoot = await detectOverlayRoot(staging, target, job.gameName);
    previousManifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
    const manifestBase = { type: packageRecord.type, gameId: job.gameId, packageId: packageRecord.id,
      sourcePackage: path.basename(archive), packageVersion: packageRecord.version || null,
      installTimestamp: new Date().toISOString(), status: 'APPLYING',
      filesAdded: previousManifest?.filesAdded || [], filesReplaced: previousManifest?.filesReplaced || [],
      backupDirectory: path.relative(target, backupRoot).split(path.sep).join('/') };
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await atomicJson(manifestPath, manifestBase);
    const added = [], replaced = [];
    async function merge(source, relative = '') {
      for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
        const rel = relative ? path.join(relative, entry.name) : entry.name;
        if (rel.toLowerCase() === '.chrona' || rel.split(/[\\/]/).some(part => part === '..')) throw new Error('The Online Fix archive contains a protected path.');
        const from = path.join(source, rel);
        const destination = path.resolve(target, rel);
        const within = path.relative(target, destination);
        if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('The Online Fix archive contains an unsafe path.');
        const sourceStat = await fs.lstat(from);
        if (sourceStat.isSymbolicLink()) throw new Error('Online Fix links are not supported.');
        const current = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (current?.isSymbolicLink()) throw new Error('The game folder contains a link at an Online Fix destination.');
        if (entry.isDirectory()) {
          if (current && !current.isDirectory()) throw new Error(`Online Fix cannot replace a folder with a file: ${rel}`);
          await fs.mkdir(destination, { recursive: true });
          if (!current) operations.push({ destination, addedFolder: true });
          await merge(source, rel);
          continue;
        }
        if (!entry.isFile()) throw new Error('Unsupported Online Fix archive entry.');
        const backup = path.join(backupRoot, rel);
        if (current && !current.isFile()) throw new Error(`Online Fix cannot replace a file with a folder: ${rel}`);
        if (current) {
          await fs.mkdir(path.dirname(backup), { recursive: true });
          if (!(await fs.stat(backup).catch(() => null))) await fs.copyFile(destination, backup);
          operations.push({ destination, backup });
          replaced.push(rel.split(path.sep).join('/'));
        } else {
          operations.push({ destination, addedFile: true });
          added.push(rel.split(path.sep).join('/'));
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(from, destination);
      }
    }
    await merge(sourceRoot);
    const manifest = { type: packageRecord.type, gameId: job.gameId, packageId: packageRecord.id,
      sourcePackage: path.basename(archive), packageVersion: packageRecord.version || null,
      installTimestamp: manifestBase.installTimestamp, status: 'COMPLETE', filesAdded: [...new Set([...(manifestBase.filesAdded || []), ...added])],
      filesReplaced: [...new Set([...(manifestBase.filesReplaced || []), ...replaced])], backupDirectory: path.relative(target, backupRoot).split(path.sep).join('/') };
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await atomicJson(manifestPath, manifest);
    await fs.mkdir(path.dirname(path.join(app.getPath('userData'), 'logs', 'download-install.log')), { recursive: true });
    await fs.appendFile(path.join(app.getPath('userData'), 'logs', 'download-install.log'), `${new Date().toISOString()} [OVERLAY] ${job.gameName}: replaced ${replaced.length}, added ${added.length} files\n`).catch(() => {});
    return manifest;
  } catch (error) {
    for (const operation of operations.reverse()) {
      if (operation.backup) await fs.copyFile(operation.backup, operation.destination).catch(() => {});
      else if (operation.addedFile) await fs.rm(operation.destination, { force: true }).catch(() => {});
      else if (operation.addedFolder) await fs.rmdir(operation.destination).catch(() => {});
    }
    if (previousManifest) await atomicJson(manifestPath, previousManifest).catch(() => {});
    else await fs.unlink(manifestPath).catch(() => {});
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
async function finishDownload(file, game, installRoot, record) {
  if (record?.installedGameId && store.games.some(item => item.id === record.installedGameId)) return;
  if (game.updateGameId) return finishGameUpdate(file, game.updateGameId, game.downloadVersion);
  const job = record?.installationJobId && store.installationJobs?.find(item => item.id === record.installationJobId);
  const packageRecord = job?.packages.find(item => item.id === record.packageId);
  if (packageRecord && packageRecord.type !== 'MAIN_GAME' && packageRecord.installBehavior === 'OVERLAY') {
    if (!job.installationTarget) throw new Error(`Download the main game package before applying ${packageRecord.name || 'this package'}.`);
    packageRecord.status = 'APPLYING'; packageRecord.overlayTarget = job.installationTarget; job.status = 'APPLYING'; job.updatedAt = new Date().toISOString(); await saveStore();
    const manifest = await applyOnlineFixOverlay(job.installationTarget, file, packageRecord, job, record?.multiPartFiles || []);
    packageRecord.overlayManifest = path.relative(job.installationTarget, path.join(job.installationTarget, '.chrona', 'overlays', safeFolderName(packageRecord.id || packageRecord.type).toLowerCase(), 'manifest.json')).split(path.sep).join('/');
    packageRecord.status = 'COMPLETE'; packageRecord.filesAdded = manifest.filesAdded.length; packageRecord.filesReplaced = manifest.filesReplaced.length;
    job.status = 'COMPLETE'; job.updatedAt = new Date().toISOString(); await saveStore();
    if (record?.multipartSessionId) {
      const multipart = store.downloadSessions?.find(item => item.id === record.multipartSessionId);
      if (multipart) { multipart.status = 'completed'; await saveStore(); }
    }
    return { status: 'applied' };
  }
  const waiting = job?.packages.find(item => item.required && item.id !== 'main-game' && !['DOWNLOADED', 'COMPLETE'].includes(item.status));
  if (waiting) throw new Error(`Waiting for required package: ${waiting.name}.`);
  const root = path.resolve(installRoot);
  await fs.mkdir(root, { recursive: true });
  let target = record?.installationTarget;
  if (target) {
    if (path.dirname(path.resolve(target)) !== root) throw new Error('The previous installation folder is unavailable or unsafe.');
    const previous = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('The previous installation folder is unavailable or unsafe.');
    if (!previous) await fs.mkdir(target);
  }
  for (let suffix = 0; !target; suffix++) {
    const candidate = path.join(root, safeFolderName(game.name) + (suffix ? ` (${suffix + 1})` : ''));
    try { await fs.mkdir(candidate); target = candidate; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (record) { record.installationTarget = target; await saveStore(); }
  if (job) { job.installationTarget = target; job.status = 'INSTALLING'; if (packageRecord) packageRecord.status = 'EXTRACTING'; await saveStore(); }
  downloadStatus(`Preparing ${game.name}...`);
  if (record?.multiPartFiles?.length) await extractGameArchive(file, target, record.multiPartFiles);
  else if (/\.(zip|rar|7z)$/i.test(file)) await extractGameArchive(file, target);
  else await fs.copyFile(file, path.join(target, path.basename(file)));
  const overlayPackages = job?.packages.filter(item => item.type !== 'MAIN_GAME' && item.installBehavior === 'OVERLAY' && ['DOWNLOADED', 'COMPLETE'].includes(item.status) && item.file) || [];
  for (const overlayPackage of overlayPackages) {
    if (overlayPackage.status === 'COMPLETE') continue;
    const manifest = await applyOnlineFixOverlay(target, overlayPackage.file, overlayPackage, job, (overlayPackage.parts || []).map(part => part.file).filter(Boolean));
    overlayPackage.status = 'COMPLETE'; overlayPackage.filesAdded = manifest.filesAdded.length; overlayPackage.filesReplaced = manifest.filesReplaced.length;
    overlayPackage.overlayManifest = path.relative(target, path.join(target, '.chrona', 'overlays', safeFolderName(overlayPackage.id || overlayPackage.type).toLowerCase(), 'manifest.json')).split(path.sep).join('/');
    const overlayDownload = overlayPackage.downloadRecordId && downloadHistory.find(overlayPackage.downloadRecordId);
    if (overlayDownload) {
      await downloadHistory.update(overlayDownload, { status: 'applied', error: '', complete: true });
      if (overlayDownload.multipartSessionId) {
        const multipart = store.downloadSessions?.find(item => item.id === overlayDownload.multipartSessionId);
        if (multipart) multipart.status = 'completed';
      }
    }
  }
  const launchers = await findLaunchers(target);
  const launcher = launchers.find(item => /(^|[\\/])(run me!?|start|play|launcher)\.(bat|cmd|exe)$/i.test(item.name)) || launchers.find(item => /\.exe$/i.test(item.path)) || launchers.find(item => !/\.(url|lnk)$/i.test(item.path));
  const installedGame = {
    id: stableId(['portable', target]), name: game.name,
    source: 'Portable', status: 'installed', installPath: target,
    executablePath: launcher?.path || '', launchType: launcher?.type || 'exe',
    workingDirectory: launcher ? path.dirname(launcher.path) : target,
    libraryPath: root, coverUrl: game.coverUrl || '', addedAt: new Date().toISOString()
  };
  await recordInstalledVersion(installedGame, game.downloadVersion);
  store.games.push(installedGame);
  if (record) record.installedGameId = installedGame.id;
  if (job) {
    job.gameRecordId = installedGame.id; job.installationTarget = target;
    if (packageRecord) { packageRecord.status = 'COMPLETE'; packageRecord.file = file; }
    job.status = job.packages.some(item => item.required && item.status !== 'COMPLETE') ? 'WAITING_FOR_FILES' : 'COMPLETE';
    job.updatedAt = new Date().toISOString();
  }
  if (record?.multipartSessionId) {
    const multipart = store.downloadSessions?.find(item => item.id === record.multipartSessionId);
    if (multipart) multipart.status = 'completed';
  }
  void appendDownloadDebugLog('INSTALL', `${game.name}: installation complete`);
  await saveStore();
  downloadStatus(`${game.name} added to Portable. Choose its launcher to finish setup.`);
  // Retain downloaded archives in Downloads, including after installation.
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed');
  const newGameId = store.games.at(-1).id;
  await chooseGameLauncher(newGameId).catch(error => downloadStatus(`Game installed. Choose its launcher from the library: ${error.message}`));
}

async function finishGameUpdate(file, gameId, metadata) {
  const game = store.games.find(item => item.id === gameId);
  if (!game || game.source !== 'Portable' || !game.installPath || isDangerousDeleteTarget(game.installPath)) throw new Error('The installed game folder is unavailable.');
  if (!/\.(zip|rar|7z)$/i.test(file)) throw new Error('Choose a ZIP, RAR, or 7z game archive to update.');
  const target = path.resolve(game.installPath);
  const targetStat = await fs.lstat(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('The installed folder must be a regular directory.');
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-update-'));
  try {
    downloadStatus(`Preparing update for ${game.name}...`);
    await extractGameArchive(file, staging);
    const launchers = await findLaunchers(staging);
    const relativeLauncher = path.relative(target, game.executablePath || '');
    if (!relativeLauncher || relativeLauncher.startsWith('..') || path.isAbsolute(relativeLauncher)) throw new Error('Choose a launcher inside the installed game folder before updating.');
    const matches = launchers.filter(item => {
      const relative = path.relative(staging, item.path).toLowerCase();
      // Require the archive's launcher path to match exactly. Extra parent folders
      // are a different layout and must go through the overwrite prompt.
      return relative === relativeLauncher.toLowerCase();
    });
    let source;
    if (matches.length !== 1) {
      const choice = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['Cancel and keep download', 'Yes, overwrite game'], defaultId: 0, cancelId: 0, title: 'Update layout is different', message: `${game.name} has a different folder layout in this update.`, detail: 'The entire installed game will be overwritten and updated. Continue?' });
      if (choice.response !== 1) throw new Error('Update cancelled. The archive is saved in Downloads.');
      source = staging;
    } else source = matches[0].path.slice(0, -relativeLauncher.length);
    async function checkDestination(from, to) {
      for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        const destination = path.join(to, entry.name);
        const stat = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (entry.isSymbolicLink() || stat?.isSymbolicLink()) throw new Error('Update folders must not contain links.');
        if (entry.isDirectory()) await checkDestination(path.join(from, entry.name), destination);
      }
    }
    await checkDestination(source, target);
    downloadStatus(`Installing update for ${game.name}...`);
    if (source === staging) {
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target, { recursive: true });
    }
    await fs.cp(source, target, { recursive: true, force: true });
    game.updatedAt = new Date().toISOString();
    delete game.updateInfo;
    if (metadata) await recordInstalledVersion(game, metadata);
    else { delete game.ankerVersion; await fs.unlink(path.join(target, VERSION_FILE)).catch(() => {}); }
    await saveStore();
    downloadStatus(`${game.name} updated successfully.`);
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed');
  } finally {
    // Only remove the fresh temporary directory created by this operation.
    const resolved = path.resolve(staging);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('chrona-update-')) {
      await fs.rm(resolved, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function chooseGameLauncher(gameId) {
  const game = store.games.find(item => item.id === gameId);
  if (!game) return;
  const result = await dialog.showOpenDialog(mainWindow, { title: `Choose the launcher for ${game.name}`, defaultPath: game.installPath, properties: ['openFile'], filters: [{ name: 'Game launchers', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] }] });
  if (result.canceled || !result.filePaths[0]) return;
  game.executablePath = result.filePaths[0];
  game.workingDirectory = path.dirname(result.filePaths[0]);
  game.launchType = /\.(bat|cmd)$/i.test(result.filePaths[0]) ? 'bat' : 'exe';
  await saveStore();
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed');
}
function resizeDownloadBrowser() {
  if (!downloadBrowserTabs.size && !downloadBrowser) return;
  const [width, height] = mainWindow.getContentSize();
  for (const tab of downloadBrowserTabs.values()) tab.view.setBounds({ x: 0, y: 146, width, height: Math.max(0, height - 146) });
  if (!downloadBrowserTabs.size && downloadBrowser) downloadBrowser.setBounds({ x: 0, y: 146, width, height: Math.max(0, height - 146) });
}
function configureDownloadBrowserTab(tab) {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//i.test(url || '')) {
      void confirmExternalProtocol(url);
      blockedPopupCount++;
      downloadStatus('Popup blocked');
    } else if (isBlockedAdUrl(url)) {
      blockedPopupCount++;
      downloadStatus('Popup blocked');
    } else if (downloadBrowserTabs.size >= MAX_DOWNLOAD_BROWSER_TABS || (tab.popupTimes = (tab.popupTimes || []).filter(time => Date.now() - time < 30000)).length >= 3) {
      blockedPopupCount++;
      downloadStatus('Popup blocked');
    } else {
      tab.popupTimes.push(Date.now());
      const created = createDownloadBrowserTab(url, tab.game, { activate: false, popup: true });
      if (!created) { blockedPopupCount++; downloadStatus('Popup blocked'); }
    }
    publishDownloadBrowserTabs();
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, next, _inPlace, isMainFrame) => {
    try {
      const parsed = new URL(next);
      if (!/^https?:$/.test(parsed.protocol)) { event.preventDefault(); void confirmExternalProtocol(next); }
      else if (isBlockedAdUrl(next)) { event.preventDefault(); blockedPopupCount++; downloadStatus('Popup blocked'); publishDownloadBrowserTabs(); }
    } catch { event.preventDefault(); }
  });
  contents.on('will-redirect', (event, next, _inPlace, isMainFrame) => {
    let parsed;
    try { parsed = new URL(next); } catch { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || isBlockedAdUrl(next)) { event.preventDefault(); blockedPopupCount++; downloadStatus('Popup blocked'); publishDownloadBrowserTabs(); }
  });
  const navigation = (_event, next) => {
    tab.url = next;
    if (tab.history?.[tab.historyIndex] !== next) {
      const known = tab.history?.lastIndexOf(next) ?? -1;
      if (known >= 0) tab.historyIndex = known;
      else {
        tab.history ||= [];
        tab.history.splice((tab.historyIndex ?? tab.history.length - 1) + 1);
        tab.history.push(next);
        if (tab.history.length > 50) tab.history.shift();
        tab.historyIndex = tab.history.length - 1;
      }
    }
    tab.title = tab.customTitle || (() => { try { return new URL(next).hostname; } catch { return 'Download page'; } })();
    tab.allowedOrigin = (() => { try { return new URL(next).origin; } catch { return tab.allowedOrigin; } })();
    if (tab.id === activeDownloadTabId) {
      downloadAllowedOrigin = tab.allowedOrigin;
      downloadPageOrigin = tab.pageOrigin;
      mainWindow.webContents.send('download:url', next);
    }
    publishDownloadBrowserTabs();
  };
  contents.on('did-navigate', navigation);
  contents.on('did-navigate-in-page', navigation);
  contents.on('page-title-updated', (event, title) => { if (!tab.customTitle) tab.title = title || tab.title; publishDownloadBrowserTabs(); });
  contents.on('did-start-loading', () => { tab.loading = true; publishDownloadBrowserTabs(); });
  contents.on('did-stop-loading', () => { tab.loading = false; publishDownloadBrowserTabs(); });
  contents.on('render-process-gone', () => { tab.loading = false; tab.title = 'Page stopped'; publishDownloadBrowserTabs(); });
}
function createDownloadBrowserTab(url, game, { activate = true, popup = false, view = null, title = '' } = {}) {
  if (downloadBrowserTabs.size >= MAX_DOWNLOAD_BROWSER_TABS && !view) return null;
  const tabView = view || new WebContentsView({ webPreferences: { session: downloadBrowserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  const tab = { id: require('crypto').randomUUID(), title: title || parsed?.hostname || 'New tab', customTitle: popup ? '' : title, url: url || 'about:blank', loading: !!url, game: { ...game }, pageOrigin: parsed?.origin || '', allowedOrigin: parsed?.origin || '', popup, main: !popup, history: url ? [url] : [], historyIndex: url ? 0 : -1 };
  tab.view = tabView;
  downloadBrowserTabs.set(tab.id, tab);
  if (!view) mainWindow.contentView.addChildView(tabView);
  configureDownloadBrowserTab(tab);
  tabView.setVisible(false);
  if (activate) activateDownloadBrowserTab(tab.id);
  else { resizeDownloadBrowser(); publishDownloadBrowserTabs(); }
  if (url) tabView.webContents.loadURL(url).catch(error => { tab.loading = false; downloadStatus(`Page could not load: ${error.message}`); publishDownloadBrowserTabs(); });
  return tab;
}
ipcMain.handle('downloads:folder', async (_event, key) => {
  if (!['downloadPath', 'defaultInstallPath'].includes(key)) throw new Error('Invalid folder setting.');
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled && result.filePaths[0]) {
    store.settings[key] = result.filePaths[0];
    await saveStore();
    await offerDefenderExclusion(dialog, mainWindow, result.filePaths);
  }
  return refreshDefenderStatus();
});
ipcMain.handle('downloads:open', async (_event, url, game) => {
  if (!/^https?:\/\//i.test(url) || !game?.name) throw new Error('A game and web link are required.');
  const downloadRoot = store.settings.downloadPath || app.getPath('downloads');
  const installRoot = store.settings.defaultInstallPath || path.join(app.getPath('home'), 'Games');
  await fs.mkdir(downloadRoot, { recursive: true });
  await fs.mkdir(installRoot, { recursive: true });
  if (game.updateGameId && !store.games.some(item => item.id === game.updateGameId && item.source === 'Portable' && item.status !== 'installable')) throw new Error('Only installed portable games can be updated.');
  const resumedSession = game.multipartSessionId && store.downloadSessions?.find(session => session.id === game.multipartSessionId);
  if (resumedSession) game = { ...game, multipartSessionId: resumedSession.id, downloadType: 'multi' };
  browserGame = { ...game, downloadVersion: null, downloadSourceUrl: url };
  downloadAllowedOrigin = new URL(url).origin;
  downloadPageOrigin = downloadAllowedOrigin;
  if (ankerPage(url)) {
    // Capture before downloading so a later website release cannot label an older archive.
    try { browserGame.downloadVersion = await readAnkerVersion(url); }
    catch (error) { throw new Error(`Cannot record the installed version: ${error.message} Please retry.`); }
  }
  const packageContext = game.updateGameId ? null : ensureInstallationPackage(browserGame, installRoot);
  browserGame.installationJobId = packageContext?.job.id || null;
  browserGame.packageId = packageContext?.pkg.id || null;
  browserGame.packageType = packageContext?.pkg.type || null;
  browserGame.packageRequired = packageContext?.pkg.required ?? null;
  await saveStore();
  downloadHistory.changed();
  if (!downloadBrowserSession) {
    const browserSession = session.fromPartition('chrona-downloads');
    downloadBrowserSession = browserSession;
    const blockedHosts = /(^|\.)((doubleclick|googlesyndication|googleadservices|googletagmanager|google-analytics|adnxs|adsrvr|taboola|outbrain|popads|popcash|propellerads|exoclick|trafficjunky|juicyads|adsterra|hilltopads|onclickads)\.)/i;
    browserSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        const parsed = new URL(details.url);
        const host = parsed.hostname.toLowerCase();
        const adHost = blockedHosts.test(host) || /(^|\.)((ad|ads|advert|popup|popunder|banner|tracker|track|analytics)[0-9-]*\.)/i.test(host);
        // File hosts commonly serve the actual archive from paths such as
        // /download/game.zip. Blocking by path keyword prevented these legitimate
        // requests and left users on the source page with no active download.
        callback({ cancel: adHost });
      } catch { callback({ cancel: false }); }
    });
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mainWindow.on('resize', resizeDownloadBrowser);
    browserSession.on('will-download', async (_event, item, webContents) => {
      const sourceTab = [...downloadBrowserTabs.values()].find(tab => tab.view.webContents === webContents);
      if (!sourceTab) { item.cancel(); return; }
      const selected = { ...(sourceTab?.game || browserGame) };
      const activeSession = selected.multipartSessionId && store.downloadSessions?.find(session => session.id === selected.multipartSessionId);
      if (selected.sourceProvider === 'Zeigames' && !activeSession && selected.downloadType !== 'single') {
        const warning = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Continue', 'Go Back'],
          defaultId: 0,
          cancelId: 1,
          title: 'Zeigames',
          message: 'Zeigames commonly uses multi-part downloads. Do you want to continue?'
        });
        if (warning.response !== 0) {
          item.cancel();
          if (sourceTab) activateDownloadBrowserTab(sourceTab.id);
          return;
        }
        const typeChoice = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Single File', 'Multi-Part', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          title: 'Download type',
          message: 'Is this game a single-file download or a multi-part download?'
        });
        if (typeChoice.response === 2) { item.cancel(); if (sourceTab) activateDownloadBrowserTab(sourceTab.id); return; }
        if (typeChoice.response === 0) selected.downloadType = 'single';
        else {
          item.cancel();
          if (sourceTab) activateDownloadBrowserTab(sourceTab.id);
          mainWindow.webContents.send('multipart:requestCount', { game: selected, url: selected.downloadSourceUrl });
          return;
        }
      }
      if (selected.downloadType === 'multi' && !selected.multipartSessionId) {
        const found = store.downloadSessions?.find(session => session.originalUrl === selected.downloadSourceUrl && session.status !== 'completed');
        if (found) selected.multipartSessionId = found.id;
      }
      const destination = store.settings.defaultInstallPath || path.join(app.getPath('home'), 'Games');
      const folder = store.settings.downloadPath || app.getPath('downloads');
      const downloadFilename = safeFolderName(item.getFilename());
      const file = path.join(folder, `${require('crypto').randomUUID()}-${downloadFilename}`);
      item.setSavePath(file);
      downloadJobs.add(item);
      const installJob = selected.installationJobId && store.installationJobs?.find(entry => entry.id === selected.installationJobId);
      const installPackage = installJob?.packages.find(entry => entry.id === selected.packageId);
      if (installPackage) {
        installPackage.status = 'DOWNLOADING'; installPackage.downloadUrl = item.getURL(); installPackage.fileType = path.extname(downloadFilename).slice(1).toLowerCase() || null;
        installPackage.expectedParts = activeSession?.expectedParts || installPackage.expectedParts;
        installJob.status = 'DOWNLOADING'; installJob.updatedAt = new Date().toISOString();
      }
      sourceTab.activity = `Downloading ${item.getFilename()}`;
      publishDownloadBrowserTabs();

      const downloadId = require('crypto').randomUUID();
      activeDownloads.set(downloadId, item);
      const record = { id: downloadId, file, filename: downloadFilename, game: selected, installRoot: destination, installationJobId: installJob?.id || null, packageId: installPackage?.id || null, multipartSessionId: activeSession?.id || null, multipartPart: !!activeSession, status: 'downloading', complete: false,
        expectedBytes: item.getTotalBytes(), receivedBytes: 0, createdAt: new Date().toISOString() };
      if (installPackage) installPackage.downloadRecordId = downloadId;
      downloadHistory.entries.unshift(record);
      void appendDownloadDebugLog('DOWNLOAD', `${selected.name}; ${installPackage?.type || 'unassigned'}; ${path.basename(file)}; tab ${sourceTab.id}`);
      const persisted = saveStore();
      downloadHistory.changed();
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('download:started', { id: downloadId, name: selected.name });
      const startedAt = Date.now(); let lastJobPublish = 0;
      item.on('updated', () => {
        const elapsed = Math.max(1, (Date.now() - startedAt) / 1000); const receivedBytes = item.getReceivedBytes(); const expectedBytes = item.getTotalBytes(); const speed = receivedBytes / elapsed;
        if (installPackage) { installPackage.receivedBytes = receivedBytes; installPackage.expectedBytes = expectedBytes; installPackage.progress = expectedBytes ? Math.round(receivedBytes / expectedBytes * 100) : null; }
        downloadStatus(`Downloading: ${selected.name} — ${expectedBytes ? Math.round(receivedBytes / expectedBytes * 100) + '%' : Math.round(receivedBytes / 1048576) + ' MB'} — ${formatRate(speed)} download, 0 B/s upload`, downloadId);
        if (Date.now() - lastJobPublish > 500) { lastJobPublish = Date.now(); publishInstallationJobs(); }
      });
      item.once('done', async (_event, state) => {
        sourceTab.activity = state === 'completed' ? 'Download ready' : 'Download failed';
        publishDownloadBrowserTabs();
        try {
          await persisted;
          if (state === 'completed') {
            await downloadHistory.update(record, { status: 'ready', complete: true, expectedBytes: item.getReceivedBytes(), receivedBytes: item.getReceivedBytes() });
            if (activeSession) {
              const info = multipartPartInfo(record.filename || path.basename(file));
              const key = info ? `${info.key}:${info.partNumber}` : (record.filename || path.basename(file)).replace(/ \(\d+\)(?=\.[^.]+$)/, '').toLowerCase();
              if (!activeSession.downloadedParts.some(part => part.key === key)) {
                const related = !!info && (!activeSession.downloadedParts.length || activeSession.downloadedParts.some(part => part.key.startsWith(`${info.key}:`)));
                activeSession.downloadedParts.push({ name: record.filename || path.basename(file), file, status: 'downloaded', complete: true, partNumber: info?.partNumber || null, key, related });
              } else {
                activeSession.duplicates ||= []; activeSession.duplicates.push({ name: path.basename(file), file });
              }
              activeSession.downloadedPartsCount = activeSession.downloadedParts.length;
              activeSession.status = activeSession.downloadedPartsCount >= activeSession.expectedParts ? 'ready_to_extract' : 'collecting_parts';
              if (installPackage) {
                installPackage.expectedParts = activeSession.expectedParts;
                installPackage.parts ||= [];
                const part = activeSession.downloadedParts.find(entry => entry.key === key);
                if (part && !installPackage.parts.some(entry => entry.file === part.file)) installPackage.parts.push({ file: part.file, name: part.name, partNumber: part.partNumber, status: 'DOWNLOADED' });
                installPackage.status = activeSession.downloadedPartsCount >= activeSession.expectedParts ? 'DOWNLOADED' : 'DOWNLOADING';
                installJob.updatedAt = new Date().toISOString();
              }
              await saveStore(); downloadHistory.changed();
              mainWindow.webContents.send('multipart:changed', activeSession);
              downloadStatus(`Part ${activeSession.downloadedPartsCount} of ${activeSession.expectedParts} downloaded.`, downloadId);
              if (activeSession.downloadedPartsCount >= activeSession.expectedParts) {
                await completeMultipartSession(activeSession);
                mainWindow.webContents.send('multipart:changed', activeSession);
              }
            } else if (!installPackage) await downloadHistory.installSaved(downloadId);
            else {
              installPackage.status = 'DOWNLOADED'; installPackage.file = file;
              installPackage.files ||= []; installPackage.files.push({ path: file, name: record.filename || path.basename(file), size: item.getReceivedBytes(), status: 'DOWNLOADED', downloadTabId: sourceTab.id });
              installJob.updatedAt = new Date().toISOString(); await saveStore();
              if (installPackage.type !== 'MAIN_GAME' && installPackage.installBehavior === 'OVERLAY') {
                await waitForInstallQueue();
                if (installPackage.status === 'COMPLETE') { await saveStore(); }
                else if (installJob.installationTarget) await downloadHistory.installSaved(downloadId);
                else {
                  const mainPackage = installJob.packages.find(entry => entry.id === 'main-game');
                  const pending = installJob.packages.find(entry => entry.required && entry.id !== 'main-game' && !['DOWNLOADED', 'COMPLETE'].includes(entry.status));
                  if (mainPackage?.downloadRecordId && !pending) await downloadHistory.installSaved(mainPackage.downloadRecordId);
                  else { installJob.status = 'WAITING_FOR_FILES'; await saveStore(); }
                }
              } else {
                const pending = installJob.packages.find(entry => entry.required && entry.id !== 'main-game' && !['DOWNLOADED', 'COMPLETE'].includes(entry.status));
                if (pending) { installJob.status = 'WAITING_FOR_FILES'; await saveStore(); downloadStatus(`Waiting for required package: ${pending.name}.`, downloadId); }
                else await downloadHistory.installSaved(downloadId);
              }
            }
          } else {
            if (installPackage) { installPackage.status = 'FAILED'; installJob.status = installPackage.required ? 'FAILED' : 'WAITING_FOR_FILES'; installJob.updatedAt = new Date().toISOString(); await saveStore(); }
            await downloadHistory.update(record, { status: state === 'cancelled' ? 'cancelled' : 'interrupted', receivedBytes: item.getReceivedBytes(), error: 'The file did not finish downloading.' });
            downloadStatus(`Download ${state}: ${selected.name}. Open Downloads for details.`, downloadId);
          }
        } catch (error) {
          if (installPackage && record.complete) { installPackage.status = 'FAILED'; installJob.status = installPackage.required ? 'FAILED' : installJob.installationTarget ? 'COMPLETE' : 'WAITING_FOR_FILES'; installJob.updatedAt = new Date().toISOString(); await saveStore().catch(() => {}); }
          await downloadHistory.update(record, { status: record.complete ? 'failed' : 'interrupted', error: error.message }).catch(console.error);
          downloadStatus(`Could not prepare ${selected.name}: ${error.message}. Install the saved file from Downloads.`, downloadId);
        }
        finally { downloadJobs.delete(item); activeDownloads.delete(downloadId); downloadHistory.changed(); }
      });
    });
  }
  if (!createDownloadBrowserTab(url, browserGame, { activate: true, title: browserGame.sourceProvider || '' })) throw new Error('Close a download browser tab before opening another.');
  publishDownloadBrowserTabs();
});

let startupRelease = null;
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('chrona:startup', async () => {
  const version = app.getVersion();
  const pending = await readDistributionJson(path.join(app.getPath('userData'), 'pending-release.json')).catch(() => null);
  const changed = store.setupCompleted && store.lastRunVersion !== version;
  if (store.setupCompleted && store.lastSeenReleaseNotes !== version && (changed || pending?.version === version)) {
    startupRelease = pending?.version === version ? pending : await releaseService.forVersion(version).catch(() => null);
    startupRelease ||= { version, title: `Chrona ${version}`, notes: 'Chrona has been updated. Release notes are currently unavailable offline.', published: null };
    await atomicJson(path.join(app.getPath('userData'), 'pending-release.json'), startupRelease);
  }
  store.lastRunVersion = version;
  await saveStore();
  return { version, setupRequired: !store.setupCompleted, release: startupRelease, settings: store.settings, locations: store.addedLocations, installPath: path.dirname(process.execPath) };
});
ipcMain.handle('chrona:ready', async () => {
  const index = process.argv.indexOf('--chrona-update-health');
  const token = index >= 0 ? process.argv[index + 1] : '';
  if (/^[a-f0-9-]{36}$/.test(token || '')) await atomicJson(path.join(app.getPath('userData'), `update-health-${token}.json`), { version: app.getVersion(), token });
  return true;
});
ipcMain.handle('chrona:notesSeen', async () => {
  store.lastSeenReleaseNotes = app.getVersion();
  startupRelease = null;
  await saveStore();
  await fs.unlink(path.join(app.getPath('userData'), 'pending-release.json')).catch(() => {});
});
ipcMain.handle('chrona:detectLibraries', async () => {
  const steam = (await discoverSteamLibraries()).map(folder => path.dirname(folder));
  const folders = [];
  for (const folder of commonLocations().filter(folder => !/steamapps/i.test(folder) && folder !== path.join(os.homedir(), 'Desktop'))) {
    if (await pathExists(folder)) folders.push(folder);
  }
  return { steam: (await Promise.all(steam.map(async folder => await pathExists(folder) ? folder : null))).filter(Boolean), folders };
});
ipcMain.handle('chrona:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('chrona:completeSetup', async (_event, value) => {
  if (store.setupCompleted) return store;
  for (const list of [value.steam, value.folders]) {
    if (!Array.isArray(list) || list.length > 100 || list.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder))) throw new Error('Please select valid library folders.');
    for (const folder of list) if (!(await fs.stat(folder)).isDirectory()) throw new Error('A selected folder is unavailable.');
  }
  store.settings.steamLibraryFolders = uniquePaths(value.steam);
  store.addedLocations = uniquePaths(value.folders);
  store.settings.darkMode = !!value.darkMode;
  store.settings.scanOnStartup = !!value.scanOnStartup;
  store.setupCompleted = true;
  store.lastSeenReleaseNotes = app.getVersion();
  await saveStore();
  if (value.scanNow) void scanAll().then(() => mainWindow?.webContents.send('library:changed')).catch(console.error);
  return store;
});
ipcMain.handle('steam:addLibraryFolder', async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: 'Add Steam library folder' }); if (!result.canceled && result.filePaths[0]) { const folder = path.resolve(result.filePaths[0]); store.settings.steamLibraryFolders = [...new Set([...(store.settings.steamLibraryFolders || []), folder])]; await saveStore(); } return store; });
ipcMain.handle('steam:removeLibraryFolder', async (_event, folder) => { store.settings.steamLibraryFolders = (store.settings.steamLibraryFolders || []).filter(item => path.resolve(item) !== path.resolve(folder)); await saveStore(); return store; });
function formatRate(bytes) { if (!bytes) return '0 B/s'; const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']; let i = 0; while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; } return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`; }
ipcMain.handle('downloads:control', async (_event, id, action) => { const item = activeDownloads.get(id); if (!item) return false; if (action === 'pause' && !item.isPaused()) item.pause(); else if (action === 'resume' && item.isPaused()) item.resume(); else if (action === 'cancel') item.cancel(); else return false; return true; });
ipcMain.handle('downloads:retry', async (_event, retryId) => {
  const record = downloadHistory.find(retryId);
  return downloadHistory.installSaved(retryId);
});
ipcMain.handle('downloads:list', () => downloadHistory.list());
ipcMain.handle('installation-jobs:list', () => store.installationJobs || []);
ipcMain.handle('downloads:reveal', async (_event, id) => {
  const entry = downloadHistory.find(id);
  if (!(await pathExists(entry.file))) throw new Error('The saved file is no longer at this location.');
  shell.showItemInFolder(entry.file);
});
ipcMain.handle('downloads:dismiss', async (_event, id) => {
  if (activeDownloads.has(id) || downloadHistory.installing.has(id)) throw new Error('Wait for this download or installation to finish.');
  store.downloadHistory = downloadHistory.entries.filter(item => item.id !== id);
  await saveStore(); downloadHistory.changed(); return true;
});
ipcMain.handle('browser:control', (_event, action, value) => {
  if (action === 'select-tab') return activateDownloadBrowserTab(value);
  if (action === 'close-tab') return removeDownloadBrowserTab(value);
  const tab = downloadBrowserTabs.get(activeDownloadTabId);
  if (action === 'new-tab') return !!createDownloadBrowserTab('', tab?.game || browserGame || {}, { activate: true, title: 'New tab' });
  if (!tab) return false;
  const contents = tab.view.webContents;
  if (action === 'close') { tab.view.setVisible(false); publishDownloadBrowserTabs(); }
  if (action === 'back' && contents.canGoBack()) contents.goBack();
  if (action === 'forward' && contents.canGoForward()) contents.goForward();
  if (action === 'reload') contents.reload();
  if (action === 'navigate') {
    const url = String(value || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Enter a valid web address.'); }
    if (!/^https?:$/.test(parsed.protocol) || isBlockedAdUrl(url)) throw new Error('This address is blocked by the download browser.');
    tab.customTitle = '';
    tab.pageOrigin = parsed.origin;
    tab.allowedOrigin = parsed.origin;
    contents.loadURL(parsed.href).catch(error => downloadStatus(`Page could not load: ${error.message}`));
  }
  return true;
});
function multipartPartInfo(name) {
  const base = String(name || '').replace(/ \(\d+\)(?=\.[^.]+$)/, '');
  let match = base.match(/^(.*?)(?:\.part(\d+))\.rar$/i);
  if (match) return { key: `${match[1].toLowerCase()}.rar`, partNumber: Number(match[2]) };
  match = base.match(/^(.*?)\.part(\d+)\.7z$/i);
  if (match) return { key: `${match[1].toLowerCase()}.7z`, partNumber: Number(match[2]) };
  match = base.match(/^(.*?)\.7z\.(\d{3})$/i);
  if (match) return { key: `${match[1].toLowerCase()}.7z`, partNumber: Number(match[2]) };
  match = base.match(/^(.*)\.r(\d{2})$/i);
  if (match) return { key: `${match[1].toLowerCase()}.rar`, partNumber: Number(match[2]) + 1 };
  return null;
}
async function extractGameArchive(file, target, multiPartFiles = []) {
  const binary = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'vendor', '7zip', '7z.exe');
  const run = (args, operation) => new Promise((resolve, reject) => {
    childProcess.execFile(binary, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const reason = [stderr, stdout].filter(Boolean).join('\n').trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 500);
        reject(new Error(!require('fs').existsSync(binary)
          ? 'The archive extractor is missing. Reinstall Chrona 1.3.3 or later.'
          : `Archive ${operation} failed${reason ? `: ${reason}` : ` (7-Zip exit code ${error.code ?? 'unknown'})`}. It may be incomplete, password-protected, or damaged.`));
      }
      else resolve(stdout);
    });
  });
  if (multiPartFiles.length) {
    const actual = new Set(multiPartFiles.map(part => path.resolve(part).toLowerCase()));
    if (!actual.has(path.resolve(file).toLowerCase())) throw new Error('The first archive part is missing from the confirmed set.');
    for (const part of multiPartFiles) if (!(await fs.stat(part).then(stat => stat.isFile()).catch(() => false))) throw new Error(`Archive part is missing: ${path.basename(part)}`);
  }
  const listing = await run(['l', '-slt', '-ba', '-p-', file], 'inspection');
  for (const line of listing.split(/\r?\n/)) {
    if (/^Attributes = .*\bl[rwx-]{9}/.test(line)) throw new Error('Archive links are not supported.');
    if (/^(Symbolic Link|Hard Link) = .+/.test(line)) throw new Error('Archive links are not supported.');
    if (!line.startsWith('Path = ')) continue;
    const name = line.slice(7);
    if (path.win32.isAbsolute(name) || name.includes(':') || name.split(/[\\/]/).includes('..')) throw new Error('Archive contains an unsafe path.');
  }
  await run(['x', '-y', '-p-', `-o${target}`, file], 'extraction');
}
