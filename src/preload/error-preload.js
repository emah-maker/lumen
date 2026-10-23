// The error page (renderer/error.html) says what went wrong in the system's language: this hands it the
// string table renderer/i18n.js looks keys up in. Registered session-wide as a 'frame' preload (main.js),
// the same idiom as page-dialogs-preload.js, so it does nothing on any page but the error page, the three warning pages (certificate, HTTPS-only, Safe Browsing) and the focus block page;
// main answers only that page too (pages:strings).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/(error|cert-error|https-only|safe-browsing|unloaded|focus-block)\.html$/.test(location.pathname)) {
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
// The crashed page (kind=crashed): Reload for a page that is not on the web (a new tab, settings, a file) asks main to reload the tab.
if (location.protocol === 'file:' && /\/renderer\/error\.html$/.test(location.pathname) && /[?&]kind=crashed\b/.test(location.search)) {
  contextBridge.exposeInMainWorld('lumenCrashed', { reload: () => ipcRenderer.send('crashed:reload') });
}
// The focus block page (renderer/focus-block.html, features/focus.js): the time left, "I need this for school" and End focus. Main answers only that page
// in a tab's top frame, and takes the site from the page's own address.
if (location.protocol === 'file:' && /\/renderer\/focus-block\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('lumenFocus', {
    state: () => ipcRenderer.invoke('focus-page:state'),
    allow: () => ipcRenderer.invoke('focus-page:allow'),
    hold: (on) => ipcRenderer.invoke('focus-page:hold', Boolean(on)),
    end: () => ipcRenderer.invoke('focus-page:end'),
    settings: () => ipcRenderer.send('focus-page:settings'),
  });
}
