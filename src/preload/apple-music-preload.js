// Preload of the Apple Music engine's hidden music.apple.com view (features/apple-music-engine.js). It acts only in the top
// frame, and only when main says this is music.apple.com (it answers with the script, or with nothing). It puts main's fixed bridge script (features/apple-music-bridge.js BRIDGE_SOURCE) into the page, and
// carries its messages: page -> main as text over IPC (main parses and bounds it), main -> page as a text DOM event. It
// exposes nothing to the page and runs nothing it is handed except that one constant script.
const { ipcRenderer, webFrame } = require('electron');

if (location.protocol === 'https:' && window.top === window) {
  const source = ipcRenderer.sendSync('amusic:bridge-source');
  if (typeof source === 'string' && source.length > 0 && source.length < 50000) {
    webFrame.executeJavaScript(source).catch(() => {});
    document.addEventListener('lumen-am-out', (e) => {
      if (typeof e.detail === 'string' && e.detail.length < 200000) ipcRenderer.send('amusic:msg', e.detail);
    });
    ipcRenderer.on('amusic:cmd', (_event, json) => {
      if (typeof json === 'string' && json.length < 2000) document.dispatchEvent(new CustomEvent('lumen-am-in', { detail: json }));
    });
  }
}
