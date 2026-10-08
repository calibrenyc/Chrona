# Chrona 1.3.8

- Fixed the packaged updater failing to open and timing out before installation.
- Made updater health verification independent of renderer startup and verified the complete update, relaunch, rollback, and data-preservation flow.
- Blocked setup programs and unrelated files from being mistaken for downloaded games.
- Fixed clearing Downloads leaving stale game-installation and multipart entries behind.
- Fixed provider pages covering Chrona's download progress and made Minimize download leave the provider safely.
- Added continuous progress reporting, a visible Cancel download action, and a clear timeout when a provider sends no file data.
- Restored the first-run setup and post-update release-notes gate in packaged builds.

Users on a release with the updater-startup bug must install this release once with `ChronaSetup-1.3.8.exe`. Future in-app updates can then start normally.
