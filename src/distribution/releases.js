const semver = require('semver');
const config = require('../../package.json').chronaUpdates;
function stableVersion(tag) {
  const version = semver.valid(String(tag || '').replace(/^v/, ''));
  return version && !semver.prerelease(version) ? version : null;
}
function normalizeRelease(release, arch = process.arch) {
  const version = stableVersion(release.tag_name);
  if (!version || release.draft || release.prerelease) return null;
  const name = `Chrona-Update-${version}-win-${arch}.zip`;
  const asset = release.assets?.find(item => item.name === name && item.state === 'uploaded');
  return { version, title: release.name || `Chrona ${version}`, notes: release.body || 'No release notes provided.',
    published: release.published_at, url: release.html_url,
    asset: asset ? { name, url: asset.browser_download_url, size: asset.size,
      sha256: /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7) : null } : null };
}
async function github(endpoint) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository)) throw new Error('The release repository is not configured.');
  const response = await fetch(`https://api.github.com/repos/${config.repository}/releases/${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Chrona' },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub is busy. Please try again later.' : `GitHub release check failed (${response.status}).`);
  return response.json();
}
async function latest(current, arch) {
  const raw = await github('latest');
  const release = raw && normalizeRelease(raw, arch);
  return { current, release, available: !!release && semver.gt(release.version, current) };
}
async function forVersion(version) {
  const raw = await github(`tags/v${version}`) || await github(`tags/${version}`);
  return raw && normalizeRelease(raw);
}
module.exports = { stableVersion, normalizeRelease, latest, forVersion };
