// Preload for the dialogs overlay (features/dialogs.js): a small bridge, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialogHost', {
  onShow: (callback) => ipcRenderer.on('dialog:show', (_e, payload) => callback(payload)),
  onUpdate: (callback) => ipcRenderer.on('dialog:update', (_e, payload) => callback(payload)), // the device chooser's list changed
  respond: (result) => ipcRenderer.send('dialog:respond', result),
});
