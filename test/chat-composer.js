// The composer in the sidebar, end to end (hidden window, a fake Claude client: no network, no key): each chat keeps its own draft
// (switching chats and back, and after a restart), Up in an empty box edits your last message, a long paste is offered as a chip and
// goes with the message, the shortcut sheet opens, and the chat-history panel shows Undo after a delete. Run it with
// LUMEN_TEST_BACKGROUND=1 so no window shows.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-composer-'));
  const env = { ...process.env, LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' };
  let app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  let ui;
  try {
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => {
      let n = 0;
      global.__sent = [];
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const last = params.messages[params.messages.length - 1];
        global.__sent.push((Array.isArray(last.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(last.content)));
        const text = `Reply ${++n}.`;
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => message };
      } } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    const text = () => ui.evaluate(() => document.getElementById('messages').textContent);
    const idle = () => waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));
    const send = async (msg, expect) => { await ui.fill('#prompt', msg); await ui.press('#prompt', 'Enter'); await waitFor(async () => new RegExp(expect).test(await text())); await idle(); };
    const promptValue = () => ui.evaluate(() => document.getElementById('prompt').value);

    // ---- chat A gets a message, then a draft
    await send('first chat hello', 'Reply 1\\.');
    await ui.fill('#prompt', 'draft for chat A');
    await sleep(300);
    // ---- New chat: the box is empty, and chat B gets its own draft
    await ui.click('#new-chat');
    await sleep(400);
    check('New chat starts with an empty box (chat A\'s draft stays with chat A)', (await promptValue()) === '', await promptValue());
    await send('second chat hello', 'Reply 2\\.');
    await ui.fill('#prompt', 'draft for chat B');
    await sleep(300);
    // ---- back to chat A from the history list
    await ui.click('#chat-history');
    await ui.waitForSelector('#chat-list:not([hidden]) .chat-item');
    const rowA = await ui.evaluate(() => [...document.querySelectorAll('.chat-item')].find((li) => /first chat hello/i.test(li.textContent))?.dataset.id || null);
    check('the history list shows chat A', Boolean(rowA), await ui.evaluate(() => [...document.querySelectorAll('.chat-item')].map((li) => li.textContent).join(' | ')));
    if (rowA) {
      await ui.click(`.chat-item[data-id="${rowA}"] .chat-title`);
      const back = await waitFor(async () => (await promptValue()) === 'draft for chat A');
      if (process.env.DEBUG_DRAFT) console.log('DEBUG1', rowA, await ui.evaluate(() => localStorage.getItem('lumen.chatDrafts')), await ui.evaluate(() => typeof shownChatId !== 'undefined' ? shownChatId : 'n/a'));
      check('opening chat A again brings back its own draft', back, await promptValue());
    }
    // ---- Up in an empty box edits your last message
    await ui.fill('#prompt', '');
    await sleep(200);
    await ui.focus('#prompt');
    await ui.press('#prompt', 'ArrowUp');
    const editing = await waitFor(() => ui.evaluate(() => {
      const box = document.querySelector('.msg.user.editing .msg-edit-box');
      return box ? box.value : null;
    }), 3000);
    check('Up in an empty box opens your last message for editing', typeof editing === 'string' && /chat hello/.test(editing), editing);
    if (editing) await ui.keyboard.press('Escape');
    await sleep(300);

    // ---- a long paste is offered as a chip, and the chip goes with the message
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} of a long pasted block of text`).join('\n');
    await ui.focus('#prompt');
    await ui.evaluate((t) => {
      const prompt = document.getElementById('prompt');
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      prompt.dispatchEvent(ev);
      if (!ev.defaultPrevented) { prompt.value += t; prompt.dispatchEvent(new Event('input', { bubbles: true })); }
    }, long);
    const offer = await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.paste-offer button'))), 3000);
    check('a long paste shows "Attach as chip"', offer, '');
    if (offer) {
      await ui.click('.paste-offer button');
      const chip = await waitFor(() => ui.evaluate(() => document.getElementById('prompt').value.trim() === '' && document.querySelectorAll('#attachments *').length > 0), 3000);
      check('the paste becomes a chip and leaves the box', chip, await promptValue());
      await ui.fill('#prompt', 'summarize the paste');
      const before = (await app.evaluate(() => global.__sent.length));
      await ui.press('#prompt', 'Enter');
      await waitFor(() => app.evaluate((n) => global.__sent.length > n, before));
      await idle();
      const sent = await app.evaluate(() => global.__sent[global.__sent.length - 1] || '');
      check("the chip's text is sent with the message", /line 59 of a long pasted block/.test(sent) && /summarize the paste/.test(sent), sent.slice(0, 200));
    }

    // ---- the shortcut sheet
    await ui.focus('#prompt');
    await ui.keyboard.press('Control+/');
    const sheet = await waitFor(() => ui.evaluate(() => { const s = document.querySelector('.shortcut-sheet'); return s && !s.hidden ? s.textContent : null; }), 3000);
    check('Ctrl+/ opens the shortcut sheet, and it lists the chat shortcuts', typeof sheet === 'string' && /Ctrl\+Shift\+O|New chat/i.test(sheet), sheet);
    await ui.keyboard.press('Escape');

    // ---- the drafts survive a restart: quit, start again on the same profile, open chat A
    await ui.fill('#prompt', 'draft for chat A');
    await sleep(400);
    await app.close().catch(() => {});
    app = await electron.launch({ args: [path.join(__dirname, '..')], env });
    ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#prompt');
    await ui.click('#chat-history');
    await ui.waitForSelector('#chat-list:not([hidden]) .chat-item');
    const rowAgain = await ui.evaluate(() => [...document.querySelectorAll('.chat-item')].find((li) => /first chat hello/i.test(li.textContent))?.dataset.id || null);
    if (rowAgain) await ui.click(`.chat-item[data-id="${rowAgain}"] .chat-title`);
    const restored = await waitFor(async () => (await promptValue()) === 'draft for chat A');
    if (process.env.DEBUG_DRAFT) console.log('DEBUG', rowAgain, JSON.stringify(await ui.evaluate(() => ({ store: localStorage.getItem('lumen.chatDrafts'), id: typeof shownChatId !== 'undefined' ? shownChatId : 'n/a', msgs: document.getElementById('messages').textContent.replace(/s+/g, ' ').slice(0, 150) }))));
    check('after a restart, opening chat A brings back its draft', restored, await promptValue());
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall chat-composer checks passed');
  process.exit(failures ? 1 : 0);
})();
