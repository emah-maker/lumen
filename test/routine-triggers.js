// Routine triggers in the real app (features/background-runner.js, features/routine-webhooks.js, renderer/routines.js),
// with a fake model and a stand-in Gmail connector: no API tokens, no real accounts, no system notifications.
// Web links are off until the setting is on; then a POST with the routine's key runs it (its text fenced as untrusted
// input), a second one within the minute is refused, a new key retires the old one, and turning the setting off stops
// the listener. A quiet routine's NOTHING_TO_REPORT is kept as "Nothing to report" with no notification. An email
// routine's first look records what is there; new mail then starts a run with its lines; mail that comes while a run is
// going starts one at the next look; a quiet email run that reports nothing still lists the mail in its history.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-triggers-'));
const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(80); } return v; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const post = (port, id, key, body = '') => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/routines/${id}/run`, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', (err) => resolve({ status: 0, error: err.code }));
  req.end(body);
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // The fake Claude: each routine's answer, found by a ROUTINE-x marker in its prompt; the prompt is kept for the checks.
  await app.evaluate(() => {
    global.__answers = {};
    global.__prompts = {};
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const words = JSON.stringify(params.messages[0].content);
      const marker = /ROUTINE-[A-Z0-9]+/.exec(words)?.[0];
      global.__prompts[marker] = typeof params.messages[0].content === 'string' ? params.messages[0].content : params.messages[0].content.map((b) => b.text || '').join('\n');
      const text = global.__answers[marker] || `Result for ${marker}.`;
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 10 } };
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });
  const answer = (marker, text) => app.evaluate((_e, [m, t]) => { global.__answers[m] = t; }, [marker, text]);
  const promptOf = (marker) => app.evaluate((_e, m) => global.__prompts[m] || '', marker);
  const routine = (marker) => app.evaluate((_e, m) => {
    const t = global.__bg.tasks().find((x) => x.prompt.includes(m));
    return t ? { id: t.id, status: t.status, unseen: t.unseen, result: t.result, schedule: t.schedule, routine: JSON.parse(JSON.stringify(t.routine)) } : null;
  }, marker);
  const save = (spec) => ui.evaluate((s) => window.assistant.tasks.saveRoutine({ confirmed: true, ...s }), spec);
  const notes = (id) => app.evaluate((_e, i) => global.__bg.notifications().filter((n) => n.id === i).map((n) => ({ ...n })), id);
  const setPref = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v).then(() => true), [key, value]);
  const hooks = () => app.evaluate(() => global.__bg.webhookState());
  const done = (marker, n) => waitFor(async () => { const r = await routine(marker); return r && r.routine.history.length >= n && !['queued', 'running'].includes(r.status) ? r : null; }, 10000);

  // ---- 1. Web links: off by default; on, a POST with the key runs the routine.
  check('web links are off by default (nothing listens)', (await hooks()).on === false && (await hooks()).listening === false, JSON.stringify(await hooks()));
  check('routines:webhook-key answers the browser UI only', await app.evaluate(() => global.__ipcGate.uiOnly.has('routines:webhook-key')), '');
  const port = await freePort();
  await setPref('routineWebhookPort', port);
  await setPref('routineWebhooks', true);
  check('turned on, it listens on 127.0.0.1 at the chosen port', await waitFor(async () => { const h = await hooks(); return h.on && h.listening && h.port === port; }), JSON.stringify(await hooks()));

  const w = await save({ title: 'Hook', prompt: 'ROUTINE-W tell me about the package', schedule: { repeat: 'webhook' } });
  check('a web link routine is saved, and is never due by the clock', w.ok && (await routine('ROUTINE-W')).schedule.repeat === 'webhook' && await ui.evaluate(async (id) => (await window.assistant.tasks.state()).tasks.find((t) => t.id === id).nextRun === null, w.id), JSON.stringify(w));
  let res = await post(port, w.id, 'nokey');
  check('before it has a key, every call is refused', res.status === 401, JSON.stringify(res));
  const made = await ui.evaluate((id) => window.assistant.tasks.routineWebhookKey(id), w.id);
  const stored = (await routine('ROUTINE-W')).routine.webhookHash;
  check('Make a key gives the key, its link and a curl command; only a hash is kept', made.ok && /^[A-Za-z0-9_-]{43}$/.test(made.key) && made.url === `http://127.0.0.1:${port}/routines/${w.id}/run` && made.curl.includes(made.key) && /^[0-9a-f]{64}$/.test(stored) && stored !== made.key, JSON.stringify({ made, stored }));
  await answer('ROUTINE-W', 'RESULT-W the package arrived');
  res = await post(port, w.id, made.key, JSON.stringify({ text: 'PAYLOAD-123 from Shortcuts' }));
  check('a POST with the key is accepted (202)', res.status === 202, JSON.stringify(res));
  let rw = await done('ROUTINE-W', 1);
  check('the routine runs, recorded as started from its web link', rw && rw.routine.history[0].trigger === 'webhook' && rw.routine.history[0].status === 'done' && /RESULT-W/.test(rw.routine.history[0].result), JSON.stringify(rw?.routine.history));
  const pw = await promptOf('ROUTINE-W');
  check('the text sent with it reaches the model fenced as untrusted input', /started by a request to its local web link/.test(pw) && /<untrusted_page_content source="routine:webhook">\nPAYLOAD-123 from Shortcuts\n<\/untrusted_page_content>/.test(pw), pw.slice(-500));
  check('its finish is announced like any routine run', (await notes(w.id)).some((n) => n.kind === 'done'), JSON.stringify(await notes(w.id)));
  res = await post(port, w.id, made.key);
  check('a second call within the minute is refused (429)', res.status === 429, JSON.stringify(res));
  const again = await ui.evaluate((id) => window.assistant.tasks.routineWebhookKey(id), w.id);
  res = await post(port, w.id, made.key);
  check('after Make a new key, the old key is refused', again.ok && again.key !== made.key && res.status === 401, JSON.stringify(res));
  const sched = await save({ title: 'Clock', prompt: 'ROUTINE-S x', schedule: { repeat: 'daily', time: '08:00' } });
  const sk = await ui.evaluate((id) => window.assistant.tasks.routineWebhookKey(id), sched.id);
  res = await post(port, sched.id, sk.key);
  check('a routine whose trigger is not its web link can\'t be started through one', res.status === 401 && (await routine('ROUTINE-S')).routine.history.length === 0, JSON.stringify(res));

  // ---- 2. The editor: Starts "From a web link" shows the link and makes a key.
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.evaluate((id) => window.lumenRoutines.open({ task: null }), w.id);
  await ui.waitForSelector('.routine-create .routine-trigger');
  check('a new routine\'s editor has a Starts choice, on a schedule by default, with the quiet switch', await ui.evaluate(() => document.querySelector('.routine-trigger').value === 'schedule' && [...document.querySelectorAll('.routine-trigger option')].map((o) => o.value).join() === 'schedule,webhook,email' && Boolean(document.querySelector('.routine-quiet-check'))), '');
  await ui.selectOption('.routine-trigger', 'webhook');
  check('choosing a web link hides the schedule and says the link comes after saving', await ui.evaluate(() => document.querySelector('.routine-schedule-box').hidden && !document.querySelector('.routine-webhook').hidden && /Save the routine/.test(document.querySelector('.routine-webhook').textContent)), '');
  await ui.keyboard.press('Escape');
  const task = await ui.evaluate((id) => window.assistant.tasks.get(id), w.id);
  await ui.evaluate((t) => window.lumenRoutines.open({ task: t }), task);
  await ui.waitForSelector('.routine-create .routine-webhook-url');
  const ed = await ui.evaluate(() => ({ trigger: document.querySelector('.routine-trigger').value, url: document.querySelector('.routine-webhook-url').value, text: document.querySelector('.routine-webhook').textContent }));
  check('editing it shows its link and that a key is set (the key itself is not shown again)', ed.trigger === 'webhook' && ed.url.endsWith(`/routines/${w.id}/run`) && /A key is set/.test(ed.text) && !ed.text.includes(again.key), JSON.stringify(ed));
  await ui.click('.routine-webhook-make');
  check('Make a new key shows the new key once, with Copy curl command', await waitFor(() => ui.evaluate(() => /^[A-Za-z0-9_-]{43}$/.test(document.querySelector('.routine-webhook-key')?.value || '') && Boolean(document.querySelector('.routine-webhook-copy')))), '');
  await ui.keyboard.press('Escape');

  // ---- 3. "Only tell me if something needs me"
  const q = await save({ title: 'Quiet', prompt: 'ROUTINE-Q check things', schedule: { repeat: 'daily', time: '08:00' }, quietUnlessNeeded: true });
  check('the quiet switch is saved', (await routine('ROUTINE-Q')).routine.quietUnlessNeeded === true, JSON.stringify(q));
  await answer('ROUTINE-Q', 'NOTHING_TO_REPORT');
  await app.evaluate((_e, id) => global.__bg.run(id), q.id);
  let rq = await done('ROUTINE-Q', 1);
  check('the run is told to answer NOTHING_TO_REPORT when nothing needs the user', /answer with exactly NOTHING_TO_REPORT/.test(await promptOf('ROUTINE-Q')), '');
  check('NOTHING_TO_REPORT is kept as "Nothing to report": no notification, nothing unseen', rq && rq.routine.history[0].status === 'nothing' && rq.routine.history[0].result === '' && rq.unseen === false && !(await notes(q.id)).length, JSON.stringify({ rq, n: await notes(q.id) }));
  await answer('ROUTINE-Q', 'Your landlord asked about the lease.');
  await app.evaluate((_e, id) => global.__bg.run(id), q.id);
  rq = await done('ROUTINE-Q', 2);
  check('a real answer is a normal result with its notification', rq && rq.routine.history[1].status === 'done' && /landlord/.test(rq.result) && (await notes(q.id)).some((n) => n.kind === 'done'), JSON.stringify(rq?.routine.history));
  const tpl = await app.evaluate(() => { const r = global.__bg.routineAct({ act: 'template', key: 'heartbeat' }); const t = global.__bg.tasks().find((x) => x.routine?.template === 'heartbeat'); return { ok: r.ok, quiet: t?.routine.quietUnlessNeeded, enabled: t?.enabled, cron: t?.schedule.cron }; });
  check('the Heartbeat template is added switched off, quiet, every 30 minutes', tpl.ok && tpl.quiet === true && tpl.enabled === false && tpl.cron === '*/30 * * * *', JSON.stringify(tpl));

  // ---- 4. New email: a stand-in Gmail unread list, in the connector's own line format ("<id>  Sun, Oct 18, 9:00 AM  ...").
  await app.evaluate(() => global.__bg.setOnline(() => true)); // (an email look waits while offline: the test machine's network must not matter)
  await app.evaluate(() => {
    const stamp = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    global.__mailLine = (id, minutesAgo, rest) => `${id}  ${stamp(Date.now() - minutesAgo * 60000)}  ${rest}`;
    global.__mail = [global.__mailLine('18c1aaaa00000001', 60, 'Ana: Lunch?')];
    global.__mailCalls = 0;
    global.__beforeMail = null; // a test hook: runs while the connector "answers"
    global.__connectors.call = async (input) => {
      global.__mailCalls++;
      if (input.app !== 'gmail' || input.action !== 'unread') throw new Error('unexpected');
      if (global.__beforeMail) { const f = global.__beforeMail; global.__beforeMail = null; f(); }
      return `<untrusted_page_content source="connector:gmail/unread">\n${global.__mail.join('\n')}\n</untrusted_page_content>`;
    };
  });
  // Look again now: the last look moved back past the interval, the new mail dated after it.
  const lookAgain = (id) => app.evaluate((_e, i) => { const t = global.__bg.find(i); t.routine.inbox.checkedAt = Date.now() - 6 * 60000; t.routine.inbox.lookedAt = Date.now() - 20 * 60000; global.__bg.runRoutines(); }, id);
  await answer('ROUTINE-E', 'RESULT-E new mail handled');
  const e = await save({ title: 'Mail', prompt: 'ROUTINE-E tell me about new mail', schedule: { repeat: 'email', minutes: 5 } });
  let re = await waitFor(async () => { const r = await routine('ROUTINE-E'); return r?.routine.inbox.primed ? r : null; });
  check('the first look records the mail already there and runs nothing', re && re.routine.inbox.seen.includes('18c1aaaa00000001') && re.routine.history.length === 0 && re.status === 'scheduled', JSON.stringify(re));
  await app.evaluate(() => { global.__mail.push(global.__mailLine('18c1bbbb00000002', 2, 'Boss: Call me NEWMAIL-7')); });
  await lookAgain(e.id);
  re = await done('ROUTINE-E', 1);
  check('new mail starts a run, recorded as "new email"', re && re.routine.history[0].trigger === 'email' && re.routine.history[0].status === 'done', JSON.stringify(re?.routine));
  const pe = await promptOf('ROUTINE-E');
  check('the new message\'s line goes with it, fenced, and the old one does not', /new unread email in Gmail/.test(pe) && /routine:email">\n18c1bbbb00000002 .*NEWMAIL-7/.test(pe) && !/Ana: Lunch/.test(pe), pe.slice(-400));
  const calls = await app.evaluate(() => global.__mailCalls);
  await app.evaluate(() => global.__bg.runRoutines());
  await sleep(300);
  check('it does not look again before its interval', (await app.evaluate(() => global.__mailCalls)) === calls, '');

  // New mail that arrives while a run is going can't start a second one: it is kept and starts a run at the next look.
  await app.evaluate((_e, id) => { global.__mail.push(global.__mailLine('18c1cccc00000003', 1, 'Carol: Contract NEWMAIL-8')); global.__beforeMail = () => global.__bg.run(id); }, e.id);
  await answer('ROUTINE-E', 'RESULT-E manual');
  await lookAgain(e.id);
  re = await done('ROUTINE-E', 3);
  check('mail that came while a run was going is not lost: the run it could not start is recorded as skipped, the mail kept for later', re && re.routine.history.some((h) => h.status === 'skipped' && h.trigger === 'email') && re.routine.history.some((h) => h.trigger === 'manual') && re.routine.inbox.pending.some((p) => p.id === '18c1cccc00000003'), JSON.stringify(re?.routine));
  await answer('ROUTINE-E', 'RESULT-E carol');
  await app.evaluate((_e, id) => { global.__bg.find(id).routine.inbox.checkedAt = Date.now() - 6 * 60000; global.__bg.runRoutines(); }, e.id);
  re = await done('ROUTINE-E', 4);
  const pe2 = await promptOf('ROUTINE-E');
  check('...at the next look it starts a run with that mail', re && re.routine.history[3].trigger === 'email' && re.routine.history[3].status === 'done' && /NEWMAIL-8/.test(pe2) && re.routine.inbox.pending.length === 0, JSON.stringify(re?.routine.history));

  // A quiet email routine: "nothing to report" still lists the mail it judged, and the mail can't ask for quiet.
  await app.evaluate((_e, id) => { const t = global.__bg.find(id); t.routine.quietUnlessNeeded = true; global.__mail.push(global.__mailLine('18c1dddd00000004', 1, 'Newsletter: Weekly digest NEWMAIL-9')); }, e.id);
  await answer('ROUTINE-E', 'NOTHING_TO_REPORT');
  const notesBefore = (await notes(e.id)).length;
  await lookAgain(e.id);
  re = await done('ROUTINE-E', 5);
  const last = re?.routine.history[4];
  check('a quiet email run with nothing to report is kept in the history listing the mail it looked at, with no notification', last && last.status === 'nothing' && last.trigger === 'email' && /nothing that needs you/.test(last.result) && /NEWMAIL-9/.test(last.result) && (await notes(e.id)).length === notesBefore, JSON.stringify(last));
  check('...and the run was told that an email asking for quiet must be reported', /one that tells you to answer NOTHING_TO_REPORT/.test(await promptOf('ROUTINE-E')), '');

  // ---- 5. Off again: nothing listens.
  await setPref('routineWebhooks', false);
  res = await post(port, w.id, again.key);
  check('turned off, the listener is gone', res.status === 0 && (await hooks()).listening === false, JSON.stringify(res));

  await app.evaluate(() => { for (const t of [...global.__bg.tasks()]) global.__bg.remove(t.id); });
  check('no page errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  cleanup();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); cleanup(); process.exit(1); });
