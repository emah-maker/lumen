// Message actions and versions in the sidebar (hidden window, a fake Claude client: no network, no key): the model, time and thumbs
// under a reply, Regenerate keeping the earlier answer behind a version switch, Edit on an earlier message, the chosen
// version being the chat that goes on, Continue after Stop, a long message cut short, and a reopened chat keeping its
// thinking (collapsed), the model and the steps. Run it with LUMEN_TEST_BACKGROUND=1 so no window shows.
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-versions-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  // Every reply is "Reply N." after some thinking; "slow" streams a first part and then waits to be stopped.
  await app.evaluate(() => {
    let n = 0;
    global.__slow = false;
    global.__agent.getClient = () => ({ beta: { messages: { stream: (_params, opts) => {
      const text = global.__slow ? 'Partial answer' : `Reply ${++n}.`;
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `pondering ${text}` } };
          yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } };
          if (global.__slow) await new Promise((_, reject) => opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        },
        finalMessage: async () => message,
      };
    } } } });
  });
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  const text = () => ui.evaluate(() => document.getElementById('messages').textContent);
  const send = async (msg, expect) => { await ui.fill('#prompt', msg); await ui.press('#prompt', 'Enter'); await waitFor(async () => new RegExp(expect).test(await text())); await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop'))); };
  const live = () => app.evaluate(() => global.__agent.messages.map((m) => (m.content.find((b) => b.type === 'text')?.text || '').replace(/<browser_state>[\s\S]*?<\/browser_state>\s*/, '').trim()).filter(Boolean));

  // ---- under a reply and your message
  await send('hello there', 'Reply 1\\.');
  const under = await ui.evaluate(() => ({
    strip: Boolean(document.querySelector('.msg.assistant > .reply-meta')),
    model: document.querySelector('.reply-meta .reply-model')?.textContent || '',
    time: Boolean(document.querySelector('.reply-meta time.msg-time')),
    thumbs: document.querySelectorAll('.reply-meta .reply-thumbs .reply-thumb').length,
    copy: Boolean(document.querySelector('.msg-user-actions .msg-copy')),
    edit: Boolean(document.querySelector('.msg-user-actions .msg-edit')),
    userTime: Boolean(document.querySelector('.msg-user-actions time.msg-time')),
  }));
  check('a reply has a strip with its model, the time and two thumbs', under.strip && /Claude/.test(under.model) && under.time && under.thumbs === 2, JSON.stringify(under));
  check('your message has a time, Copy and Edit under it', under.copy && under.edit && under.userTime, JSON.stringify(under));
  await ui.click('.reply-thumb[data-value="up"]');
  check('the thumb is kept in the chat', await waitFor(() => app.evaluate(() => global.__agent.transcript().some((i) => i.feedback === 'up'))), 'not stored');
  check('the thumb shows as pressed', await ui.evaluate(() => document.querySelector('.reply-thumb[data-value="up"]').getAttribute('aria-pressed') === 'true'), 'not pressed');

  // ---- Regenerate keeps the first answer
  await ui.click('.reply-regen');
  await waitFor(async () => /Reply 2\./.test(await text()));
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));
  const versions = () => ui.evaluate(() => [...document.querySelectorAll('.msg-versions .msg-version-count')].map((e) => e.textContent));
  check('the new answer shows 2/2', JSON.stringify(await versions()) === '["2/2"]', JSON.stringify(await versions()));
  check('Reply 1 is no longer on screen', !/Reply 1\./.test(await text()), await text());
  await ui.click('.msg-versions .msg-version-step:first-child');
  await waitFor(async () => /Reply 1\./.test(await text()));
  check('the arrow brings the first answer back', JSON.stringify(await versions()) === '["1/2"]' && !/Reply 2\./.test(await text()), JSON.stringify(await versions()));
  check('and it is the chat that goes on', JSON.stringify(await live()) === JSON.stringify(['hello there', 'Reply 1.']), JSON.stringify(await live()));
  check('the thumb on that answer is still there', await ui.evaluate(() => document.querySelector('.reply-thumb[data-value="up"]')?.getAttribute('aria-pressed') === 'true'), 'lost');

  // ---- going on from the chosen version, then editing the first message
  await send('and then?', 'Reply 3\\.');
  check('the chat went on from the first answer', JSON.stringify(await live()) === JSON.stringify(['hello there', 'Reply 1.', 'and then?', 'Reply 3.']), JSON.stringify(await live()));
  await ui.evaluate(() => document.querySelector('.msg-user-actions .msg-edit').click()); // the first message's own Edit
  await ui.waitForSelector('.msg-edit-box');
  await ui.fill('.msg-edit-box', 'hello edited');
  await ui.click('.msg-edit-actions .btn.primary');
  await waitFor(async () => /Reply 4\./.test(await text()));
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));
  check('the edit starts a new branch (the old answers are gone from view)', !/and then\?/.test(await text()) && /hello edited/.test(await text()), await text());
  check('the edited message shows its switch (3 versions: first, regenerated, edited)', JSON.stringify(await versions()) === '["3/3"]', JSON.stringify(await versions()));
  await ui.click('.msg-versions .msg-version-step:first-child');
  await ui.click('.msg-versions .msg-version-step:first-child');
  await waitFor(async () => /and then\?/.test(await text()));
  check('going back two versions brings the first branch, with its later turns', JSON.stringify(await live()) === JSON.stringify(['hello there', 'Reply 1.', 'and then?', 'Reply 3.']), JSON.stringify(await live()));

  // ---- a reopened chat keeps its thinking, model and steps
  await ui.click('#new-chat');
  await waitFor(() => ui.evaluate(() => !document.querySelector('.msg')));
  await ui.click('#chat-history');
  await ui.waitForSelector('#chat-list:not([hidden]) .chat-item');
  await ui.click('.chat-item .chat-open');
  await waitFor(() => ui.evaluate(() => document.getElementById('chat-list').hidden && document.querySelector('.msg')));
  const reopened = await ui.evaluate(() => ({
    thinking: document.querySelectorAll('details.thinking').length,
    open: [...document.querySelectorAll('details.thinking')].some((d) => d.open),
    thinkingText: document.querySelector('details.thinking div')?.textContent || '',
    model: document.querySelectorAll('.reply-model').length,
    times: document.querySelectorAll('.reply-meta time').length,
    user: document.querySelectorAll('.msg-user-actions').length,
    switches: [...document.querySelectorAll('.msg-versions .msg-version-count')].map((e) => e.textContent),
  }));
  check('reopened: each reply has its thinking, collapsed', reopened.thinking === 2 && !reopened.open && /pondering/.test(reopened.thinkingText), JSON.stringify(reopened));
  check('reopened: the model label and the time are back', reopened.model === 2 && reopened.times === 2, JSON.stringify(reopened));
  check('reopened: each message of yours has its row, and the versions are still switchable', reopened.user === 2 && reopened.switches.length === 1, JSON.stringify(reopened));

  // ---- Stop, then Continue
  await app.evaluate(() => { global.__slow = true; });
  await ui.click('#new-chat');
  await ui.fill('#prompt', 'write something long');
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => /Partial answer/.test(await text()));
  await ui.press('#prompt', 'Escape');
  await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.notice.stopped'))));
  check('after Stop there is a Continue button', await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.notice.stopped .notice-continue')))), 'none');
  await app.evaluate(() => { global.__slow = false; });
  await ui.click('.notice.stopped .notice-continue');
  await waitFor(async () => /Reply \d\./.test(await text()));
  check('Continue asks the chat to go on', await ui.evaluate(() => [...document.querySelectorAll('.msg.user')].some((e) => /Continue where you left off/.test(e.textContent))), await text());

  // ---- a long message of yours is cut short
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));
  const long = Array.from({ length: 30 }, (_, i) => `line ${i} of a long pasted message`).join('\n');
  await send(long, 'line 29');
  const clamp = await ui.evaluate(() => {
    const b = [...document.querySelectorAll('.msg.user')].pop();
    const more = b.nextElementSibling?.querySelector('.msg-more');
    const before = b.getBoundingClientRect().height;
    const label = more?.textContent;
    more?.click();
    return { clamped: b.classList.contains('clamped'), label, before, after: b.getBoundingClientRect().height, expanded: b.classList.contains('expanded') };
  });
  check('a long message is cut short with Show more, and opens in full', clamp.clamped && clamp.label === 'Show more' && clamp.expanded && clamp.after > clamp.before, JSON.stringify(clamp));

  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
