// The error page (renderer/error.html) says what went wrong in the system's language: this hands it the
// string table renderer/i18n.js looks keys up in. Registered session-wide as a 'frame' preload (main.js),
// the same idiom as page-dialogs-preload.js, so it does nothing on any page but the error page itself;
// main answers only that page too (pages:strings).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/error\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('lumenI18n', ipcRenderer.sendSync('pages:strings') || { locale: 'en', strings: {} });
}
