// [mid-run messages] A message typed while the reply runs reaches the model at the run's next step, as in Claude Code, instead of waiting in
// the line until the whole reply ends (ai/steer.js, agent.js loop, renderer/chat-core.js steerOut). Hidden window, throwaway profile, fake
// Claude client that takes two tool rounds, each held until the test lets it go (no network, no key, no real CLI):
//   A. typed during the first round: the bubble says it goes at the next step; the NEXT request carries it; the bubble is then a sent message
//      ("Sent to the AI while it worked"); it is not sent again when the reply ends; after a reload of the view the chat still shows it
//   B. typed while the final answer streams (no step left): it waits, and goes as the next message, as before
// Run under the lock:  node scripts/test/e2e-lock.js run --owner mid-run-steer -- node test/e2e/mid-run-steer.js
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mid-run-steer-'));
  const missing = path.join(profile, 'no-such-cli.exe'); // (the user's real AI CLIs stay out of this run)
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: missing, LUMEN_CODEX_BIN: missing, LUMEN_GROK_BIN: missing, LUMEN_AGY_BIN: missing } });
  try {
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); });
    const ui = await app.firstWindow({ timeout: 90000 });
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');

    // Fake Claude: the first message of a chat ("create a doc…") takes two rounds of list_tabs, then answers; each request is held until
    // global.__release(). Any other first message ("plain") answers at once. Every request is recorded: its round and its last user message.
    await app.evaluate(() => {
      global.__requests = [];
      let gate; const reset = () => { global.__gateP = new Promise((r) => { gate = r; }); };
      reset();
      global.__release = () => { gate(); reset(); };
      const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' '));
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const round = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')).length;
        const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
        const firstOfTurn = [...params.messages].reverse().find((m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')));
        const doc = /create a doc/.test(textOf(firstOfTurn));
        global.__requests.push({ round, doc, last: textOf(lastUser).replace(/<browser_state>[\s\S]*?<\/browser_state>/, '').trim().slice(-400), all: JSON.stringify(params.messages) });
        const tool = doc && round < 2;
        const text = tool ? `Step ${round + 1}` : doc ? 'The doc is made in ME2340.' : `Answered: ${textOf(lastUser).replace(/\s+/g, ' ').slice(-40)}`;
        const content = tool ? [{ type: 'text', text }, { type: 'tool_use', id: `tu-${round}`, name: 'list_tabs', input: {} }] : [{ type: 'text', text }];
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: tool ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 10, output_tokens: 5 } };
        const gateP = global.__gateP;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
            if (doc) await gateP;
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
    const requests = () => app.evaluate(() => global.__requests.map(({ all, ...r }) => ({ ...r, steer: /<sent_while_working>/.test(all), n: (all.match(/is probably in me2340/g) || []).length })));
    const type = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const release = () => app.evaluate(() => global.__release());
    const bubbleOf = (needle) => ui.evaluate((t) => { const b = [...document.querySelectorAll('#messages .msg.user, #messages .queued-bubble')].find((e) => e.textContent.includes(t)); return b ? { cls: b.className, text: b.textContent, queued: b.classList.contains('queued') } : null; }, needle);

    // ---- A. typed during the first tool round
    await type('create a doc for me2340 in canvas');
    await waitFor(async () => (await requests()).length === 1 && await running());
    await type('is probably in me2340');
    const waiting = await waitFor(async () => { const b = await bubbleOf('is probably in me2340'); return b && /Queued · goes in at the AI’s next step/.test(b.text) ? b : null; }, 5000);
    check('A: the bubble says it goes to the AI at its next step (not "Queued" until the reply ends)', Boolean(waiting), JSON.stringify(await bubbleOf('is probably in me2340')));
    await release(); // round 1 ends: its tool runs, and the next request goes out
    await waitFor(async () => (await requests()).length === 2);
    const second = (await requests())[1];
    check('A: the next request carries the message (with that round\'s tool results)', second && second.round === 1 && second.steer && /is probably in me2340/.test(second.last), JSON.stringify(await requests()));
    const sent = await waitFor(async () => { const b = await bubbleOf('is probably in me2340'); return b && !b.queued && /steered/.test(b.cls) ? b : null; }, 5000);
    check('A: the bubble is a sent message, "Sent to the AI while it worked"', Boolean(sent) && /Sent to the AI while it worked/.test(sent.text), JSON.stringify(await bubbleOf('is probably in me2340')));
    check('A: the reply keeps working (it was not stopped for it)', await running());
    await release(); // round 2
    await waitFor(async () => (await requests()).length === 3);
    await release(); // the final answer
    await idle();
    await sleep(1500); // (a message left in the line would go now)
    const all = await requests();
    check('A: not sent again when the reply ends (no fourth request; once in the last one)', all.length === 3 && all[2].n === 1, JSON.stringify(all));
    check('A: the line is empty', await ui.evaluate(() => document.querySelectorAll('#messages .queued-bubble').length === 0));
    await ui.reload();
    await ui.waitForFunction(() => window.chatQueue);
    const redrawn = await waitFor(() => bubbleOf('is probably in me2340'), 8000);
    check('A: after a reload of the view the chat still shows it, as sent while it worked', redrawn && /steered/.test(redrawn.cls) && /Sent to the AI while it worked/.test(redrawn.text), JSON.stringify(redrawn));

    // ---- B. typed while the final answer streams: there is no step left, so it goes as the next message
    await ui.click('#new-chat');
    await sleep(400);
    await type('create a doc again');
    await waitFor(async () => (await requests()).length === 4);
    await release();
    await waitFor(async () => (await requests()).length === 5);
    await release();
    await waitFor(async () => (await requests()).length === 6); // the final answer is streaming (held)
    await type('one more thing');
    await sleep(300);
    await release();
    await waitFor(async () => (await requests()).length === 7, 10000);
    const next = (await requests())[6];
    check('B: typed during the final answer, it goes as the next message, as before', next && !next.doc && /one more thing/.test(next.last) && !next.steer, JSON.stringify(await requests()));
    await idle();
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err.stack}`);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* left in the temp folder */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
