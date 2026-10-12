// The chat page's "Working on: <tab>" chip and the purple "agent active" mark in the tab strip (features/chat-page.js, main.js agentActiveTab).
// They belong to a tab a reply is acting on, never to the tab the user looked at last. A stubbed provider (no network, no key) drives it:
//  - a reply that uses no tab tool ("look at the pdf I just downloaded...") leaves the open web tab unmarked, with no chip;
//  - a reply that does use one (read_page) shows the chip and the mark during the reply, and both clear when it ends;
//  - a session restored after quitting mid-reply carries no marker, and its chat page shows no chip.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const LONG = 'emah-maker/lumen: Chromium browser with a Claude agent (Electron), built for people who live in their tabs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const launch = async (profile) => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  return app;
};
// What the chat page's header and composer show of the permission mode, and the layout and contrast measurements (run in the page).
const modeState = `(() => { const b = document.getElementById('auto-allow'); const g = document.getElementById('bypass-badge'); return { mode: b.dataset.mode, label: b.querySelector('.perm-state')?.textContent, title: b.title, armed: b.classList.contains('armed'), badge: Boolean(g) && !g.hidden && g.getBoundingClientRect().width > 0, badgeTitle: g?.title }; })()`;
const measure = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cy: (r.top + r.bottom) / 2 }; };
  const ids = ['cp-export', 'cp-home', 'auto-allow', 'cp-more'];
  const actions = ids.map((id) => ({ id, ...box(document.getElementById(id)) }));
  const named = [['model', '.model-picker'], ['title', '.cp-title-wrap'], ['chip', '#cp-target'], ...ids.map((id) => [id, '#' + id])].map(([n, sel]) => ({ n, ...box(document.querySelector(sel)) })).filter((x) => x.w > 0);
  const overlaps = [];
  for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) if (named[i].l < named[j].r - 0.5 && named[j].l < named[i].r - 0.5) overlaps.push(named[i].n + '/' + named[j].n);
  const chip = document.getElementById('cp-target'); const text = document.getElementById('cp-target-text'); const cs = getComputedStyle(text);
  return { heights: actions.map((a) => Math.round(a.h)), centres: actions.map((a) => Math.round(a.cy)), gaps: actions.slice(1).map((a, i) => Math.round(a.l - actions[i].r)),
    overlaps, scrollX: document.documentElement.scrollWidth > innerWidth + 1, right: Math.max(...named.map((x) => x.r)) <= innerWidth + 0.5, vw: innerWidth,
    chip: chip.hidden ? null : { h: Math.round(chip.getBoundingClientRect().height), overflow: cs.textOverflow, hidden: cs.overflow, cut: text.scrollWidth > text.clientWidth, title: chip.title } };
})()`;
const contrast = `(() => {
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (css) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = css; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => top[3] >= 1 ? top : [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const backdrop = (el) => { let c = [255, 255, 255, 1]; const chain = []; for (let e = el; e; e = e.parentElement) chain.push(rgba(getComputedStyle(e).backgroundColor)); for (const l of chain.reverse()) c = over(l, c); return c; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (bgEl, fgEl) => { const bg = backdrop(bgEl); const fg = over(rgba(getComputedStyle(fgEl).color), bg); const [a, b] = [lum(bg), lum(fg)].sort((x, y) => y - x); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
  const btn = document.getElementById('auto-allow'); const pill = document.querySelector('#bypass-badge .bb-pill');
  return { button: ratio(btn, btn.querySelector('.perm-state')), badge: pill && pill.offsetWidth ? ratio(pill, pill.querySelector('.bb-text')) : null };
})()`;
const scheme = (app, value) => app.evaluate(async (_e, v) => {
  const t = global.__chatPage.tabs().find((x) => x.chat);
  const wc = global.__chatPage.contents(t.id);
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
}, value);
const resize = (app, w) => app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setMinimumSize(300, 300); win.setContentSize(width, 800); }, w);

// The stub never touches the tabs itself. A message containing "USE TAB" asks for read_page first; the model's last turn is held while
// global.__hold is set, so the state during the reply can be looked at.
const stubProvider = (app) => app.evaluate(() => {
  global.__hold = null;
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const usage = { input_tokens: 100, output_tokens: 20 };
    const lastAsk = [...params.messages].reverse().find((m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')));
    const wantsTab = /USE TAB/.test(JSON.stringify(lastAsk));
    const results = params.messages.indexOf(lastAsk) < params.messages.length - 1 && params.messages.slice(params.messages.indexOf(lastAsk)).some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    if (wantsTab && !results) {
      const text = 'Reading.';
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: 'tu-1', name: 'read_page', input: {} }], usage }),
      };
    }
    const text = 'All done.';
    return {
      async *[Symbol.asyncIterator]() { if (global.__hold) await global.__hold; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
    };
  } } } });
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Fixture ${req.url.slice(1)}: ${LONG}</title><body><p>fixture ${req.url}</p></body>`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-workingon-'));

  let app = await launch(profile);
  let ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await stubProvider(app);

  const tabs = () => app.evaluate(() => global.__chatPage.tabs());
  const chatTab = async () => (await tabs()).find((t) => t.chat && /chat-page\.html$/.test(t.url));
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  const chipHidden = () => inPage("document.getElementById('cp-target').hidden");
  const chipText = () => inPage("document.getElementById('cp-target-text').textContent");
  // The strip's mark for a tab ('running' | 'approval' | ... | ''), and how many tabs pulse as being read.
  const mark = (id) => ui.evaluate((i) => document.querySelector(`.tab[data-id="${i}"]`)?.dataset.chat ?? 'NO TAB', id);
  const reading = () => ui.evaluate(() => document.querySelectorAll('.tab.ai-reading').length);
  const send = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  const running = () => inPage("document.getElementById('send').classList.contains('stop')");
  const hold = () => app.evaluate(() => { global.__hold = new Promise((r) => { global.__release = r; }); });
  const release = () => app.evaluate(() => { global.__release?.(); global.__hold = null; });
  const openWeb = (name) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, `${base}/${name}`);

  // ---- a web tab, then a chat tab
  const web = await openWeb('github');
  await app.evaluate(() => global.__chatPage.open());
  const chat = await waitFor(chatTab);
  await waitFor(async () => (await inPage('document.readyState')) === 'complete');
  check('setup: a web tab and a chat tab', Boolean(chat) && Boolean(web), JSON.stringify(await tabs()));
  check('idle: no "Working on" chip', await waitFor(async () => (await chipHidden()) === true), await chipText());
  check('idle: the web tab has no mark', (await mark(web)) === '', await mark(web));

  // ---- 0. The permission mode control: one click goes to the next mode (Ask > Auto > Bypass > Ask), in the header and the composer alike
  const mode = () => inPage(modeState);
  const clickMode = () => inPage("document.getElementById('auto-allow').click()");
  const settled = async (want) => waitFor(async () => { const m = await mode(); return m.mode === want && !m.armed && m; }, 6000);
  let m = await mode();
  check('mode: starts on Ask, named in the header, the tooltip names the next mode, no composer bar', m.mode === 'ask' && m.label === 'Ask' && /switch to Auto/.test(m.title) && !m.badge, JSON.stringify(m));
  await clickMode();
  m = await mode();
  check('mode: going up asks for a second click first (the existing confirm), saying which mode', m.armed && m.mode === 'ask' && /Confirm Auto/.test(m.label) && /Click again to switch to Auto/.test(m.title), JSON.stringify(m));
  await clickMode();
  m = await settled('auto');
  check('mode: the second click switches to Auto; the tooltip now names Bypass', Boolean(m) && m.label === 'Auto' && /switch to Bypass/.test(m.title), JSON.stringify(m));
  await clickMode();
  await clickMode();
  m = await settled('bypass');
  check('mode: Auto > Bypass (confirmed) shows the Bypass name and the composer bar', Boolean(m) && m.label === 'Bypass' && m.badge && /switch to Ask/.test(m.title) && /switch to Ask/.test(m.badgeTitle), JSON.stringify(m));
  check('mode: the main window sidebar control follows', await waitFor(async () => (await ui.evaluate(() => document.getElementById('auto-allow').dataset.mode)) === 'bypass'), await ui.evaluate(() => document.getElementById('auto-allow').dataset.mode));
  await clickMode();
  m = await settled('ask');
  check('mode: Bypass > Ask wraps around in one click and the composer bar goes', Boolean(m) && m.label === 'Ask' && !m.badge, JSON.stringify(m));
  check('mode: Settings did not open', !(await tabs()).some((t) => /settings/i.test(t.url)), JSON.stringify(await tabs()));
  for (let i = 0; i < 4; i++) await clickMode(); // Ask > Auto > Bypass again (each rise is armed, then confirmed)
  m = await settled('bypass');
  await inPage("document.getElementById('bypass-badge').click()");
  m = await settled('ask');
  check('mode: clicking the composer bar does the same as the header (Bypass > Ask), no Settings', Boolean(m) && !m.badge && !(await tabs()).some((t) => /settings/i.test(t.url)), JSON.stringify(m));
  await inPage("document.getElementById('auto-allow').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))");
  check('mode: right-click opens the full menu, with a Settings row', (await inPage("(() => { const m = document.getElementById('perm-menu'); return !m.hidden && Boolean(document.getElementById('perm-settings')) && [...m.querySelectorAll('.perm-item[data-mode]')].length === 3; })()")) === true, 'no menu');
  await inPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  for (let i = 0; i < 4; i++) await clickMode(); // end on Bypass: the stub's tab tool then needs no approval card
  m = await settled('bypass');
  check('mode: ends on Bypass (for the reply below)', Boolean(m), JSON.stringify(m));

  // ---- 1. a reply that uses no tab tool
  await hold();
  await send('look at the pdf i just downloaded and generate an image on how to do the problem');
  check('the reply is running', Boolean(await waitFor(running)), 'not running');
  await sleep(600);
  check('no tab tool: no "Working on" chip during the reply', (await chipHidden()) === true, await chipText());
  check('no tab tool: the web tab shows no agent mark during the reply', (await mark(web)) === '', await mark(web));
  check('no tab tool: the chat tab itself is the one marked running', (await mark(chat.id)) === 'running', await mark(chat.id));
  check('no tab tool: no tab is pulsing as read', (await reading()) === 0, await reading());
  await release();
  check('the reply finished', await waitFor(async () => !(await running()) && /All done\./.test(await inPage("document.getElementById('messages').textContent"))), 'still running');
  check('no tab tool: still no chip and no mark after the reply', (await chipHidden()) === true && (await mark(web)) === '', `${await chipText()} / ${await mark(web)}`);

  // ---- 2. a reply that does use one
  await hold();
  await send('USE TAB: what does my open page say');
  check('tab tool: the chip appears during the reply, naming the tab', await waitFor(async () => (await chipHidden()) === false && /Fixture github/.test(await chipText())), `${await chipHidden()} ${await chipText()}`);
  check('tab tool: the web tab shows the running mark during the reply', await waitFor(async () => (await mark(web)) === 'running'), await mark(web));

  // ---- the header while the chip shows: one height, centred, no overlap, an ellipsis, readable Bypass, at three widths and both themes
  for (const w of [1280, 900, 700]) {
    await resize(app, w);
    await waitFor(async () => Math.abs((await inPage('innerWidth')) - w) < 40, 4000);
    await sleep(300);
    for (const theme of ['light', 'dark']) {
      await scheme(app, theme);
      await sleep(250);
      const lay = await inPage(measure);
      const con = await inPage(contrast);
      const tag = `${w}px ${theme}`;
      check(`header ${tag}: the four right-side controls (and the chip) are all 32px tall and share one centre line`, lay.heights.every((h) => h === 32) && new Set(lay.centres).size === 1 && (w < 900 ? lay.chip?.h === 0 : lay.chip?.h === 32), JSON.stringify(lay));
      check(`header ${tag}: even spacing between the controls`, new Set(lay.gaps).size === 1, JSON.stringify(lay.gaps));
      check(`header ${tag}: nothing overlaps (model, title, chip, controls), nothing wider than the window`, lay.overlaps.length === 0 && !lay.scrollX && lay.right, JSON.stringify(lay));
      check(`header ${tag}: the chip text truncates with an ellipsis inside its pill and carries the full name in its tooltip (under 900px the page hides the chip by design)`, lay.chip && lay.chip.overflow === 'ellipsis' && lay.chip.hidden === 'hidden' && (w < 900 || lay.chip.cut || w > 900) && lay.chip.title.includes(LONG) && (w !== 900 || lay.chip.cut), JSON.stringify(lay.chip));
      check(`header ${tag}: Bypass is readable (contrast >= 4.5), button and composer bar`, con.button >= 4.5 && con.badge >= 4.5, JSON.stringify(con));
    }
  }
  await scheme(app, 'light');
  await resize(app, 1280);
  await sleep(300);
  if (process.env.WOC_SHOTS) {
    const png = await app.evaluate(async () => (await global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id).capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(process.env.WOC_SHOTS, 'chat-header-during-reply.png'), Buffer.from(png, 'base64'));
  }
  await release();
  check('tab tool: the reply finished', await waitFor(async () => !(await running())), 'still running');
  check('tab tool: the chip clears when the reply ends', await waitFor(async () => (await chipHidden()) === true), await chipText());
  check('tab tool: the web tab mark clears when the reply ends', await waitFor(async () => (await mark(web)) !== 'running'), await mark(web));

  // ---- 3. a session restored after quitting in the middle of a tab-using reply
  await hold();
  await send('USE TAB: and once more');
  await waitFor(async () => (await mark(web)) === 'running');
  await sleep(3500); // the session is saved a moment after tabs change
  await app.close();
  app = await launch(profile);
  ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await stubProvider(app);
  const restored = await waitFor(chatTab, 15000);
  const strip = () => ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((el) => ({ id: Number(el.dataset.id), title: el.textContent, chat: el.dataset.chat || '' })));
  const webBack = await waitFor(async () => (await strip()).find((t) => /Fixture github/.test(t.title)), 15000);
  check('restore: the chat page and the web tab come back', Boolean(restored) && Boolean(webBack), JSON.stringify(await strip()));
  await waitFor(async () => (await inPage('document.readyState')) === 'complete');
  await sleep(800);
  const marks = restored && webBack ? [await mark(webBack.id), await mark(restored.id)] : [];
  check('restore: nothing is running after a restart, so no tab shows a mark at all', JSON.stringify(marks) === '["",""]' || !marks.includes('running'), JSON.stringify(await strip()));
  check('restore: no tab carries an agent mark', marks.length === 2 && !marks.includes('running') && !marks.includes('approval'), JSON.stringify(marks));
  check('restore: no tab is pulsing as read', (await reading()) === 0, await reading());
  check('restore: the chat page shows no "Working on" chip', (await chipHidden()) === true, await chipText());
  check('restore: the page is not running', !(await running()), 'running');

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
