// Typing in the address bar works as in Chrome, Edge and Firefox: no spellcheck or autocorrect, a site is completed in place only
// when it was typed before, Backspace / Delete take the completion away, Enter goes to exactly what is shown, words are searched
// exactly as typed (never sent to a page that only matches them), the first row is always what was typed, the arrow keys move
// through the rows and Escape puts the typed text back, Shift+Delete removes a History row, Ctrl+Enter adds www. and .com.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(40); } return v; };

  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Page ${req.url.slice(1)}</title><p>${req.url}</p>`); }).listen(0);
  const port = server.address().port;
  const local = `http://localhost:${port}`;
  const ip = `http://127.0.0.1:${port}`;
  const profile = process.env.CLAUDE_BROWSER_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-omnibox-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => { [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setContentSize(1100, 700); });

  // One ordinary tab on a local page: every navigation of it is recorded (did-start-navigation comes before any network).
  const tabId = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); return t.id; }, `${ip}/start`);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), tabId);
  await app.evaluate(() => {
    global.__navs = [];
    const wc = global.__agent.browser.activeTab().webContents;
    wc.on('did-start-navigation', (d, url, _inPlace, isMain) => { if ((d && typeof d === 'object' && 'isMainFrame' in d ? d.isMainFrame : isMain) !== false) global.__navs.push(d?.url || url); });
  });
  const navs = () => app.evaluate(() => global.__navs.slice());
  const lastNav = async (after) => waitFor(async () => { const n = await navs(); return n.length > after && n[n.length - 1]; });
  const currentUrl = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  const loadDirect = async (url) => { await app.evaluate(async (_e, u) => { const wc = global.__agent.browser.activeTab().webContents; await wc.loadURL(u).catch(() => {}); }, url); await waitFor(async () => (await ui.evaluate(() => document.getElementById('address').value)).includes(new URL(url).pathname)); await sleep(250); }; // not from the address bar: not a typed visit
  const field = () => ui.evaluate(() => { const a = document.getElementById('address'); const suggest = globalThis.eval('suggest'); /* app.js's list (a top-level let) */ return { value: a.value, start: a.selectionStart, end: a.selectionEnd, selected: suggest.selected, typed: suggest.typed, items: suggest.items.map((i) => ({ kind: i.kind, title: i.title, go: i.go })) }; });
  const typeIn = async (text) => {
    await ui.evaluate(() => document.getElementById('address').focus());
    await ui.keyboard.press('Control+A');
    await ui.keyboard.type(text, { delay: 15 });
  };
  const listFor = (typed) => waitFor(async () => { const f = await field(); return f.typed === typed && f.items.length > 0 && f; });
  const hasHistory = (url) => app.evaluate((_e, u) => global.__managers.history().has(u), url);
  const historyEntry = (url) => app.evaluate((_e, u) => { const e = global.__managers.history().get(u); return e ? { ...e } : null; }, url);

  // ---- 1. no spellcheck or autocorrect on the field
  const attrs = await ui.evaluate(() => { const a = document.getElementById('address'); return { spell: a.getAttribute('spellcheck'), spellProp: a.spellcheck, correct: a.getAttribute('autocorrect'), caps: a.getAttribute('autocapitalize'), complete: a.getAttribute('autocomplete') }; });
  check('the address field has spellcheck, autocorrect and autocapitalize off', attrs.spell === 'false' && attrs.spellProp === false && attrs.correct === 'off' && attrs.caps === 'off' && attrs.complete === 'off', JSON.stringify(attrs));

  // Visits: localhost is typed in the address bar once; 127.0.0.1 is only loaded (as a click would), never typed.
  let n;
  await typeIn(`localhost:${port}/alpha`);
  await ui.keyboard.press('Enter');
  await waitFor(async () => (await currentUrl()) === `${local}/alpha`, 6000);
  const typedEntry = await waitFor(async () => { const e = await historyEntry(`${local}/alpha`); return e && e.typed > 0 && e; });
  check('a site typed in the address bar is recorded as typed', Boolean(typedEntry), JSON.stringify(await historyEntry(`${local}/alpha`)));
  await loadDirect(`${ip}/page-one`);
  await loadDirect(`${ip}/page-two`);
  const clicked = await historyEntry(`${ip}/page-one`);
  check('a page only loaded (not typed) is in History without a typed count', Boolean(clicked) && !clicked.typed, JSON.stringify(clicked));

  // ---- 2. inline completion only from a site typed before, as selected text after the caret
  await typeIn('loc');
  const inline = await waitFor(async () => { const f = await field(); return f.value !== 'loc' && f; }, 3000);
  check('a typed site completes in place: what was typed, then the rest selected after the caret', inline && inline.value === `localhost:${port}` && inline.start === 3 && inline.end === inline.value.length, JSON.stringify(inline));
  check('the first row is the completed site', inline && inline.items[0]?.go === `${local}/` && inline.selected === 0, JSON.stringify(inline?.items?.slice(0, 2)));
  await ui.keyboard.type('a');
  const kept = await field();
  check('typing the next letter of the completion keeps it showing (no flicker back to the bare text)', kept.value === `localhost:${port}` && kept.start === 4 && kept.end === kept.value.length, JSON.stringify(kept));

  // ---- 3. Backspace / Delete remove the completion first
  await listFor('loca');
  await ui.keyboard.press('Backspace');
  await sleep(400);
  const back = await field();
  check('Backspace removes the completion and nothing else; it does not come back', back.value === 'loca' && back.start === 4 && back.end === 4, JSON.stringify(back));
  await typeIn('loc');
  await waitFor(async () => (await field()).value === `localhost:${port}`);
  await ui.keyboard.press('Delete');
  await sleep(400);
  const del = await field();
  check('Delete removes the completion too', del.value === 'loc', JSON.stringify(del));

  // ---- 4. Enter goes to exactly what is shown
  n = (await navs()).length;
  await ui.keyboard.press('Enter');
  const afterBack = await lastNav(n);
  check('Enter after the completion was removed searches what is left, exactly as typed', /^https:\/\/www\.google\.com\/search\?q=loc$/.test(afterBack || ''), afterBack);
  await loadDirect(`${ip}/page-two`);
  await typeIn('loc');
  await waitFor(async () => (await field()).value === `localhost:${port}`);
  n = (await navs()).length;
  await ui.keyboard.press('Enter');
  const toCompleted = await lastNav(n);
  check('Enter with the completion showing goes to that site', toCompleted === `${local}/`, toCompleted);
  await waitFor(async () => (await currentUrl()).startsWith(local), 5000);

  // ---- 5. never from a site that was not typed: visited only, or a built-in suggestion
  await typeIn('127.0');
  await listFor('127.0');
  await sleep(300);
  const notTyped = await field();
  check('a site only visited (never typed) is not completed in place', notTyped.value === '127.0' && notTyped.start === 5, JSON.stringify(notTyped));
  await typeIn('you');
  await listFor('you');
  await sleep(300);
  const seed = await field();
  check('a built-in suggestion (YouTube) is never completed in place', seed.value === 'you', JSON.stringify(seed));
  check('…it is still a row to pick, after the search row', seed.items[0]?.kind === 'search' && seed.items[0].title === 'you' && seed.items.some((i) => /youtube/.test(i.go)), JSON.stringify(seed.items));
  await ui.keyboard.press('Escape');

  // ---- 6. words are searched exactly as typed, never sent to a page that matches them
  for (const typed of ['page', 'teh weathr tomorow', 'node.js', 'Recieve']) {
    await typeIn(typed);
    const f = await listFor(typed);
    if (typed === 'page') check('typing words that match History pages: the first row is still "search for" what was typed, and it is what Enter takes', f && f.items[0].kind === 'search' && f.items[0].title === 'page' && f.selected === 0 && f.items.some((i) => i.kind === 'history'), JSON.stringify(f));
    n = (await navs()).length;
    await ui.keyboard.press('Enter');
    const went = await lastNav(n);
    check(`Enter on "${typed}" searches it exactly as typed with the default engine`, went === `https://www.google.com/search?q=${encodeURIComponent(typed)}`, went);
    await loadDirect(`${ip}/page-two`);
  }

  // ---- 7. the first row is what was typed at every keystroke (the list never reorders under the cursor)
  await ui.evaluate(() => document.getElementById('address').focus());
  await ui.keyboard.press('Control+A');
  const firsts = [];
  for (const letter of 'page') {
    await ui.keyboard.type(letter);
    const typed = 'page'.slice(0, firsts.length + 1);
    const f = await listFor(typed);
    firsts.push(f && f.items[0].kind === 'search' && f.items[0].title === typed && f.selected === 0);
  }
  check('as each letter is typed, the first row stays the search for the typed text, selected', firsts.every(Boolean), JSON.stringify(firsts));

  // ---- 8. arrow keys move through the rows; Escape puts back what was typed
  const list = await listFor('page');
  await ui.keyboard.press('ArrowDown');
  const down = await field();
  check('ArrowDown picks the next row and the field shows it', down.selected === 1 && down.value === list.items[1].go, JSON.stringify(down));
  await ui.keyboard.press('ArrowUp');
  const up = await field();
  check('ArrowUp goes back to the first row: the typed text', up.selected === 0 && up.value === 'page', JSON.stringify(up));
  await ui.keyboard.press('ArrowDown');
  await ui.keyboard.press('ArrowDown');
  await ui.keyboard.press('Escape');
  const esc = await field();
  check('Escape puts back exactly what was typed and closes the list', esc.value === 'page' && esc.items.length === 0, JSON.stringify(esc));
  await ui.keyboard.press('Escape');

  // ---- 9. Enter right after a keystroke goes to what the field shows, never to a row of the list for the earlier text
  await typeIn('pag');
  const old = await listFor('pag');
  await ui.keyboard.press('ArrowDown');
  const row = (await field()).value;
  n = (await navs()).length;
  await ui.keyboard.type('x');
  await ui.keyboard.press('Enter');
  const quick = await lastNav(n);
  check('a row picked from the list, then edited: Enter opens the edited text, not the row', old.items.length > 1 && quick === row + 'x' && quick !== old.items[1].go, JSON.stringify({ quick, row }));
  await loadDirect(`${ip}/page-two`);

  // ---- 10. Shift+Delete removes a History row
  await typeIn('page-one');
  const rows = await listFor('page-one');
  const at = rows.items.findIndex((i) => i.kind === 'history' && i.go === `${ip}/page-one`);
  for (let i = 0; i < at; i++) await ui.keyboard.press('ArrowDown');
  const picked = await field();
  await ui.keyboard.press('Shift+Delete');
  const gone = await waitFor(async () => !(await hasHistory(`${ip}/page-one`)));
  const after = await waitFor(async () => { const f = await field(); return f.typed === 'page-one' && !f.items.some((i) => i.go === `${ip}/page-one`) && f; });
  check('Shift+Delete on a History row removes that page from History', at > 0 && picked.selected === at && gone, JSON.stringify({ at, picked: picked.selected, gone }));
  check('…the list is made again without it, and the field holds the typed text', Boolean(after) && after.value === 'page-one', JSON.stringify(after || await field()));
  await ui.keyboard.press('Escape');
  await ui.keyboard.press('Escape');

  // ---- 11. a URL is the first row and Enter opens exactly it
  await typeIn(`localhost:${port}/zz`);
  const url = await listFor(`localhost:${port}/zz`);
  check('typing an address: the first row is that URL', url && url.items[0].kind === 'site' && url.items[0].go === `http://localhost:${port}/zz` && url.value === `localhost:${port}/zz`, JSON.stringify(url));
  n = (await navs()).length;
  await ui.keyboard.press('Enter');
  const exact = await lastNav(n);
  check('Enter opens exactly that address', exact === `${local}/zz`, exact);
  await waitFor(async () => (await currentUrl()) === `${local}/zz`, 5000);

  // ---- 12. Ctrl+Enter adds www. and .com
  await typeIn('lumenomniboxtest');
  await listFor('lumenomniboxtest');
  n = (await navs()).length;
  await ui.keyboard.press('Control+Enter');
  const com = await lastNav(n);
  check('Ctrl+Enter opens www.<text>.com', com === 'https://www.lumenomniboxtest.com/', com);
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.stop());

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
