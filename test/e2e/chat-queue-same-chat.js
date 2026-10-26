/* global shownChatId, running, line -- chat-core.js globals, read inside ui.evaluate() */
// A message typed while a chat's reply runs belongs to THAT chat: it waits (queued bubble) and goes into the same chat when the reply ends,
// whatever the sidebar showed meanwhile (the AI or the user switched to another tab, whose chat is a new empty one). Never a new chat.
// Hidden window, throwaway profile, fake Claude client (no network, no key).
// Run under the lock:  node scripts/test/e2e-lock.js run --owner chat-queue-same-chat -- node test/e2e/chat-queue-same-chat.js
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
  const root = path.join(__dirname, '..', '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chat-queue-same-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('oneChatPerTab', true); global.__settings.backend.set('aiStayOnMyTab', false); });
    const ui = await app.firstWindow({ timeout: 90000 });
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');

    // Fake Claude: "hold" streams a word, then waits until global.__release(); "early" waits BEFORE the first word (the chat is not named yet in the
    // view); the rest answer at once. Every request is recorded with the chat open in main when it started (agent:ask opens the sender's chat first).
    await app.evaluate(() => {
      global.__requests = [];
      let gate; const reset = () => { global.__gateP = new Promise((r) => { gate = r; }); };
      reset();
      global.__release = () => { gate(); reset(); };
      const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' '));
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const last = textOf(params.messages[params.messages.length - 1]);
        global.__requests.push({ last, chat: global.__tabChats.chatId(), user: last.replace(/<browser_state>[\s\S]*?<\/browser_state>/, '').trim().slice(0, 40) });
        const hold = /\bhold\b/.test(last);
        const early = /\bearly\b/.test(last);
        const gateP = global.__gateP;
        // "swap": the run's own switch_tab tool call (the AI moves the front tab to global.__swapTo) once it is let go; its next turn answers.
        const swap = /swap hold/.test(textOf(params.messages[0])) && !params.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
        const text = hold || swap ? 'Working on it' : `Answered: ${last.replace(/\s+/g, ' ').slice(-60)}`;
        global.__requests[global.__requests.length - 1].swap = swap; global.__requests[global.__requests.length - 1].n = params.messages.length;
        const content = [{ type: 'text', text }];
        if (swap) content.push({ type: 'tool_use', id: 'tu-swap', name: 'switch_tab', input: { tab_id: global.__swapTo, show: true } });
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: swap ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 10, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() {
            if (early) await gateP;
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
            if ((hold && !early) || swap) await gateP;
          },
          finalMessage: async () => message,
        };
      } } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await sleep(400);
    await ui.waitForFunction(() => window.chatQueue);
    const running = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
    const idle = (ms = 15000) => waitFor(async () => !(await running()), ms);
    const requests = () => app.evaluate(() => global.__requests.slice());
    const type = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const bubbles = () => ui.evaluate(() => [...document.querySelectorAll('#messages > .queued-bubble')].map((b) => b.firstChild?.textContent));
    const sidebarText = () => ui.evaluate(() => document.getElementById('messages').innerText);
    const box = () => ui.evaluate(() => document.getElementById('prompt').value);
    const openTab = (url) => app.evaluate((_e, u) => { const id = global.__agent.browser.openTab(u).id; global.__tabChats.setSidebar(id, true); return id; }, url);
    const showTab = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
    const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
    const chatOfTab = (id) => app.evaluate((_e, i) => global.__tabChats.bindings.chatOf(i), id);
    const release = () => app.evaluate(() => global.__release());
    const requestOf = async (needle) => (await requests()).find((r) => r.last.includes(needle));
    const settle = () => waitFor(() => app.evaluate(() => global.__tabChats.shown() === global.__tabChats.chatId()));

    // ---- A. a reply runs in chat A (named); a message is queued; the front tab changes to a tab with its own new empty chat; the reply ends
    const tabA = await active();
    await type('hold alpha');
    await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.msg.assistant')].some((m) => /Working on it/.test(m.textContent))));
    const chatA = await chatOfTab(tabA);
    await type('queued for alpha');
    await waitFor(async () => (await bubbles()).length === 1);
    const tabB = await openTab('about:blank');
    await waitFor(async () => (await active()) === tabB);
    await settle();
    await sleep(600);
    const chatB = await chatOfTab(tabB);
    console.log('INFO  A: chatA', chatA, 'chatB', chatB, 'sidebar shows', JSON.stringify((await sidebarText()).slice(0, 60)));
    await release();
    await sleep(2500);
    let hit = await requestOf('queued for alpha');
    check('A: the queued message is not sent into the other tab\'s new chat', !hit || hit.chat === chatA, JSON.stringify({ hit, chatA, chatB, reqs: await requests() }));
    await showTab(tabA);
    await waitFor(async () => /alpha/.test(await sidebarText()));
    await sleep(1500);
    await idle();
    hit = await requestOf('queued for alpha');
    const kept = hit ? hit.chat === chatA : /queued for alpha/.test(await box()) || /queued for alpha/.test(await sidebarText());
    check('A: back in chat A the message went there (sent into it, or waits in its box), never elsewhere', kept, JSON.stringify({ hit, chatA, box: await box(), reqs: await requests() }));

    // ---- B. a message typed before the first event named the chat, then the sidebar follows to another tab's new empty chat
    await showTab(tabB);
    await settle();
    await sleep(500);
    await ui.click('#new-chat');
    await settle();
    await type('early beta'); // (held before its first word: the view has not named this chat)
    await waitFor(() => running());
    await type('queued for beta');
    await waitFor(async () => (await bubbles()).length === 1);
    const st = () => ui.evaluate(() => JSON.stringify({ shown: shownChatId, running, line: line.list.map((q) => [q.text, q.chatId]) }));
    console.log('INFO  B: state before tab', await st());
    const chatBeta = await chatOfTab(tabB);
    const tabC = await openTab('about:blank');
    await waitFor(async () => (await active()) === tabC);
    await settle();
    await sleep(600);
    const chatC = await chatOfTab(tabC);
    console.log('INFO  B: state after tab', await st());
    console.log('INFO  B: chatBeta', chatBeta, 'chatC', chatC, 'sidebar shows', JSON.stringify((await sidebarText()).slice(0, 60)), 'running', await running());
    await release();
    await sleep(2500);
    console.log('INFO  B: after release: requests', JSON.stringify((await requests()).map((r) => [r.chat, r.user])), 'box', JSON.stringify(await box()), 'bubbles', JSON.stringify(await bubbles()), 'sidebar', JSON.stringify((await sidebarText()).slice(0, 80)));
    hit = await requestOf('queued for beta');
    check('B: the message typed before the chat was named is not sent into the other tab\'s new chat', !hit || hit.chat === chatBeta, JSON.stringify({ hit, chatBeta, chatC, reqs: await requests() }));
    // ---- C. the AI's own switch_tab moves the front tab (the sidebar does not follow a run's own tool call) to a tab that has a chat of its own; the
    // message typed meanwhile must still go into the chat it was typed in when the reply ends, not into the front tab's chat.
    await showTab(tabA);
    await waitFor(async () => /alpha/.test(await sidebarText()));
    await settle();
    await ui.click('#new-chat');
    await settle();
    const tabD = await openTab('about:blank'); // its own new empty chat (One chat per tab)
    await waitFor(async () => (await active()) === tabD);
    await settle();
    const tabE = await active();
    await type('plain delta'); // (tab D's chat has history of its own now)
    await waitFor(async () => /Answered: .*delta/.test(await sidebarText()));
    await idle();
    await showTab(tabB); // (the tab the run starts in)
    await waitFor(async () => (await active()) === tabB);
    await settle();
    await ui.click('#new-chat');
    await settle();
    await app.evaluate((_e, t) => { global.__swapTo = t; }, tabD);
    await type('swap hold gamma, go to the other tab');
    await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.msg.assistant')].some((m) => /Working on it/.test(m.textContent))));
    const chatGamma = await chatOfTab(tabB);
    const chatD = await chatOfTab(tabD);
    await type('queued for gamma');
    console.log('INFO  C: line', await ui.evaluate(() => JSON.stringify({ shown: shownChatId, line: line.list.map((q) => [q.text, q.chatId]) })));
    await waitFor(async () => (await bubbles()).length === 1);
    // (the AI was asked to go to another tab: its own switch_tab does not move the sidebar)
    await release();
    await waitFor(async () => (await active()) === tabD, 8000);
    await sleep(800);
    console.log('INFO  C: tabs', tabA, tabB, tabD, tabE, JSON.stringify(await app.evaluate(() => global.__requests.length)));
    console.log('INFO  C: chatGamma', chatGamma, 'chatD', chatD, 'front', await active(), 'sidebar shows', JSON.stringify((await sidebarText()).slice(0, 80)), 'bubbles', JSON.stringify(await bubbles()));
    await waitFor(async () => (await requests()).length >= 5 || (await requestOf('queued for gamma')), 8000);
    await sleep(2500);
    hit = await requestOf('queued for gamma');
    console.log('INFO  C: transcript', JSON.stringify(await app.evaluate(() => global.__agent.transcript().slice(-6))).slice(0, 1500));
    console.log('INFO  C: requests', JSON.stringify((await requests()).map((r) => [r.chat, r.user, r.swap, r.n])));
    check('C: the message queued in chat gamma was sent into chat gamma (or kept for it), not the front tab\'s chat', !hit || hit.chat === chatGamma, JSON.stringify({ hit, chatGamma, chatD, tabE }));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
