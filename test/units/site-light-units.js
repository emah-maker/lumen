// Sites with a half-built dark mode get the light page in a dark theme: found by measuring the page (browser/half-dark.js), applied by the
// override in browser/chrome-identity.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { schemeFor, watcher } = require('../../src/browser/chrome-identity');
const { mixed, halfDark, lightIsBetter, trial, hostOf, createStore, KEEP_FOR } = require('../../src/browser/half-dark');

// ---- the override for a site found half dark
const isLight = (u) => hostOf(u) === 'www.halfdark.test';
assert.strictEqual(schemeFor('https://www.halfdark.test/', true, isLight), 'light', 'dark theme: told light');
assert.strictEqual(schemeFor('https://www.halfdark.test/', false, isLight), '', 'light theme: nothing to change');
assert.strictEqual(schemeFor('https://example.com/', true, isLight), '', 'every other site follows the theme');

// ---- hostOf: web pages only
assert.strictEqual(hostOf('https://WWW.Example.com/a?b'), 'www.example.com');
assert.strictEqual(hostOf('file:///C:/x.html'), '');
assert.strictEqual(hostOf('not a url'), '');

// ---- the measure. A Glassdoor-like page told dark: dark sections, white cards, and on some of them light text nobody can read.
const glassdoor = { dark: true, text: 2400, unreadable: 300, onLight: 1200, onDark: 900 };
const mixedOnly = { dark: true, text: 2000, unreadable: 0, onLight: 800, onDark: 1000 }; // readable, but dark sections over white cards
const fullDark = { dark: true, text: 3500, unreadable: 0, onLight: 7, onDark: 3490 }; // (github.com's dark page, measured)
const lightOnly = { dark: true, text: 4400, unreadable: 0, onLight: 4400, onDark: 0 }; // (a site with no dark mode at all)
const lightPage = { dark: false, text: 2400, unreadable: 0, onLight: 2200, onDark: 120 };
assert.ok(Math.abs(mixed(mixedOnly) - 0.4) < 1e-9);
assert.strictEqual(mixed(fullDark) < 0.01, true);
assert.strictEqual(mixed({ text: 0 }), 0);
assert.strictEqual(halfDark(glassdoor), true, 'unreadable text on white cards: half dark');
assert.strictEqual(halfDark(mixedOnly), true, 'dark sections over white cards: half dark');
assert.strictEqual(halfDark(fullDark), false, 'a whole dark page is not');
assert.strictEqual(halfDark(lightOnly), false, 'a page with no dark mode is not');
assert.strictEqual(halfDark({ ...glassdoor, dark: false }), false, 'a page not told dark is not measured as such');
assert.strictEqual(halfDark({ dark: true, text: 150, unreadable: 150, onLight: 150, onDark: 0 }), false, 'too little text to tell');
assert.strictEqual(halfDark({ dark: true, text: 10000, unreadable: 130, onLight: 10000, onDark: 0 }), false, 'a few unreadable lines in a long page are not');
assert.strictEqual(halfDark(null), false);

assert.strictEqual(lightIsBetter(glassdoor, lightPage), true, 'the light page reads and is even: kept');
assert.strictEqual(lightIsBetter(mixedOnly, lightPage), true);
assert.strictEqual(lightIsBetter(mixedOnly, { ...mixedOnly, dark: false }), false, 'a page that ignores the scheme looks the same: not kept');
assert.strictEqual(lightIsBetter(glassdoor, { ...lightPage, unreadable: 200 }), false, 'still unreadable in light: not kept');
assert.strictEqual(lightIsBetter(mixedOnly, { dark: false, text: 2000, unreadable: 0, onLight: 1100, onDark: 700 }), false, 'still half dark and half light: not kept');
assert.strictEqual(lightIsBetter(glassdoor, { dark: false, text: 0, unreadable: 0, onLight: 0, onDark: 0 }), false, 'nothing measured: not kept');
assert.strictEqual(lightIsBetter(glassdoor, null), false);

