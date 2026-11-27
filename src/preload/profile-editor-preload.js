// Preload for the profile editor window (features/profiles-ui.js): Add / Edit a profile's name, colour and avatar. Nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profileEditor', {
  init: () => ipcRenderer.invoke('profile-editor:init'),
  save: (fields) => ipcRenderer.invoke('profile-editor:save', fields),
  cancel: () => ipcRenderer.send('profile-editor:cancel'),
});
