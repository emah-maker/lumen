// Closing a tab must never take its window with it unless the USER closed the window's last tab (Chrome): the AI's closes, a held or doubled
// Ctrl+W, a page closing itself and a crashed window UI all leave the window, and a window that does close says why in
// diagnostics/window-events.jsonl. Run with LUMEN_TEST_BACKGROUND=1 and a temp CLAUDE_BROWSER_PROFILE.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabclosewin-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const wins = () => app.evaluate(() => global.__windows.list().map((w) => ({ id: w.windowId, tabs: w.tabs.map((t) => t.id), activeId: w.activeId })));
    const events = () => { try { return fs.readFileSync(path.join(profile, 'diagnostics', 'window-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const key = (extra) => app.evaluate((_e, x) => global.__pageTools.handleShortcut({ key: 'w', control: true, ...x }), extra);
    const newWindow = async () => { const before = (await wins()).map((w) => w.id); await app.evaluate(() => global.__basics.openNewWindow()); return waitFor(async () => (await wins()).find((x) => !before.includes(x.id) && x.tabs.length)); };

    // 1. A held Ctrl+W, and one press reported twice, close one tab: not the tab that takes its place, nor the window.
    const first = (await wins())[0];
    for (let i = 0; i < 3; i++) await app.evaluate((_e, wid) => global.__windows.open(wid, 'about:blank'), first.id);
    await waitFor(async () => (await wins())[0].tabs.length === 4);
    await key({ isAutoRepeat: true });
    await sleep(600);
    check('a held Ctrl+W (auto-repeat) closes nothing', (await wins())[0].tabs.length === 4);
    await key({}); await key({});
    await waitFor(async () => (await wins())[0].tabs.length === 3);
    await sleep(600);
    check('one press seen twice closes one tab', (await wins())[0].tabs.length === 3, JSON.stringify(await wins()));
    await sleep(150);
    await key({});
    check('a later press closes the next one', !!(await waitFor(async () => (await wins())[0].tabs.length === 2)));

    // 2. The AI closing a window's only tab never closes the window (a fresh tab takes its place), by every path.
    const w2 = await newWindow();
    const total = (await wins()).length;
    const lone = w2.tabs[0];
    await app.evaluate((_e, id) => { global.__aiTabs.tab(id).openedBy = { chatId: 1, runId: 1, at: Date.now() }; global.__agent.browser.requestCloseTab(id); }, lone);
    await waitFor(async () => !(await wins()).find((w) => w.id === w2.id)?.tabs.includes(lone));
    await sleep(800);
    const after = (await wins()).find((w) => w.id === w2.id);
    check('the AI closing a window\'s only tab (close_tab) keeps the window, with a fresh tab', (await wins()).length === total && after && after.tabs.length === 1 && after.tabs[0] !== lone, JSON.stringify(await wins()));
    const lone2 = after.tabs[0];
    await app.evaluate((_e, id) => { global.__agent.browser.closeTab(id); }, lone2);
    await sleep(800);
    const after2 = (await wins()).find((w) => w.id === w2.id);
    check('code closing a window\'s only tab keeps the window too', (await wins()).length === total && after2 && after2.tabs.length === 1 && after2.tabs[0] !== lone2, JSON.stringify(await wins()));
    check('...and writes no window-closed breadcrumb', !events().some((e) => e.event === 'window-closed'), JSON.stringify(events()));

    // 3. Hidden AI tabs: the user closing the last tab they can see leaves the window (an AI tab comes to the front), it does not vanish.
    await app.evaluate(() => global.__settings.backend.set('hideAiTabs', true));
    const aiTab = await app.evaluate((_e, wid) => { const t = global.__windows.open(wid, 'about:blank'); global.__aiTabs.tab(t.id).openedBy = { chatId: 1, runId: 1, at: Date.now() }; return t.id; }, w2.id);
    const userTab = (await wins()).find((w) => w.id === w2.id).tabs.find((id) => id !== aiTab);
    await app.evaluate((_e, id) => { global.__aiTabs.switchTo(id); global.__closeTabInteractive(id); }, userTab);
    await sleep(1200);
    const w2now = (await wins()).find((w) => w.id === w2.id);
    check('closing the last visible tab with only a hidden AI tab left keeps the window', Boolean(w2now) && w2now.tabs.includes(aiTab), JSON.stringify(await wins()));

    // 4. The window UI crashing reloads it; no window closes.
    const before = (await wins()).length;
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('index.html')); w?.webContents.forcefullyCrashRenderer(); });
    await sleep(3000);
    check('a crashed window UI does not close any window', (await wins()).length === before, JSON.stringify(await wins()));

    // 5. The user closing a window's last tab does close it, and the breadcrumb says so.
    const w3 = await newWindow();
    const n = (await wins()).length;
    await app.evaluate((_e, id) => global.__closeTabInteractive(id), w3.tabs[0]);
    check('the user closing a window\'s last tab closes that window', !!(await waitFor(async () => (await wins()).length === n - 1)), JSON.stringify(await wins()));
    const ev = await waitFor(() => events().find((e) => e.event === 'window-closed'));
    check('window-events.jsonl says why: reason and tab counts', ev && ev.reason === 'user-closed-last-tab' && ev.tabsBefore && ev.tabsBefore.all === 1, JSON.stringify(events()));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
