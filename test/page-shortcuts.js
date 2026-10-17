// Browser shortcuts while the keyboard is inside a web page, as in Chrome (hidden: LUMEN_TEST_BACKGROUND=1).
//   1. Reserved keys (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+1-9...) always go to the browser; a page cannot block them.
//   2. Every other browser key (Ctrl+L, Ctrl+R, zoom, Alt+Left...) goes to the page first; the browser acts only if the page left it alone.
//   3. Typing in a field is never taken; the AI's own key presses never run browser commands.
// Keys arrive the way a user's do: webContents.sendInputEvent on the tab.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// ?mode=plain handles nothing; ?mode=handles preventDefaults every Ctrl / Alt / F-key chord it is told to keep.
const PAGE = (mode) => `<!doctype html><title>Page ${mode}</title><textarea id="t"></textarea><input id="i"><script>
  window.__keys = [];
  const mode = ${JSON.stringify(mode)};
  window.addEventListener('keydown', (e) => {
    window.__keys.push((e.ctrlKey ? 'c' : '') + (e.altKey ? 'a' : '') + (e.shiftKey ? 's' : '') + ':' + e.key.toLowerCase());
    if (mode === 'handles' && (e.ctrlKey || e.altKey || /^F\\d+$/.test(e.key))) e.preventDefault();
  });
</script>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pageshortcuts-tmp-'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE(req.url.slice(1) || 'plain')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pageshortcuts-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: dir, TMP: dir },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  await sleep(800);

  const go = async (text) => { await app.evaluate(({ ipcMain }, t) => ipcMain.emit('nav:go', {}, t), text); await sleep(1800); };
  const tabJs = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  const ids = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => t.id));
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
  const keyLog = () => tabJs('window.__keys.slice()');
  // A real key press to the front tab, the focus in the page: keyDown then keyUp.
  const press = (keyCode, mods = ['control']) => app.evaluate(async (_e, [k, m]) => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
    await new Promise((r) => setTimeout(r, 700));
  }, [keyCode, mods]);
  const addressFocused = () => ui.evaluate(() => document.activeElement?.id === 'address');
  const blurAddress = () => ui.evaluate(() => document.activeElement?.blur());
  const focusField = (id = 't') => tabJs(`document.getElementById(${JSON.stringify(id)}).focus()`);
  const openFindBar = () => ui.evaluate(() => !document.getElementById('findbar').hidden);
  const closeFind = () => ui.evaluate(() => { document.getElementById('findbar').hidden = true; });
  const zoom = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getZoomLevel());
  const resetZoom = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.setZoomLevel(0));
  const reloads = () => tabJs('performance.timeOrigin');

  for (const mode of ['plain', 'handles']) {
    // ---- reserved keys: the browser's, whatever the page does, from inside a text field
    await go(`${base}/${mode}`);
    await focusField('t');
    let before = await ids();
    await press('T');
    const afterT = await waitFor(async () => { const l = await ids(); return l.length === before.length + 1 ? l : null; });
    check(`${mode}: Ctrl+T in a textarea opens a tab`, Boolean(afterT), JSON.stringify({ before, afterT }));
    const fresh = (afterT || []).find((i) => !before.includes(i));
    if (fresh) {
      await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), fresh);
      await go(`${base}/${mode}`);
      await focusField('t');
      before = await ids();
      await press('W');
      check(`${mode}: Ctrl+W in a textarea closes the tab`, Boolean(await waitFor(async () => (await ids()).length === before.length - 1)), `${before.length} -> ${(await ids()).length}`);
    }
    await go(`${base}/${mode}`);
    await focusField('i');
    const w0 = await windows();
    const known = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id));
    await press('N');
    check(`${mode}: Ctrl+N in an input opens a window`, Boolean(await waitFor(async () => (await windows()) === w0 + 1)), `${w0} -> ${await windows()}`);
    // the new window took the keyboard focus: close it so the next steps run in the first one
    await app.evaluate(({ BrowserWindow }, keep) => { for (const w of BrowserWindow.getAllWindows()) if (!keep.includes(w.id) && !w.isDestroyed()) w.destroy(); }, known);
    await sleep(600);
    await go(`${base}/${mode}`);
    await focusField('t');
    // Ctrl+Tab and Ctrl+2 move between tabs
    const two = await ids();
    const active0 = await app.evaluate(() => global.__agent.browser.activeTab().id);
    await press('Tab');
    const active1 = await app.evaluate(() => global.__agent.browser.activeTab().id);
    check(`${mode}: Ctrl+Tab switches tab`, two.length < 2 || active1 !== active0, `${active0} -> ${active1}`);
    await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), active0);
  }

  // ---- page-first keys: a page that handles them keeps them; one that does not hands them to the browser
  await go(`${base}/handles`);
  await focusField('t');
  await blurAddress();
  await press('L');
  check('handling page: it saw Ctrl+L', (await keyLog()).includes('c:l'), JSON.stringify(await keyLog()));
  check('handling page: Ctrl+L did NOT focus the address bar', !(await addressFocused()), '');
  await press('F');
  check('handling page: Ctrl+F did NOT open the find bar', !(await openFindBar()), '');
  await press('K');
  check('handling page: Ctrl+K reached the page, the browser did nothing', (await keyLog()).includes('c:k') && !(await addressFocused()) && !(await openFindBar()), JSON.stringify(await keyLog()));
  await resetZoom();
  await press('=');
  check('handling page: Ctrl+= did not zoom', (await zoom()) === 0, await zoom());
  const orig = await reloads();
  await press('R');
  await sleep(600);
  check('handling page: Ctrl+R did not reload', (await reloads()) === orig, '');
  await press('F5', []);
  await sleep(600);
  check('handling page: F5 did not reload', (await reloads()) === orig, '');
  await press('Left', ['alt']);
  check('handling page: Alt+Left reached the page', (await keyLog()).includes('a:arrowleft'), JSON.stringify(await keyLog()));

  await go(`${base}/plain`);
  await focusField('t');
  await blurAddress();
  await press('L');
  check('plain page: Ctrl+L focuses the address bar', await waitFor(addressFocused), '');
  await blurAddress();
  await focusField('t');
  await press('F');
  check('plain page: Ctrl+F opens the find bar', await waitFor(openFindBar), '');
  await closeFind();
  await resetZoom();
  await press('=');
  check('plain page: Ctrl+= zooms', Boolean(await waitFor(async () => (await zoom()) > 0)), await zoom());
  await resetZoom();
  const orig2 = await reloads();
  await press('R');
  check('plain page: Ctrl+R reloads', Boolean(await waitFor(async () => (await reloads()) !== orig2, 5000)), '');
  await go(`${base}/plain`);
  await focusField('t');
  await blurAddress();
  await press('F6', []);
  check('plain page: F6 focuses the address bar', await waitFor(addressFocused), '');

  // ---- typing in a field is never taken
  await go(`${base}/plain`);
  await focusField('t');
  await app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.focus();
    for (const ch of 'hello world') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch === ' ' ? 'Space' : ch });
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch === ' ' ? 'Space' : ch });
    }
    await new Promise((r) => setTimeout(r, 400));
  });
  check('typing in a textarea is never stolen', (await tabJs('document.getElementById("t").value')) === 'hello world', await tabJs('document.getElementById("t").value'));
  await closeFind();
  await blurAddress();
  await focusField('t');
  await press('A');
  check('Ctrl+A in a textarea stays the page\'s (no browser action)', !(await openFindBar()) && !(await addressFocused()), '');

  // ---- the AI's own Ctrl+W is the page's, never the browser's
  await go(`${base}/plain`);
  await focusField('t');
  const n = (await ids()).length;
  const res = await app.evaluate(async () => {
    const signal = new AbortController().signal;
    const m = []; m.settings = { model: 'claude-opus-5' };
    const tab = global.__agent.browser.activeTab();
    try { return { ok: true, out: await global.__agent.inTask(tab.id, signal, () => global.__agent.execute('press_key', { key: 'w', modifiers: ['control'] }), m) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  await sleep(800);
  check('AI press_key Ctrl+W does not close the tab', (await ids()).length === n, JSON.stringify({ n, now: (await ids()).length, res }));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll page shortcut checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
