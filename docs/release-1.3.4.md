# Chrona 1.3.4

- Fixed application updates failing while extracting `resources/app.asar`. The staging extractor now disables Electron ASAR path virtualization while writing the update package.
