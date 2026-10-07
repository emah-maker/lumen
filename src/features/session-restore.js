// Session restore's pure decisions (main.js restoreTabsFrom does the Electron part). Restoring a saved session makes a
// real page (a renderer process and its memory, a network load) only for the tab that was in front; every other
// saved tab comes back as a placeholder (title, icon and address, no WebContents) that loads when it is first opened.
// `neighbors` lets a caller also load tabs next to the front one (0 today: each is ~100 MB and a request burst at startup).

// The saved indices that get a page now: the front tab (clamped into range), and `neighbors` on each side.
function liveIndices(count, active, { neighbors = 0 } = {}) {
  const n = Math.max(0, Math.floor(Number(count)) || 0);
  if (!n) return new Set();
  const front = Math.min(Math.max(0, Math.floor(Number(active)) || 0), n - 1);
  const live = new Set([front]);
  const extra = Math.max(0, Math.floor(Number(neighbors)) || 0);
  for (let d = 1; d <= extra; d++) { if (front - d >= 0) live.add(front - d); if (front + d < n) live.add(front + d); }
  return live;
}

module.exports = { liveIndices };
