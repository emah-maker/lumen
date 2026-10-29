// The screen side of "a reply that looks finished always finishes, and Stop always works" (see test/units/reply-stuck-units.js for the engine side).
// Hidden Electron (LUMEN_TEST_BACKGROUND, a throwaway profile). The Claude Code turn is replaced by a stub that emits the events the real one does
// (agent.js claudeCodeTurn): no CLI, no network, no key.
//   a. a reply ends with a file card after its text: no streaming dot is left, the working line goes, the reply's actions show, the queued message sends
//   b. a stuck reply that ignores Stop: within 3 s the reply is marked stopped, the composer is free, the queued text is back in it as a draft
//   c. "Send now" while a reply is stuck: the reply stops and the queued message is sent
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reply-stuck-')); // a throwaway profile, never the real one
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reply-stuck-files-'));
  const html = path.join(files, 'solution.html');
  fs.writeFileSync(html, '<!doctype html><title>solution</title><p id="hello">worked solution</p>');
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', TEMP: os.tmpdir(), ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { let v = null; try { v = await fn(); } catch {} if (v) return v; if (Date.now() > end) return null; await sleep(60); } };

  await app.evaluate((_e, htmlPath) => {
    const a = global.__agent;
    global.__release = false;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // The task of a run (agent.js runTask): the events the Claude Code path emits. Everything around it is the real thing: run(), Stop (agent:stop ->
    // abort), the stop grace, 'done', main's view of the chat.
    a.runTask = async (messages, _tab, text, _images, controller, emit) => {
      const signal = controller.signal;
      messages.push({ role: 'user', content: text });
      const said = (t) => { emit({ type: 'text_block' }); emit({ type: 'text', text: t }); messages.push({ role: 'assistant', content: [{ type: 'text', text: t }] }); return t; };
      emit({ type: 'turn_start' });
      if (/STUCKHARD/.test(text)) { emit({ type: 'text', text: 'Working on it' }); await new Promise(() => {}); } // never ends, ignores Stop: no 'done' ever
      if (/STUCKSOFT/.test(text)) { // ends when stopped, as the real engine does
        emit({ type: 'text', text: 'Working on it' });
        await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
        emit({ type: 'notice', text: 'Stopped.', stopped: true });
      } else if (/FILECARD/.test(text)) { // the text, then the file card, then (when released) the reply is announced complete
        const t = said('Fixed: the page is done. Left standing: nothing.');
        await a.engineFiles(t, null, emit, { written: [htmlPath] });
        while (!global.__release) await wait(50);
        a.runs.get(messages).settling = true; // (as claudeCodeTurn does at reply_complete)
        emit({ type: 'reply_complete' });
        await wait(300); // (the CLI's last line)
      } else {
        said(`Answered: ${String(text).slice(-30)}`);
        a.runs.get(messages).settling = true;
        emit({ type: 'reply_complete' });
      }
    };
  }, html);

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(300);
  const state = () => ui.evaluate(() => ({
    running: document.getElementById('send').classList.contains('stop'),
    streaming: document.querySelectorAll('.msg.assistant.streaming').length,
    working: document.querySelectorAll('.working').length,
    queued: document.querySelectorAll('.queued-bubble').length,
    stopped: [...document.querySelectorAll('.notice.stopped')].map((n) => n.textContent),
    prompt: document.getElementById('prompt').value,
    promptDisabled: document.getElementById('prompt').disabled,
    copy: document.querySelectorAll('.msg.assistant .reply-copy').length,
    cards: document.querySelectorAll('.ai-files').length,
    text: [...document.querySelectorAll('.msg.assistant')].map((m) => m.textContent).join(' | '),
  }));
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };

  // ---- a. text, then a file card, then complete; a message queued meanwhile
  await send('FILECARD make the page');
  await ui.waitForSelector('.ai-files', { timeout: 10000 }).catch(() => {});
  await send('queued after the card');
  await ui.waitForSelector('.queued-bubble', { timeout: 5000 }).catch(() => {});
  let s = await state();
  check('a. the file card is under the text while the reply still runs, and the message waits', s.cards === 1 && s.running && s.queued === 1, JSON.stringify(s));
  check('a. the text before the card has no streaming dot (the card closed it)', s.streaming === 0, JSON.stringify(s));
  await app.evaluate(() => { global.__release = true; });
  await until(async () => /Answered: .*queued after the card/.test((await state()).text) && !(await state()).running, 15000);
  s = await state();
  check('a. the reply ended: no streaming dot, no working line, no underline', s.streaming === 0 && s.working === 0, JSON.stringify(s));
  check('a. the reply\'s actions are shown (copy)', s.copy >= 1, JSON.stringify(s));
  check('a. the queued message sent by itself and was answered; nothing waits', /Answered: .*queued after the card/.test(s.text) && s.queued === 0 && !s.running, JSON.stringify(s));
  check('a. the file card is still there', s.cards === 1, JSON.stringify(s));

  // ---- b. stuck, Stop does nothing in main: the screen ends it within 3 s, the queued text goes back to the box
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.waitForTimeout(300);
  await send('STUCKHARD please');
  await ui.waitForFunction(() => /Working on it/.test(document.body.textContent) && document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 });
  await send('queued while stuck');
  await ui.waitForSelector('.queued-bubble', { timeout: 5000 });
  // Timed in the page, from the click to the moment the reply shows as stopped and the composer is free: timed from here, Playwright's click
  // and the state() polls added about a second on a busy machine (the page had it done in 2014 ms, the test saw 3000).
  await ui.evaluate(() => {
    window.__stopTook = null;
    document.getElementById('send').addEventListener('click', () => {
      const at = performance.now();
      const done = () => document.querySelector('.notice.stopped') && !document.getElementById('send').classList.contains('stop');
      const mo = new MutationObserver(() => { if (done()) { mo.disconnect(); window.__stopTook = Math.round(performance.now() - at); } });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    }, { capture: true, once: true });
  });
  await ui.click('#send'); // the Stop button
  const ended = await until(async () => { const x = await state(); return !x.running && x.stopped.length ? x : null; }, 6000);
  const took = await ui.evaluate(() => window.__stopTook);
  s = await state();
  check('b. within 3 s the reply is marked stopped and the run state is cleared', Boolean(ended) && took !== null && took < 3000, JSON.stringify({ took, ...s }));
  check('b. the dot and the working line are gone', s.streaming === 0 && s.working === 0, JSON.stringify(s));
  check('b. the composer is usable', !s.promptDisabled, JSON.stringify(s));
  check('b. the queued text is in the composer as a draft, and was not sent', s.prompt.includes('queued while stuck') && s.queued === 0 && !/Answered: .*queued while stuck/.test(s.text), JSON.stringify(s));
  await ui.fill('#prompt', '');

  // ---- c. Send now while a reply is stuck
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.waitForTimeout(300);
  await send('STUCKSOFT go');
  await ui.waitForFunction(() => /Working on it/.test(document.body.textContent) && document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 });
  await send('send this one now');
  await ui.waitForSelector('.queued-bubble', { timeout: 5000 });
  await ui.locator('.queued-bubble .queue-btn', { hasText: 'Send now' }).click();
  await until(async () => /Answered: .*send this one now/.test((await state()).text) && !(await state()).running, 15000);
  s = await state();
  check('c. the stuck reply was stopped (marked interrupted)', s.stopped.some((t) => /Interrupted|Stopped/.test(t)), JSON.stringify(s));
  check('c. the queued message was sent and answered', /Answered: .*send this one now/.test(s.text) && s.queued === 0 && !s.running, JSON.stringify(s));
  check('c. nothing is left running; the box is empty', s.streaming === 0 && s.working === 0 && s.prompt === '', JSON.stringify(s));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
