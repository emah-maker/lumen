// [uBlock mode] Lumen's own request rules while uBlock Origin Lite blocks (src/features/ublock-helper.js): each setting makes the rule it
// should and none it shouldn't, the rules are valid declarativeNetRequest shapes, and tracking-params.js's site patterns are the domains the
// rules name. Plain Node.
const os = require('os');
const fs = require('fs');
const path = require('path');
const H = require('../../src/features/ublock-helper');
const TP = require('../../src/features/tracking-params');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail ?? ''}`}`); if (!ok) failures++; };

const hints = { low: { 'Sec-CH-UA': '"Google Chrome";v="152"', 'Sec-CH-UA-Mobile': '?0' }, high: { 'Sec-CH-UA-Full-Version-List': '"Google Chrome";v="152.0.0.0"' } };
const all = { sendDoNotTrack: true, sendGpc: true, blockThirdPartyCookies: true, blockTrackingPings: true, stripTrackingParams: true };
const none = { sendDoNotTrack: false, sendGpc: false, blockThirdPartyCookies: false, blockTrackingPings: false, stripTrackingParams: false };
const headersSet = (rules) => rules.flatMap((r) => (r.action.requestHeaders || []).map((h) => `${h.operation}:${h.header.toLowerCase()}`));
const on = H.rulesFor(all, { hints, dark: true, tracking: TP.forRules() });
const off = H.rulesFor(none, { hints, dark: false, tracking: TP.forRules() });

