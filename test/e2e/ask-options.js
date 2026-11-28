// [ask options] The AI asks with clickable answers (ai/ask-user.js, renderer/ask-card.js), hidden window, a fake Claude client (no network,
// no key): the model calls ask_user with two options, the sidebar shows the card, a click on "Waltham" goes back as the tool's result and
// the same run goes on with it (no new message), the card shows what was picked, and the chat page (lumen://chat) draws the saved card
// answered. Run with LUMEN_TEST_BACKGROUND=1. LUMEN_ASK_SHOTS=<dir> saves screenshots.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ask-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    // The fake model: its first turn asks (ask_user), its next turn reads the tool result and answers with it.
    await app.evaluate(() => {
      const fake = global.__fake = { requests: [] };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        fake.requests.push({ tools: (params?.tools || []).map((t) => t.name), messages: JSON.parse(JSON.stringify(params.messages)) });
        const last = params.messages[params.messages.length - 1];
        const result = Array.isArray(last?.content) ? last.content.find((b) => b.type === 'tool_result') : null;
        const said = result ? (Array.isArray(result.content) ? result.content.map((c) => c.text || '').join('') : String(result.content || '')) : '';
        const picked = /→ (\w+)/.exec(said)?.[1];
        const content = result
          ? [{ type: 'text', text: `Applying to ${picked || 'nothing'} now.` }]
          : [{ type: 'text', text: 'One thing first.' }, { type: 'tool_use', id: 'toolu_ask1', name: 'ask_user', input: { questions: [{ question: 'The Northport application has a Waltham cover letter. Which did you mean?', header: 'Application', options: ['Northport', 'Waltham'] }] } }];
        const text = content[0].text;
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: result ? 'end_turn' : 'tool_use', content, usage: { input_tokens: 1000, output_tokens: 100 } };
        return {
          async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
          finalMessage: async () => message,
        };
      } } } });
    });
    const shot = async (page, name) => {
      if (!process.env.LUMEN_ASK_SHOTS) return;
      fs.mkdirSync(process.env.LUMEN_ASK_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.LUMEN_ASK_SHOTS, `${name}.png`) });
    };

    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.fill('#prompt', 'finish my Northport application');
    await ui.press('#prompt', 'Enter');
    const card = await waitFor(() => ui.evaluate(() => {
      const c = document.querySelector('#messages .ask-card');
      return c ? { chips: [...c.querySelectorAll('.ask-opt[data-label]')].map((b) => b.textContent), other: Boolean(c.querySelector('.ask-other-btn')), legend: c.querySelector('legend')?.textContent || '', role: c.getAttribute('role'), running: document.getElementById('send').classList.contains('stop'), focused: document.activeElement?.classList.contains('ask-opt') } : null;
    }));
    check('the model was offered ask_user', (await app.evaluate(() => global.__fake.requests[0]?.tools || [])).includes('ask_user'));
    check('the card shows the question, a chip per option and Other…', card && card.chips.join('|') === 'Northport|Waltham' && card.other && /Which did you mean/.test(card.legend) && card.role === 'group', JSON.stringify(card));
    check('the run waits on the card (still running), with the first chip focused for the keyboard', card?.running === true && card?.focused === true, JSON.stringify(card));
    const color = await ui.evaluate(() => { const c = document.querySelector('#messages .ask-card'); return getComputedStyle(c).backgroundColor !== 'rgba(0, 0, 0, 0)'; });
    check('the card is styled (its stylesheet loaded with it)', color);
    await shot(ui, '1-card');

    const before = await app.evaluate(() => global.__fake.requests.length);
    await ui.evaluate(() => [...document.querySelectorAll('#messages .ask-card .ask-opt')].find((b) => b.textContent === 'Waltham').click());
    await waitFor(async () => /Applying to Waltham now\./.test(await ui.evaluate(() => document.getElementById('messages').textContent)) && !(await ui.evaluate(() => document.getElementById('send').classList.contains('stop'))));
    const reqs = await app.evaluate(() => global.__fake.requests);
    const second = reqs[before];
    const toolResult = second?.messages?.at(-1)?.content?.find?.((b) => b.type === 'tool_result');
    const resultText = toolResult ? JSON.stringify(toolResult.content) : '';
    check('the click went back as ask_user\'s result in the same run', reqs.length === before + 1 && toolResult?.tool_use_id === 'toolu_ask1' && /→ Waltham/.test(resultText), resultText || JSON.stringify(second?.messages?.at(-1)));
    const users = await ui.evaluate(() => [...document.querySelectorAll('#messages .msg.user')].map((m) => m.textContent));
    check('no new user message was sent for the answer', users.length === 1 && /Northport application/.test(users[0]), JSON.stringify(users));
    const after = await ui.evaluate(() => { const c = document.querySelector('#messages .ask-card'); return { answered: c.classList.contains('answered'), pressed: [...c.querySelectorAll('.ask-opt[aria-pressed="true"]')].map((b) => b.textContent), disabled: [...c.querySelectorAll('button')].every((b) => b.disabled), status: c.querySelector('.ask-status').textContent }; });
    check('the card shows what was picked and takes no more clicks', after.answered && after.pressed.join() === 'Waltham' && after.disabled && /Waltham/.test(after.status), JSON.stringify(after));
    check('the run went on with the answer', /Applying to Waltham now\./.test(await ui.evaluate(() => document.getElementById('messages').textContent)));
    await shot(ui, '2-answered');

    // The saved chat: the chat page draws the card again, answered.
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch { return null; }
    }, code);
    const saved = await waitFor(() => inPage(`(() => { const c = document.querySelector('#messages .ask-card'); return c ? { answered: c.classList.contains('answered'), pressed: [...c.querySelectorAll('.ask-opt[aria-pressed="true"]')].map((b) => b.textContent), text: document.getElementById('messages').textContent } : null; })()`), 20000);
    check('the chat page (a saved chat drawn again) shows the card answered', saved?.answered === true && saved.pressed.join() === 'Waltham' && /Applying to Waltham now\./.test(saved.text), JSON.stringify(saved));
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite threw  -> ${err?.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
