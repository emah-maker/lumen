/* global setRunning */
// A sidebar that missed the end of a reply (hidden while it finished) must not keep a Stop button that swallows the
// next Send: the composer's running state follows main when the sidebar is shown again and when the button is clicked.
// Fake Claude client; one window.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(50); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-stuckstop-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  app.process().stderr?.on('data', (d) => { const t = String(d); if (/Error|Uncaught|exception/i.test(t) && !/MaxListeners/.test(t)) console.log(`  [main stderr] ${t.trim().slice(0, 400)}`); });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    const fake = global.__fake = { asks: 0, gate: null, release: null };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const n = ++fake.asks;
      const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply ${n}.` }], usage: { input_tokens: 10, output_tokens: 5 } };
      return {
        async *[Symbol.asyncIterator]() { if (fake.gate) await fake.gate; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });
  const asks = () => app.evaluate(() => global.__fake.asks);
  const hold = () => app.evaluate(() => { const f = global.__fake; f.gate = new Promise((r) => { f.release = r; }); });
  const release = () => app.evaluate(() => { const f = global.__fake; f.gate = null; f.release?.(); });
  const isStop = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
  const toggle = () => ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  const ask = async (text) => { await ui.fill('#prompt', text); await ui.keyboard.press('Enter'); };

  await toggle();
  await ui.waitForSelector('#prompt', { state: 'visible' });

  // 1. A reply that finishes while the sidebar is folded away: shown again, the button is Send, and it sends.
  await hold();
  await ask('first question');
  check('a running reply shows Stop', await waitFor(isStop), 'no stop');
  await toggle();
  await release();
  await waitFor(async () => !(await app.evaluate(() => global.__tabChats.runs().some((r) => r.live))));
  await toggle();
  check('shown again after the reply ended: Send, not Stop', await waitFor(async () => !(await isStop()), 3000), 'still stop');

  await sleep(1000); // (the show animation settles)
  // 2. The sidebar missed the end entirely (simulated: running state left on): showing it again fixes the button.
  await ui.evaluate(() => setRunning(true));
  check('stale Stop is showing', await isStop(), 'not stop');
  await toggle();
  await sleep(800);
  await toggle();
  check('stale Stop cleared when the sidebar is shown again', await waitFor(async () => !(await isStop()), 3000), 'still stop');

  // 3. Clicking a stale Stop with text typed sends the message.
  await ui.evaluate(() => setRunning(true));
  await ui.fill('#prompt', 'second question');
  const before = await asks();
  await ui.click('#send');
  check('clicking a stale Stop sends the message', await waitFor(async () => (await asks()) === before + 1, 5000), `asks=${await asks()} before=${before}`);
  await waitFor(async () => !(await app.evaluate(() => global.__tabChats.runs().some((r) => r.live))));

  // 4. A really running reply is still stopped by the button.
  await hold();
  await ask('third question');
  await waitFor(isStop);
  await app.evaluate(({ ipcMain }) => { global.__stops = 0; ipcMain.on('agent:stop', () => { global.__stops++; }); });
  await ui.click('#send');
  check('Stop still stops a running reply', await waitFor(async () => (await app.evaluate(() => global.__stops)) === 1, 5000), 'stop not called');
  await release();

  await app.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
