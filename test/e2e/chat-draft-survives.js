// Soak: a draft typed in the full-page chat (lumen://chat tab) and in the sidebar chat survives everything the app does around it, and the
// chat pages are never reloaded: tab switches and bursts, another chat running and finishing, chat list updates, an idle period past the
// unload / freeze timers, memory pressure, the sidebar opening and closing, a window resize. Also: a forced renderer crash puts the draft back.
// Hidden Electron (LUMEN_TEST_BACKGROUND=1), a 50-chat / 30-tab profile, a fake model, no network.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { seed } = require('../helpers/_chat-seed');
const { _electron: electron } = require('playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 420000);
  hardStop.unref();

  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>${req.url}</h1></body>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-draft-'));
  const privateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-draft-temp-'));
  const { ids } = await seed(profile, { chats: 50, big: 60 });
  const bigId = ids[0];
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test', TEMP: privateTemp, TMP: privateTemp, TMPDIR: privateTemp };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env });
  const ui = await app.firstWindow({ timeout: 90000 });
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  try {
    await ui.waitForSelector('.tab');
    const T = (fn, arg) => app.evaluate(fn, arg);
    await T(() => global.__settings.backend.set('sidebarNewChat', false));
    // Fake model: replies at once, or when a gate opens.
    await T(() => {
      const fake = global.__fake = { n: 0, gate: null, release: null };
      global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
        const text = `Reply ${++fake.n}.`;
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return { async *[Symbol.asyncIterator]() { if (fake.gate) await fake.gate; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => message };
      } } } });
    });
    // ---- 30 tabs: 27 pages, the full-page chat on the long chat, one more chat tab (the spare/other), and the first tab
    for (let i = 0; i < 27; i++) await T((_e, u) => { global.__agent.browser.openTab(u, { background: true }); }, `${base}/p${i}`);
    await T(() => global.__chatPage.open());
    const chatTab = await waitFor(() => T(() => { const t = global.__chatPage.tabs().find((x) => x.chat); return t ? t.id : null; }), 20000);
    const inPage = (code) => T(async (_e, [id, c]) => { try { return await global.__chatPage.contents(id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [chatTab, code]);
    check('the full-page chat opened', Boolean(chatTab));
    // open the long chat in the full page
    await waitFor(async () => (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) >= 1, 20000);
    await inPage(`(() => { const b = document.querySelector('#cp-items .chat-item[data-id="${bigId}"] .chat-open'); if (b) b.click(); })()`);
    await waitFor(async () => (await inPage("document.querySelectorAll('#messages .msg, #messages > *').length")) > 20, 20000);
    // another chat tab and the tab count
    const tabCount = await T(() => global.__chatPage.tabs().length);
    check('about 30 tabs are open', tabCount >= 28, tabCount);

    // ---- counters on the chat page's webContents (navigations, loads, crashes)
    await T((_e, id) => {
      const wc = global.__chatPage.contents(id);
      const c = global.__cnt = { nav: 0, load: 0, gone: 0, urls: [], id: wc.id };
      wc.on('did-start-navigation', (_ev, url, _same, isMain) => { if (isMain !== false) { c.nav++; c.urls.push(String(url).slice(0, 80)); } });
      wc.on('did-finish-load', () => { c.load++; });
      wc.on('render-process-gone', () => { c.gone++; });
    }, chatTab);
    const counts = () => T(() => ({ nav: global.__cnt.nav, load: global.__cnt.load, gone: global.__cnt.gone, urls: global.__cnt.urls }));
    const sameWc = (a) => T((_e, [id, w]) => global.__chatPage.contents(id)?.id === w, [chatTab, a]);

    // ---- the drafts
    const FULL = 'full-page draft: do not lose me\nsecond line';
    const tabIdsAll = await T(() => global.__chatPage.tabs().map((t) => t.id));
    const SIDE = 'sidebar draft: do not lose me either';
    await inPage(`(() => { const p = document.getElementById('prompt'); p.focus(); p.value = ${JSON.stringify(FULL)}; p.dispatchEvent(new Event('input')); })()`);
    await sleep(2500); // (the long chat finishes drawing)
    // scroll the full page's thread up so a reset would show
    await inPage(`(() => { let e = document.getElementById('messages'); while (e && e.scrollHeight <= e.clientHeight + 5) e = e.parentElement; e = e || document.scrollingElement; e.scrollTop = Math.floor(e.scrollHeight / 3); window.__scrolled = e.scrollTop; return window.__scrolled; })()`);
    const ANCHOR = `(() => { const m = document.getElementById('messages'); let e = m; while (e && e.scrollHeight <= e.clientHeight + 5) e = e.parentElement; e = e || document.scrollingElement; const pos = (k) => k.offsetTop - e.scrollTop; if (!window.__anchorEl || !window.__anchorEl.isConnected) { const r = e.getBoundingClientRect(); window.__anchorEl = [...m.children].find((k) => k.getBoundingClientRect().bottom > r.top + 40); window.__anchorOffset = pos(window.__anchorEl); return 'set'; } return String(Math.round(pos(window.__anchorEl) - window.__anchorOffset)); })()`;
    await inPage(ANCHOR);
    const sideTab = tabIdsAll.find((i) => i !== chatTab);
    await T((_e, i) => { global.__chatPage.switchTab(i); global.__tabChats.setSidebar(i, true); }, sideTab);
    await ui.waitForSelector('#new-chat', { state: 'visible' });
    await ui.waitForSelector('#prompt', { state: 'attached' });
    await ui.evaluate((v) => { const p = document.getElementById('prompt'); p.value = v; p.dispatchEvent(new Event('input')); }, SIDE);
    await sleep(700); // (drafts are saved on every input)
    const before = await counts();
    const mark = await inPage("(window.__alive = (window.__alive || Math.random()), window.__alive)"); // a page-lifetime marker: gone when the page reloads
    
    const tabIds = await T(() => global.__chatPage.tabs().map((t) => t.id));

    const verify = async (label, opts = {}) => {
      const full = await inPage("document.getElementById('prompt').value");
      const c = await counts();
      const m = await inPage('window.__alive');
      const sc = await inPage(ANCHOR);
      if (opts.chatActive) await T((_e, i) => { global.__chatPage.switchTab(i); }, sideTab);
      if (opts.chatActive) await sleep(800);
      const side = await ui.evaluate(() => document.getElementById('prompt').value);
      check(`${label}: full-page draft kept`, full === FULL, full);
      check(`${label}: sidebar draft kept`, side === SIDE, side);
      check(`${label}: chat page not reloaded (nav ${c.nav - before.nav}, load ${c.load - before.load}, gone ${c.gone})`, c.nav === before.nav && c.load === before.load && c.gone === 0 && m === mark && (await sameWc(before.id ?? (await T(() => global.__cnt.id)))), JSON.stringify(c.urls.slice(before.urls.length)));
      check(`${label}: scroll position kept`, Math.abs(Number(sc)) <= 3, `moved by ${sc}px`);
    };
    const activate = async (id) => { await T((_e, i) => global.__chatPage.switchTab(i), id); };

    // 1. tab switches and bursts, ending away from the chat tab (the draft sits in a background tab)
    for (let r = 0; r < 3; r++) for (const id of tabIds.slice(0, 20)) await T((_e, i) => global.__chatPage.switchTab(i), id);
    await T((_e, i) => { global.__chatPage.switchTab(i); global.__tabChats.setSidebar(i, true); }, sideTab);
    await sleep(500);
    await verify('after a tab-switch burst');

    // 2. another chat runs (sidebar) and finishes, and the chat list changes
    await T(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = ''; p.dispatchEvent(new Event('input')); });
    await ui.click('#new-chat');
    await ui.fill('#prompt', 'another chat question');
    await ui.press('#prompt', 'Enter');
    await sleep(700);
    await T(() => { const s = global.__chats.store(); const id = ids0(); function ids0() { return s.list ? (s.list()[5] || {}).id : null; } if (id && s.touch) s.touch(id); });
    await T(() => { global.__fake.release(); global.__fake.gate = null; });
    await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 15000);
    await sleep(800);
    await ui.evaluate((v) => { const p = document.getElementById('prompt'); p.value = v; p.dispatchEvent(new Event('input')); }, SIDE); // (the sidebar's box is the new chat's; give it back its draft)
    await verify('after another chat ran and finished');

    // 3. idle past the unload / freeze timers, then memory pressure
    await T((_e, ids2) => { for (const id of ids2) global.__tabSleep.age(id, 3 * 3600e3); }, tabIds);
    await T(() => global.__patchSettings({ tabSleepMinutes: 5, tabSleepFreezeFirstMinutes: 1, tabSleepKeepRecent: 0, tabSleepKeepForms: false }));
    await T(() => global.__tabSleep.fakePressure(false));
    await T(() => global.__tabSleep.sweep());
    await sleep(400);
    await T(() => global.__tabSleep.sweep());
    await T(() => global.__tabSleep.fakePressure(true));
    await T(() => global.__tabSleep.sweep());
    await T(() => global.__tabSleep.unloadAll());
    await sleep(500);
    const st = await T((_e, id) => global.__tabSleep.state().find((t) => t.id === id), chatTab);
    check('the chat tab (with a draft) was not unloaded or frozen', st && !st.sleeping && !st.frozen && st.view, JSON.stringify(st));
    await verify('after idle, freeze, unload and memory pressure');
    await T(() => global.__tabSleep.fakePressure(false));

    // 4. sidebar open/close and a window resize
    for (let i = 0; i < 6; i++) { await T((_e, [id, o]) => global.__tabChats.setSidebar(id, o), [sideTab, i % 2 === 1]); await sleep(300); }
    const bw = await app.browserWindow(ui);
    await bw.evaluate((w) => { const [wd, ht] = w.getSize(); w.setSize(wd - 200, ht - 100); });
    await sleep(300);
    await bw.evaluate((w) => { const [wd, ht] = w.getSize(); w.setSize(wd + 200, ht + 100); });
    await sleep(500);
    await ui.evaluate((v) => { const p = document.getElementById('prompt'); if (!p.value) { p.value = v; p.dispatchEvent(new Event('input')); } }, SIDE);
    await verify('after sidebar open/close and a resize');

    // 5. back to the chat tab: still the same page
    await activate(chatTab);
    await sleep(600);
    await verify('on returning to the chat tab', { chatActive: true });
    await activate(chatTab);

    // 5b. an EMPTY new chat (not started yet) holds a draft in the full page and in the sidebar: the same stress must not wipe either
    {
      const ND_FULL = 'new-chat full draft';
      const ND_SIDE = 'new-chat sidebar draft';
      await T((_e, i) => { global.__chatPage.switchTab(i); global.__tabChats.setSidebar(i, true); }, sideTab);
      await ui.click('#new-chat');
      await sleep(500);
      await ui.evaluate((v) => { const p = document.getElementById('prompt'); p.value = v; p.dispatchEvent(new Event('input')); }, ND_SIDE);
      await activate(chatTab);
      await sleep(400);
      await inPage("(() => { const b = document.getElementById('cp-new') || document.getElementById('new-chat'); if (b) b.click(); })()");
      await sleep(600);
      await inPage(`(() => { const p = document.getElementById('prompt'); p.focus(); p.value = ${JSON.stringify(ND_FULL)}; p.dispatchEvent(new Event('input')); })()`);
      await sleep(500);
      const nav0 = (await counts()).nav;
      for (let r = 0; r < 3; r++) for (const id of tabIds.slice(0, 12)) await T((_e, i) => global.__chatPage.switchTab(i), id);
      await T((_e, i) => { global.__chatPage.switchTab(i); }, sideTab);
      await sleep(800);
      const sideNow = await ui.evaluate(() => document.getElementById('prompt').value);
      check('an empty new chat in the sidebar keeps its draft over tab switches', sideNow === ND_SIDE, sideNow);
      await activate(chatTab);
      await sleep(800);
      const fullNow = await inPage("document.getElementById('prompt').value");
      check('an empty new chat in the full page keeps its draft over tab switches', fullNow === ND_FULL, fullNow);
      check('...without reloading the page', (await counts()).nav === nav0);
    }

    // 6. a forced renderer crash: the draft comes back after the page loads again
    await inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(FULL)}; p.dispatchEvent(new Event('input')); })()`);
    await sleep(700);
    await T((_e, id) => { global.__chatPage.contents(id).forcefullyCrashRenderer(); }, chatTab);
    await sleep(2500);
    const afterCrash = await T((_e, id) => { const c = global.__chatPage.contents(id); return { url: c ? c.getURL() : 'TAB GONE: ' + JSON.stringify(global.__chatPage.tabs().filter((t) => t.chat)), gone: global.__cnt.gone }; }, chatTab);
    // (the page comes back on its own: main reloads a crashed chat page)
    await waitFor(async () => (await inPage("document.readyState")) === 'complete' && (await inPage("!!document.getElementById('prompt')")) === true, 20000);
    await sleep(800);
    const restored = await inPage("document.getElementById('prompt').value");
    check(`a crashed chat page (${afterCrash.url.slice(0, 30)}) gets its draft back after a reload`, restored === FULL, restored);
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err?.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
