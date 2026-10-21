// The chat list follows the chats' last activity (features/chat-store.js touch, main.js bumpChat, renderer/chat-items.js liveOrder):
// a chat that is sent a message moves to the top of the open list at once, while its reply is still running; opening an older chat
// (and leaving it again) does not reorder anything; a pinned chat stays in the Pinned group. A fake model, invisible windows
// (LUMEN_TEST_BACKGROUND=1), no network.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-recency-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    // The stubbed provider: every reply is "Reply N."; a gate holds a reply back so the run can be seen while it is running.
    await app.evaluate(() => {
      const fake = global.__fake = { n: 0, gate: null, release: null };
      global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
        const text = `Reply ${++fake.n}.`;
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() { if (fake.gate) await fake.gate; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
          finalMessage: async () => message,
        };
      } } } });
    });

    // Five saved chats, oldest first: one..five; "one" is pinned.
    const names = ['one', 'two', 'three', 'four', 'five'];
    const ids = {};
    for (const n of names) {
      ids[n] = await app.evaluate((_e, name) => {
        const store = global.__chats.store();
        const id = store.newId();
        store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: `${name} topic` }] }, { role: 'assistant', content: [{ type: 'text', text: `${name} answer` }] }] });
        return id;
      }, n);
      await sleep(25);
    }
    await app.evaluate((_e, id) => global.__chats.store().setPinned(id, true), ids.one);

    // The full-page chat's list is on screen all the time, so it shows a live change.
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage("document.readyState")) === 'complete' && (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 5, 20000);
    // The list as drawn: headings and titles in order.
    const drawn = async () => (await inPage("[...document.querySelectorAll('#cp-items > li')].map((li) => li.classList.contains('chat-item') ? li.querySelector('.chat-title').textContent.replace(/ topic$/, '') : '# ' + li.textContent.trim())")) || [];
    const unpinned = async () => { const d = await drawn(); return d.filter((x) => !x.startsWith('#')).slice(1); };
    const mouseAway = () => inPage("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
    const open = async (n) => { await inPage(`document.querySelector('#cp-items .chat-item[data-id="${ids[n]}"] .chat-open').click()`); return waitFor(async () => new RegExp(`${n} answer`).test(await inPage("document.getElementById('messages').textContent")), 10000); };
    const send = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    const idle = () => waitFor(() => app.evaluate(() => global.__tabChats.runs().every((r) => !r.live)), 10000);

    let d = await drawn();
    check('start: a Pinned group with "one", then the rest newest first', d[0] === '# Pinned' && d[1] === 'one' && d.filter((x) => !x.startsWith('#')).join() === 'one,five,four,three,two', JSON.stringify(d));

    // 1. Opening older chats, and leaving them again, changes nothing.
    check('opening the third chat works', await open('three'), 'did not open');
    await mouseAway();
    await sleep(300);
    check('opening a chat does not reorder the list', (await unpinned()).join() === 'five,four,three,two', JSON.stringify(await drawn()));
    check('opening an older chat (and leaving the one before it) does not reorder either', await open('two') && (await unpinned()).join() === 'five,four,three,two', JSON.stringify(await drawn()));
    check('...the chats were not stamped as used', await app.evaluate((_e, id) => global.__chats.store().list().find((c) => c.id === id).updated, ids.three) < await app.evaluate((_e, id) => global.__chats.store().list().find((c) => c.id === id).updated, ids.four), 'three newer than four');

    // 2. Send in the third chat: it moves to the top of the open list while its reply is still running.
    check('back to the third chat', await open('three'), 'did not open');
    await mouseAway();
    await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
    await send('keep going on three');
    check('the reply is running', await waitFor(() => app.evaluate(() => global.__tabChats.runs().some((r) => r.live))), 'not running');
    check('the sent-in chat moves to the top of the list, live, while it runs', await waitFor(async () => (await unpinned()).join() === 'three,five,four,two', 5000), JSON.stringify(await drawn()));
    check('the pinned chat stays in the Pinned group above it', (await drawn())[0] === '# Pinned' && (await drawn())[1] === 'one', JSON.stringify(await drawn()));
    await app.evaluate(() => global.__fake.release());
    await idle();
    check('after the reply it is still at the top', await waitFor(async () => (await unpinned()).join() === 'three,five,four,two', 5000), JSON.stringify(await drawn()));

    // 3. Opening an older chat afterwards still changes nothing.
    await open('four');
    await mouseAway();
    await sleep(300);
    check('opening an older chat after that leaves the order alone', (await unpinned()).join() === 'three,five,four,two', JSON.stringify(await drawn()));

    // 4. A message in the pinned chat keeps it pinned (and does not move the others).
    await open('one');
    await mouseAway();
    await app.evaluate(() => { global.__fake.gate = null; });
    await send('and a word on one');
    await waitFor(async () => /Reply \d+\./.test(await inPage("document.getElementById('messages').textContent")) && (await inPage("document.getElementById('messages').textContent")).includes('and a word on one'));
    await idle();
    await sleep(300);
    d = await drawn();
    check('a message in the pinned chat keeps it in the Pinned group', d[0] === '# Pinned' && d[1] === 'one' && d.indexOf('# Pinned') === 0, JSON.stringify(d));
    check('...and the other chats keep their order', (await unpinned()).join() === 'three,five,four,two', JSON.stringify(d));
    check('...and it is still pinned in the saved list', await app.evaluate((_e, id) => global.__chats.store().list().find((c) => c.id === id).pinned === true, ids.one), 'unpinned');

    check('no page errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
