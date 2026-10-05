// Tab search (Ctrl+Shift+A and the strip's button): finds open tabs by title and address, Enter
// switches, a closed tab reopens. Tab audio: a tab playing sound shows a speaker, clicking it mutes
// the tab, and Mute Site covers every tab on that host (features/tab-tools.js, renderer/tab-search.js).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// One second of a quiet 440 Hz tone, looped by the page.
function toneWav() {
  const rate = 22050;
  const samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), i * 2);
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
  const waitFor = async (fn, timeout = 8000) => {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await fn().catch((e) => { last = e; return false; });
      if (last) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  };

  const wav = toneWav();
  const titles = { '/alpha': 'Alpha Report', '/beta': 'Beta Notes', '/zeta-path': 'Unrelated page', '/delta': 'Delta Closed' };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/tone.wav') { res.setHeader('Content-Type', 'audio/wav'); return res.end(wav); }
    res.setHeader('Content-Type', 'text/html');
    if (url === '/audio') return res.end('<title>Sound page</title><audio id="a" src="/tone.wav" loop autoplay></audio><script>document.getElementById("a").play().catch(() => {});</script>');
    res.end(`<title>${titles[url] || url}</title><p>${url}</p>`);
  }).listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`; // a different host, same server

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabsearch-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_ALLOW_AUDIO: '1' } }); // (test mode mutes audio, and a muted page is never reported as playing)
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));

  const open = (url, background = true) => app.evaluate(async (_e, { url, background }) => {
    const t = global.__agent.browser.openTab(url, { background });
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, { url, background });
  const activeUrl = () => app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL());
  const panelOpen = () => ui.evaluate(() => { const p = document.getElementById('tab-search-panel'); return Boolean(p && !p.hidden); });
  const resultTitles = () => ui.evaluate(() => [...document.querySelectorAll('.tab-search-item .tab-search-title')].map((e) => e.textContent));
  const selectedItem = () => ui.evaluate(() => { const s = document.querySelector('.tab-search-item.selected'); return s ? { title: s.querySelector('.tab-search-title').textContent, kind: s.dataset.kind } : null; });
  const typeQuery = async (q) => { await ui.fill('#tab-search-input', q); await waitFor(async () => (await resultTitles()).length > 0 || q === ''); };

  // Ctrl+Shift+A as a real key press, into the page (the usual case) or the browser UI.
  const pressSearchKey = (where = 'page') => app.evaluate(({ BrowserWindow }, where) => {
    const wc = where === 'ui' ? BrowserWindow.fromId(global.__windows.list()[0].windowId).webContents : // (getAllWindows()[0] can be a spare or an agent window)
       global.__agent.browser.activeTab().webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control', 'shift'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control', 'shift'] });
  }, where);

  // ---- tab search
  const alphaId = await open(`${base}/alpha`);
  await open(`${base}/beta`);
  await open(`${base}/zeta-path`);
  const deltaId = await open(`${base}/delta`);

  await ui.click('#tab-search');
  check('the tab search button opens the popup', await waitFor(panelOpen), 'not open');
  check('the search box has the keyboard', await ui.evaluate(() => document.activeElement?.id === 'tab-search-input'), 'focus elsewhere');
  const all = await resultTitles();
  check('an empty query lists every open tab', ['Alpha Report', 'Beta Notes', 'Unrelated page', 'Delta Closed'].every((t) => all.includes(t)), JSON.stringify(all));
  await ui.keyboard.press('Escape');
  check('Escape closes it', await waitFor(async () => !(await panelOpen())), 'still open');

  await pressSearchKey('page');
  check('Ctrl+Shift+A in a page opens tab search', await waitFor(panelOpen), 'not open');
  check('with the keyboard in the search box', await waitFor(() => ui.evaluate(() => document.activeElement?.id === 'tab-search-input')), 'focus elsewhere');

  await typeQuery('beta');
  check('typing a title finds that tab first', (await selectedItem())?.title === 'Beta Notes', JSON.stringify(await resultTitles()));
  await typeQuery('zeta-path');
  const byUrl = await resultTitles();
  check('typing part of the address finds a tab whose title doesn\'t match', byUrl[0] === 'Unrelated page', JSON.stringify(byUrl));
  await typeQuery('btnts');
  check('letters in order with gaps still match ("btnts" -> Beta Notes)', (await resultTitles())[0] === 'Beta Notes', JSON.stringify(await resultTitles()));
  await typeQuery('qqqzzz');
  check('no match shows the empty message', await ui.evaluate(() => Boolean(document.querySelector('.tab-search-empty'))) && (await resultTitles()).length === 0, 'results shown');

  await typeQuery('alpha');
  await ui.keyboard.press('Enter');
  check('Enter switches to the chosen tab', await waitFor(async () => (await activeUrl()) === `${base}/alpha`), await activeUrl());
  check('and closes the popup', await waitFor(async () => !(await panelOpen())), 'still open');

  await pressSearchKey('ui');
  check('Ctrl+Shift+A in the browser UI opens it too', await waitFor(panelOpen), 'not open');
  await typeQuery('report');
  await ui.keyboard.press('ArrowDown'); // wraps round a single result
  check('arrow keys keep a result selected', (await selectedItem())?.title === 'Alpha Report', JSON.stringify(await selectedItem()));
  await ui.keyboard.press('Escape');

  // A closed tab shows under "Recently closed" and reopens.
  await app.evaluate((_e, id) => global.__agent.browser.closeTab(id), deltaId);
  await waitFor(async () => (await app.evaluate(() => global.__closedTabs())).includes(`${base}/delta`));
  await pressSearchKey('page');
  await waitFor(panelOpen);
  await typeQuery('delta');
  const closedSel = await selectedItem();
  check('a closed tab is found by its title, under Recently closed', closedSel?.title === 'Delta Closed' && closedSel?.kind === 'closed', JSON.stringify(closedSel));
  check('with a Recently closed heading', await ui.evaluate(() => [...document.querySelectorAll('.tab-search-section')].some((h) => h.textContent === 'Recently closed')), 'no heading');
  await ui.keyboard.press('Enter');
  check('Enter reopens it as the active tab', await waitFor(async () => (await activeUrl()) === `${base}/delta`), await activeUrl());
  check('and it leaves the closed list', !(await app.evaluate(() => global.__closedTabs())).includes(`${base}/delta`), 'still listed');
  check('a stale reopen (list changed) does nothing', await ui.evaluate((u) => window.browser.reopenClosed(0, u), `${base}/nothing`) === false, 'reopened');

  // ---- tab audio
  const soundId = await open(`${base}/audio`, false);
  const tabEl = `#tabs .tab[data-id="${soundId}"]`;
  const audible = await waitFor(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((w) => w.getURL() === url && w.isCurrentlyAudible()), `${base}/audio`), 10000);
  if (audible) check('the sound page is playing audio', true, ''); // (not audible: reported as skipped below)
  // Chromium reports a tab as audible only while the machine's audio output takes the stream; with no usable output (some CI and remote
  // sessions) the speaker button never appears, so what depends on it is skipped, loudly.
  if (audible) {
    check('its tab shows the speaker button', await waitFor(() => ui.evaluate((sel) => Boolean(document.querySelector(`${sel} .tab-audio:not(.muted)`)), tabEl)), 'no speaker');
  check('the other tabs don\'t', await ui.evaluate((id) => [...document.querySelectorAll('#tabs .tab .tab-audio')].every((b) => b.closest('.tab').dataset.id === String(id)), soundId), 'speaker elsewhere');
  }

  const mutedOf = (url) => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter((w) => w.getURL() === url).map((w) => w.isAudioMuted()), url);

  if (audible) {
    await ui.click(`${tabEl} .tab-audio`);
  check('clicking the speaker mutes the tab', await waitFor(async () => (await mutedOf(`${base}/audio`)).every(Boolean) && (await mutedOf(`${base}/audio`)).length === 1), JSON.stringify(await mutedOf(`${base}/audio`)));
  const audibleNow = () => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter((w) => w.getURL() === url).map((w) => w.isCurrentlyAudible()), `${base}/audio`);
  // Chromium keeps reporting a muted tab as playing (the sound is silenced, not stopped), which is
  // what keeps its crossed-out speaker on the tab so it can be unmuted.
  check('a muted tab still reports playing, so its muted speaker stays', (await audibleNow())[0] === true, JSON.stringify(await audibleNow()));
  check('the speaker shows as muted', await waitFor(() => ui.evaluate((sel) => Boolean(document.querySelector(`${sel} .tab-audio.muted`)), tabEl)), 'not shown muted');
  check('clicking the speaker doesn\'t switch or close tabs', await ui.evaluate((sel) => Boolean(document.querySelector(sel)), tabEl), 'tab gone');
  await ui.click(`${tabEl} .tab-audio`);
  check('clicking it again unmutes', await waitFor(async () => (await mutedOf(`${base}/audio`))[0] === false), JSON.stringify(await mutedOf(`${base}/audio`)));
  check('and the speaker is back to normal', await waitFor(() => ui.evaluate((sel) => Boolean(document.querySelector(`${sel} .tab-audio:not(.muted)`)), tabEl)), 'still muted');

  // Tab menu: Mute Tab / Mute Site
  const labels = await app.evaluate((_e, id) => global.__tabAudioMenu(id), soundId);
  check('the tab menu offers Mute Tab and Mute Site', labels.includes('Mute Tab') && labels.includes('Mute Site'), JSON.stringify(labels));
  const sameSiteId = await open(`${base}/beta?again`);
  const otherSiteId = await open(`${other}/beta`);
  await app.evaluate((_e, id) => global.__tabAudioMenu(id, 'Mute Site'), soundId);
  const siteState = async () => ({
    sound: (await mutedOf(`${base}/audio`))[0],
    same: (await mutedOf(`${base}/beta?again`))[0],
    other: (await mutedOf(`${other}/beta`))[0],
  });
  check('Mute Site mutes every tab on that host', await waitFor(async () => { const s = await siteState(); return s.sound && s.same; }), JSON.stringify(await siteState()));
  check('but not tabs on another host', (await siteState()).other === false, JSON.stringify(await siteState()));
  await open(`${base}/alpha?later`);
  check('a page opened later on that host starts muted', await waitFor(async () => (await mutedOf(`${base}/alpha?later`))[0] === true), JSON.stringify(await mutedOf(`${base}/alpha?later`)));
  check('the menu now offers Unmute Site', (await app.evaluate((_e, id) => global.__tabAudioMenu(id), sameSiteId)).includes('Unmute Site'), 'no Unmute Site');
  // A site-muted tab that leaves the site is unmuted.
  await app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/beta?again'));
    await wc.loadURL(url);
  }, `${other}/zeta-path`);
  check('a site-muted tab that goes to another site is unmuted', await waitFor(async () => (await mutedOf(`${other}/zeta-path`))[0] === false), JSON.stringify(await mutedOf(`${other}/zeta-path`)));
  await app.evaluate((_e, id) => global.__tabAudioMenu(id, 'Unmute Site'), soundId);
  check('Unmute Site unmutes them again', await waitFor(async () => (await mutedOf(`${base}/audio`))[0] === false && (await mutedOf(`${base}/alpha?later`))[0] === false), JSON.stringify(await siteState()));
  void otherSiteId;
  } else console.log('SKIP  speaker button, mute by click, Mute Site (the page never became audible: no usable audio output on this machine)');

  // Mute Tab from the menu.
  await app.evaluate((_e, id) => global.__tabAudioMenu(id, 'Mute Tab'), alphaId);
  check('Mute Tab from the menu mutes it', await waitFor(async () => (await mutedOf(`${base}/alpha`))[0] === true), JSON.stringify(await mutedOf(`${base}/alpha`)));

  // Pages can't reach the mute or reopen calls (they're UI-only IPC).
  const gate = await app.evaluate(() => ['tab:mute', 'tabsearch:closed', 'tabsearch:reopen'].every((c) => global.__ipcGate.uiOnly.has(c)));
  check('tab:mute and the tab search calls answer only the browser UI', gate, 'not gated');

  check('no errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
