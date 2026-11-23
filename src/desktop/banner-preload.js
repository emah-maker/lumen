// [desktop apps] The banner's only bridge: its buttons, whether the pointer is over the bar (so the window is click-through everywhere
// else), dragging it, making it small or full size, and the text main sends it. Nothing else is reachable from that page.
const { contextBridge, ipcRenderer } = require('electron');

const DRAG = new Set(['start', 'move', 'end']);

contextBridge.exposeInMainWorld('desktopBanner', {
  action: (what) => ipcRenderer.send('desktop-banner:action', what === 'resume' ? 'resume' : 'stop'),
  hover: (on) => ipcRenderer.send('desktop-banner:hover', Boolean(on)),
  drag: (phase, x, y) => { if (DRAG.has(phase)) ipcRenderer.send('desktop-banner:drag', phase, Number(x), Number(y)); },
  size: (small) => ipcRenderer.send('desktop-banner:size', Boolean(small)),
  onState: (cb) => ipcRenderer.on('desktop-banner:state', (_e, s) => cb({ text: String(s?.text || ''), paused: Boolean(s?.paused), app: String(s?.app || ''), small: Boolean(s?.small) })),
});
