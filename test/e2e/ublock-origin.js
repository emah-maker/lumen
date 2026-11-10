// [uBlock mode] Settings → Privacy and security → Ad blocker → uBlock Origin, with no network: a small Manifest V2 fixture
// (test/fixtures/extensions/ublock-origin-standin: a background page that, like uBlock Origin, takes `browser` and calls browserAction at
// start-up, and blocks /standin-ad.js with a blocking webRequest listener only for requests that come with their tab) is packed into a CRX on
// the spot and served from 127.0.0.1 with a release list in place of GitHub's (LUMEN_TEST_UBO_RELEASES, LUMEN_TEST_UBO_ID: honoured only in a test run).
// Covers: the one-step switch from Settings (release list, download, signature, install, Lumen steps aside), that the extension starts and its
// blocking reaches a real tab (Electron 44's two gaps, preload/extensions-mv2-preload.js), a restart in that mode, a release refused for
// its signature, and switching back (removed, Lumen's blocker back).
// Also its element hiding (chrome.tabs.insertCSS/removeCSS, browser/extension-css.js): a YouTube-like grid whose ad item collapses, a frame's own
// rule kept to that frame, the rule taken back, and the page told dark in a dark theme while uBlock Origin runs.
// Not covered: the real uBlock Origin and GitHub (no network in tests).
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/ublock-origin.js (a throwaway profile; no window shows)
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

  const fixture = path.join(__dirname, '..', 'fixtures', 'extensions', 'ublock-origin-standin');
  const { id: extId, crx } = buildCrx(fixture);
  let served = crx; // (swapped for another publisher's build to see it refused)
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.url.startsWith('/releases')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ tag_name: '1.0.0', assets: [{ name: 'uBlock0_1.0.0.chromium.zip', browser_download_url: `${origin}/zip` }, { name: 'uBlock0_1.0.0.chromium.crx', browser_download_url: `${origin}/ubo.crx` }] })); return; }
    if (req.url.startsWith('/ubo.crx')) { res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(served); return; }
    // A YouTube-like home grid (the third item holds an ad slot, as YouTube's ytd-rich-item-renderer does) whose own CSS says display:block
    // !important (a weaker selector than the rule's). Its frame has an ad box of its own; the top page has one too, that the frame's rule
    // must leave alone.
    if (req.url.startsWith('/grid-frame')) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div class="frame-ad" style="height:40px">frame ad</div>'); return; }
    if (req.url.startsWith('/grid')) {
      res.setHeader('Content-Type', 'text/html');
      const item = (i) => `<div class="item" id="i${i}">${i === 2 ? '<div class="ad-slot">ad</div>' : `video ${i}`}</div>`;
      res.end(`<!doctype html><title>grid</title><style>body{margin:0}#grid{display:flex;flex-wrap:wrap;width:330px}#grid .item{display:block!important;width:100px;height:60px;margin:5px}</style><div id="grid">${[0, 1, 2, 3, 4, 5].map(item).join('')}</div><div class="frame-ad" id="top-ad">top box</div><iframe src="/grid-frame"></iframe>`);
      return;
    }
    if (req.url.startsWith('/standin-ad.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end('window.adRan = true;'); return; }
    res.setHeader('Content-Type', 'text/html');
    // The ad script's outcome becomes the page title: "loaded" (nothing took it) or "blocked" (the extension's listener did).
    res.end(`<!doctype html><title>waiting</title><script src="/standin-ad.js?${Date.now()}" onload="document.title='loaded'" onerror="document.title='blocked'"></script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adRequests = () => requests.filter((u) => u.startsWith('/standin-ad.js')).length;
  const downloads = () => requests.filter((u) => u.startsWith('/ubo.crx')).length;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ubo-'));
  const readPrefs = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
  const errors = [];
  const launch = async () => {
    const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_UBO_RELEASES: `${origin}/releases`, LUMEN_TEST_UBO_ID: extId } });
    const ui = await app.firstWindow();
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    return app;
  };
  let app = null;

  const openSettings = async (section) => {
    const id = await app.evaluate((_e, s) => global.__settings.open(s), section);
    await waitFor(() => app.evaluate((_e, i) => global.__settings.contents(i)?.executeJavaScript('document.body?.dataset.ready === "1"', true).catch(() => false), id));
    return id;
  };
  const inTab = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [id, code]);
  const choose = async (sid, value) => {
    await inTab(sid, `(() => { const s = document.getElementById('pref-adBlocker'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
    if (value !== 'lumen') { await waitFor(() => inTab(sid, "Boolean(document.getElementById('ublock-confirm-go'))").then((v) => v === true), 5000); return inTab(sid, "(() => { const t = document.getElementById('ublock-confirm-title').textContent; document.getElementById('ublock-confirm-go').click(); return t; })()"); }
    return null;
  };
  const note = (sid) => inTab(sid, "document.getElementById('ad-blocker-status').textContent");
  const adOutcome = async () => {
    const id = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, `${origin}/?${Date.now()}`);
    const title = await waitFor(() => app.evaluate((_e, i) => { const wc = global.__settings.contents(i); const tt = wc && !wc.isLoading() ? wc.getTitle() : ''; return tt === 'loaded' || tt === 'blocked' ? tt : null; }, id), 10000);
    await app.evaluate((_e, i) => global.__agent.browser.closeTab?.(i), id).catch(() => {});
    return title;
  };
  const extensionLoaded = () => app.evaluate(({ session }, id) => Boolean(session.defaultSession.extensions.getExtension(id)), extId);
  // The background page's own state: what the fixture's listener saw (tab ids), and whether it got past browserAction.
  const background = (code) => app.evaluate(async ({ webContents }, [id, c]) => { const bg = webContents.getAllWebContents().find((w) => w.getURL().startsWith(`chrome-extension://${id}/background.html`)); return bg ? bg.executeJavaScript(c).catch((e) => `ERROR ${e.message}`) : 'no background page'; }, [extId, code]);

  try {
    app = await launch();
    check('the test page loads its ad script with Lumen\'s blocker (nothing on 127.0.0.1 is in its lists)', (await adOutcome()) === 'loaded');

    let sid = await openSettings('privacy');
    const options = await inTab(sid, "[...document.getElementById('pref-adBlocker').options].map((o) => o.value + '=' + o.textContent).join('|')");
    check('Settings → Ad blocker offers Lumen\'s, uBlock Origin Lite and uBlock Origin', options === 'lumen=Lumen’s built-in blocker|ublock=uBlock Origin Lite|ublock-origin=uBlock Origin', options);

    // ---- a release whose package another key signed: refused, nothing switched
    served = buildCrx(fixture).crx;
    check('it asks first, naming uBlock Origin', (await choose(sid, 'ublock-origin')) === 'Use uBlock Origin?');
    // (the select is still enabled for a moment before the install starts: wait for the refusal itself, not just an enabled select)
    let row = '';
    await waitFor(() => inTab(sid, "document.getElementById('pref-adBlocker').disabled ? null : document.querySelector('#pref-adBlocker').closest('.row').textContent").then((t) => { row = t || row; return /not signed by uBlock Origin/.test(row) && t; }), 15000);
    const refused = row;
    check('a package not signed by uBlock Origin\'s key is refused: still Lumen\'s blocker, nothing installed', readPrefs().adBlocker !== 'ublock-origin' && !(await extensionLoaded()) && !fs.existsSync(path.join(profile, 'Extensions', extId)) && /not signed by uBlock Origin/.test(refused), refused);
    check('...and the choice shows Lumen\'s again', (await inTab(sid, "document.getElementById('pref-adBlocker').value")) === 'lumen');
    served = crx;

    // ---- one step: choose uBlock Origin
    await openSettings('privacy').then((i) => { sid = i; });
    await choose(sid, 'ublock-origin');
    const onNote = await waitFor(() => note(sid).then((t) => (/uBlock Origin is on/.test(t) ? t : null)), 20000);
    check('choosing uBlock Origin installs it and says so', Boolean(onNote), await note(sid));
    check('it was downloaded from the release\'s CRX (after the refused one)', downloads() === 2, downloads());
    check('it is loaded in the main session, from the store\'s extension folder', await extensionLoaded() && fs.existsSync(path.join(profile, 'Extensions', extId, '1.0.0_0', 'manifest.json')));
    check('the setting is saved, and its toolbar button pinned', readPrefs().adBlocker === 'ublock-origin' && (readPrefs().extensionPins?.order || []).includes(extId), JSON.stringify(readPrefs().extensionPins));
    const about = await inTab(sid, "(() => { const n = document.getElementById('ad-blocker-ublock-note'); return { hidden: n.hidden, text: n.textContent, toggle: document.getElementById('pref-adblock').closest('.row').hidden }; })()");
    check('Settings: the note names uBlock Origin and its GitHub releases; Lumen\'s own rows hide', about.hidden === false && /While uBlock Origin is on/.test(about.text) && /GitHub releases/.test(about.text) && about.toggle === true, JSON.stringify(about));
    check('its background page started (past browserAction, with `browser` completed)', (await waitFor(() => background('Array.isArray(self.seen)').then((v) => v === true), 10000)) === true, await background('typeof self.seen'));
    const ads0 = adRequests();
    check('its blocking listener blocks in a tab', (await adOutcome()) === 'blocked');
    check('...the ad request never reached the server', adRequests() === ads0, `${adRequests()} vs ${ads0}`);
    const seen = JSON.parse(await background('JSON.stringify(self.seen)') || '[]');
    check('...and it saw the request with its tab (not -1)', seen.length > 0 && seen.every((t) => t >= 0), JSON.stringify(seen));

    // ---- its element hiding, in the frame each rule names; and the page follows a dark theme
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
    const gridTab = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, `${origin}/grid?${Date.now()}`);
    await waitFor(() => app.evaluate((_e, i) => { const wc = global.__settings.contents(i); return Boolean(wc && !wc.isLoading()); }, gridTab), 10000);
    // (Playwright tells every page it attaches to that the system is light: that is undone, so the page sees Lumen's theme)
    for (const p of app.context().pages()) if (p.url().includes('/grid')) await p.emulateMedia({ colorScheme: null }).catch(() => {});
    const inGrid = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c); } catch (err) { return 'ERROR ' + err.message; } }, [gridTab, code]);
    const inFrame = (code) => app.evaluate(async (_e, [i, c]) => { const fr = global.__settings.contents(i).mainFrame.frames[0]; return fr ? fr.executeJavaScript(c).catch((err) => 'ERROR ' + err.message) : 'no frame'; }, [gridTab, code]);
    const layout = "(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return { ad: getComputedStyle(document.getElementById('i2')).display, i3: Math.round(r('i3').left), i2slot: Math.round(r('i1').right + 10), topAd: getComputedStyle(document.getElementById('top-ad')).display, sheets: document.styleSheets.length }; })()";
    const hidden = await waitFor(() => inGrid(layout).then((v) => (v?.ad === 'none' ? v : null)), 10000);
    check('a uBlock-style rule hides the grid item that holds an ad, over the page\'s own display:block !important', hidden?.ad === 'none', JSON.stringify(await inGrid(layout)));
    check('...and the slot collapses: the next item moves into it (no hole)', hidden && hidden.i3 === hidden.i2slot, JSON.stringify(hidden));
    check('...the sheet is not one of the page\'s (document.styleSheets)', hidden?.sheets === 1, JSON.stringify(hidden));
    check('a frame\'s rule hides the ad in that frame', (await waitFor(() => inFrame("getComputedStyle(document.querySelector('.frame-ad')).display").then((v) => (v === 'none' ? v : null)), 8000)) === 'none', await inFrame("getComputedStyle(document.querySelector('.frame-ad')).display"));
    check('...and not in the top page', hidden?.topAd === 'block', JSON.stringify(hidden));
    await inGrid("postMessage('standin-uncss', '*')");
    const shown = await waitFor(() => inGrid(layout).then((v) => (v?.ad === 'block' ? v : null)), 8000);
    check('removeCSS takes the rule back out: the item shows again', shown?.ad === 'block', JSON.stringify(await inGrid(layout)));
    check('a dark theme: the page is told prefers-color-scheme: dark while uBlock Origin runs', (await inGrid("matchMedia('(prefers-color-scheme: dark)').matches")) === true);
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
    await app.evaluate((_e, i) => global.__agent.browser.closeTab?.(i), gridTab).catch(() => {});

    // ---- a restart in uBlock Origin mode
    await app.close();
    app = await launch();
    check('after a restart: still uBlock Origin, loaded from disk', (await app.evaluate(() => global.__ublock.on())) === true && readPrefs().adBlocker === 'ublock-origin' && await waitFor(extensionLoaded, 10000));
    check('after a restart: it blocks from the start', (await waitFor(async () => ((await adOutcome()) === 'blocked' ? 'blocked' : null), 15000)) === 'blocked');
    check('no second download at start-up (the daily check waits for the first tab and a day)', downloads() === 2, downloads());

    // ---- back to Lumen's blocker
    sid = await openSettings('privacy');
    await choose(sid, 'lumen');
    const offNote = await waitFor(() => note(sid).then((t) => (/Lumen’s blocker is on/.test(t) ? t : null)), 15000);
    check('choosing Lumen\'s blocker says so', Boolean(offNote), await note(sid));
    check('...uBlock Origin is removed (session and folder)', !(await extensionLoaded()) && !fs.existsSync(path.join(profile, 'Extensions', extId)));
    check('...the page\'s ad script loads again', (await adOutcome()) === 'loaded');

    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite threw: ${err.stack || err}`);
  } finally {
    await app?.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll uBlock Origin checks passed.');
  process.exit(failures ? 1 : 0);
})();
