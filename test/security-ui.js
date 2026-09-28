// Certificate warnings and the lock's mixed-content state (features/site-security.js):
// - a bad certificate shows Lumen's warning page, not the generic error page;
// - "Back to safety" goes back; the agent's navigate or a script clicking "Continue" never gets
//   through on its own: only the user's answer in Lumen's own dialog does, and then only for that host;
// - an https page that loads an http image shows "not fully secure"; a clean one shows the lock.
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn().catch(() => null))) return v; await sleep(100); } return v; };

  // A self-signed certificate for localhost and 127.0.0.1 (openssl ships with Git for Windows and macOS).
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cert-'));
  const key = path.join(certDir, 'key.pem');
  const cert = path.join(certDir, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  openssl isn't available (${err.message})`);
    process.exit(0);
  }

  const plain = http.createServer((req, res) => {
    if (req.url.startsWith('/img')) { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Plain ${req.url}</title><p>plain</p>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => plain.once('listening', r));
  const plainUrl = `http://127.0.0.1:${plain.address().port}`;
  const page = (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/mixed')) { res.end(`<title>Mixed</title><img src="${plainUrl}/img.svg">`); return; }
    res.end(`<title>Secure ${req.url}</title><p>hello</p>`);
  };
  const opts = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const bad = https.createServer(opts, page).listen(0, '127.0.0.1');
  const bad2 = https.createServer(opts, page).listen(0, '127.0.0.1');
  await Promise.all([bad, bad2].map((s) => new Promise((r) => s.once('listening', r))));
  const badUrl = `https://127.0.0.1:${bad.address().port}/`;
  const bad2Url = `https://127.0.0.1:${bad2.address().port}/`;
  const goodBase = `https://localhost:${bad.address().port}`; // trusted below, for the mixed-content checks

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-secui-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  // "localhost" is trusted (a stand-in for a real site with a real certificate); everything else is
  // verified by Chromium as usual, so 127.0.0.1 fails with a certificate error.
  await app.evaluate(() => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.session.setCertificateVerifyProc((req, cb) => cb(req.hostname === 'localhost' ? 0 : -3));
  });
  const url = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  const load = (u) => app.evaluate((_e, u) => { global.__agent.browser.activeTab().webContents.loadURL(u).catch(() => {}); }, u);
  const inTab = (js) => app.evaluate((_e, js) => global.__agent.browser.activeTab().webContents.executeJavaScript(js, true), js);
  const state = () => app.evaluate(() => global.__siteSecurity.stateOf(global.__agent.browser.activeTab().webContents));
  const dialogId = () => app.evaluate(() => global.__dialogs.currentId?.() || null);
  const lock = () => ui.$eval('#security', (e) => ({ cls: e.className, hidden: e.hidden, title: e.title }));
  const onWarning = () => url().then((u) => u.includes('cert-error.html') && u);
  const ready = () => waitFor(() => inTab("document.readyState === 'complete'"));
  // A new tab starts with the address bar focused, and a focused address bar hides the lock.
  const unfocus = () => ui.evaluate(() => { document.getElementById('address').blur(); document.body.focus(); });

  // 1. The warning page, and Back to safety.
  await load(`${plainUrl}/start`);
  await waitFor(() => url().then((u) => u.startsWith(plainUrl)));
  await load(badUrl);
  const warn = await waitFor(onWarning);
  check('a bad certificate shows the certificate warning page', Boolean(warn), await url());
  check('the warning names the certificate error', /ERR_CERT_/.test(decodeURIComponent(warn || '')), warn);
  await sleep(300);
  check('the address bar shows the site, not the warning page', (await ui.inputValue('#address')).includes('127.0.0.1'), await ui.inputValue('#address'));
  await ready();
  await inTab("document.getElementById('back').click()");
  const back = await waitFor(() => url().then((u) => u.startsWith(`${plainUrl}/start`) && u));
  check('Back to safety returns to the previous page', Boolean(back), await url());

  // 2. Nothing but the user's answer gets through.
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), badUrl).catch(() => {});
  check("the agent's navigate lands on the warning, not the site", Boolean(await waitFor(onWarning)), await url());
  check('no dialog is shown for an ordinary visit', (await dialogId()) === null, await dialogId());
  await ready();
  await inTab("document.getElementById('advanced').click(); document.getElementById('continue').click()");
  const asked = await waitFor(dialogId);
  check("Continue asks in Lumen's own dialog", Boolean(asked), asked);
  await sleep(500);
  check('the page does not load while the question is open', Boolean(await onWarning()), await url());
  if (asked) await app.evaluate((_e, id) => global.__dialogs.respond({ id, response: 0 }), asked);
  await sleep(1000);
  check('Cancel stays on the warning page', Boolean(await waitFor(onWarning)), await url());
  // A script on a warning page sending the tab to a different bad address is refused without asking.
  await load(bad2Url);
  await waitFor(() => url().then((u) => u.includes(encodeURIComponent(String(bad2.address().port)))));
  await ready();
  await inTab(`location.href = ${JSON.stringify(badUrl)}`);
  await sleep(1500);
  check('a script navigating to another bad host is not offered a way through', (await dialogId()) === null && Boolean(await onWarning()), `${await dialogId()} ${await url()}`);

  // 3. The user continues: that host loads, is marked "not secure", and stays allowed this run.
  await load(badUrl); // the tab is already on this address's warning page: a plain load still doesn't ask
  await sleep(1000);
  check('reloading the address from the warning page does not ask', (await dialogId()) === null && Boolean(await onWarning()), `${await dialogId()} ${await url()}`);
  await ready();
  await inTab("document.getElementById('advanced').click(); document.getElementById('continue').click()");
  const asked2 = await waitFor(dialogId);
  if (asked2) await app.evaluate((_e, id) => global.__dialogs.respond({ id, response: 1 }), asked2);
  const through = await waitFor(() => url().then((u) => u === badUrl && u));
  check('Continue (unsafe) loads the site', Boolean(through), await url());
  check('the page is marked not secure', (await waitFor(state)) === 'broken', await state());
  await unfocus();
  const l1 = await waitFor(() => lock().then((l) => /danger/.test(l.cls) && l));
  check('the lock shows "Not secure"', Boolean(l1), JSON.stringify(await lock()));
  await load(`${badUrl}again`);
  check('the same host loads again without asking', Boolean(await waitFor(() => url().then((u) => u === `${badUrl}again`))) && (await dialogId()) === null, await url());
  await load(bad2Url);
  check('another host with the same certificate still gets the warning', Boolean(await waitFor(onWarning)), await url());

  // 4. Mixed content on a trusted https page.
  await load(`${goodBase}/clean`);
  await waitFor(() => url().then((u) => u === `${goodBase}/clean`));
  await sleep(800);
  check('a clean https page has no security note', (await state()) === null, await state());
  await unfocus();
  const l2 = await waitFor(() => lock().then((l) => !l.hidden && l.cls === 'security' && l));
  check('a clean https page shows the plain lock', Boolean(l2), JSON.stringify(await lock()));
  await load(`${goodBase}/mixed`);
  const mixed = await waitFor(() => state().then((s) => s === 'mixed' && s));
  check('an https page with an http image is "not fully secure"', Boolean(mixed), await state());
  await unfocus();
  const l3 = await waitFor(() => lock().then((l) => /insecure/.test(l.cls) && /Not fully secure/.test(l.title) && l));
  check('the lock shows the not-fully-secure warning', Boolean(l3), JSON.stringify(await lock()));
  await load(`${goodBase}/clean2`);
  await waitFor(() => url().then((u) => u.endsWith('/clean2')));
  await sleep(500);
  check('the note clears on the next page', (await state()) === null, await state());

  await app.close();
  for (const s of [plain, bad, bad2]) s.close();
  fs.rmSync(certDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
