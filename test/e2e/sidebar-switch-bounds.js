// A tab switch lays the incoming page out once, for its own sidebar (main.js fitTabSidebar, renderer/app.js followTabSidebar). Tab A has the
// AI sidebar open, tab B has it closed; switching between them by clicking the strip, the incoming tab's view must take one size and keep it:
//   - every bounds its view is given from the click until things settle (each setBounds, and its bounds sampled every 4 ms) is one value:
//     B full width (never first at A's narrower width), A narrower by the sidebar (never first at B's full width);
//   - its page sees no resize (no layout at a size in between);
//   - no slide and no snapshot of the tab left (the sidebar is applied at once on a switch);
//   - the UI's sidebar ends as the incoming tab has it.
// Hidden window (LUMEN_TEST_BACKGROUND=1), a temporary profile.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(40); } return v; };

// A page that reports every resize of its own layout.
const PAGE = (name) => `<!doctype html><title>Page ${name}</title><body style="margin:0;font:15px Arial">
<h1>PAGE-${name}</h1><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">${Array.from({ length: 30 }, (_, i) => `<div style="height:90px;background:hsl(${i * 12},60%,70%)"></div>`).join('')}</div>
<script>window.__resizes = []; addEventListener('resize', () => window.__resizes.push(innerWidth));</script></body>`;

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE((req.url || '/').slice(1) || 'home')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidebar-switch-bounds-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarNewChat: false, performanceMode: 'off' }));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const errors = [];
  try {
    const ui = await app.firstWindow();
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => window.assistant.setAutoGroup?.(false));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    const open = (u) => app.evaluate(async (_e, url) => { const t = global.__agent.browser.openTab(url); await new Promise((r) => t.webContents.once('did-finish-load', r)); return global.__windows.list()[0].activeId; }, u);
    const active = () => app.evaluate(() => global.__windows.list()[0].activeId);
    const sidebarOf = (id) => app.evaluate((_e, i) => global.__tabChats.sidebar(i), id);
    const uiSidebar = () => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden'));
    const settled = (want) => waitFor(() => ui.evaluate((o) => {
      const b = document.body;
      return document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === String(o) && !b.classList.contains('sidebar-moving') && b.classList.contains('sidebar-hidden') === !o && !document.querySelector('.page-snapshot');
    }, want), 6000);

    const tabA = await open(`${base}/alpha`);
    await app.evaluate((_e, i) => global.__tabChats.setSidebar(i, true), tabA);
    check('tab A: its sidebar opens', await settled(true), await uiSidebar());
    const tabB = await open(`${base}/beta`);
    check('tab B: opened in front with its sidebar closed', (await active()) === tabB && (await sidebarOf(tabB)) === false && Boolean(await settled(false)), `${await active()} ${await sidebarOf(tabB)} ${await uiSidebar()}`);
    await sleep(600);

    // Main side: every setBounds on a tab's view, and its bounds sampled every 4 ms, for the tab named.
    await app.evaluate(({ BrowserWindow }) => {
      const viewOf = (id) => { const cid = global.__windows.list()[0].tabs.find((t) => t.id === id)?.contentsId; return BrowserWindow.getAllWindows()[0].contentView.children.find((c) => c.webContents?.id === cid); };
      const key = (b) => `${b.x},${b.y},${b.width}x${b.height}`;
      global.__watch = (id) => {
        const view = viewOf(id);
        const rec = { calls: [], samples: [key(view.getBounds())] };
        if (!view.__origSetBounds) view.__origSetBounds = view.setBounds;
        view.setBounds = function (b) { rec.calls.push(key(b)); return view.__origSetBounds.call(this, b); };
        const timer = setInterval(() => { const k = key(view.getBounds()); if (rec.samples[rec.samples.length - 1] !== k) rec.samples.push(k); }, 4);
        global.__stopWatch = () => { clearInterval(timer); view.setBounds = view.__origSetBounds; return { ...rec, final: key(view.getBounds()) }; };
      };
    });
    const pageOf = (id) => app.evaluate(({ webContents }, i) => global.__windows.list()[0].tabs.find((t) => t.id === i)?.contentsId, id);
    const pageEval = async (id, js) => app.evaluate(({ webContents }, { cid, code }) => webContents.fromId(cid).executeJavaScript(code), { cid: await pageOf(id), code: js });

    // The UI: does a slide or a snapshot show at any frame while the switch happens?
    const watchUi = () => ui.evaluate(() => {
      window.__uiSeen = { moving: false, snapshot: false };
      const end = performance.now() + 2500;
      const tick = () => { const b = document.body; if (b.classList.contains('sidebar-moving')) window.__uiSeen.moving = true; if (document.querySelector('.page-snapshot')) window.__uiSeen.snapshot = true; if (performance.now() < end) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });

    const fullWidth = await app.evaluate(() => global.__contentBounds().fullWidth);
    async function switchTo(id, wantOpen, label) {
      await pageEval(id, 'window.__resizes = []; true');
      await app.evaluate((_e, i) => global.__watch(i), id);
      await watchUi();
      await ui.click(`.tab[data-id="${id}"]`);
      await waitFor(async () => (await active()) === id);
      const done = await settled(wantOpen);
      await sleep(800); // (anything late: a second relayout would land in here)
      const rec = await app.evaluate(() => global.__stopWatch());
      const resizes = await pageEval(id, 'window.__resizes');
      const seen = await ui.evaluate(() => window.__uiSeen);
      const sizes = [...new Set([...rec.samples, ...rec.calls])];
      const width = Number(/,(\d+)x/.exec(rec.final)[1]);
      check(`${label}: the UI's sidebar ends ${wantOpen ? 'open' : 'closed'}, as this tab has it`, Boolean(done) && (await uiSidebar()) === wantOpen, await uiSidebar());
      check(`${label}: the incoming view has one size from the click on (no size in between)`, sizes.length === 1, JSON.stringify(rec));
      check(`${label}: that size is ${wantOpen ? 'narrower by the sidebar' : 'the full page area'}`, wantOpen ? width < fullWidth - 200 : width === fullWidth, `${rec.final} full ${fullWidth}`);
      check(`${label}: its page never resized`, Array.isArray(resizes) && resizes.length === 0, JSON.stringify(resizes));
      check(`${label}: no slide and no snapshot of the tab left`, !seen.moving && !seen.snapshot, JSON.stringify(seen));
    }

    for (let round = 1; round <= 2; round++) {
      await switchTo(tabA, true, `round ${round}, B -> A (sidebar open)`);
      await switchTo(tabB, false, `round ${round}, B <- A (sidebar closed)`);
    }
    check('the sidebar state of each tab is unchanged', (await sidebarOf(tabA)) === true && (await sidebarOf(tabB)) === false, `${await sidebarOf(tabA)} ${await sidebarOf(tabB)}`);
    check('no page errors in the UI', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failures++;
    console.log(`FAIL  threw: ${e.stack || e}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
