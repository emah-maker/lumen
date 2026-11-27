// Split view across a restart (hidden): two pairs, one in front with its divider moved, are saved with the session and come back paired, the
// divider where it was, both sides of the front pair shown. A session saved by an older Lumen (no `splits`) still loads, its tabs unpaired.
// Windows are invisible (LUMEN_TEST_BACKGROUND); nothing moves the real mouse.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await sleep(100); } };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..', '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' },
  timeout: 90000,
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${req.url}</title><body><p>${req.url}</p></body>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-splitrestore-'));

  const start = async () => {
    const app = await launch(profile);
    const ui = await app.firstWindow({ timeout: 90000 });
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    return { app, ui, errors };
  };
  const quit = async (app) => {
    const proc = app.process();
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    app.evaluate(({ app: a }) => a.quit()).catch(() => {}); // as the user quits: the session is written on the way out
    await Promise.race([exited, sleep(60000)]);
    return proc.exitCode !== null || Boolean(proc.signalCode);
  };
  // The tabs by their page's path (/a, /b, ...): ids are new after a restart.
  const byPath = async (app) => Object.fromEntries((await app.evaluate(() => global.__agent.browser.listTabs())).map((t) => { try { return [new URL(t.url).pathname, t]; } catch { return [String(t.id), t]; } }));
  const state = (app) => app.evaluate(() => global.__split.state());
  const shownIds = (s) => s.views.filter((v) => v.visible).map((v) => v.id).sort((x, y) => x - y).join();

  // ---- 1. two pairs, the divider of the one in front moved ----
  let { app, ui, errors } = await start();
  const open = (url) => app.evaluate(async (_e, url) => {
    const t = global.__agent.browser.openTab(url, { background: true });
    await new Promise((r) => { if (!t.webContents.isLoading()) r(); else t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, url);
  const a = await open(`${base}/a`), b = await open(`${base}/b`), c = await open(`${base}/c`), d = await open(`${base}/d`);
  await app.evaluate((_e, [x, y]) => global.__split.open(x, y), [d, c]); // c | d
  await app.evaluate((_e, [x, y]) => global.__split.open(x, y), [b, a]); // a | b, in front
  await app.evaluate(() => global.__split.ratio(0.35));
  let s = await waitFor(async () => { const x = await state(app); return x.shown ? x : null; });
  check('(setup) a | b shown with the divider moved', Boolean(s) && s.activeId === b && Math.abs(s.pair.ratio - 0.35) < 0.01, JSON.stringify(s?.pair));
  const entry = await app.evaluate(() => global.__split.session());
  const at = (p) => entry.urls.findIndex((u) => u.endsWith(p));
  check('the saved session has both pairs, by position, with their ratios', Array.isArray(entry.splits) && entry.splits.length === 2
    && entry.splits.some((p) => p.left === at('/a') && p.right === at('/b') && Math.abs(p.ratio - 0.35) < 0.01)
    && entry.splits.some((p) => p.left === at('/c') && p.right === at('/d') && p.ratio === 0.5), JSON.stringify({ urls: entry.urls, splits: entry.splits }));
  check('no renderer errors before the quit', errors.length === 0, errors.join('; '));
  check('the first Lumen exited', await quit(app), 'still running after 60 s');

  // ---- 2. the restart brings them back ----
  ({ app, ui, errors } = await start());
  let tabsNow = await waitFor(async () => { const m = await byPath(app); return m['/a'] && m['/b'] && m['/c'] && m['/d'] ? m : null; });
  check('(setup) the four tabs came back', Boolean(tabsNow), JSON.stringify(await byPath(app)));
  const A = tabsNow?.['/a']?.id, B = tabsNow?.['/b']?.id, C = tabsNow?.['/c']?.id, D = tabsNow?.['/d']?.id;
  s = await waitFor(async () => { const x = await state(app); return x.shown && x.views.filter((v) => v.visible).length === 2 ? x : null; });
  check('the pair in front comes back shown, both pages side by side', Boolean(s) && s.activeId === B && s.pair?.left === A && s.pair?.right === B
    && shownIds(s) === [A, B].sort((x, y) => x - y).join(), JSON.stringify(await state(app)));
  check('its divider is where it was', Boolean(s) && Math.abs(s.pair.ratio - 0.35) < 0.01, JSON.stringify(s?.pair));
  const list = await app.evaluate(() => global.__agent.browser.listTabs());
  check('the other pair is paired too (the tab list says which is beside which)', list.find((t) => t.id === C)?.splitWith === D && list.find((t) => t.id === D)?.splitWith === C, JSON.stringify(list.map((t) => [t.id, t.url, t.splitWith])));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), D);
  s = await waitFor(async () => { const x = await state(app); return x.shown && x.activeId === D && x.views.filter((v) => v.visible).length === 2 ? x : null; });
  check('switching to it shows both of its pages (the sleeping side wakes)', Boolean(s) && s.pair.left === C && s.pair.right === D && s.pair.ratio === 0.5 && shownIds(s) === [C, D].sort((x, y) => x - y).join(), JSON.stringify(await state(app)));
  const marks = await waitFor(async () => { const m = await ui.evaluate(() => document.querySelectorAll('.tab.split-left, .tab.split-right').length); return m === 4 ? m : null; });
  check('the strip draws both pairs joined', marks === 4, String(marks));
  check('no renderer errors after the restart', errors.length === 0, errors.join('; '));
  check('the second Lumen exited', await quit(app), 'still running after 60 s');

  // ---- 3. a session from an older Lumen: no `splits` ----
  let stripped = 0;
  const strip = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(strip); return; }
    if ('splits' in o && Array.isArray(o.urls)) { delete o.splits; stripped++; }
    for (const v of Object.values(o)) strip(v);
  };
  for (const f of fs.readdirSync(profile).filter((n) => n.endsWith('.json'))) { // (wherever the session is kept)
    const file = path.join(profile, f);
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const before = stripped;
    strip(json);
    if (stripped > before) fs.writeFileSync(file, JSON.stringify(json, null, 2));
  }
  check('(setup) the saved session had its splits taken out', stripped >= 1, String(stripped));
  ({ app, ui, errors } = await start());
  tabsNow = await waitFor(async () => { const m = await byPath(app); return m['/a'] && m['/b'] && m['/c'] && m['/d'] ? m : null; });
  check('an older session still loads every tab', Boolean(tabsNow), JSON.stringify(await byPath(app)));
  s = await state(app);
  check('…unpaired, one page shown', !s.shown && !s.pair && s.views.filter((v) => v.visible).length === 1 && Object.values(tabsNow || {}).every((t) => !t.splitWith), JSON.stringify(s));
  check('no renderer errors with the older session', errors.length === 0, errors.join('; '));
  await app.close();

  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
