// When the AI closes the tab you are in, you land on a tab an AI run is still working in first (main.js closeTab / aiWorkingTabAfterClose,
// features/ai-manners.js focusAfterAiClose); a tab YOU close keeps the normal rule (the neighbour). The chat's activity card keeps a closed
// tab: its icon and title chip and the last frame, marked "closed", and the chip reopens it (renderer/step-ui.js, tab-ref.js, features/tab-chips.js).
// Hidden windows (LUMEN_TEST_BACKGROUND=1), a throwaway profile, no network beyond 127.0.0.1. Run it under the lock:
//   node scripts/e2e-lock.js run --owner ai-close-focus -- node test/ai-close-focus.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return v; };
const J = (v) => JSON.stringify(v);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/fav')) { res.setHeader('Content-Type', 'image/png'); res.end(PNG); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE ${req.url}</h1></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aiclosefocus-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));

    const active = () => app.evaluate(() => global.__windows.list()[0].activeId);
    const ids = () => app.evaluate(() => global.__windows.list()[0].tabs.map((t) => t.id));
    const open = (name) => app.evaluate((_e, u) => global.__agent.browser.openTab(u, { background: true }).id, `${base}/${name}`);
    const working = (list) => app.evaluate((_e, l) => { global.__agent.runTabIds = () => l; }, list); // the tabs an AI run is working in
    const goTo = (id) => app.evaluate((_e, i) => global.__aiTabs.switchTo(i), id);
    const aiClose = (id) => app.evaluate((_e, i) => global.__agent.browser.requestCloseTab(i), id); // the AI's close_tab
    const gone = (id) => waitFor(async () => !(await ids()).includes(id));
    const settle = async (want) => waitFor(async () => (await active()) === want, 6000);

    const U = (await ids())[0];
    const [A, B, C, D, E] = [await open('a'), await open('b'), await open('c'), await open('d'), await open('e')];
    await waitFor(async () => (await ids()).length === 6);

    // 1. the AI closes the tab in front: to the tab a run is still working in, not the neighbour
    await working([E]);
    await goTo(B);
    check('(set up) B is in front', await settle(B), await active());
    await aiClose(B);
    await gone(B);
    check('the AI closes the tab in front: you land on the tab it is still working in (E), not the neighbour (C)', await settle(E), `${await active()} wanted ${E}`);

    // 2. no tab being worked in: the normal rule
    await working([]);
    await goTo(A);
    await aiClose(A);
    await gone(A);
    check('no AI run working anywhere: the normal rule (the neighbour, C)', await settle(C), `${await active()} wanted ${C}`);

    // 3. a tab YOU close keeps the normal rule, even with a run working elsewhere
    await working([E]);
    await goTo(C);
    await ui.evaluate((id) => window.browser.closeTab(id), C);
    await gone(C);
    check('you close the tab in front: the normal rule (D), not the AI tab (E)', await settle(D), `${await active()} wanted ${D}`);

    // 4. a helper's tab closing (browser.closeTab, the AI's own call) counts as the AI closing
    await working([U]);
    await goTo(D);
    await app.evaluate((_e, id) => global.__agent.browser.closeTab(id), D);
    await gone(D);
    check('a helper tab closing: to the working tab (U), not the neighbour (E)', await settle(U), `${await active()} wanted ${U}`);

    // 5. the same chat's run first, then the most recently looked at working tab
    const F = await open('f');
    const G = await open('g');
    await working([F, G]);
    await goTo(E);
    await app.evaluate((_e, [f, g]) => {
      global.__agent.currentScope = () => ({ chat: 'MINE' });
      global.__agent.runTabIdFor = (m) => (m === 'MINE' ? f : null);
      global.__aiTabs.tab(g).viewedAt = Date.now() + 5000; // G was looked at last of the two: only the chat's own run can make F the answer
    }, [F, G]);
    await aiClose(E);
    await gone(E);
    check("the closing chat's own run first (F), before the most recently active working tab (G)", await settle(F), `${await active()} wanted ${F}`);
    await app.evaluate(() => { delete global.__agent.currentScope; delete global.__agent.runTabIdFor; });
    await goTo(U);
    await aiClose(F);
    await gone(F);
    check('the AI closing a tab that is not in front does not move you', await settle(U), `${await active()} wanted ${U}`);

    // 6. split view: the other side stays open
    const H = await open('h');
    const I = await open('i');
    await app.evaluate((_e, [r, l]) => global.__split.open(r, l), [I, H]);
    check('(set up) H and I are side by side, I in front', (await settle(I)) && await app.evaluate(() => Boolean(global.__split.state().pair)), await active());
    await working([G]);
    await aiClose(I);
    await gone(I);
    check('split view: the AI closes the side you are in: you land on the working tab (G) and the other side (H) stays open', (await settle(G)) && (await ids()).includes(H), `${await active()} ${J(await ids())}`);
    const J2 = await open('j');
    const K = await open('k');
    await app.evaluate((_e, [r, l]) => global.__split.open(r, l), [K, J2]);
    await settle(K);
    await working([J2]);
    await aiClose(K);
    await gone(K);
    check('split view: when the other side is the working tab, it is shown', await settle(J2), `${await active()} wanted ${J2}`);

    // 7. the chat's activity card keeps a tab the AI closed: its icon and title chip, the last frame, marked closed; the chip reopens it
    await working([]);
    const T = await open('card-tab?T1');
    await waitFor(async () => app.evaluate((_e, id) => global.__aiTabs.tab(id)?.view?.webContents.getTitle().includes('card-tab'), T), 8000);
    await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    await ui.evaluate(async ({ id, url }) => {
      await loadStepUI();
      const host = document.createElement('div');
      host.id = 'cf-host';
      document.body.append(host);
      const turn = { cards: [], card: null, plain: null, working: null };
      window.stepUI.add(turn, { name: 'get_console', input: { tab_id: id }, id: 'cf1', label: 'Reading the page console' }, { messages: host, append: (n) => host.append(n), task: '' });
      const cv = document.createElement('canvas'); cv.width = 40; cv.height = 25; const x = cv.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 40, 25);
      window.stepUI.thumb(turn, { type: 'thumb', data: cv.toDataURL('image/jpeg').split(',')[1], tabId: id, url, title: 'Page card-tab', favicon: null });
    }, { id: T, url: `${base}/card-tab?T1` });
    const card = '#cf-host .act-card';
    const cardState = () => ui.evaluate(() => {
      const c = document.querySelector('#cf-host .act-card');
      const wrap = c.querySelector('.act-tab');
      const img = wrap && wrap.querySelector('.tab-ref-icon img');
      const shot = c.querySelector('.act-shot');
      return {
        shot: shot.dataset.tabClosed || '', mode: shot.dataset.mode || '', hidden: shot.hidden, frame: c.querySelector('.act-thumb').hasAttribute('src'),
        label: shot.dataset.closedLabel || '', state: (wrap && wrap.dataset.state) || '', icon: (img && img.getAttribute('src')) || '', title: (wrap && wrap.querySelector('.tab-ref-title').textContent) || '',
      };
    });
    const before = await waitFor(async () => { const s = await cardState(); return s.state === 'open' && s.icon && s; });
    check('while the tab is open: the chip shows its icon, the frame is not marked closed', Boolean(before) && before.shot === '' && before.frame && /favicon[.]ico$/.test(before.icon), J(before || await cardState()));
    await aiClose(T);
    await gone(T);
    const after = await waitFor(async () => { const s = await cardState(); return s.state === 'closed' && s; });
    check('the AI closed it: the card keeps the chip (icon and title) marked closed', Boolean(after) && after.icon === before.icon && /card-tab/.test(after.title), J(after || await cardState()));
    check('...and keeps the last frame, marked "closed", not blank', Boolean(after) && after.frame && after.mode === 'frame' && !after.hidden && after.shot === '1' && after.label === 'closed', J(after));
    const entry = await app.evaluate((_e, id) => global.__tabChips.rt().describe(String(id)), T);
    check('main reports it closed, with its icon, reopenable', entry.state === 'closed' && entry.reopen === true && entry.favicon === before.icon, J(entry));
    const listBefore = await app.evaluate(() => global.__closedTabs().length);
    await ui.click(`${card} .act-tabs-head`);
    await ui.click(`${card} .act-tab[data-state="closed"] .tab-ref`);
    const back = await waitFor(() => app.evaluate((_e, u) => { const a = global.__agent.browser.activeTab(); return a && a.webContents.getURL() === u ? a.id : null; }, `${base}/card-tab?T1`), 8000);
    check('clicking the closed chip reopens it at its address', Boolean(back) && back !== T, J({ back, T }));
    const listAfter = await app.evaluate(() => global.__closedTabs().length);
    check('...as Reopen Closed Tab does: the entry leaves that list (no duplicate to reopen)', listAfter === listBefore - 1, J({ listBefore, listAfter }));
    await ui.evaluate(() => { const h = document.getElementById('cf-host'); if (h) h.remove(); });

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
