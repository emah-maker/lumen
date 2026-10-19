// A new tab puts the text cursor in the address bar, however it was opened and wherever the keyboard
// was before. Each case starts with focus in some place, opens a tab, then checks the real state (the UI's
// document.hasFocus() and activeElement, the focused window and contents) and types with real key events to
// whichever contents has native focus: the text must land in the address bar. Tabs opened in the
// background (middle-click, Open link in new tab, an AI tab) must leave the cursor where it was.
// Needs a window that can take OS focus: with LUMEN_TEST_BACKGROUND set, the native-focus checks are skipped.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SPARE = process.env.NTF_SPARE === '1';
  // Runs off-screen without taking focus unless NTF_FOCUS=1 (the native-focus checks then run against a real, focused window).
  const BG = process.env.NTF_FOCUS !== '1';

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/slow') return setTimeout(() => res.end('<title>Slow</title><input id="i" autofocus><p>slow</p>'), 2500);
    if (req.url === '/form') return res.end('<title>Form</title><input id="i"><p>form</p>');
    if (req.url === '/autofocus') return res.end('<title>Auto</title><input id="i" autofocus><p>auto</p>');
    res.end(`<title>Page ${req.url.slice(1)}</title><a id="l" href="/linked" target="_blank">link</a><p>${req.url}</p>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ntfocus-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ...(BG ? { LUMEN_TEST_BACKGROUND: '1' } : {}) } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  await sleep(1500);

  if (BG) console.log('SKIP  native OS-focus checks (the window is off-screen and unfocused); run with NTF_FOCUS=1 on a spare desktop');
  const win0 = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html') || true)?.id);
  const activeId = () => app.evaluate(() => global.__agent.browser.activeTab()?.id);
  const tabCount = () => app.evaluate(() => global.__tabsArray().length);
  const activeUrl = () => app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL());
  const focusUi = () => app.evaluate(({ BrowserWindow }, bg) => { const w = global.__ntWin(BrowserWindow); if (!bg) { w.show(); w.focus(); } w.webContents.focus(); }, BG);
  const typeNative = (text) => app.evaluate(async ({ webContents }, t) => {
    for (const ch of t) {
      const wc = webContents.getFocusedWebContents();
      for (const type of ['keyDown', 'char', 'keyUp']) wc?.sendInputEvent({ type, keyCode: ch });
      await new Promise((r) => setTimeout(r, 10));
    }
  }, text);
  // Ctrl+T as the keyboard sends it, to whichever contents `from` names ('ui' or 'page').
  const ctrl = (key, from = 'ui', shift = false) => app.evaluate(({ BrowserWindow }, { key, from, shift }) => {
    const w = global.__ntWin(BrowserWindow);
    const wc = from === 'page' ? global.__agent.browser.activeTab().webContents : w.webContents;
    const modifiers = shift ? ['control', 'shift'] : ['control'];
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  }, { key, from, shift });
  const state = () => app.evaluate(async ({ BrowserWindow, webContents }) => {
    const w = global.__ntWin(BrowserWindow);
    const f = webContents.getFocusedWebContents();
    return {
      winFocused: w.isFocused(),
      focusedIsUi: f?.id === w.webContents.id,
      focusedIsActive: f?.id === global.__agent.browser.activeTab()?.webContents.id,
      ui: await w.webContents.executeJavaScript('({ hasFocus: document.hasFocus(), id: document.activeElement?.id || document.activeElement?.tagName, value: document.getElementById("address").value })'),
    };
  });
  const settle = async (ms = 1800) => { await sleep(ms); };
  // Waits for the new tab to be in front and loaded, then checks where the keyboard is.
  const expectAddress = async (label, { type = true, keep = null } = {}) => {
    await settle();
    const s = await state();
    const atAddress = s.ui.id === 'address' && s.ui.hasFocus;
    if (BG) check(`${label}: address bar is the active element`, s.ui.id === 'address', JSON.stringify(s));
    else check(`${label}: caret in the address bar (OS focus on the UI)`, atAddress && s.focusedIsUi && s.winFocused, JSON.stringify(s));
    if (type && !BG) {
      await ui.evaluate(() => { const a = document.getElementById('address'); a.value = ''; });
      await focusAddressIfNot();
      await typeNative('xyz');
      await sleep(150);
      const v = await ui.evaluate(() => document.getElementById('address').value);
      check(`${label}: typed text lands in the address bar`, v.includes('xyz'), JSON.stringify(v));
    }
  };
  // (after a failed case, put the caret there so the next case starts clean)
  const focusAddressIfNot = async () => {
    const s = await state();
    if (s.ui.id !== 'address' || !s.focusedIsUi) await app.evaluate(({ BrowserWindow }) => { const w = global.__ntWin(BrowserWindow); w.webContents.focus(); }).then(() => ui.evaluate(() => document.getElementById('address').focus()));
  };
  const reset = async () => { // one clean page in front, nothing else open
    await ui.keyboard.press('Escape').catch(() => {});
    await ui.evaluate(() => { document.getElementById('findbar').hidden = true; });
    await app.evaluate(async () => {
      const ids = global.__tabsArray().map((t) => t.id);
      const t = global.__agent.browser.openTab(global.__ntBase + '/start');
      await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 3000); });
      for (const id of ids) global.__closeTabInteractive(id);
    });
    await sleep(500);
  };
  await app.evaluate((_e, { base, ui }) => { global.__ntBase = base; global.__ntWin = (BW) => BW.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === ui) || BW.getAllWindows()[0]; }, { base, ui: ui.url() });

  // ---- starting places (each leaves the keyboard there, on a page in front)
  const starts = {
    async 'the address bar'() { await openPage('/start'); await ui.evaluate(() => document.getElementById('address').focus()); await focusUi(); },
    async 'a web page input'() { await openPage('/form'); await pageFocus("document.getElementById('i').focus()"); },
    async 'the page itself'() { await openPage('/start'); await pageFocus('document.body.focus()'); },
    async 'the new-tab page search box'() { await openPage(undefined); await sleep(800); await pageFocus("document.getElementById('q').focus()"); },
    async 'the AI sidebar composer'() { await openPage('/start'); await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); }); await sleep(500); await ui.evaluate(() => document.getElementById('prompt').focus()); },
    async 'the find bar'() { await openPage('/start'); await ui.evaluate(() => { const f = document.getElementById('findbar'); f.hidden = false; document.getElementById('find-input').focus(); }); },
    async 'a tab-strip button'() { await openPage('/start'); await ui.evaluate(() => document.getElementById('new-tab').focus()); },
    async 'a settings page'() { await ui.evaluate(() => window.browser.newTab('lumen://settings')); await sleep(1200); },
  };
  async function openPage(p) {
    await app.evaluate(async (_e, url) => {
      const t = global.__agent.browser.openTab(url);
      await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    }, p === undefined ? undefined : `${base}${p}`);
    await sleep(500);
  }
  async function pageFocus(code) {
    await app.evaluate(async (_e, code) => {
      const wc = global.__agent.browser.activeTab().webContents;
      wc.focus();
      await wc.executeJavaScript(code);
    }, code);
    await sleep(200);
  }

  // ---- ways to open a new tab
  const opens = {
    'Ctrl+T (keyboard in the UI)': async (from) => ctrl('t', from === 'ui' || from === 'page' ? from : 'ui'),
    'the + button': async () => ui.click('#new-tab'),
    'tab context menu: New tab to the right': async () => { const id = await activeId(); await app.evaluate((_e, id) => global.__tabMenu(id, 'New tab to the right'), id); },
    'Ctrl+Shift+T (reopen closed tab)': async () => { await app.evaluate(async () => { const b = global.__agent.browser; const t = b.openTab(global.__ntBase + '/closed', { background: true }); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 3000); }); global.__closeTabInteractive(t.id); }); await sleep(300); await ctrl('t', 'ui', true); },
  };

  const froms = process.env.NTF_STARTS ? process.env.NTF_STARTS.split(',') : Object.keys(starts);
  const only = process.env.NTF_OPENS ? process.env.NTF_OPENS.split(',') : Object.keys(opens);
  for (const from of froms) {
    if (!starts[from]) continue;
    for (const via of only) {
      if (!opens[via]) continue;
      await reset();
      if (SPARE) { await app.evaluate(() => global.__spareNewTab.enable(true)); for (let i = 0; i < 40 && !(await app.evaluate(() => global.__spareNewTab.ready())); i++) await sleep(100); }
      await focusUi();
      await starts[from]();
      await sleep(400);
      const before = await activeId();
      // A key from the page goes to the page's contents (it is what has focus), others from the UI.
      const keyFrom = ['a web page input', 'the page itself', 'the new-tab page search box'].includes(from) ? 'page' : 'ui';
      await opens[via](keyFrom);
      await sleep(300);
      const after = await activeId();
      if (via.startsWith('Ctrl+Shift+T')) { // a reopened page is a page, not a blank tab: the page has the keyboard, as in Chrome
        await settle();
        const r = await state();
        if (!BG) check(`from ${from}, ${via}: the reopened page has the keyboard`, r.focusedIsActive, JSON.stringify(r));
        continue;
      }
      if (before === undefined && after === undefined) { console.log(`SKIP  from ${from}, ${via}: no tab menu there`); continue; }
      if (after === before) { check(`from ${from}, ${via}: a tab opened`, false, `${before} -> ${after}`); continue; }
      await expectAddress(`from ${from}, ${via}`);
    }
  }

  if (!process.env.NTF_SKIP_EXTRA) {
    const caretNow = async (label) => {
      const s = await state();
      if (BG) check(label, s.ui.id === 'address', JSON.stringify(s));
      else check(label, s.ui.id === 'address' && s.ui.hasFocus && s.focusedIsUi, JSON.stringify(s));
    };
    const keepsCaret = async (label, setup, trigger, { waitMs = 0, expectActiveChange = false } = {}) => {
      await reset();
      await focusUi();
      await setup();
      await sleep(300);
      const before = await activeId();
      await trigger();
      await sleep(waitMs + 600);
      const after = await activeId();
      check(`${label}: ${expectActiveChange ? 'a new tab is in front' : 'the tab in front is unchanged'}`, expectActiveChange ? after !== before : after === before, `${before} -> ${after}`);
    };
    // The new-tab page's own contents grab keyboard focus late (a widget's frame such as the calendar embed focuses itself
    // as it loads, seconds after the page): the cursor stays in the address bar until the page is clicked.
    for (const delay of [300, 2500, 6000]) {
      await keepsCaret(`the page takes native focus ${delay} ms after a new tab opened (a frame focusing itself)`, async () => { await openPage('/start'); await ui.evaluate(() => document.getElementById('address').focus()); await focusUi(); }, async () => {
        await ctrl('t', 'ui');
        await sleep(delay);
        await app.evaluate(() => global.__agent.browser.activeTab().webContents.focus());
      }, { expectActiveChange: true });
      await caretNow(`the page takes native focus ${delay} ms after a new tab opened: caret still in the address bar`);
    }
    // ...but a click on the page is the user choosing the page: it keeps the keyboard.
    await keepsCaret('click into the new-tab page', async () => { await openPage('/start'); }, async () => {
      await ctrl('t', 'ui');
      await sleep(1500);
      await app.evaluate(({ webContents }) => { const wc = global.__agent.browser.activeTab().webContents; wc.focus(); wc.sendInputEvent({ type: 'mouseDown', x: 300, y: 300, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: 300, y: 300, button: 'left', clickCount: 1 }); });
      await sleep(300);
      await app.evaluate(() => global.__agent.browser.activeTab().webContents.focus());
    }, { expectActiveChange: true });
    if (!BG) {
      const s = await state();
      check('click into the new-tab page: the page keeps the keyboard afterwards', s.focusedIsActive, JSON.stringify(s));
    }
    // A slow page still loading in the tab we left, with an autofocus field, must not take the cursor from the new tab.
    await keepsCaret('a tab still loading (autofocus field) when a new tab opens', async () => { await ui.evaluate(() => document.getElementById('address').focus()); await app.evaluate((_e, u) => { global.__agent.browser.openTab(u); }, `${base}/slow`); await sleep(200); }, async () => { await ctrl('t', 'ui'); await sleep(4000); }, { expectActiveChange: true });
    await caretNow('a tab still loading (autofocus field) when a new tab opens: caret in the address bar after it finished');
    // Background tabs (middle-click, Open link in new tab, an AI tab) leave the cursor where it was.
    for (const [label, open] of [
      ['a link opened in a background tab', (u) => global.__agent.browser.openTab(u, { background: true, openerId: global.__agent.browser.activeTab().id })],
      ['an AI-opened tab', () => global.__agent.browser.openTab(undefined, { background: true, openedBy: { chatId: 'c1', runId: 'r1' } })],
      ['a background new-tab page', () => global.__agent.browser.openTab(undefined, { background: true })],
    ]) {
      await keepsCaret(`${label}: caret stays in the address bar`, async () => { await openPage('/start'); await ui.evaluate(() => document.getElementById('address').focus()); await focusUi(); }, async () => { await app.evaluate((_e, { src, base }) => { new Function('u', `return (${src})(u)`)(base + '/linked'); }, { src: open.toString(), base }); await sleep(1500); });
      await caretNow(`${label}: still the address bar afterwards`);
    }
    for (const [label, open] of [
      ['a link opened in a background tab', (u) => global.__agent.browser.openTab(u, { background: true, openerId: global.__agent.browser.activeTab().id })],
      ['an AI-opened tab', () => global.__agent.browser.openTab(undefined, { background: true, openedBy: { chatId: 'c1', runId: 'r1' } })],
    ]) {
      await keepsCaret(`${label}: the page's input keeps the keyboard`, async () => { await openPage('/form'); await pageFocus("document.getElementById('i').focus()"); }, async () => { await app.evaluate((_e, { src, base }) => { new Function('u', `return (${src})(u)`)(base + '/linked'); }, { src: open.toString(), base }); await sleep(1500); });
      if (!BG) {
        const s = await state();
        check(`${label}: native focus stays on the page in front`, s.focusedIsActive, JSON.stringify(s));
      }
    }
  }

  check('no UI errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
