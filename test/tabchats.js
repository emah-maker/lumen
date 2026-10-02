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

  // (The sidebar is open or closed tab by tab, and a new tab starts closed: these tabs are used through their sidebar, so they open it.)
  const openTab = (url) => app.evaluate((_e, u) => { const id = global.__agent.browser.openTab(u).id; global.__tabChats.setSidebar(id, true); return id; }, url);
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
  // (The sidebar redraws a moment after the main side switches chats, so wait for it to settle, then make sure it stays empty.)
  const emptyNow = async () => (await bubbles()).length === 0 && !/is working/.test(await messagesText());
  const settled = await waitFor(emptyNow, 4000);
  await sleep(400);
  check('a new tab starts with its own empty chat', Boolean(settled) && (await emptyNow()), await messagesText());
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
  await waitFor(async () => { const t = await messagesText(); return /chat-A/.test(t) && !/chat-B/.test(t); });
  let text = await messagesText();
  check('switching to tab A shows chat A, still working, not chat B', /chat-A/.test(text) && !/chat-B/.test(text), text);
  check('its streamed words are there too, not only a spinner', await waitFor(async () => /A is working/.test(await messagesText())), await messagesText());
  check('chat A shows as running in the sidebar', await ui.evaluate(() => document.body.classList.contains('agent-active')), 'not running');
  await showTab(tabB);
  await waitFor(async () => { const t = await messagesText(); return /chat-B/.test(t) && !/chat-A/.test(t); });
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

  // ---- 4b. The cap is a setting: raising it starts waiting chats at once; a waiting chat can be stopped from the list.
  await app.evaluate(() => global.__patchSettings({ maxChatRuns: 1 }));
  const tG = await openTab(`${base}/g`); await waitFor(async () => (await active()) === tG); await send('chat-G: go'); await inflight('G');
  const tH = await openTab(`${base}/h`); await waitFor(async () => (await active()) === tH); await send('chat-H: go');
  await waitFor(() => tc(() => global.__tabChats.runs().some((r) => r.queued)));
  check('with the cap at one the second chat waits', (await mark(tH)) === 'waiting' && !(await tc(() => global.__inflight.has('H'))), await mark(tH));
  check('the waiting mark has its own glyph (a ring), not just another colour', await waitFor(() => ui.evaluate((i) => { const el = document.querySelector(`#tabs .tab[data-id="${i}"] .tab-chat-mark`); return el?.classList.contains('waiting') && el.querySelector('svg circle') && !el.querySelector('.cm-spin') && el.getBoundingClientRect().width >= 12; }, tH)), 'no glyph');
  const gMark = await ui.evaluate((i) => { const el = document.querySelector(`#tabs .tab[data-id="${i}"] .tab-chat-mark`); const r = el.getBoundingClientRect(); const fav = document.querySelector(`#tabs .tab[data-id="${i}"] .tab-favicon`).getBoundingClientRect(); return { spin: Boolean(el.querySelector('.cm-spin')), clear: r.left >= fav.right - 1 }; }, tG);
  check('the working mark is a spinner on the title side of the icon, not over it', gMark.spin && gMark.clear, JSON.stringify(gMark));
  await app.evaluate(() => global.__patchSettings({ maxChatRuns: 3 }));
  check('raising the cap in Settings starts the waiting chat right away', Boolean(await inflight('H')) && (await mark(tH)) === 'running', await mark(tH));
  await tc(() => { global.__release('G'); global.__release('H'); });
  await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000);
  await app.evaluate(() => global.__patchSettings({ maxChatRuns: 1 }));
  const tI = await openTab(`${base}/i`); await waitFor(async () => (await active()) === tI); await send('chat-I: go'); await inflight('I');
  const tJ = await openTab(`${base}/j`); await waitFor(async () => (await active()) === tJ); await send('chat-J: go');
  await waitFor(() => tc(() => global.__tabChats.runs().some((r) => r.queued)));
  await showTab(tI); await waitFor(async () => (await active()) === tI);
  const listW = await ui.evaluate(() => window.assistant.chats.list());
  const waiting = listW.chats.find((c) => c.title.includes('chat-J'));
  check('the list marks the waiting chat', waiting?.badge === 'queued', JSON.stringify(waiting));
  await ui.evaluate(() => document.getElementById('chat-history').click());
  await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.chat-stop-wait'))));
  const rowText = await ui.evaluate(() => [...document.querySelectorAll('.chat-item')].map((li) => li.innerText.replace(/\s+/g, ' ')));
  check('the chat list says "This tab" for the chat of the tab in front and "In tab" for the others', rowText.some((t) => /chat-I/.test(t) && /This tab/.test(t)) && rowText.some((t) => /chat-J/.test(t) && /In tab:/.test(t)), JSON.stringify(rowText));
  const contrast = await ui.evaluate(() => { const px = (css) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.fillStyle = css; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); }; const el = document.querySelector('.chat-place:not(.here)'); let bgEl = el.closest('.chat-item'); let bg = null; while (bgEl && !bg) { const b = getComputedStyle(bgEl).backgroundColor; if (b && !/rgba\(.*, 0\)|transparent/.test(b)) bg = b; bgEl = bgEl.parentElement; } const lum = (a) => a.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, k) => s + v * [0.2126, 0.7152, 0.0722][k], 0); const l1 = lum(px(getComputedStyle(el).color)), l2 = lum(px(bg || getComputedStyle(document.body).backgroundColor)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); });
  check('the "In tab" text has at least AA contrast for small text on the light surface', contrast >= 4.5, contrast);
  await ui.evaluate(() => document.querySelector('.chat-stop-wait').click());
  await waitFor(() => tc(() => !global.__tabChats.runs().some((r) => r.queued)));
  check('"Stop waiting" takes a waiting chat out of the line (it was not the open chat)', !(await tc(() => global.__inflight.has('J'))) && (await mark(tJ)) !== 'waiting', await mark(tJ));
  await ui.evaluate(() => document.getElementById('chat-history').click());
  await tc(() => global.__release('I'));
  await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000);
  await app.evaluate(() => global.__patchSettings({ maxChatRuns: 3 }));

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

  // ---- 5b. One chat in two tabs ("Also show in this tab"): the chat has one home tab where its run works; both tabs
  // show the same messages and marks; a new chat in either tab only unbinds that tab; Stop works from either tab.
  const chatIdOf = async (who) => (await ui.evaluate(() => window.assistant.chats.list())).chats.find((c) => c.title.includes(`chat-${who}`))?.id;
  const bindings = (id) => tc((_e, i) => ({ tabs: global.__tabChats.bindings.tabsOf(i), home: global.__tabChats.bindings.homeOf(i) }), id);
  const tabCount = () => tc(() => global.__windows.list()[0].tabs.length);
  const runOf = () => tc(() => global.__tabChats.runs().find((r) => r.live));
  const clickShare = async (id) => {
    await ui.evaluate(() => document.getElementById('chat-history').click());
    await waitFor(() => ui.evaluate((i) => Boolean(document.querySelector(`.chat-item[data-id="${i}"] .chat-act-share`)), id));
    await ui.evaluate((i) => document.querySelector(`.chat-item[data-id="${i}"] .chat-act-share`).click(), id);
    await waitFor(async () => (await bindings(id)).tabs.length >= 2);
  };
  // A chat working in tab 1 (its home), then shown in tab 2 from the chat list; tab 2 is in front.
  const sharedChat = async (who) => {
    const t1 = await openTab(`${base}/${who.toLowerCase()}1`); await waitFor(async () => (await active()) === t1);
    await send(`chat-${who}: go`); await inflight(who);
    const t2 = await openTab(`${base}/${who.toLowerCase()}2`); await waitFor(async () => (await active()) === t2);
    const id = await chatIdOf(who);
    await clickShare(id);
    await waitFor(async () => new RegExp(`${who} is working`).test(await messagesText()));
    return { t1, t2, id };
  };
  const finish = async (who) => { await tc((_e, w) => global.__release(w), who); await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000); };

  // S: marks, tools on the home tab, the list line, where a click goes, a message from the other tab.
  const S = await sharedChat('S');
  let st = await bindings(S.id);
  check('Also show in this tab: the chat is in both tabs, and the first tab stays its home', JSON.stringify(st.tabs) === JSON.stringify([S.t1, S.t2]) && st.home === S.t1, JSON.stringify(st));
  check('the second tab shows the same chat, with its live words', /chat-S/.test(await messagesText()) && /S is working/.test(await messagesText()), await messagesText());
  const runS = await runOf('S');
  check('its run keeps working in the home tab, not the tab it is viewed in', runS?.tab === S.t1, JSON.stringify(runS));
  check('both tabs carry the working mark', (await mark(S.t1)) === 'running' && (await mark(S.t2)) === 'running' && await waitFor(async () => (await stripMark(S.t1)) === 'running' && (await stripMark(S.t2)) === 'running'), `${await mark(S.t1)} ${await mark(S.t2)}`);
  const listS = (await ui.evaluate(() => window.assistant.chats.list())).chats.find((c) => c.id === S.id);
  check('the list says it is in 2 tabs and which is home', listS.tabs?.length === 2 && listS.tabs.find((x) => x.home)?.id === S.t1 && listS.tabs.find((x) => x.here)?.id === S.t2, JSON.stringify(listS.tabs));
  await ui.evaluate(() => document.getElementById('chat-history').click());
  const rowS = await waitFor(() => ui.evaluate((i) => document.querySelector(`.chat-item[data-id="${i}"] .chat-place`)?.textContent || '', S.id));
  check('the row reads "In 2 tabs: ... (home), This tab"', /^In 2 tabs: .*\(home\), This tab/.test(rowS), rowS);
  await ui.evaluate(() => document.getElementById('chat-history').click());
  await showTab(S.t1);
  await waitFor(async () => /S is working/.test(await messagesText()));
  check('the home tab shows it too', /chat-S/.test(await messagesText()) && /S is working/.test(await messagesText()), await messagesText());
  check('coming to the front does not change the home', (await bindings(S.id)).home === S.t1, JSON.stringify(await bindings(S.id)));
  const neutral = await openTab(`${base}/neutral`); await waitFor(async () => (await active()) === neutral);
  await finish('S');
  check('its tool read the home tab (not the tab it was shown in)', (await tc(() => global.__seen.S)) === 'S1', await tc(() => global.__seen.S));
  check('finished while neither tab was in front: both tabs say done', await waitFor(async () => (await mark(S.t1)) === 'done' && (await mark(S.t2)) === 'done') && await waitFor(async () => (await stripMark(S.t1)) === 'done' && (await stripMark(S.t2)) === 'done'), `${await mark(S.t1)} ${await mark(S.t2)}`);
  await ui.evaluate((id) => window.assistant.chats.showTab(id), S.id);
  check('a click on a shared chat from a tab that does not show it goes to the home tab', await waitFor(async () => (await active()) === S.t1), await active());
  await ui.evaluate((id) => window.assistant.chats.showTab(id), S.id);
  check('... from the home tab it goes to the other tab', await waitFor(async () => (await active()) === S.t2), await active());
  await ui.evaluate((id) => window.assistant.chats.showTab(id), S.id);
  check('... and from the other tab back to the home', await waitFor(async () => (await active()) === S.t1), await active());
  await waitFor(async () => /S finished/.test(await messagesText()));
  check('both tabs show the finished reply', /S finished/.test(await messagesText()), await messagesText());
  await showTab(S.t2);
  await waitFor(async () => /S finished/.test(await messagesText()));
  check('... the other tab too', /S finished/.test(await messagesText()) && /chat-S/.test(await messagesText()), await messagesText());
  await send('chat-S: once more');
  await waitFor(async () => (await bubbles()).some((b) => /once more/.test(b)) && (await messagesText()).split('S finished').length > 2);
  check('any tab can send a message: it answers in this tab', (await bubbles()).some((b) => /once more/.test(b)), await messagesText());
  await waitFor(() => tc(() => global.__tabChats.runs().length === 0));
  check('a message sent from the other tab of an idle chat starts there, and that tab is now its home', (await bindings(S.id)).home === S.t2 && (await bindings(S.id)).tabs.length === 2, JSON.stringify(await bindings(S.id)));
  await showTab(S.t1);
  await waitFor(async () => (await bubbles()).some((b) => /once more/.test(b)));
  check('the first tab shows the new message and reply too', (await bubbles()).some((b) => /once more/.test(b)), await messagesText());

  // T: Stop from the tab that only shows the chat. U: Stop from the home tab.
  const clickStop = async () => { await ui.waitForSelector('#send.stop'); await ui.click('#send'); };
  const T = await sharedChat('T');
  await clickStop();
  await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 6000) || await tc(() => global.__release('T'));
  check('Stop in the tab that only shows the chat ends the run', await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000), JSON.stringify(await tc(() => global.__tabChats.runs())));
  check('... and says stopped, with no working mark left on either tab', (await ui.evaluate(() => Boolean(document.querySelector('.notice.stopped')))) && (await mark(T.t1)) !== 'running' && (await mark(T.t2)) !== 'running', `${await mark(T.t1)} ${await mark(T.t2)}`);
  const U = await sharedChat('U');
  await showTab(U.t1);
  await waitFor(async () => /U is working/.test(await messagesText()));
  await clickStop();
  await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 6000) || await tc(() => global.__release('U'));
  check('Stop in the home tab ends the run', await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000), JSON.stringify(await tc(() => global.__tabChats.runs())));
  await showTab(U.t2);
  await waitFor(async () => /chat-U/.test(await messagesText()));
  check('... and the other tab shows it stopped as well', await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.notice.stopped')))), await messagesText());

  // V: a new chat in the tab that only shows it. W: a new chat in the home tab. The other tab keeps the chat and its work.
  const V = await sharedChat('V');
  await ui.click('#new-chat');
  await waitFor(async () => (await bindings(V.id)).tabs.length === 1);
  st = await bindings(V.id);
  check('new chat in the viewing tab: only that tab leaves the chat', JSON.stringify(st.tabs) === JSON.stringify([V.t1]) && st.home === V.t1 && (await tc((_e, t) => global.__tabChats.bindings.chatOf(t), V.t2)) !== V.id, JSON.stringify(st));
  check('... the chat keeps working in its tab', (await runOf('V'))?.tab === V.t1 && (await mark(V.t1)) === 'running', JSON.stringify(await runOf('V')));
  check('... the tab with the new chat has an empty sidebar and no working mark', (await bubbles()).length === 0 && (await mark(V.t2)) !== 'running', await messagesText());
  await showTab(V.t1);
  await waitFor(async () => /V is working/.test(await messagesText()));
  check('the other tab still shows the old chat, working', /chat-V/.test(await messagesText()) && /V is working/.test(await messagesText()), await messagesText());
  await finish('V');
  const W = await sharedChat('W');
  await showTab(W.t1);
  await waitFor(async () => /W is working/.test(await messagesText()));
  await ui.click('#new-chat');
  await waitFor(async () => (await tc((_e, t) => global.__tabChats.bindings.chatOf(t), W.t1)) !== W.id);
  st = await bindings(W.id);
  check('new chat in the home tab: the other tab keeps showing the chat', JSON.stringify(st.tabs) === JSON.stringify([W.t2]), JSON.stringify(st));
  check('... and the run goes on, in the tab it works in', (await runOf('W'))?.tab === W.t1 && (await mark(W.t2)) === 'running', JSON.stringify(await runOf('W')));
  await showTab(W.t2);
  await waitFor(async () => /W is working/.test(await messagesText()));
  check('... the other tab shows it working', /chat-W/.test(await messagesText()), await messagesText());
  await finish('W');
  await waitFor(async () => /W finished/.test(await messagesText()));
  check('... and receives the reply', /W finished/.test(await messagesText()), await messagesText());

  // Y: closing the tab that only shows a working chat. Z: closing its home tab.
  const Y = await sharedChat('Y');
  const countY = await tabCount();
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), Y.t2);
  await waitFor(async () => (await tabCount()) < countY);
  await sleep(500);
  st = await bindings(Y.id);
  check('closing a tab that only shows the chat just unbinds it (no new tab, the run is untouched)', (await tabCount()) === countY - 1 && JSON.stringify(st.tabs) === JSON.stringify([Y.t1]) && (await runOf('Y'))?.tab === Y.t1, JSON.stringify({ st, count: await tabCount(), countY, run: await runOf('Y') }));
  await finish('Y');
  const Z = await sharedChat('Z');
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), Z.t1);
  const moved2 = await waitFor(() => tc((_e, [a, b]) => { const r = global.__tabChats.runs().find((x) => x.live); return r && r.tab != null && r.tab !== a ? r : null; }, [Z.t1]));
  st = await bindings(Z.id);
  check('closing the home tab of a working chat keeps it going in a background tab', Boolean(moved2) && moved2.tab !== Z.t2 && moved2.tab !== Z.t1, JSON.stringify(moved2));
  check('... the other tab still shows the chat, and the background tab is its new home', st.tabs.includes(Z.t2) && st.home === moved2?.tab, JSON.stringify(st));
  await finish('Z');

  // P: a finished chat in two tabs comes back in two tabs after a restart (checked in step 8).
  const P = await sharedChat('P');
  await finish('P');

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
  // The chat is shown in a tab of the first window too: that window's sidebar follows the run live as well.
  const idM = await chatIdOf('M');
  await ui.evaluate(() => document.getElementById('chat-history').click());
  await waitFor(() => ui.evaluate((i) => Boolean(document.querySelector(`.chat-item[data-id="${i}"] .chat-act-share`)), idM));
  await ui.evaluate((i) => document.querySelector(`.chat-item[data-id="${i}"] .chat-act-share`).click(), idM);
  await waitFor(async () => (await bindings(idM)).tabs.length >= 2);
  await waitFor(async () => /M is working/.test(await messagesText()));
  const homeAfterShare = await bindings(idM);
  check('a chat working in a tab of another window can be shown here too, and the home stays where the run is', /chat-M/.test(await messagesText()) && homeAfterShare.home === mover, JSON.stringify(homeAfterShare));
  await tc(() => global.__release('M'));
  await waitFor(() => tc(() => global.__seen.M));
  check('its tool read the moved tab, now in the other window', (await tc(() => global.__seen.M)) === 'MOVEME', await tc(() => global.__seen.M));
  await waitFor(async () => /M finished/.test(await text2()));
  check('its reply streams into the new window sidebar', /M finished/.test(await text2()), await text2());
  check('... and into the first window\'s sidebar, which shows the same chat', await waitFor(async () => /M finished/.test(await messagesText())), await messagesText());

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
  // (The sidebar may come back closed: it draws a chat only while open, so it is opened as at the start.)
  if (await ui.evaluate(() => document.body.classList.contains('sidebar-hidden'))) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  const restored = await tc(() => ({ entries: global.__tabChats.bindings.entries(), runs: global.__tabChats.runs(), tabs: global.__windows.list()[0].tabs.length, active: global.__windows.list()[0].activeId }));
  check('after a restart the tabs are bound to their saved chats again', restored.entries.length >= 1 && restored.entries.every(([, c]) => beforeRestart.saved.includes(c)), JSON.stringify({ restored, wanted }));
  check('after a restart nothing is re-run', restored.runs.length === 0, JSON.stringify(restored.runs));
  const pAfter = await tc((_e, id) => { const b = global.__tabChats.bindings; const home = b.homeOf(id); return { tabs: b.tabsOf(id), home, homeUrl: global.__windows.list().flatMap((w) => w.tabs).find((t) => t.id === home)?.url || '' }; }, P.id);
  check('a chat shown in two tabs comes back in two tabs after a restart', pAfter.tabs.length === 2, JSON.stringify(pAfter));
  check('... with the same tab as its home', /\/p1$/.test(pAfter.homeUrl), JSON.stringify(pAfter));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), restored.entries[0][0]);
  const shown = await waitFor(async () => { const t = (await ui.evaluate(() => document.getElementById('messages').innerText)).trim(); return /finished|working|chat-/.test(t) && t; });
  check('a tab shows its saved chat again', Boolean(shown) && /finished|working|chat-/.test(shown), shown);
  check('no script errors', errors.length === 0, errors.join('; '));

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
