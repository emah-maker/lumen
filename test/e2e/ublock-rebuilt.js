// [uBlock mode] What Lumen's own webRequest listeners did, rebuilt without them while uBlock Origin Lite blocks on the main session
// (features/ublock-helper.js's request rules, main.js's navigationGate, ai/page-debug.js's DevTools log), and the listeners back after
// switching to Lumen's blocker. No network: the uBlock stand-in comes from a local store (as in ublock-mode.js), Google's Safe Browsing API
// is a local stand-in (as in safe-browsing.js), and every *.test host maps to the local web server.
// Checked in uBlock mode: Do Not Track, Global Privacy Control, Chrome's Sec-CH-UA hints, tracking parameters taken off a page's address,
// tracking pings refused, third-party cookies left off (and sent when that setting is off), Focus mode's block page, Safe Browsing's warning
// (a clean page still loads), the AI's network log, and Lumen's rules extension hidden from Settings → Extensions.
// Then, back on Lumen's blocker: the rules extension is gone and each of those comes from Lumen's listeners again.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/ublock-rebuilt.js (a throwaway profile; no window shows)
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(100); } return v; };

  // ---- Google's Safe Browsing API, stood in for (one listed page: evil.test/phish.html)
  const sha = (s) => crypto.createHash('sha256').update(s).digest();
  const listed = sha('evil.test/phish.html');
  const prefix = listed.readUInt32BE(0);
  const prefixBytes = Buffer.alloc(4); prefixBytes.writeUInt32BE(prefix);
  const emptySum = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('base64');
  const api = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.searchParams.get('key') !== 'test-key-123456') { res.statusCode = 403; res.end('{}'); return; }
    if (u.pathname === '/v5/hashLists:batchGet') {
      res.end(JSON.stringify({ hashLists: u.searchParams.getAll('names').map((name) => (name === 'se-4b'
        ? { name, version: 'djE=', partialUpdate: false, additionsFourBytes: { firstValue: prefix, riceParameter: 28, entriesCount: 0, encodedData: '' }, sha256Checksum: crypto.createHash('sha256').update(prefixBytes).digest('base64'), minimumWaitDuration: '1800s' }
        : { name, version: 'djE=', partialUpdate: false, sha256Checksum: emptySum, minimumWaitDuration: '1800s' })) }));
      return;
    }
    if (u.pathname === '/v5/hashes:search') {
      const asked = new Set(u.searchParams.getAll('hashPrefixes'));
      res.end(JSON.stringify({ fullHashes: asked.has(listed.subarray(0, 4).toString('base64')) ? [{ fullHash: listed.toString('base64'), fullHashDetails: [{ threatType: 'SOCIAL_ENGINEERING' }] }] : [], cacheDuration: '300s' }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });

  // ---- the web (and the store's download address)
  const { id: extId, crx } = buildCrx(path.join(__dirname, '..', 'fixtures', 'extensions', 'ublock-standin'));
  const seen = []; // { host, url, headers }
  const web = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    seen.push({ host, url: req.url, headers: req.headers });
    if (req.url.startsWith('/crx')) { res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(crx); return; }
    if (req.url.startsWith('/img')) { res.setHeader('Content-Type', 'image/gif'); res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); return; }
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/ping')) { res.end(`<title>ping</title><script>navigator.sendBeacon('/beacon', 'x'); document.title = 'sent';</script>`); return; }
    if (req.url.startsWith('/third')) { res.end(`<title>third</title><img src="http://localhost:${web.address().port}/img?${Date.now()}" onload="document.title='img'" onerror="document.title='img'">`); return; }
    res.end(`<title>Page ${host}${req.url}</title><p>${host}</p>`);
  });
  await Promise.all([api, web].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const port = web.address().port;
  const at = (host, p = '/') => `http://${host}:${port}${p}`;
  const origin = `http://127.0.0.1:${port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ublock-rebuilt-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WEBSTORE_ORIGIN: origin, LUMEN_TEST_UBOL_ID: extId, LUMEN_SAFE_BROWSING_URL: `http://127.0.0.1:${api.address().port}` };
  delete env.GOOGLE_SAFE_BROWSING_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..'), '--host-resolver-rules=MAP *.test 127.0.0.1'], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  let tabId = null; // the web tab every page here loads in (opened once Lumen is up)
  const url = () => app.evaluate((_e, id) => global.__settings.contents(id)?.getURL() || '', tabId);
  const load = (u) => app.evaluate((_e, [id, x]) => { global.__settings.contents(id)?.loadURL(x).catch(() => {}); }, [tabId, u]);
  // Loads `u` and waits until the tab shows that page, loaded, with a title matching `want` (the address's path, before any query, identifies it).
  const loadedTitle = async (u, want) => {
    const p = new URL(u).pathname;
    await load(u);
    return waitFor(() => app.evaluate((_e, id) => { const wc = global.__settings.contents(id); return wc && !wc.isLoading() ? { url: wc.getURL(), title: wc.getTitle() } : null; }, tabId)
      .then((x) => (x && x.url.includes(p) && want.test(x.title) ? x.title : null)), 8000);
  };
  // (In uBlock mode a privacy setting reaches Lumen's request rules a moment later: waited for.)
  const setPref = (key, value) => app.evaluate(async (_e, [k, v]) => { await global.__settings.backend.set(k, v); await global.__ublock.rulesSettled(); }, [key, value]);
  const request = (host, p) => seen.filter((s) => s.host === host && s.url.startsWith(p));
  const last = (host, p) => request(host, p).slice(-1)[0];
  const rulesExtension = () => app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().some((e) => e.name === 'Lumen request rules'));
  const network = () => app.evaluate(async (_e, id) => { const r = await global.__agent.execute('get_network', { tab_id: id }); const blocks = Array.isArray(r) ? r : r?.content || [r]; return typeof r === 'string' ? r : blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'); }, tabId);

  // The privacy settings this suite checks, on (DNT and GPC are off by default).
  const privacyOn = async () => { await setPref('sendDoNotTrack', true); await setPref('sendGpc', true); await setPref('blockThirdPartyCookies', true); };
  // Each rebuilt piece, as the person would see it. `mode` names the run in the labels.
  async function checkAll(label) {
    const mode = label.replace(/[^a-z]+/gi, "-"); // (in addresses)
    await network(); // (the AI's capture of the tab starts with its first look)
    // headers
    await loadedTitle(at('site.test', `/hdr-${mode}`), /Page/);
    const h = last('site.test', `/hdr-${mode}`)?.headers || {};
    check(`${label}: Do Not Track and Global Privacy Control are sent`, h.dnt === '1' && h['sec-gpc'] === '1', JSON.stringify(h));
    await loadedTitle(at('localhost', `/hints-${mode}`), /Page/);
    const hh = last('localhost', `/hints-${mode}`)?.headers || {};
    check(`${label}: a page gets Chrome's Sec-CH-UA hints (Google Chrome)`, /Google Chrome/.test(hh['sec-ch-ua'] || '') && hh['sec-ch-ua-mobile'] === '?0', JSON.stringify(hh));
    // tracking parameters
    await loadedTitle(at('site.test', `/clean-${mode}?utm_source=mail&keep=1&fbclid=abc`), /Page/);
    const asked = request('site.test', `/clean-${mode}`).map((s) => s.url);
    check(`${label}: tracking parameters are taken off before the page is asked for`, asked.length > 0 && asked.every((u) => !/utm_source|fbclid/.test(u)) && asked.some((u) => /keep=1/.test(u)), JSON.stringify(asked));
    // pings
    const beacons = request('site.test', '/beacon').length;
    await loadedTitle(at('site.test', `/ping-${mode}`), /sent/);
    await sleep(800);
    check(`${label}: a tracking ping (sendBeacon) is not sent`, request('site.test', '/beacon').length === beacons, request('site.test', '/beacon').length);
    // third-party cookies
    await app.evaluate(({ session }, p) => session.defaultSession.cookies.set({ url: `http://localhost:${p}/`, name: 'tp', value: '1', secure: true, sameSite: 'no_restriction' }), port);
    await loadedTitle(at('site.test', `/third-${mode}-a`), /img/);
    const off = last('localhost', '/img')?.headers || {};
    await setPref('blockThirdPartyCookies', false);
    await loadedTitle(at('site.test', `/third-${mode}-b`), /img/);
    const sent = last('localhost', '/img')?.headers || {};
    await setPref('blockThirdPartyCookies', true);
    check(`${label}: a third-party cookie is left off (and sent when that setting is off)`, !/tp=1/.test(off.cookie || '') && /tp=1/.test(sent.cookie || ''), JSON.stringify({ off: off.cookie, sent: sent.cookie, tail: seen.slice(-6).map((x) => `${x.host}${x.url} c=${x.headers.cookie || ''}`) }));
    // Focus mode
    const focusUrl = await (async () => { await load(at('distract.test', `/f-${mode}`)); return waitFor(() => url().then((u) => (u.includes('focus-block.html') ? u : null)), 8000); })();
    check(`${label}: Focus mode shows its block page for a listed site`, Boolean(focusUrl), await url());
    // Safe Browsing
    const warn = await (async () => { await load(at('evil.test', '/phish.html')); return waitFor(() => url().then((u) => (u.includes('safe-browsing.html') ? u : null)), 10000); })();
    check(`${label}: Safe Browsing shows its warning for a listed page`, Boolean(warn), await url());
    check(`${label}: a page that is not listed still loads`, Boolean(await loadedTitle(at('clean.test', `/ok-${mode}`), /Page clean\.test/)), await url());
    // the AI's network log
    await loadedTitle(at('third.test', `/third-${mode}-net`), /img/);
    const net = await network();
    check(`${label}: the AI's network log lists the page's requests`, /img/.test(net) && /third\.test/.test(net), net.slice(0, 400));
  }

  try {
    await ui.waitForSelector('.tab');
    tabId = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, at('site.test', '/start'));
    await privacyOn();
    await setPref('focusSites', ['distract.test']);
    await app.evaluate(() => global.__focus.ctl().start(30));
    // Safe Browsing: the key, then the lists from the stand-in.
    await app.evaluate(async () => { await global.__settings.backend.set('safeBrowsing', true); });
    const sid = await app.evaluate(() => global.__settings.open('privacy'));
    const inSettings = (js) => app.evaluate(async (_e, [i, c]) => global.__settings.contents(i).executeJavaScript(c, true), [sid, js]);
    await waitFor(() => inSettings("Boolean(document.getElementById('safe-browsing-key'))"));
    await inSettings("const i = document.getElementById('safe-browsing-key'); i.value = 'test-key-123456'; document.getElementById('safe-browsing-save').click(); true");
    check('Safe Browsing is active (stand-in lists)', Boolean(await waitFor(() => inSettings("document.getElementById('safe-browsing-status').textContent").then((t) => /^Active/.test(t)), 15000)));

    // ---- uBlock mode: from Settings, through the confirmation
    await inSettings("(() => { const s = document.getElementById('pref-adBlocker'); s.value = 'ublock'; s.dispatchEvent(new Event('change')); return true; })()");
    const listed = await waitFor(() => inSettings("[...document.querySelectorAll('#ublock-confirm-list li')].map((li) => li.textContent).join(' | ')"), 5000);
    check('choosing uBlock Origin Lite first says what differs', /Safe Browsing/.test(listed || '') && /network log/.test(listed || ''), listed);
    await inSettings("document.getElementById('ublock-confirm-cancel').click(); true");
    await sleep(300);
    check('Cancel: nothing installed, still Lumen\'s blocker', (await inSettings("document.getElementById('pref-adBlocker').value")) === 'lumen' && (await app.evaluate(() => global.__ublock.on())) === false);
    await inSettings("(() => { const s = document.getElementById('pref-adBlocker'); s.value = 'ublock'; s.dispatchEvent(new Event('change')); return true; })()");
    await waitFor(() => inSettings("Boolean(document.getElementById('ublock-confirm-go'))"), 5000);
    await inSettings("document.getElementById('ublock-confirm-go').click(); true");
    check('Use uBlock Origin Lite: it is on', Boolean(await waitFor(() => app.evaluate(() => global.__ublock.on()), 20000)));
    check('Lumen\'s request-rules extension is loaded', Boolean(await waitFor(rulesExtension, 10000)));
    const listedExt = await app.evaluate(() => global.__settings.backend.listExtensions().map((e) => e.name));
    check('...and is not listed in Settings → Extensions (the uBlock stand-in is)', !listedExt.includes('Lumen request rules') && listedExt.some((n) => /stand-in/.test(n)), JSON.stringify(listedExt));
    await sleep(500);
    await checkAll('uBlock mode');

    // ---- back to Lumen's blocker: every listener back
    await app.evaluate(() => global.__ublock.set('lumen'));
    check('back on Lumen\'s blocker: its request-rules extension is gone', !(await rulesExtension()));
    await checkAll('Lumen mode');

    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    api.close(); web.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll uBlock rebuilt-protection checks passed.');
  process.exit(failures ? 1 : 0);
})();
