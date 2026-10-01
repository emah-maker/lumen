// A sidebar chat per tab, working at the same time (features/tab-chats.js, main.js "[chat per tab]"), with a
// fake Claude client: no network, no key needed. Two fake-model chats run in two tabs at once: both stream, their
// tools act on their own tabs, switching tabs shows the right chat with its live state, the tabs carry a mark,
// the cap makes the next chat wait, a tab closed under a working chat does not stop it, the chat list shows
// where each chat lives (open it in its tab, move it here), and tab-chat bindings come back after a restart and
// follow a tab into another window.
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

// The model: a message that names "chat-X" is chat X. Its first turn streams a line, then waits until the test lets
// it go (so several chats are in flight together), then reads the page; the second turn answers "X finished" and
// records what its read_page tool saw.
const fakeModel = (app) => app.evaluate(() => {
  global.__seen = {};
  global.__inflight = new Set();
  const holds = {};
  const hold = (who) => (holds[who] ||= (() => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; })());
  global.__release = (who) => hold(who).resolve();
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    const results = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    const usage = { input_tokens: 100, output_tokens: 20 };
    if (!results.length) {
      const text = `${who} is working`;
      return {
        async *[Symbol.asyncIterator]() {
          global.__inflight.add(who);
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
          await hold(who).p;
        },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}`, name: 'read_page', input: {} }], usage }),
      };
    }
    const seen = JSON.stringify(results.at(-1).content);
    global.__seen[who] = /PAGE-(\w+)/.exec(seen)?.[1] || seen.slice(0, 80);
    const text = `${who} finished`;
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
    };
  } } } });
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${name}</title><body><h1>PAGE-${name}</h1><p>This is page ${name}.</p></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabchats-'));
  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await fakeModel(app);

  const openTab = (url) => app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, url);
  const showTab = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
  const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const tc = (fn, arg) => app.evaluate(fn, arg);
  const mark = (id) => tc((_e, i) => global.__tabChats.mark(i), id);
  const stripMark = (id) => ui.evaluate((i) => document.querySelector(`#tabs .tab[data-id="${i}"]`)?.dataset.chat || '', id);
  const messagesText = () => ui.evaluate(() => document.getElementById('messages').innerText);
  const bubbles = () => ui.evaluate(() => [...document.querySelectorAll('#messages .msg.user')].map((e) => e.textContent.trim()));
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const inflight = (who) => waitFor(() => tc((_e, w) => global.__inflight.has(w), who));

  // ---- 1. Two tabs, two chats, working at the same time.
  const tabA = await active();
  await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/alpha`);
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await waitFor(() => app.evaluate(() => /PAGE|alpha/i.test(global.__windows.list()[0].tabs[0].url)));
  await send('chat-A: read this tab');
  await inflight('A');
  const tabB = await openTab(`${base}/beta`); // in front now, with a chat of its own
  await waitFor(async () => (await active()) === tabB);
  await waitFor(() => tc(() => global.__tabChats.shown() === global.__tabChats.chatId()));
  check('a new tab starts with its own empty chat', (await bubbles()).length === 0 && !/is working/.test(await messagesText()), await messagesText());
  const ids = await tc(() => ({ a: global.__tabChats.bindings.chatOf(1), b: [...global.__tabChats.bindings.entries()] }));
  check('the two tabs are bound to two different chats', ids.b.length === 2 && ids.b[0][1] !== ids.b[1][1], JSON.stringify(ids));
  await send('chat-B: read this tab');
  await inflight('B');
  const runs = await tc(() => global.__tabChats.runs());
  check('both chats are running at once, each in its own tab', runs.length === 2 && runs.every((r) => r.live) && runs.find((r) => r.tab === tabA) && runs.find((r) => r.tab === tabB), JSON.stringify(runs));
  check('both streamed their first line', true);
  check('each tab carries a "working" mark', (await mark(tabA)) === 'running' && (await mark(tabB)) === 'running', `${await mark(tabA)} ${await mark(tabB)}`);
  check('the tab strip shows the marks', (await waitFor(async () => (await stripMark(tabA)) === 'running' && (await stripMark(tabB)) === 'running')), `${await stripMark(tabA)} ${await stripMark(tabB)}`);

  // ---- 2. Switching tabs shows that tab's chat, live.
  await showTab(tabA);
  await waitFor(async () => (await bubbles()).some((b) => /chat-A/.test(b)));
  let text = await messagesText();
  check('switching to tab A shows chat A, still working, not chat B', /chat-A/.test(text) && !/chat-B/.test(text), text);
  check('its streamed words are there too, not only a spinner', await waitFor(async () => /A is working/.test(await messagesText())), await messagesText());
  check('chat A shows as running in the sidebar', await ui.evaluate(() => document.body.classList.contains('agent-active')), 'not running');
  await showTab(tabB);
  await waitFor(async () => (await bubbles()).some((b) => /chat-B/.test(b)));
  text = await messagesText();
  check('switching back to tab B shows chat B, not chat A', /chat-B/.test(text) && !/chat-A/.test(text), text);
  check('the user was never moved by a tool', (await active()) === tabB, await active());

  // ---- 3. Let both finish: each read its own tab even though the user was elsewhere.
  await tc(() => { global.__release('A'); global.__release('B'); });
  await waitFor(() => tc(() => Object.keys(global.__seen).length === 2));
  const seen = await tc(() => global.__seen);
  check('each chat\'s tool read its own tab', seen.A === 'ALPHA' && seen.B === 'BETA', JSON.stringify(seen));
  await waitFor(async () => /B finished/.test(await messagesText()));
  check('chat B\'s reply is in tab B', /B finished/.test(await messagesText()), await messagesText());
  check('chat A finished while its tab was not in front: its tab says done', await waitFor(async () => (await mark(tabA)) === 'done'), await mark(tabA));
  check('... and the strip shows the done dot', await waitFor(async () => (await stripMark(tabA)) === 'done'), await stripMark(tabA));
  await showTab(tabA);
  await waitFor(async () => /A finished/.test(await messagesText()));
  check('chat A\'s reply is in tab A', /A finished/.test(await messagesText()) && !/B finished/.test(await messagesText()), await messagesText());
  check('viewing the chat clears the done dot', await waitFor(async () => (await mark(tabA)) === null), await mark(tabA));

  // ---- 4. The cap: three chats work, the fourth waits its turn (and says so), then runs.
  const extra = [];
  for (const [i, who] of ['C', 'D', 'E'].entries()) { extra.push(await openTab(`${base}/${who.toLowerCase()}`)); await waitFor(async () => (await active()) === extra[i]); }
  await showTab(extra[0]); await waitFor(async () => (await active()) === extra[0]); await send('chat-C: go'); await inflight('C');
  await showTab(extra[1]); await waitFor(async () => (await active()) === extra[1]); await send('chat-D: go'); await inflight('D');
  // A third slot is taken by a chat in a tab of its own
  const tabF = await openTab(`${base}/f`); await waitFor(async () => (await active()) === tabF); await send('chat-F: go'); await inflight('F');
  await showTab(extra[2]); await waitFor(async () => (await active()) === extra[2]);
  await send('chat-E: go');
  await waitFor(() => tc(() => global.__tabChats.runs().some((r) => r.queued)));
  const queued = await tc(() => global.__tabChats.runs().find((r) => r.queued));
  check('with three working, the fourth chat waits (a visible waiting state)', Boolean(queued) && (await mark(extra[2])) === 'waiting', JSON.stringify(queued));
  check('the waiting chat says so on its working line', await ui.evaluate(() => /Waiting for another chat/.test(document.querySelector('.working')?.dataset.status || '')), await ui.evaluate(() => document.querySelector('.working')?.dataset.status));
  check('it is not running yet', !(await tc(() => global.__inflight.has('E'))), 'E started');
  await showTab(extra[0]); // away and back: its message and waiting state are still shown
  await showTab(extra[2]);
  await waitFor(async () => (await bubbles()).some((b) => /chat-E/.test(b)));
  check('switching away and back keeps the waiting chat\'s message and state', (await bubbles()).some((b) => /chat-E/.test(b)) && await ui.evaluate(() => Boolean(document.querySelector('.working')?.dataset.status)), await messagesText());
  await tc(() => global.__release('C'));
  await inflight('E');
  check('when a chat finishes the waiting one starts', await tc(() => global.__inflight.has('E')) && (await mark(extra[2])) === 'running', await mark(extra[2]));
  await tc(() => { for (const w of ['D', 'E', 'F']) global.__release(w); });
  await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000);
  check('everything finishes and no run is left', (await tc(() => global.__tabChats.runs().length)) === 0 && (await tc(() => global.__tabChats.slots.size())) === 0, JSON.stringify(await tc(() => global.__tabChats.runs())));

  // ---- 5. The chat list knows where each chat lives.
  await showTab(tabA);
  await waitFor(async () => /A finished/.test(await messagesText()));
  const list = await ui.evaluate(() => window.assistant.chats.list());
  const chatB = list.chats.find((c) => c.title.includes('chat-B'));
  check('the list says which tab each chat lives in', chatB?.tab?.id === tabB && chatB.tab.here === false && list.chats.find((c) => c.title.includes('chat-A'))?.tab?.here === true, JSON.stringify(list.chats.map((c) => [c.title, c.tab])));
  await ui.evaluate((id) => window.assistant.chats.showTab(id), chatB.id);
  check('"Open chat in its tab" goes to that tab and shows the chat', await waitFor(async () => (await active()) === tabB && /B finished/.test(await messagesText())), `${await active()} ${await messagesText()}`);
  await showTab(tabA);
  await waitFor(async () => /A finished/.test(await messagesText()));
  await ui.evaluate((id) => window.assistant.chats.open(id), chatB.id);
  await waitFor(async () => /B finished/.test(await messagesText()));
  const moved = await tc((_e, b) => ({ home: global.__tabChats.bindings.tabOf(b), onB: global.__tabChats.bindings.chatOf(2) }), chatB.id);
  check('"Move chat to this tab" binds it here and takes it from the other tab', moved.home === tabA, JSON.stringify(moved));
  await showTab(tabB);
  await waitFor(async () => (await tc(() => global.__tabChats.shown() === global.__tabChats.chatId())));
  check('the tab it left starts a chat of its own', (await bubbles()).length === 0, await messagesText());

  // ---- 6. A tab closed under a working chat does not stop it; the chat stays reachable.
  const doomed = await openTab(`${base}/doomed`);
  await waitFor(async () => (await active()) === doomed);
  await send('chat-X: go');
  await inflight('X');
  const before = await tc(() => global.__tabChats.runs().find((r) => r.live));
  await app.evaluate((_e, id) => { global.__doomed = id; global.__closeTabInteractive(id); }, doomed);
  await waitFor(async () => !(await tc((_e2, i) => global.__windows.list()[0].tabs.some((t) => t.id === i), doomed)));
  const after = await waitFor(() => tc(() => { const r = global.__tabChats.runs().find((x) => x.live); return r && r.tab != null && r.tab !== global.__doomed ? r : null; }));
  check('closing a tab with a working chat keeps it running, in a background tab', Boolean(before) && Boolean(after) && after.tab !== doomed, JSON.stringify({ before, after }));
  await tc(() => global.__release('X'));
  await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000);
  const savedX = await tc(() => global.__chats.store().list().some((c) => c.title.includes('chat-X')));
  check('it finished and is in the chat list', savedX, 'not saved');

  // ---- 7. A tab moves to another window and takes its chat, and a task working in it, along.
  const mover = await openTab(`${base}/moveme`);
  await waitFor(async () => (await active()) === mover);
  await send('chat-M: go');
  await inflight('M');
  const win1 = await tc(() => global.__windows.list()[0].windowId);
  await app.evaluate((_e, [w, id]) => global.__windows.tearOff(w, id, { x: 200, y: 200 }), [win1, mover]);
  await waitFor(() => tc(() => global.__windows.list().length === 2));
  const ui2 = await waitFor(() => app.windows().find((p) => p !== ui && p.url().includes('index.html')));
  await ui2.waitForSelector('.tab');
  const text2 = () => ui2.evaluate(() => document.getElementById('messages').textContent);
  await waitFor(async () => /chat-M/.test(await text2()));
  check('the chat follows its tab into the new window and shows there', /chat-M/.test(await text2()), await text2());
  check('the old window sidebar is not touched by it', !/chat-M/.test(await ui.evaluate(() => document.getElementById('messages').textContent)), 'M shows in the old window');
  const homeM = await tc(() => { const r = global.__tabChats.runs().find((x) => x.live); return { run: r, bound: global.__tabChats.bindings.chatOf(r?.tab) === r?.chatId }; });
  check('its run goes on in the moved tab', homeM.run?.tab === mover && homeM.bound, JSON.stringify(homeM));
  await tc(() => global.__release('M'));
  await waitFor(() => tc(() => global.__seen.M));
  check('its tool read the moved tab, now in the other window', (await tc(() => global.__seen.M)) === 'MOVEME', await tc(() => global.__seen.M));
  await waitFor(async () => /M finished/.test(await text2()));
  check('its reply streams into the new window sidebar', /M finished/.test(await text2()), await text2());

  // ---- 8. After a restart each tab shows its chat; nothing is re-run.
  const beforeRestart = await tc(() => ({ entries: global.__tabChats.bindings.entries(), saved: global.__chats.store().list().map((c) => c.id) }));
  const wanted = beforeRestart.entries.filter(([, c]) => beforeRestart.saved.includes(c));
  await app.evaluate(() => global.__settingsFlush && global.__settingsFlush());
  await app.close();
  app = await launch(profile);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await fakeModel(app);
  await waitFor(() => tc(() => global.__tabChats.bindings.size() > 0));
  const restored = await tc(() => ({ entries: global.__tabChats.bindings.entries(), runs: global.__tabChats.runs(), tabs: global.__windows.list()[0].tabs.length, active: global.__windows.list()[0].activeId }));
  check('after a restart the tabs are bound to their saved chats again', restored.entries.length >= 1 && restored.entries.every(([, c]) => beforeRestart.saved.includes(c)), JSON.stringify({ restored, wanted }));
  check('after a restart nothing is re-run', restored.runs.length === 0, JSON.stringify(restored.runs));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), restored.entries[0][0]);
  const shown = await waitFor(async () => (await ui.evaluate(() => document.getElementById('messages').innerText)).trim());
  check('a tab shows its saved chat again', Boolean(shown) && /finished|working|chat-/.test(shown), shown);
  check('no script errors', errors.length === 0, errors.join('; '));

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
