// The address bar's decisions that live in the main process (main.js suggest:query, nav:go), kept pure for
// test/units/omnibox-units.js. They follow Chrome: what is typed is never rewritten, a URL opens and anything else is
// searched exactly as typed, and only a site the user has typed before is completed in place.
const TLDS = require('./tlds');
const { resolveInput, searchUrlFor } = require('./search');

// What Enter does with `text`: { kind: 'url', url } or { kind: 'search', url } (the engine's results page).
function classify(text, engineId) {
  const url = resolveInput(text, engineId);
  return { kind: url === searchUrlFor(engineId, String(text || '').trim()) ? 'search' : 'url', url };
}

// The host a visit counts for, without "www." ("www.github.com" and "github.com" are one site), or '' for a non-web URL.
function siteOf(url) {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.host.toLowerCase().replace(/^www\./, '') : '';
  } catch { return ''; }
}

const bare = (url) => String(url).replace(/^https?:\/\/(www\.)?/i, '');

// The inline completion for `typed` from History entries ({ url, title, visits, last, typed }), or null. Only a site the user
// has typed into the address bar before (an entry of that host with typed > 0) is offered, as Chrome does: a page only
// clicked to, an imported page or a built-in suggestion never fills the field. Without a "/" the site's host is completed;
// with one, a visited address on that site. `text` is the field's whole value (what was typed, then the completion), `url`
// where Enter goes while the completion is still showing.
function inlineCompletion(typed, entries) {
  const value = String(typed || '');
  if (!value || /\s/.test(value) || value.length > 200) return null;
  const lead = /^(https?:\/\/)?(www\.)?/i.exec(value)[0];
  const rest = value.slice(lead.length);
  if (!rest) return null;
  const want = rest.toLowerCase();
  const list = [...(entries || [])]; // (History's values() is an iterator: read twice below)
  const typedSites = new Map(); // site -> times typed
  for (const e of list) {
    const site = e && e.typed > 0 ? siteOf(e.url) : '';
    if (site) typedSites.set(site, (typedSites.get(site) || 0) + e.typed);
  }
  if (!typedSites.size) return null;
  const byText = new Map(); // completion -> { score, url }
  for (const e of list) {
    const site = e ? siteOf(e.url) : '';
    if (!site || !typedSites.has(site) || e.url.length > 300) continue;
    let host;
    try { host = new URL(e.url).host; } catch { continue; }
    const shownHost = host.replace(/^www\./i, '');
    const candidate = rest.includes('/') ? bare(e.url).replace(/\/$/, '') : shownHost;
    if (candidate.length <= rest.length || !candidate.toLowerCase().startsWith(want)) continue;
    const url = rest.includes('/') ? e.url : `${new URL(e.url).protocol}//${host}/`;
    const score = (rest.includes('/') ? e.typed || 0 : typedSites.get(site)) * 1e9 + (e.visits || 0) * 1e3 + (e.last || 0) / 1e13 - candidate.length / 1e4;
    const had = byText.get(candidate.toLowerCase());
    if (!had) byText.set(candidate.toLowerCase(), { candidate, url, score });
    else { had.score += e.visits || 0; if (score > had.score) had.url = url; }
  }
  let best = null;
  for (const c of byText.values()) if (!best || c.score > best.score || (c.score === best.score && c.candidate.length < best.candidate.length)) best = c;
  if (!best) return null;
  return { text: value + best.candidate.slice(rest.length), url: best.url };
}

// Ctrl+Enter (Chrome): "example" opens www.example.com. "www." goes in front unless it is there, ".com" goes at the end of
// the host unless it already ends in a real top-level domain; a path, port or query stays. Anything with a space or a
// scheme is left as it is.
function ctrlEnterInput(text) {
  const value = String(text || '').trim();
  if (!value || /\s/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  const m = /^([^/?#:]+)(:\d+)?(.*)$/.exec(value);
  if (!m) return value;
  let host = m[1].replace(/\.$/, '');
  const tld = host.includes('.') ? host.slice(host.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!TLDS.has(tld) || host.split('.').length < 2 || /^www\.[^.]+$/i.test(host)) host += '.com';
  if (!/^www\./i.test(host)) host = `www.${host}`;
  return host + (m[2] || '') + m[3];
}

module.exports = { classify, siteOf, inlineCompletion, ctrlEnterInput };
