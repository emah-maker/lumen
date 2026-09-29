// The downloads panel (renderer/downloads-panel.html): the list comes from features/downloads.js, and
// every action goes back by download id. main.js accepts these only from the panel's own view.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('downloadsPanel', {
  onList: (callback) => ipcRenderer.on('downloads:list', (_e, list) => callback(list)),
  onOpen: (callback) => ipcRenderer.on('downloads:open', () => callback()),
  act: (action, id) => ipcRenderer.send('downloads:act', action, id),
  drag: (id) => ipcRenderer.send('downloads:drag', id),
  clear: () => ipcRenderer.send('downloads:clear'),
  openFolder: () => ipcRenderer.send('downloads:folder'),
  showAll: () => ipcRenderer.send('downloads:all'),
  close: () => ipcRenderer.send('downloads:close'),
  setHeight: (height) => ipcRenderer.send('downloads:height', height),
});