(async () => {
  // ---- the watcher sends the override when the site test says so, and clears it
  const sent = [];
  let dark = true;
  const update = watcher(async (method, params) => { sent.push([method, params]); }, () => dark, isLight);
  assert.strictEqual(await update('https://example.com/'), false, 'a site that follows the theme: no command');
  assert.strictEqual(await update('https://www.halfdark.test/'), true);
  assert.deepStrictEqual(sent.pop(), ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }]);
  assert.strictEqual(await update('https://www.halfdark.test/jobs'), false, 'still on the site: nothing sent again');
  assert.strictEqual(await update('https://example.com/'), true, 'leaving it clears the override');
  assert.deepStrictEqual(sent.pop(), ['Emulation.setEmulatedMedia', { features: [] }]);
  await update('https://www.halfdark.test/');
  dark = false;
  assert.strictEqual(await update('https://www.halfdark.test/'), true, 'the theme turned light: the override goes');
  assert.deepStrictEqual(sent.pop(), ['Emulation.setEmulatedMedia', { features: [] }]);
  const failing = watcher(async () => { throw new Error('detached'); }, () => true, isLight);
  assert.strictEqual(await failing('https://www.halfdark.test/'), false, 'a debugger that is gone is not an error');

  // ---- the store: trying, keeping, dropping, saved across a restart
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-half-dark-'));
  try {
    const file = path.join(dir, 'half-dark-sites.json');
    const a = createStore({ file });
    const u = 'https://www.halfdark.test/Reviews';
    assert.strictEqual(a.worthTrying(u), true);
    assert.strictEqual(a.isLight(u), false);
    a.try(u);
    assert.strictEqual(a.isLight(u), true, 'told light while its light page is measured');
    assert.strictEqual(a.worthTrying(u), false, 'not measured twice at once');
    assert.strictEqual(a.known(u), false, 'not kept yet');
    a.keep('https://www.halfdark.test/');
    await a.saved();
    assert.strictEqual(a.known(u), true);
    assert.strictEqual(a.isLight('https://www.halfdark.test/Job'), true, 'the whole host');
    assert.strictEqual(a.isLight('https://other.halfdark.test/'), false, 'another host of the same site is measured on its own');
    const savedFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual([savedFile.version, Object.keys(savedFile.sites)], [2, ['www.halfdark.test']]);
    assert.deepStrictEqual(createStore({ file }).hosts(), ['www.halfdark.test'], 'kept after a restart');

    const v = 'https://even.test/';
    a.try(v);
    a.drop(v);
    assert.strictEqual(a.isLight(v), false, 'dropped: the theme again');
    assert.strictEqual(a.worthTrying(v), false, 'the light page was no better: not tried again this run');
    assert.strictEqual(createStore({ file }).worthTrying(v), true, '...but after a restart it is');
    const w = 'https://moved.test/';
    a.try(w);
    a.drop(w, { measured: false });
    assert.strictEqual(a.worthTrying(w), true, 'the tab moved on before the light page was measured: tried again later');
    assert.deepStrictEqual(createStore({ file }).hosts(), ['www.halfdark.test'], 'only kept hosts are saved');

    // a list saved before the third reading: left unread, so a site saved from one reading (youtube.com) follows the theme and is measured again
    fs.writeFileSync(file, JSON.stringify({ hosts: ['www.youtube.com'] }));
    const old = createStore({ file });
    assert.strictEqual(old.isLight('https://www.youtube.com/'), false, 'an old list: the theme again');
    assert.strictEqual(old.worthTrying('https://www.youtube.com/'), true, '...and measured again');
    // kept for 30 days, then measured again
    let clock = 1000;
    const timed = createStore({ now: () => clock });
    timed.keep('https://www.halfdark.test/');
    clock += KEEP_FOR - 1;
    assert.strictEqual(timed.isLight('https://www.halfdark.test/'), true, 'kept within 30 days');
    clock += 2;
    assert.strictEqual(timed.isLight('https://www.halfdark.test/'), false, 'after 30 days: the theme again');
    assert.strictEqual(timed.worthTrying('https://www.halfdark.test/'), true, '...and measured again');
    assert.deepStrictEqual(timed.hosts(), []);

    fs.writeFileSync(file, 'not json');
    assert.deepStrictEqual(createStore({ file }).hosts(), [], 'a broken file is an empty list');
    assert.deepStrictEqual(createStore({ file: path.join(dir, 'missing.json') }).hosts(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // ---- the trial: dark, light, dark again. Each reading in turn; what the tab was told after each step.
  const run = async (readings, { moveAt = -1 } = {}) => {
    const store = createStore();
    const told = [];
    let n = 0;
    const r = await trial({
      url: 'https://www.site.test/', store,
      probe: async () => readings[n++] ?? null,
      apply: (u) => told.push(store.isLight(u || 'https://www.site.test/') ? 'light' : 'dark'),
      wait: async () => {},
      here: () => n !== moveAt,
    });
    return { r, told, kept: store.known('https://www.site.test/'), again: store.worthTrying('https://www.site.test/') };
  };
  let t = await run([glassdoor, lightPage, glassdoor]);
  assert.deepStrictEqual([t.r, t.told, t.kept], ['light', ['light', 'dark', 'light'], true], 'half dark both times it was told dark: kept, light');
  t = await run([mixedOnly, lightPage, fullDark]);
  assert.deepStrictEqual([t.r, t.told, t.kept], ['dark', ['light', 'dark', 'dark'], false], 'whole the second time it was told dark (caught mid-switch, as YouTube was): not kept');
  assert.strictEqual(t.again, false, '...and not tried again this run');
  t = await run([fullDark]);
  assert.deepStrictEqual([t.r, t.told], ['dark', []], 'a whole dark page: one reading, nothing told');
  t = await run([mixedOnly, { ...mixedOnly, dark: false }]);
  assert.deepStrictEqual([t.r, t.told, t.kept], ['dark', ['light', 'dark'], false], 'the light page no better: the theme again');
  t = await run([glassdoor, lightPage, glassdoor], { moveAt: 2 });
  assert.deepStrictEqual([t.r, t.told.at(-1), t.kept, t.again], ['moved', 'dark', false, true], 'the page moved on (a reload to change theme): the theme again, tried later');
  console.log('site-light-units: ok');
})().catch((e) => { console.error(e); process.exit(1); });
