// AI tab manners in the real app (features/ai-manners.js, main.js "[ai manners]", the tab strip and the sidebar), with a
// temp profile and no network: the AI's tabs open in the background and carry a mark; the sidebar toggle hides and shows
// them (and keeps its state across a restart); "Close the tabs the AI opened" closes only what is still the AI's, and Undo
// brings them back; hands-off mode refuses acts on the user's tabs (and shows its badge) while reading works; and the AI
// neither moves the user's focus nor their caret, and waits while they type.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE</h1><label>Field A <input id="a" value="hello"></label><label>Field B <input id="b" value=""></label></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aimanners-'));
  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const openAi = (url) => app.evaluate((_e, u) => global.__agent.browser.openTab(u, { ai: true }).id, url);
  const openUser = (url) => app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, url);
  const tabEl = (id) => ui.evaluate((i) => { const el = document.querySelector(`#tabs .tab[data-id="${i}"]`); return el ? { ai: el.classList.contains('ai-opened'), label: el.getAttribute('aria-label'), mark: getComputedStyle(el.querySelector('.tab-ai-mark')).display } : null; }, id);
  const toggle = () => ui.evaluate(() => { const b = document.getElementById('hide-ai-tabs'); return { hidden: b.hidden, pressed: b.getAttribute('aria-pressed'), label: b.title, count: document.getElementById('hide-ai-tabs-count').hidden ? '' : document.getElementById('hide-ai-tabs-count').textContent }; });
  const tabCount = () => ui.evaluate(() => document.querySelectorAll('#tabs .tab').length);
  const wcOf = (id, fn, arg) => app.evaluate(({ webContents }, a) => { const t = global.__aiTabs.tab(a.id); return webContents.fromId(t.view.webContents.id).executeJavaScript(a.code); }, { id, code: fn, arg });
  const run = (id, fn) => app.evaluate(async (_e, a) => {
    const signal = new AbortController().signal;
    const m = []; m.settings = { model: 'claude-opus-5' };
    try { return { ok: true, out: await global.__agent.inTask(a.id, signal, () => global.__agent.execute(a.name, a.input), m) }; } catch (e) { return { ok: false, error: e.message }; }
  }, { id, ...fn });

  // ---- 1. The AI's tab opens behind the user's, marked.
  const user = await active();
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click()); // the toggle lives in the AI sidebar
  await ui.waitForSelector('#sidebar', { state: 'visible' });
  await app.evaluate(({ webContents }, u) => { webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).loadURL(u); }, `${base}/user`);
  await waitFor(() => app.evaluate(() => /127\.0\.0\.1/.test(global.__windows.list()[0].tabs[0].url)));
  const aiTab = await openAi(`${base}/ai1`);
  check('the AI\'s new tab opens in the background: the user stays on their tab', (await active()) === user, await active());
  check('it is marked as opened by the AI', await app.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)?.openedBy), aiTab));
  const el = await waitFor(async () => (await tabEl(aiTab))?.ai && (await tabEl(aiTab)));
  check('the strip marks it (a mark after the title, and a spoken note)', el?.ai && el.mark !== 'none' && /Opened by AI/.test(el.label || ''), JSON.stringify(el));
  check('a tab the user opens has no mark', (await tabEl(user))?.ai === false);

  // ---- 2. The sidebar toggle.
  let t = await waitFor(async () => { const x = await toggle(); return !x.hidden && x; });
  check('the toggle appears while the AI has a tab open, with their count', t && t.pressed === 'false' && t.count === '1' && /Hide the 1 tab/.test(t.label), JSON.stringify(t));
  const before = await tabCount();
  await ui.focus('#hide-ai-tabs');
  await ui.keyboard.press('Space');
  t = await waitFor(async () => { const x = await toggle(); return x.pressed === 'true' && x; });
  check('keyboard: Space turns it on (aria-pressed), the label says the tab is hidden', t && /is hidden/.test(t.label), JSON.stringify(t));
  check('on: the AI\'s tab is out of the strip, still open, and the count stays', (await waitFor(async () => (await tabCount()) === before - 1)) && (await tabEl(aiTab)) === null && (await ui.evaluate(() => document.getElementById('hide-ai-tabs-label').textContent)) === '1 hidden' && (await app.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)), aiTab)));
  check('on: the user\'s own tab is still shown', (await tabEl(user)) !== null);
  // the tab in front stays shown even though it is the AI's (the user went there: a click in the page would hand it over, a look does not)
  await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), aiTab);
  await waitFor(async () => (await active()) === aiTab);
  check('on: the AI\'s tab is shown while it is the tab in front', await waitFor(async () => (await tabEl(aiTab)) !== null));
  await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), user);
  await waitFor(async () => (await tabEl(aiTab)) === null);
  check('on: it goes out of the strip again once the user leaves it', (await tabEl(aiTab)) === null);
  await app.evaluate(() => global.__settingsFlush());
  check('the toggle is a saved setting', await app.evaluate(() => global.__settings.backend.prefs().hideAiTabs === true));
  await ui.click('#hide-ai-tabs');
  t = await waitFor(async () => { const x = await toggle(); return x.pressed === 'false' && x; });
  check('off: the tab is back with its mark', t && (await waitFor(async () => (await tabEl(aiTab))?.ai)) === true, JSON.stringify(t));

  // ---- 3. Restart: the state comes back.
  await ui.click('#hide-ai-tabs');
  await waitFor(async () => (await toggle()).pressed === 'true');
  await app.evaluate(() => global.__settingsFlush());
  await app.close();
  app = await launch(profile);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  if (!(await ui.isVisible('#sidebar'))) { await ui.evaluate(() => document.getElementById('toggle-sidebar').click()); await ui.waitForSelector('#sidebar', { state: 'visible' }); }
  t = await waitFor(async () => { const x = await toggle(); return x.pressed === 'true' && x; });
  check('after a restart the toggle is still on (and stays reachable with no AI tab, to turn it off)', t && t.hidden === false, JSON.stringify(t));
  await ui.click('#hide-ai-tabs');
  await waitFor(async () => (await toggle()).pressed === 'false');
  check('...and turning it off with no AI tab open hides the button again', (await waitFor(async () => (await toggle()).hidden)) === true);

  // ---- 4. Close the tabs the AI opened (and what it never closes).
  const user2 = await active();
  const a1 = await openAi(`${base}/c1`);
  const a2 = await openAi(`${base}/c2`);
  const a3 = await openAi(`${base}/c3`);
  const a4 = await openAi(`${base}/c4`);
  await app.evaluate((_e, ids) => { global.__aiTabs.tab(ids[1]).pinned = true; global.__aiTabs.handOver(global.__aiTabs.tab(ids[2])); }, [a1, a2, a3]);
  const sel = await app.evaluate(() => global.__aiTabs.select({}).map((x) => x.tab.id));
  check('close selection: not the pinned tab, not the one the user took over', JSON.stringify(sel.sort()) === JSON.stringify([a1, a4].sort()), JSON.stringify(sel));
  await waitFor(() => app.evaluate((_e, ids) => ids.every((i) => /\/c\d$/.test(global.__aiTabs.tab(i).view.webContents.getURL())), [a1, a2, a3, a4])); // loaded: Undo reopens by address
  const closed = await app.evaluate(() => global.__aiTabs.close({}));
  await waitFor(async () => (await app.evaluate((_e, i) => !global.__aiTabs.tab(i), a1)));
  const gone = await app.evaluate((_e, ids) => ids.map((i) => !global.__aiTabs.tab(i)), [a1, a2, a3, a4]);
  check('closing takes only the tabs that are still the AI\'s', closed.closed === 2 && JSON.stringify(gone) === '[true,false,false,true]', JSON.stringify({ closed, gone }));
  const reopened = await app.evaluate((_e, tok) => global.__aiTabs.reopen(tok), closed.token);
  const urls = () => app.evaluate(() => global.__windows.list()[0].tabs.map((x) => x.url));
  await waitFor(async () => (await urls()).filter((u) => /\/c[14]$/.test(u)).length === 2);
  const after = { reopened, urls: await urls(), aiLeft: await app.evaluate(() => global.__aiTabs.select({}).length) };
  check('Undo reopens them, as the user\'s own tabs (no mark)', reopened.reopened === 2 && after.urls.filter((u) => /\/c[14]$/.test(u)).length === 2 && after.aiLeft === 0, JSON.stringify(after));
  check('the user never left their tab', (await active()) === user2);

  // ---- 4b. The taskbar's command (a second instance started with --close-ai-tabs): same rules, no window brought forward.
  const b1 = await openAi(`${base}/c1`);
  const b2 = await openAi(`${base}/c2`);
  await app.evaluate((_e, id) => { global.__aiTabs.tab(id).pinned = true; }, b2);
  await waitFor(() => app.evaluate((_e, i) => /\/c1$/.test(global.__aiTabs.tab(i)?.view.webContents.getURL() || ''), b1));
  const focusBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isFocused()));
  await app.evaluate(() => global.__taskbar.secondInstance(['Lumen.exe', '--close-ai-tabs']));
  check('taskbar: the command closes the AI\'s tab', await waitFor(() => app.evaluate((_e, i) => !global.__aiTabs.tab(i), b1)));
  check('taskbar: a pinned AI tab stays, and so does the user\'s tab', await app.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)), b2) && (await active()) === user2);
  check('taskbar: the strip says what closed, with Undo', Boolean(await waitFor(() => ui.evaluate(() => /Closed 1 tab the AI opened/.test(document.body.innerText)))));
  check('taskbar: no window took the focus', JSON.stringify(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isFocused()))) === JSON.stringify(focusBefore));
  const none = await app.evaluate(() => global.__taskbar.closeAiTabs());
  check('taskbar: with none left to close it does nothing', none.closed === 0 && none.windows === 0, JSON.stringify(none));
  await app.evaluate((_e, id) => { global.__aiTabs.tab(id).pinned = false; return global.__aiTabs.close({}); }, b2); // (tidy: the later steps count the AI's tabs)
  await waitFor(() => app.evaluate((_e, i) => !global.__aiTabs.tab(i), b2));

  // ---- 5. Hands-off mode.
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', true));
  const badge = await waitFor(async () => ui.evaluate(() => { const b = document.getElementById('hands-off'); return b && !b.hidden && b.textContent.trim(); }));
  check('the composer shows the Hands-off badge', badge === 'Hands-off', badge);
  const ai5 = await openAi(`${base}/own`);
  await waitFor(() => app.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)?.view.webContents.getURL()), ai5));
  let r = await run(user2, { name: 'click', input: { element_id: 1 } });
  check('hands-off: a click on the user\'s tab is refused in the tool layer', !r.ok && /Hands-off mode is on/.test(r.error), JSON.stringify(r));
  r = await run(user2, { name: 'type_text', input: { element_id: 1, text: 'x' } });
  check('hands-off: typing there is refused', !r.ok && /Hands-off/.test(r.error), JSON.stringify(r));
  r = await run(user2, { name: 'navigate', input: { url: `${base}/elsewhere` } });
  check('hands-off: navigating it is refused, and the page did not move', !r.ok && /Hands-off/.test(r.error) && !/elsewhere/.test(await app.evaluate(() => global.__windows.list()[0].tabs[0].url)), JSON.stringify(r));
  r = await run(user2, { name: 'read_page', input: {} });
  check('hands-off: reading the user\'s tab still works', r.ok && /Field A/.test(r.out), JSON.stringify(r).slice(0, 300));
  r = await run(ai5, { name: 'scroll', input: { direction: 'down' } });
  check('hands-off: the AI works in the tab it opened', r.ok, JSON.stringify(r));
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', false));
  check('the badge goes when the setting is off', await waitFor(() => ui.evaluate(() => document.getElementById('hands-off').hidden)));

  // ---- 6. Focus: the user's caret and keyboard stay where they are.
  const form = await openUser(`${base}/form`);
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), form);
  await waitFor(async () => (await active()) === form);
  await waitFor(() => wcOf(form, "document.readyState === 'complete' && !!document.getElementById('a')"));
  await wcOf(form, "(() => { const a = document.getElementById('a'); a.focus(); a.setSelectionRange(2, 2); return true; })()");
  await app.evaluate((_e, i) => { global.__manners.userInput.click(global.__aiTabs.tab(i).view.webContents, Date.now()); }, form);
  const read = await run(form, { name: 'read_page', input: {} });
  const bId = Number(/"id":(\d+),"tag":"input","label":"Field B"/.exec(String(read.out))?.[1]);
  check('(set up: the form is read and field B has an id)', Number.isFinite(bId), String(read.out).slice(0, 400));
  await ui.evaluate(() => document.getElementById('address').focus());
  const typed = await run(form, { name: 'type_text', input: { element_id: bId, text: 'zz' } });
  const state = await wcOf(form, "({ b: document.getElementById('b').value, active: document.activeElement.id, start: document.getElementById('a').selectionStart })");
  check('the AI typed into field B', typed.ok && state.b === 'zz', JSON.stringify({ typed, state }));
  check('the user\'s caret went back to field A, where it was', state.active === 'a' && state.start === 2, JSON.stringify(state));
  check('the omnibox kept the keyboard', await ui.evaluate(() => document.activeElement?.id === 'address'));
  const keyBefore = await app.evaluate((_e, i) => global.__manners.userInput.typedAt(global.__aiTabs.tab(i).view.webContents), form);
  await run(form, { name: 'press_key', input: { key: 'Shift' } });
  check('keys the AI sends do not count as the user typing', (await app.evaluate((_e, i) => global.__manners.userInput.typedAt(global.__aiTabs.tab(i).view.webContents), form)) === keyBefore);
  // (the pause is for the field the user is typing in: put them in field B, the one the AI is about to type into)
  await wcOf(form, "(() => { document.getElementById('b').focus(); return true; })()");
  await app.evaluate((_e, i) => global.__manners.userInput.key(global.__aiTabs.tab(i).view.webContents, Date.now()), form);
  const started = Date.now();
  await run(form, { name: 'type_text', input: { element_id: bId, text: 'y' } });
  const took = Date.now() - started;
  check('the AI waits while the user types in that tab (about 1.5 s after their last key)', took >= 1200, `${took} ms`);
  await ui.evaluate(() => document.getElementById('address').focus());
  const ai6 = await openAi(`${base}/bg`);
  await run(ai6, { name: 'scroll', input: { direction: 'down' } });
  const after2 = { focus: await ui.evaluate(() => document.activeElement?.id || document.activeElement?.tagName), active: await active(), form, ai6 };
  check('opening and working in the AI\'s tab left the omnibox focused and the user on their tab', after2.focus === 'address' && after2.active === form, JSON.stringify(after2));

  // ---- 7. A click through the tool leaves the keyboard in the address bar.
  await ui.evaluate(() => document.getElementById('address').focus());
  const clicked = await run(form, { name: 'click', input: { element_id: bId } });
  check('a click through the tool keeps the keyboard in the address bar', clicked.ok && (await ui.evaluate(() => document.activeElement?.id)) === 'address' && (await active()) === form, JSON.stringify(clicked));

  // ---- 8. A page the AI opened that opens another: behind, and the AI's own.
  const idsOf = () => app.evaluate(() => global.__windows.list()[0].tabs.map((x) => x.id));
  const known = await idsOf();
  await wcOf(ai6, "(() => { window.open(location.origin + '/popped', '_blank'); return true; })()");
  const popped = await waitFor(async () => (await idsOf()).find((i) => !known.includes(i)));
  check('window.open from an AI tab makes a tab', Boolean(popped), JSON.stringify(await idsOf()));
  await waitFor(() => app.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)), popped));
  check('...marked as the AI\'s own, so it can be closed again', await app.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)?.openedBy), popped));
  check('...and it opened behind: the user stays on their tab and keeps the address bar', (await active()) === form && (await ui.evaluate(() => document.activeElement?.id)) === 'address');
  await app.evaluate((_e, i) => global.__aiTabs.close({}).then(() => i), popped); // (tidy)

  // ---- 9. The strip says so: hands-off mode, and tabs hidden.
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', true));
  check('hands-off: the tab strip shows its cue too', await waitFor(() => ui.evaluate(() => { const b = document.getElementById('hands-off-strip'); return b && !b.hidden && b.getBoundingClientRect().width > 0; })));
  await ui.click('#hands-off-strip');
  await sleep(600);
  await ui.click('#hands-off-strip');
  const settingsTabs = await waitFor(async () => { const u = await app.evaluate(() => global.__windows.list()[0].tabs.map((x) => x.url).filter((x) => /settings\.html/.test(x))); return u.length && u; });
  check('the hands-off cue opens Settings at its switch, and a second click reuses that tab', settingsTabs?.length === 1 && /#hands-off$/.test(settingsTabs[0]), JSON.stringify(settingsTabs));
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', false));
  check('...and it goes when the setting is off',await waitFor(() => ui.evaluate(() => document.getElementById('hands-off-strip').hidden)));
  await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), form);
  await waitFor(async () => (await active()) === form);
  await app.evaluate(() => global.__settings.backend.set('hideAiTabs', true));
  const chip = await waitFor(() => ui.evaluate(() => { const l = document.getElementById('hide-ai-tabs-label'); return l && !l.hidden && l.textContent.trim(); }));
  const nHidden = await app.evaluate(() => global.__windows.list()[0].tabs.filter((x) => global.__aiTabs.tab(x.id)?.openedBy && x.id !== global.__windows.list()[0].activeId).length);
  check('hiding says so in words in the strip ("N hidden")', chip === `${nHidden} hidden` && nHidden > 0, `${chip} / ${nHidden}`);
  // three or more tabs of the user's in the strip, hidden AI tabs among them: a full lap (both ways) never lands on a hidden one
  await openUser(`${base}/u2`);
  await openUser(`${base}/u3`);
  await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), form);
  await waitFor(async () => (await active()) === form);
  await waitFor(async () => (await ui.evaluate(() => document.querySelectorAll('#tabs .tab').length)) >= 3);
  const landed = [];
  for (const d of [1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1]) {
    await app.evaluate((_e, dir) => global.__aiTabs.cycle(dir), d);
    await sleep(120);
    landed.push(await active());
  }
  const aiAmong = await app.evaluate((_e, ids) => ids.filter((i) => global.__aiTabs.tab(i)?.openedBy), landed);
  check('Ctrl+Tab never lands on a hidden AI tab (3+ visible tabs, a full lap each way)', new Set(landed).size >= 3 && aiAmong.length === 0, JSON.stringify({ landed, aiAmong }));
  await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), form);
  await waitFor(async () => (await active()) === form);

  // layout: at 1200px the cue and the chip are single-line pills, and a toast never sits on the cue
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.fromId(global.__windows.list()[0].windowId); w.setSize(1200, 800); });
  await waitFor(() => ui.evaluate(() => innerWidth >= 1100));
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', true));
  await waitFor(() => ui.evaluate(() => { const b = document.getElementById('hands-off-strip'); return !b.hidden && b.getBoundingClientRect().width > 0; }));
  await app.evaluate(() => global.__chatPage.ui().send('tabs:organize-note', { text: 'Closed 3 tabs the AI opened.', undo: true, ttl: 9000, aiUndo: 0, undoLabel: 'Undo', undoTitle: 'Undo' }));
  await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.organize-note'))));
  const lay = await ui.evaluate(() => {
    const r = (el) => { const b = el?.getBoundingClientRect(); return b && { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
    const line = (el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length; };
    const cue = document.getElementById('hands-off-strip');
    const chipEl = document.getElementById('hide-ai-tabs');
    const toast = document.querySelector('.organize-note');
    return {
      width: innerWidth, cue: r(cue), chip: r(chipEl), toast: r(toast),
      cueLabelLines: line(cue.querySelector('.hands-off-label')), chipLabelLines: line(document.getElementById('hide-ai-tabs-label')),
      cueLabelShown: getComputedStyle(cue.querySelector('.hands-off-label')).display !== 'none',
    };
  });
  const overlap = (a, b) => a && b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
  check('1200px: the hands-off cue is one line, a pill no taller than 30px, with its words', lay.cueLabelShown && lay.cueLabelLines === 1 && lay.cue.h <= 30 && lay.cue.w > 60, JSON.stringify(lay));
  check('1200px: the "N hidden" chip is one line and no taller than 30px', lay.chipLabelLines === 1 && lay.chip.h <= 30, JSON.stringify(lay));
  check('1200px: the toast does not sit on the cue or the chip', !overlap(lay.toast, lay.cue) && !overlap(lay.toast, lay.chip), JSON.stringify(lay));
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', false));
  await app.evaluate(() => global.__settings.backend.set('hideAiTabs', false));

  // crowded: 5+ tabs of the user's and 3+ of the AI's at 700px, hands-off on: the controls stay in view and apart, the tab in front stays readable
  for (let i = 0; i < 3; i++) await openUser(`${base}/crowd${i}`);
  for (let i = 0; i < 2; i++) await openAi(`${base}/crowdai${i}`);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.fromId(global.__windows.list()[0].windowId).setSize(700, 800); });
  await waitFor(() => ui.evaluate(() => innerWidth <= 720));
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', true));
  await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), form);
  await waitFor(async () => (await active()) === form);
  await waitFor(() => ui.evaluate(() => document.querySelectorAll('#tabs .tab').length >= 8));
  await sleep(400);
  const crowd = await ui.evaluate(() => {
    const r = (el) => { const b = el?.getBoundingClientRect(); return b && { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom, shown: !el.hidden && b.width > 0 }; };
    const cue = r(document.getElementById('hands-off-strip'));
    const organize = r(document.getElementById('organize-tabs'));
    const search = r(document.getElementById('tab-search'));
    const chipB = r(document.getElementById('hide-ai-tabs'));
    const add = r(document.getElementById('new-tab'));
    const act = r(document.querySelector('#tabs .tab.active'));
    return { n: document.querySelectorAll('#tabs .tab').length, width: innerWidth, cue, organize, search, chipB, add, act, cueLabel: getComputedStyle(document.querySelector('#hands-off-strip .hands-off-label')).display };
  });
  const apart = (list) => list.filter((x) => x?.shown).every((a, i, all) => all.every((b, j) => i === j || !(a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b && b.y < a.b)));
  check('crowded (700px, 8+ tabs): the cue is icon-only and the strip controls do not overlap', crowd.cueLabel === 'none' && apart([crowd.cue, crowd.organize, crowd.search, crowd.chipB, crowd.add]), JSON.stringify(crowd));
  check('crowded: tab search stays inside the window and the tab in front is at least 60px wide', crowd.search.r <= crowd.width && crowd.act.w >= 60, JSON.stringify({ act: crowd.act, n: crowd.n }));
  console.log(`      (crowded: ${crowd.n} tabs at ${crowd.width}px, the tab in front is ${Math.round(crowd.act.w)}px wide)`);
  check('crowded: Organize (when shown) is as tall as the pills beside it', !crowd.organize.shown || crowd.organize.h === crowd.chipB.h, JSON.stringify(crowd));
  await app.evaluate(() => global.__settings.backend.set('aiHandsOff', false));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.fromId(global.__windows.list()[0].windowId).setSize(1200, 800); });

  // ---- 10. Undo puts a tab back in its group.
  const gTab = await openAi(`${base}/grp`);
  await waitFor(() => app.evaluate((_e, i) => /\/grp$/.test(global.__aiTabs.tab(i)?.view.webContents.getURL() || ''), gTab));
  const gid = await app.evaluate((_e, ids) => global.__tabGroups.create('Mixed', ids).id, [gTab, form]);
  const res = await app.evaluate(() => global.__aiTabs.close({}));
  await waitFor(async () => !(await app.evaluate((_e, i) => global.__aiTabs.tab(i), gTab)));
  await app.evaluate((_e, tok) => global.__aiTabs.reopen(tok), res.token);
  const back = await waitFor(() => app.evaluate(() => global.__windows.list()[0].tabs.find((x) => /\/grp$/.test(x.url))));
  check('Undo puts the tab back in its group', Boolean(back) && back.groupId === gid, JSON.stringify({ back, gid }));
  const second = await app.evaluate((_e, tok) => global.__aiTabs.reopen(tok), res.token);
  check('a second Undo of the same close reopens nothing', second.reopened === 0, JSON.stringify(second));

  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();

  // ---- 11. A fresh window at 1000px with 7 tabs of the user's: Organize is its icon and the tab in front keeps a readable width.
  const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aimanners2-'));
  const app2 = await launch(profile2);
  const ui2 = await app2.firstWindow();
  await ui2.waitForSelector('.tab');
  for (let i = 0; i < 6; i++) await app2.evaluate((_e, u) => global.__agent.browser.openTab(u).id, `${base}/seven${i}`);
  await app2.evaluate(({ BrowserWindow }) => { BrowserWindow.fromId(global.__windows.list()[0].windowId).setSize(1000, 800); });
  await waitFor(() => ui2.evaluate(() => innerWidth >= 980 && innerWidth < 1100 && document.querySelectorAll('#tabs .tab').length >= 7));
  await sleep(500);
  const seven = await ui2.evaluate(() => {
    const act = document.querySelector('#tabs .tab.active')?.getBoundingClientRect();
    const org = document.getElementById('organize-tabs');
    return { n: document.querySelectorAll('#tabs .tab').length, width: innerWidth, act: act && act.width, orgShown: !org.hidden && org.getBoundingClientRect().width > 0, orgW: org.getBoundingClientRect().width, orgText: getComputedStyle(org.querySelector('span')).display };
  });
  check('1000px, 7 tabs: the tab in front is at least 100px wide', seven.act >= 100, JSON.stringify(seven));
  check('1000px: Organize (when shown) is just its icon', !seven.orgShown || (seven.orgText === 'none' && seven.orgW <= 30), JSON.stringify(seven));
  await app2.close();
  fs.rmSync(profile2, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });

  // ---- 12. "Hide AI tabs" is on and a new session opens tabs: none appears in the strip (but the one in front, or one playing sound), and the
  // button and its words always match what the strip shows: a tab shown because it is in front is not counted as hidden. Two windows; off and on.
  {
    const profile3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aimanners3-'));
    const app3 = await launch(profile3);
    const w1 = await app3.firstWindow();
    await w1.waitForSelector('.tab');
    await w1.evaluate(() => document.getElementById('toggle-sidebar').click());
    await app3.evaluate(() => global.__settings.backend.set('hideAiTabs', true));
    const strip = (page) => page.evaluate(() => {
      const b = document.getElementById('hide-ai-tabs');
      const tabs = [...document.querySelectorAll('#tabs .tab')];
      return { ids: tabs.map((e) => Number(e.dataset.id)), ai: tabs.filter((e) => e.classList.contains('ai-opened')).map((e) => Number(e.dataset.id)), front: Number(document.querySelector('#tabs .tab.active')?.dataset.id), pressed: b.getAttribute('aria-pressed'), gone: b.hidden, chip: document.getElementById('hide-ai-tabs-label').hidden ? '' : document.getElementById('hide-ai-tabs-label').textContent.trim(), title: b.title };
    });
    const aiIds = (winIndex = 0) => app3.evaluate((_e, n) => global.__windows.list()[n].tabs.map((x) => x.id).filter((i) => global.__aiTabs.tab(i)?.openedBy), winIndex);
    // the invariant: the button's count and words are exactly what the strip shows
    const matches = async (page, winIndex = 0) => {
      await sleep(400);
      const s = await strip(page);
      const ai = await aiIds(winIndex);
      const hidden = ai.filter((i) => !s.ids.includes(i)).length;
      const shown = ai.filter((i) => s.ids.includes(i)).length;
      const wantChip = hidden > 0 ? (shown > 0 ? `${hidden} more hidden` : `${hidden} hidden`) : shown > 0 ? `${shown} in view` : '';
      const wantTitle = hidden > 0 && shown === 0 ? /is hidden|are hidden/ : hidden > 0 ? /more tabs? the AI opened (is|are) hidden/ : shown > 0 ? /stays? in the strip/ : /Tabs the AI opens are hidden/;
      return { ok: s.pressed === 'true' && s.chip === wantChip && wantTitle.test(s.title) && !(hidden === 0 && /is hidden|are hidden/.test(s.title) && shown > 0), s, hidden, shown, wantChip };
    };
    const userTab = (await app3.evaluate(() => global.__windows.list()[0].activeId));
    const aiOpen = (u, o = {}) => app3.evaluate((_e, a) => global.__agent.browser.openTab(a.u, { ai: true, ...a.o }).id, { u, o });
    let m = await matches(w1);
    check('hide on, nothing opened yet: the button says tabs the AI opens are hidden, with no tab claimed', m.ok && m.hidden === 0 && m.shown === 0, JSON.stringify(m));

    // a new session: tabs behind the user's, an outside agent's tab, and a link an AI page opens
    const n1 = await aiOpen(`${base}/s1`);
    const n2 = await app3.evaluate((_e, u) => global.__agent.browser.openTab(u, { background: true, openedBy: {} }).id, `${base}/s2`); // (an outside agent: ai-agents.js)
    await waitFor(() => app3.evaluate((_e, i) => /\/s1$/.test(global.__aiTabs.tab(i)?.view.webContents.getURL() || ''), n1));
    await app3.evaluate((_e, i) => global.__aiTabs.tab(i).view.webContents.executeJavaScript("window.open('/s3', '_blank'); true", true), n1);
    const n3 = await waitFor(() => app3.evaluate(() => global.__windows.list()[0].tabs.find((x) => /\/s3$/.test(x.url))?.id));
    m = await matches(w1);
    check('a new session\'s tabs open behind: the user stays on their tab', (await app3.evaluate(() => global.__windows.list()[0].activeId)) === userTab && m.s.front === userTab, JSON.stringify(m));
    check('a link an AI page opened is the AI\'s too (marked, behind)', Boolean(n3) && (await app3.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)?.openedBy), n3)), String(n3));
    check('none of them appears in the strip, and the chip says "3 hidden"', m.s.ids.length === 1 && m.s.ids[0] === userTab && m.hidden === 3 && m.s.chip === '3 hidden' && m.ok, JSON.stringify(m));

    // one comes to the front (the AI shows it): it is shown, not counted as hidden, and the button says so
    const n4 = await aiOpen(`${base}/s4`, { show: true });
    await waitFor(async () => (await app3.evaluate(() => global.__windows.list()[0].activeId)) === n4);
    m = await matches(w1);
    check('the AI tab in front is in the strip with its mark, and the others stay out', m.s.ids.includes(n4) && m.s.ai.includes(n4) && m.s.front === n4 && m.s.ids.length === 2 && m.hidden === 3, JSON.stringify(m));
    check('...the chip says "3 more hidden" (the one in front is not counted), and the button does not claim all are hidden', m.ok && m.s.chip === '3 more hidden' && !/^3 tabs the AI opened are hidden/.test(m.s.title), JSON.stringify(m));

    // back to the user's tab: it goes out again; with only the front AI tab left over, the button says "in view" instead of "hidden"
    await app3.evaluate((_e, i) => global.__aiTabs.switchTo(i), userTab);
    m = await matches(w1);
    check('leaving it hides it again and the chip says "4 hidden"', m.s.ids.length === 1 && m.hidden === 4 && m.s.chip === '4 hidden' && m.ok, JSON.stringify(m));
    await app3.evaluate((_e, ids) => { for (const i of ids) global.__aiTabs.handOver(global.__aiTabs.tab(i)); }, [n1, n2, n3]); // (the user took three over)
    await app3.evaluate((_e, i) => global.__aiTabs.switchTo(i), n4);
    m = await matches(w1);
    check('only the AI tab in front is left: the chip says "1 in view", the button never says "hidden"', m.shown === 1 && m.hidden === 0 && m.s.chip === '1 in view' && !/is hidden|are hidden/.test(m.s.title) && m.ok, JSON.stringify(m));
    await app3.evaluate((_e, i) => global.__aiTabs.switchTo(i), userTab);

    // a second window: the toggle state reaches it, a new session's tab there is hidden there, and its words match its own strip
    const known = await app3.evaluate(() => global.__windows.list().map((w) => w.windowId));
    await app3.evaluate(({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] }); });
    const two = await waitFor(async () => { const w = await app3.evaluate(() => global.__windows.list()); return w.length === known.length + 1 && w.every((x) => x.tabs.length) && w; }, 12000);
    const w2page = await waitFor(() => app3.windows().find((p) => p !== w1 && /index\.html/.test(p.url())), 12000);
    check('a second window opens', Boolean(two) && Boolean(w2page), JSON.stringify(two));
    const idx2 = two ? two.findIndex((w) => !known.includes(w.windowId)) : 1;
    await w2page.waitForSelector('.tab');
    await w2page.evaluate(() => { if (!document.getElementById('sidebar') || getComputedStyle(document.getElementById('sidebar')).display === 'none') document.getElementById('toggle-sidebar')?.click(); });
    const pressed2 = await waitFor(async () => (await strip(w2page)).pressed === 'true');
    check('the second window shows the toggle on', Boolean(pressed2), JSON.stringify(await strip(w2page)));
    const bAi = await app3.evaluate((_e, u) => global.__agent.browser.openTab(u, { ai: true }).id, `${base}/b1`); // (the new window is the current one)
    const bWin = await app3.evaluate((_e, i) => global.__windows.list().findIndex((w) => w.tabs.some((x) => x.id === i)), bAi);
    m = await matches(w2page, bWin);
    check('a new session\'s tab in the second window is hidden there, and its chip matches', bWin === idx2 && m.hidden === 1 && !m.s.ids.includes(bAi) && m.s.chip === '1 hidden' && m.ok, JSON.stringify({ m, bWin, idx2 }));

    // off and on refresh every window at once
    await app3.evaluate(() => global.__settings.backend.set('hideAiTabs', false));
    const offBoth = await waitFor(async () => { const a = await strip(w1); const b = await strip(w2page); return a.pressed === 'false' && b.pressed === 'false' && a.ai.every((i) => a.ids.includes(i)) && b.ai.every((i) => b.ids.includes(i)) && b.ai.includes(bAi) && [a, b]; });
    check('off: both windows show every AI tab again (marked), the chip is gone', Boolean(offBoth) && offBoth.every((s) => s.chip === ''), JSON.stringify(offBoth));
    await app3.evaluate(() => global.__settings.backend.set('hideAiTabs', true));
    const onBoth = await waitFor(async () => { const a = await strip(w1); const b = await strip(w2page); return a.pressed === 'true' && b.pressed === 'true' && !b.ids.includes(bAi) && [a, b]; });
    check('on again: both windows hide them again at once', Boolean(onBoth), JSON.stringify(onBoth));
    const mm = await matches(w2page, idx2);
    check('...and the second window\'s chip still matches its strip', mm.ok, JSON.stringify(mm));
    await app3.close();
    fs.rmSync(profile3, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
