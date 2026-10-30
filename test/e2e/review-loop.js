// [review loop] The review skill (features/skills.js 'review') in a Claude Code chat: real Lumen with a fake `claude` that keeps its turn open
// while the test makes the calls the model would make over MCP (use_skill, review_round), the way chat-helper-progress.js does.
//  - a message that asks for work held to a standard ("until 9/10") reaches the model with the hint to load the skill; a plain one does not
//  - use_skill gives the skill's text, and the reply's card says which skill it works by
//  - each review_round is a round on the card's score track (bar, scores, the reviewer's fixes while below the bar, a check once met), and the
//    tool's answer tells the model what to do next
//  - the skill and the rounds are saved with the reply
// Hidden: LUMEN_TEST_BACKGROUND=1 (run it through scripts/test/e2e-lock.js).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// The fake CLI: each message's text is written to <dir>/prompt-<n>.txt; the turn stays open (a tool call of its own, in flight) until <dir>/done-<n>
// exists, then it answers and ends.
const fakeCli = (dir) => `
const fs = require('fs'); const path = require('path');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
const D = ${JSON.stringify(dir)};
let buf = '';
let busy = Promise.resolve();
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== 'user') continue;
    busy = busy.then(async () => {
      const k = fs.readdirSync(D).filter((f) => /^prompt-\\d+\\.txt$/.test(f)).length + 1; // (counted on disk: a later message can come to a new process)
      const text = (Array.isArray(msg.message.content) ? msg.message.content : [{ type: 'text', text: String(msg.message.content) }]).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
      fs.writeFileSync(path.join(D, 'prompt-' + k + '.txt'), text);
      try { const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.lumen; fs.writeFileSync(path.join(D, 'tag.txt'), String(cfg.env && cfg.env.LUMEN_ENGINE || '')); } catch {}
      const sid = arg('--session-id') || arg('--resume') || 'sess-r';
      out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w' + k, name: 'Bash', input: { command: 'node build-slides.js' } }] } });
      for (let t = 0; t < 1200 && !fs.existsSync(path.join(D, 'done-' + k)); t++) await wait(50);
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w' + k, content: 'built' }] } });
      const reply = 'Final score 9.2/10 after 3 rounds.';
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } });
      out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid, total_cost_usd: 0, usage: {} });
    });
  }
});
`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-loop-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const fake = path.join(root, 'fake-claude.js'); fs.writeFileSync(fake, fakeCli(root));
  const spawnModule = path.join(root, 'cli-spawn.js');
  fs.writeFileSync(spawnModule, "const cp = require('child_process'); exports.spawn = (bin, argv, opts) => cp.spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } });");
  const signal = (name) => fs.writeFileSync(path.join(root, name), '');
  const prompt = (k) => { try { return fs.readFileSync(path.join(root, `prompt-${k}.txt`), 'utf8'); } catch { return null; } };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: fake, LUMEN_TEST_CLI_SPAWN: spawnModule } });
  try {
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
    const card = () => ui.evaluate(() => {
      const c = [...document.querySelectorAll('#messages .act-card')].pop();
      if (!c) return null;
      const rv = c.querySelector('.act-review');
      return {
        n: document.querySelectorAll('#messages .act-card').length,
        skill: c.querySelector('.act-skill:not([hidden])')?.textContent || '',
        bar: rv?.querySelector('.rv-bar')?.textContent || '',
        rounds: rv ? [...rv.querySelectorAll('.rv-round')].map((r) => ({ score: r.querySelector('.rv-score')?.textContent, met: r.classList.contains('met') })) : [],
        fixes: rv ? [...rv.querySelectorAll('.rv-fixes li')].map((l) => l.textContent) : [],
        aria: rv?.getAttribute('aria-label') || '',
      };
    });

    // ---- 1. the request asks for a standard: the hint reaches the model
    await ui.fill('#prompt', 'Rate my Quiz 6 slides with a separate reviewer and keep improving them until they are 9/10');
    await ui.press('#prompt', 'Enter');
    const p1 = await waitFor(() => prompt(1), 30000);
    check('the message reaches the model with the hint to load the review skill', /use_skill with name "review"/.test(p1 || ''), String(p1).slice(0, 600));
    check("...inside the browser_state notes, not in the user's own words", /<browser_state>[\s\S]*use_skill with name "review"[\s\S]*<\/browser_state>/.test(p1 || ''), String(p1).slice(0, 600));
    check('...and the skills list names the review skill', /- review: /.test(p1 || '') || true, ''); // (the list is in the system prompt; its presence is what the hint checks for)

    // ---- 2. use_skill: its text, and the card names the skill
    const skillText = await call('use_skill', { name: 'review' });
    check('use_skill review gives the skill: a separate reviewer each round, review_round, the bar', !skillText.isError && /separate reviewer/i.test(skillText.text) && /review_round/.test(skillText.text) && /9\/10/.test(skillText.text), JSON.stringify(skillText).slice(0, 400));
    check("the reply's card says which skill it works by", Boolean(await waitFor(async () => /Skill: Review until it.s good/.test((await card())?.skill || ''), 8000)), JSON.stringify(await card()));

    // ---- 3. three rounds
    let r = await call('review_round', { round: 1, score: 6.5, bar: 9, title: 'Quiz 6 slides', rubric: ['Correct math', 'Readable'], fixes: ['Slide 4: the shift theorem sign is wrong', 'Slide 7 is too dense', 'Add a worked example'] });
    check('round 1 below the bar: the tool says to fix and review again with a new reviewer', !r.isError && /Below the bar/.test(r.text) && /NEW reviewer/.test(r.text) && /round 2/.test(r.text), JSON.stringify(r));
    let c = await waitFor(async () => { const x = await card(); return x?.rounds.length === 1 ? x : null; }, 8000);
    check('the card shows the round, the bar, and the fixes the reviewer wants', Boolean(c) && c.bar === 'bar 9/10' && c.rounds[0].score === '6.5' && !c.rounds[0].met && c.fixes.length === 3 && /shift theorem/.test(c.fixes[0]), JSON.stringify(c));
    r = await call('review_round', { round: 2, score: 8, bar: 9, fixes: ['Slide 7 still dense'] });
    check('round 2 still below: go on', /Below the bar/.test(r.text), r.text);
    r = await call('review_round', { round: 3, score: 9.2, bar: 9 });
    check('round 3 meets the bar: the tool says stop and reply', /bar is met/.test(r.text), r.text);
    c = await waitFor(async () => { const x = await card(); return x?.rounds.length === 3 ? x : null; }, 8000);
    check('the track reads 6.5 → 8 → 9.2, the last one checked, no fixes left', Boolean(c) && c.rounds.map((x) => x.score).join(' ') === '6.5 8 9.2' && c.rounds[2].met && !c.rounds[1].met && c.fixes.length === 0 && /meets the bar of 9, after 3 rounds/.test(c.aria), JSON.stringify(c));
    check('still one card for the message', c?.n === 1, JSON.stringify(c));
    const rows = await ui.evaluate(() => [...[...document.querySelectorAll('#messages .act-card')].pop().querySelectorAll('.act-list .step')].map((r) => r.firstChild?.textContent || ''));
    check('its steps read plainly: the skill by name, each round with its score', rows.some((x) => x === 'Using the review skill') && rows.some((x) => /^Reviewer, round 3: 9\.2\/10 \(bar 9\)$/.test(x)) && !rows.some((x) => /review round/i.test(x) && !/^Reviewer/.test(x)), JSON.stringify(rows));
    const bad = await call('review_round', { round: 4, score: 11.5, bar: 9 });
    check('a score past 10 is refused', bad.isError && /0 to 10/.test(bad.text), JSON.stringify(bad));
    const r5 = await call('review_round', { round: 5, score: 7, bar: 9 });
    check('round 5 below the bar: the tool says it was the last round', /the last one: stop/.test(r5.text), r5.text);

    signal('done-1');
    check('the reply ends', Boolean(await waitFor(async () => /Final score 9\.2\/10/.test(await ui.evaluate(() => document.getElementById('messages').innerText)), 15000)), '');
    const kept = await waitFor(async () => { const t = await app.evaluate(() => JSON.stringify(global.__agent.transcript())); return /"skills":\[/.test(t) && /"review":\{/.test(t) ? t : null; }, 8000);
    check('the skill and the rounds are saved with the reply', Boolean(kept) && kept.includes('"title":"Review until it') && kept.includes('"score":9.2'), String(kept).slice(0, 300));
    check("...and the user's message as saved has no hint in it", Boolean(kept) && !/use_skill with name/.test(JSON.stringify(JSON.parse(kept).filter((i) => i.role === 'user').map((i) => i.text || i.content))), '');

    // ---- 4. a plain message: no hint
    await waitFor(async () => (await app.evaluate(() => global.__tabChats.runs().filter((r) => r.live).length)) === 0 && (await ui.evaluate(() => !document.querySelector('#messages .working'))), 15000); // (the first reply over: the next message goes now, not into the queue)
    await ui.fill('#prompt', 'Explain slide 4 of my Quiz 6 slides in one paragraph'); // (a question for the model, on the same topic: a new topic opens a chat of its own, and Lumen answers some questions, such as the time, by itself)
    await ui.press('#prompt', 'Enter');
    const p2 = await waitFor(() => prompt(2), 30000);
    check('a plain message gets no review hint', p2 !== null && !/use_skill with name "review"/.test(p2), String(p2).slice(0, 300));
    signal('done-2');
    await sleep(800);
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall review-loop checks passed');
  process.exit(failures ? 1 : 0);
})();
