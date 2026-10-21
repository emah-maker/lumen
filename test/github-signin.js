// "Sign in with GitHub" in the real app (hidden window), against a stand-in for github.com and api.github.com on 127.0.0.1 (a throwaway
// https certificate; nothing leaves the machine):
//  - the new-tab GitHub card, signed out, offers Sign in with GitHub; pressing it shows the one-time code and the address to open, the
//    sign-in page is "opened" (recorded, not opened), and the card fills in by itself once the stand-in approves;
//  - Settings → Widgets → GitHub has the same sign-in (code, who you are, Sign out) and no token field in sight except under Advanced;
//  - the same sign-in set up the GitHub connector; the token appears in neither page nor in connectors.json;
//  - a revoked token turns the card into "Sign in again"; Sign out in Settings takes the connector down with it.
// Run hidden and under the lock: node scripts/test/e2e-lock.js run --owner <name> -- timeout 600 node test/github-signin.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { openSettingsTab } = require('./settings-tab');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = `gho_${'E2e3E2e3E2'.repeat(4)}`;
const CLIENT = 'Iv1.e2eclient00001';

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-signin-profile-')); // (not lumen-*: other suites sweep those from the shared temp folder)
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    process.exit(0);
  }
  let valid = new Set();
  let approve = false; // the stand-in approves the device code when this is true
  const seen = [];
  const pr = (n) => ({ number: n, title: `Fix thing ${n}`, html_url: `https://github.com/acme/app/pull/${n}`, user: { login: 'octo-cat' }, updated_at: '2026-09-28T10:00:00Z', pull_request: {}, comments: 1 });
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ path: u.pathname, auth: req.headers.authorization || '', cookie: req.headers.cookie || '' });
      const out = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/login/device/code') return out(200, { device_code: 'dc-e2e', user_code: 'WDJB-MJHT', verification_uri: 'https://127.0.0.1/login/device', expires_in: 900, interval: 1 });
      if (u.pathname === '/login/oauth/access_token') return out(200, approve ? { access_token: TOKEN, scope: 'read:user,notifications', token_type: 'bearer' } : { error: 'authorization_pending' });
      if (u.pathname.startsWith('/api/')) {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!valid.has(token)) return out(401, { message: 'Bad credentials' });
        const h = { 'x-oauth-scopes': 'read:user, notifications' };
        if (u.pathname === '/api/user') return out(200, { login: 'octocat' }, h);
        if (u.pathname === '/api/search/issues') return out(200, { total_count: 42, items: Array.from({ length: 12 }, (_, i) => pr(i + 1)) }, h);
        if (u.pathname === '/api/notifications') return out(200, [{ id: '1' }], { ...h, link: '<https://api.github.com/notifications?per_page=1&page=7>; rel="last"' });
      }
      return out(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;
  const profile = path.join(scratch, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [{ id: 'wgit00001', type: 'github', x: 0, y: 0, w: 5, h: 5 }], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, [b, client]) => {
      global.__widgetEndpoints = { github: `${b}/api`, githubLogin: b };
      global.__connectorEndpoints = { github: `${b}/api` };
      global.__githubClientId = client;
      global.__githubPollScale = 0.01;
      global.__widgetRateMax = 5000;
    }, [base, CLIENT]);
    await app.evaluate(() => Promise.all(global.__widgets.list().map((w) => global.__widgets.refresh(w, { force: true, user: true })))); // (the card asked once at start-up, before the stand-in's address and client id were set)
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__homeTab = t; });
    const inTab = (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js);
    const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await inTab(code).catch(() => false)) return true; await sleep(150); } return false; };
    const card = `document.querySelector('.w-card[data-id="wgit00001"]')`;

    // ---- the card, signed out ----
    check('the signed-out GitHub card says to sign in and offers Sign in with GitHub (no raw error)', await waitFor(`/Sign in to GitHub/.test(${card}?.textContent || '') && [...${card}.querySelectorAll('.w-body button')].some((b) => b.textContent === 'Sign in with GitHub')`), await inTab(`${card}?.textContent`));
    await inTab(`[...${card}.querySelectorAll('.w-body button')].find((b) => b.textContent === 'Sign in with GitHub').click(); true`);
    check('pressing it shows the one-time code on the card, and where to enter it', await waitFor(`${card}?.querySelector('.gh-user-code')?.textContent === 'WDJB-MJHT' && /login\\/device/.test(${card}.textContent)`), await inTab(`${card}?.textContent`));
    const opened = await app.evaluate(() => global.__githubOpened || []);
    check('the sign-in page was handed to a Lumen tab (the stand-in’s device page; a test only records it)', opened.length === 1 && opened[0] === `${base}/login/device`, JSON.stringify(opened));
    check('the card does not keep a Sign in button while the code waits', await inTab(`![...${card}.querySelectorAll('.w-body button')].some((b) => b.textContent === 'Sign in with GitHub')`), '');

    // ---- approved: the card fills in ----
    valid = new Set([TOKEN]);
    approve = true;
    check('once approved the card fills in by itself (review requests, assigned, unread)', await waitFor(`${card}?.querySelector('.gh-summary') && /42/.test(${card}.textContent) && /7/.test(${card}.textContent) && !${card}.querySelector('.gh-user-code')`), await inTab(`${card}?.textContent`));
    const conn = await app.evaluate(() => global.__connectors.list().connectors.find((c) => c.id === 'github'));
    check('the same sign-in set up the GitHub connector', conn.status === 'connected' && /octocat/.test(conn.statusText), JSON.stringify(conn.statusText));
    const connFile = fs.readFileSync(path.join(profile, 'connectors.json'), 'utf8');
    const pageText = await inTab('document.documentElement.outerHTML');
    check('the token is in neither the page nor connectors.json (only the encrypted settings key)', !pageText.includes(TOKEN) && !connFile.includes(TOKEN) && !/"secret"/.test(connFile), '');
    await app.evaluate(() => { if (global.__settingsFlush) global.__settingsFlush(); });
    const settingsJson = fs.readFileSync(path.join(profile, 'settings.json'), 'utf8');
    check('settings.json holds the token only encrypted', !settingsJson.includes(TOKEN) && Boolean(JSON.parse(settingsJson).keys?.['widget:github']), settingsJson.slice(0, 120));

    // ---- Settings ----
    const sp = await openSettingsTab(app, 'appearance');
    const spWait = async (code, tries = 60) => { for (let i = 0; i < tries; i++) { if ((await sp(code)) === true) return true; await sleep(150); } return false; };
    await spWait("Boolean(document.getElementById('widget-add'))");
    await sp("document.getElementById('widget-add').click()");
    await sp("document.querySelector('.seg [data-type=github]').click(); true");
    check('Settings: the GitHub editor shows who you are and how, with Sign out and Switch account', await spWait("/Signed in as @octocat with GitHub/.test(document.getElementById('github-status')?.textContent || '') && !document.getElementById('github-signout').hidden && !document.getElementById('github-switch').hidden && document.getElementById('github-signin').hidden"), await sp("document.getElementById('github-status')?.textContent"));
    check('Settings: the token field is only under Advanced, and nothing in the page holds the token', (await sp("Boolean(document.getElementById('widget-token')?.closest('details.wf-advanced'))")) === true && (await sp('document.documentElement.outerHTML')).includes(TOKEN) === false, '');
    // Switch account starts a new code and shows it
    await sp("document.getElementById('github-switch').click(); true");
    approve = false;
    check('Settings: Switch account asks GitHub for a new code and shows it (and Cancel)', await spWait("document.getElementById('github-code')?.textContent === 'WDJB-MJHT' && !document.getElementById('github-code-row').hidden && !document.getElementById('github-cancel').hidden"), await sp("document.getElementById('github-code-row')?.outerHTML?.slice(0, 200)"));
    await sp("document.getElementById('github-cancel').click(); true");
    check('Settings: Cancel puts the signed-in state back, with the old sign-in kept', await spWait("document.getElementById('github-code-row').hidden === true && /Signed in as @octocat/.test(document.getElementById('github-status').textContent)"), await sp("document.getElementById('github-status')?.textContent"));

    // ---- a revoked token: the card says Sign in again ----
    valid = new Set();
    await app.evaluate(() => global.__widgets.refresh(global.__widgets.list().find((w) => w.type === 'github'), { force: true, user: true }));
    check('revoked token: the card says so and offers Sign in again (no raw GitHub error)', await waitFor(`${card}?.querySelector('.gh-signin') && [...${card}.querySelectorAll('.w-body button')].some((b) => b.textContent === 'Sign in again') && !/Bad credentials|rejected/i.test(${card}.textContent)`), await inTab(`${card}?.textContent`));
    check('revoked token: Settings says the sign-in is no longer accepted and offers Sign in again', await spWait("/no longer accepts/.test(document.getElementById('github-status')?.textContent || '') && document.getElementById('github-signin').textContent === 'Sign in again' && !document.getElementById('github-signin').hidden"), await sp("document.getElementById('github-status')?.textContent"));

    // ---- sign out in Settings ----
    await sp("document.getElementById('github-signout').click(); true");
    check('Sign out: Settings says not signed in, the card goes back to the sign-in prompt', await spWait("/Not signed in/.test(document.getElementById('github-status')?.textContent || '') && document.getElementById('github-signout').hidden === true") && await waitFor(`/Sign in to GitHub/.test(${card}?.textContent || '') && [...${card}.querySelectorAll('.w-body button')].some((b) => b.textContent === 'Sign in with GitHub')`), await sp("document.getElementById('github-status')?.textContent"));
    const after = await app.evaluate(() => global.__connectors.list().connectors.find((c) => c.id === 'github').status);
    check('Sign out: the GitHub connector is off too', after === 'off', after);
    check('the stand-in saw no cookies', seen.every((s) => !s.cookie), JSON.stringify(seen.find((s) => s.cookie)));
  } catch (err) {
    check('the run finished without an error', false, err.stack || err);
  } finally {
    await app.close().catch(() => {});
    await new Promise((r) => srv.close(r));
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
