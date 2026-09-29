// Preload for the tool overlay (features/tool-overlay.js): a small bridge, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toolHost', {
  onShow: (callback) => ipcRenderer.on('tool-overlay:show', (_e, payload) => callback(payload)),
  onUpdate: (callback) => ipcRenderer.on('tool-overlay:update', (_e, payload) => callback(payload)),
  action: (id, action, data) => ipcRenderer.send('tool-overlay:action', { id, action, data }),
});
