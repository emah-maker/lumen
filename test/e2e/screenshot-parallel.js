// Two sidebar chats working at the same time, each in its own background tab, both calling the AI's screenshot tool
// again and again (ai/snapshot.js screenshot -> features/tab-capture.js captureJpeg / captureTab). While chat A's page is
// locked up, chat B's screenshots of its own tab must still come back at once. Fake model, hidden windows.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const SHOTS = 8; // screenshots per chat
const BUSY_MS = 14000; // how long chat A's page is locked up

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${name}</title><body style="margin:0;background:#${name === 'ALPHA' ? 'c03030' : name === 'BETA' ? '3030c0' : 'ddd'}"><h1>PAGE-${name}</h1><script>setInterval(() => { document.title = 'Page ${name} ' + Date.now(); }, 200);</script></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-shotpar-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('oneChatPerTab', true); });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  // The model: chat X streams a line, waits for the shared gate, then asks for a screenshot SHOTS times, then finishes.
  // What each screenshot call returned (a picture or an error) and how long it took is recorded in global.__shots[X].
  await app.evaluate((_e, n) => {
    global.__shots = {};
    global.__inflight = new Set();
    let open; const gate = new Promise((r) => { open = r; });
    global.__go = () => open();
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
      const results = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
      const rec = (global.__shots[who] ||= []);
      const usage = { input_tokens: 100, output_tokens: 20 };
      if (results.length) {
        const last = results.at(-1).content.find((b) => b.type === 'tool_result');
        const blocks = Array.isArray(last?.content) ? last.content : [];
        rec.push({ image: blocks.some((b) => b.type === 'image'), error: Boolean(last?.is_error), text: JSON.stringify(last?.content).slice(0, 200), at: Date.now() });
      }
      if (results.length >= n) {
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${who} finished` } }; }, finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `${who} finished` }], usage }) };
      }
      const text = `${who} shot ${results.length}`;
      return {
        async *[Symbol.asyncIterator]() { global.__inflight.add(who); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; if (!results.length) await gate; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}-${results.length}`, name: 'screenshot', input: {} }], usage }),
      };
    } } } });
    global.__shotStart = (who) => { (global.__shots[who] ||= []).t0 = Date.now(); };
  }, SHOTS);

  const openTab = (url) => app.evaluate((_e, u) => { const id = global.__agent.browser.openTab(u).id; global.__tabChats.setSidebar(id, true); return id; }, url);
  const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const inflight = (who) => waitFor(() => app.evaluate((_e, w) => global.__inflight.has(w), who));

  // Chat A in the first tab, chat B in a second; then a third tab (the user's) comes to the front: both run tabs are behind it.
  const tabA = await active();
  await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/alpha`);
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await waitFor(() => app.evaluate(() => /alpha/i.test(global.__windows.list()[0].tabs[0].url)));
  await send('chat-A: take screenshots');
  await inflight('A');
  const tabB = await openTab(`${base}/beta`);
  await waitFor(async () => (await active()) === tabB);
  await waitFor(() => app.evaluate(() => global.__tabChats.shown() === global.__tabChats.chatId()));
  await sleep(500);
  await send('chat-B: take screenshots');
  await inflight('B');
  const tabC = await openTab(`${base}/gamma`);
  await waitFor(async () => (await active()) === tabC);
  await sleep(800);
  const visible = await app.evaluate(() => global.__windows.list()[0].tabs.map((t) => [t.id, t.url]));
  check('both run tabs are behind the tab in front', (await active()) === tabC && tabA !== tabC && tabB !== tabC, JSON.stringify(visible));

  // The sidebar's Browser cards are on screen (the live preview runs for each run); the UI tells main so over this channel.
  await app.evaluate(({ ipcMain, webContents }) => { for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'window') ipcMain.emit('agent:thumbs-visible', { sender: wc }, true); });

  // Chat A's page locks up (a script that runs for BUSY_MS: a heavy page, an alert()): the screenshots of that tab wait until it answers.
  // They must not hold up chat B's screenshots of its own, healthy tab.
  await app.evaluate((_e, [id, ms]) => { global.__aiTabs.tab(id).view.webContents.executeJavaScript('setTimeout(() => { const t = Date.now(); while (Date.now() - t < ' + ms + '); }, 0)').catch(() => {}); }, [tabA, BUSY_MS]);
  await sleep(300);
  const t0 = Date.now();
  await app.evaluate(() => global.__go());
  const doneB = await waitFor(() => app.evaluate((_e, n) => (global.__shots.B || []).length >= n, SHOTS), 60000);
  const tookB = Date.now() - t0;
  const doneA = await waitFor(() => app.evaluate((_e, n) => (global.__shots.A || []).length >= n, SHOTS), 60000);
  const shots = await app.evaluate(() => global.__shots);
  for (const who of ['A', 'B']) console.log(who, (shots[who] || []).map((s) => (s.at - t0) + (s.image ? '' : ' ERR ' + s.text)).join(' | '));
  for (const who of ['A', 'B']) {
    const list = shots[who] || [];
    const bad = list.filter((s) => !s.image || s.error);
    check('chat ' + who + ': all ' + SHOTS + ' screenshots came back as pictures', list.length >= SHOTS && bad.length === 0, JSON.stringify(bad.slice(0, 2)) + ' of ' + list.length);
  }
  check("chat B's " + SHOTS + ' screenshots did not wait for the locked-up tab of chat A (' + tookB + ' ms, the lock lasts ' + BUSY_MS + ' ms)', Boolean(doneB) && tookB < BUSY_MS / 2, tookB + ' ms, done=' + doneB);
  check('chat A finished once its page answered again', Boolean(doneA), 'not done');
  check("the user's tab was not moved", (await active()) === tabC, await active());
  check('no page errors', errors.length === 0, errors.join('; '));

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
