// chrome.tabs.insertCSS and removeCSS for extensions. electron-chrome-extensions' insertCSS put every sheet in the tab's top frame, whatever
// frame it named, and it has no removeCSS. uBlock Origin (Manifest V2) does all its element hiding with these two: each frame's rules, and it
// takes rules back out as the page changes. So an ad inside a frame stayed, one frame's rules hid things in the top page, and a rule taken
// back stayed for good. Here each sheet goes to the frame it names (or all of them) through preload/extension-css-preload.js in the tab's
// top frame (webFrame.insertCSS on that frame), which keeps the keys for removeCSS. The handlers replace the library's in its router
// (setupExtensions, main.js).
// Not as Chrome does it: sheets are author sheets, not the user sheets uBlock asks for (Electron 44 can't take a user sheet back out:
// removeInsertedCSS leaves it), and a frame in another process than the top page (a cross-site frame) is out of the preload's reach.
const CHANNEL = 'lumen-extension-css';

// The frames a call names: frameId 0 (or none) the top frame, another frameId that frame (Chromium's extension frame ids are frame tree node
// ids), allFrames every frame in the tab.
function framesFor(wc, details = {}) {
  const top = wc.mainFrame;
  if (!top) return [];
  if (details.allFrames) return top.framesInSubtree;
  const id = Number.isInteger(details.frameId) ? details.frameId : 0;
  if (id === 0) return [top];
  return top.framesInSubtree.filter((f) => f.frameTreeNodeId === id);
}

// `tabById(id)` -> the tab's webContents (the library's store). Returns the router callbacks.
function handlers(tabById) {
  const send = (op) => (_event, tabId, details) => {
    const wc = tabById(tabId);
    if (!wc || wc.isDestroyed() || typeof details?.code !== 'string') return undefined; // (a file: is not used by the extensions Lumen runs)
    const top = wc.mainFrame;
    const tokens = framesFor(wc, details).filter((f) => f.processId === top.processId).map((f) => f.frameToken);
    if (tokens.length) {
      try { top.send(CHANNEL, op, details.code, tokens); } catch { /* the page is gone */ }
    }
    return undefined;
  };
  return { insertCSS: send('insert'), removeCSS: send('remove') };
}

module.exports = { CHANNEL, framesFor, handlers };
