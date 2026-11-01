// [uBlock mode] Settings → Privacy and security → Ad blocker → uBlock Origin Lite, with no network: a small fixture extension
// (test/fixtures/extensions/ublock-standin: one declarativeNetRequest rule blocking /standin-ad.js, turned on from its worker as
// uBlock Origin Lite does) is packed into a CRX on the spot and served from 127.0.0.1 in place of the Chrome Web Store
// (LUMEN_TEST_WEBSTORE_ORIGIN), and stands in for uBlock Origin Lite (LUMEN_TEST_UBOL_ID, honoured only with that stand-in).
// Covers: the one-step switch from Settings (download, install, toolbar pin, Lumen steps aside), that the extension's rules really
// apply (they don't while any Lumen webRequest listener is on the session), a restart in uBlock mode, switching back (removed, Lumen's
// hooks back, so an extension's rules stop applying again: never both), and removing the extension elsewhere falls back to Lumen's blocker.
// Not covered: the real uBlock Origin Lite and its store page (no network in tests).
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/ublock-mode.js (a throwaway profile; no window shows)
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(100); } return v; };

  const { id: extId, crx } = buildCrx(path.join(__dirname, '..', 'fixtures', 'extensions', 'ublock-standin'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith('/crx')) { res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(crx); return; }
    if (req.url.startsWith('/standin-ad.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end('window.adRan = true;'); return; }
    res.setHeader('Content-Type', 'text/html');
    // The ad script's outcome becomes the page title: "loaded" (no blocker took it) or "blocked" (the extension's rule did).
    res.end(`<!doctype html><title>waiting</title><script src="/standin-ad.js?${Date.now()}" onload="document.title='loaded'" onerror="document.title='blocked'"></script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adRequests = () => requests.filter((u) => u.startsWith('/standin-ad.js')).length;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ublock-'));
  const readPrefs = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
  const launch = async () => {
    const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WEBSTORE_ORIGIN: origin, LUMEN_TEST_UBOL_ID: extId } });
    const ui = await app.firstWindow();
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    return app;
  };
  const errors = [];
  let app = null;

  const openSettings = async (section) => {
    const id = await app.evaluate((_e, s) => global.__settings.open(s), section);
    await waitFor(() => app.evaluate((_e, i) => global.__settings.contents(i)?.executeJavaScript('document.body?.dataset.ready === "1"', true).catch(() => false), id));
    return id;
  };
  const inTab = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [id, code]);
  const choose = (sid, value) => inTab(sid, `(() => { const s = document.getElementById('pref-adBlocker'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
  const note = (sid) => inTab(sid, "document.getElementById('ad-blocker-status').textContent");
  // A fresh web tab on the test page; resolves with what happened to its ad script.
  const adOutcome = async () => {
    const id = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, `${origin}/?${Date.now()}`);
    const title = await waitFor(() => app.evaluate((_e, i) => { const wc = global.__settings.contents(i); const tt = wc && !wc.isLoading() ? wc.getTitle() : ''; return tt === 'loaded' || tt === 'blocked' ? tt : null; }, id), 10000);
    await app.evaluate((_e, i) => global.__agent.browser.closeTab?.(i), id).catch(() => {});
    return title;
  };
  const extensionLoaded = () => app.evaluate(({ session }, id) => Boolean(session.defaultSession.extensions.getExtension(id)), extId);

  try {
    // ---- first run: Lumen's blocker
    app = await launch();
    check('starts in Lumen\'s blocker mode', (await app.evaluate(() => global.__ublock.on())) === false);
    check('the test page loads its ad script with no extension (nothing on 127.0.0.1 is in Lumen\'s lists)', (await adOutcome()) === 'loaded');

    let sid = await openSettings('privacy');
    const before = await inTab(sid, `({ value: document.getElementById('pref-adBlocker')?.value, note: document.getElementById('ad-blocker-ublock-note')?.hidden, toggle: document.getElementById('pref-adblock')?.closest('.row')?.hidden })`);
    check('Settings → Ad blocker: one choice, on Lumen\'s blocker, with Lumen\'s switch shown and the uBlock note hidden', before?.value === 'lumen' && before.note === true && before.toggle === false, JSON.stringify(before));

    // ---- one step: choose uBlock Origin Lite
    await choose(sid, 'ublock');
    const onNote = await waitFor(() => note(sid).then((t) => (/uBlock Origin Lite is on/.test(t) ? t : null)), 20000);
    check('choosing uBlock Origin Lite installs it and says so', Boolean(onNote), await note(sid));
    check('it was downloaded from the store address (the stand-in), once', requests.filter((u) => u.startsWith('/crx')).length === 1, JSON.stringify(requests.filter((u) => u.startsWith('/crx'))));
    check('it is loaded in the main session', await extensionLoaded());
    check('the setting is saved', readPrefs().adBlocker === 'ublock', readPrefs().adBlocker);
    check('its toolbar button is pinned (its popup: pause on a site, its settings)', (readPrefs().extensionPins?.order || []).includes(extId), JSON.stringify(readPrefs().extensionPins));
    const after = await inTab(sid, `({ value: document.getElementById('pref-adBlocker').value, note: document.getElementById('ad-blocker-ublock-note').hidden, toggle: document.getElementById('pref-adblock').closest('.row').hidden })`);
    check('Settings: Lumen\'s own switch and allow list hide, the note on what steps aside shows', after.value === 'ublock' && after.note === false && after.toggle === true, JSON.stringify(after));
    const ads0 = adRequests();
    check('its rules apply in a tab (Lumen left no webRequest listener on the session)', (await adOutcome()) === 'blocked');
    check('...the ad request never reached the server', adRequests() === ads0, `${adRequests()} vs ${ads0}`);

    // ---- a restart in uBlock mode
    await app.close();
    app = await launch();
    check('after a restart: still uBlock mode, the extension loaded', (await app.evaluate(() => global.__ublock.on())) === true && await waitFor(extensionLoaded, 10000));
    check('after a restart: its rules apply from the start (no gate or header listener came back)', (await waitFor(async () => ((await adOutcome()) === 'blocked' ? 'blocked' : null), 15000)) === 'blocked');

    // ---- back to Lumen's blocker
    sid = await openSettings('privacy');
    await choose(sid, 'lumen');
    const offNote = await waitFor(() => note(sid).then((t) => (/Lumen’s blocker is on/.test(t) ? t : null)), 15000);
    check('choosing Lumen\'s blocker says so', Boolean(offNote), await note(sid));
    check('...uBlock Origin Lite is removed (session and folder)', !(await extensionLoaded()) && !fs.existsSync(path.join(profile, 'Extensions', extId)));
    check('...the setting is saved', readPrefs().adBlocker === 'lumen', readPrefs().adBlocker);
    check('...the page\'s ad script loads again', (await adOutcome()) === 'loaded');

    // ---- never both: with Lumen's hooks on the session, an installed blocker extension's rules don't apply
    const installed = await app.evaluate(async ({ session }, id) => { try { await global.__installExtension(id); await session.defaultSession.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`).catch(() => {}); return true; } catch (err) { return err.message; } }, extId);
    await sleep(800);
    check('in Lumen\'s mode, the same extension installed by hand blocks nothing (Lumen\'s listeners keep its rules off)', installed === true && (await adOutcome()) === 'loaded', installed);

    // ---- uBlock mode, then the extension removed from elsewhere: Lumen's blocker takes over
    await app.evaluate(() => global.__ublock.set('ublock'));
    check('switching with it already installed: no second download', requests.filter((u) => u.startsWith('/crx')).length === 2, requests.filter((u) => u.startsWith('/crx')).length);
    check('...and it blocks', (await waitFor(async () => ((await adOutcome()) === 'blocked' ? 'blocked' : null), 10000)) === 'blocked');
    await app.evaluate((_e, id) => global.__uninstallExtension(id), extId);
    const fellBack = await waitFor(async () => (await app.evaluate(() => global.__ublock.on())) === false && readPrefs().adBlocker === 'lumen', 5000);
    check('removed from Settings → Extensions: back to Lumen\'s blocker', fellBack, `on=${await app.evaluate(() => global.__ublock.on())} saved=${readPrefs().adBlocker}`);
    check('...and the page loads its ad script again', (await adOutcome()) === 'loaded');

    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite threw: ${err.stack || err}`);
  } finally {
    await app?.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll uBlock mode checks passed.');
  process.exit(failures ? 1 : 0);
})();
