// "Site access" for an extension, as in Chrome's extension menu: on all sites (as installed) or only on the sites listed.
// A content script written for <all_urls> is injected into every page (BetterCampus's is a 5 MB script that costs ~50 ms
// on each one), and a webRequest listener sees every request; Electron has no switch to hold either back, so the
// restriction is made in the manifest the extension is loaded with: its sweeping patterns become the listed sites.
// Narrow patterns (a script written for one site) stay as they are. The original manifest is kept beside it, so "all
// sites" restores it exactly and an update (a new folder with its own manifest) is narrowed the same way when it loads.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORIGINAL = 'manifest.lumen-original.json';
const BROAD = /^(<all_urls>|\*:\/\/\*\/\*?|https?:\/\/\*\/\*?)$/;
const isBroad = (pattern) => typeof pattern === 'string' && BROAD.test(pattern);

// What the user typed ("instructure.com", "*.canvas.edu", "https://app.example.com/*") as match patterns, or null when it is no site.
function patternsOf(entry) {
  const text = String(entry || '').trim().toLowerCase();
  if (!text || text.length > 200) return null;
  if (/^(\*|https?):\/\//.test(text)) return /^(\*|https?):\/\/[a-z0-9*.-]+(:\d+)?\/\S*$/.test(text) && !isBroad(text) ? [text] : null; // (a full match pattern is kept as typed)
  const host = text.replace(/^\*\./, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/.test(host)) return null;
  return text.startsWith('*.') || !host.includes(':') ? [`*://*.${host}/*`] : [`*://${host}/*`]; // "example.com" covers its subdomains, as Chrome's "on specific sites" does
}

// The saved list, cleaned: a short array of the entries that are sites.
const cleanSites = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/)).map((s) => String(s).trim().toLowerCase()).filter((s) => s && patternsOf(s)))].slice(0, 50);

// The manifest with its sweeping content-script and host patterns swapped for the sites. A script that matched only
// sweeping patterns takes the sites; one with a mix keeps its narrow ones and gains the sites.
function narrowManifest(manifest, sites) {
  const patterns = [...new Set(cleanSites(sites).flatMap(patternsOf))];
  if (!patterns.length || !manifest || typeof manifest !== 'object') return manifest;
  const swap = (list) => {
    if (!Array.isArray(list) || !list.some(isBroad)) return list;
    return [...new Set([...list.filter((p) => !isBroad(p)), ...patterns])];
  };
  const out = { ...manifest };
  if (Array.isArray(out.content_scripts)) out.content_scripts = out.content_scripts.map((cs) => (cs && Array.isArray(cs.matches) ? { ...cs, matches: swap(cs.matches) } : cs));
  if (Array.isArray(out.host_permissions)) out.host_permissions = swap(out.host_permissions);
  if (Array.isArray(out.permissions) && out.permissions.some(isBroad)) out.permissions = swap(out.permissions); // (a manifest v2 extension lists its hosts among its permissions)
  return out;
}

// True when the manifest has anything sweeping to narrow (otherwise the setting would do nothing).
const hasBroadAccess = (manifest) => [
  ...(manifest?.host_permissions || []), ...(manifest?.permissions || []), ...(manifest?.content_scripts || []).flatMap((c) => c?.matches || []),
].some(isBroad);

// An extension's id comes from its `key` (Web Store installs have one); an unpacked extension without it has an id
// from its path, which a changed folder would change, so the setting is not offered for those.
function idOfKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const hex = crypto.createHash('sha256').update(key, 'base64').digest().subarray(0, 16).toString('hex');
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Sites worth suggesting for an extension we know the needs of (shown as "Use suggested sites"). Canvas schools host on
// instructure.com or their own domain, so the user adds theirs.
const SUGGESTED = {
  cndibmoanboadcifjkjbdpjgfedanolh: ['instructure.com', 'bettercampus.com', 'canvas.northeastern.edu'], // BetterCampus (was BetterCanvas)
};
const suggestedSites = (id) => SUGGESTED[id] || [];

// Writes (or restores) the manifest in `dir` for the saved sites, before the extension loads from it. Returns the manifest in effect.
async function applyToDir(dir, savedSites) {
  const file = path.join(dir, 'manifest.json');
  const original = path.join(dir, ORIGINAL);
  const hasOriginal = await fs.promises.stat(original).then(() => true, () => false);
  let source;
  try { source = JSON.parse((await fs.promises.readFile(hasOriginal ? original : file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
  const id = idOfKey(source.key);
  const sites = id ? cleanSites(savedSites?.[id]) : [];
  const narrowed = sites.length && hasBroadAccess(source) ? narrowManifest(source, sites) : null;
  if (narrowed) {
    if (!hasOriginal) await fs.promises.copyFile(file, original);
    await fs.promises.writeFile(file, JSON.stringify(narrowed));
    return narrowed;
  }
  if (hasOriginal) { await fs.promises.copyFile(original, file); await fs.promises.rm(original, { force: true }); }
  return source;
}

module.exports = { patternsOf, cleanSites, narrowManifest, hasBroadAccess, idOfKey, suggestedSites, applyToDir, isBroad, ORIGINAL };
