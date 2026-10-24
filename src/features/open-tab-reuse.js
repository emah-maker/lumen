// Fewer tabs: when the AI's open_tab does not need to open one (pure; ai/agent.js wires it in, test/units/open-tab-reuse-units.js covers it).
//   urlKey(raw)       one address for "the same page": scheme and host lowercased, the #fragment, tracking parameters, a trailing slash,
//                     "www." and a default port dropped; the other parameters kept (a different query is a different page)
//   wantsNewTab(text) the user's own words ask for a tab ("in a new tab", "open it in another tab"): open_tab then always opens one
//   decide(...)       'open' | 'existing' (that page is already open in a tab: say so, open nothing) | 'reuse-own' (the chat's own idle AI
//                     tab loads it instead of a new one)
// Only the sidebar chat's own tab is ever navigated or worked in; a tab the user has open is never moved, only pointed at.

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|msclkid|mc_eid|igshid|ref_src)$/i;

function urlKey(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    let path = u.pathname.replace(/\/+$/, '');
    try { path = decodeURIComponent(path); } catch { /* keep as is */ }
    const port = u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) ? `:${u.port}` : '';
    const search = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${port}${path}${search ? `?${search}` : ''}`.toLowerCase();
  } catch { return ''; }
}

const NEW_TAB = /\b(?:(?:in|into|on|as)\s+(?:a\s+|an\s+|the\s+)?(?:new|another|separate|different|extra|second|fresh)\s+tabs?|(?:new|another|separate|extra)\s+tabs?|(?:in|into)\s+(?:a\s+)?tabs?|side[- ]by[- ]side)\b/i;
function wantsNewTab(text) { return typeof text === 'string' && text.length < 4000 && NEW_TAB.test(text); }

// url: the address to open (already normalized by navUrl). tabs: the window's tabs the AI may see ({ id, url, off?, busy? }: off = AI turned
// off there, busy = another chat's run works in it). own: the chat's own AI tab ({ id, alive, inFront, loading, audible }) or null.
// explicit: the user asked for a new tab. show / keep: the call wants the tab in front / left open afterwards.
function decide({ url, tabs = [], own = null, explicit = false, show = false, keep = false } = {}) {
  if (explicit) return { action: 'open' };
  const key = urlKey(url);
  if (key) {
    const same = tabs.filter((t) => !t.off && !t.busy && urlKey(t.url) === key);
    const mine = own && same.find((t) => t.id === own.id);
    if (mine) return { action: 'existing', id: mine.id, mine: true };
    if (same.length) return { action: 'existing', id: same[0].id, mine: false };
  }
  // The chat's own tab, idle (loaded, quiet, not in front of the user), carries on instead of a second one. A call that wants a tab in front
  // or kept open for the user gets a tab of its own.
  if (own && own.alive && !show && !keep && !own.inFront && !own.loading && !own.audible) return { action: 'reuse-own', id: own.id };
  return { action: 'open' };
}

module.exports = { urlKey, wantsNewTab, decide };
