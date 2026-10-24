// /btw in the app, hidden (LUMEN_TEST_BACKGROUND=1), with a mocked Anthropic client (no network):
//   - the main reply is held mid-run; /btw answers anyway, within a second, in a card, on the cheaper model, while the main reply is untouched
//   - the main reply then finishes normally; the question and the answer never became chat messages
//   - a failing model shows a clear error with Retry in the card; Retry in the same card gets the answer
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(50); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-btw-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.waitForSelector('#prompt');
    await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
    await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden')));
    // The mock: the main reply waits for global.__gate; a /btw request (its text says "Side question:") answers at once, unless told to fail.
    await app.evaluate(() => {
      global.__log = [];
      global.__mode = 'ok';
      let open;
      global.__gate = new Promise((r) => { open = r; });
      global.__openGate = () => open();
      const stream = (params) => {
        const isBtw = /Side question:/.test(JSON.stringify(params.messages));
        global.__log.push({ model: params.model, btw: isBtw, tools: params.tools ? params.tools.length : 0, at: Date.now() });
        const text = isBtw ? 'It was the pricing page.' : 'Main task finished.';
        const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 20, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() {
            if (!isBtw) await global.__gate;
            else if (global.__mode === 'fail') throw Object.assign(new Error('overloaded_error: try later'), { status: 529 });
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
          },
          finalMessage: async () => message,
        };
      };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => { const s = stream({ ...params, signalForTest: opts?.signal }); return s; } } } });
    });
    const chatMessages = () => app.evaluate(() => JSON.stringify(global.__agent.messages));
    const cards = () => ui.evaluate(() => [...document.querySelectorAll('.btw-card')].map((c) => ({ q: c.querySelector('.btw-q')?.textContent, body: c.querySelector('.btw-body')?.textContent, error: c.querySelector('.btw-body')?.classList.contains('btw-error'), foot: c.querySelector('.btw-foot')?.textContent, retry: Boolean(c.querySelector('.btw-retry')), busy: c.getAttribute('aria-busy') === 'true' })));

    // Start the main task; it is held.
    await ui.fill('#prompt', 'open the pricing page and summarize it');
    await ui.press('#prompt', 'Enter');
    check('setup: the main reply is running and held', await waitFor(() => app.evaluate(() => global.__log.length === 1)) && await ui.evaluate(() => document.body.classList.contains('agent-active')));

    // /btw while it runs.
    const t0 = Date.now();
    await ui.fill('#prompt', '/btw which page was that?');
    await ui.press('#prompt', 'Enter');
    const answered = await waitFor(async () => (await cards()).some((c) => /pricing page/.test(c.body || '')), 5000);
    const ms = Date.now() - t0;
    const list = await cards();
    check('btw: answered in a card while the main reply is still running', answered && list.length === 1 && list[0].q === 'which page was that?', JSON.stringify(list));
    check('btw: fast (answer under 1.5 s with a mocked instant model)', ms < 1500, ms);
    check('btw: the main reply is still running (not stopped, not waited for)', await ui.evaluate(() => document.body.classList.contains('agent-active')) && !(await ui.evaluate(() => /Main task finished/.test(document.body.innerText))));
    const log = await app.evaluate(() => global.__log);
    check('btw: one extra request, on the cheaper model, no tools', log.length === 2 && log[1].btw && log[1].model === 'claude-haiku-5-5' && log[1].tools === 0, JSON.stringify(log));
    check('btw: the card names the model that answered', /Answered by/.test(list[0]?.foot || ''), JSON.stringify(list));

    // Failure: a clear error and Retry in the same card.
    await app.evaluate(() => { global.__mode = 'fail'; });
    await ui.fill('#prompt', '/btw and the price?');
    await ui.press('#prompt', 'Enter');
    const failed = await waitFor(async () => (await cards()).find((c) => c.q === 'and the price?' && c.error), 5000);
    check('failure: the card says it failed, with the reason, and offers Retry', failed && /failed/i.test(failed.body) && failed.retry && !failed.busy, JSON.stringify(failed));
    await app.evaluate(() => { global.__mode = 'ok'; });
    await ui.click('.btw-card:nth-child(2) .btw-retry');
    const retried = await waitFor(async () => (await cards()).find((c) => c.q === 'and the price?' && /pricing page/.test(c.body || '')), 5000);
    check('failure: Retry in the same card gets the answer', retried && !retried.error && (await cards()).length === 2, JSON.stringify(await cards()));

    // The main reply finishes normally; /btw never entered the chat.
    await app.evaluate(() => global.__openGate());
    const finished = await waitFor(() => ui.evaluate(() => /Main task finished/.test(document.body.innerText) && !document.body.classList.contains('agent-active')), 8000);
    check('main: the held reply finishes normally afterwards', finished);
    const after = await chatMessages();
    check('main: the questions and answers are in no chat message', !/which page was that|and the price|It was the pricing page/.test(after), after.slice(0, 300));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
