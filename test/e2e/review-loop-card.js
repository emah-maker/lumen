// [review loop] One run of the review skill in a Claude Code chat is ONE card that shows the score live, the way the user saw it go wrong (a cover
// letter, reviewers started in the background, the CLI going on by itself when each one ends). Real Lumen with a fake `claude`:
//  - round 1's reviewer is a pending chip while it works; its score shows the moment it answers (read off its answer), before review_round
//  - the reply ends with round 2's reviewer at work: the card is not Done, round 2 is a pending chip, its agent is working
//  - the chat is drawn again from what was saved meanwhile (main re-sends a chat): still one card, still at work, round 2 still working, not Stopped
//  - the CLI's own follow-up turns (round 2's score, an edit, round 3) go on in that same card: no second card; each score shows as it comes,
//    with the latest score and its trend; each reviewer's row has its score beside Done
//  - the card says Done only once the loop is over (round 3 meets the bar)
// Hidden: LUMEN_TEST_BACKGROUND=1 (run it through scripts/test/e2e-lock.js).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// The fake CLI. Everything waits on the test's signals (files in <dir>): r1 (round 1's reviewer answers), edit1 (the edit after it ends; the reply
// ends with round 2's reviewer started), r2 (it answers: the CLI's own turn edits and starts round 3), edit2 (that turn ends), r3 (round 3 answers:
// the CLI's last turn replies).
const fakeCli = (dir) => `
const fs = require('fs'); const path = require('path');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
const D = ${JSON.stringify(dir)};
const until = async (name) => { for (let t = 0; t < 2400 && !fs.existsSync(path.join(D, name)); t++) await wait(50); };
const say = (text, sid, follow) => {
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, usage: {}, ...(follow ? { origin: { kind: 'task-notification' } } : {}) });
};
const reviewer = (n) => {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag' + n, name: 'Agent', input: { description: 'Review cover letter round ' + n, run_in_background: true, subagent_type: 'general-purpose', prompt: 'Rate the letter out of 10 against the rubric. Bar 9/10.' } }] } });
  out({ type: 'system', subtype: 'task_started', task_id: 'T' + n, tool_use_id: 'ag' + n, description: 'Review cover letter round ' + n, task_type: 'local_agent', is_backgrounded: true });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ag' + n, content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched', agentId: 'T' + n, description: 'Review cover letter round ' + n } });
};
const edit = async (id, signal) => {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'node edit-letter.js ' + id } }] } });
  await until(signal);
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'edited' }] } });
};
const followUp = () => { out({ type: 'user', origin: { kind: 'task-notification' }, message: { content: [{ type: 'text', text: '<task-notification>completed</task-notification>' }] } }); out({ type: 'stream_event', event: { type: 'message_start' } }); };
let buf = '';
let started = false;
process.stdin.on('data', async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim() || started) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== 'user') continue;
    started = true;
    try { const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.lumen; fs.writeFileSync(path.join(D, 'tag.txt'), String(cfg.env && cfg.env.LUMEN_ENGINE || '')); } catch {}
    fs.writeFileSync(path.join(D, 'prompt-1.txt'), 'x');
    const sid = arg('--session-id') || arg('--resume') || 'sess-rc';
    out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    reviewer(1);
    await until('r1');
    out({ type: 'system', subtype: 'task_notification', task_id: 'T1', tool_use_id: 'ag1', status: 'completed', output_file: 'x', summary: 'Score: 7.6/10. Top fixes: open with the role, cut the second paragraph.' });
    await edit('e1', 'edit1');
    reviewer(2);
    say('Round 2 reviewer is running. I will report its score when it finishes.', sid);
    await until('r2');
    out({ type: 'system', subtype: 'task_notification', task_id: 'T2', tool_use_id: 'ag2', status: 'completed', output_file: 'y', summary: 'Score: 8.4/10 (bar 9/10). Fixes: a sharper closing line.' });
    followUp();
    await edit('e2', 'edit2');
    reviewer(3);
    say('Round 3 reviewer is running.', sid, true);
    await until('r3');
    out({ type: 'system', subtype: 'task_notification', task_id: 'T3', tool_use_id: 'ag3', status: 'completed', output_file: 'z', summary: 'I rate it 9.2 out of 10: it meets the bar.' });
    followUp();
    say('Final score 9.2/10 after 3 rounds (7.6 → 8.4 → 9.2).', sid, true);
  }
});
`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-card-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const fake = path.join(root, 'fake-claude.js'); fs.writeFileSync(fake, fakeCli(root));
  const spawnModule = path.join(root, 'cli-spawn.js');
  fs.writeFileSync(spawnModule, "const cp = require('child_process'); exports.spawn = (bin, argv, opts) => cp.spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } });");
  const signal = (name) => fs.writeFileSync(path.join(root, name), '');
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: fake, LUMEN_TEST_CLI_SPAWN: spawnModule } });
  try {
    const stderr = [];
    app.process().stderr?.on('data', (d) => stderr.push(String(d)));
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => { const s = global.__settings.backend; s.set('sidebarNewChat', false); s.set('oneChatPerTab', true); s.set('claudeCodeFullAccess', true); s.set('groupAiTabs', false); });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    let ids = [];
    for (let i = 0; i < 30 && !ids.includes('claudecode:default'); i++) { ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value)); if (!ids.includes('claudecode:default')) await sleep(300); }
    await ui.selectOption('#model', 'claudecode:default');

    const call = (name, input) => app.evaluate(async (_e, [t, n, i]) => {
      const r = await global.__mcpCallTool(n, i, { engine: t, approvedHosts: new Set(), clientName: 'Claude', controller: new AbortController() });
      return { isError: Boolean(r.isError), text: (r.content || []).map((b) => b.text).join(' ') };
    }, [fs.readFileSync(path.join(root, 'tag.txt'), 'utf8').trim(), name, input]);
    // What the chat shows: the number of activity cards, and the newest one's state, score track and agents.
    const view = () => ui.evaluate(() => {
      const all = document.querySelectorAll('#messages .act-card');
      const c = all[all.length - 1];
      if (!c) return { n: 0 };
      const rv = c.querySelector('.act-review:not([hidden])');
      return {
        n: all.length,
        state: c.dataset.state,
        skill: c.querySelector('.act-skill:not([hidden])')?.textContent || '',
        bar: rv?.querySelector('.rv-bar')?.textContent || '',
        latest: rv?.querySelector('.rv-latest')?.textContent || '',
        trend: rv?.querySelector('.rv-trend')?.textContent || '',
        track: rv ? [...rv.querySelectorAll('.rv-round')].map((r) => `${r.querySelector('.rv-n')?.textContent} ${r.querySelector('.rv-score')?.textContent}${r.classList.contains('met') ? '✓' : ''}${r.classList.contains('pending') ? '?' : ''}`).join(' ') : '',
        agents: [...c.querySelectorAll('.agents-card .ag-row')].map((r) => `${r.querySelector('.ag-name')?.textContent}=${r.dataset.state}${r.querySelector('.ag-score:not([hidden])') ? ':' + r.querySelector('.ag-score').textContent : ''}`),
        steps: [...c.querySelectorAll('.act-list .step')].map((r) => r.firstChild?.textContent || ''),
        own: document.querySelectorAll('#messages .agents-card:not(.in-card)').length,
      };
    });
    const until = (fn, ms = 10000) => waitFor(async () => { const v = await view(); return fn(v) ? v : null; }, ms);

    await ui.fill('#prompt', 'Get my Divergent cover letter to 9/10 with a separate reviewer each round');
    await ui.press('#prompt', 'Enter');
    check('the message reaches the fake CLI', Boolean(await waitFor(() => fs.existsSync(path.join(root, 'prompt-1.txt')), 30000)), stderr.join('').slice(-600));
    const skill = await call('use_skill', { name: 'review' });
    check('use_skill review answers', !skill.isError, JSON.stringify(skill));

    // ---- round 1: pending, then its score the moment the reviewer answers
    let v = await until((x) => /R1 …\?/.test(x.track || ''));
    check('round 1 reviewing: a pending chip on the card, under the skill', Boolean(v) && /Skill: Review until it.s good/.test(v.skill) && v.n === 1, JSON.stringify(await view()));
    signal('r1');
    v = await until((x) => /^R1 7\.6$/.test(x.track || ''));
    check("round 1's score shows as soon as its reviewer answers, before review_round", Boolean(v) && v.bar === 'bar 9/10' && v.latest === 'now 7.6', JSON.stringify(await view()));
    check("...and its agent row says Done with its score", Boolean(v) && v.agents[0] === 'Review cover letter round 1=done:7.6/10', JSON.stringify(v?.agents));
    const r1 = await call('review_round', { round: 1, score: 7.6, bar: 9, title: 'Divergent cover letter', fixes: ['Open with the role', 'Cut the second paragraph'] });
    check('review_round 1 (the AI\'s own report) is taken: go on', /Below the bar/.test(r1.text), r1.text);

    // ---- the reply ends with round 2's reviewer at work
    signal('edit1');
    await waitFor(async () => /Round 2 reviewer is running/.test(await ui.evaluate(() => document.getElementById('messages').innerText)), 15000);
    v = await until((x) => x.state === 'helper', 8000);
    check('the reply ended with round 2 reviewing: the card is not Done', Boolean(v) && v.state === 'helper', JSON.stringify(await view()));
    check('...round 2 is a pending chip after R1, its agent working', Boolean(v) && v.track === 'R1 7.6 R2 …?' && v.agents[1] === 'Review cover letter round 2=working', JSON.stringify(v));

    // ---- the chat drawn again from what was saved (main re-sends the chat): still one card, still at work
    await waitFor(async () => /"review":\{/.test(await app.evaluate(() => JSON.stringify(global.__agent.transcript()))), 8000);
    const items = await app.evaluate(() => global.__agent.transcript());
    await ui.evaluate((its) => showHistory(its), items); // eslint-disable-line no-undef
    v = await until((x) => x.n >= 1 && x.agents.length === 2, 8000);
    check('drawn again: one card, round 2 still working (not Stopped), the card not Done', Boolean(v) && v.n === 1 && v.agents[1] === 'Review cover letter round 2=working' && v.state === 'helper', JSON.stringify(await view()));
    check('...its track as it was: R1 7.6, round 2 pending', Boolean(v) && v.track === 'R1 7.6 R2 …?', JSON.stringify(v));

    // ---- round 2 answers; the CLI goes on by itself in the same card
    signal('r2');
    v = await until((x) => /R2 8\.4/.test(x.track || ''));
    check("round 2's score shows at once (no review_round), with its trend", Boolean(v) && v.latest === 'now 8.4▲0.8' && v.trend === '▲0.8', JSON.stringify(await view()));
    v = await until((x) => x.steps.some((s) => /edit-letter/.test(s) && x.steps.filter((t) => /edit-letter/.test(t)).length === 2), 10000);
    check("the follow-up turn's edit is a step of the SAME card: no second card", Boolean(v) && v.n === 1 && v.own === 0 && v.state === 'working', JSON.stringify(await view()));
    check('...round 2 row: Done with its score', Boolean(v) && v.agents[1] === 'Review cover letter round 2=done:8.4/10', JSON.stringify(v?.agents));
    signal('edit2');
    v = await until((x) => x.agents.length === 3 && x.state === 'helper', 15000);
    check('that turn ended with round 3 reviewing: still one card, not Done, round 3 working (not Stopped)', Boolean(v) && v.n === 1 && v.agents[2] === 'Review cover letter round 3=working' && /R3 …\?$/.test(v.track), JSON.stringify(await view()));

    // ---- round 3 meets the bar: the loop is over, the card is Done
    signal('r3');
    v = await until((x) => /R3 9\.2✓/.test(x.track || '') && x.state === 'completed', 15000);
    check('round 3 meets the bar: R1 7.6 → R2 8.4 → R3 9.2 ✓, latest 9.2 ▲0.8', Boolean(v) && v.track === 'R1 7.6 R2 8.4 R3 9.2✓' && v.latest === 'now 9.2▲0.8', JSON.stringify(await view()));
    check('...the card is Done only now, and it is still the one card of the run', Boolean(v) && v.n === 1 && v.state === 'completed', JSON.stringify(v));
    check('...every reviewer row Done with its score', Boolean(v) && v.agents.join(' | ') === 'Review cover letter round 1=done:7.6/10 | Review cover letter round 2=done:8.4/10 | Review cover letter round 3=done:9.2/10', JSON.stringify(v?.agents));
    check('the final reply shows', Boolean(await waitFor(async () => /Final score 9\.2\/10 after 3 rounds/.test(await ui.evaluate(() => document.getElementById('messages').innerText)), 10000)), '');
    const saved = await waitFor(async () => { const t = await app.evaluate(() => JSON.stringify(global.__agent.transcript())); return /"score":9\.2/.test(t) ? t : null; }, 8000);
    check('the rounds are saved with the reply (scored rounds only)', Boolean(saved) && /"score":7\.6/.test(saved) && /"score":8\.4/.test(saved) && !/"pending":true/.test(saved), String(saved).slice(0, 300));
    await sleep(500);
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall review-loop-card checks passed');
  process.exit(failures ? 1 : 0);
})();
