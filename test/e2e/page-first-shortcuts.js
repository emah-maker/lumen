// Page-first shortcuts (features/page-first-keys.js), in the real app (hidden: LUMEN_TEST_BACKGROUND=1).
// MATLAB Online, Google Docs, VS Code for the Web, Figma and Overleaf handle Ctrl+S themselves and call preventDefault(); Chrome then
// does not save the page. Lumen must do the same: the page gets Ctrl+S / Ctrl+P / Ctrl+F first, and Lumen's own action runs only when
// the page left the key alone. Browser keys (Ctrl+T, Ctrl+W...) stay Lumen's whatever the page does. Keys arrive the way a user's do
// (webContents.sendInputEvent). Lumen's save is stubbed (no dialog); the print preview is Lumen's own sheet (no OS dialog) and is closed.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// A page that handles these keys like a web app does (preventDefault) and records every key it sees; ?mode picks what it does.
const PAGE = (mode) => `<!doctype html><title>Editor ${mode}</title><textarea id="t"></textarea><iframe id="f" src="/frame" style="position:fixed;left:0;top:0;width:200px;height:100px"></iframe><script>
  window.__keys = [];
  const mode = ${JSON.stringify(mode)};
  const mine = new Set(['s', 'p', 'f', 'g', 't', 'w', 'o', 'd', 'tab']);
  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    window.__keys.push(k + (e.shiftKey ? '+shift' : ''));
    if (mode === 'handles' && mine.has(k)) e.preventDefault();
  };
  if (mode === 'stops') { // handles it in a capture handler and stops it from going any further, as some editors do
    document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 's') { window.__keys.push('s'); e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  } else window.addEventListener('keydown', onKey);
</script>`;
const FRAME = `<!doctype html><title>frame</title><input id="i"><script>
  window.__keys = [];
  window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 's') { window.__keys.push('s'); e.preventDefault(); } });
</script>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pagefirst-tmp-'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/frame') return res.end(FRAME);
    res.end(PAGE(req.url.slice(1) || 'plain'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pagefirst-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: dir, TMP: dir },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  await sleep(800);

  const go = async (text) => { await app.evaluate(({ ipcMain }, t) => ipcMain.emit('nav:go', {}, t), text); await sleep(1800); };
  const tabJs = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  const list = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => t.id));
  // A real key press to the front tab: keyDown, then keyUp, with Ctrl (and Shift) held.
  const press = (keyCode, mods = ['control']) => app.evaluate(async (_e, [k, m]) => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
    await new Promise((r) => setTimeout(r, 700));
  }, [keyCode, mods]);
  const pageKeys = () => tabJs('window.__keys.slice()');

  // Lumen's save is stubbed and counted; Lumen's find bar and print sheet are read from the UI and the print module.
  await app.evaluate(() => { global.__saves = 0; global.__pageTools.tools.savePage = async () => { global.__saves += 1; return null; }; });
  const saves = () => app.evaluate(() => global.__saves);
  const findOpen = () => ui.evaluate(() => !document.getElementById('findbar').hidden);
  const closeFind = () => ui.evaluate(() => { document.getElementById('findbar').hidden = true; });
  const printOpen = () => app.evaluate(() => global.__printPreview.printPreview.isOpen());
  const closePrint = async () => { await app.evaluate(() => global.__printPreview.printPreview.close('cancel')); await waitFor(async () => !(await printOpen()), 3000); };

  // ---- Lumen's own pages keep their keys: on the new-tab page Ctrl+S is Lumen's at once
  await go('lumen://newtab');
  const n0 = await saves();
  await press('S');
  check("the new-tab page: Ctrl+S reaches Lumen's save (its own page keeps its keys)", (await saves()) === n0 + 1, `${n0} -> ${await saves()}`);

  // ---- a page that handles the keys
  const s1 = await saves();
  await go(`${base}/handles`);
  await tabJs('document.getElementById("t").focus()');
  await press('S');
  check('handling page: it saw Ctrl+S', (await pageKeys()).includes('s'), JSON.stringify(await pageKeys()));
  check('handling page: Lumen\'s Save page did NOT run', (await saves()) === s1, await saves());
  await press('P');
  check('handling page: it saw Ctrl+P', (await pageKeys()).includes('p'), JSON.stringify(await pageKeys()));
  check('handling page: Lumen\'s print sheet did NOT open', !(await printOpen()), '');
  await press('F');
  check('handling page: it saw Ctrl+F', (await pageKeys()).includes('f'), JSON.stringify(await pageKeys()));
  check('handling page: Lumen\'s find bar did NOT open', !(await findOpen()), '');
  await press('G');
  check('handling page: Ctrl+G did not open Lumen\'s find bar', !(await findOpen()), '');

  // ---- a page that handles Ctrl+S and stops it from propagating
  await go(`${base}/stops`);
  await tabJs('document.getElementById("t").focus()');
  await press('S');
  check('stopping page: it handled Ctrl+S', (await pageKeys()).includes('s'), JSON.stringify(await pageKeys()));
  check('stopping page: Lumen\'s Save page did NOT run', (await saves()) === s1, await saves());

  // ---- a same-origin frame (Google Docs types into one) that handles Ctrl+S: a click puts the focus in the frame
  await go(`${base}/plain`);
  const ready = await app.evaluate(() => { const wc = global.__agent.browser.activeTab().webContents; const f = wc.mainFrame.frames[0]; return { main: global.__pageFirst.ready().includes(global.__pageFirst.frameKey(wc.mainFrame)), frame: f ? global.__pageFirst.ready().includes(global.__pageFirst.frameKey(f)) : null }; });
  console.log(`INFO  preload ran in: main frame ${ready.main}, same-origin iframe (hooked by the main frame's preload) ${ready.frame}`);
  const s0 = await saves();
  await app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.focus();
    for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: 40, y: 40, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 400));
  });
  const focusedIsFrame = await app.evaluate(() => { const wc = global.__agent.browser.activeTab().webContents; return Boolean(wc.focusedFrame) && wc.focusedFrame !== wc.mainFrame; });
  await press('S');
  const frameSaw = await app.evaluate(() => global.__agent.browser.activeTab().webContents.mainFrame.frames[0].executeJavaScript('window.__keys.slice()'));
  check('a handling frame in the page got the focus and saw Ctrl+S', focusedIsFrame && frameSaw.includes('s'), JSON.stringify({ focusedIsFrame, frameSaw }));
  check("a handling frame in the page: Lumen's Save page did NOT run", (await saves()) === s0, `${s0} -> ${await saves()}`);

  // ---- a page that does not handle the keys
  await go(`${base}/plain`);
  await tabJs('document.getElementById("t").focus()');
  const p0 = await saves();
  await press('S');
  check('plain page: it saw Ctrl+S', (await pageKeys()).includes('s'), JSON.stringify(await pageKeys()));
  check("plain page: Lumen's Save page ran, once", (await saves()) === p0 + 1, `${p0} -> ${await saves()}`);
  await press('S');
  check('plain page: a second Ctrl+S saves again (one save each)', (await saves()) === p0 + 2, await saves());
  await press('P');
  check("plain page: Ctrl+P opens Lumen's print sheet", await waitFor(printOpen), '');
  await closePrint();
  await press('F');
  check("plain page: Ctrl+F opens Lumen's find bar", await waitFor(findOpen), '');
  await closeFind();

  // ---- browser keys stay the browser's, even when the page calls preventDefault on them
  await go(`${base}/handles`);
  await tabJs('document.getElementById("t").focus()');
  const tabsBefore = await list();
  await press('T');
  const afterT = await waitFor(async () => { const l = await list(); return l.length === tabsBefore.length + 1 ? l : null; }, 3000);
  check('Ctrl+T opens a tab although the page prevents it', Boolean(afterT), JSON.stringify({ tabsBefore, afterT }));
  const newTab = (afterT || []).find((id) => !tabsBefore.includes(id));
  if (newTab) {
    await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), newTab);
    await go(`${base}/handles`);
    await tabJs('document.getElementById("t").focus()');
    const n = (await list()).length;
    await press('W');
    const closed = await waitFor(async () => (await list()).length === n - 1, 3000);
    check('Ctrl+W closes the tab although the page prevents it', Boolean(closed), `${n} -> ${(await list()).length}`);
  }

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll page-first shortcut checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
