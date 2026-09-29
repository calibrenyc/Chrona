## Fixed

- Fixed the Windows updater extracting `resources/app.asar`. The updater now disables Electron's ASAR virtual filesystem before unpacking, so it can safely write and verify the complete application package.

### Important

If a previous update showed **Invalid package ... resources\\app.asar**, download and run **Chrona 1.2.4.exe** once. That installs the corrected updater; future updates can then be installed from Chrona.
