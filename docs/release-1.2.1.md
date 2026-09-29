# Chrona 1.2.1

## Fixed

- Added the **Downloads** tab. Completed game downloads now stay on disk and remain available to install again if extraction or setup fails.
- Each saved download shows its status, file location, install retry action, and a link to reveal it in Explorer.
- AnkerGames downloads keep the version and build captured when their file was downloaded. Retrying installation writes that same version record, so update checks compare against the correct installed release.
- Interrupted downloads are retained in the list with their original download page, ready to resume from the source.

## Updating Chrona

- Added **Chrona Updater**, a separate installed program and Start Menu shortcut. It checks official GitHub Releases, downloads the verified update package, installs it, and restarts Chrona.
- The in-app updater uses the same separate updater program, so Chrona can replace its files safely after it closes.

## Install

Download **ChronaSetup-1.2.1.exe** for a new installation or a manual upgrade. Existing user libraries and settings are preserved.

This release is unsigned; Windows may show an unknown-publisher or SmartScreen warning.
