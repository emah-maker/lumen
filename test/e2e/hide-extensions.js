// The toolbar's extension buttons, as Chrome's puzzle menu has them, with four tiny extensions installed through the same installer the store
// button uses (packed on the spot, served from 127.0.0.1 in place of the store's download address; no real network). Covers: new extensions
// start pinned while fewer than three are, the puzzle button and its menu (every extension, the pin checkboxes, "Manage extensions"), a popup
// run from the menu opening under the puzzle button, pin and unpin from the menu and from Settings → Extensions, the three modes (Only the
// ones I pin, All of them, Hide all: no extension button and no puzzle button, the extensions still running and still in Settings and the ⋯
// menu), the puzzle button's dot for an unpinned extension with a badge, the order (Alt+Arrow, and a drag) and that it is kept across a restart.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/hide-extensions.js   (HIDE_EXT_SHOTS=<dir> saves pictures of the toolbar)
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');
const { openSettingsTab } = require('../helpers/settings-tab');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(100); } return v; };

  // Four extensions: a toolbar popup each; the last one sets a badge when it starts.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hide-ext-src-'));
  const NAMES = ['Pin test Alpha', 'Pin test Beta', 'Pin test Gamma', 'Pin test Delta'];
  const packs = NAMES.map((name, i) => {
    const dir = path.join(root, `ext${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { manifest_version: 3, name, version: '1.0.0', description: 'A fixture for test/e2e/hide-extensions.js', action: { default_popup: 'popup.html', default_title: name } };
    if (i === 3) manifest.background = { service_worker: 'bg.js' };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'popup.html'), `<!doctype html><meta charset="utf-8"><title>${name}</title><div style="width:200px;height:100px">${name}</div>`);
    if (i === 3) fs.writeFileSync(path.join(dir, 'bg.js'), "chrome.action.setBadgeText({ text: '7' });");
    return { name, ...buildCrx(dir) };
  });
  const server = http.createServer((req, res) => {
    const m = /id%3D([a-p]{32})/.exec(req.url) || /id=([a-p]{32})/.exec(req.url);
    const pack = packs.find((p) => m && p.id === m[1]);
    if (req.url.startsWith('/crx') && pack) { res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(pack.crx); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Extension test page</title><body><p>hello</p></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const [A, B, C, D] = packs.map((p) => p.id);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hide-ext-'));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WEBSTORE_ORIGIN: origin } });
  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  const watch = () => ui.on('pageerror', (e) => errors.push(e.message));
  watch();
  const shots = process.env.HIDE_EXT_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const shot = async (name) => { if (shots) await ui.screenshot({ path: path.join(shots, `${name}.png`), clip: { x: 0, y: 0, width: (await ui.evaluate(() => innerWidth)), height: 90 } }).catch(() => {}); };

  // What the toolbar shows now: each button's id, whether it is visible (shown, with a size), and its place; the puzzle button.
  const bar = () => ui.evaluate(() => {
    const list = document.getElementById('extension-actions');
    const puzzle = document.getElementById('actions-overflow');
    const buttons = [...(list.shadowRoot?.querySelectorAll('.action') || [])].map((n) => { const r = n.getBoundingClientRect(); return { id: n.id, shown: !n.hidden && r.width > 0, order: Number(n.style.order || 0), x: r.left, draggable: n.draggable }; });
    const pr = puzzle.getBoundingClientRect();
    const toolbar = buttons.filter((b) => b.shown).sort((a, b) => a.x - b.x).map((b) => b.id);
    return { all: buttons.map((b) => b.id), toolbar, puzzle: !puzzle.hidden && pr.width > 0, dot: puzzle.classList.contains('has-attention'), label: puzzle.getAttribute('aria-label'), puzzleRect: { left: pr.left, right: pr.right, bottom: pr.bottom }, listShown: list.getBoundingClientRect().width > 0, noExt: document.documentElement.classList.contains('pref-no-extensions'), buttons };
  });
  const barIs = async (expect, ms = 8000) => { let last; const ok = await waitFor(async () => { last = await bar(); return expect(last) ? last : null; }, ms); return ok || last; };
  const ids = (list) => JSON.stringify(list);
  const saved = (key) => app.evaluate((_e, k) => global.__settings.backend.state().prefs[k], key);
  const setting = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v), [key, value]);
  const menu = () => app.evaluate(() => (global.__extensionsMenu || []).map((i) => ({ label: i.label || '', type: i.type || 'normal', sub: (i.submenu || []).map((s) => ({ label: s.label, type: s.type, checked: s.checked, enabled: s.enabled !== false })) })));
  const clickPuzzle = async () => { await app.evaluate(() => { global.__extensionsMenu = null; }); await ui.click('#actions-overflow'); return waitFor(() => app.evaluate(() => Boolean(global.__extensionsMenu))); };
  const popups = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((x) => x.webContents.getURL().startsWith('chrome-extension://') && x.isVisible()).map((w) => ({ url: w.webContents.getURL(), bounds: w.getBounds() })));
  const closePopups = () => app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().startsWith('chrome-extension://') && !w.isDestroyed()) w.destroy(); });

  try {
    await ui.waitForSelector('.tab');
    const none = await bar();
    check('nothing installed: no extension buttons and no puzzle button', none.all.length === 0 && !none.puzzle, JSON.stringify(none));

    // ---- install: the first three start pinned, the fourth starts in the menu
    for (const p of packs) {
      const r = await app.evaluate(async (_e, id) => { try { const ext = await global.__installExtension(id); return { ok: true, name: ext.name }; } catch (err) { return { ok: false, error: err.message }; } }, p.id).catch((e) => ({ ok: false, error: e.message }));
      check(`install ${p.name}`, r.ok && r.name === p.name, JSON.stringify(r));
      await waitFor(async () => ((await saved('extensionPins')).seen || []).includes(p.id), 8000); // each one gets its first pin choice before the next is installed (a real install is one at a time)
    }
    let b = await barIs((s) => s.all.length === 4 && s.toolbar.length === 3);
    check('four extensions have buttons; three show in the toolbar', b.all.length === 4 && b.toolbar.length === 3, JSON.stringify(b));
    check('the first three installed are the pinned ones, in install order', ids(b.toolbar) === ids([A, B, C]), ids(b.toolbar));
    check('the fourth starts unpinned: its button exists (it keeps running) but is not shown', b.buttons.find((x) => x.id === D)?.shown === false);
    check('the puzzle button shows, named Extensions', b.puzzle && /^Extensions/.test(b.label), JSON.stringify([b.puzzle, b.label]));
    check('the saved pins are the first three', ids((await saved('extensionPins')).order) === ids([A, B, C]), ids(await saved('extensionPins')));
    check('the mode defaults to Only the ones I pin', (await saved('extensionsToolbar')) === 'pinned');
    await shot('1-pinned-default');

    // ---- an unpinned extension with a badge: a dot on the puzzle button
    b = await barIs((s) => s.dot, 12000);
    check('the unpinned extension\'s badge puts a dot on the puzzle button', b.dot === true, JSON.stringify([b.dot, b.label]));
    check('the dotted puzzle button says so in its name', /something to show/.test(b.label), b.label);
    await shot('2-dot');

    // ---- the menu
    check('clicking the puzzle button opens the menu', await clickPuzzle(), 'no menu');
    let m = await menu();
    const names = m.filter((i) => i.type === 'normal' && !i.sub.length).map((i) => i.label);
    check('the menu lists every extension, the pinned ones first', ids(names.slice(0, 4)) === ids(['Pin test Alpha', 'Pin test Beta', 'Pin test Gamma', 'Pin test Delta']), ids(names));
    const pinMenu = m.find((i) => i.label === 'Pin to toolbar');
    check('the menu has Pin to toolbar with a checkbox per extension, the pinned ones checked', pinMenu?.sub.length === 4 && ids(pinMenu.sub.map((s) => s.checked)) === ids([true, true, true, false]) && pinMenu.sub.every((s) => s.type === 'checkbox' && s.enabled), JSON.stringify(pinMenu));
    check('the menu ends with Manage extensions', m[m.length - 1].label === 'Manage extensions…', JSON.stringify(m[m.length - 1]));

    // ---- a popup from the menu opens, under the puzzle button
    await app.evaluate(() => global.__extensionsMenu[3].click()); // Delta: not in the toolbar
    const popup = await waitFor(async () => (await popups()).find((p) => p.url.startsWith(`chrome-extension://${D}/popup.html`)), 10000);
    check('Delta (only in the menu) opens its popup from the menu', Boolean(popup), JSON.stringify(await popups()));
    if (popup) {
      const win = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html')); const c = w.getContentBounds(); return { x: c.x, y: c.y }; });
      const pr = b.puzzleRect;
      const nearX = popup.bounds.x <= win.x + pr.right + 8 && popup.bounds.x + popup.bounds.width >= win.x + pr.left - 8;
      check('the popup is anchored to the puzzle button (under it, in line with it)', nearX && popup.bounds.y >= win.y + pr.bottom - 12 && popup.bounds.y <= win.y + pr.bottom + 80, JSON.stringify({ popup: popup.bounds, win, pr }));
    }
    await closePopups();
    await sleep(200);

    // ---- pin from the menu: Delta joins the toolbar, the dot goes
    await clickPuzzle();
    m = await menu();
    await app.evaluate(() => { const sub = global.__extensionsMenu.find((i) => i.label === 'Pin to toolbar').submenu; sub[3].click({ checked: true }); });
    b = await barIs((s) => s.toolbar.length === 4);
    check('pinned from the menu: Delta is now the last button in the toolbar', ids(b.toolbar) === ids([A, B, C, D]), ids(b.toolbar));
    check('...and its dot is gone (a pinned badge is in plain sight)', b.dot === false);
    check('...and the pin is saved', ids((await saved('extensionPins')).order) === ids([A, B, C, D]));

    // ---- unpin from Settings → Extensions
    const inSettings = await openSettingsTab(app, 'extensions');
    const rows = await waitFor(async () => { const n = await inSettings("document.querySelectorAll('#extensions-list .item').length"); return n === 4 ? n : null; }, 10000);
    check('Settings → Extensions lists the four, each with a Show in toolbar switch', rows === 4 && (await inSettings("document.querySelectorAll('#extensions-list .ext-pin input.switch').length")) === 4, rows);
    check('the switches mirror the pins (all four on)', (await inSettings("[...document.querySelectorAll('#extensions-list .ext-pin input.switch')].map((i) => i.checked).join()")) === 'true,true,true,true');
    check('the mode row offers the three choices', (await inSettings("[...document.querySelectorAll('#pref-extensionsToolbar option')].map((o) => o.value).join()")) === 'pinned,all,none');
    await inSettings("document.querySelector('#extensions-list .ext-pin input.switch[aria-label*=\"Alpha\"]').click()"); // the list is not in install order
    b = await barIs((s) => s.toolbar.length === 3);
    check('switched off in Settings: Alpha leaves the toolbar and the others stay in order', ids(b.toolbar) === ids([B, C, D]), ids(b.toolbar));
    check('...and Alpha\'s switch is off, in the saved pins too', (await inSettings("[...document.querySelectorAll('#extensions-list .ext-pin input.switch')].map((i) => (/Alpha/.test(i.getAttribute('aria-label')) ? 'A' : '') + i.checked).sort().join()")) === 'Afalse,true,true,true' && ids((await saved('extensionPins')).order) === ids([B, C, D]));
    await clickPuzzle();
    m = await menu();
    check('the menu mirrors it (Alpha unchecked)', ids(m.find((i) => i.label === 'Pin to toolbar').sub.map((s) => s.checked)) === ids([false, true, true, true]) || ids(m.find((i) => i.label === 'Pin to toolbar').sub.map((s) => s.checked)).includes('false'), JSON.stringify(m.find((i) => i.label === 'Pin to toolbar')));
    await shot('3-unpinned-alpha');

    // ---- order: Alt+Arrow moves the focused button; a drag moves it too; both are saved
    await ui.evaluate((id) => document.getElementById('extension-actions').shadowRoot.getElementById(id).focus(), D);
    await ui.keyboard.press('Alt+ArrowLeft');
    b = await barIs((s) => s.toolbar[1] === D);
    check('Alt+Left on Delta moves it one place left', ids(b.toolbar) === ids([B, D, C]), ids(b.toolbar));
    check('...and it is saved', ids((await saved('extensionPins')).order.slice(0, 3)) === ids([B, D, C]), ids(await saved('extensionPins')));
    check('...and keeps the keyboard focus', await ui.evaluate((id) => document.getElementById('extension-actions').shadowRoot.activeElement?.id === id, D));
    await ui.keyboard.press('Alt+ArrowLeft');
    await ui.keyboard.press('Alt+ArrowLeft'); // already first: stays
    b = await barIs((s) => s.toolbar[0] === D);
    check('Alt+Left again puts it first; once more at the end of the row changes nothing', ids(b.toolbar) === ids([D, B, C]), ids(b.toolbar));
    const dragTo = (from, before) => ui.evaluate(([f, bf]) => {
      const root = document.getElementById('extension-actions').shadowRoot;
      const src = root.getElementById(f);
      const tgt = bf ? root.getElementById(bf) : null;
      const dt = new DataTransfer();
      const fire = (el, type, x) => el.dispatchEvent(new DragEvent(type, { bubbles: true, composed: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: 14 }));
      const list = document.getElementById('extension-actions');
      const last = [...root.querySelectorAll('.action')].filter((n) => !n.hidden).sort((a, c) => a.getBoundingClientRect().left - c.getBoundingClientRect().left).pop().getBoundingClientRect();
      const x = tgt ? tgt.getBoundingClientRect().left + 3 : last.right + 6;
      fire(src, 'dragstart', src.getBoundingClientRect().left + 3);
      fire(list, 'dragover', x);
      const marked = Boolean(root.querySelector('.drop-before, .drop-after'));
      fire(list, 'drop', x);
      fire(src, 'dragend', x);
      return marked;
    }, [from, before]);
    const marked = await dragTo(D, null);
    b = await barIs((s) => s.toolbar[2] === D);
    check('dragging Delta past the last button puts it last (a drop marker showed on the way)', marked && ids(b.toolbar) === ids([B, C, D]), ids(b.toolbar));
    await dragTo(C, B);
    b = await barIs((s) => s.toolbar[0] === C);
    check('dragging Gamma before Beta moves it there', ids(b.toolbar) === ids([C, B, D]), ids(b.toolbar));
    check('a drag is saved', ids((await saved('extensionPins')).order.slice(0, 3)) === ids([C, B, D]), ids(await saved('extensionPins')));
    check('only the pinned buttons can be dragged', (await bar()).buttons.every((x) => x.draggable === [C, B, D].includes(x.id)));
    await shot('4-reordered');

    // ---- All of them: every button shows, pinned first; the puzzle button only when there is no room
    await setting('extensionsToolbar', 'all');
    b = await barIs((s) => s.toolbar.length === 4);
    check('All of them: all four buttons show, the pinned ones first', ids(b.toolbar) === ids([C, B, D, A]), ids(b.toolbar));
    check('...with room, no puzzle button is needed', b.puzzle === false, b.puzzle);
    await shot('5-all');

    // ---- Hide all: no extension button and no puzzle button; the extensions run, and Settings and the ⋯ menu list them
    await setting('extensionsToolbar', 'none');
    b = await barIs((s) => !s.listShown && !s.puzzle);
    check('Hide all: no extension buttons and no puzzle button', b.toolbar.length === 0 && !b.puzzle && !b.listShown && b.noExt, JSON.stringify([b.toolbar, b.puzzle, b.listShown]));
    check('...but the extensions are still loaded and running', (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().filter((e) => e.name.startsWith('Pin test')).length)) === 4);
    check('...and their buttons are still there for their badges (Delta\'s badge survived)', (await ui.evaluate((id) => Boolean(document.getElementById('extension-actions').shadowRoot.getElementById(id)?.querySelector('.badge')), D)) === true);
    const extItems = await app.evaluate(() => global.__extensionsAppMenu());
    check('...and the ⋯ menu still lists them', extItems.filter((i) => i.label.startsWith('Pin test')).length === 4, JSON.stringify(extItems));
    const inSettings2 = await openSettingsTab(app, 'extensions');
    await inSettings2('location.reload()'); // the page was opened before the mode changed: a fresh look
    await sleep(500);
    await waitFor(async () => (await inSettings2('document.body?.dataset.ready === "1"')) === true, 10000);
    await waitFor(async () => (await inSettings2("document.querySelectorAll('#extensions-list .item').length")) === 4, 10000);
    check('...and Settings → Extensions lists them, the switches off-limits while nothing is shown', (await inSettings2("[...document.querySelectorAll('#extensions-list .ext-pin input.switch')].every((i) => i.disabled)")) === true && (await inSettings2("document.getElementById('pref-extensionsToolbar').value")) === 'none', JSON.stringify(await inSettings2("[[...document.querySelectorAll('#extensions-list .ext-pin input.switch')].map((i) => i.disabled), document.getElementById('pref-extensionsToolbar')?.value]")));
    await shot('6-hidden');

    // ---- the ⋯ menu's extension entries: "Show in toolbar"
    check('the ⋯ menu entries carry Show in toolbar (disabled while Hide all is on)', extItems.every((i) => i.pin?.label === 'Show in toolbar' && i.pin.enabled === false), JSON.stringify(extItems));

    // ---- back to Only the ones I pin: the order and pins are as they were left
    await setting('extensionsToolbar', 'pinned');
    b = await barIs((s) => s.toolbar.length === 3 && s.puzzle);
    check('Only the ones I pin again: the same three, in the same order, and the puzzle button is back', ids(b.toolbar) === ids([C, B, D]) && b.puzzle, JSON.stringify([b.toolbar, b.puzzle]));

    // ---- a restart keeps the pins and the order
    await app.evaluate(() => global.__settingsFlush?.());
    await app.close();
    app = await launch();
    ui = await app.firstWindow();
    watch();
    await ui.waitForSelector('.tab');
    b = await barIs((s) => s.all.length === 4 && s.toolbar.length === 3, 45000);
    check('after a restart: the same pinned extensions in the same order', ids(b.toolbar) === ids([C, B, D]), JSON.stringify([b.all, b.toolbar]));
    check('...Alpha is still in the menu only, the puzzle button shows', b.buttons.find((x) => x.id === A)?.shown === false && b.puzzle);
    check('...and the saved pins and mode are as left', ids((await saved('extensionPins')).order) === ids([C, B, D]) && (await saved('extensionsToolbar')) === 'pinned');

    // ---- narrow window and the side tab list: nothing overlaps, the puzzle button stays reachable
    await setting('tabLayout', 'side');
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html')); w.setSize(700, 600); });
    await sleep(600);
    const narrow = await ui.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; };
      const end = document.querySelector('.toolbar-end');
      const omni = document.getElementById('omnibox');
      const puzzle = document.getElementById('actions-overflow');
      const list = document.getElementById('extension-actions');
      const items = [...end.children].filter((el) => !el.hidden && el.getBoundingClientRect().width > 0).map(rect);
      return { win: innerWidth, end: rect(end), omni: rect(omni), puzzle: rect(puzzle), puzzleHidden: puzzle.hidden, list: rect(list), items, overlap: items.some((a, i) => items.some((c, j) => j > i && a.l < c.r - 1 && c.l < a.r - 1)) };
    });
    check('a narrow window with side tabs: the puzzle button is shown, whole, inside the window', !narrow.puzzleHidden && narrow.puzzle.l >= 0 && narrow.puzzle.r <= narrow.win + 1 && narrow.puzzle.w > 0, JSON.stringify(narrow.puzzle));
    check('...nothing in the end column overlaps, and the address field keeps clear of it', !narrow.overlap && narrow.omni.r <= narrow.end.l + 1, JSON.stringify({ omni: narrow.omni, end: narrow.end }));
    await shot('7-narrow-side-tabs');
    await setting('tabLayout', 'top');

    check('no page errors in the toolbar', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
