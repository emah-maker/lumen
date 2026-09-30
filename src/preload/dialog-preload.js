// Preload for the dialogs overlay (features/dialogs.js): a small bridge, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialogHost', {
  onShow: (callback) => ipcRenderer.on('dialog:show', (_e, payload) => callback(payload)),
  respond: (result) => ipcRenderer.send('dialog:respond', result),
});
