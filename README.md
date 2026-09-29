# Chrona

A local-first Windows desktop launcher for mixed game libraries: Steam, Epic Games, Xbox-style URI launches, and portable installs that need a specific `.exe`, `.bat`, `.cmd`, `.lnk`, or `.url` entry point.

## Run

```powershell
npm install
npm start
```

## Windows installer and updates

Run `npm run dist` to build the current installer, portable app and full x64 update
ZIP in `dist/`. Setup lets you select the installation directory, Steam/game libraries,
appearance and shortcuts. Existing configurations skip library setup. Settings
and library metadata remain in `%APPDATA%\chrona-game-launcher`.

Chrona checks stable releases from [calibrenyc/Chrona](https://github.com/calibrenyc/Chrona).
You can also check from Settings. Updates download in the launcher and install
through a separate process, with package verification, backups, rollback and a
startup health check. Release notes appear immediately after the splash screen.
Older portable users must run the installer once to gain application updates.

Run `npm run audit` for the renderer audit. See [distribution architecture and release
instructions](docs/distribution.md) for the audit, package contract, Electron
smoke tests, draft-release command and recovery procedure.

## What it does

- Scans common game folders across `C:` through `G:`.
- Reads Steam `appmanifest_*.acf` files and launches Steam games with `steam://rungameid/...`.
- Reads Epic `.item` manifests when available and launches through Epic's launcher URI.
- Finds portable games by looking for likely launcher files under game folders.
- Lets you add more folders from the app.
- Lets you choose each game's launch type and launcher path or URI.
- Saves your library settings in Electron's app data folder.
- Uses Steam's public cover image CDN for Steam games and searches Steam by name for portable installs.
- Offers an Acrylic desktop backdrop with a dark tint for readability.

## Notes

Some launchers do not expose a reliable way to force themselves minimized. The app uses launcher URI schemes where possible, which generally avoids opening a manual launcher flow, but the final behavior is controlled by Steam, Epic, Xbox, or the game's own launcher.
