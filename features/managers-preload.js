// The Bookmarks and Downloads pages' bridge (features/managers.js). Only a tab opened as one of
// those pages gets this preload, and only that page's own document sees the API; main checks the
// sender again before answering.
const { contextBridge, ipcRenderer } = require('electron');

const page = location.protocol === 'file:' ? (/\/renderer\/(bookmarks|downloads)\.html$/.exec(location.pathname) || [])[1] : null;
const onChange = (channel) => (fn) => { if (typeof fn === 'function') ipcRenderer.on(channel, () => fn()); };

if (page === 'bookmarks') {
  contextBridge.exposeInMainWorld('lumenBookmarks', {
    list: () => ipcRenderer.invoke('bookmarks:list'),
    add: (b) => ipcRenderer.invoke('bookmarks:add', b),
    update: (b) => ipcRenderer.invoke('bookmarks:update', b),
    remove: (url) => ipcRenderer.invoke('bookmarks:remove', url),
    open: (url) => ipcRenderer.invoke('bookmarks:open', url),
    exportFile: () => ipcRenderer.invoke('bookmarks:export'),
    importFile: () => ipcRenderer.invoke('bookmarks:import'),
    onChange: onChange('bookmarks:changed'),
  });
} else if (page === 'downloads') {
  contextBridge.exposeInMainWorld('lumenDownloads', {
    list: () => ipcRenderer.invoke('downloads:list'),
    act: (id, action) => ipcRenderer.invoke('downloads:act', id, action),
    openFolder: () => ipcRenderer.invoke('downloads:folder'),
    onChange: onChange('downloads:changed'),
  });
}
