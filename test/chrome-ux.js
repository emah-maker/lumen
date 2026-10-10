// Browser-chrome UX fixes from docs/ux-audit/chrome.md: the tab menu and page menu show their shortcuts, the two AI
// switches sit together, Copy Link and bookmarking confirm in the strip's toast, Back / Forward have a history list,
// a page on this computer isn't labelled "Not secure", and the tab in front stays in view when the window narrows.
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
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(50); } return v; };

  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Page ${req.url.slice(1)}</title><p>${req.url}</p>`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chrome-ux-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ clipboard }) => { global.__copied = null; clipboard.writeText = (text) => { global.__copied = text; }; }); // not the real clipboard
  await app.evaluate(() => global.__patchSettings({ bookmarks: [] }));
  const win = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => { [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setContentSize(w, h); }, [w, h]);
  await win(1100, 700);
  const open = (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); return t.id; }, url);
  const full = (id) => app.evaluate((_e, id) => global.__tabMenuFull(id), id);
  const note = () => ui.evaluate(() => document.querySelector('.organize-note .organize-note-text')?.textContent || '');

  await open(`${base}/a`);
  const b = await open(`${base}/b`);

  // ---- 1. the tab menu shows shortcuts, and keeps the two AI switches together
  const items = await full(b);
  const hint = (label) => items.find((i) => i.label === label);
  check('tab menu: Reload shows its shortcut, without registering it twice', hint('Reload')?.accelerator === 'CmdOrCtrl+R' && hint('Reload')?.registerAccelerator === false, JSON.stringify(hint('Reload')));
  check('tab menu: Close Tab, Reopen Closed Tab and Bookmark Tab show theirs', hint('Close tab')?.accelerator === 'CmdOrCtrl+W' && hint('Reopen closed tab')?.accelerator === 'CmdOrCtrl+Shift+T' && hint('Bookmark tab')?.accelerator === 'CmdOrCtrl+D' && hint('Bookmark all tabs')?.accelerator === 'CmdOrCtrl+Shift+D', JSON.stringify(items.map((i) => i.accelerator)));
  const keep = items.findIndex((i) => /Keep the AI from acting|Let the AI act/.test(i.label || ''));
  const site = items.findIndex((i) => /^(Turn off|Turn on) AI on /.test(i.label || ''));
  check('tab menu: "Keep the AI from acting on this tab" and "Turn off AI on <site>" are neighbours', keep !== -1 && site === keep + 1, JSON.stringify(items.map((i) => i.label)));
  check('tab menu: the AI section is set off by separators from the tab commands above and Close below', items[keep - 1]?.label === '---' && items[site + 1]?.label === '---' && items[site + 2]?.label === 'Close tab', JSON.stringify(items.map((i) => i.label)));

  // ---- 2. confirmations in the strip's toast
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Copy link'), b);
  check('Copy Link says "Link copied"', await waitFor(async () => (await note()) === 'Link copied'), await note());
  check('…and put the address on the clipboard', (await app.evaluate(() => global.__copied)) === `${base}/b`, await app.evaluate(() => global.__copied));
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Bookmark tab'), b);
  check('Bookmark Tab says "Bookmark added"', await waitFor(async () => (await note()) === 'Bookmark added'), await note());
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Remove bookmark'), b);
  check('Remove Bookmark says "Bookmark removed"', await waitFor(async () => (await note()) === 'Bookmark removed'), await note());

  // ---- 3. a page on this computer is not "Not secure"
  const chip = () => ui.evaluate(() => { const s = document.getElementById('security'); return { cls: s.className, hidden: s.hidden, name: s.getAttribute('aria-label'), text: s.textContent.trim() }; });
  await ui.evaluate(() => document.activeElement.blur()); // (the field being typed in shows no chip)
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), b);
  const local = await waitFor(async () => { const c = await chip(); return !c.hidden && c; });
  check('http://127.0.0.1 shows a neutral chip, not the orange "Not secure"', local && !/insecure|danger/.test(local.cls) && local.text === '' && local.name === 'This page is on your own computer', JSON.stringify(local));

  // ---- 4. Back / Forward: a list of pages, and a click goes straight there
  await open(`${base}/h1`);
  await app.evaluate(async (_e, base) => { const wc = global.__agent.browser.activeTab().webContents; for (const n of ['h2', 'h3', 'h4']) { await wc.loadURL(`${base}/${n}`); } }, base);
  await waitFor(async () => (await app.evaluate(() => global.__agent.browser.activeTab().webContents.navigationHistory.getAllEntries().length)) >= 4);
  const back = await app.evaluate(() => global.__navHistoryMenu('back').map((i) => i.label));
  check('Back lists the pages behind, nearest first, then Show All History', JSON.stringify(back.slice(0, 3)) === '["Page h3","Page h2","Page h1"]' && back.includes('Show all history'), JSON.stringify(back));
  check('Forward has nothing to list at the newest page', (await app.evaluate(() => global.__navHistoryMenu('forward'))).length === 0, '');
  await app.evaluate(() => { global.__navHistoryMenu('back').find((i) => i.label === 'Page h2').click(); });
  const gone = await waitFor(async () => (await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL())) === `${base}/h2`);
  check('picking Page h2 goes straight there (two steps back)', gone, await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL()));
  const fwd = await app.evaluate(() => global.__navHistoryMenu('forward').map((i) => i.label));
  check('…and Forward then lists the pages ahead', JSON.stringify(fwd.slice(0, 2)) === '["Page h3","Page h4"]', JSON.stringify(fwd));
  // The right-click itself: the UI asks main, which pops the menu up (captured here, not shown).
  await app.evaluate(({ Menu }) => { global.__popups = []; Menu.prototype.popup = function () { global.__popups.push(this.items.map((i) => i.label || '---')); }; });
  await waitFor(async () => !(await ui.evaluate(() => document.getElementById('back').disabled)));
  await ui.click('#back', { button: 'right' });
  const popped = await waitFor(async () => (await app.evaluate(() => global.__popups)).length > 0 && (await app.evaluate(() => global.__popups[0])));
  check('right-clicking Back pops the history list up', Array.isArray(popped) && popped[0] === 'Page h1', JSON.stringify(popped));

  // ---- 5. the tab in front stays in view when the window narrows
  for (let i = 0; i < 12; i++) await open(`${base}/n${i}`);
  await win(1300, 700);
  await sleep(500);
  const visible = () => ui.evaluate(() => { const s = document.getElementById('tabs').getBoundingClientRect(); const r = document.querySelector('#tabs .tab.active').getBoundingClientRect(); return { ok: r.left >= s.left - 1 && r.right <= s.right + 1, s: [s.left, s.right], r: [r.left, r.right] }; });
  check('(setup) the tab in front is in view in a wide window', (await visible()).ok, JSON.stringify(await visible()));
  await win(700, 700);
  const stays = await waitFor(async () => (await visible()).ok, 3000);
  check('the tab in front is still in view after the window narrows', stays, JSON.stringify(await visible()));

  // ---- 6. round 2: dead merge rows, tab state in the name, monograms, the default match, the AI button
  await win(1100, 700);
  const labels2 = (await full(b)).map((i) => i.label || '');
  check('tab menu: with one window there are no Merge rows (not shown dead)', !labels2.some((l) => /^Merge (all windows|window into)/.test(l)), JSON.stringify(labels2));
  const nameOf = (id) => ui.evaluate((i) => document.querySelector(`#tabs .tab[data-id="${i}"]`)?.getAttribute('aria-label') || '', id);
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Pin tab'), b);
  await waitFor(async () => /pinned/.test(await nameOf(b)));
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Mute tab'), b);
  const named = await waitFor(async () => { const n = await nameOf(b); return /pinned/.test(n) && /muted/.test(n) && n; });
  check('tab state (pinned, muted) is in the tab\'s accessible name', Boolean(named) && /^Page b, pinned, muted/.test(named), await nameOf(b));
  check('the speaker button is not a Tab stop (the strip stays one roving stop)', await ui.evaluate((i) => document.querySelector(`#tabs .tab[data-id="${i}"] .tab-audio`)?.tabIndex === -1, b), '');
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Unmute tab'), b);
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Unpin tab'), b);
  await waitFor(async () => !/pinned|muted/.test(await nameOf(b)));
  const mono = await waitFor(() => ui.evaluate((i) => { const e = document.querySelector(`#tabs .tab[data-id="${i}"] .tab-favicon`); return e && e.classList.contains('monogram') && { text: e.textContent, hue: e.style.getPropertyValue('--mono-hue') }; }, b), 6000);
  check('a page with no icon gets a monogram of its site (a letter on a color), not the globe', Boolean(mono) && mono.text === '1' && mono.hue !== '', JSON.stringify(mono));
  const aiBtn = await ui.evaluate(() => { const b = document.getElementById('toggle-sidebar'); return { who: b.dataset.assistant, title: b.title, label: b.getAttribute('aria-label'), setup: b.classList.contains('needs-setup') }; });
  check('the toolbar AI button names what it is for (set up, or the model)', aiBtn.who === 'AI' ? aiBtn.setup && /^Set up AI \(/.test(aiBtn.title) && aiBtn.label === 'Set up AI' : !aiBtn.setup && aiBtn.label === aiBtn.who, JSON.stringify(aiBtn));
  // the omnibox: plain words with a history page first pre-select it; an address typed in full is left alone
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), b);
  await ui.evaluate(() => document.getElementById('address').focus());
  await ui.keyboard.press('Control+A');
  await ui.keyboard.type('page');
  const pre = await waitFor(async () => { const s = await ui.evaluate('({ selected: suggest.selected, kinds: suggest.items.map((i) => i.kind) })'); return s.kinds.length && s; });
  check('typing plain words pre-selects the first row when it is a page from history', pre && pre.kinds[0] === 'history' && pre.selected === 0, JSON.stringify(pre));
  await ui.keyboard.press('Enter');
  const went = await waitFor(async () => { const u = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL()); return u.startsWith(base) && !/google/.test(u) && u; });
  check('Enter goes to that page, not to a web search', Boolean(went), await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL()));
  await ui.evaluate(() => document.getElementById('address').focus());
  await ui.keyboard.press('Control+A');
  await ui.keyboard.type(`${base}/n1`);
  await sleep(500);
  const exact = await ui.evaluate("({ selected: suggest.selected, value: document.getElementById('address').value })");
  check('typing a full address pre-selects nothing, so Enter goes to exactly what was typed', exact.selected === -1 && exact.value === `${base}/n1`, JSON.stringify(exact));
  await ui.keyboard.press('Escape');
  await ui.keyboard.press('Escape');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
