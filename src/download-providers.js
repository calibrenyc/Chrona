const ONLINE_FIX_NAMES = new Set(['online-fix', 'online fix', 'onlinefix']);

function isSupportedGamePackage(filename) {
  const name = String(filename || '').trim().toLowerCase();
  // Chrona installs archives; accepting arbitrary executables lets advertising
  // installers (for example, browser setup programs) masquerade as the game.
  return /\.(zip|rar|7z)$/.test(name) || /\.(zip|rar|7z)\.\d{3}$/.test(name) || /\.part\d+\.rar$/.test(name);
}

function classifyProvider(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (ONLINE_FIX_NAMES.has(normalized)) {
    return { id: 'online-fix', packageType: 'ONLINE_FIX', installBehavior: 'OVERLAY', supportsMultipart: true };
  }
  if (/zeigames/.test(normalized)) {
    return { id: 'zeigames', packageType: 'MAIN_GAME', installBehavior: 'EXTRACT', supportsMultipart: true };
  }
  if (/ankergames/.test(normalized)) {
    return { id: 'ankergames', packageType: 'MAIN_GAME', installBehavior: 'EXTRACT', supportsMultipart: false };
  }
  return { id: normalized.replace(/[^a-z0-9-]+/g, '-') || 'unknown', packageType: 'MAIN_GAME', installBehavior: 'EXTRACT', supportsMultipart: true };
}

function packageDefinition(game, providerName) {
  const adapter = classifyProvider(providerName);
  const declaredType = String(game?.packageType || '').toUpperCase();
  if (['MAIN_GAME', 'ONLINE_FIX', 'PREREQUISITE', 'DLC', 'PATCH', 'OPTIONAL'].includes(declaredType)) {
    adapter.packageType = declaredType;
    adapter.installBehavior = game?.installBehavior || (declaredType === 'MAIN_GAME' ? 'EXTRACT' : 'OVERLAY');
  }
  const declarations = Array.isArray(game?.requiredPackages) ? game.requiredPackages : [];
  const declared = declarations.find(item => String(item?.type || '').toUpperCase() === adapter.packageType);
  const explicitRequired = typeof game?.packageRequired === 'boolean' ? game.packageRequired : null;
  const required = adapter.packageType === 'MAIN_GAME' || (explicitRequired ?? (!!declared?.required ||
    (adapter.packageType === 'ONLINE_FIX' && game?.requiresOnlineFix === true && game?.onlineFixOptional !== true)));
  const packageId = adapter.packageType === 'MAIN_GAME' ? 'main-game' : String(declared?.packageId || declared?.id || adapter.packageType.toLowerCase().replaceAll('_', '-')).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return {
    ...adapter,
    fileType: game?.fileType || null,
    extractionRequired: game?.extractionRequired !== false,
    overlayTarget: adapter.packageType !== 'MAIN_GAME' && adapter.installBehavior === 'OVERLAY' ? 'MAIN_GAME' : null,
    required,
    optional: !required,
    dependsOn: adapter.packageType === 'ONLINE_FIX' ? 'MAIN_GAME' : null,
    packageId
  };
}

module.exports = { classifyProvider, packageDefinition, isSupportedGamePackage };
