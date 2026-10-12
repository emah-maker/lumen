// The error page (renderer/error.html) says what went wrong in the system's language: this hands it the
// string table renderer/i18n.js looks keys up in. Registered session-wide as a 'frame' preload (main.js),
// the same idiom as page-dialogs-preload.js, so it does nothing on any page but the error page and the three warning pages (certificate, HTTPS-only, Safe Browsing);
// main answers only that page too (pages:strings).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/(error|cert-error|https-only|safe-browsing)\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('lumenI18n', ipcRenderer.sendSync('pages:strings') || { locale: 'en', strings: {} });
}
// The "This file was moved or deleted" page (the error page with kind=missingfile): Show in folder and Choose file. Main takes the
// file from the page's own address, never from these calls.
if (location.protocol === 'file:' && /\/renderer\/error\.html$/.test(location.pathname) && /[?&]kind=missingfile\b/.test(location.search)) {
  contextBridge.exposeInMainWorld('lumenMissingFile', {
    showInFolder: () => ipcRenderer.send('missingfile:folder'),
    choose: () => ipcRenderer.send('missingfile:choose'),
  });
}
