// "Keep the AI from acting on this tab" in the real app (features/ai-manners.js keepOff, main.js "[ai off-tab]", the address bar's button and the
// tab strip), with a temp profile and no network: the shield button shows on a page and toggles per tab; the tab carries a mark in the
// strip; reading it still works, every tool that acts is refused on it, in the tool layer; it stays through navigation and a restart.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus. SHOTS=<dir> saves screenshots of the button.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE ${req.url}</h1><button id="b">Go</button></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aitaboff-'));
  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => { await unfocus(); await sleep(400); if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await ui.screenshot({ path: path.join(process.env.SHOTS, name), clip: { x: 0, y: 0, width: 1100, height: 90 } }); } };

  const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const btn = () => ui.evaluate(() => { const b = document.getElementById('ai-off-tab'); return { hidden: b.hidden, pressed: b.getAttribute('aria-pressed'), title: b.title, label: b.getAttribute('aria-label') }; });
  const mark = (id) => ui.evaluate((i) => { const el = document.querySelector(`#tabs .tab[data-id="${i}"]`); return el ? { kept: el.classList.contains('ai-kept-off'), shown: getComputedStyle(el.querySelector('.tab-off-mark')).display !== 'none', label: el.getAttribute('aria-label') } : null; }, id);
  const run = (id, name, input = {}) => app.evaluate(async (_e, a) => {
    const signal = new AbortController().signal;
    const m = []; m.settings = { model: 'claude-opus-5' };
    try { return { ok: true, out: await global.__agent.inTask(a.id, signal, () => global.__agent.execute(a.name, a.input), m) }; } catch (e) { return { ok: false, error: e.message }; }
  }, { id, name, input });
  const press = () => ui.$eval('#ai-off-tab', (b) => b.click()); // a DOM click: while the address bar has focus the buttons are hidden
  const unfocus = () => ui.evaluate(() => document.activeElement?.blur());
  const goto = async (url) => { await app.evaluate(({ webContents }, u) => { webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).loadURL(u); }, url); await waitFor(() => app.evaluate((_e, u) => global.__windows.list()[0].tabs[0].url === u, url)); };

  const first = await active();
  check('the button is not shown on the new tab page (no page to keep the AI off)', (await btn()).hidden === true, JSON.stringify(await btn()));
  await goto(`${base}/one`);
  await waitFor(async () => (await btn()).hidden === false);
  const off = await btn();
  check('on a web page it shows, off: pressed false, the tooltip offers it', off.hidden === false && off.pressed === 'false' && off.title === 'Keep the AI from acting on this tab' && off.label === off.title, JSON.stringify(off));
  check('the page works for the AI at first', (await run(first, 'read_page')).ok === true);
  await shot('ai-off-tab-off.png');

  await press();
  const on = await waitFor(async () => { const b = await btn(); return b.pressed === 'true' && b; });
  check('clicking it turns it on: pressed, and the tooltip says the AI can read but not act', on && /can read this tab but not act on it/.test(on.title), JSON.stringify(on));
  const m = await waitFor(async () => (await mark(first))?.kept && (await mark(first)));
  check('the tab strip marks the tab (a shield after the title, and a spoken note)', m?.kept && m.shown && /AI read-only/.test(m.label || ''), JSON.stringify(m));
  await shot('ai-off-tab-on.png');

  for (const [name, input] of [['read_page', {}], ['find', { query: 'Go' }], ['screenshot', {}]]) {
    const r = await run(first, name, input);
    check(`${name} still works on the tab (read-only)`, r.ok === true, JSON.stringify(r).slice(0, 300));
  }
  for (const [name, input] of [['click', { text: 'Go' }], ['type_text', { text: 'x' }], ['press_key', { key: 'Enter' }], ['scroll', { direction: 'down' }], ['run_script', { code: '1' }], ['navigate', { url: `${base}/two` }], ['reload', {}]]) {
    const r = await run(first, name, input);
    check(`${name} is refused on the tab, with the clear text`, !r.ok && /keeps the AI from acting on this tab/.test(r.error) && /You can read it/.test(r.error), JSON.stringify(r));
  }
  const second = await app.evaluate((_e, u) => global.__agent.browser.openTab(u, { ai: true }).id, `${base}/ai`);
  check('another tab works as usual', (await run(second, 'read_page')).ok === true);
  const listed = JSON.parse((await run(second, 'list_tabs')).out);
  check('list_tabs lists the tab marked read-only', /read-only/.test(listed.find((t) => t.id === first)?.off_limits || ''), JSON.stringify(listed));
  check('close_tab on it is refused, and read_tabs reads it', /keeps the AI from acting/.test((await run(second, 'close_tab', { tab_id: first })).error || '') && (await run(second, 'read_tabs', { ids: [first] })).ok === true);
  const rt = String((await run(second, 'read_tabs', { ids: [first] })).out || '');
  check('read_tabs returns its text', /PAGE \//.test(rt) && !/keeps the AI|skipped/.test(rt), rt.slice(0, 300));

  await goto(`${base}/three`);
  check('it stays on while the tab navigates (per tab, not per site)', (await btn()).pressed === 'true' && (await run(first, 'click', { text: 'Go' })).error?.includes('keeps the AI from acting'));

  // the other tab's own button state, and the user's right to turn it off again
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), second);
  await waitFor(async () => (await btn()).pressed === 'false');
  check('the button follows the tab in front: off on the other tab', (await btn()).pressed === 'false');
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), first);
  await waitFor(async () => (await btn()).pressed === 'true');

  // a restart brings it back with the tab
  await app.close();
  app = await launch(profile);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const restored = await waitFor(() => app.evaluate(() => global.__windows.list()[0].tabs.length >= 1 && global.__windows.list()[0].activeId));
  const back = await waitFor(async () => { const b = await btn(); return b.pressed === 'true' && b; });
  check('after a restart the tab comes back with the AI still kept off', Boolean(back) && (await run(restored, 'click', { text: 'Go' })).error?.includes('keeps the AI from acting'), JSON.stringify({ back, restored }));

  // turning it off again (the user's click) lets the AI back in
  await press();
  await waitFor(async () => (await btn()).pressed === 'false');
  check('clicking again lets the AI act on the tab', !/keeps the AI from acting/.test((await run(restored, 'click', { text: 'Go' })).error || ''));

  check('no page errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
