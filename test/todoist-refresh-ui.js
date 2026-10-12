// The Todoist card's Refresh button on the new-tab page, in a real window (off-screen, throwaway profile) against a stand-in Todoist
// over local https: a press right after a load is a real request, the button turns and is off while it runs and a second press joins
// the run (one request), a press with the old list showing replaces it (or keeps it under a warning when Todoist is down), and Try again on
// a card that has no list asks again and loads it. (The unit side is test/widget-refresh-press-units.js.)
'use strict';
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const TOKEN = 'tok_0123456789abcdef0123456789abcdef';

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-todoist-refresh-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the browser checks: openssl isn't available (${err.message})`);
    process.exit(0);
  }
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const srv = { tasks: ['Water plants'], fail: false, gate: null, asks: 0 };
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'Unauthorized' });
    if (u.pathname === '/todoist/projects') return json(200, { results: [{ id: 'p1', name: 'Home', color: 'red' }], next_cursor: null });
    if (u.pathname === '/todoist/tasks/filter') {
      srv.asks++;
      if (srv.gate) await srv.gate;
      if (srv.fail) return json(503, { error: 'busy' });
      return json(200, { results: srv.tasks.map((t, i) => ({ id: String(100 + i), content: t, priority: 1, project_id: 'p1', labels: [], due: { date: ymd }, child_order: i })), next_cursor: null });
    }
    return json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-todoist-refresh-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, b) => { global.__widgetEndpoints = { todoist: `${b}/todoist` }; global.__widgetRateMax = 5000; }, base);
    const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
    const saved = await W('save', { type: 'todoist', token: TOKEN, todo: { source: 'all', max: 0 } });
    const id = saved.widget.id;
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__homeTab = t; });
    const inTab = (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js);
    const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await inTab(code).catch(() => false)) return true; await sleep(100); } return false; };
    const card = `document.querySelector('.w-card[data-id="${id}"]')`;
    const btn = `${card}?.querySelector('.w-refresh')`;
    const text = () => inTab(`${card}?.textContent || ''`);

    check('the card shows its list', await waitFor(`(${card}?.textContent || '').includes('Water plants')`), await text());
    check('...with a Refresh button that is on and not turning', await inTab(`(() => { const b = ${btn}; return Boolean(b) && !b.disabled && !b.classList.contains('spinning'); })()`), '');

    // 1. right after a load (well inside the 15 s floor), with a new task on the server
    srv.tasks = ['Water plants', 'Call Sam'];
    const asks0 = srv.asks;
    let open;
    srv.gate = new Promise((r) => { open = r; });
    await inTab(`${btn}.click()`);
    check('a press right after a load asks Todoist again', await (async () => { for (let i = 0; i < 40 && srv.asks === asks0; i++) await sleep(100); return srv.asks === asks0 + 1; })(), String(srv.asks - asks0));
    check('...the button turns and is off while Todoist has not answered', await waitFor(`(() => { const b = ${btn}; return Boolean(b) && b.disabled && b.classList.contains('spinning') && b.getAttribute('aria-busy') === 'true'; })()`), await inTab(`${btn}?.outerHTML`));
    // 2. a second press during the run joins it (the button is off; a forced click and a direct action are both one request)
    await inTab(`${btn}.click(); widgetAct('${id}', 'refresh');`);
    await sleep(600);
    check('a second press during the run joins it: still one request', srv.asks === asks0 + 1, String(srv.asks - asks0));
    open(); srv.gate = null;
    check('when Todoist answers the new task shows and the button is back on', await waitFor(`(${card}?.textContent || '').includes('Call Sam') && !${btn}.disabled && !${btn}.classList.contains('spinning')`), `${await text()} | ${await inTab(`${btn}?.outerHTML`)}`);

    // 3. with the list showing and Todoist down: the list stays, a warning says why; then a press after it is back replaces the list
    srv.fail = true;
    await inTab(`${btn}.click()`);
    check('Todoist down: the old list stays on the card with a warning, and the button is back on', await waitFor(`(${card}?.textContent || '').includes('Call Sam') && Boolean(${card}.querySelector('.w-foot.warn')) && !${btn}.disabled`), `${await text()} | ${await inTab(`${btn}?.outerHTML`)}`);
    srv.fail = false;
    srv.tasks = ['Call Sam', 'Buy milk'];
    await sleep(1100);
    await inTab(`${btn}.click()`);
    check('a press after it is back (old list showing) replaces the list and clears the warning', await waitFor(`(${card}?.textContent || '').includes('Buy milk') && !${card}.querySelector('.w-foot.warn')`), await text());

    // 4. a card with no list and an error: Try again asks again at once
    srv.fail = true;
    await app.evaluate((_e, i) => { global.__widgets.cache.delete(i); return global.__widgets.refresh(global.__widgets.list().find((w) => w.id === i), { force: true }); }, id);
    check('with no list and Todoist down the card says it could not update and offers Try again', await waitFor(`Boolean(${card}?.querySelector('.w-actions .w-btn')) && /Try again/.test(${card}.textContent)`), await text());
    srv.fail = false;
    srv.tasks = ['Back again'];
    const asks1 = srv.asks;
    await inTab(`[...${card}.querySelectorAll('.w-btn')].find((b) => /Try .*again|Trying/.test(b.textContent)).click()`);
    check('Try again asks Todoist at once and the list loads', await waitFor(`(${card}?.textContent || '').includes('Back again')`) && srv.asks > asks1, `${await text()} asks ${srv.asks - asks1}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
