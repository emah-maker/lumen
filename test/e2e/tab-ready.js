// Tabs kept ready (features/tab-ready.js), in a hidden window (LUMEN_TEST_BACKGROUND, a fresh profile, a private TEMP):
//   - the 3 latest background tabs are out of the background state (webContents.backgroundThrottling is false); the tab in front and older tabs are not;
//   - the tab under the pointer is kept ready after a short rest, and let go after the pointer leaves; a press keeps it at once;
//   - "Keep the latest tabs ready" (tabReadyRecent): 0 keeps only the hovered tab, 5 keeps five;
//   - a tab that a run keeps unthrottled is left alone;
//   - a lone switch makes exactly two setVisible calls (show the new, hide the old); a burst of ten makes at most four, and ends on the last tab;
//   - the recorder carries the renderer priority, the idle time and the view calls.
// A hidden window cannot show the Windows efficiency-mode effect itself (every tab of a test window counts as visible), so this proves the
// calls and the limits; scripts/measure/measure-real-switch.js (a visible window, run by hand) measures the effect.
require('../helpers/_tmp-cleanup');
const rig = require('../helpers/_tab-switch-rig');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = rig.sleep;
  const hard = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 4 * 60 * 1000);
  const r = await rig.launchRig({ tabs: 10, chats: 0, widgets: false });
  const { app, ui } = r;
  const click = async (id) => { await ui.evaluate((tab) => document.querySelector(`#tabs .tab[data-id="${tab}"]`).click(), id); await sleep(450); };
  const state = () => app.evaluate(() => global.__tabReady.state());
  const throttling = (id) => app.evaluate((_e, tab) => { const t = global.__aiTabs.tab(tab); return t?.view ? t.view.webContents.backgroundThrottling : null; }, id);
  const ready = async () => { await app.evaluate(() => { global.__tabReady.sync(); }); await sleep(100); return state(); };
  const pointer = (kind, id) => ui.evaluate(({ kind, id }) => {
    const el = document.querySelector(`#tabs .tab[data-id="${id}"]`);
    if (kind === 'down') el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    else el.dispatchEvent(new PointerEvent(kind === 'over' ? 'pointerover' : 'pointerout', { bubbles: true, pointerType: 'mouse' }));
  }, { kind, id });
  try {
    await app.evaluate(() => { global.__tabReady.enable(true); global.__tabReady.battery(false); }); // (a laptop test machine may really be on battery: one tab only)
    // go through tabs 4..9 in order: 9 is in front, 8, 7, 6 are the latest three
    for (const id of r.ids.slice(4)) await click(id);
    await sleep(300);
    const front = r.ids[9];
    const s = await ready();
    const ids = s.map((x) => x.id).sort((a, b) => a - b);
    check('the 3 latest background tabs are kept ready', JSON.stringify(ids) === JSON.stringify(r.ids.slice(6, 9)) && s.every((x) => x.why === 'recent'), JSON.stringify(s));
    check('...their pages report background throttling off', (await Promise.all(r.ids.slice(6, 9).map(throttling))).every((v) => v === false));
    check('the tab in front and an older tab keep the normal state (throttling on)', (await throttling(front)) === true && (await throttling(r.ids[5])) === true);

    // the pointer
    const target = r.ids[5];
    await pointer('over', target);
    await sleep(250);
    check('a pointer resting on a tab keeps it ready (why: hover)', (await state()).some((x) => x.id === target && x.why === 'hover') && (await throttling(target)) === false, JSON.stringify(await state()));
    await pointer('out', target);
    await ui.evaluate(() => document.querySelector('#tabs').dispatchEvent(new PointerEvent('pointerleave')));
    await sleep(400);
    check('...and not at once when the pointer leaves (a 1.5 s grace)', (await state()).some((x) => x.id === target));
    await sleep(1900);
    check('...it is let go after the grace (throttling on again)', !(await state()).some((x) => x.id === target) && (await throttling(target)) === true, JSON.stringify(await state()));
    const other = r.ids[4];
    await pointer('down', other);
    await sleep(150);
    check('a press on a tab keeps it ready at once', (await state()).some((x) => x.id === other && x.why === 'hover'), JSON.stringify(await state()));
    await ui.evaluate(() => document.querySelector('#tabs').dispatchEvent(new PointerEvent('pointerleave')));
    await click(other);
    await sleep(300);
    check('after the click the tab in front is not kept (it is visible)', !(await state()).some((x) => x.id === other) || (await throttling(other)) === true, JSON.stringify(await state()));

    // the setting
    await app.evaluate(() => global.__settings.backend.set('tabReadyRecent', 0));
    await sleep(500);
    check('tabReadyRecent 0: no recent tab is kept (only a hovered one would be)', (await state()).filter((x) => x.why === 'recent').length === 0, JSON.stringify(await state()));
    await app.evaluate(() => global.__settings.backend.set('tabReadyRecent', 5));
    await sleep(500);
    check('tabReadyRecent 5: five are kept', (await state()).filter((x) => x.why === 'recent').length === 5, JSON.stringify(await state()));
    await app.evaluate(() => global.__settings.backend.set('tabReadyRecent', 3));
    await sleep(500);
    check('tabReadyRecent 3: back to three', (await state()).filter((x) => x.why === 'recent').length === 3, JSON.stringify(await state()));

    // on battery: one
    await app.evaluate(() => { global.__tabReady.battery(true); global.__tabReady.sync(); });
    await sleep(300);
    check('on battery only one recent tab is kept (the latest)', (await state()).filter((x) => x.why === 'recent').length === 1, JSON.stringify(await state()));
    await app.evaluate(() => { global.__tabReady.battery(false); global.__tabReady.sync(); });
    await sleep(300);
    check('...and three again on mains power', (await state()).filter((x) => x.why === 'recent').length === 3, JSON.stringify(await state()));

    // view calls
    await sleep(600);
    const calls = () => app.evaluate(() => global.__tabReady.visibleCalls());
    let c0 = await calls();
    await click(r.ids[6]);
    const lone = (await calls()) - c0;
    check('a lone switch makes exactly two setVisible calls (show the new tab, hide the old one)', lone === 2, `${lone}`);
    await sleep(600);
    c0 = await calls();
    const burst = await ui.evaluate((list) => { for (const id of list) document.querySelector(`#tabs .tab[data-id="${id}"]`).click(); return list[list.length - 1]; }, [r.ids[1], r.ids[2], r.ids[3], r.ids[4], r.ids[5], r.ids[7], r.ids[8], r.ids[9], r.ids[7], r.ids[8]]);
    await sleep(900);
    const total = (await calls()) - c0;
    const active = await app.evaluate(() => global.__agent.browser.activeTab()?.id);
    const vis = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents && v.getVisible()).length);
    check('a burst of ten switches makes at most four setVisible calls, not twenty', total <= 4, `${total}`);
    check('...it ends on the last tab, with one tab view visible', active === burst && vis === 1, `${active} vs ${burst}, visible ${vis}`);

    // a run's own unthrottled tab is left alone
    const runTab = r.ids[0];
    const kept = await app.evaluate((_e, id) => { const t = global.__aiTabs.tab(id); t.view.webContents.setBackgroundThrottling(false); return t.view.webContents.backgroundThrottling; }, runTab);
    await app.evaluate(() => global.__tabReady.sync());
    check('a tab that someone else keeps unthrottled is not released here', kept === false && (await throttling(runTab)) === false, JSON.stringify(await state()));
    await app.evaluate((_e, id) => global.__aiTabs.tab(id).view.webContents.setBackgroundThrottling(true), runTab);

    // the recorder
    await app.evaluate(() => global.__settings.backend.set('recordSwitchTimings', true));
    await sleep(600);
    await click(r.ids[3]);
    await click(r.ids[2]);
    await sleep(500);
    const data = await app.evaluate(() => global.__switchTiming.data());
    const last = data.switches[data.switches.length - 1];
    console.log(`recorded: kept ${last.kept} idleMs ${last.idleMs} priority ${last.priorityBefore}(${last.priorityBeforeLabel}) -> ${last.priorityAfter} visibleCalls ${last.visibleCalls}`);
    check('the recorder has the renderer priority before and after (a number on Windows; may be null elsewhere)', process.platform === 'win32' ? Number.isFinite(last.priorityBefore) && Number.isFinite(last.priorityAfter) : true, JSON.stringify(last));
    check('...the idle time, the kept-ready state and exactly two view calls for the switch', Number.isFinite(last.idleMs) && 'kept' in last && last.visibleCalls === 2, JSON.stringify(last));
    check('...a summary and the tab settings in the export', data.summary && data.settings?.tabReadyRecent === 3 && data.version === 2 && data.os && Array.isArray(data.launchSwitches), JSON.stringify(Object.keys(data)));
    check('...and no address or title', !/https?:|127\.0\.0\.1|Page \d|Dom \d|Video \d/.test(JSON.stringify(data).replace(/"privacy": "[^"]*"/, '')));

    check('no page errors in the browser UI', r.errors.filter((e) => !/setPointerCapture/.test(e)).length === 0, r.errors.join(' | ')); // (the synthetic press has no real pointer to capture)
  } finally {
    clearTimeout(hard);
    await r.close();
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
