// The give-up detector end to end (ai/handoff.js, agent.js runTaskOnce), in a hidden window with a fake Claude client that
// answers from a script: a first final reply that hands the work back gets exactly one automatic follow-up turn, shown as a
// quiet "Trying another way…" step, and the second reply is the final one. A reply that stops for a CAPTCHA does not trigger it.
// A model that hands back twice is not asked a third time, and the capability-gap note (Settings → AI and agents) gets one entry
// with no words from the reply. No network, no key. Run alone: node test/e2e/handoff.js
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-handoff-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    // Runs one message against a script of replies; resolves with what the screen would have seen and how many model calls were made.
    const ask = (text, replies) => app.evaluate((_e, { text, replies }) => new Promise((resolve) => {
      global.__agent.reset?.();
      let n = 0;
      const prompts = [];
      global.__agent.getClient = () => ({ beta: { messages: { stream: (req) => {
        const reply = replies[Math.min(n, replies.length - 1)];
        n++;
        const last = req.messages[req.messages.length - 1];
        prompts.push(JSON.stringify(last.content).slice(0, 400));
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 10 } };
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }; }, finalMessage: async () => message };
      } } } });
      const events = [];
      global.__agent.run(text, (e) => { events.push(e); if (e.type === 'done') resolve({ events, calls: n, prompts, items: global.__agent.transcript() }); });
    }), { text, replies });
    const gaps = () => { try { return fs.readFileSync(path.join(profile, 'diagnostics', 'ai-gaps.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

    // 1. A handoff, then real work: the follow-up fires once.
    const a = await ask('summarize my report in the open doc', ['I can\'t read it. Please paste the full text of your report here.', 'I read the document through another route. The report says revenue grew 12%.']);
    check('handoff: the model was called twice', a.calls === 2, a.calls);
    check('handoff: one "retry" event and one quiet "Trying another way…" step', a.events.filter((e) => e.type === 'retry').length === 1 && a.events.filter((e) => e.type === 'tool' && e.label === 'Trying another way…' && !e.id).length === 1, JSON.stringify(a.events.map((e) => e.type)));
    check('handoff: the follow-up asked for another approach', /different approach/.test(a.prompts[1] || '') && /lumen_retry/.test(a.prompts[1] || ''), a.prompts[1]);
    const shownA = a.items.filter((i) => i.role === 'assistant').map((i) => i.text);
    check('handoff: the second reply is the final one, and the handoff text is not in the chat', shownA.length === 1 && /revenue grew/.test(shownA[0]), JSON.stringify(shownA));
    check('handoff: the follow-up is not shown as a user message', a.items.filter((i) => i.role === 'user').length === 1, JSON.stringify(a.items.map((i) => i.role)));
    check('handoff: a retry that worked leaves no gap note', gaps().length === 0, JSON.stringify(gaps()));

    // 2. A legitimate stop (CAPTCHA): nothing is retried.
    const c = await ask('open the ticket page and book it', ['The site shows a CAPTCHA that only you can solve. Please complete it and I will carry on.']);
    check('captcha: one model call, no retry step', c.calls === 1 && !c.events.some((e) => e.type === 'retry'), `${c.calls} ${JSON.stringify(c.events.map((e) => e.type))}`);
    // A sign-in and a question about a choice are legitimate stops too.
    const s = await ask('check my inbox', ['You need to sign in to Gmail first. I can\'t enter your password.']);
    check('sign-in: not retried', s.calls === 1, s.calls);

    // 3. Handing back twice: asked once only, then the gap is noted (no words from the reply).
    const d = await ask('make the slides in the doc', ['You\'ll need to do this yourself: open it in a browser.', 'Please paste the text of the slides here so I can continue.']);
    check('no loop: two model calls, never three', d.calls === 2 && d.events.filter((e) => e.type === 'retry').length === 1, d.calls);
    const entries = gaps();
    check('gap note: one entry with a date and what was missing, none of the reply\'s words', entries.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(entries[0].date) && typeof entries[0].missing === 'string' && !/slides|browser|yourself/i.test(JSON.stringify(entries[0])), JSON.stringify(entries));

    // 4. Off: no note.
    await app.evaluate(() => global.__settings.backend.set('aiGapLog', false));
    await ask('make the slides in the doc', ['Please paste the text here.', 'Please paste the text here.']);
    check('opt-out: nothing more is written with the setting off', gaps().length === 1, JSON.stringify(gaps()));

    // 5. A plain how-to answer is not a handoff.
    const h = await ask('how do I clear my cookies in Chrome?', ['You can open Settings, then Privacy, then Clear browsing data. You\'ll need to pick a time range first.']);
    check('how-to: an answer that tells the user the steps is left alone', h.calls === 1, h.calls);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
