// Saving a chat never stalls the main thread (hidden, STRICT). Two big chats (one of 400 messages of about 2 KB, one of about 300 KB) are
// saved 20 times each, the app switches between them 20 times (the sidebar's chat:open, which saves the chat it leaves and reads the one it
// opens), and a reply streams in meanwhile. A setImmediate probe in the main process runs the whole time: the longest gap between two
// of its turns is the longest the main thread was held by one task. It must stay at or below 20 ms. Never loosen the limit: if this
// fails, a save (or a load) is doing too much in one go (features/chat-store.js slices the work and writes with fs.promises).
// Before this work one save of the 400-message chat held the thread for 14-31 ms.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const LIMIT_MS = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-savestall-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
    timeout: 90000,
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');

    // A fake model that streams a reply of 60 pieces over about 3 s.
    await app.evaluate(() => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
        const text = Array.from({ length: 60 }, (_, i) => `piece ${i} of the streamed reply. `).join('');
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() { for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 50)); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `piece ${i} of the streamed reply. ` } }; } },
          finalMessage: async () => message,
        };
      } } } });
    });

    // Two big chats, written straight into the app's chat store before the probe starts.
    const ids = await app.evaluate(() => {
      const store = global.__chats.store();
      const words = (n, tag) => `${tag} ${'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. '.repeat(Math.ceil(n / 80))}`.slice(0, n);
      const make = (count, size, tag) => ({ settings: { model: 'claude-opus-5' }, messages: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: words(size, `${tag}${i}`) }] })) });
      const a = store.newId();
      const b = store.newId();
      store.save(a, make(400, 2048, 'A'));
      store.save(b, make(150, 2048, 'B')); // about 300 KB
      const c = store.newId();
      store.save(c, make(4, 300, 'C')); // a small chat for the reply to stream into
      global.__smallId = c;
      store.setCurrent(a);
      global.__snapA = store.load(a); // (read now: the probe must only see what saving costs)
      return { a, b };
    });
    await ui.evaluate((id) => window.assistant.chats.open(id), ids.a);
    await waitFor(() => app.evaluate((_e, id) => global.__chats.id() === id, ids.a));

    // One reply first, outside the measurement: the first run of a fresh process loads and compiles a lot of code (that is start-up, not saving).
    const small = await app.evaluate(() => global.__smallId);
    await ui.evaluate((id) => window.assistant.chats.open(id), small);
    await waitFor(() => app.evaluate((_e, id) => global.__chats.id() === id, small), 5000);
    await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
    await ui.fill('#prompt', 'warm up');
    await ui.press('#prompt', 'Enter');
    check('the warm-up reply finished', Boolean(await waitFor(async () => /piece 59 of the streamed reply/.test(await ui.evaluate(() => document.getElementById('messages').textContent)), 30000)), 'no reply');
    await ui.evaluate((id) => window.assistant.chats.open(id), ids.a);
    await waitFor(() => app.evaluate((_e, id) => global.__chats.id() === id, ids.a), 5000);

    // The probe: setImmediate turns back to back. The gap between two turns is the longest task that held the main thread.
    await app.evaluate(() => {
      const G = global.__gap = { on: false, max: 0, over: [], turns: 0, phase: '' };
      let last = performance.now();
      const turn = () => {
        const n = performance.now();
        if (G.on) { const g = n - last; G.turns++; if (g > G.max) G.max = g; if (g > 20) G.over.push({ ms: Math.round(g), phase: G.phase }); }
        last = n;
        setImmediate(turn);
      };
      setImmediate(turn);
    });
    // The app's own start-up work (the ad blocker parsing its lists, the first windows) holds the thread for hundreds of ms and has nothing
    // to do with saving: measure from the moment the main thread has been quiet for 3 s (no gap over 10 ms).
    await app.evaluate(() => {
      const G = global.__gap;
      G.quietFrom = performance.now();
      let last = performance.now();
      const watch = () => { const n = performance.now(); if (n - last > 10) G.quietFrom = n; last = n; if (!G.on) setImmediate(watch); };
      setImmediate(watch);
    });
    const quiet = await waitFor(() => app.evaluate(() => performance.now() - global.__gap.quietFrom > 3000), 90000);
    check('the app settled after start-up (3 s with no main-thread gap over 10 ms)', Boolean(quiet), 'never quiet');
    const phase = (name) => app.evaluate((_e, n) => { global.__gap.phase = n; }, name);
    const gapNow = () => app.evaluate(() => ({ max: global.__gap.max, over: global.__gap.over, turns: global.__gap.turns }));
    await app.evaluate(() => { global.__gap.on = true; });

    // 1. 20 saves of the 400-message chat (each one changes the last message, so each is a real write).
    await phase('saves');
    await app.evaluate(async (_e, id) => {
      const store = global.__chats.store();
      const snap = global.__snapA;
      for (let i = 0; i < 20; i++) {
        const last = snap.messages[snap.messages.length - 1];
        last.content[0].text += ` edit ${i}`;
        store.saveAsync(id, snap);
        await new Promise((r) => setTimeout(r, 90));
      }
      await store.drain();
    }, ids.a);
    const afterSaves = await gapNow();
    check('20 saves of the 400-message chat: no main-thread gap over 20 ms', afterSaves.over.length === 0, JSON.stringify(afterSaves.over));

    // 2. 20 switches between the two big chats, each leaving a changed chat (so a save) and reading the other.
    await phase('switches');
    for (let i = 0; i < 20; i++) {
      await app.evaluate(() => { const m = global.__agent.messages; const last = m[m.length - 1]; if (last && Array.isArray(last.content) && last.content[0]?.type === 'text') last.content[0].text += ' !'; });
      const target = i % 2 ? ids.a : ids.b;
      await ui.evaluate((id) => window.assistant.chats.open(id), target);
      await waitFor(() => app.evaluate((_e, id) => global.__chats.id() === id, target), 5000);
    }
    const afterSwitches = await gapNow();
    check('20 switches between two big chats: no main-thread gap over 20 ms', afterSwitches.over.length === 0, JSON.stringify(afterSwitches.over));

    // 3. a reply streaming (in a small chat, so that what the agent itself does to start a run over 400 messages is not counted as saving) while
    //    the 400-message chat is saved 20 more times; the streaming chat's own saves (each step, and when the reply is done) are debounced.
    await phase('streaming');
    await ui.evaluate((id) => window.assistant.chats.open(id), small);
    await waitFor(() => app.evaluate((_e, id) => global.__chats.id() === id, small), 5000);
    await app.evaluate((_e, id) => {
      const store = global.__chats.store();
      const snap = global.__snapA;
      global.__savesDuringReply = (async () => {
        for (let i = 0; i < 20; i++) { snap.messages[snap.messages.length - 1].content[0].text += ` more ${i}`; store.saveAsync(id, snap); await new Promise((r) => setTimeout(r, 150)); }
      })();
    }, ids.a);
    await ui.fill('#prompt', 'say something long');
    await ui.press('#prompt', 'Enter');
    check('the streamed reply finished', Boolean(await waitFor(async () => (await ui.evaluate(() => document.getElementById('messages').textContent)).split('piece 59 of the streamed reply').length > 2, 30000)), 'no reply');
    await app.evaluate(async () => { await global.__savesDuringReply; await global.__chats.store().drain(); });
    const total = await gapNow();
    check('... while a reply streams in and the big chat is saved: no main-thread gap over 20 ms', total.over.length === 0, JSON.stringify(total.over));
    check(`the longest gap of the whole run is at most ${LIMIT_MS} ms (${Math.round(total.max)} ms, ${total.turns} turns)`, total.max <= LIMIT_MS && total.turns > 100, `${total.max} ms over ${total.turns} turns`);

    // What was saved is whole and complete: no temp file left, the index and both chats read back, the new reply is in the chat.
    await app.evaluate(() => { global.__gap.on = false; });
    const dir = path.join(profile, 'chats');
    check('no temp file is left in the chats folder', !fs.readdirSync(dir).some((n) => n.includes('.tmp')), fs.readdirSync(dir).join(','));
    const readBack = await app.evaluate((_e, id) => {
      const store = global.__chats.store();
      const snap = store.load(id);
      return { count: snap?.messages?.length, lastEdit: JSON.stringify(snap.messages.at(-1)).includes('more 19'), listed: store.list().map((c) => c.id) };
    }, ids.a);
    check('the 400-message chat is on disk with its last edit', readBack.count === 400 && readBack.lastEdit, JSON.stringify(readBack));
    const streamed = await app.evaluate((_e, id) => ({ hasReply: JSON.stringify(global.__chats.store().load(id)).split('piece 59 of the streamed reply').length > 2 }), small); // (the warm-up reply and this one)
    check('the streamed reply is in the chat it streamed into', streamed.hasReply, JSON.stringify(streamed));
    check('both big chats are listed', readBack.listed.includes(ids.a) && readBack.listed.includes(ids.b), JSON.stringify(readBack.listed));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll chat-save-stall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
