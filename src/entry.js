// Updater mode never loads launcher IPC or acquires its single-instance lock.
if (process.argv.includes('--chrona-updater')) require('./distribution/worker');
else if (require('node:path').basename(process.execPath).toLowerCase() === 'chronaupdater.exe') require('./distribution/standalone');
else require('./main');
