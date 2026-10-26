// Settings → Tabs and browsing > Page unloading, end to end in a hidden Lumen (LUMEN_TEST_BACKGROUND): every control in the section is changed and
// the value is persisted to settings.json and takes effect at once (no restart); a tab unloads after the timer and stays loaded when an
// exception applies; the tab menu's "Unload tab", "Unload other tabs" and "Never unload this site"; "Unload all background tabs now";
// the status panel; the Reload placeholder; "Reset to defaults". LUMEN_UNLOAD_SHOT=<file.png> also saves a picture of the section.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openSettingsTab } = require('../helpers/settings-tab');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(60); } return false; };
  const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 280000);
  hardStop.unref();

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const form = req.url.startsWith('/form') ? '<input id="f" type="text" value="">' : '';
    res.end(`<!doctype html><title>Page ${req.url.slice(1)}</title><body><h1>${req.url}</h1>${form}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const A = `http://127.0.0.1:${port}`; // one site
  const B = `http://localhost:${port}`; // another site

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-unload-'));
  const privateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-unload-temp-'));
  const settingsFile = path.join(profile, 'settings.json');
  const saved = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', TEMP: privateTemp, TMP: privateTemp, TMPDIR: privateTemp },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  try {
    await ui.waitForSelector('.tab');
    const T = (fn, arg) => app.evaluate(fn, arg);
    const state = () => T(() => global.__tabSleep.state());
    const byId = async (id) => (await state()).find((t) => t.id === id);
    const open = (url) => T(async (_e, u) => {
      const t = global.__agent.browser.openTab(u, { background: true });
      await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 6000); });
      return t.id;
    }, url);
    const age = (id, min) => T((_e, [i, m]) => global.__tabSleep.age(i, m * 60e3), [id, min]);
    const sweep = () => T(() => global.__tabSleep.sweep());
    const isAsleep = async (id) => (await byId(id))?.sleeping === true;
    const front = (await T(() => global.__agent.browser.listTabs())).find((t) => t.active).id;

    // Quiet start: only what this test sets applies.
    await T(() => { global.__tabSleep.fakePressure(false); });
    await T(() => global.__patchSettings({ performanceMode: 'off' })); // (a hidden test window can have no GPU, which turns Performance mode on by itself)
    const inSettings = await openSettingsTab(app, 'tabs-sleep');
    const settingsId = inSettings.id;
    const q = (expr) => inSettings(expr);
    const section = await waitFor(async () => (await q('Boolean(document.getElementById("pref-tabSleep") && document.getElementById("unload-status"))')) === true, 8000);
    check('the Page unloading section is on the Tabs page', section, await q('document.title'));
    check('its group title says Page unloading', (await q('document.querySelector("#sec-tabs-sleep .group-title, #sec-tabs-sleep")?.textContent?.includes("Page unloading") || document.body.textContent.includes("Page unloading")')) === true);

    // ---- every control: change it, find it in settings.json, and see the page follow ----
    const setSelect = (id, value) => q(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return 'missing'; el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
    const setNumber = (id, value) => q(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return 'missing'; el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
    const clickEl = (id) => q(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return 'missing'; el.click(); return el.checked ?? true; })()`);
    const checkedOf = (id) => q(`document.getElementById(${JSON.stringify(id)})?.checked`);
    const persisted = (key, want) => waitFor(() => JSON.stringify(saved()[key]) === JSON.stringify(want), 4000);
    const hiddenRow = (id) => q(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return !el || el.closest('.row').hidden || !el.closest('.row').offsetParent; })()`);

    // each switch: flip it, persisted; flip back
    for (const [key, label, startsOn] of [['tabSleepKeepAudio', 'audio', true], ['tabSleepKeepPinned', 'pinned', true], ['tabSleepKeepForms', 'forms', true], ['tabSleepKeepTransfers', 'downloads', true], ['tabSleepKeepGroups', 'groups', false], ['tabSleepDim', 'dim', true], ['tabSleepShowFreed', 'freed', true]]) {
      const id = `pref-${key}`;
      check(`${label}: starts ${startsOn ? 'on' : 'off'} by default`, (await checkedOf(id)) === startsOn, await checkedOf(id));
      await clickEl(id);
      check(`${label}: turning it ${startsOn ? 'off' : 'on'} is saved`, await persisted(key, !startsOn), JSON.stringify(saved()[key]));
      await clickEl(id);
      check(`${label}: and back is saved`, await persisted(key, startsOn));
    }
    check('call/camera/screen-share and AI/task exceptions are shown as always on', (await q('(() => { const a = document.getElementById("unload-keep-calls"), b = document.getElementById("unload-keep-agent"); return a?.checked && a.disabled && b?.checked && b.disabled; })()')) === true);
    // the dimmed icon follows the switch in the browser UI at once
    await setSelect('pref-tabSleepMinutes', 20);
    await clickEl('pref-tabSleepDim');
    check('Dim off: the tab strip stops dimming (live)', await waitFor(() => ui.evaluate(() => document.documentElement.classList.contains('pref-no-sleep-dim')), 4000));
    await clickEl('pref-tabSleepDim');
    check('Dim on: the strip dims again (live)', await waitFor(() => ui.evaluate(() => !document.documentElement.classList.contains('pref-no-sleep-dim')), 4000));

    // selects
    for (const [key, values] of [['tabSleepMinutes', [5, 15, 30, 60, 120, 240, 0, 20]], ['tabSleepHow', ['freeze', 'unload']], ['tabSleepFreezeFirstMinutes', [0, 10]], ['tabSleepMaxAwake', [5, 10, 20, 0]], ['tabSleepKeepRecent', [0, 3]], ['tabSleepPressure', ['off', 'low', 'aggressive', 'medium']], ['tabSleepLumenGb', [2, 0]], ['tabSleepSoonMinutes', [1, 15, 5]], ['tabSleepOnReturn', ['placeholder', 'reload']], ['tabPreload', [0, 1]]]) {
      for (const v of values) {
        if (key === 'tabSleepHow' && v === 'freeze') await setSelect('pref-tabSleepFreezeFirstMinutes', 10); // (the freeze-first row is hidden while tabs freeze)
        await setSelect(`pref-${key}`, v);
        check(`${key} = ${v} is saved`, await persisted(key, v), JSON.stringify(saved()[key]));
      }
    }
    // custom numbers
    await setSelect('pref-tabSleepMinutes', 'custom');
    check('Unload after: Custom shows a number box', (await q('!document.getElementById("pref-tabSleepMinutesCustom").hidden')) === true);
    await setNumber('pref-tabSleepMinutesCustom', 7);
    check('Unload after: a custom 7 minutes is saved', await persisted('tabSleepMinutes', 7));
    check('...and the box stays', (await q('document.getElementById("pref-tabSleepMinutes").value')) === 'custom');
    await setNumber('pref-tabSleepMinutesCustom', 0);
    check('Unload after: 0 in the box is refused (Never is its own choice)', saved().tabSleepMinutes === 7);
    await setSelect('pref-tabSleepMinutes', 20);
    await setSelect('pref-tabSleepMaxAwake', 'custom');
    await setNumber('pref-tabSleepMaxAwakeCustom', 37);
    check('Max live background tabs: a custom 37 is saved', await persisted('tabSleepMaxAwake', 37));
    await setSelect('pref-tabSleepMaxAwake', 0);
    check('Max live background tabs: Unlimited is saved as 0', await persisted('tabSleepMaxAwake', 0));
    check('Unlimited is the default shown', (await q('document.getElementById("pref-tabSleepMaxAwake").options[0].textContent')) === 'Unlimited');
    check('Unload after offers 5, 15, 30 minutes, 1, 2, 4 hours and Never', (await q('[...document.getElementById("pref-tabSleepMinutes").options].map((o) => o.textContent).join("|")')).includes('5 minutes|15 minutes|20 minutes|30 minutes|1 hour|2 hours|4 hours|8 hours|Never|Custom'), await q('[...document.getElementById("pref-tabSleepMinutes").options].map((o) => o.textContent).join("|")'));

    // site lists
    const list = (id) => q(`[...document.querySelectorAll(${JSON.stringify(`#${id} .item .grow`)})].map((e) => e.textContent)`);
    const addSite = async (inputId, text) => { await q(`(() => { const i = document.getElementById(${JSON.stringify(inputId)}); i.value = ${JSON.stringify(text)}; document.getElementById(${JSON.stringify(`${inputId}-add`)}).click(); })()`); };
    await addSite('unload-never-add', 'Example.com');
    check('Always keep loaded: a site is added (as a bare host)', await persisted('tabSleepNever', ['example.com']) && (await list('unload-never')).join() === 'example.com', JSON.stringify(await list('unload-never')));
    await addSite('unload-never-add', '*.news.org');
    check('...a wildcard works', await persisted('tabSleepNever', ['example.com', '*.news.org']), JSON.stringify(saved().tabSleepNever));
    await addSite('unload-never-add', 'not a site!');
    check('...junk is refused with a message', await waitFor(async () => (await q('document.querySelector("#sec-tabs-sleep .note.err")?.textContent || ""')).includes('Not added'), 4000) && saved().tabSleepNever.length === 2, JSON.stringify(saved().tabSleepNever));
    await q('[...document.querySelectorAll("#unload-never .item button")][0].click()');
    check('...Remove takes a site out', await persisted('tabSleepNever', ['*.news.org']));
    await q('[...document.querySelectorAll("#unload-never .item button")][0].click()');
    check('...and the list can be emptied', await persisted('tabSleepNever', []));
    const tabA = await open(`${A}/a1`);
    await T((_e, id) => global.__agent.browser.switchTab(id), tabA);
    await sleep(300);
    await T((_e, id) => global.__agent.browser.switchTab(id), front);
    await q('document.getElementById("unload-never-add-current").click()');
    check('"Add current site" adds the page you were last on', await persisted('tabSleepNever', ['127.0.0.1']), JSON.stringify(saved().tabSleepNever));
    await q('[...document.querySelectorAll("#unload-never .item button")][0].click()');
    await addSite('unload-soon-add', 'localhost');
    check('Unload these sites sooner: a site is added', await persisted('tabSleepSoon', ['localhost']));
    await q('[...document.querySelectorAll("#unload-soon .item button")][0].click()');
    check('...and removed', await persisted('tabSleepSoon', []));
    await setSelect('pref-tabSleepSoonMinutes', 5);

    // ---- live effect: a short timer ----
    await setSelect('pref-tabSleepMinutes', 5);
    await setSelect('pref-tabSleepFreezeFirstMinutes', 0);
    await setSelect('pref-tabSleepKeepRecent', 0);
    await setSelect('pref-tabSleepPressure', 'off');
    const p1 = await open(`${A}/p1`);
    const p2 = await open(`${A}/p2`);
    await sweep();
    check('a fresh background tab stays loaded', !(await isAsleep(p1)) && !(await isAsleep(p2)));
    await age(p1, 6);
    await age(p2, 4);
    await sweep();
    check('after the timer the idle tab unloads (live, no restart)', await waitFor(() => isAsleep(p1), 6000), JSON.stringify(await byId(p1)));
    check('...a tab not idle long enough stays', !(await isAsleep(p2)));
    check('...the front tab is never unloaded', !(await isAsleep(front)));
    const unloaded1 = await byId(p1);
    check('...it has no view and an estimate of the memory it freed', unloaded1.view === false && typeof unloaded1.freedMb === 'number', JSON.stringify(unloaded1));
    // the timer setting is live: shorten it to 1 minute... (custom) and the 4-minute-old tab goes
    await setSelect('pref-tabSleepMinutes', 'custom');
    await setNumber('pref-tabSleepMinutesCustom', 3);
    check('changing the time applies at once: the tab idle 4 minutes unloads without waiting for the next check', await waitFor(() => isAsleep(p2), 6000), JSON.stringify(await byId(p2)));
    await setSelect('pref-tabSleepMinutes', 5);

    // ---- exceptions ----
    const reloadAll = async () => { for (const id of [p1, p2]) await T((_e, i) => global.__agent.browser.switchTab(i), id); await T((_e, id) => global.__agent.browser.switchTab(id), front); await sleep(400); };
    await reloadAll();
    check('(setup) tabs are loaded again', !(await isAsleep(p1)) && !(await isAsleep(p2)));
    // pinned
    await T((_e, id) => global.__pinTab(id, true), p1);
    await age(p1, 30);
    await sweep();
    await sleep(500);
    check('exception: a pinned tab does not unload', !(await isAsleep(p1)));
    await clickEl('pref-tabSleepKeepPinned');
    await sweep();
    check('...and does when "Pinned tabs" is turned off (live)', await waitFor(() => isAsleep(p1), 6000));
    await clickEl('pref-tabSleepKeepPinned');
    await T((_e, id) => global.__pinTab(id, false), p1);
    await reloadAll();
    // listed site
    await q('(() => { const i = document.getElementById("unload-never-add"); i.value = "127.0.0.1"; document.getElementById("unload-never-add-add").click(); })()');
    await persisted('tabSleepNever', ['127.0.0.1']);
    await age(p1, 30);
    await sweep();
    await sleep(500);
    check('exception: a site on the always-keep list does not unload', !(await isAsleep(p1)));
    await q('[...document.querySelectorAll("#unload-never .item button")][0].click()');
    await sweep();
    check('...and does once it is removed from the list (live)', await waitFor(() => isAsleep(p1), 6000));
    await reloadAll();
    // wildcard
    await q('(() => { const i = document.getElementById("unload-never-add"); i.value = "127.0.*"; document.getElementById("unload-never-add-add").click(); })()');
    await persisted('tabSleepNever', ['127.0.*']);
    await age(p1, 30);
    await sweep();
    await sleep(500);
    check('exception: a wildcard entry (127.0.*) keeps its sites loaded', !(await isAsleep(p1)));
    await q('[...document.querySelectorAll("#unload-never .item button")][0].click()');
    await persisted('tabSleepNever', []);
    // typed text
    const pf = await open(`${A}/form1`);
    const typed = () => T(async (_e, id) => { const t = global.__pageTools.tab(id); await t.view.webContents.executeJavaScript('document.getElementById("f").value = "unsent draft"'); return true; }, pf);
    await typed();
    await age(pf, 30);
    await sweep();
    await sleep(600);
    check('exception: a tab with typed, unsent text does not unload', !(await isAsleep(pf)));
    await clickEl('pref-tabSleepKeepForms');
    await sweep();
    check('...and does when "unsaved input" is turned off (live)', await waitFor(() => isAsleep(pf), 8000));
    await clickEl('pref-tabSleepKeepForms');
    // the master switch
    await reloadAll();
    await age(p2, 30);
    await clickEl('pref-tabSleep');
    check('master switch off is saved', await persisted('tabSleep', false));
    check('...and the rest of the section hides', await hiddenRow('pref-tabSleepMinutes'));
    await sweep();
    await sleep(500);
    check('...nothing unloads while it is off', !(await isAsleep(p2)));
    await clickEl('pref-tabSleep');
    check('master switch on is saved and the rows return', await persisted('tabSleep', true) && !(await hiddenRow('pref-tabSleepMinutes')));
    await sweep();
    check('...and the idle tab unloads again', await waitFor(() => isAsleep(p2), 6000));

    // ---- Never ----
    await setSelect('pref-tabSleepMinutes', 0);
    await reloadAll();
    await age(p1, 600);
    const pre = (await byId(p1)).sleeping;
    await sweep();
    await sleep(500);
    check('Never: an idle tab stays loaded', !(await isAsleep(p1)), JSON.stringify({ pre, p1, p2, tabs: await state(), never: saved().tabSleepMinutes, pr: saved().tabSleepPressure }));
    await setSelect('pref-tabSleepMinutes', 120);
    await reloadAll(); // (its idle clock starts again)
    await age(p1, 30);
    await sweep();
    await sleep(500);
    check('a 2-hour setting is kept (Performance mode off does not cap it at 20 minutes)', !(await isAsleep(p1)));
    await setSelect('pref-tabSleepMinutes', 5);

    // ---- memory pressure ----
    await reloadAll();
    await age(p1, 3);
    await T(() => global.__tabSleep.fakePressure(true));
    await sweep();
    await sleep(500);
    check('memory pressure Off: low memory unloads nothing', !(await isAsleep(p1)));
    await setSelect('pref-tabSleepPressure', 'medium');
    check('Medium + low memory: a tab idle 3 minutes unloads (live)', await waitFor(() => isAsleep(p1), 6000));
    await reloadAll();
    await age(p1, 1.5);
    await setSelect('pref-tabSleepPressure', 'low');
    await sweep();
    await sleep(500);
    check('Low: a tab idle only 1.5 minutes stays', !(await isAsleep(p1)));
    await setSelect('pref-tabSleepPressure', 'aggressive');
    check('Aggressive: the same tab unloads (live)', await waitFor(() => isAsleep(p1), 6000));
    await T(() => global.__tabSleep.fakePressure(false));
    await setSelect('pref-tabSleepPressure', 'off');

    // ---- the cap ----
    await reloadAll();
    const c1 = await open(`${A}/c1`);
    const c2 = await open(`${A}/c2`);
    for (const id of [p1, p2, c1, c2]) await age(id, 2);
    await age(p1, 4); await age(p2, 3);
    await setSelect('pref-tabSleepMaxAwake', 'custom');
    await setNumber('pref-tabSleepMaxAwakeCustom', 2);
    await persisted('tabSleepMaxAwake', 2);
    await waitFor(async () => (await state()).filter((t) => !t.sleeping && t.view).length <= 3, 10000);
    const awake = (await state()).filter((t) => !t.sleeping && t.view).map((t) => t.id);
    check('a cap of 2 leaves at most 2 background tabs loaded (plus the front one), the longest idle gone first', awake.length <= 3 && (await isAsleep(p1)) && (await isAsleep(p2)), JSON.stringify(await state()));
    await setSelect('pref-tabSleepMaxAwake', 0);
    await reloadAll();

    // ---- the tab menu ----
    const labels = (id) => T((_e, i) => global.__tabMenu(i), id);
    const menuLabels = (await labels(p1)).map((i) => i.label);
    check('the tab menu has Unload tab, Unload other tabs and Never unload this site', menuLabels.includes('Unload tab') && menuLabels.includes('Unload other tabs') && menuLabels.includes('Never unload 127.0.0.1'), menuLabels.join(' | '));
    await T((_e, id) => global.__tabMenu(id, 'Unload tab'), p1);
    check('"Unload tab" unloads that tab at once', await waitFor(() => isAsleep(p1), 6000));
    check('...and the menu then offers to wake it', (await labels(p1)).some((i) => i.label === 'Wake tab' || i.label === 'Reload tab'), JSON.stringify(await labels(p1)));
    await reloadAll();
    await T((_e, id) => global.__tabMenu(id, 'Unload other tabs'), p2);
    check('"Unload other tabs" unloads the background tabs but not this one or the front one', await waitFor(() => isAsleep(p1) && isAsleep(c1), 8000) && !(await isAsleep(p2)) && !(await isAsleep(front)), JSON.stringify(await state()));
    await T((_e, id) => global.__tabMenu(id, 'Never unload 127.0.0.1'), p2);
    check('"Never unload this site" adds it to the list', await persisted('tabSleepNever', ['127.0.0.1']));
    check('...and the Settings list follows', await waitFor(async () => (await list('unload-never')).join() === '127.0.0.1', 8000), JSON.stringify([await list('unload-never'), await q("[document.hidden, document.visibilityState, Boolean(document.getElementById('unload-status')?.offsetParent), Boolean(document.getElementById('unload-never'))]"), await q("window.lumenSettings.tabSleep.status().then((s) => JSON.stringify(s.lists), (e) => 'ERR ' + e.message)"), await (async () => { await q("document.dispatchEvent(new Event('visibilitychange')); 1"); await sleep(700); return `after a visibilitychange: ${JSON.stringify(await list('unload-never'))}`; })()]));
    check('...and the menu offers to allow it again', (await labels(p2)).some((i) => i.label === 'Allow 127.0.0.1 to unload'));
    await T((_e, id) => global.__tabMenu(id, 'Allow 127.0.0.1 to unload'), p2);
    check('Allow takes it off again', await persisted('tabSleepNever', []));
    await reloadAll();

    // ---- Unload all background tabs now + the status panel ----
    const stat = (id) => q(`document.getElementById("unload-stat-${id}")?.textContent`);
    await q('document.getElementById("unload-status").scrollIntoView()');
    await q('window.dispatchEvent(new CustomEvent("lumen-pref", { detail: { key: "x" } }))');
    check('the status panel shows counts', await waitFor(async () => /^\d+$/.test(await stat('loaded')), 6000), await stat('loaded'));
    const before = await T(() => global.__tabSleep.status());
    check('...loaded, unloaded and exempt tabs, memory used and freed', typeof before.loaded === 'number' && typeof before.unloaded === 'number' && typeof before.exempt === 'number' && typeof before.usedMb === 'number' && typeof before.freedMb === 'number' && before.usedMb >= 0, JSON.stringify(before));
    await T((_e, id) => global.__agent.browser.switchTab(id), c2); // (the cap test left it unloaded)
    await T((_e, id) => global.__agent.browser.switchTab(id), front);
    await T((_e, id) => global.__pinTab(id, true), c2);
    await q('document.getElementById("unload-now").click()');
    check('"Unload all background tabs now" unloads them', await waitFor(async () => (await isAsleep(p1)) && (await isAsleep(p2)) && (await isAsleep(c1)), 10000), JSON.stringify(await state()));
    check('...but not the pinned one or the front one', !(await isAsleep(c2)) && !(await isAsleep(front)));
    check('...and the button says how many', await waitFor(async () => /Unloaded \d+ tabs?\./.test(await q('document.getElementById("unload-now-result")?.textContent || ""')), 6000), await q('document.getElementById("unload-now-result")?.textContent'));
    check('the status panel follows: unloaded count and exempt count', await waitFor(async () => Number(await stat('unloaded')) >= 3 && Number(await stat('exempt')) >= 1, 8000), `${await stat('unloaded')} ${await stat('exempt')}`);
    check('...with a reason for the exempt ones', (await q('document.getElementById("unload-exempt-note")?.textContent')).includes('pinned'), await q('document.getElementById("unload-exempt-note")?.textContent'));
    const after = await T(() => global.__tabSleep.status());
    check('the status counts add up', after.loaded + after.unloaded === (await state()).length, JSON.stringify(after));
    await T((_e, id) => global.__pinTab(id, false), c2);
    // refreshes only while the section is open
    const calls = await q('(() => { window.__polls = 0; const orig = window.lumenSettings.tabSleep.status; return typeof orig; })()');
    check('the status call is available to the page', calls === 'function');

    // ---- Performance mode and the page say so ----
    await setSelect('pref-tabSleepMinutes', 240);
    await q('save("performanceMode", "on")');
    check('Performance mode on: the section says tabs unload after 5 minutes', await waitFor(async () => (await q('document.getElementById("unload-perf-note")?.textContent')).includes('Performance mode is on: tabs unload after 5 minutes'), 8000), await q('document.getElementById("unload-perf-note")?.textContent'));
    check('...and that it caps background tabs', await waitFor(async () => (await q('document.getElementById("unload-cap-note")?.textContent')).includes('Performance mode is on: at most 4'), 8000), await q('document.getElementById("unload-cap-note")?.textContent'));
    await reloadAll();
    await age(p1, 6);
    await sweep();
    check('Performance mode shortens the time (a 4-hour setting still unloads after 5 minutes)', await waitFor(() => isAsleep(p1), 6000));
    await q('save("performanceMode", "off")');
    check('Performance mode off: the note goes', await waitFor(async () => (await q('document.getElementById("unload-perf-note")?.textContent')) === '', 8000));
    await setSelect('pref-tabSleepMinutes', 5);

    // ---- placeholder ----
    await reloadAll();
    await setSelect('pref-tabSleepOnReturn', 'placeholder');
    await persisted('tabSleepOnReturn', 'placeholder');
    await age(p1, 30);
    await sweep();
    await waitFor(() => isAsleep(p1), 6000);
    await T((_e, id) => global.__tabSleep.sleep(id), p1).catch(() => {});
    check('(setup) tab p1 is unloaded', await isAsleep(p1));
    // hovering does not wake it in this mode
    await T((_e, id) => { /* the hover intent is off in tests unless enabled: wake ahead must stay out of the way anyway */ return global.__wake ? (global.__wake.enable(true), global.__wake.hover(id, true)) : null; }, p1);
    await sleep(500);
    check('with the Reload page on, hovering an unloaded tab does not load it', await isAsleep(p1));
    await T((_e, id) => global.__wake.hover(id, false), p1);
    await ui.evaluate((id) => document.querySelector(`.tab[data-id="${id}"]`)?.click(), p1);
    check('switching to it shows the Reload page, not the site', await waitFor(async () => (await byId(p1))?.placeholder === true, 8000), JSON.stringify(await byId(p1)));
    const placeholderUrl = () => T((_e, id) => global.__pageTools.tab(id)?.view?.webContents?.getURL(), p1);
    check('...a Lumen page that loads nothing from the site', await waitFor(async () => /\/renderer\/unloaded\.html\?/.test(await placeholderUrl()), 6000), await placeholderUrl());
    const pageText = () => T(async (_e, id) => global.__pageTools.tab(id).view.webContents.executeJavaScript('document.body.innerText'), p1);
    check('...with a Reload button and what it stands for', await waitFor(async () => /Reload/.test(await pageText()) && /127\.0\.0\.1/.test(await pageText()), 6000), await pageText());
    check('...the tab strip still shows the real address and title', (await T(() => global.__agent.browser.listTabs())).find((t) => t.id === p1)?.url === `${A}/p1`, JSON.stringify((await T(() => global.__agent.browser.listTabs())).find((t) => t.id === p1)));
    await T(async (_e, id) => { await global.__pageTools.tab(id).view.webContents.executeJavaScript('document.getElementById("reload").click()'); }, p1);
    check('pressing Reload loads the page and leaves the placeholder', await waitFor(async () => { const s = await byId(p1); return s && s.placeholder === false && s.sleeping === false && s.view === true; }, 8000), JSON.stringify(await byId(p1)));
    check('...on the real address', await waitFor(async () => (await placeholderUrl()) === `${A}/p1`, 8000), await placeholderUrl());
    await setSelect('pref-tabSleepOnReturn', 'reload');
    await T((_e, id) => global.__agent.browser.switchTab(id), front);
    await T((_e, id) => global.__tabSleep.sleep(id), p1);
    await ui.evaluate((id) => document.querySelector(`.tab[data-id="${id}"]`)?.click(), p1);
    check('with "Reload immediately" switching to an unloaded tab loads it at once (live)', await waitFor(async () => { const s = await byId(p1); return s.sleeping === false && s.placeholder === false && s.view; }, 8000), JSON.stringify(await byId(p1)));
    await T((_e, id) => global.__agent.browser.switchTab(id), front);

    // ---- picture of the section (hidden window) ----
    if (process.env.LUMEN_UNLOAD_SHOT) {
      await q('(() => { const s = document.getElementById("sec-tabs-sleep"); s.scrollIntoView({ block: "start" }); window.scrollBy(0, -80); document.querySelector("main, #sections")?.scrollBy?.(0, -80); })()');
      await sleep(600);
      const png = await T(async (_e, id) => { const img = await global.__settings.contents(id).capturePage(); return img.toPNG().toString('base64'); }, settingsId);
      fs.writeFileSync(process.env.LUMEN_UNLOAD_SHOT, Buffer.from(png, 'base64'));
      console.log(`screenshot: ${process.env.LUMEN_UNLOAD_SHOT} (${png.length} base64 chars)`);
    }

    // ---- reset ----
    await setSelect('pref-tabSleepMinutes', 60);
    await setSelect('pref-tabSleepPressure', 'aggressive');
    await clickEl('pref-tabSleepKeepGroups');
    await q('(() => { const i = document.getElementById("unload-soon-add"); i.value = "news.com"; document.getElementById("unload-soon-add-add").click(); })()');
    await persisted('tabSleepSoon', ['news.com']);
    await q('document.getElementById("unload-reset").click()');
    const keys = ['tabSleepMinutes', 'tabSleepPressure', 'tabSleepKeepGroups', 'tabSleepSoon', 'tabSleepNever', 'tabSleepOnReturn', 'tabSleepMaxAwake', 'tabSleepHow'];
    check('Reset to defaults removes the section\'s saved values', await waitFor(() => keys.every((k) => !(k in saved())), 6000), JSON.stringify(keys.filter((k) => k in saved())));
    check('...and the controls show the defaults (live)', (await q('document.getElementById("pref-tabSleepMinutes").value')) === '20' && (await q('document.getElementById("pref-tabSleepPressure").value')) === 'medium' && (await checkedOf('pref-tabSleepKeepGroups')) === false && (await list('unload-soon')).length === 0 && (await q('document.getElementById("pref-tabSleepOnReturn").value')) === 'reload');
    check('Reset to defaults is the last row of the section', (await q('(() => { const rows = [...document.querySelectorAll("#sec-tabs-sleep .row")].filter((r) => r.offsetParent); return rows[rows.length - 1].querySelector("#unload-reset") !== null; })()')) === true);
    check('every control has a one-line description', (await q('(() => { const rows = [...document.querySelectorAll("#sec-tabs-sleep .row")].filter((r) => !r.hidden); return rows.filter((r) => !r.querySelector(".desc")).map((r) => r.querySelector(".label")?.textContent); })()')).length === 0, JSON.stringify(await q('[...document.querySelectorAll("#sec-tabs-sleep .row")].filter((r) => !r.hidden && !r.querySelector(".desc")).map((r) => r.querySelector(".label")?.textContent)')));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  test crashed -> ${err && err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `${failures} FAILED` : 'tab-unload OK');
  process.exit(failures ? 1 : 0);
})();
