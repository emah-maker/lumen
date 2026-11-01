// The shim that gives an extension's content scripts Lumen's alert/confirm/prompt (browser/extension-dialogs.js): it goes
// first, reaches only the sites the extension's own scripts already reach (no new access shows in its permissions), is
// replaced rather than stacked on a reload, and an ask is accepted only with the key made for a loaded extension.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { withShim, reachOf, shimSource, createRegistry, parseAsk, SHIM } = require('../../src/browser/extension-dialogs');
const { extensionPermissionLines } = require('../../src/browser/extension-permissions');

const pass = (name) => console.log(`PASS  ${name}`);

// 1Password-shaped (manifest v3, content scripts on every site, scripting): the shim first, on <all_urls>.
const op = { manifest_version: 3, name: '1Password', permissions: ['scripting', 'storage'], host_permissions: ['<all_urls>'], content_scripts: [{ matches: ['<all_urls>'], js: ['inject.js'], all_frames: true }] };
const shimmed = withShim(op);
assert.deepStrictEqual(shimmed.content_scripts[0], { matches: ['<all_urls>'], js: [SHIM], run_at: 'document_start', all_frames: true, match_about_blank: true });
assert.deepStrictEqual(shimmed.content_scripts.slice(1), op.content_scripts, "the extension's own scripts follow, unchanged");
assert.deepStrictEqual(extensionPermissionLines(shimmed), extensionPermissionLines(op), 'the permissions shown are the same');
pass('a content-script extension gets the shim first, with nothing new in its permissions');

assert.deepStrictEqual(withShim(withShim(op)).content_scripts.filter((cs) => cs.js.includes(SHIM)).length, 1, 'loaded again: one shim');
pass('a second load replaces the shim entry instead of adding another');

const narrow = { manifest_version: 3, content_scripts: [{ matches: ['https://*.instructure.com/*'], js: ['a.js'] }], host_permissions: ['https://api.example.com/*'] };
assert.deepStrictEqual(reachOf(narrow), ['https://*.instructure.com/*'], 'host permissions without scripting add nothing');
assert.deepStrictEqual(reachOf({ ...narrow, permissions: ['scripting'] }), ['https://*.instructure.com/*', 'https://api.example.com/*'], 'with scripting they count');
assert.deepStrictEqual(reachOf({ manifest_version: 2, permissions: ['tabs', 'http://*/*', 'storage'] }), ['http://*/*'], 'manifest v2 host permissions count');
pass('the shim reaches only the sites the extension can already run scripts on');

// Site access "all sites except" (browser/extension-sites.js) excludes a site from every script: the shim stays off it too,
// but only from what all of them exclude (a site one script still runs on keeps the shim).
const msft = '*://*.login.microsoftonline.com/*';
const kept = { ...op, content_scripts: [{ matches: ['<all_urls>'], exclude_matches: [msft], js: ['a.js'] }, { matches: ['https://*.x.com/*'], exclude_matches: ['https://bank.com/*', msft], js: ['b.js'] }] };
assert.deepStrictEqual(withShim(kept).content_scripts[0].exclude_matches, [msft], 'the site every script excludes');
assert.deepStrictEqual(withShim(withShim(kept)).content_scripts[0].exclude_matches, [msft], 'loaded again: the same');
assert.ok(!('exclude_matches' in withShim({ ...kept, content_scripts: [kept.content_scripts[0], { matches: ['<all_urls>'], js: ['c.js'] }] }).content_scripts[0]), 'one script without it: no exclusion');
pass('the shim stays off a site every one of the extension\'s scripts is kept off');

const none = { manifest_version: 3, name: 'Theme', permissions: ['storage'] };
assert.deepStrictEqual(withShim(none), none, 'an extension that runs nothing on pages is left alone');
const stale = { ...none, content_scripts: [{ matches: ['<all_urls>'], js: [SHIM] }] };
assert.deepStrictEqual(withShim(stale).content_scripts, [], 'a leftover shim entry (its scripts were removed) goes');
pass('no shim for an extension without page scripts');

// The shim itself: replaces the three in its world and answers from the ask; falls back to the native call when the ask fails.
const run = (status, body) => {
  const calls = [];
  const sent = [];
  class XMLHttpRequest { open(m, u, a) { sent.push({ m, u, a }); } setRequestHeader() {} send(b) { sent.push(JSON.parse(b)); this.status = status; this.responseText = body; } }
  const window = { alert: (m) => calls.push(['native alert', m]), confirm: (m) => { calls.push(['native confirm', m]); return 'native'; }, prompt: () => 'native' };
  vm.runInNewContext(shimSource('k1'), { window, XMLHttpRequest, location: { href: 'https://site.example/' } });
  return { window, calls, sent };
};
{
  const { window, sent, calls } = run(200, JSON.stringify({ accept: true }));
  assert.strictEqual(window.confirm('Paste?'), true);
  assert.deepStrictEqual(sent[0], { m: 'POST', u: 'lumen-dialog://ask/', a: false }, 'a synchronous request');
  assert.deepStrictEqual(sent[1], { key: 'k1', kind: 'confirm', message: 'Paste?', value: '', frame: 'https://site.example/' });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(window.confirm.name, 'confirm');
}
{
  const { window } = run(200, JSON.stringify({ accept: true, value: 'Grace' }));
  assert.strictEqual(window.prompt('Name?', 'Ada'), 'Grace');
  assert.strictEqual(run(200, JSON.stringify({ accept: false })).window.prompt('Name?'), null);
}
{
  const { window, calls } = run(403, 'null');
  assert.strictEqual(window.confirm('Paste?'), 'native', 'refused: the native confirm still asks');
  assert.deepStrictEqual(calls, [['native confirm', 'Paste?']]);
}
pass('the shim answers from Lumen, and falls back to the native dialog when Lumen cannot answer');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ext-dialogs-units-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), String.fromCharCode(0xfeff) + JSON.stringify(op));
  const registry = createRegistry();
  await registry.prepare(dir);
  const key = fs.readFileSync(path.join(dir, SHIM), 'utf8').match(/key: "([^"]+)"/)[1];
  assert.ok(key.length >= 30, 'a long random key');
  assert.strictEqual(parseAsk(JSON.stringify({ key, kind: 'confirm', message: 'Paste?' }), registry), null, 'not until the extension has loaded');
  registry.loaded(dir, { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', name: '1Password' });
  assert.deepStrictEqual(parseAsk(JSON.stringify({ key, kind: 'confirm', message: 'Paste?', frame: 'https://site.example/' }), registry), { kind: 'confirm', message: 'Paste?', value: '', frame: 'https://site.example/', extension: { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', name: '1Password' } });
  assert.strictEqual(parseAsk(JSON.stringify({ key: 'guess', kind: 'confirm' }), registry), null, 'a made-up key');
  assert.strictEqual(parseAsk('not json', registry), null);
  await registry.prepare(dir);
  assert.strictEqual(parseAsk(JSON.stringify({ key, kind: 'alert' }), registry), null, "a reload's new key retires the old one");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(onDisk.content_scripts.filter((cs) => cs.js.includes(SHIM)).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  pass('asks are accepted only with the key of a loaded extension; a reload makes a new one');
  console.log('extension-dialogs-units: ok');
})().catch((err) => { console.error(err); process.exit(1); });
