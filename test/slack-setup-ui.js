// The guided Slack setup in Settings (Appearance → Widgets → Slack): the steps are shown, the one paste box
// connects with a token (against a stand-in Slack over a throwaway https server: no real Slack, no network),
// refuses nonsense, remembers a half-pasted Client ID, shows "Connected to <workspace> as <user>" with a
// Disconnect button, and never puts the token on the page. Run: node test/slack-setup-ui.js
// With SLACK_SETUP_SHOTS=<dir> it also saves screenshots; with SLACK_SETUP_WINDOW=1 it also presses
// "Create the Lumen app in Slack" and checks the setup window opens on Slack's prefilled create-app page
// (that one reaches the real slack.com, so it is off by default).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { openSettingsTab } = require('./settings-tab');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'xoxp-1111-2222-abcdefghij';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-slack-ui-'));
  const key = path.join(tmp, 'k.pem');
  const cert = path.join(tmp, 'c.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) { console.log(`SKIP  openssl isn't available (${err.message})`); return; }
  const calls = [];
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    calls.push({ path: req.url, auth: req.headers.authorization || '' });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth.test') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
      return res.end(JSON.stringify({ ok: true, user_id: 'U100', user: 'ana.ruiz', team_id: 'T1', team: 'Muse', url: 'https://muse.slack.com/' }));
    }
    res.end(JSON.stringify({ ok: true, revoked: true }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [] }));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' }, timeout: 60000 });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, b) => { global.__widgetEndpoints = { slack: `${b}/api` }; }, base);
    const inSettings = await openSettingsTab(app, 'widgets');
    const shot = async (name) => {
      const dir = process.env.SLACK_SETUP_SHOTS;
      if (!dir) return;
      fs.mkdirSync(dir, { recursive: true });
      await inSettings('(() => { const e = document.querySelector("#slack-create"); if (e) e.scrollIntoView({ block: "start" }); })()');
      await sleep(250);
      const png = await app.evaluate(async (_e, id) => (await global.__settings.contents(id).capturePage()).toPNG().toString('base64'), inSettings.id);
      fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(png, 'base64'));
    };
    await inSettings('document.querySelector("#widget-add").click()');
    await sleep(300);
    await inSettings('document.querySelector("button[data-type=slack]").click()');
    await sleep(400);
    const q = (sel, prop = 'textContent') => inSettings(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.${prop} : null; })()`);
    const visible = (sel) => inSettings(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return Boolean(e && e.offsetParent !== null); })()`);

    check('setup: the main button creates the app, and the three steps are shown', (await q('#slack-create')) === 'Create the Lumen app in Slack' && (await visible('#slack-steps')) && (await inSettings('document.querySelectorAll("#slack-steps li").length')) === 3, await q('#slack-steps'));
    check('setup: it starts as Not connected, with the paste box and no Disconnect', (await q('#slack-status')) === 'Not connected.' && (await visible('#slack-paste')) && !(await visible('#slack-disconnect')), await q('#slack-status'));
    check('setup: the old pasted-address row is hidden until a sign-in is waiting', !(await visible('#slack-pasted')), '');
    await shot('1-not-connected');

    const paste = async (text) => { await inSettings(`(() => { const i = document.querySelector('#slack-paste'); i.value = ${JSON.stringify(text)}; document.querySelector('#slack-connect').click(); })()`); await sleep(700); };
    await paste('hello');
    check('paste: nonsense is refused with what to paste, nothing connects', /User OAuth Token/.test(await q('#slack-status')) && !/Connected/.test(await q('#slack-status')), await q('#slack-status'));
    await paste('Client ID\n1234567.7654321');
    check('paste: a Client ID alone waits for the secret', /Client Secret/.test(await q('#slack-status')) && !(await visible('#slack-pasted')), await q('#slack-status'));
    await app.evaluate(async () => { await global.__widgets.slackCancel?.(); });
    await paste('xoxp-9999-8888-wrongwrongwrong');
    check('paste: a token Slack refuses is explained and nothing is stored', /no longer accepts|Slack/.test(await q('#slack-status')) && !/Connected to/.test(await q('#slack-status')), await q('#slack-status'));
    await paste(`  ${TOKEN}  `);
    check('paste: a token connects, naming the workspace and the user', /Connected to Muse as ana\.ruiz/.test(await q('#slack-status')) && (await visible('#slack-disconnect')) && !(await visible('#slack-steps')), await q('#slack-status'));
    check('paste: the token went to the Slack API as a bearer header only, and is not on the page', calls.some((c) => c.path === '/api/auth.test' && c.auth === `Bearer ${TOKEN}`) && !(await inSettings('document.documentElement.outerHTML')).includes(TOKEN) && (await q('#slack-paste', 'value')) === '', JSON.stringify(calls));
    await shot('2-connected');
    const stored = await app.evaluate(() => { try { return String(require('fs').readFileSync(require('path').join(process.env.CLAUDE_BROWSER_PROFILE, 'settings.json'), 'utf8')); } catch { return ''; } });
    check('paste: nothing secret is written to settings.json', !stored.includes('xoxp'), stored.slice(0, 120));
    await inSettings('document.querySelector("#slack-disconnect").click()');
    await sleep(700);
    check('disconnect: back to Not connected with the steps again', (await q('#slack-status')) === 'Not connected.' && (await visible('#slack-steps')) && calls.some((c) => c.path === '/api/auth.revoke'), await q('#slack-status'));

    if (process.env.SLACK_SETUP_WINDOW) {
      await inSettings('document.querySelector("#slack-create").click()');
      await sleep(6000);
      const info = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getTitle() !== '' || true).map((w) => ({ title: w.getTitle(), url: w.webContents.getURL().slice(0, 90) })));
      const setupWin = info.find((w) => /api\.slack\.com\/apps\?new_app=1&manifest_json=/.test(w.url));
      check('create: the setup window opens Slack’s create-app page with the manifest in the address', Boolean(setupWin), JSON.stringify(info));
      const dir = process.env.SLACK_SETUP_SHOTS;
      if (dir) {
        const png = await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => /api\.slack\.com/.test(x.webContents.getURL())); return w ? (await w.webContents.capturePage()).toPNG().toString('base64') : ''; });
        if (png) fs.writeFileSync(path.join(dir, '3-setup-window.png'), Buffer.from(png, 'base64'));
      }
      await shot('4-after-create-clicked');
    }
  } finally {
    await app.close().catch(() => {});
    srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
