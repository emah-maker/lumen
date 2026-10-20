// The AI sidebar is open or closed tab by tab (features/sidebar-tabs.js, main.js "[sidebar per tab]", app.js showSidebar):
// opening it in one tab leaves the others as they were, switching restores each tab's own state (toolbar button, aria-pressed,
// the page area), tabs showing the same chat still keep their own state, toggling fast and opening tabs never leaves it out of step, a new tab starts closed, a moved or torn-off tab takes its state
// along, a closed tab is forgotten, and the saved session brings the open tabs back open. Run with LUMEN_TEST_BACKGROUND=1.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${name}</title><body><h1>PAGE-${name}</h1></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidebartabs-'));
  let app = await launch(profile);
  const oneChatPerTab = () => app.evaluate(() => global.__settings.backend.set('oneChatPerTab', true)); // these checks are about tabs with a chat each (the old behaviour)
  await oneChatPerTab();
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  const openTab = (url) => app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, url);
  // Switches in main, then waits until the window's strip shows that tab (so the sidebar has been told about it too).
  const showTab = async (id, page = ui) => {
    await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
    await waitFor(() => page.evaluate((i) => document.querySelector('#tabs .tab.active')?.dataset.id === String(i), id));
    await sleep(60);
  };
  const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const model = (id) => app.evaluate((_e, i) => global.__tabChats.sidebar(i), id); // main's answer for a tab
  const shown = (page = ui) => page.evaluate(() => !document.body.classList.contains('sidebar-hidden')); // the sidebar is laid out
  const pressed = (page = ui) => page.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true');
  const settled = (page = ui) => page.evaluate(() => !document.body.classList.contains('sidebar-moving'));
  const sidebarState = async (page = ui) => `${await shown(page) ? 'open' : 'closed'}/${(await pressed(page)) ? 'pressed' : 'not pressed'}`;
  const toggle = (page = ui) => page.evaluate(() => document.getElementById('toggle-sidebar').click());
  const waitState = (want, page = ui) => waitFor(async () => (await shown(page)) === want && (await pressed(page)) === want && (await settled(page)));
  const wait = (ms) => sleep(ms);

  // ---- 1. Two tabs: opening in one leaves the other alone.
  const tabA = await active();
  check('the window starts with the sidebar closed', await waitState(false), await sidebarState());
  await toggle();
  check('A: the toolbar button opens the sidebar', await waitState(true), await sidebarState());
  check('main knows it is open for tab A', (await model(tabA)) === true, await model(tabA));
  const tabB = await openTab(`${base}/beta`);
  await waitFor(() => ui.evaluate((i) => document.querySelector('#tabs .tab.active')?.dataset.id === String(i), tabB));
  check('a new tab starts with the sidebar closed, though it is open in the tab before', await waitState(false), await sidebarState());
  check('...and main says closed for B, open for A', (await model(tabB)) === false && (await model(tabA)) === true, `${await model(tabB)} ${await model(tabA)}`);
  await toggle();
  check('B: opening it there works', await waitState(true), await sidebarState());
  await showTab(tabA);
  await waitFor(async () => (await active()) === tabA);
  check('back on A it is still open', await waitState(true), await sidebarState());
  await toggle();
  check('A: closing it', await waitState(false), await sidebarState());
  check('B stays open for main when A closes', (await model(tabB)) === true && (await model(tabA)) === false, `${await model(tabB)} ${await model(tabA)}`);
  await showTab(tabB);
  check('switching to B shows its own open sidebar', await waitState(true), await sidebarState());
  await showTab(tabA);
  check('switching to A shows its own closed sidebar', await waitState(false), await sidebarState());

  // ---- 2. Switching is smooth: the page area has two sizes (before, after), never an in-between one that is not part of the spring, and settles.
  const sample = async (fn) => {
    const widths = [];
    let stop = false;
    const loop = (async () => { while (!stop) { const b = await app.evaluate((_e, id) => global.__tabChats.viewBounds(id), tabB); if (b) widths.push(b.width); await sleep(8); } })();
    await fn();
    await wait(900);
    stop = true;
    await loop;
    return widths;
  };
  await showTab(tabB);
  await waitState(true);
  const openWidth = (await app.evaluate((_e, id) => global.__tabChats.viewBounds(id), tabB)).width;
  await showTab(tabA);
  await waitState(false);
  const closedWidth = (await app.evaluate((_e, id) => global.__tabChats.viewBounds(id), tabA)).width;
  check('the page is narrower with the sidebar open than closed', openWidth < closedWidth, `${openWidth} ${closedWidth}`);
  const widths = await sample(() => showTab(tabB));
  const distinct = [...new Set(widths.filter((w) => w > 0))];
  const finalWidth = widths.filter((w) => w > 0).at(-1);
  check('switching to a tab with the sidebar open ends at the narrow width', Math.abs(finalWidth - openWidth) <= 1, `${finalWidth} vs ${openWidth}`);
  check('the page view never gets wider than the closed width, nor narrower than the open one', widths.every((w) => w === 0 || (w >= openWidth - 1 && w <= closedWidth + 1)), JSON.stringify(distinct));
  check('the page view changes size at most twice (no double animation)', distinct.length <= 3, JSON.stringify(distinct));
  check('the sidebar comes to rest (not left floating)', await settled(), 'sidebar-moving left on');

  // ---- 3. Keyboard: Ctrl+J acts on the tab in front only.
  await showTab(tabA);
  await waitState(false);
  const ctrlJ = () => app.evaluate(({ webContents }) => { // a real key event into the window's UI (main's before-input-event handles Ctrl+J)
    const w = global.__windows.list().find((x) => x.current) || global.__windows.list()[0];
    const wc = webContents.fromId(w.uiContentsId);
    for (const type of ['rawKeyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'J', modifiers: ['control'] });
  });
  await ctrlJ();
  check('Ctrl+J opens the sidebar on A', await waitState(true), await sidebarState());
  check('...for A only', (await model(tabA)) === true && (await model(tabB)) === true, `${await model(tabA)} ${await model(tabB)}`);
  await ctrlJ();
  check('Ctrl+J closes it again', await waitState(false), await sidebarState());
  check('...A is closed, B is still open', (await model(tabA)) === false && (await model(tabB)) === true, `${await model(tabA)} ${await model(tabB)}`);

  // ---- 4. Screen readers: the button says what the tab's sidebar is, after every switch.
  await showTab(tabB);
  await waitState(true);
  check('B: aria-pressed is true', (await pressed()) === true, await sidebarState());
  await showTab(tabA);
  await waitState(false);
  check('A: aria-pressed is false', (await pressed()) === false, await sidebarState());

  // ---- 5. Tabs that show the same chat still keep their own state: a toggle in one never flips the other.
  const tabC = await openTab(`${base}/gamma`);
  await waitFor(() => ui.evaluate((i) => document.querySelector('#tabs .tab.active')?.dataset.id === String(i), tabC));
  await waitState(false);
  const chatOfB = await app.evaluate((_e, id) => { const c = global.__tabChats.bindings.chatOf(id); return c; }, tabB);
  check('B has a chat of its own', Boolean(chatOfB), chatOfB);
  await app.evaluate((_e, [t, c]) => global.__tabChats.bindings.bind(t, c), [tabC, chatOfB]); // "also show in this tab"
  await showTab(tabA);
  await showTab(tabC);
  check('a tab that joins a chat keeps its own (closed) sidebar, though the chat is open in B', await waitState(false), await sidebarState());
  await toggle(); // open in C
  check('opening in C', await waitState(true), await sidebarState());
  await toggle(); // and close it again in C
  check('closing in C', await waitState(false), await sidebarState());
  check('...leaves B open', (await model(tabB)) === true, await model(tabB));
  await showTab(tabB);
  check('B still shows it open', await waitState(true), await sidebarState());
  await toggle(); // close in B
  await waitState(false);
  await toggle(); // open in B again
  await waitState(true);
  check('toggling in B leaves C closed', (await model(tabC)) === false, await model(tabC));
  await showTab(tabA);
  check('...and A closed', await waitState(false), await sidebarState());
  await app.evaluate((_e, t) => global.__tabChats.bindings.unbindTab(t), tabC);

  // ---- 5b. Toggling fast and opening new tabs never leaves the sidebar out of step: the button, main's answer for the tab in front,
  // the laid-out sidebar and the page width all agree once it settles, and each tab keeps its own state.
  const consistent = async () => {
    const id = await active();
    if (!(await waitFor(() => settled(), 4000))) return `still moving on ${id}`;
    await sleep(120);
    const m = await model(id); const sh = await shown(); const pr = await pressed();
    const w = (await app.evaluate((_e, i) => global.__tabChats.viewBounds(i), id))?.width;
    const wantW = m ? openWidth : closedWidth;
    return m === sh && sh === pr && Math.abs((w || 0) - wantW) <= 2 ? '' : `tab ${id}: main ${m}, shown ${sh}, pressed ${pr}, width ${w} (want ${wantW})`;
  };
  await showTab(tabA);
  await waitState(false);
  for (let i = 0; i < 5; i++) await toggle(); // five clicks, no waiting: ends open
  const fastA = await consistent();
  check('five fast clicks on the button end in one settled state that everything agrees on', fastA === '' && (await model(tabA)) === true, fastA || String(await model(tabA)));
  await ui.evaluate(() => document.getElementById('new-tab').click()); // the user's new tab, right away
  await waitFor(async () => (await active()) !== tabA);
  const tabD = await active();
  const newD = await consistent();
  check('a new tab opened mid-toggle starts closed, and everything agrees', newD === '' && (await model(tabD)) === false, newD || String(await model(tabD)));
  check('...and the tab before keeps its open sidebar', (await model(tabA)) === true, String(await model(tabA)));
  await toggle(); await showTab(tabA); // open in the new tab, then straight back to A while it slides
  const backA = await consistent();
  check('switching tabs while the sidebar slides ends with the tab\'s own state', backA === '' && (await model(tabD)) === true, backA || String(await model(tabD)));
  for (let i = 0; i < 6; i++) { await toggle(); await showTab(i % 2 ? tabA : tabD); } // toggle + switch, over and over
  const churn = await consistent();
  check('toggling and switching over and over leaves the tab in front consistent', churn === '', churn);
  for (const id of [tabA, tabD]) { await showTab(id); const c = await consistent(); if (c) { check('every tab is consistent after the churn', false, c); break; } }
  await app.evaluate((_e, i) => global.__notifyClick ? global.__notifyClick.closeTab(i) : null, tabD);

  // ---- 6. A tab that is moved to a new window takes its state along; the other window is not touched.
  await showTab(tabB);
  await waitState(true);
  const win1 = await app.evaluate(() => global.__windows.list()[0].windowId);
  await app.evaluate((_e, [w, id]) => global.__windows.tearOff(w, id, { x: 240, y: 240 }), [win1, tabB]);
  await waitFor(() => app.evaluate(() => global.__windows.list().length === 2));
  const ui2 = await waitFor(() => app.windows().find((p) => p !== ui && p.url().includes('index.html')));
  await ui2.waitForSelector('.tab');
  check('the torn-off tab opens its new window with the sidebar open', await waitState(true, ui2), await sidebarState(ui2));
  const leftFront = await app.evaluate((_e, w) => global.__windows.list().find((x) => x.windowId === w)?.activeId, win1); // (the window it left: the new one is current now)
  check('the window it left shows its own front tab\'s state, not the moved tab\'s', await waitState(await model(leftFront)), `${leftFront} ${await sidebarState()} ${await model(leftFront)}`);
  await toggle(ui2);
  check('closing it in the new window', await waitState(false, ui2), await sidebarState(ui2));
  await app.evaluate((_e, [id, to]) => { const w2 = global.__windows.list().find((w) => w.tabs.some((t) => t.id === id)); return global.__windows.moveTo(w2.windowId, id, to); }, [tabB, win1]);
  await waitFor(() => app.evaluate(() => global.__windows.list().length === 1));
  await showTab(tabB);
  check('moved back, the tab brings its closed state', await waitState(false), await sidebarState());

  // ---- 7. Which tab is open before the restart: C (a web page, so the session keeps it; A is a new-tab page, which it does not).
  await showTab(tabC);
  await waitState(false);
  await toggle();
  await waitState(true);
  check('open on C before the restart', (await model(tabC)) === true, await model(tabC));
  await showTab(tabB);
  await waitState(false);

  // ---- 8. Restart: the saved session brings each tab back with its own state.
  await showTab(tabC);
  await waitState(true);
  await app.evaluate(() => global.__settingsFlush && global.__settingsFlush());
  await app.close();
  app = await launch(profile);
  await oneChatPerTab();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const stateOf = () => app.evaluate(() => { const w = global.__windows.list().find((x) => x.current) || global.__windows.list()[0]; return { active: w.activeId, tabs: w.tabs.map((t) => t.id) }; });
  const back = await waitFor(async () => { const s = await stateOf(); return s.tabs.length >= 2 ? s : null; }, 30000); // (the session comes back tab by tab: give a loaded machine time)
  check('the session came back with its tabs', Boolean(back), JSON.stringify(await stateOf()));
  const states = await Promise.all(back.tabs.map((id) => model(id)));
  const openCount = states.filter(Boolean).length;
  check('exactly one tab (the one that was open) comes back with its sidebar open', openCount === 1, JSON.stringify(states));
  const openIdx = states.findIndex(Boolean);
  check('the front tab is the open one, and its sidebar shows open at once', back.tabs[openIdx] === back.active && (await waitState(true)), `${back.active} ${await sidebarState()}`);
  const other = back.tabs.find((id) => id !== back.active);
  await showTab(other);
  check('another restored tab comes back closed', await waitState(false), await sidebarState());

  check('no script errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
