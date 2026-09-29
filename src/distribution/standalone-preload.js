const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('chronaUpdater', {
  check: () => ipcRenderer.invoke('chrona:check'),
  install: () => ipcRenderer.invoke('chrona:install'),
  launch: () => ipcRenderer.invoke('updater:launchCurrent'),
  details: () => ipcRenderer.invoke('chrona:logs'),
  onProgress: callback => ipcRenderer.on('chrona:progress', (_event, value) => callback(value))
});
