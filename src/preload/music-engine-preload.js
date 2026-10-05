// Preload of a music engine's hidden view (features/music-engine.js: Apple Music's music.apple.com, Spotify's open.spotify.com). It acts
// only in the top frame, and only when main says this is the engine's own page (main answers with that service's fixed bridge script,
// or with nothing). It puts the script into the page, and carries its messages: page -> main as text over IPC (main parses and bounds
// it), main -> page as a text DOM event. It exposes nothing to the page and runs nothing it is handed except that one constant script.
const { ipcRenderer, webFrame } = require('electron');

if (location.protocol === 'https:' && window.top === window) {
  const source = ipcRenderer.sendSync('musicengine:bridge-source');
  if (typeof source === 'string' && source.length > 0 && source.length < 80000) {
    // The listeners first: a bridge that reports as soon as it runs (Spotify's) must not be heard by nobody.
    document.addEventListener('lumen-engine-out', (e) => {
      if (typeof e.detail === 'string' && e.detail.length < 200000) ipcRenderer.send('musicengine:msg', e.detail);
    });
    ipcRenderer.on('musicengine:cmd', (_event, json) => {
      if (typeof json === 'string' && json.length < 2000) document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: json }));
    });
    webFrame.executeJavaScript(source).catch(() => {});
  }
}
