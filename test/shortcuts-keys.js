// Ctrl+Enter and the Meeting helper key, in the real app (hidden: LUMEN_TEST_BACKGROUND=1), with keys that arrive the way a user's do
// (webContents.sendInputEvent, so main.js's before-input-event sees them first; a synthetic DOM event would skip that).
// The decision: Ctrl+Enter means one thing, "send what is typed in this box now". It never toggles the Meeting helper (that is
// Ctrl+Shift+E now, and a page that uses Ctrl+Shift+E gets it first). Contexts:
//   - sidebar chat box: Ctrl+Enter reaches the box (Send now while a reply runs); it used to be swallowed by the Meeting helper toggle
//   - Ctrl+Shift+E: opens and closes the Meeting helper from the sidebar, and from a page that leaves the key alone
//   - a page that takes Ctrl+Shift+E (Google Docs: centre) keeps it; a page gets Ctrl+Enter untouched (send in Gmail)
//   - new-tab page: Ctrl+Enter asks the AI (the tab becomes the full-page chat), and its hint names the key
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PAGE = (mode) => `<!doctype html><title>Editor ${mode}</title><textarea id="t"></textarea><script>
  window.__keys = [];
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    window.__keys.push(e.key.toLowerCase() + (e.shiftKey ? '+shift' : ''));
    if (${JSON.stringify(mode)} === 'handles' && e.shiftKey && e.key.toLowerCase() === 'e') e.preventDefault(); // Docs: centre
  });
</script>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); } catch { v = null; } if (v) return v; await sleep(100); } return v; };

  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE(req.url.slice(1) || 'plain')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-shortcuts-keys-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => window.assistant.setAutoGroup(false));
    await sleep(800);

    // keys sent to the UI's own webContents (sidebar, toolbar) or to the front tab's page
    const sendTo = (target, keyCode, modifiers) => app.evaluate(async ({ BrowserWindow }, [tgt, k, m]) => {
      const wc = tgt === 'ui' ? BrowserWindow.getAllWindows()[0].webContents : global.__agent.browser.activeTab().webContents;
      wc.focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
      await new Promise((r) => setTimeout(r, 600));
    }, [target, keyCode, modifiers]);
    const meetingShown = () => ui.evaluate(() => { const p = document.getElementById('meeting-panel'); return Boolean(p) && !p.hidden && !!window.meetingUi; });
    const meetingTouched = () => ui.evaluate(() => Boolean(window.meetingUi));
    const tabJs = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
    const go = async (text) => { await app.evaluate(({ ipcMain }, t) => ipcMain.emit('nav:go', {}, t), text); await sleep(1800); };

    // ---- sidebar chat box: Ctrl+Enter reaches it, and does not touch the Meeting helper
    await ui.evaluate(() => { window.__k = []; document.addEventListener('keydown', (e) => window.__k.push(`${e.target.id || e.target.tagName}:${e.key}${e.ctrlKey ? '+ctrl' : ''}${e.shiftKey ? '+shift' : ''}`), true); });
    await ui.evaluate(() => { const b = document.getElementById('toggle-sidebar') || document.querySelector('[data-action="toggle-sidebar"]'); document.body.classList.contains('sidebar-hidden') && b?.click(); });
    await ui.evaluate(() => document.getElementById('prompt')?.focus());
    await sendTo('ui', 'Return', ['control']);
    const got = await ui.evaluate(() => window.__k.slice());
    check('sidebar box: Ctrl+Enter arrives at the page (Send now needs it)', got.some((k) => /:Enter\+ctrl$/.test(k)), JSON.stringify(got));
    check('sidebar box: Ctrl+Enter does not open the Meeting helper', !(await meetingTouched()) || !(await meetingShown()), '');

    // ---- Ctrl+Shift+E opens and closes the Meeting helper from the sidebar
    await sendTo('ui', 'E', ['control', 'shift']);
    check('Ctrl+Shift+E opens the Meeting helper', await waitFor(meetingShown, 15000), '');
    await sendTo('ui', 'E', ['control', 'shift']);
    check('Ctrl+Shift+E again closes it', await waitFor(async () => !(await meetingShown()), 5000), '');

    // ---- on a web page: a page that takes Ctrl+Shift+E keeps it; one that leaves it alone lets Lumen open the helper
    await go(`${base}/handles`);
    await sendTo('tab', 'E', ['control', 'shift']);
    check('a page that handles Ctrl+Shift+E gets it first and the Meeting helper stays closed', (await tabJs('window.__keys.slice()')).includes('e+shift') && !(await meetingShown()), JSON.stringify(await tabJs('window.__keys.slice()')));
    await go(`${base}/plain`);
    await sendTo('tab', 'E', ['control', 'shift']);
    check('a page that leaves Ctrl+Shift+E alone: the page saw it, then the Meeting helper opens', (await tabJs('window.__keys.slice()')).includes('e+shift') && (await waitFor(meetingShown, 15000)), JSON.stringify(await tabJs('window.__keys.slice()')));
    await sendTo('ui', 'E', ['control', 'shift']); // close it again
    await waitFor(async () => !(await meetingShown()), 5000);
    await sendTo('tab', 'Return', ['control']);
    check('on a page Ctrl+Enter is the page\'s own (it sees it) and does not open the Meeting helper', (await tabJs('window.__keys.slice()')).includes('enter') && !(await meetingShown()), JSON.stringify(await tabJs('window.__keys.slice()')));

    // ---- new-tab page: the hint names the key, and Ctrl+Enter asks the AI (the tab becomes the full-page chat)
    await app.evaluate(async () => {
      const t = global.__agent.browser.openTab();
      await new Promise((r) => { t.webContents.once('did-finish-load', r); setTimeout(r, 6000); });
      global.__chatPage.switchTab(t.id);
    });
    await waitFor(() => tabJs("document.getElementById('q') ? 'yes' : ''"));
    const hint = await tabJs("document.getElementById('mode-hint').textContent");
    check('new-tab hint names Ctrl+Enter for asking the AI', /Ctrl\+Enter to ask AI/.test(hint) && !/Mod\+/.test(hint), hint);
    await tabJs("document.getElementById('q').focus()");
    await sendTo('tab', 'Return', ['control']);
    const chat = await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs())).find((t) => t.id === id && /chat-page\.html/.test(t.url)), 10000);
    check('new-tab box: Ctrl+Enter opens the full-page chat in that tab', Boolean(chat), JSON.stringify(await app.evaluate(() => global.__chatPage.tabs())));
    check('new-tab box: and did not open the Meeting helper', !(await meetingShown()), '');
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
