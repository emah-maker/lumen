// [look] Music-reactive home screen, the browser's half (renderer/newtab-music-react.js is the page's). The page asks "what is playing?" about
// every 4 seconds while it is in front and the setting is on; this answers with ONE tab's capture id, or nothing.
//
//   - Only the new-tab page's top frame is answered (main.js checks the sender), and only while Settings → "Music-reactive home screen" is on.
//   - The source is a Lumen window that is playing sound right now: first Lumen's own music players (Spotify, Apple Music), then any tab.
//     It is never the microphone and never the computer's sound as a whole: Chromium's per-tab capture id (webContents.getMediaSourceId)
//     only works for the one tab it names, only for the page it was made for, and only for 10 seconds.
//   - The page then asks for that stream, audio only, and Chromium asks the permission handler about the captured tab (not the asking page).
//     allows() is the single exception to "media is refused unless the user said yes": it says yes only for the tab an id was just made for,
//     only when the request comes from a local Lumen page (never from the captured tab's own page), never for video, within 15 seconds, once.
//   - Nothing here reads, keeps or forwards audio. Frames are reduced to a few numbers inside the page's analyser.
'use strict';

const GRANT_MS = 15e3;
const HOLD_MS = 3e3; // a tab that was audible this recently still counts (Chromium says silent in every quiet gap; a song has them)

function create({ players, tabs, isNewTab, enabled, now = Date.now, pick }) {
  const grants = new Map(); // captured webContents id -> { requester (the new-tab page's webContents), until }
  const usable = (wc) => Boolean(wc) && !wc.isDestroyed();
  const lastAudible = new Map(); // webContents id -> when it was last heard
  const audible = (wc) => {
    let on = false;
    try { on = wc.isCurrentlyAudible() === true; } catch { on = false; }
    const t = now();
    if (on) lastAudible.set(wc.id, t);
    return on || t - (lastAudible.get(wc.id) ?? -1e12) < HOLD_MS;
  };
  // While the page keeps asking (and for 12 s after it stops), every window is looked at about 2.5 times a second so the hold above sees the beats
  // between the quiet gaps, not just the instant of each question. A few cheap calls; the timer stops by itself.
  let timer = null; let lastAsk = 0;
  const sampleAll = () => {
    if (now() - lastAsk > 12e3) { clearInterval(timer); timer = null; return; }
    for (const wc of [...players(), ...tabs()]) if (usable(wc)) audible(wc);
  };
  return {
    // (requesting webContents, the key it is capturing now or null) -> { key: null } | { key, id: null } (same as it has) | { key, id }
    source(requester, have) {
      if (!usable(requester) || enabled() !== true) return { key: null };
      lastAsk = now();
      if (!timer) { timer = setInterval(sampleAll, 400); timer.unref?.(); }
      const list = (ws) => ws.filter(usable).filter((w) => w !== requester).map((w) => ({ id: w.id, audible: audible(w), wc: w }));
      const p = list(players()); const t = list(tabs());
      const key = pick(p, t, requester.id);
      if (key === null) return { key: null };
      if (key === have) return { key, id: null };
      const target = [...p, ...t].find((x) => x.id === key)?.wc;
      if (!target) return { key: null };
      let id;
      try { id = target.getMediaSourceId(requester); } catch { return { key: null }; }
      if (typeof id !== 'string' || !id) return { key: null };
      grants.set(target.id, { requester, until: now() + GRANT_MS });
      return { key, id };
    },
    // The permission handler's question, about `wc` (the captured tab). consume: a request uses the grant up; a check (which asks without
    // opening anything) leaves it. details: Electron's, with securityOrigin the asking page's origin.
    allows(wc, permission, details, consume) {
      if (permission !== 'media' || !usable(wc) || enabled() !== true) return false;
      const g = grants.get(wc.id);
      if (!g) return false;
      if (now() > g.until || !usable(g.requester)) { grants.delete(wc.id); return false; }
      const d = details || {};
      if (d.isMainFrame === false || d.mediaType === 'video') return false;
      if (Array.isArray(d.mediaTypes) && d.mediaTypes.some((m) => m !== 'audio')) return false; // never video, never both (tab audio itself is listed as no type at all)
      if (typeof d.securityOrigin !== 'string' || !d.securityOrigin.startsWith('file:')) return false; // asked by one of Lumen's own local pages, not by the tab's page
      let onNewTab = false;
      try { onNewTab = isNewTab(g.requester.getURL()); } catch { return false; }
      if (!onNewTab) return false;
      if (consume) grants.delete(wc.id);
      return true;
    },
    forget(wc) { if (wc) for (const [k, g] of grants) if (k === wc.id || g.requester === wc) grants.delete(k); },
  };
}

module.exports = { create, GRANT_MS };
