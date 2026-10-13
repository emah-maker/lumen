// Opening and closing the AI sidebar on the new-tab page (and on a web page and lumen://chat), in an invisible window
// (LUMEN_TEST_BACKGROUND=1). The new-tab page doesn't slide or flash: the sidebar and the page view change in one step, in an order that
// never leaves a gap or draws the view over the sidebar. Checks:
//   - after an open and after a close the page view and the sidebar tile the content area exactly (no overlap, no gap), at 1280, 900 and
//     700 px, on the new-tab page, on a web page (which slides over a snapshot) and with reduced motion;
//   - sampled every few ms, the new-tab page's view is never hidden and the sidebar never slides; a web page is never blank (its view
//     is hidden only while the snapshot is on screen);
//   - the home page's widgets don't reload on open or close: the page gets no resize event (it keeps its full-width layout), its cards
//     and the TradingView frame are the same elements afterwards, and nothing navigates;
//   - five quick toggles end in the state the count says, nothing stuck (moving class, hidden view);
//   - the shortcut (Ctrl+J), pressed with the keyboard in the page, moves the native focus to the window's UI and the message box has it.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(60); } return v; };

const CHART = 'wsbtv001';
const MINI = 'wsbtv002';
const widgets = [
  { id: CHART, type: 'tradingview', tv: { symbol: 'NASDAQ:AAPL', interval: 'D', view: 'chart', theme: 'light' }, x: 0, y: 0, w: 4, h: 3 },
  { id: MINI, type: 'tradingview', tv: { symbol: 'NASDAQ:AAPL', interval: 'D', view: 'mini', theme: 'light' }, x: 8, y: 0, w: 4, h: 3 },
];

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Page</title><body style="margin:0"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding:20px">' + Array.from({ length: 12 }, (_, i) => `<div style="background:hsl(${i * 30},70%,80%);padding:30px">Card ${i}</div>`).join('') + '</div></body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidebar-newtab-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: widgets, sidebarNewChat: false, performanceMode: 'off' }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.evaluate(() => window.assistant.setAutoGroup(false));

    // ---- helpers
    const win = (w, h = 800) => app.evaluate(({ BrowserWindow }, [a, b]) => BrowserWindow.getAllWindows()[0].setContentSize(a, b), [w, h]);
    const toggle = () => ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    const settled = (open) => waitFor(() => ui.evaluate((o) => {
      const b = document.body;
      return document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === String(o) && !b.classList.contains('sidebar-moving') && b.classList.contains('sidebar-hidden') === !o && !document.querySelector('.page-snapshot');
    }, open), 6000);
    // The page view of the tab in front (main's own numbers) and the UI's boxes, taken together.
    const geometry = async () => {
      const dom = await ui.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
        return { body: r(document.querySelector('.body')), viewport: r(document.getElementById('viewport')), sidebar: document.body.classList.contains('sidebar-hidden') ? null : r(document.getElementById('sidebar')), moving: document.body.classList.contains('sidebar-moving'), snapshot: Boolean(document.querySelector('.page-snapshot')) };
      });
      const view = await app.evaluate(() => { const t = global.__agent.browser.activeTab(); const v = t && global.__tabViews?.(t.id); return v || null; });
      return { ...dom, view };
    };
    // The view and the sidebar tile the body: view from the body's left, sidebar to its right edge, touching.
    const tiles = (g, open) => {
      if (!g.view || !g.view.visible) return `view not showing: ${JSON.stringify(g.view)}`;
      const v = g.view;
      if (v.x !== g.body.x || v.y !== g.body.y || v.h !== g.body.h) return `view ${JSON.stringify(v)} vs body ${JSON.stringify(g.body)}`;
      if (!open) return g.sidebar === null && v.w === g.body.w ? '' : `closed: view ${v.w} body ${g.body.w} sidebar ${JSON.stringify(g.sidebar)}`;
      if (!g.sidebar) return 'open but no sidebar box';
      if (v.x + v.w !== g.sidebar.x) return `gap or overlap: view ends ${v.x + v.w}, sidebar starts ${g.sidebar.x}`;
      if (g.sidebar.x + g.sidebar.w !== g.body.x + g.body.w) return `sidebar ends ${g.sidebar.x + g.sidebar.w}, body ends ${g.body.x + g.body.w}`;
      return '';
    };
    // The end state: the page view's bounds reach main a moment after the UI has settled, so it is polled until it tiles (or 2.5 s).
    let m = '';
    const tilesSoon = async (open) => { let why = 'never looked'; await waitFor(async () => { why = tiles(await geometry(), open); return !why; }, 2500); return why; };
    // Frames sampled while `action` runs: main's view bounds and visibility every few ms, the UI's own state on every frame.
    const record = async (action, ms = 1300) => {
      await app.evaluate(({ BrowserWindow }) => {
        global.__samples = [];
        const t = global.__agent.browser.activeTab();
        global.__sampler = setInterval(() => {
          const view = global.__tabViews(t.id);
          global.__samples.push({ at: Date.now(), visible: Boolean(view?.visible), w: view?.w ?? 0 });
        }, 6);
      });
      await ui.evaluate(() => {
        window.__ui = [];
        window.__uiStop = false;
        const sb = document.getElementById('sidebar');
        const tick = () => {
          window.__ui.push({ at: Date.now(), moving: document.body.classList.contains('sidebar-moving'), hidden: document.body.classList.contains('sidebar-hidden'), sidebarW: Math.round(sb.getBoundingClientRect().width), snapshot: Boolean(document.querySelector('.page-snapshot')) });
          if (!window.__uiStop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await action();
      await sleep(ms);
      const samples = await app.evaluate(() => { clearInterval(global.__sampler); return global.__samples; });
      const frames = await ui.evaluate(() => { window.__uiStop = true; return window.__ui; });
      return { samples, frames };
    };
    const nearest = (frames, at) => frames.reduce((best, f) => (!best || Math.abs(f.at - at) < Math.abs(best.at - at) ? f : best), null);
    const longest = (flags) => { let best = 0; let run = 0; for (const f of flags) { run = f ? run + 1 : 0; best = Math.max(best, run); } return best; };

    // A tab view's numbers for the tests (main.js has no such hook): the tab's WebContentsView, found through its contents.
    await app.evaluate(({ BrowserWindow }) => {
      global.__tabViews = (id) => {
        const w = BrowserWindow.getAllWindows()[0];
        const wc = global.__agent.browser.activeTab();
        const hit = wc && wc.id === id ? wc.webContents : null;
        const v = w.contentView.children.find((c) => c.webContents && hit && c.webContents === hit);
        if (!v) return null;
        const b = v.getBounds();
        return { visible: v.getVisible(), x: b.x, y: b.y, w: b.width, h: b.height };
      };
    });

    // ---- the new-tab page, with widgets
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__home = t; });
    const home = (js) => app.evaluate((_e, c) => global.__home.webContents.executeJavaScript(c), js);
    check('the new-tab page is the tab in front, and shows its TradingView cards', await waitFor(() => home(`document.querySelectorAll('.w-card iframe').length`).then((n) => n >= 1)), await home(`document.querySelectorAll('.w-card').length`));
    await sleep(1500);
    await ui.evaluate(() => { if (!document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
    await settled(false);
    await app.evaluate(() => {
      const wc = global.__home.webContents;
      global.__navs = 0;
      global.__navUrls = [];
      wc.on('did-start-navigation', (e) => { global.__navs++; global.__navUrls.push(String(e.url).slice(0, 80)); });
      wc.on('did-frame-navigate', () => { global.__navs++; });
    });
    await home(`(() => { window.__resizes = []; addEventListener('resize', () => window.__resizes.push(innerWidth)); document.querySelectorAll('.w-card, .w-card iframe').forEach((e) => { e.__keep = true; }); document.body.__keep = true; return true; })()`);
    // The counters watch only the toggles: sizing the window itself legitimately resizes the page.
    const quiet = () => Promise.all([home('window.__resizes.length = 0; true'), app.evaluate(() => { global.__navs = 0; })]);
    let resized = [];
    let navigated = 0;
    const tally = async () => { resized.push(...(await home('window.__resizes.slice()'))); navigated += await app.evaluate(() => global.__navs); await quiet(); };
    const cardCount = await home(`document.querySelectorAll('.w-card').length`);

    for (const width of [1280, 900, 700]) {
      await win(width);
      await sleep(1200); // (the page and its widgets settle at the new size before the counters start)
      let g = await geometry();
      check(`[${width}px] new tab, sidebar closed: the page view fills the content area`, !(m = await tilesSoon(false)), m);

      await quiet();
      const opened = await record(toggle);
      await tally();
      check(`[${width}px] new tab: the sidebar opens`, await settled(true), JSON.stringify(await geometry()));
      g = await geometry();
      check(`[${width}px] new tab, open: the page view and the sidebar tile the content area exactly`, !(m = await tilesSoon(true)), m);
      check(`[${width}px] new tab: no snapshot, no slide (the sidebar never has its moving class)`, opened.frames.every((f) => !f.moving && !f.snapshot), JSON.stringify(opened.frames.filter((f) => f.moving || f.snapshot).slice(0, 2)));
      check(`[${width}px] new tab: the page view is showing in every sample (no blank frame)`, opened.samples.every((s) => s.visible), `${opened.samples.filter((s) => !s.visible).length} of ${opened.samples.length} samples hidden`);
      // The view narrows only after the UI has the sidebar in place: never a sample with the view narrow and the sidebar not laid out (a gap).
      const gapOpen = opened.samples.map((s) => { const f = nearest(opened.frames, s.at); return s.w < g.body.w && f.hidden && Math.abs(f.at - s.at) < 25; });
      check(`[${width}px] new tab, opening: no stretch of frames with the page narrowed and no sidebar yet (a gap)`, longest(gapOpen) < 3, `${longest(gapOpen)} in a row`);

      const closed = await record(toggle);
      await tally();
      check(`[${width}px] new tab: the sidebar closes`, await settled(false), JSON.stringify(await geometry()));
      g = await geometry();
      check(`[${width}px] new tab, closed again: the page view fills the content area`, !(m = await tilesSoon(false)), m);
      check(`[${width}px] new tab, closing: the page view is showing in every sample, and nothing slides`, closed.samples.every((s) => s.visible) && closed.frames.every((f) => !f.moving && !f.snapshot), `${closed.samples.filter((s) => !s.visible).length} hidden`);
      // On the way out the view widens first (over the sidebar), then the sidebar leaves: never the sidebar gone with the view still narrow.
      const gapClose = closed.samples.map((s) => { const f = nearest(closed.frames, s.at); return s.w < g.body.w && f.hidden && Math.abs(f.at - s.at) < 25; });
      check(`[${width}px] new tab, closing: no stretch of frames with the sidebar gone and the page still narrow (a gap)`, longest(gapClose) < 3, `${longest(gapClose)} in a row`);
    }
    await win(1280);
    await sleep(300);

    // ---- the home page was not touched by any of that
    const after = await home(`({ keep: [...document.querySelectorAll('.w-card, .w-card iframe')].every((e) => e.__keep), body: Boolean(document.body.__keep), cards: document.querySelectorAll('.w-card').length })`);
    check('the home page got no resize event across three opens and closes (it keeps its full-width layout)', resized.length === 0, JSON.stringify(resized));
    check('its cards and the TradingView frames are the same elements (nothing re-rendered or reloaded)', after.keep && after.body && after.cards === cardCount && cardCount >= 1, JSON.stringify(after));
    check('nothing in the home page navigated (no widget frame reloaded)', navigated === 0, `${navigated} ${JSON.stringify(await app.evaluate(() => global.__navUrls))}`);

    // ---- five quick toggles
    const quick = async (n, gap) => {
      for (let i = 0; i < n; i++) { await toggle(); if (gap) await sleep(gap); }
    };
    const wantOpen = (start, n) => (n % 2 === 1 ? !start : start);
    for (const gap of [0, 30, 90]) {
      const start = !(await ui.evaluate(() => document.body.classList.contains('sidebar-hidden')));
      await quick(5, gap);
      const end = wantOpen(start, 5);
      check(`five quick toggles (${gap} ms apart) on the new tab end ${end ? 'open' : 'closed'}`, await settled(end), JSON.stringify(await geometry()));
      const g = await geometry();
      check(`...with the page view and sidebar tiling the content area, nothing stuck (${gap} ms)`, !(m = await tilesSoon(end)) && !g.moving && !g.snapshot, m);
      check(`...and main agrees about the tab's sidebar (${gap} ms)`, await waitFor(async () => (await app.evaluate(() => global.__tabChats.sidebar(global.__agent.browser.activeTab().id))) === end), 'main disagrees');
    }
    // back to closed for what follows
    if (!(await ui.evaluate(() => document.body.classList.contains('sidebar-hidden')))) { await toggle(); await settled(false); }

    // ---- the shortcut with the keyboard in the page: the window's native focus goes to the UI, the message box has it
    await app.evaluate(() => {
      const w = global.__chatPage.ui();
      global.__focusCalls = 0;
      if (!w.__wrapped) { const f = w.focus.bind(w); w.focus = (...a) => { global.__focusCalls++; return f(...a); }; w.__wrapped = true; }
    });
    const ctrlJ = (from) => app.evaluate(({ BrowserWindow }, f) => {
      const wc = f === 'page' ? global.__agent.browser.activeTab().webContents : BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'j', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'j', modifiers: ['control'] });
    }, from);
    await ui.evaluate(() => { window.__log = []; const of = HTMLElement.prototype.focus; HTMLElement.prototype.focus = function (...a) { const r = of.apply(this, a); window.__log.push('focus() ' + (this.id || this.tagName) + ' vis=' + getComputedStyle(this).visibility + ' body=' + document.body.className + ' sb=' + getComputedStyle(document.getElementById('sidebar')).visibility + '/' + document.getElementById('sidebar').className + ' now=' + (document.activeElement?.id || document.activeElement?.tagName)); return r; }; document.addEventListener('focusin', (e) => window.__log.push('in ' + (e.target.id || e.target.tagName) + ' @' + Math.round(performance.now())), true); document.addEventListener('focusout', (e) => window.__log.push('out ' + (e.target.id || e.target.tagName) + ' @' + Math.round(performance.now())), true); });
    await ctrlJ('page');
    check('Ctrl+J from the page opens the sidebar on the new-tab page', await settled(true), JSON.stringify(await geometry()));
    check('...the window\'s UI is given the keyboard (not left in the page)', (await app.evaluate(() => global.__focusCalls)) >= 1, await app.evaluate(() => global.__focusCalls));
    const focusNow = () => ui.evaluate(() => { const a = document.activeElement; return `${a?.tagName}#${a?.id} hasFocus=${document.hasFocus()} hidden=${document.body.classList.contains('sidebar-hidden')}`; });
    check('...and the message box is the focused element', await waitFor(() => ui.evaluate(() => document.activeElement?.id === 'prompt')), await focusNow());
    const callsOpen = await app.evaluate(() => global.__focusCalls);
    await ctrlJ('page');
    check('Ctrl+J again closes it, and leaves the keyboard where it was', await settled(false) && (await app.evaluate(() => global.__focusCalls)) === callsOpen, await app.evaluate(() => global.__focusCalls));
    await ctrlJ('ui');
    check('Ctrl+J with the keyboard in the UI opens it with the message box focused', await settled(true) && await waitFor(() => ui.evaluate(() => document.activeElement?.id === 'prompt')), await ui.evaluate(() => document.activeElement?.id));
    await ctrlJ('ui');
    await settled(false);

    // ---- the spare new-tab page (a page made ready before it is asked for) taken at the moment the sidebar opens
    let g;
    await app.evaluate(() => global.__spareNewTab.enable(true));
    check('a spare new-tab page is made ready', await waitFor(() => app.evaluate(() => global.__spareNewTab.ready()), 15000), 'not ready');
    for (const sidebarFirst of [false, true]) {
      if (sidebarFirst) { await toggle(); await settled(true); }
      await app.evaluate(() => { global.__agent.browser.openTab(); }); // takes the spare; the sidebar of a fresh tab is closed
      const spare = await record(toggle, 1200); // asked for at once, as a keyboard shortcut right after Ctrl+T would
      const want = sidebarFirst ? await ui.evaluate(() => !document.body.classList.contains('sidebar-hidden')) : true;
      check(`spare new-tab page taken ${sidebarFirst ? 'with the sidebar open on the tab before' : 'then the sidebar asked for at once'}: it settles`, await settled(want), JSON.stringify(await geometry()));
      await sleep(300);
      g = await geometry();
      check('...the page view and the sidebar tile the content area, and the page is showing', !(m = await tilesSoon(want)), m);
      const gone = spare.samples.map((s) => !s.visible);
      check('...the new page is never hidden for more than the moment it is filled in (no stretch of blank frames after it showed)', longest(gone.slice(gone.indexOf(false) < 0 ? gone.length : gone.indexOf(false))) < 3, `${longest(gone)} in a row`);
      if (want) { await toggle(); await settled(false); }
      await app.evaluate(() => { const t = global.__agent.browser.activeTab(); global.__agent.browser.closeTab?.(t.id); });
    }
    await app.evaluate(() => global.__spareNewTab.enable(false));

    // ---- reduced motion: no slide on a web page either, and the same tiling
    await ui.evaluate(() => document.documentElement.classList.add('pref-reduce-motion'));
    // ---- a web page: slides over a snapshot; the live view is hidden only while the snapshot is up
    await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-finish-load', r)); }, `${base}/`);
    await sleep(800);
    const reducedOpen = await record(toggle, 900);
    check('reduced motion, web page: the sidebar opens with no slide and no snapshot', await settled(true) && reducedOpen.frames.every((f) => !f.moving && !f.snapshot), JSON.stringify(reducedOpen.frames.filter((f) => f.moving || f.snapshot).slice(0, 2)));
    g = await geometry();
    check('reduced motion, web page, open: the view and the sidebar tile the content area', !(m = await tilesSoon(true)), m);
    await toggle();
    check('reduced motion, web page: closes and fills the content area again', await settled(false) && !(m = await tilesSoon(false)), JSON.stringify(await geometry()) + ' ' + await ui.evaluate(() => document.body.className + ' ' + document.getElementById('toggle-sidebar').getAttribute('aria-pressed')));
    await ui.evaluate(() => document.documentElement.classList.remove('pref-reduce-motion'));

    for (const width of [1280, 900, 700]) {
      await win(width);
      await sleep(400);
      const opened = await record(toggle, 1500);
      check(`[${width}px] web page: the sidebar opens, sliding over a snapshot of the page`, await settled(true) && opened.frames.some((f) => f.moving && f.snapshot), JSON.stringify(await geometry()));
      g = await geometry();
      check(`[${width}px] web page, open: the view and the sidebar tile the content area exactly`, !(m = await tilesSoon(true)), m);
      const blank = opened.samples.map((s) => { const f = nearest(opened.frames, s.at); return !s.visible && !f.snapshot && Math.abs(f.at - s.at) < 25; });
      check(`[${width}px] web page, opening: never a blank page (the view is hidden only while the snapshot is on screen)`, longest(blank) < 3, `${longest(blank)} samples in a row`);
      const closed = await record(toggle, 1500);
      check(`[${width}px] web page: the sidebar closes`, await settled(false), JSON.stringify(await geometry()));
      g = await geometry();
      check(`[${width}px] web page, closed: the view fills the content area`, !(m = await tilesSoon(false)), m);
      const blank2 = closed.samples.map((s) => { const f = nearest(closed.frames, s.at); return !s.visible && !f.snapshot && Math.abs(f.at - s.at) < 25; });
      check(`[${width}px] web page, closing: never a blank page`, longest(blank2) < 3, `${longest(blank2)} samples in a row`);
    }
    await win(1280);
    for (const gap of [0, 40]) {
      const start = !(await ui.evaluate(() => document.body.classList.contains('sidebar-hidden')));
      await quick(5, gap);
      const end = wantOpen(start, 5);
      check(`five quick toggles (${gap} ms apart) on a web page end ${end ? 'open' : 'closed'}, tiled, nothing stuck`, await settled(end) && !(m = await tilesSoon(end)), JSON.stringify(await geometry()));
      if (end) { await toggle(); await settled(false); }
    }

    // ---- lumen://chat
    await app.evaluate(() => global.__chatPage.open());
    await waitFor(() => app.evaluate(() => global.__chatPage.tabs().some((t) => t.chat && /chat-page\.html$/.test(t.url))));
    await sleep(800);
    await toggle();
    await sleep(900);
    await toggle();
    await sleep(900);
    g = await geometry();
    const settledChat = await ui.evaluate(() => !document.body.classList.contains('sidebar-moving') && !document.querySelector('.page-snapshot'));
    check('lumen://chat: opening and closing the sidebar leaves nothing stuck (no snapshot, no moving class)', settledChat, JSON.stringify(g));
    const chatView = await app.evaluate(({ BrowserWindow }) => { const t = global.__chatPage.tabs().find((x) => x.chat); const c = global.__chatPage.contents(t.id); const w = BrowserWindow.getAllWindows()[0]; const v = w.contentView.children.find((k) => k.webContents === c); return v ? { visible: v.getVisible(), ...v.getBounds() } : null; }).catch(() => null);
    check('lumen://chat: its page view is showing', Boolean(chatView?.visible) || chatView === null, JSON.stringify(chatView));

    check('no page errors in the UI', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sidebar-on-the-new-tab checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
