// [background helpers] A Claude Code chat whose reply starts a helper in the background (an Agent call with run_in_background) and ends at once:
// real Lumen with a fake `claude` that prints what the CLI's documentation says it prints for that (see test/units/cc-helpers-units.js).
//  - the reply's card does not say "Done": it says a helper is working (state "helper"), the chat is free to take messages meanwhile
//  - the helper's own steps appear on that card as they happen, a Lumen tool call it makes over MCP too (it reaches the chat, not "no message in progress")
//  - when the helper ends the card is Done, and the CLI's own follow-up turn lands in the SAME chat as a reply of its own (no new chat, no new
//    user bubble), saved with the chat
//  - a helper whose process dies is stopped, not left spinning
// Hidden: LUMEN_TEST_BACKGROUND=1 (run it through scripts/test/e2e-lock.js).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// The fake CLI. The first message starts the helper and ends the turn. Everything after the result happens on the test's signals (files in
// <dir>): step1 (the helper starts a tool call), step2 (its result), end (the helper ends, and the CLI goes on by itself), die (the process exits).
const fakeCli = (dir) => `
const fs = require('fs'); const path = require('path');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
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
    try { const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.lumen; fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'tag.txt'), String(cfg.env && cfg.env.LUMEN_ENGINE || '')); } catch {}
    const sid = arg('--session-id') || arg('--resume') || 'sess-h';
    out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Review Laplace quiz slides', run_in_background: true, subagent_type: 'general-purpose', prompt: 'Rate the deck out of 10.' } }] } });
    out({ type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'ag1', description: 'Review Laplace quiz slides', task_type: 'local_agent', is_backgrounded: true });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched', agentId: 'T1', description: 'Review Laplace quiz slides' } });
    const first = 'A separate reviewer agent is now checking the deck.';
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: first }], stop_reason: 'end_turn' } });
    out({ type: 'result', subtype: 'success', is_error: false, result: first, session_id: sid, total_cost_usd: 0, usage: {} });
    // ---- after the result: the helper works
    const seen = new Set();
    for (let tick = 0; tick < 2400; tick++) {
      for (const name of ['step1', 'step2', 'die', 'end']) {
        if (seen.has(name) || !fs.existsSync(path.join(${JSON.stringify(dir)}, name))) continue;
        seen.add(name);
        if (name === 'step1') out({ type: 'assistant', parent_tool_use_id: 'ag1', message: { content: [{ type: 'tool_use', id: 'h1', name: 'Read', input: { file_path: 'C:/deck/slide3.txt' } }] } });
        else if (name === 'step2') out({ type: 'user', parent_tool_use_id: 'ag1', message: { content: [{ type: 'tool_result', tool_use_id: 'h1', content: 'slide text' }] } });
        else if (name === 'die') process.exit(3);
        else {
      out({ type: 'system', subtype: 'task_notification', task_id: 'T1', tool_use_id: 'ag1', status: 'completed', output_file: 'x', summary: 'The deck is rated 9/10' });
      const second = 'The reviewer rated the deck 9/10.';
      out({ type: 'user', origin: { kind: 'task-notification' }, message: { content: [{ type: 'text', text: '<task-notification>completed</task-notification>' }] } });
      out({ type: 'stream_event', event: { type: 'message_start' } });
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: second } } });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: second }], stop_reason: 'end_turn' } });
      out({ type: 'result', subtype: 'success', is_error: false, result: second, session_id: sid, total_cost_usd: 0, usage: {}, origin: { kind: 'task-notification' } });
      await wait(200);
      process.exit(0);
        }
      }
      await wait(50);
    }
  }
});
`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cchelp-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const fake = path.join(root, 'fake-claude.js'); fs.writeFileSync(fake, fakeCli(root));
  const spawnModule = path.join(root, 'cli-spawn.js'); // what the engines call in place of child_process.spawn (features/ai-agents.js cliSpawn)
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

    const text = () => ui.evaluate(() => document.getElementById('messages').innerText);
    const running = () => app.evaluate(() => global.__tabChats.runs().filter((r) => r.live).length);
    const cardState = () => ui.evaluate(() => document.querySelector('#messages .act-card')?.dataset.state || '');
    const cardStatus = () => ui.evaluate(() => document.querySelector('#messages .act-card .act-status-text')?.textContent || '');
    const cardSub = () => ui.evaluate(() => document.querySelector('#messages .act-card .act-sub')?.textContent || '');
    const stepRows = () => ui.evaluate(() => [...document.querySelectorAll('#messages .act-card .act-list .step')].map((r) => ({ text: r.firstChild?.textContent || '', cls: r.className })));
    const chatId = () => app.evaluate(() => global.__tabChats.chatId());

    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    let ids = [];
    for (let i = 0; i < 30 && !ids.includes('claudecode:default'); i++) { ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value)); if (!ids.includes('claudecode:default')) await sleep(300); }
    await ui.selectOption('#model', 'claudecode:default');
    const chat = await chatId();
    await ui.fill('#prompt', 'Create a separate reviewer agent that rates the Laplace quiz slides, keep going until 9/10');
    await ui.press('#prompt', 'Enter');

    // ---- 1. the reply ends at once; the card says a helper is working
    check('the reply that starts the helper shows', Boolean(await waitFor(async () => /separate reviewer agent is now checking/.test(await text()), 30000)), `${await text()} | stderr: ${stderr.join('').slice(-800)}`);
    check('...the card does not say Done: a helper is working', Boolean(await waitFor(async () => (await cardState()) === 'helper', 8000)), `${await cardState()} | ${await cardStatus()}`);
    const status1 = await cardStatus();
    check('...its status line names the helper (live indicator: the dot is the working one)', /Helper working/.test(status1) && /Review Laplace quiz slides/.test(status1) && /Helper working/.test(await cardSub()), `${status1} | ${await cardSub()}`);
    check('...the chat itself is free (no run going: the composer takes the next message)', await waitFor(async () => (await running()) === 0, 8000) === true && (await ui.evaluate(() => !document.querySelector('#messages .working'))), String(await running()));
    const dot = await ui.evaluate(() => { const d = document.querySelector('#messages .act-card .act-dot'); return d ? getComputedStyle(d).animationName : ''; });
    check('...the dot pulses while the helper works', /pulse/.test(dot), dot);

    // ---- 2. the helper's steps appear as they happen
    signal('step1');
    check("the helper's own step shows on that card, running", Boolean(await waitFor(async () => (await stepRows()).some((r) => /slide3\.txt/.test(r.text) && /running/.test(r.cls)), 8000)), JSON.stringify(await stepRows()));
    check('...and the status line follows it', Boolean(await waitFor(async () => /Helper working: .*slide3\.txt/.test(await cardStatus()), 5000)), await cardStatus());
    check('...the card stays "helper", not "working" or "stopped", with a step running', (await cardState()) === 'helper', await cardState());

    // the helper's Lumen call (what the CLI does over MCP): it reaches the chat that started the helper, and is a step of that card
    const tag = fs.existsSync(path.join(root, 'tag.txt')) ? fs.readFileSync(path.join(root, 'tag.txt'), 'utf8').trim() : '';
    check('the fake CLI was told its run tag (the stdio bridge config)', tag.length > 8, tag);
    const rowsBefore = (await stepRows()).length;
    const call = await app.evaluate(async (_e, t) => {
      const r = await global.__mcpCallTool('list_tabs', {}, { engine: t, approvedHosts: new Set(), clientName: 'Claude', controller: new AbortController() });
      return { isError: Boolean(r.isError), text: (r.content || []).map((b) => b.text).join(' ').slice(0, 200) };
    }, tag);
    check("a Lumen tool call from the helper's process is served (not 'no message in progress')", call.isError === false, JSON.stringify(call));
    check('...and shows as a step on the same card', Boolean(await waitFor(async () => (await stepRows()).length > rowsBefore, 5000)), JSON.stringify(await stepRows()));
    check('...still one card, still helper working', (await ui.evaluate(() => document.querySelectorAll('#messages .act-card').length)) === 1 && (await cardState()) === 'helper', `${await cardState()}`);

    signal('step2');
    check("the helper's step ends", Boolean(await waitFor(async () => (await stepRows()).some((r) => /slide3\.txt/.test(r.text) && /done/.test(r.cls)), 5000)), JSON.stringify(await stepRows()));

    // ---- 3. the helper ends: Done, and the follow-up lands in the same chat
    const userBubbles = await ui.evaluate(() => document.querySelectorAll('#messages .msg.user').length);
    signal('end');
    check('the card is Done when the helper ends', Boolean(await waitFor(async () => (await cardState()) === 'completed', 10000)), `${await cardState()} | ${await cardStatus()}`);
    check("the CLI's follow-up appears as a reply in the same chat", Boolean(await waitFor(async () => /The reviewer rated the deck 9\/10\./.test(await text()), 15000)), `${await text()} | ${JSON.stringify(await app.evaluate(() => global.__tabChats.runs()))}`);
    check('...under the earlier reply, in the same chat, with no new message of the user\'s', (await chatId()) === chat && (await ui.evaluate(() => document.querySelectorAll('#messages .msg.user').length)) === userBubbles && (await ui.evaluate(() => { const t = document.getElementById('messages').innerText; return t.indexOf('separate reviewer agent') < t.indexOf('rated the deck 9/10'); })), `${chat} ${await chatId()}`);
    check('...and the chat is idle after it (no working line, no run)', await waitFor(async () => (await running()) === 0 && (await ui.evaluate(() => !document.querySelector('#messages .working'))), 8000) === true, String(await running()));
    const saved = await app.evaluate(() => global.__agent.messages.map((m) => ({ role: m.role, text: (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('') })));
    check("the follow-up is saved with the chat's history (a second assistant reply)", saved.filter((m) => m.role === 'assistant').length === 2 && /9\/10/.test(saved[saved.length - 1].text) && saved.filter((m) => m.role === 'user').length === 1, JSON.stringify(saved));
    check('the first card is still Done after the follow-up', (await ui.evaluate(() => document.querySelector('#messages .act-card')?.dataset.state)) === 'completed', await cardState());

    // ---- 4. a second chat on the same engine: a helper whose process dies is stopped, never left spinning
    await ui.click('#new-chat');
    await sleep(400);
    for (const f of ['step1', 'step2', 'end', 'tag.txt']) fs.rmSync(path.join(root, f), { force: true });
    await ui.selectOption('#model', 'claudecode:default');
    await ui.fill('#prompt', 'Start another reviewer agent');
    await ui.press('#prompt', 'Enter');
    check('a second helper turn: card says a helper works', Boolean(await waitFor(async () => (await cardState()) === 'helper', 30000)), `${await cardState()} | ${await text()}`);
    signal('die');
    check('the process dies: the helper is stopped, the card is not left on "helper working"', Boolean(await waitFor(async () => (await cardState()) !== 'helper' && (await cardState()) !== '', 15000)), `${await cardState()} | ${await cardStatus()}`);
    check('...and nothing is left running', await waitFor(async () => (await running()) === 0, 8000) === true, String(await running()));
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall chat-helper-progress checks passed');
  process.exit(failures ? 1 : 0);
})();
