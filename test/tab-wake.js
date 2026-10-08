// Waking tabs faster (main.js: wake ahead on hover and press, background preload, freeze first). There is no picture of
// the page while a tab wakes. Runs Lumen in a hidden window (LUMEN_TEST_BACKGROUND): a woken tab shows the live page, with
// nothing laid over it; hover and press wake a placeholder ahead (not a quick pass-over); preload wakes the neighbours up
// to the cap; an idle tab is frozen first when that is set; the old tab-snapshots folder is removed at startup.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };
  const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 180000);

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const n = req.url.slice(1);
    const field = /^pw/.test(n) ? '<input type="password" value="">' : '';
    setTimeout(() => res.end(`<!doctype html><title>Wake ${n}</title><body style="font:20px sans-serif;background:#cde"><h1>Wake ${n}</h1>${field}${'<p>text</p>'.repeat(200)}</body>`), 120);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-wake-'));
  const urls = [0, 1, 2, 3, 4, 5].map((i) => `${base}/${i}`).concat([`${base}/login`, `${base}/pw1`]);
  fs.mkdirSync(path.join(profile, 'tab-snapshots'), { recursive: true }); fs.writeFileSync(path.join(profile, 'tab-snapshots', 'old.jpg'), 'x'); // (what an older build left)
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ tabSnapshots: true, tabPreload: 1, tabSleepMinutes: 5, tabSleepFreezeFirstMinutes: 10, session: { urls, titles: urls.map((u, i) => `Wake ${i}`), favicons: urls.map(() => null), active: 0, groupIds: urls.map(() => null), pinned: urls.map(() => false) } }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  try {
    await ui.waitForSelector('.tab');
    const state = () => app.evaluate(() => global.__wake.state());
    const byUrl = async (path_) => (await state()).find((t) => t.url === `${base}${path_}`);
    const idOf = async (p) => (await byUrl(p))?.id;
    const clickTab = (id) => ui.evaluate((id) => document.querySelector(`.tab[data-id="${id}"]`)?.click(), id);
    const loaded = (id) => waitFor(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getType() === 'webview' || w.getType() === 'browserView').every((w) => !w.isLoading())));

    check('off in tests unless asked: only the front tab has a page', (await state()).filter((t) => !t.sleeping).length === 1);
    check('the folder of old wake pictures is removed at startup', await waitFor(() => !fs.existsSync(path.join(profile, 'tab-snapshots')), 3000), 'still there');
    check('...and the old setting is dropped from settings.json', !('tabSnapshots' in JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'))));
    await app.evaluate(() => global.__wake.enable(true));
    await sleep(2500); // the front page has loaded

    // ---- an unloaded tab wakes with no picture laid over it ----
    const t1 = await idOf('/1');
    await clickTab(t1);
    check('(setup) tab 1 loads', await waitFor(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => /\/1$/.test(w.getURL()) && !w.isLoading())), 10000));
    const t0 = await idOf('/0');
    await clickTab(t0);
    await app.evaluate((_e, id) => global.__tabSleep.sleep(id), t1);
    const byId = async (id) => (await state()).find((t) => t.id === id);
    check('(setup) tab 1 is unloaded', (await byId(t1)).sleeping === true);
    await clickTab(t1);
    check('switching to it wakes it', (await byId(t1)).sleeping === false);
    check('...with nothing laid over the page area', !(await ui.evaluate(() => Boolean(document.querySelector('.wake-cover, .page-snapshot')))), 'covered');
    check('...the real page loads', await waitFor(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => /\/1$/.test(w.getURL()) && !w.isLoading())), 8000), JSON.stringify(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => [w.getURL(), w.isLoading()])), null, 0));
    check('no wake pictures are taken or kept', !fs.existsSync(path.join(profile, 'tab-snapshots')), 'folder is back');
    await clickTab(t0);

    // ---- hover and press wake a placeholder ahead ----
    for (const t of await state()) if (t.id !== t0 && !t.sleeping) await app.evaluate((_e, id) => global.__tabSleep.sleep(id), t.id); // (the sleep cap and memory are what hover respects: start with none awake)
    await sleep(300);
    const t2 = await idOf('/2');
    await app.evaluate((_e, id) => global.__wake.hover(id, true), t2);
    await sleep(60);
    await app.evaluate((_e, id) => global.__wake.hover(id, false), t2);
    await sleep(300);
    check('a quick pass over a tab wakes nothing', (await byUrl('/2')).sleeping === true, JSON.stringify(await byUrl('/2')));
    await app.evaluate((_e, id) => global.__wake.hover(id, true), t2);
    check('resting the pointer on it wakes it (100 ms)', await waitFor(async () => (await byUrl('/2')).sleeping === false, 2000), JSON.stringify(await byUrl('/2')));
    check('...in the background (the front tab stays in front)', await ui.evaluate(() => document.querySelector('.tab.active')?.dataset.id) === String(t0));
    const t3 = await idOf('/3');
    await app.evaluate((_e, id) => global.__wake.down(id), t3);
    check('pressing on a tab wakes it at once', await waitFor(async () => (await byUrl('/3')).sleeping === false, 2000), JSON.stringify(await byUrl('/3')));
    check('...marked as woken ahead', (await byUrl('/3')).wokeAhead === 'down' && (await byUrl('/2')).wokeAhead === 'hover');
    // memory pressure: a hover does not wake
    const t4 = await idOf('/4');
    await app.evaluate(() => global.__tabSleep.fakePressure(true));
    await app.evaluate((_e, id) => global.__wake.hover(id, true), t4);
    await sleep(500);
    check('under memory pressure a hover wakes nothing', (await byUrl('/4')).sleeping === true, JSON.stringify(await byUrl('/4')));
    await app.evaluate((_e, id) => global.__wake.hover(id, false), t4);
    await app.evaluate(() => global.__tabSleep.fakePressure(false));

    // ---- background preload: the neighbours, up to the cap (1), one at a time ----
    for (const t of await state()) if (t.id !== t0 && !t.sleeping) await app.evaluate((_e, id) => global.__tabSleep.sleep(id), t.id);
    await clickTab(t0);
    await sleep(500);
    await app.evaluate(() => global.__wake.preload());
    const st = await state();
    const pre = st.filter((t) => t.preloaded);
    check('preload wakes one tab (the cap), the one next to the front tab', pre.length === 1 && pre[0].id === st[1].id, JSON.stringify([pre, st]));
    check('...and not the others', st.filter((t) => !t.sleeping).length === 2, JSON.stringify(st.map((t) => [t.id, t.sleeping])));
    const wc = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.isAudioMuted()).length);
    check('...muted while it waits', wc >= 1, String(wc));
    // under memory pressure it stops
    await app.evaluate((_e, id) => global.__tabSleep.sleep(id), pre[0].id);
    await app.evaluate(() => global.__tabSleep.fakePressure(true));
    await app.evaluate(() => global.__wake.preload());
    check('memory pressure stops the preload', (await state()).filter((t) => t.preloaded).length === 0);
    await app.evaluate(() => global.__tabSleep.fakePressure(false));

    // ---- freeze first ----
    await app.evaluate((_e, id) => global.__wake.down(id), t2); // awake in the background, then idle for 6 minutes (the setting here: sleep after 5)
    await waitFor(async () => (await byUrl('/2')).sleeping === false, 3000);
    await loaded();
    // (the sweep's own idle test can't run here: a hidden test window counts every tab as captured) frozen the way the freeze-first rule does it:
    check('freezing works', await app.evaluate((_e, id) => global.__tabSleep.freeze(id), t2) === true);
    await app.evaluate((_e, id) => global.__wake.markFrozenFirst(id), t2);
    await app.evaluate(() => global.__tabSleep.sweep());
    let f = await byUrl('/2');
    check('a tab frozen first stays frozen before the time is up', f.frozen === true && f.frozenFirst === true && f.sleeping === false, JSON.stringify(f));
    await app.evaluate((_e, id) => global.__wake.ageFrozen(id, 11 * 60e3), t2);
    await app.evaluate(() => global.__tabSleep.sweep());
    f = await byUrl('/2');
    check('after the time it unloads', f.sleeping === true && f.frozen === false, JSON.stringify(f));
    await app.evaluate((_e, id) => global.__tabSleep.age(id, 0), t2);

    check('the UI had no errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
    server.close();
    clearTimeout(hardStop);
  }
  console.log(failures ? `${failures} FAILED` : 'tab-wake OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