check('ids are 1..n and unique (updateDynamicRules refuses repeats)', on.every((r, i) => r.id === i + 1));
check('every rule has a priority, an action and a condition', on.every((r) => r.priority >= 1 && r.action?.type && r.condition && typeof r.condition === 'object'));
check('Do Not Track and GPC: set when on', headersSet(on).includes('set:dnt') && headersSet(on).includes('set:sec-gpc'));
check('...and not sent when off', !headersSet(off).includes('set:dnt') && !headersSet(off).includes('set:sec-gpc'), headersSet(off).join());
check('Chrome\'s hints are sent either way (they are Lumen\'s identity, not a privacy choice)', ['set:sec-ch-ua', 'set:sec-ch-ua-mobile', 'set:sec-ch-ua-full-version-list'].every((h) => headersSet(off).includes(h)));
const low = on.filter((r) => r.action.requestHeaders?.some((h) => h.header === 'Sec-CH-UA'));
check('low-entropy hints: https, and http on this computer only (as Chrome sends client hints)', low.length === 2 && low[0].condition.urlFilter === '|https://' && new RegExp(low[1].condition.regexFilter).test('http://localhost:8080/') && !new RegExp(low[1].condition.regexFilter).test('http://example.com/') && new RegExp(low[1].condition.regexFilter).test('http://[::1]:3000/') && !new RegExp(low[1].condition.regexFilter).test('http://127a0b0c1/'), JSON.stringify(low.map((r) => r.condition)));
check('every header rule covers page loads too (a rule with no resourceTypes leaves main frames out)', on.filter((r) => r.action.type === 'modifyHeaders' && !r.action.requestHeaders.some((h) => h.operation === 'remove')).every((r) => r.condition.resourceTypes?.includes('main_frame')));
const high = on.filter((r) => r.action.requestHeaders?.some((h) => h.header === 'Sec-CH-UA-Full-Version-List'));
check('high-entropy hints go to Google and YouTube only', high.length === 2 && new RegExp(high[0].condition.regexFilter).test('https://accounts.google.com/x') && new RegExp(high[0].condition.regexFilter).test('https://www.google.de/') && !new RegExp(high[0].condition.regexFilter).test('https://example.com/') && high[1].condition.requestDomains.includes('youtube.com'));
const color = (rules) => rules.find((r) => r.action.requestHeaders?.some((h) => h.header === 'Sec-CH-Prefers-Color-Scheme'));
check('the color-scheme hint follows the theme', color(on).action.requestHeaders[0].value === '"dark"' && color(off).action.requestHeaders[0].value === '"light"');
const cookies = on.find((r) => r.action.requestHeaders?.some((h) => h.operation === 'remove' && h.header === 'cookie'));
check('third-party cookies: removed from third-party requests only, never from a page load', cookies && cookies.condition.domainType === 'thirdParty' && !cookies.condition.resourceTypes.includes('main_frame'));
check('...and left alone when that setting is off', !off.some((r) => r.action.requestHeaders?.some((h) => h.operation === 'remove')));
check('tracking pings: refused when on (the default), sent when off', on.some((r) => r.action.type === 'block' && r.condition.resourceTypes.join() === 'ping') && !off.some((r) => r.action.type === 'block'));
check('blockTrackingPings missing (an old profile) counts as on', H.rulesFor({}, {}).some((r) => r.action.type === 'block'));
const strip = on.filter((r) => r.action.type === 'redirect');
const everywhere = strip.find((r) => !r.condition.requestDomains);
check('tracking parameters: one rule for every site, one per site with its own share ids', Boolean(everywhere) && strip.length === 1 + TP.BY_HOST.length, strip.length);
check('...page loads only, GET only, sign-in and payment sites left alone', strip.every((r) => r.condition.resourceTypes.join() === 'main_frame' && r.condition.requestMethods.join() === 'get') && everywhere.condition.excludedRequestDomains.includes('accounts.google.com'));
const removed = everywhere.action.redirect.transform.queryTransform.removeParams;
check('...removes the ad-click ids and the common utm_ names', ['fbclid', 'gclid', 'msclkid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].every((p) => removed.includes(p)));
check('...every name it removes is one tracking-params.js removes too', removed.every((p) => TP.strip(`https://example.com/?${p}=1&keep=1`) === 'https://example.com/?keep=1'), removed.filter((p) => TP.strip(`https://example.com/?${p}=1&keep=1`) !== 'https://example.com/?keep=1').join());
check('...the prefixed names really carry the prefixes tracking-params.js knows', H.PREFIXED.every((p) => TP.PREFIXES.some((x) => p.startsWith(x))));
check('...and nothing when the setting is off', !off.some((r) => r.action.type === 'redirect'));
const rules = TP.forRules();
check('tracking-params: each site\'s domains match its pattern', rules.byHost.every((b, i) => b.domains.length && b.domains.every((d) => TP.BY_HOST[i][0].test(d))), JSON.stringify(rules.byHost.map((b) => b.domains)));
check('tracking-params: the left-alone domains match its pattern', rules.leaveDomains.every((d) => TP.LEAVE.test(d)));
check('declarativeNetRequest\'s regex limit: every regexFilter is short', on.every((r) => !r.condition.regexFilter || r.condition.regexFilter.length < 200));

// The extension's files, written into the profile (again only when they change)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ublock-helper-'));
try {
  const out = H.writeFiles(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  check('writeFiles: an MV3 extension with only declarativeNetRequest, named as Lumen\'s', manifest.manifest_version === 3 && manifest.permissions.join() === 'declarativeNetRequest' && manifest.name === H.NAME && !manifest.action && !manifest.background && !manifest.content_scripts);
  check('writeFiles: outside Extensions/ (start-up loads every folder there as the user\'s)', path.basename(out) === H.FOLDER && path.basename(path.dirname(out)) !== 'Extensions');
  const before = fs.statSync(path.join(out, 'manifest.json')).mtimeMs;
  H.writeFiles(dir);
  check('writeFiles: unchanged files are not written again', fs.statSync(path.join(out, 'manifest.json')).mtimeMs === before);
  check('isHelper: by its folder', H.isHelper({ path: out }, dir) && !H.isHelper({ path: path.join(dir, 'other') }, dir) && !H.isHelper(null, dir));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(failures ? `\n${failures} FAILED` : '\nAll uBlock helper checks passed.');
process.exit(failures ? 1 : 0);
