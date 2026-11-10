// In a tab's top frame: the sheets an extension puts in this frame, or in a frame inside it, with chrome.tabs.insertCSS, and takes back with
// removeCSS (browser/extension-css.js sends them here with the frames' tokens). webFrame.insertCSS keeps a sheet out of the page's own
// document.styleSheets; frames in this process are reached by their token.
const { ipcRenderer, webFrame } = require('electron');

const keys = new Map(); // frame token + code -> the keys of the sheets inserted with it
ipcRenderer.on('lumen-extension-css', (_event, op, code, tokens) => {
  if (typeof code !== 'string' || !Array.isArray(tokens)) return;
  for (const token of tokens) {
    const id = `${token}\n${code}`;
    try {
      const frame = token === webFrame.frameToken ? webFrame : webFrame.findFrameByToken(token);
      if (!frame) { keys.delete(id); continue; }
      if (op === 'insert') keys.set(id, [...(keys.get(id) || []), frame.insertCSS(code)]);
      else if (op === 'remove') { for (const key of keys.get(id) || []) frame.removeInsertedCSS(key); keys.delete(id); }
    } catch { /* a frame that just went away */ }
  }
});
