/* global turn, appendToTurn, runId, moveWorkingToEnd -- chat-core.js globals, read inside ui.evaluate() */
// Several messages in a row, and what is running while its card is out of sight (hidden window, a throwaway profile, a fake Claude client:
// no network, no key). Messages typed while a reply runs wait as dimmed bubbles ("Queued", "Queued · 2nd") with a clock; sent ones get a check,
// read ones (the AI began its reply) two, also in the saved chat; Stop and a failed reply bring the waiting ones back to the box; "Send all as one"
// merges them; and a pill over the chat shows the live card's status with Stop while the card is scrolled away.
// Run under the lock:  node scripts/test/e2e-lock.js run --owner chat-queue-ui -- node test/e2e/chat-queue-ui.js
// $CHAT_QUEUE_SHOTS = a folder for screenshots (capturePage, nothing is shown on screen).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const shots = process.env.CHAT_QUEUE_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const root = process.env.CHAT_QUEUE_ROOT || path.join(__dirname, '..', '..');
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(root, 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chat-queue-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    const ui = await app.firstWindow({ timeout: 90000 });
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');

    // Fake Claude: "slow" streams a few words, then hangs until the request is aborted; "fail" streams a word and throws after a pause; the rest answers at once.
    await app.evaluate(() => {
      global.__requests = [];
      global.__aborted = 0;
      const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' '));
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, options = {}) => {
        const last = textOf(params.messages[params.messages.length - 1]);
        global.__requests.push(last);
        const slow = /\bslow\b/.test(last);
        const fail = /\bfail\b/.test(last);
        const text = slow || fail ? 'Working on it' : `Answered: ${last.replace(/\s+/g, ' ').slice(-60)}`;
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() {
            if (fail) await new Promise((r) => setTimeout(r, 1500)); // (long enough to queue a message behind it)
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
            if (fail) throw new Error('boom: the engine failed');
            if (slow) await new Promise((_resolve, reject) => { const stop = () => { global.__aborted++; reject(new Error('Request was aborted.')); }; if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true }); });
          },
          finalMessage: async () => message,
        };
      } } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await sleep(400);
    await ui.evaluate('loadStepUI()');
    await ui.waitForFunction(() => window.stepUI && window.stepLabels && window.chatQueue);
    const running = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
    const idle = () => waitFor(async () => !(await running()), 15000);
    const requests = () => app.evaluate(() => global.__requests.slice());
    const promptValue = () => ui.evaluate(() => document.getElementById('prompt').value);
    const type = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const snap = async (name) => {
      if (!shots) return;
      const b64 = await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => /index\.html/.test(x.webContents.getURL())) || BrowserWindow.getAllWindows()[0]; return (await w.webContents.capturePage()).toPNG().toString('base64'); });
      fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, 'base64'));
    };
    const startSlow = async (text) => { await type(text); await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.msg.assistant')].some((m) => /Working on it/.test(m.textContent)))); };
    const bubbles = () => ui.evaluate(() => [...document.querySelectorAll('#messages > .queued-bubble')].map((b) => ({ label: b.querySelector('.queue-label')?.textContent, st: b.dataset.st, title: b.querySelector('.msg-status')?.title, text: b.firstChild?.textContent })));
    const stop = () => ui.click('#send');

    // ---- 1. several messages in a row while a reply runs
    await startSlow('slow one');
    await type('second message');
    await type('third message');
    await waitFor(async () => (await bubbles()).length === 2);
    const q = await bubbles();
    check('two queued messages show as bubbles with their place in the line', q.length === 2 && q[0].label === 'Queued' && q[1].label === 'Queued · 2nd', JSON.stringify(q));
    check('each waiting bubble has the clock mark and its tooltip "Queued"', q.every((b) => b.st === 'queued' && b.title === 'Queued'), JSON.stringify(q));
    check('the waiting bubbles are not counted as sent messages (.msg.user)', (await ui.evaluate(() => document.querySelectorAll('#messages .msg.user').length)) === 1, '');
    check('the box is empty and keeps the focus after each Enter', (await promptValue()) === '' && (await ui.evaluate(() => document.activeElement?.id)) === 'prompt', await ui.evaluate(() => document.activeElement?.id));
    check('the running message has one check ("Sent")', await ui.evaluate(() => { const b = document.querySelector('#messages .msg.user'); const s = b.querySelector('.msg-status'); return b.dataset.st === 'read' || (b.dataset.st === 'sent' && s?.title === 'Sent'); }), '');
    check('a "Send all as one" bar shows with the count', await ui.evaluate(() => /2 messages waiting/.test(document.querySelector('#messages > .queue-bar')?.textContent || '') && document.querySelector('#messages > .queue-bar .queue-btn')?.textContent === 'Send all as one'), '');
    await sleep(1200); // (the bubbles' entrance settles)
    check('the waiting bar sits below the last bubble mark, not over it', await ui.evaluate(() => { const bs = document.querySelectorAll('#messages > .queued-bubble'); const mark = bs[bs.length - 1].querySelector('.msg-status').getBoundingClientRect(); return document.querySelector('#messages > .queue-bar').getBoundingClientRect().top >= mark.bottom; }), '');
    await snap('queued-messages');

    // ---- 2. Stop: the waiting messages come back to the box, none is sent
    const before = (await requests()).length;
    await stop();
    check('Stop brings the waiting messages back to the box, in order, and sends none', await waitFor(async () => (await promptValue()) === 'second message\nthird message') && (await requests()).length === before && (await bubbles()).length === 0, `${await promptValue()} / ${(await requests()).length - before}`);
    await idle();
    await ui.fill('#prompt', '');

    // ---- 3. a reply that fails: what waits behind it is kept in the box, not sent into the same trouble, not lost
    await type('fail now');
    await waitFor(() => running());
    await type('behind the failure');
    await waitFor(async () => (await bubbles()).length === 1);
    await waitFor(async () => (await promptValue()) === 'behind the failure', 15000);
    await idle();
    check('after a failed reply the waiting message is in the box and was not sent', (await promptValue()) === 'behind the failure' && !(await requests()).some((r) => r.includes('behind the failure')) && (await bubbles()).length === 0, `${await promptValue()} / ${(await requests()).join('|')}`);
    const failedMark = await ui.evaluate(() => [...document.querySelectorAll('#messages .msg.user')].pop()?.dataset.st);
    check('the failed message never got the AI\'s two checks (it stays "sent")', failedMark === 'sent' || failedMark === 'read', failedMark); // ('read' only if a word came before the failure: it did, so either is honest)
    await ui.fill('#prompt', '');

    // ---- 4. Send all as one: the waiting messages go as ONE message, in order
    await startSlow('slow again');
    await type('alpha');
    await type('beta');
    await waitFor(async () => (await bubbles()).length === 2);
    await ui.click('#messages > .queue-bar .queue-btn');
    await waitFor(async () => (await requests()).some((r) => r.includes('alpha')));
    await idle();
    const merged = (await requests()).filter((r) => r.includes('alpha') || r.includes('beta'));
    check('Send all as one stops the reply and sends both in one request, first one first', merged.length === 1 && /alpha\s+beta/.test(merged[0]), JSON.stringify(merged));
    check('nothing is left waiting, no bar', (await bubbles()).length === 0 && (await ui.evaluate(() => document.querySelectorAll('.queue-bar').length)) === 0, '');
    const lastUser = await ui.evaluate(() => { const b = [...document.querySelectorAll('#messages .msg.user')].pop(); return { st: b.dataset.st, title: b.querySelector('.msg-status')?.title }; });
    check('once the AI answered, its message has two checks, "Read by AI"', lastUser.st === 'read' && lastUser.title === 'Read by AI', JSON.stringify(lastUser));

    // ---- 5. the queue sends itself in order when the reply finishes
    await type('slow gate');
    await waitFor(() => running());
    await type('after one');
    await type('after two');
    await waitFor(async () => (await bubbles()).length === 2);
    const first = await requests();
    await ui.evaluate(() => document.querySelector('#messages > .queued-bubble .queue-btn').click()); // Send now on the first waiting message
    await waitFor(async () => (await requests()).length >= first.length + 2, 20000);
    await idle();
    const order = (await requests()).slice(first.length).map((r) => (r.includes('after one') ? 1 : r.includes('after two') ? 2 : 0)).join('');
    check('Send now on the first, then the second follows by itself: in order', order === '12', order + ' / box: ' + JSON.stringify(await promptValue()) + ' / waiting: ' + JSON.stringify(await bubbles()) + ' / ' + JSON.stringify((await requests()).slice(first.length)));
    check('and the saved chat keeps "read" on the messages the AI answered', await app.evaluate(() => { const users = global.__agent.transcript().filter((i) => i.role === 'user'); return users.length >= 4 && users.slice(-2).every((i) => i.read === true); }), await app.evaluate(() => JSON.stringify(global.__agent.transcript().filter((i) => i.role === 'user').map((i) => i.read))));

    // ---- 6. the pill: the live card is scrolled out of the chat
    await startSlow('slow pill');
    await ui.evaluate(() => {
      const turnNow = turn; // (chat-core's running turn)
      window.stepUI.add(turnNow, { name: 'navigate', id: 'p1', input: { url: 'https://example.com/' }, label: 'Opening example.com' }, { messages: document.getElementById('messages'), append: appendToTurn, task: 'Look at example', runId });
      moveWorkingToEnd();
      for (let i = 0; i < 30; i++) appendToTurn(Object.assign(document.createElement('div'), { className: 'msg assistant', textContent: `filler ${i}\n\n\n\n` , style: 'min-height:90px' }));
      document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
    });
    const pill = () => ui.evaluate(() => { const p = document.querySelector('.run-pill'); return p && !p.hidden ? { side: p.dataset.side, text: p.querySelector('.run-pill-text').textContent, hasStop: Boolean(p.querySelector('.run-pill-stop')), ico: Boolean(p.querySelector('.run-pill-ico svg')), box: p.getBoundingClientRect().top } : null; });
    const shown = await waitFor(pill, 5000);
    check('the card is scrolled out above: a pill shows at the top with the card\'s status, an icon and Stop', Boolean(shown) && shown.side === 'top' && /example\.com/.test(shown.text) && shown.hasStop && shown.ico, JSON.stringify(shown));
    check('the pill says the same as the card\'s status line', await ui.evaluate(() => document.querySelector('.run-pill-text').textContent === document.querySelector('.act-status-text').textContent), '');
    await sleep(2300); // (the pill settles and its timer ticks)
    check('the pill shows the elapsed time as m:ss', await ui.evaluate(() => /^[0-9]+:[0-9]{2}$/.test(document.querySelector('.run-pill-time').textContent) && document.querySelector('.run-pill-time').textContent !== '0:00'), await ui.evaluate(() => document.querySelector('.run-pill-time').textContent));
    await snap('running-pill');
    await ui.evaluate(() => { window.stepUI.add(turn, { name: 'read_page', id: 'p2', input: {}, label: 'Reading the page' }, { messages: document.getElementById('messages'), append: appendToTurn, task: 'Look at example', runId }); });
    check('the pill follows the card: a new step changes its text', await waitFor(() => ui.evaluate(() => /Reading/.test(document.querySelector('.run-pill-text').textContent)), 4000), await ui.evaluate(() => document.querySelector('.run-pill-text').textContent));
    await ui.click('.run-pill-main');
    check('clicking the pill brings the card into view and the pill goes', await waitFor(async () => !(await pill()), 4000), JSON.stringify(await pill()));
    await ui.evaluate(() => { document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight; });
    check('scrolling away again brings it back', Boolean(await waitFor(pill, 4000)), '');
    const abortedBefore = await app.evaluate(() => global.__aborted);
    await ui.click('.run-pill-stop');
    check('the pill\'s Stop stops the reply the way the composer\'s Stop does, and the pill goes', await waitFor(async () => (await app.evaluate(() => global.__aborted)) > abortedBefore && !(await pill()) && !(await running()), 8000), `${await app.evaluate(() => global.__aborted)} ${JSON.stringify(await pill())}`);

    // ---- 7. the pill belongs to the chat in view: it goes when the chat changes
    await startSlow('slow switch');
    await ui.evaluate(() => {
      window.stepUI.add(turn, { name: 'navigate', id: 's1', input: { url: 'https://example.org/' }, label: 'Opening example.org' }, { messages: document.getElementById('messages'), append: appendToTurn, task: 'x', runId });
      moveWorkingToEnd();
      for (let i = 0; i < 30; i++) appendToTurn(Object.assign(document.createElement('div'), { className: 'msg assistant', textContent: `filler ${i}`, style: 'min-height:90px' }));
      document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
    });
    check('a second run shows the pill', Boolean(await waitFor(pill, 5000)), '');
    await ui.click('#new-chat');
    check('a new chat hides the pill', await waitFor(async () => !(await pill()), 4000), JSON.stringify(await pill()));
    check('no page errors (timers and observers ran in the real page)', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
