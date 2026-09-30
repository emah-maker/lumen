const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suggest', {
  onItems: (callback) => ipcRenderer.on('suggest:items', (_e, payload) => callback(payload)),
  pick: (index, listId) => ipcRenderer.send('suggest:pick', index, listId),
});
