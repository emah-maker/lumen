// [uBlock mode] Lumen's own request rules while uBlock Origin Lite blocks on the main session (features/ublock-mode.js).
// There Lumen may add no session.webRequest listener (one turns every extension's rules off), so what its listeners did is done with
// declarativeNetRequest instead, from a small extension of Lumen's own that blocks nothing: Chrome's user-agent hints (Sec-CH-UA*: every
// secure request gets the low-entropy ones, Google's and YouTube's the rest, as Chrome sends after their Accept-CH), Do Not Track,
// Global Privacy Control, the color-scheme hint for Google, third-party cookies left off requests, tracking pings refused and tracking
// parameters taken off the addresses pages open at (features/tracking-params.js's list, as names: DNR can't match a prefix).
// The extension is written into the profile (an extension can't be loaded from inside app.asar) and hidden from the Extensions lists.
const fs = require('fs');
const path = require('path');

const NAME = 'Lumen request rules';
const FOLDER = 'lumen-request-rules'; // in the profile, next to Extensions/ (never inside it: start-up loads every folder there)
const MANIFEST = {
  manifest_version: 3,
  name: NAME,
  version: '1.0.0',
  description: 'Lumen’s own request headers and privacy rules while uBlock Origin Lite is the ad blocker. Blocks no ads.',
  permissions: ['declarativeNetRequest'],
  host_permissions: ['<all_urls>'],
};
const PAGE = '<!doctype html><meta charset="utf-8"><title>Lumen request rules</title>';

// Every request type (a rule with no resourceTypes leaves out main frames).
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];
const SUB_TYPES = ALL_TYPES.filter((t) => t !== 'main_frame');
const GOOGLE = '^https://([a-z0-9-]+\\.)*google\\.[a-z.]+/'; // (settings-backend.js GOOGLE_ORIGIN, as a URL)
const HINTED = ['youtube.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'ytimg.com'];
// tracking-params.js's prefixes, as the names in use (DNR's removeParams takes whole names).
const PREFIXED = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_reader', 'utm_referrer', 'utm_social', 'utm_social-type', 'utm_brand', 'utm_place', 'utm_pubreferrer', 'utm_swu', 'utm_viz_id', 'utm_cid', 'utm_creative_format', 'utm_marketing_tactic', 'utm_source_platform',
  'pk_campaign', 'pk_kwd', 'pk_source', 'pk_medium', 'mtm_campaign', 'mtm_kwd', 'mtm_source', 'mtm_medium', 'mtm_content', 'mtm_cid', 'mtm_group', 'mtm_placement'];

const set = (headers) => Object.entries(headers).map(([header, value]) => ({ header, operation: 'set', value: String(value) }));

// The rules for these settings. hints: { low: {Sec-CH-UA…}, high: {Sec-CH-UA-Full-Version-List…} }, dark: the theme pages are told.
function rulesFor(prefs, { hints, dark, tracking } = {}) {
  const rules = [];
  const add = (action, condition, priority = 1) => rules.push({ id: rules.length + 1, priority, action, condition });
  if (hints?.low && Object.keys(hints.low).length) { // (Chrome sends them to secure origins: https, and http on this computer)
    add({ type: 'modifyHeaders', requestHeaders: set(hints.low) }, { urlFilter: '|https://', resourceTypes: ALL_TYPES });
    add({ type: 'modifyHeaders', requestHeaders: set(hints.low) }, { regexFilter: '^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])[:/]', resourceTypes: ALL_TYPES });
  }
  if (hints?.high && Object.keys(hints.high).length) {
    add({ type: 'modifyHeaders', requestHeaders: set(hints.high) }, { regexFilter: GOOGLE, resourceTypes: ALL_TYPES });
    add({ type: 'modifyHeaders', requestHeaders: set(hints.high) }, { urlFilter: '|https://', requestDomains: HINTED, resourceTypes: ALL_TYPES });
  }
  add({ type: 'modifyHeaders', requestHeaders: set({ 'Sec-CH-Prefers-Color-Scheme': dark ? '"dark"' : '"light"' }) }, { regexFilter: GOOGLE, resourceTypes: ['main_frame', 'sub_frame'] });
  if (prefs.sendDoNotTrack) add({ type: 'modifyHeaders', requestHeaders: set({ DNT: '1' }) }, { resourceTypes: ALL_TYPES });
  if (prefs.sendGpc) add({ type: 'modifyHeaders', requestHeaders: set({ 'Sec-GPC': '1' }) }, { resourceTypes: ALL_TYPES });
  if (prefs.blockThirdPartyCookies) add({ type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'remove' }] }, { domainType: 'thirdParty', resourceTypes: SUB_TYPES });
  if (prefs.blockTrackingPings !== false) add({ type: 'block' }, { resourceTypes: ['ping'] });
  if (prefs.stripTrackingParams !== false && tracking) {
    const leave = tracking.leaveDomains;
    add({ type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [...tracking.everywhere, ...PREFIXED] } } } }, { resourceTypes: ['main_frame'], excludedRequestDomains: leave, requestMethods: ['get'] }, 2);
    for (const { domains, names } of tracking.byHost) {
      add({ type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [...tracking.everywhere, ...PREFIXED, ...names] } } } }, { resourceTypes: ['main_frame'], requestDomains: domains, requestMethods: ['get'] }, 3);
    }
  }
  return rules;
}

// Writes the extension's two files into the profile (again when they changed) and returns its folder.
function writeFiles(userData) {
  const dir = path.join(userData, FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, text) => { const file = path.join(dir, name); try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* not there yet */ } fs.writeFileSync(file, text); };
  put('manifest.json', JSON.stringify(MANIFEST, null, 2));
  put('rules.html', PAGE);
  return dir;
}

// This extension, by its folder (an unpacked extension's id comes from its path).
const isHelper = (ext, userData) => Boolean(ext?.path) && path.resolve(ext.path) === path.resolve(userData, FOLDER);

module.exports = { NAME, FOLDER, MANIFEST, ALL_TYPES, PREFIXED, rulesFor, writeFiles, isHelper };
