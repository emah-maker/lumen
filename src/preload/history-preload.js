// The History page's bridge (renderer/history.html): its entries, and removing one. Only a tab
// opened as the History page gets this preload, and only that page itself sees the API; main.js
// also checks the sender's URL before answering.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/history\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('lumenI18n', ipcRenderer.sendSync('pages:strings') || { locale: 'en', strings: {} }); // renderer/i18n.js
  contextBridge.exposeInMainWorld('lumenHistory', {
    list: () => ipcRenderer.invoke('history:list'),
    remove: (url) => ipcRenderer.invoke('history:remove', url),
    manage: () => ipcRenderer.invoke('history:manage'), // opens Settings → Privacy and security, where Clear browsing data is
  });
}
