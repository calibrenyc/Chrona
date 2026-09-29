## New
- Install Chrona with a Windows setup wizard, a choice of installation folder, game libraries, Steam location, appearance and shortcuts.
- Check for stable Chrona updates directly from GitHub Releases in Settings.
- Download and install complete application updates without manually replacing files.
- See What's New immediately after the splash screen following an update.

## Improved
- Existing libraries, accounts, game paths, artwork, playtime and preferences stay in Chrona's existing user-data folder.
- Detect Steam through its Windows registry entry and configured library folders.
- Setup remembers your choices and existing users skip onboarding.

## Fixed
- Verify package sizes, archive paths and application file hashes before installation.
- Use a separate updater process to wait for Chrona to exit, back up application files, install the update and verify startup.
- Restore the previous application if replacement or startup fails, with logs and recovery backups retained.
- Save configuration through atomic file replacement and preserve unreadable configuration for recovery.

### Installing
Download **ChronaSetup-1.2.0.exe**. Existing portable users should run setup once to switch to the installed version; their saved configuration is retained.

This release is **unsigned**. Windows may display an unknown-publisher or SmartScreen warning.

The **Chrona-Update-1.2.0-win-x64.zip** asset is the complete Windows x64 application package used by Chrona's updater.
