// Electron virtualizes .asar paths. Distribution must hash/copy/rename the
// archive bytes, never traverse them as a virtual application directory.
module.exports = process.versions.electron ? require('original-fs') : require('node:fs');
