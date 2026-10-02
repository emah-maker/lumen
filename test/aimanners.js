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
  check('on: the AI\'s tab is out of the strip, still open, and the count stays', (await waitFor(async () => (await tabCount()) === before - 1)) && (await tabEl(aiTab)) === null && t.count === '1' && (await app.evaluate((_e, i) => Boolean(global.__aiTabs.tab(i)), aiTab)));
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

  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
