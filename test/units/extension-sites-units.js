// Extension "Site access" (browser/extension-sites.js), plain Node: which sites a typed entry means, how a manifest is narrowed, and that
// the manifest on disk is written for the saved sites and restored exactly. No Electron, no network.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const X = require('../../src/browser/extension-sites');
const mp = require('../../src/browser/match-pattern');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const bare = X.patternsOf('instructure.com');
  check('a bare domain covers its subdomains too', same(bare, ['*://*.instructure.com/*']) && mp.matchesUrl(bare[0], 'https://x.instructure.com/courses') && mp.matchesUrl(bare[0], 'https://instructure.com/'), bare);
  check('a "*." entry and a full match pattern are accepted', same(X.patternsOf('*.canvas.edu'), ['*://*.canvas.edu/*']) && same(X.patternsOf('https://app.example.com/*'), ['https://app.example.com/*']), '');
  check('an entry that means every site, or is no site, is refused', X.patternsOf('<all_urls>') === null && X.patternsOf('*://*/*') === null && X.patternsOf('https://*/*') === null && X.patternsOf('not a site') === null && X.patternsOf('') === null && X.patternsOf('a'.repeat(300)) === null, '');
  const cleaned = X.cleanSites('Instructure.com, school.edu  instructure.com;nope!');
  check('the saved list is cleaned (typed text split on commas and spaces, deduped, bad entries dropped)', same(cleaned, ['instructure.com', 'school.edu']) && same(X.cleanSites(null), []), cleaned);

  const manifest = {
    manifest_version: 3,
    permissions: ['storage', 'tabs'],
    host_permissions: ['<all_urls>'],
    content_scripts: [
      { matches: ['<all_urls>'], js: ['all.js'] },
      { matches: ['https://calendar.google.com/*'], js: ['cal.js'] },
      { matches: ['https://*/*', 'http://localhost/*'], js: ['web.js'] },
    ],
  };
  const n = X.narrowManifest(manifest, ['instructure.com']);
  check('narrowing: sweeping content scripts and hosts become the sites', same(n.content_scripts[0].matches, ['*://*.instructure.com/*']) && same(n.host_permissions, ['*://*.instructure.com/*']), JSON.stringify(n));
  check('narrowing: a script for one site is left alone; a mixed one keeps its narrow patterns and gains the sites', same(n.content_scripts[1].matches, ['https://calendar.google.com/*']) && same(n.content_scripts[2].matches, ['http://localhost/*', '*://*.instructure.com/*']), JSON.stringify(n.content_scripts));
  check('narrowing: permissions that are not hosts, and the input, are untouched', same(n.permissions, ['storage', 'tabs']) && manifest.content_scripts[0].matches[0] === '<all_urls>' && n.manifest_version === 3, '');
  const script = { content_scripts: [n.content_scripts[0]] };
  check('narrowing: a page the extension used to run on no longer matches, a listed one does', !mp.contentScriptsApply(script, 'https://news.com/a') && mp.contentScriptsApply(script, 'https://school.instructure.com/courses/1'), '');
  check('narrowing: no usable sites leaves the manifest as it is', X.narrowManifest(manifest, []) === manifest && X.narrowManifest(manifest, ['<all_urls>']) === manifest, '');
  check('broad access is told from narrow', X.hasBroadAccess(manifest) && !X.hasBroadAccess(n) && !X.hasBroadAccess({ content_scripts: [{ matches: ['https://a.com/*'] }] }), '');
  check('a manifest v2 extension lists hosts among its permissions: those are narrowed too', same(X.narrowManifest({ permissions: ['tabs', '<all_urls>'] }, ['a.com']).permissions, ['tabs', '*://*.a.com/*']), '');

  // The id comes from the key as Chrome does it (the 32 letters the installer reports); an extension without a key gets no setting.
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const id = X.idOfKey(key);
  check('the id is 32 letters a to p, and none without a key', /^[a-p]{32}$/.test(id) && X.idOfKey(undefined) === null && X.idOfKey('') === null, id);
  check('BetterCampus has suggested sites (no school\'s own domain); others have none', same(X.suggestedSites('cndibmoanboadcifjkjbdpjgfedanolh'), ['instructure.com', 'bettercampus.com']) && same(X.suggestedSites(id), []), '');

  // ---- all sites except these
  check('"www." is the site itself: www.example.com covers example.com and its subdomains', same(X.patternsOf('www.example.com'), ['*://*.example.com/*']) && same(X.patternsOf('*.www.example.com'), ['*://*.example.com/*']) && same(X.patternsOf('www.com'), ['*://*.www.com/*']), JSON.stringify([X.patternsOf('www.example.com'), X.patternsOf('www.com')]));
  check('saved values: a list is "only these", { except } is "all except these", nothing usable is all sites',
    same(X.accessOf(['a.com']), { mode: 'only', sites: ['a.com'] }) && same(X.accessOf({ except: 'b.com, nope!' }), { mode: 'except', sites: ['b.com'] })
    && same(X.accessOf(undefined), { mode: 'all', sites: [] }) && same(X.accessOf({ except: [] }), { mode: 'all', sites: [] }) && same(X.accessOf([]), { mode: 'all', sites: [] }), '');
  check('what is saved for a mode', same(X.savedOf('except', ['B.com']), { except: ['b.com'] }) && same(X.savedOf('only', ['a.com']), ['a.com']) && same(X.savedOf(undefined, 'a.com'), ['a.com']) && X.savedOf('except', []) === null && X.savedOf('only', ['<all_urls>']) === null, '');
  const withExcludes = { ...manifest, content_scripts: [...manifest.content_scripts, { matches: ['<all_urls>'], exclude_matches: ['https://bank.com/*'], js: ['x.js'] }, { js: ['no-matches.js'] }] };
  const ex = X.excludeManifest(withExcludes, ['login.microsoftonline.com']);
  const msft = '*://*.login.microsoftonline.com/*';
  check('except: every content script (sweeping or narrow) gets the site in exclude_matches; matches are untouched',
    ex.content_scripts.slice(0, 3).every((cs, i) => same(cs.exclude_matches, [msft]) && same(cs.matches, withExcludes.content_scripts[i].matches)), JSON.stringify(ex.content_scripts));
  check('except: a script\'s own exclude_matches are kept, the site added after them', same(ex.content_scripts[3].exclude_matches, ['https://bank.com/*', msft]), JSON.stringify(ex.content_scripts[3]));
  check('except: an entry without matches, host permissions and the input are left as they are', same(ex.content_scripts[4], { js: ['no-matches.js'] }) && same(ex.host_permissions, ['<all_urls>']) && !('exclude_matches' in withExcludes.content_scripts[0]), JSON.stringify(ex));
  const exPage = { content_scripts: ex.content_scripts.slice(0, 1) };
  check('except: the listed site and its subdomains get no script, every other site still does',
    !mp.contentScriptsApply(exPage, 'https://login.microsoftonline.com/common/oauth2') && !mp.contentScriptsApply(exPage, 'https://x.login.microsoftonline.com/') && mp.contentScriptsApply(exPage, 'https://northeastern.instructure.com/courses') && mp.contentScriptsApply(exPage, 'https://microsoftonline.com/'), '');
  const exWww = X.excludeManifest(manifest, ['www.bank.com']);
  check('except: "www.bank.com" keeps it off bank.com and www.bank.com', !mp.contentScriptsApply({ content_scripts: exWww.content_scripts.slice(0, 1) }, 'https://bank.com/') && !mp.contentScriptsApply({ content_scripts: exWww.content_scripts.slice(0, 1) }, 'https://www.bank.com/login'), JSON.stringify(exWww.content_scripts[0]));
  check('except: adding the same site twice does not repeat it, and no sites leaves the manifest as it is', same(X.excludeManifest(ex, ['login.microsoftonline.com']).content_scripts[0].exclude_matches, [msft]) && X.excludeManifest(manifest, []) === manifest && X.excludeManifest({ permissions: ['<all_urls>'] }, ['a.com']).content_scripts === undefined, '');

  // ---- on disk
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sites-'));
  const file = path.join(dir, 'manifest.json');
  const shipped = JSON.stringify({ ...manifest, key, name: 'T', version: '1' }, null, 2);
  fs.writeFileSync(file, shipped);
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  await X.applyToDir(dir, {});
  check('nothing saved: the manifest is not touched', fs.readFileSync(file, 'utf8') === shipped && !fs.existsSync(path.join(dir, X.ORIGINAL)), '');
  await X.applyToDir(dir, { [id]: ['instructure.com'] });
  check('saved sites: the manifest on disk is narrowed and the original kept beside it', same(read().content_scripts[0].matches, ['*://*.instructure.com/*']) && fs.existsSync(path.join(dir, X.ORIGINAL)) && read().key === key, JSON.stringify(read()).slice(0, 300));
  await X.applyToDir(dir, { [id]: ['instructure.com', 'school.edu'] });
  check('changed sites: narrowed from the original, not from the narrowed copy', same(read().content_scripts[0].matches, ['*://*.instructure.com/*', '*://*.school.edu/*']), JSON.stringify(read().content_scripts[0]));
  await X.applyToDir(dir, { other: ['x.com'] });
  check('all sites again: the shipped manifest is restored byte for byte', fs.readFileSync(file, 'utf8') === shipped, fs.readFileSync(file, 'utf8').slice(0, 200));
  check('all sites again: no original is left behind', !fs.existsSync(path.join(dir, X.ORIGINAL)), '');
  await X.applyToDir(dir, { [id]: { except: ['login.microsoftonline.com'] } });
  check('only these -> all except: rewritten from the original (sweeping patterns back, the site excluded)', same(read().content_scripts[0].matches, ['<all_urls>']) && same(read().content_scripts[0].exclude_matches, ['*://*.login.microsoftonline.com/*']) && same(read().host_permissions, ['<all_urls>']) && fs.existsSync(path.join(dir, X.ORIGINAL)), JSON.stringify(read()).slice(0, 300));
  await X.applyToDir(dir, { [id]: ['instructure.com'] });
  check('all except -> only these: no exclusion is left over', same(read().content_scripts[0].matches, ['*://*.instructure.com/*']) && !('exclude_matches' in read().content_scripts[0]), JSON.stringify(read().content_scripts[0]));
  await X.applyToDir(dir, { [id]: { except: ['login.microsoftonline.com'] } });
  await X.applyToDir(dir, {});
  check('all except -> all sites: the shipped manifest is restored byte for byte, no original left', fs.readFileSync(file, 'utf8') === shipped && !fs.existsSync(path.join(dir, X.ORIGINAL)), fs.readFileSync(file, 'utf8').slice(0, 200));
  // An update lands as a new folder with its own manifest: it is narrowed the same way when it loads.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sites-'));
  fs.writeFileSync(path.join(dir2, 'manifest.json'), JSON.stringify({ ...manifest, key, version: '2' }));
  await X.applyToDir(dir2, { [id]: ['instructure.com'] });
  const updated = JSON.parse(fs.readFileSync(path.join(dir2, 'manifest.json'), 'utf8'));
  check('an updated version is narrowed when it loads', updated.version === '2' && same(updated.host_permissions, ['*://*.instructure.com/*']), JSON.stringify(updated).slice(0, 300));
  // No key (an unpacked extension): its id would change with its folder, so nothing is written.
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sites-'));
  fs.writeFileSync(path.join(dir3, 'manifest.json'), JSON.stringify(manifest));
  await X.applyToDir(dir3, { [id]: ['instructure.com'] });
  check('no key: left alone', same(JSON.parse(fs.readFileSync(path.join(dir3, 'manifest.json'), 'utf8')), manifest), '');
  check('a missing or broken manifest does not throw', (await X.applyToDir(path.join(dir, 'nope'), {})) === null, '');

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
