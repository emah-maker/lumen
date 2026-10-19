// The screen recorder's window (renderer/recorder.html, features/screen-recorder.js): the page records and shows the small bar; this is
// its only bridge. Recorded pieces go to main, which writes the file; buttons go back as one word; main sends what the bar should show.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenRec', {
  chunk: (buffer) => ipcRenderer.send('screen-rec:chunk', buffer),
  done: (info) => ipcRenderer.send('screen-rec:done', { bytes: Number(info?.bytes) || 0 }),
  ctl: (what) => ipcRenderer.send('screen-rec:ctl', String(what)),
  onView: (callback) => ipcRenderer.on('screen-rec:view', (_e, view) => callback(view)),
});
