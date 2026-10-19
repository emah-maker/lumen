// [look] Music-reactive home screen, the browser's half (renderer/newtab-music-react.js is the page's). The page listens to the sound the PC is
// playing: Windows' system-output loopback, a copy of what is already going to the speakers, handed to the new-tab page through getDisplayMedia (audio
// only: the video Chromium insists on is stopped the moment it arrives). A loopback never touches the tabs or apps that make the sound, so nothing is
// muted, delayed or interrupted, and it hears the Spotify desktop app and any other program too.
//
//   - Only the new-tab page's top frame is answered (main.js checks the sender), only while Settings → "Music-reactive home screen" is on, and only on
//     Windows (the page is told why when it is not).
//   - start() makes a 15-second grant for the page. The permission handlers (allowsDisplay) and the display-media handler (takeDisplay) honour it for that
//     page only and use it up once: a stream is one grant. Never the microphone or the camera (those requests always name their type and are never
//     answered here), never the screen's picture.
//   - Nothing here reads, keeps or forwards audio. The page reduces each frame to a few loudness numbers and drops it.
'use strict';

const GRANT_MS = 15e3;

function create({ isNewTab, enabled, now = Date.now, platform = process.platform }) {
  const grants = new Map(); // the new-tab page's webContents id -> { wc, until }
  const usable = (wc) => Boolean(wc) && !wc.isDestroyed();
  const live = (wc) => { const g = grants.get(wc.id); if (!g) return false; if (now() > g.until) { grants.delete(wc.id); return false; } return true; };
  let onNewTab = (wc) => { try { return isNewTab(wc.getURL()); } catch { return false; } };
  return {
    supported: () => platform === 'win32',
    // The page asks to start listening -> { ok: true } | { ok: false, why: 'off' | 'platform' }
    start(requester) {
      if (!usable(requester) || enabled() !== true) return { ok: false, why: 'off' };
      if (platform !== 'win32') return { ok: false, why: 'platform' };
      grants.set(requester.id, { wc: requester, until: now() + GRANT_MS });
      return { ok: true };
    },
    // The permission handlers' question: may `wc` use getDisplayMedia right now? Chromium asks 'display-capture', or 'media' with no media type at all
    // (a microphone or camera request always names its type). Yes only for the new-tab page itself, while its grant is live.
    allowsDisplay(wc, permission, details) {
      const d = details || {};
      const display = permission === 'display-capture' || (permission === 'media' && Array.isArray(d.mediaTypes) && d.mediaTypes.length === 0 && d.mediaType === undefined);
      if (!display || d.isMainFrame === false || !usable(wc) || enabled() !== true || platform !== 'win32') return false;
      return live(wc) && onNewTab(wc);
    },
    // The display-media handler's question: true when this request is the new-tab page's own, with a live grant (which it uses up).
    takeDisplay(wc, isTopFrame) {
      if (!usable(wc) || isTopFrame !== true || enabled() !== true || platform !== 'win32') return false;
      const ok = live(wc) && onNewTab(wc);
      if (ok) grants.delete(wc.id);
      return ok;
    },
    forget(wc) { if (wc) grants.delete(wc.id); },
  };
}

module.exports = { create, GRANT_MS };
