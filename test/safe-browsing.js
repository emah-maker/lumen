// Google Safe Browsing (features/safe-browsing.js), against a local stand-in for Google's API:
// - off (the default) or without a key: nothing is checked and Google gets no request;
// - with a key saved in Settings: the lists download, a listed page shows the red warning instead of
//   loading (so is a redirect to one), a clean page loads, and Back to safety goes back;
// - the agent's navigate lands on the warning; only the user's answer in Lumen's own dialog, after
//   the warning page's link, lets the page load, and then only that page.
// Optional: with GOOGLE_SAFE_BROWSING_API_KEY set, Google's real test page is checked too.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn().catch(() => null))) return v; await sleep(100); } return v; };

  const sha = (s) => crypto.createHash('sha256').update(s).digest();
  const PHISH = 'evil.test/phish.html';
  const MALWARE = 'malware.test/';
  const listed = [sha(PHISH), sha(MALWARE)];
  // Rice-delta encoding with k = 28 (see reference/Local.Database).
  const encode = (values, k = 28) => {
    const sorted = [...values].sort((a, b) => a - b);
    const bits = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      for (let j = 0; j < Math.floor(d / 2 ** k); j++) bits.push(1);
      bits.push(0);
      for (let j = 0; j < k; j++) bits.push(Math.floor((d % 2 ** k) / 2 ** j) % 2);
    }
    const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
    return { firstValue: sorted[0], riceParameter: k, entriesCount: sorted.length - 1, encodedData: bytes.toString('base64') };
  };
  const prefixes = listed.map((h) => h.readUInt32BE(0));
  const sorted = Buffer.concat([...prefixes].sort((a, b) => a - b).map((p) => { const b = Buffer.alloc(4); b.writeUInt32BE(p); return b; }));
  const emptySum = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('base64');

  // The stand-in for safebrowsing.googleapis.com.
  const google = [];
  const api = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    google.push({ path: u.pathname, query: u.search, cookie: req.headers.cookie || '' });
    res.setHeader('Content-Type', 'application/json');
    if (u.searchParams.get('key') !== 'test-key-123456') { res.statusCode = 403; res.end('{}'); return; }
    if (u.pathname === '/v5/hashLists:batchGet') {
      res.end(JSON.stringify({ hashLists: u.searchParams.getAll('names').map((name) => (name === 'se-4b'
        ? { name, version: 'djE=', partialUpdate: false, additionsFourBytes: encode(prefixes), sha256Checksum: crypto.createHash('sha256').update(sorted).digest('base64'), minimumWaitDuration: '1800s' }
        : { name, version: 'djE=', partialUpdate: false, sha256Checksum: emptySum, minimumWaitDuration: '1800s' })) }));
      return;
    }
    if (u.pathname === '/v5/hashes:search') {
      const asked = new Set(u.searchParams.getAll('hashPrefixes'));
      const fullHashes = [
        { fullHash: listed[0].toString('base64'), fullHashDetails: [{ threatType: 'SOCIAL_ENGINEERING' }] },
        { fullHash: listed[1].toString('base64'), fullHashDetails: [{ threatType: 'MALWARE' }] },
      ].filter((f) => asked.has(Buffer.from(f.fullHash, 'base64').subarray(0, 4).toString('base64')));
      res.end(JSON.stringify({ fullHashes, cacheDuration: '300s' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  }).listen(0, '127.0.0.1');
  // The "web": every *.test host maps to this server (--host-resolver-rules below).
  const visits = [];
  const web = http.createServer((req, res) => {
    const where = `${(req.headers.host || '').split(':')[0]}${req.url}`;
    visits.push(where);
    if (req.url === '/go') { res.statusCode = 302; res.setHeader('Location', `http://evil.test:${web.address().port}/phish.html`); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Page ${where}</title><p>${where}</p>`);
  }).listen(0, '127.0.0.1');
  await Promise.all([api, web].map((s) => new Promise((r) => s.once('listening', r))));
  const port = web.address().port;
  const at = (host, p = '/') => `http://${host}:${port}${p}`;
  const phishUrl = at('evil.test', '/phish.html');
  const malwareUrl = at('malware.test', '/download');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sb-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_SAFE_BROWSING_URL: `http://127.0.0.1:${api.address().port}` };
  delete env.GOOGLE_SAFE_BROWSING_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--host-resolver-rules=MAP *.test 127.0.0.1'], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  const url = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  const load = (u) => app.evaluate((_e, u) => { global.__agent.browser.activeTab().webContents.loadURL(u).catch(() => {}); }, u);
  const inTab = (js) => app.evaluate((_e, js) => global.__agent.browser.activeTab().webContents.executeJavaScript(js, true), js);
  const dialogId = () => app.evaluate(() => global.__dialogs.currentId?.() || null);
  const status = () => app.evaluate(() => global.__safeBrowsing.status());
  const onWarning = () => url().then((u) => u.includes('safe-browsing.html') && u);
  const ready = () => waitFor(() => inTab("document.readyState === 'complete'"));
  const loaded = (u) => waitFor(() => url().then((x) => x === u && x));

  // 1. Off by default: nothing is checked, and Google hears nothing.
  check('Safe Browsing is off by default', (await status()).enabled === false, JSON.stringify(await status()));
  await load(phishUrl);
  check('off: a listed page loads normally', Boolean(await loaded(phishUrl)), await url());
  // 2. On, but no key yet: still nothing sent.
  await app.evaluate(() => global.__settings.backend.set('safeBrowsing', true));
  await load(at('evil.test', '/phish.html?again'));
  await loaded(at('evil.test', '/phish.html?again'));
  await sleep(500);
  check('on without a key: inactive, and no request reaches Google', (await status()).active === false && google.length === 0, JSON.stringify({ status: await status(), google }));

  // 3. The key, entered in Settings > Privacy.
  const sid = await app.evaluate(() => global.__settings.open('privacy'));
  const inSettings = (js) => app.evaluate(async (_e, [i, c]) => global.__settings.contents(i).executeJavaScript(c, true), [sid, js]);
  await waitFor(() => inSettings("Boolean(document.getElementById('safe-browsing-key'))"));
  const inactiveNote = await waitFor(() => inSettings("document.getElementById('safe-browsing-status')?.textContent"));
  check('Settings shows it is inactive without a key', /Inactive/.test(inactiveNote || ''), inactiveNote);
  await inSettings("const i = document.getElementById('safe-browsing-key'); i.value = 'test-key-123456'; document.getElementById('safe-browsing-save').click(); true");
  const activeNote = await waitFor(() => inSettings("document.getElementById('safe-browsing-status').textContent").then((t) => /^Active/.test(t) && t), 10000);
  check('after saving the key, the lists download and Settings says Active', Boolean(activeNote), await inSettings("document.getElementById('safe-browsing-status').textContent"));
  check('the key is stored encrypted, not in plain text', !fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').includes('test-key-123456'), 'plain key in settings.json');
  check('Google got the list request without any cookies', google.some((g) => g.path === '/v5/hashLists:batchGet') && google.every((g) => !g.cookie), JSON.stringify(google));
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), sid);
  await waitFor(() => url().then((u) => !u.includes('settings.html')));

  // 4. A clean page loads; a listed one shows the warning, and Back to safety returns.
  const cleanUrl = at('clean.test', '/start');
  await load(cleanUrl);
  check('a page not on the lists loads', Boolean(await loaded(cleanUrl)), await url());
  visits.length = 0;
  google.length = 0;
  await load(phishUrl);
  const warn = await waitFor(onWarning);
  check('a listed page shows the Safe Browsing warning instead', Boolean(warn), await url());
  check('the listed page itself was never requested', !visits.some((v) => v.startsWith('evil.test')), visits);
  const searched = google.filter((g) => g.path === '/v5/hashes:search');
  check('Google was asked about 4-byte prefixes only, not the address', searched.length === 1 && !/evil|phish/.test(searched[0].query)
    && new URLSearchParams(searched[0].query).getAll('hashPrefixes').every((p) => Buffer.from(p, 'base64').length === 4), JSON.stringify(searched));
  await ready();
  const text = await inTab('document.body.innerText');
  check('the warning says "suspected", credits Google and names the site', /Suspected deceptive site/.test(text) && /Advisory provided by Google/.test(text) && text.includes('evil.test'), text);
  check('the address bar shows the listed address', (await ui.inputValue('#address')).includes('evil.test'), await ui.inputValue('#address'));
  await inTab("document.getElementById('back').click()");
  check('Back to safety returns to the previous page', Boolean(await loaded(cleanUrl)), await url());

  // 5. A malware page, and a redirect to a listed page.
  await load(malwareUrl);
  await waitFor(onWarning);
  await ready();
  check('a malware-listed host shows the malware warning', /may harm your computer/.test(await inTab('document.body.innerText')), await inTab('document.body.innerText'));
  await load(cleanUrl);
  await loaded(cleanUrl);
  visits.length = 0;
  await load(at('clean.test', '/go'));
  const redirected = await waitFor(() => url().then((u) => u.includes('safe-browsing.html') && decodeURIComponent(u).includes('evil.test') && u));
  check('a redirect to a listed page is caught', Boolean(redirected) && decodeURIComponent(redirected).includes('evil.test'), await url());
  check('...and the listed page was never requested', !visits.some((v) => v.startsWith('evil.test')), visits);

  // 6. Only the user gets past it.
  await load(cleanUrl);
  await loaded(cleanUrl);
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), phishUrl).catch(() => {});
  check("the agent's navigate lands on the warning, not the page", Boolean(await waitFor(onWarning)), await url());
  check('no dialog is shown for an ordinary visit', (await dialogId()) === null, await dialogId());
  await ready();
  await inTab("document.getElementById('advanced').click(); document.getElementById('continue').click()");
  const asked = await waitFor(dialogId);
  check("'Visit this site anyway' asks in Lumen's own dialog", Boolean(asked), asked);
  await sleep(500);
  check('the page does not load while the question is open', Boolean(await onWarning()) && !visits.some((v) => v.startsWith('evil.test')), await url());
  if (asked) await app.evaluate((_e, id) => global.__dialogs.respond({ id, response: 0 }), asked);
  await sleep(800);
  check('Cancel stays on the warning page', Boolean(await waitFor(onWarning)) && !visits.some((v) => v.startsWith('evil.test')), await url());
  // A script on the warning page sending the tab to a different listed page gets no way through.
  await ready();
  await inTab(`location.href = ${JSON.stringify(malwareUrl)}`);
  await sleep(1200);
  check('a script navigating to another listed page is not offered a way through', (await dialogId()) === null && Boolean(await onWarning()), `${await dialogId()} ${await url()}`);
  await load(phishUrl);
  await waitFor(() => url().then((u) => u.includes(encodeURIComponent('evil.test'))));
  await ready();
  await inTab("document.getElementById('advanced').click(); document.getElementById('continue').click()");
  const asked2 = await waitFor(dialogId);
  if (asked2) await app.evaluate((_e, id) => global.__dialogs.respond({ id, response: 1 }), asked2);
  check("the user's Visit loads the page", Boolean(await loaded(phishUrl)), await url());
  await load(cleanUrl);
  await loaded(cleanUrl);
  await load(phishUrl);
  check('that page then loads again without asking, until Lumen quits', Boolean(await loaded(phishUrl)) && (await dialogId()) === null, await url());
  await load(malwareUrl);
  check('another listed page still gets the warning', Boolean(await waitFor(onWarning)), await url());

  // 6b. A private window is protected the same way: its tabs show the warning, and going past it is the user's answer
  // in Lumen's dialog, drawn in the private window.
  visits.length = 0;
  const privMalware = `${malwareUrl}?private`;
  const pwin = await app.evaluate((_e, u) => global.__private.open(u).win.id, privMalware);
  const privUrl = () => app.evaluate((_e, id) => { const w = global.__private.list().find((x) => x.windowId === id); return w?.tabs[0]?.url || ''; }, pwin);
  const privWarn = await waitFor(() => privUrl().then((u) => u.includes('safe-browsing.html') && u));
  check('a private tab shows the Safe Browsing warning for a listed page', Boolean(privWarn), await privUrl());
  check('...and the listed page was never requested from it', !visits.some((v) => v.startsWith('malware.test')), visits);
  const privTab = (js) => app.evaluate(({ webContents }, [id, c]) => webContents.fromId(global.__private.list().find((x) => x.windowId === id).tabs[0].contentsId).executeJavaScript(c, true), [pwin, js]);
  await waitFor(() => privTab("document.readyState === 'complete'"));
  await privTab("document.getElementById('advanced').click(); document.getElementById('continue').click()");
  const privAsked = await waitFor(dialogId);
  const dialogHost = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => /dialog\.html/.test(v.webContents.getURL()) && v.getVisible()))?.id ?? null);
  check("in a private window, 'Visit this site anyway' asks in Lumen's dialog, over the private window", Boolean(privAsked) && dialogHost === pwin, `${privAsked} ${dialogHost} ${pwin}`);
  if (privAsked) await app.evaluate((_e, id) => global.__dialogs.respond({ id, response: 0 }), privAsked);
  await sleep(600);
  check('Cancel keeps the private tab on the warning', (await privUrl()).includes('safe-browsing.html') && !visits.some((v) => v.startsWith('malware.test')), await privUrl());
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), pwin);
  await waitFor(() => app.evaluate(() => global.__private.count() === 0));

  // 7. Switched off again: listed pages load, and Google hears nothing more.
  await app.evaluate(() => global.__settings.backend.set('safeBrowsing', false));
  google.length = 0;
  await load(`${malwareUrl}?off`);
  check('switched off: a listed page loads and nothing is sent', Boolean(await loaded(`${malwareUrl}?off`)) && google.length === 0, JSON.stringify(google));

  await app.close();
  api.close();
  web.close();

  // Optional: Google's real service and its official test page (needs a real key).
  const realKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;
  if (!realKey) {
    console.log('SKIP  live check against Google (set GOOGLE_SAFE_BROWSING_API_KEY to run it)');
  } else {
    const liveProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sb-live-'));
    fs.writeFileSync(path.join(liveProfile, 'settings.json'), JSON.stringify({ safeBrowsing: true }));
    const live = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: liveProfile } });
    await (await live.firstWindow()).waitForSelector('.tab');
    const synced = await waitFor(() => live.evaluate(() => global.__safeBrowsing.status()).then((s) => s.entries > 0 && s), 60000);
    check('live: Google\'s lists download', Boolean(synced), JSON.stringify(await live.evaluate(() => global.__safeBrowsing.status())));
    await live.evaluate(() => { global.__agent.browser.activeTab().webContents.loadURL('https://testsafebrowsing.appspot.com/s/phishing.html').catch(() => {}); });
    const liveWarn = await waitFor(() => live.evaluate(() => global.__agent.browser.activeTab().webContents.getURL()).then((u) => u.includes('safe-browsing.html') && u), 20000);
    check("live: Google's phishing test page shows the warning", Boolean(liveWarn), await live.evaluate(() => global.__agent.browser.activeTab().webContents.getURL()));
    await live.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
