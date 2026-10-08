// Waking tabs faster (main.js: captureSnapshot / showCover, wake ahead on hover and press, background preload, freeze first).
// Runs Lumen in a hidden window (LUMEN_TEST_BACKGROUND): a picture is taken when a tab is left and shown over the page area
// when a slept tab is switched to, until it paints; none for sign-in addresses or pages with a password field; hover and
// press wake a placeholder ahead (not a quick pass-over); preload wakes the neighbours up to the cap; clearing history
// clears the pictures; an idle tab is frozen first when that is set.
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
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ tabPreload: 1, tabSleepMinutes: 5, tabSleepFreezeFirstMinutes: 10, session: { urls, titles: urls.map((u, i) => `Wake ${i}`), favicons: urls.map(() => null), active: 0, groupIds: urls.map(() => null), pinned: urls.map(() => false) } }));
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

    check('off in tests unless asked: only the front tab has a page, no pictures', (await state()).filter((t) => !t.sleeping).length === 1 && (await app.evaluate(() => global.__wake.snapshotStats().count)) === 0);
    await app.evaluate(() => global.__wake.enable(true));
    await sleep(2500); // the front page has loaded

    // ---- a picture is taken when a tab is left ----
    const t1 = await idOf('/1');
    await clickTab(t1);
    await waitFor(async () => (await byUrl('/1'))?.painted === true);
    await loaded();
    const t0 = await idOf('/0');
    await clickTab(t0); // leaves tab 1: its picture is taken
    check('leaving a page keeps its picture', await waitFor(() => app.evaluate((_e, u) => global.__wake.hasSnapshot(u), `${base}/1`), 5000), 'none');
    const stats = await app.evaluate(() => global.__wake.snapshotStats());
    check('the picture is small (under 300 KB)', stats.count >= 1 && stats.bytes < 300 * 1024, JSON.stringify(stats));

    // ---- sign-in addresses and pages with a password field: none ----
    for (const [name, p] of [['a /login address', '/login'], ['a page with a password field', '/pw1']]) {
      const id = await idOf(p);
      await clickTab(id); await waitFor(async () => (await byUrl(p))?.painted === true); await loaded(); await sleep(1800);
      await app.evaluate((_e, id) => global.__wake.capture(id), id);
      await clickTab(t0); await sleep(900);
      check(`no picture of ${name}`, !(await app.evaluate((_e, u) => global.__wake.hasSnapshot(u), `${base}${p}`)), 'a picture was kept');
    }

    // ---- an unloaded tab comes back behind its picture ----
    await app.evaluate((_e, id) => global.__tabSleep.sleep(id), t1);
    check('(setup) tab 1 is unloaded', (await byUrl('/1')).sleeping === true);
    await clickTab(t1);
    check('switching to it puts the picture up first', await waitFor(async () => { const m = await app.evaluate(() => global.__wake.last()); return Boolean(m && m.id === t1 && m.coverAt && m.shownAt); }, 4000), JSON.stringify(await app.evaluate(() => global.__wake.last())));
    const mark = await app.evaluate(() => global.__wake.last());
    check('...and the real page paints after, which ends the cover', await waitFor(async () => { const m = await app.evaluate(() => global.__wake.last()); return Boolean(m?.paintAt) && !(await byUrl('/1')).cover; }, 8000), JSON.stringify(mark));
    const m2 = await app.evaluate(() => global.__wake.last());
    check('...the picture was on screen before the page painted', m2.shownAt <= m2.paintAt + 20, JSON.stringify(m2));
    check('the cover is gone from the UI', await waitFor(() => ui.evaluate(() => !document.querySelector('.wake-cover')), 2000), 'still there');

    // ---- a tab with no picture wakes as before (nothing covers it) ----
    const t5 = await idOf('/5');
    await clickTab(t5);
    check('no picture, no cover', (await app.evaluate(() => global.__wake.last())).id !== t5 && !(await ui.evaluate(() => Boolean(document.querySelector('.wake-cover')))), 'covered');
    await waitFor(async () => (await byUrl('/5'))?.painted === true); await loaded();
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
    check('resting the pointer on it wakes it (150 ms)', await waitFor(async () => (await byUrl('/2')).sleeping === false, 2000), JSON.stringify(await byUrl('/2')));
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
    check('preload wakes one tab (the cap), the one next to the front tab', pre.length === 1 && pre[0].id === st[1].id, JSON.stringify(pre));
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
    await waitFor(async () => (await byUrl('/2')).painted === true, 5000);
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

    // ---- clearing the history clears the pictures ----
    check('(setup) there are pictures', (await app.evaluate(() => global.__wake.snapshotStats().count)) >= 1);
    await app.evaluate(() => global.__wake.snapshotClear());
    check('they can all be cleared', (await app.evaluate(() => global.__wake.snapshotStats().count)) === 0);
    check('the UI had no errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
    server.close();
    clearTimeout(hardStop);
  }
  console.log(failures ? `${failures} FAILED` : 'tab-wake OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
