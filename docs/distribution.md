# Distribution architecture

## Audit (2026-09-19)

Chrona is Electron 31 / CommonJS, with a context-isolated preload and vanilla HTML,
CSS and JavaScript renderer. `src/main.js` owns the launcher and IPC. The existing
welcome animation in `index.html` is dismissed after 1.8 seconds. Version comes
from package.json (previously 1.1.0; the About label and portable filename were
hardcoded). electron-builder 24 previously emitted only a portable executable.
The distribution work upgrades electron-builder to 26.15.3: 24.13.3's assisted
per-user installer crashed in NSIS System.dll on this Windows 11 machine. The
new builder uses bounded Windows known-folder copying and avoids the affected
legacy System::Store implementation. Electron itself remains on 31.7.7.

`library.json` in Electron's userData directory contains games, paths, accounts,
art caches, preferences and play history. Keep the legacy package-name directory
(`%APPDATA%/chrona-game-launcher`) stable across portable/installed builds. Never
include it in release packages. Existing valid stores imply completed setup;
new stores explicitly record incomplete setup. Writes use atomic replacement.
Malformed stores are preserved and startup stops rather than resetting users.

Steam discovery already reads libraryfolders.vdf and appmanifest files. Extend
that implementation with registry detection and user-selected Steam roots.
Reuse existing Epic/portable scanning after setup; do not scan entire drives in
the setup wizard.

## Design

GitHub stable releases supply semantic version, title, body, date and an exact
architecture-specific full ZIP. The build creates an application file manifest
with SHA-256 hashes. Download size, optional GitHub asset digest, archive paths,
manifest version and every file hash are verified before closing the launcher.

An isolated copy of the Electron runtime runs `src/distribution/worker.js` as a
separate updater process outside the installation. It waits for launcher exit,
journals each move, backs up managed files, installs the staged application,
validates it, and waits for a renderer-ready health receipt from the new launcher.
Errors restore files in reverse order. Backups and logs remain for diagnosis.
Unknown files and all user data are outside the managed-file replacement set.

NSIS handles per-user Windows registration, directory selection, shortcuts,
repair/reinstallation and uninstall. The existing renderer handles first-run
libraries/preferences and post-update notes with the same design tokens. The
installer carries the setup pages before installation, with first-run setup as
a fallback for ZIP installations.

## Building and releasing

Run `npm ci`, `npm run audit`, then `npm run dist` on Windows with Node and PowerShell.
The version in package.json is the only application version source. The build
emits `dist/ChronaSetup-VERSION.exe` and
`dist/Chrona-Update-VERSION-win-x64.zip`. The full ZIP contains
`chrona-package.json` and the complete Electron application, including the
updater mode. Never rename the update asset: release selection is exact and
architecture-specific. Do not publish development directories or user data.

Create `docs/release-VERSION.md` with release notes, then run
`node scripts/draft-release.cjs` with an authenticated GitHub CLI. This uploads
the installer, update package and SHA-256 checksums as a **draft** release to
`calibrenyc/Chrona`. Review the assets and notes, then publish the release when
ready. Drafts and prereleases are ignored by the launcher. The new GitHub
repository is a release distribution repository; local source is not uploaded
by this command. Older portable builds do not have an updater, so users must run
the installer once to migrate; their existing profile stays in place.

No code-signing certificate is configured. Production signing can be supplied
through electron-builder's signing configuration. The manifest hook runs after
executable resource editing/signing so hashes describe the shipped bytes.
`signExecutable: false` currently disables signing while retaining Chrona's
Windows icon and version metadata; remove it when configuring a certificate.

For a certificate-backed signed build, set `WIN_CSC_LINK` (or `CSC_LINK`) to the
certificate location and its password through `WIN_CSC_KEY_PASSWORD` (or
`CSC_KEY_PASSWORD`), or set `CHRONA_CERT_THUMBPRINT` to an installed code-signing
certificate with an accessible private key. Run `npm run dist:signed`. This
enables signing and `forceCodeSigning` for that build, preserving the manifest
hook after signing. It refuses to build without explicit signing credentials.
Never commit certificate files, private keys, or passwords. Cloud signing needs
provider-specific configuration before using that provider.

## Verification and recovery

`scripts/smoke-electron.cjs` is an Electron test harness for fresh and updated
profiles. `node scripts/smoke-updater.cjs` exercises an actual packaged helper,
process-exit handoff, file replacement, health receipt and profile preservation.
Both use isolated `.qa` profiles; screenshots and full update fixtures remain
there for inspection. Use `--user-data-dir=ABSOLUTE_PATH` for an isolated manual
launcher profile. Never point a test at the real profile.

Update workspaces are siblings of the chosen installation named
`.chrona-update-*`; this keeps moves on the same volume. They contain the ZIP,
staged files, a separate helper runtime, `job.json`, the journal, and backup.
Logs are in `%APPDATA%/chrona-game-launcher/logs/updater.log`; installer logging
uses the same logs folder. Backups are retained after success and failure.

If power loss interrupts replacement, close Chrona and run the retained
`helper/Chrona.exe --chrona-updater ABSOLUTE_WORKSPACE/job.json`. The helper
replays the journal backwards before retrying. Do not delete the workspace
until recovery is complete. If recovery itself fails, View Details reports the
backup location and the updater does not claim the installation is safe.

An update needs room for the download, extracted application, helper copy and
backup. An unwritable/protected installation fails before Chrona closes; install
per-user into a writable directory. Full ZIP updates retain the registered NSIS
uninstaller and shortcuts and update Installed Apps version metadata.

The release model is normalized in `releases.js` independently of downloading
and replacement. A future channel/manifest provider can supply the same shape
without moving replacement logic into the launcher. Only stable x64 Windows
packages are currently built. Backups are intentionally retained, so disk-space
cleanup is currently manual after a successful update.
