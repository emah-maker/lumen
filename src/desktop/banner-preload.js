// [desktop apps] The banner's only bridge: its two buttons, whether the pointer is over one (so the window is click-through everywhere
// else), and the text main sends it. Nothing else is reachable from that page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBanner', {
  action: (what) => ipcRenderer.send('desktop-banner:action', what === 'resume' ? 'resume' : 'stop'),
  hover: (on) => ipcRenderer.send('desktop-banner:hover', Boolean(on)),
  onState: (cb) => ipcRenderer.on('desktop-banner:state', (_e, s) => cb({ text: String(s?.text || ''), paused: Boolean(s?.paused) })),
});
