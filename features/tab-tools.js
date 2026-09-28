// Tab search (Ctrl+Shift+A) and tab audio: the speaker on a tab playing sound, Mute Tab and Mute
// Site. main.js owns the tabs; this keeps the per-tab audio state and the titles of closed tabs
// (main.js's closedTabs list keeps only their URLs) for the search popup's "Recently closed".

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

function create({ onChange, isWebUrl }) {
  const mutedSites = new Set(); // hosts muted with "Mute Site", until Lumen quits
  const closedTitles = new Map(); // closed tab URL -> its title

  // Mute Site covers the tabs on that host now and any page on it later, until unmuted; a tab muted
  // only because of its site is unmuted again when it leaves the site. A tab muted by hand stays muted.
  function applySite(tab, wc) {
    if (wc.isDestroyed()) return;
    const host = hostOf(wc.getURL());
    if (host && mutedSites.has(host)) {
      if (!wc.isAudioMuted()) { wc.setAudioMuted(true); tab.siteMuted = true; }
    } else if (tab.siteMuted) {
      tab.siteMuted = false;
      if (!tab.muted) wc.setAudioMuted(false);
    }
  }

  // Called for every tab view, including a sleeping tab's rebuilt one (tab.muted carries over).
  function wire(tab) {
    const wc = tab.view.webContents;
    if (tab.muted) wc.setAudioMuted(true);
    wc.on('audio-state-changed', () => onChange());
    wc.on('did-navigate', () => { applySite(tab, wc); onChange(); });
    applySite(tab, wc);
  }

  function state(tab, alive) {
    if (!alive) return { audible: false, muted: Boolean(tab.muted) };
    const wc = tab.view.webContents;
    return { audible: wc.isCurrentlyAudible(), muted: wc.isAudioMuted() };
  }

  function setMuted(tab, muted) {
    const wc = tab.view?.webContents;
    tab.muted = Boolean(muted);
    tab.siteMuted = false;
    if (wc && !wc.isDestroyed()) wc.setAudioMuted(tab.muted);
    onChange();
  }

  const siteOf = (url) => (isWebUrl(url) ? hostOf(url) : '');
  const siteMuted = (host) => Boolean(host) && mutedSites.has(host);

  function setSiteMuted(host, muted, tabs, urlOf) {
    if (!host) return;
    if (muted) mutedSites.add(host);
    else mutedSites.delete(host);
    for (const tab of tabs) {
      if (hostOf(urlOf(tab)) !== host) continue;
      const wc = tab.view?.webContents;
      if (muted) {
        if (wc && !wc.isDestroyed() && !wc.isAudioMuted()) { wc.setAudioMuted(true); tab.siteMuted = true; }
      } else {
        tab.muted = false;
        tab.siteMuted = false;
        if (wc && !wc.isDestroyed()) wc.setAudioMuted(false);
      }
    }
    onChange();
  }

  function noteClosed(url, title) {
    if (!url) return;
    closedTitles.delete(url); // re-adding moves it to the end, so the oldest are dropped first
    closedTitles.set(url, title || '');
    while (closedTitles.size > 100) closedTitles.delete(closedTitles.keys().next().value);
  }

  // Most recent first; `index` is the entry's place in main.js's closedTabs, for reopen().
  function closedEntries(closedTabs, limit = 25) {
    const out = [];
    for (let index = closedTabs.length - 1; index >= 0 && out.length < limit; index--) {
      const url = closedTabs[index];
      out.push({ index, url, title: closedTitles.get(url) || url });
    }
    return out;
  }

  return { wire, state, setMuted, siteOf, siteMuted, setSiteMuted, noteClosed, closedEntries };
}

module.exports = { create, hostOf };
