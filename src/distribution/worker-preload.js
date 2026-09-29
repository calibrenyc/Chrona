const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('updater', {
  onStatus: callback => ipcRenderer.on('updater:status', (_event, value) => callback(value)),
  action: value => ipcRenderer.invoke('updater:action', value)
});
