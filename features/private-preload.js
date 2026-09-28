// The private window's UI bridge (renderer/private.html). Sandboxed: only the private:* calls below,
// and main answers them only from that window's own top-level UI document (features/private-window.js).
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set(['private:new-tab', 'private:new-window', 'private:close-tab', 'private:switch', 'private:go', 'private:back', 'private:forward', 'private:reload']);
const LISTEN = new Set(['private:state', 'private:focus-address']);

contextBridge.exposeInMainWorld('privateUi', {
  send: (channel, arg) => { if (SEND.has(channel)) ipcRenderer.send(channel, arg); },
  on: (channel, fn) => { if (LISTEN.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data)); },
});
