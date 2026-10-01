// The private window's UI bridge (renderer/private.html). Sandboxed: only the private:* calls below,
// and main answers them only from that window's own top-level UI document (features/private-window.js).
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set(['private:new-tab', 'private:new-window', 'private:close-tab', 'private:switch', 'private:move', 'private:go', 'private:back', 'private:forward', 'private:reload',
  'private:zoom-reset', 'private:focus-page', 'private:find', 'private:find-stop', 'private:downloads']);
const LISTEN = new Set(['private:state', 'private:focus-address', 'private:find-open', 'private:find-close', 'private:find-step', 'private:find-result', 'private:fullscreen']);

// The window's strings (locales/, private.* keys) for renderer/i18n.js, and the platform for the title bar's layout.
const loaded = ipcRenderer.sendSync('private:strings') || {};
contextBridge.exposeInMainWorld('lumenI18n', { locale: loaded.locale || 'en', strings: loaded.strings || {} });
contextBridge.exposeInMainWorld('privateUi', {
  platform: loaded.platform || process.platform,
  send: (channel, arg) => { if (SEND.has(channel)) ipcRenderer.send(channel, arg); },
  on: (channel, fn) => { if (LISTEN.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data)); },
});
