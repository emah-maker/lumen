// Preload for the print preview sheet (features/print-preview.js): a small bridge, nothing else.
// The page can send a settings object and press buttons; it never names a file.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printHost', {
  on: (channel, callback) => {
    if (!['print:init', 'print:rendered', 'print:error', 'print:busy', 'print:pdf-shown'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => callback(payload));
  },
  rect: (rect) => ipcRenderer.send('print:rect', rect),
  render: (settings) => ipcRenderer.send('print:render', settings),
  save: (settings) => ipcRenderer.send('print:save', settings),
  print: (settings) => ipcRenderer.send('print:print', settings),
  system: () => ipcRenderer.send('print:system'),
  cancel: () => ipcRenderer.send('print:cancel'),
});
