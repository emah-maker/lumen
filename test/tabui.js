// The tab strip's Chrome-style interactions (renderer/app.js, renderer/tab-search.js): the speaker
// on a tab playing sound (after the title; a click mutes, and it shows crossed out), middle-click
// closes a tab, the hover card under a tab you rest on, Shift/Ctrl/Cmd+click multi-selection, and
// closing a run of tabs with their ✕ without the tabs resizing under the pointer.
// `TABUI_SHOTS=<dir>` also saves screenshots of the strip there (light and dark).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// One second of a quiet 440 Hz tone, looped by the page.
function toneWav() {
  const rate = 22050;
  const data = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(50); } return false; };

  const wav = toneWav();
  const server = http.createServer((req, res) => {
    if (req.url === '/tone.wav') { res.setHeader('Content-Type', 'audio/wav'); return res.end(wav); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/audio') return res.end('<title>Sound page</title><audio id="a" src="/tone.wav" loop autoplay></audio><script>document.getElementById("a").play().catch(() => {});</script>');
    res.end(`<title>Page ${req.url.slice(1)}: a longer title for the hover card</title><p>${req.url}</p>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabui-'));
  const shots = process.env.TABUI_SHOTS;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ...(process.env.NTUI_AUDIO === '1' ? { LUMEN_TEST_ALLOW_AUDIO: '1' } : {}) } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
  await ui.evaluate(() => window.assistant.setAutoGroup(false)); // one host's tabs would be grouped otherwise

  const open = (url, background = true) => app.evaluate(async (_e, { url, background }) => {
    const t = global.__agent.browser.openTab(url, { background });
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, { url, background });
  const activeId = () => app.evaluate(() => global.__agent.browser.activeTab()?.id);
  const tabIds = () => ui.evaluate(() => [...document.querySelectorAll('#tabs .tab:not(.tab-ghost)')].map((el) => Number(el.dataset.id)));
  const tabSel = (id) => `#tabs .tab[data-id="${id}"]`;
  const rectOf = (sel) => ui.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const shot = async (name, rect = { x: 0, y: 0, width: 1440, height: 100 }) => {
    if (!shots) return;
    const b64 = await app.evaluate(async ({ BrowserWindow }, rect) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect)).toPNG().toString('base64'), rect);
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, name), Buffer.from(b64, 'base64'));
  };
  const away = () => ui.mouse.move(700, 400); // over the page area: off the strip

  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await open(`${base}/p${i}`));

  // ---- 1. the speaker: shown while a tab plays sound, after the title; a click mutes the tab ----
  // Test runs are silent (--mute-audio), and Chromium then never reports a tab as playing sound, so there is no speaker to
  // test: this section runs only with sound, as NTUI_AUDIO=1 node test/tabui.js.
  if (process.env.NTUI_AUDIO !== '1') console.log('SKIP  the speaker on a tab playing sound (needs sound: run with NTUI_AUDIO=1)');
  else {
  const soundId = await open(`${base}/audio`);
  check('a tab playing sound shows the speaker', await waitFor(() => ui.evaluate((sel) => Boolean(document.querySelector(`${sel} .tab-audio:not(.muted)`)), tabSel(soundId)), 10000), 'no speaker');
  const order = await ui.evaluate((sel) => [...document.querySelector(`${sel} .tab-inner`).children].map((c) => c.classList[0]), tabSel(soundId));
  check('the speaker sits after the title, before the ✕ (Chrome)', order.indexOf('tab-audio') === order.indexOf('tab-title') + 1 && order.indexOf('tab-close') > order.indexOf('tab-audio'), order.join());
  const mutedNow = () => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter((w) => w.getURL() === url).map((w) => w.isAudioMuted())[0], `${base}/audio`);
  const beforeActive = await activeId();
  await ui.hover(tabSel(soundId)); // the ✕ shows beside the speaker
  await sleep(250);
  const clear = await ui.evaluate((sel) => {
    const a = document.querySelector(`${sel} .tab-audio`).getBoundingClientRect();
    const c = document.querySelector(`${sel} .tab-close`).getBoundingClientRect();
    return a.right <= c.left + 0.5;
  }, tabSel(soundId));
  check('the speaker and the ✕ do not overlap', clear, 'they overlap');
  await ui.click(`${tabSel(soundId)} .tab-audio`);
  check('clicking the speaker mutes the tab', await waitFor(async () => (await mutedNow()) === true), await mutedNow());
  check('it shows crossed out', await waitFor(() => ui.evaluate((sel) => Boolean(document.querySelector(`${sel} .tab-audio.muted`)), tabSel(soundId))), 'not muted in the strip');
  check('and the click did not switch to the tab', (await activeId()) === beforeActive, `${await activeId()} vs ${beforeActive}`);
  const label = await ui.evaluate((sel) => document.querySelector(`${sel} .tab-audio`).getAttribute('aria-label'), tabSel(soundId));
  check('its label says what a click does', /^Unmute Tab: Sound page$/.test(label), label);
  if (shots) {
    for (const scheme of ['light', 'dark']) {
      await ui.emulateMedia({ colorScheme: scheme });
      await away();
      await sleep(250);
      const r = await rectOf(tabSel(soundId));
      await shot(`audio-muted-${scheme}.png`, { x: Math.round(r.left) - 210, y: 0, width: 440, height: 44 });
    }
    await ui.emulateMedia({ colorScheme: 'light' });
  }
  await ui.click(`${tabSel(soundId)} .tab-audio`);
  check('clicking it again unmutes', await waitFor(async () => (await mutedNow()) === false), await mutedNow());
  check('and the speaker is back to normal', await waitFor(() => ui.evaluate((sel) => Boolean(document.querySelector(`${sel} .tab-audio:not(.muted)`)), tabSel(soundId))), 'still muted');
  if (shots) {
    for (const scheme of ['light', 'dark']) {
      await ui.emulateMedia({ colorScheme: scheme });
      await away();
      await sleep(250);
      const r = await rectOf(tabSel(soundId));
      await shot(`audio-playing-${scheme}.png`, { x: Math.round(r.left) - 210, y: 0, width: 440, height: 44 });
      await ui.hover(tabSel(soundId));
      await sleep(250);
      await shot(`audio-playing-hover-${scheme}.png`, { x: Math.round(r.left) - 210, y: 0, width: 440, height: 44 });
    }
    await ui.emulateMedia({ colorScheme: 'light' });
  }
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)?.setAudioMuted(true), `${base}/audio`); // quiet for the rest
  }

  // ---- 2. middle-click closes a tab; on the strip's empty space it does nothing ----
  const extra = await open(`${base}/extra`);
  const r = await rectOf(tabSel(extra));
  await ui.mouse.click(r.x, r.y, { button: 'middle' });
  check('middle-click closes that tab', await waitFor(async () => !(await tabIds()).includes(extra)), (await tabIds()).join());
  const count = (await tabIds()).length;
  // Closing a tab reflows the rest (they animate wider), and the search button rides the strip's
  // end - so wait for the tab strip to hold still, then pick the point and check it is not a tab.
  const stripLayout = () => ui.evaluate(() => JSON.stringify([...document.querySelectorAll('#tabs .tab'), document.getElementById('tab-search')].map((el) => el.getBoundingClientRect().right)) + document.querySelectorAll('.organize-note').length);
  let lastLayout = '';
  let stableFrames = 0;
  await waitFor(async () => { const l = await stripLayout(); stableFrames = l === lastLayout ? stableFrames + 1 : 0; lastLayout = l; return stableFrames >= 4; }, 4000);
  const empty = await ui.evaluate(() => { const b = document.getElementById('tab-search').getBoundingClientRect(); return { x: b.right + 60, y: b.top + b.height / 2 }; });
  const emptyHit = await ui.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.tab, button') !== null, empty);
  check('the empty strip point is not on a tab or button', !emptyHit, JSON.stringify(empty));
  await ui.mouse.click(empty.x, empty.y, { button: 'middle' });
  await ui.mouse.dblclick(empty.x, empty.y);
  await sleep(400);
  // Empty strip space is the window's title bar: a double-click there is the system's (zoom or
  // maximize, as Chrome leaves it), so the page itself adds no tab.
  check('middle-click and double-click on empty strip space open or close nothing', (await tabIds()).length === count, `${count} -> ${(await tabIds()).length}`);

  // ---- 3. the hover card ----
  await away();
  await sleep(400);
  const target = pages[1];
  const cardState = () => ui.evaluate(() => {
    const card = document.querySelector('.tab-hover-card');
    if (!card || card.hidden) return null;
    const r = card.getBoundingClientRect();
    return { title: card.querySelector('.hover-card-title').textContent, host: card.querySelector('.hover-card-host').textContent, left: r.left, top: r.top, bottom: r.bottom, viewportTop: document.getElementById('viewport').getBoundingClientRect().top };
  });
  const tr = await rectOf(tabSel(target));
  await ui.mouse.move(tr.x, tr.y);
  await sleep(200);
  check('no card at once: it waits for the pointer to rest', (await cardState()) === null, JSON.stringify(await cardState()));
  check('then a card shows', await waitFor(async () => Boolean(await cardState()), 1500), 'never shown');
  let card = await cardState();
  check('it has the page title and the site', card?.title === 'Page p1: a longer title for the hover card' && card?.host === `127.0.0.1:${server.address().port}`, JSON.stringify(card));
  check('it sits under the tab, lined up with it', card && Math.abs(card.left - tr.left) <= 1 && card.top >= tr.bottom, JSON.stringify({ card, tr }));
  check('and it ends above the page view (which is drawn over this document)', card && card.bottom <= card.viewportTop, JSON.stringify(card));
  const hasTooltip = await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].some((el) => el.hasAttribute('title') || el.querySelector('.tab-close').hasAttribute('title')));
  check('tabs have no title tooltip on top of the card', !hasTooltip, 'a title attribute is set');
  if (shots) {
    for (const scheme of ['light', 'dark']) {
      await ui.emulateMedia({ colorScheme: scheme });
      await sleep(250);
      await shot(`hover-card-${scheme}.png`, { x: Math.max(0, Math.round(tr.left) - 120), y: 0, width: 560, height: 90 });
    }
    await ui.emulateMedia({ colorScheme: 'light' });
  }
  const next = await rectOf(tabSel(pages[2]));
  await ui.mouse.move(next.x, next.y, { steps: 4 });
  await sleep(60);
  card = await cardState();
  check('moving to the next tab carries the card along at once', card?.title === 'Page p2: a longer title for the hover card', JSON.stringify(card));
  await ui.mouse.down();
  await sleep(50);
  check('a press puts it away', (await cardState()) === null, JSON.stringify(await cardState()));
  await ui.mouse.up();
  await sleep(700);
  check('and it stays away while the pointer rests on the tab it clicked', (await cardState()) === null, JSON.stringify(await cardState()));
  await ui.mouse.move(tr.x, tr.y, { steps: 4 });
  check('another tab shows its card again', await waitFor(async () => (await cardState())?.title === 'Page p1: a longer title for the hover card', 1500), JSON.stringify(await cardState()));
  await away();
  check('leaving the strip hides the card', await waitFor(async () => (await cardState()) === null, 1000), JSON.stringify(await cardState()));

  // ---- 4. multi-select ----
  const [a, b, c, d] = pages;
  const selected = () => ui.evaluate(() => [...document.querySelectorAll('#tabs .tab.selected, #tabs .tab.active')].map((el) => Number(el.dataset.id)));
  const toggleKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await ui.click(tabSel(a), { position: { x: 30, y: 14 } });
  await waitFor(async () => (await activeId()) === a);
  await ui.click(tabSel(c), { position: { x: 30, y: 14 }, modifiers: ['Shift'] });
  check('Shift+click selects the run of tabs', await waitFor(async () => (await activeId()) === c && JSON.stringify(await selected()) === JSON.stringify([a, b, c])), JSON.stringify({ sel: await selected(), active: await activeId() }));
  check('and the clicked tab is the active one', (await activeId()) === c, await activeId());
  const looks = await ui.evaluate((sel) => getComputedStyle(document.querySelector(sel)).backgroundColor, tabSel(b));
  check('a selected tab is lit (not transparent)', looks !== 'rgba(0, 0, 0, 0)' && looks !== 'transparent', looks);
  if (shots) {
    for (const scheme of ['light', 'dark']) {
      await ui.emulateMedia({ colorScheme: scheme });
      await away();
      await sleep(300);
      await shot(`selection-${scheme}.png`, { x: 0, y: 0, width: 1000, height: 44 });
    }
    await ui.emulateMedia({ colorScheme: 'light' });
  }
  await ui.click(tabSel(b), { position: { x: 30, y: 14 }, modifiers: [toggleKey] });
  check(`${toggleKey}+click takes a selected tab out`, await waitFor(async () => JSON.stringify(await selected()) === JSON.stringify([a, c])), JSON.stringify(await selected()));
  await ui.click(tabSel(d), { position: { x: 30, y: 14 }, modifiers: [toggleKey] });
  check(`${toggleKey}+click adds a tab and makes it active`, await waitFor(async () => (await activeId()) === d && JSON.stringify(await selected()) === JSON.stringify([a, c, d])), JSON.stringify({ sel: await selected(), active: await activeId() }));
  await ui.click(tabSel(d), { position: { x: 30, y: 14 }, modifiers: [toggleKey] });
  check(`${toggleKey}+click on the active selected tab hands active to another selected tab`, await waitFor(async () => [a, c].includes(await activeId()) && JSON.stringify(await selected()) === JSON.stringify([a, c])), JSON.stringify({ sel: await selected(), active: await activeId() }));
  const hears = await ui.evaluate(() => typeof window.browser.setTabSelection === 'function');
  console.log(hears ? 'INFO  main hears the selection (setTabSelection)' : 'INFO  main does not take the selection yet (no window.browser.setTabSelection): it is only shown');
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), b);
  check('switching to a tab outside it (not by clicking) ends the selection', await waitFor(async () => JSON.stringify(await selected()) === JSON.stringify([b])), JSON.stringify(await selected()));
  await ui.click(tabSel(a), { position: { x: 30, y: 14 }, modifiers: ['Shift'] });
  await waitFor(async () => (await selected()).length === 2);
  await ui.click(tabSel(c), { position: { x: 30, y: 14 } });
  check('a plain click ends it too', await waitFor(async () => (await activeId()) === c && JSON.stringify(await selected()) === JSON.stringify([c])), JSON.stringify(await selected()));

  // ---- 5. closing tabs in a row: widths hold until the pointer leaves the strip ----
  for (let i = 0; i < 5; i++) await open(`${base}/q${i}`); // ~11 tabs: narrower than full, wide enough for a ✕
  await away();
  await sleep(600);
  const widths = () => ui.evaluate(() => [...document.querySelectorAll('#tabs .tab:not(.pinned):not(.tab-ghost)')].map((el) => el.getBoundingClientRect().width));
  const w0 = await widths();
  check('with many tabs they are narrower than full width', w0.length >= 10 && Math.max(...w0) < 199 && Math.min(...w0) > 80, JSON.stringify(w0.map(Math.round)));
  const ids0 = await tabIds();
  const mid = ids0[Math.floor(ids0.length / 2)];
  await ui.hover(tabSel(mid));
  await sleep(200);
  const x1 = await rectOf(`${tabSel(mid)} .tab-close`);
  let closedRow = 0;
  let under = null;
  for (let i = 0; i < 3; i++) {
    const before = await tabIds();
    await ui.mouse.move(x1.x, x1.y);
    await ui.mouse.down();
    await ui.mouse.up();
    await waitFor(async () => (await tabIds()).length === before.length - 1);
    await sleep(520); // the neighbours' slide
    under = await ui.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return { close: Boolean(el?.closest('.tab-close')), id: Number(el?.closest('.tab')?.dataset.id) }; }, { x: x1.x, y: x1.y });
    if ((await tabIds()).length === before.length - 1 && under.close) closedRow++;
  }
  check(`three ✕ clicks in one place close three tabs, the next ✕ sliding under the pointer each time (${closedRow}/3)`, closedRow === 3, JSON.stringify(under));
  const w1 = await widths();
  check('the tabs kept their widths meanwhile', w1.every((w) => Math.abs(w - w0[0]) < 1), JSON.stringify(w1.map(Math.round)));
  await away();
  check('leaving the strip lets them widen into the room', await waitFor(async () => { const w = await widths(); return w[0] > w0[0] + 3; }, 2000), JSON.stringify((await widths()).map(Math.round)));
  await sleep(600);
  const indicator = await ui.evaluate(() => {
    const a = document.querySelector('#tabs .tab.active').getBoundingClientRect();
    const i = document.querySelector('#tabs .tab-indicator').getBoundingClientRect();
    return Math.abs(a.left - i.left) < 1.5 && Math.abs(a.width - i.width) < 1.5;
  });
  check("the active tab's surface followed", indicator, 'indicator off the active tab');

  // ---- 6. the strip's keyboard still works ----
  await ui.focus('#tabs .tab.active');
  const focusedBefore = await ui.evaluate(() => document.activeElement.dataset.id);
  await ui.keyboard.press('ArrowRight');
  const focusedAfter = await ui.evaluate(() => document.activeElement.dataset.id);
  check('ArrowRight still moves focus along the strip', focusedAfter && focusedAfter !== focusedBefore, `${focusedBefore} -> ${focusedAfter}`);

  check('no renderer errors', errors.length === 0, errors.join('; '));
  server.close();
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
