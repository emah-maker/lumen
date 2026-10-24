// The hovered-link bubble (renderer/link-status.html): text comes from features/link-status.js; the only call back is "the pointer is on me".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linkStatus', {
  onText: (callback) => ipcRenderer.on('linkstatus:text', (_e, text) => callback(String(text))),
  dodge: () => ipcRenderer.send('linkstatus:dodge'),
});
