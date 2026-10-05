// "Send now" in the sidebar chat: while a reply runs, a typed message (the button or Ctrl+Enter) or a queued one
// (its notice's Send now) stops the reply and goes next. The reply so far stays on screen, marked interrupted, and
// reaches the next request in the history. Uses a fake Claude client: no network, no key.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-send-now-')); // a throwaway profile, never the real one
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

  // Fake Claude: a message starting "slow" streams a partial reply, then hangs until the request is aborted;
  // anything else answers at once. Every request's history is recorded.
  await app.evaluate(() => {
    global.__requests = [];
    global.__aborted = 0;
    const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' '));
    global.__agent.getClient = () => ({
      beta: { messages: { stream: (params, options = {}) => {
        global.__requests.push(JSON.parse(JSON.stringify(params.messages)));
        const last = textOf(params.messages[params.messages.length - 1]);
        const slow = /\bslow\b/.test(last);
        const text = slow ? 'Partial answer so far' : `Answered: ${last.slice(-40)}`;
        const message = { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
            if (slow) {
              await new Promise((_resolve, reject) => {
                const stop = () => { global.__aborted++; reject(new Error('Request was aborted.')); };
                if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
              });
            }
          },
          finalMessage: async () => message,
        };
      } } },
    });
  });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(300);
  const running = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
  const hidden = () => ui.evaluate(() => document.getElementById('send-now').hidden);
  const startSlow = async (text) => {
    await ui.fill('#prompt', text);
    await ui.press('#prompt', 'Enter');
    await ui.waitForFunction(() => [...document.querySelectorAll('.msg.assistant')].some((m) => /Partial answer so far/.test(m.textContent)), null, { timeout: 10000 });
  };
  const lastRequest = () => app.evaluate(() => global.__requests[global.__requests.length - 1]);
  const waitAnswered = (word) => ui.waitForFunction((w) => [...document.querySelectorAll('.msg.assistant')].some((m) => m.textContent.includes(`Answered: ${w}`)) && !document.getElementById('send').classList.contains('stop'), word, { timeout: 10000 });

  // 1. The composer's Send now button.
  check('Send now is hidden while nothing runs', await hidden(), 'shown');
  await startSlow('slow one');
  check('a reply is running', await running(), 'not running');
  check('Send now stays hidden with nothing typed', await hidden(), 'shown');
  await ui.fill('#prompt', 'first follow-up');
  check('Send now shows while a reply runs and text is typed', !(await hidden()), 'hidden');
  await ui.click('#send-now');
  await waitAnswered('first follow-up').catch(() => {});
  const after1 = await ui.evaluate(() => ({
    partial: [...document.querySelectorAll('.msg.assistant')].some((m) => /Partial answer so far/.test(m.textContent)),
    notice: [...document.querySelectorAll('.notice.stopped')].map((n) => n.textContent).pop() || '',
    queued: document.querySelectorAll('.notice.queued').length,
    prompt: document.getElementById('prompt').value,
    sendNowHidden: document.getElementById('send-now').hidden,
  }));
  check('the stopped reply\'s text stays in the chat', after1.partial, JSON.stringify(after1));
  check('it is marked interrupted', /Interrupted/.test(after1.notice), after1.notice);
  check('nothing is left waiting, the composer is empty and Send now hidden again', after1.queued === 0 && after1.prompt === '' && after1.sendNowHidden, JSON.stringify(after1));
  check('the request was aborted', (await app.evaluate(() => global.__aborted)) === 1, String(await app.evaluate(() => global.__aborted)));
  const req1 = await lastRequest();
  const partialTurn = req1?.[req1.length - 2];
  const partialText = partialTurn?.content?.map?.((b) => b.text).join('') || '';
  check('the next turn\'s history has the partial reply, marked interrupted', partialTurn?.role === 'assistant' && /Partial answer so far/.test(partialText) && /interrupted/i.test(partialText), JSON.stringify(partialTurn));
  check('and the new message as the latest turn', JSON.stringify(req1?.[req1.length - 1]).includes('first follow-up'), JSON.stringify(req1?.[req1.length - 1]));

  // 2. Ctrl+Enter is Send now while a reply runs.
  await startSlow('slow two');
  await ui.fill('#prompt', 'second follow-up');
  await ui.press('#prompt', 'Control+Enter');
  await waitAnswered('second follow-up').catch(() => {});
  const req2 = await lastRequest();
  check('Ctrl+Enter stops the reply and sends the message next', JSON.stringify(req2?.[req2.length - 1]).includes('second follow-up') && (await app.evaluate(() => global.__aborted)) === 2, JSON.stringify(req2?.slice(-2)));

  // 3. Enter still queues; the queued message's own Send now sends it at once.
  await startSlow('slow three');
  await ui.fill('#prompt', 'queued follow-up');
  await ui.press('#prompt', 'Enter');
  await ui.waitForSelector('.notice.queued', { timeout: 5000 }).catch(() => {});
  check('Enter while running queues the message (the reply goes on)', (await ui.locator('.notice.queued').count()) === 1 && (await running()), await ui.locator('.notice.queued').count());
  await ui.locator('.notice.queued .queue-btn', { hasText: 'Send now' }).click();
  await waitAnswered('queued follow-up').catch(() => {});
  const req3 = await lastRequest();
  check('a queued message\'s Send now stops the reply and sends it next', JSON.stringify(req3?.[req3.length - 1]).includes('queued follow-up') && (await app.evaluate(() => global.__aborted)) === 3 && (await ui.locator('.notice.queued').count()) === 0, JSON.stringify(req3?.slice(-2)));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
