// [parallel chats] Two or more Claude Code chats working at once, in real Lumen with a fake `claude` CLI (no network, no sign-in):
// sidebar chats in two tabs, two chats swapped in one sidebar, and a background task on Claude Code beside them. Each chat's
// streamed words and steps show only in its own chat while both stream; a Stop pressed in a chat with nothing running leaves the
// other chat alone (main.js agent:stop, agent.stopOpen); every chat reaches "done" with its reply there after switching back;
// and switching tabs or chats while two stream is timed (the sidebar shows the other chat soon).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// The fake CLI: a message naming "chat-X" streams "X-word-N" lines with one Bash step, and with HOLD-X keeps streaming until the
// file go-X appears in the test's folder; then it answers "X finished".
const fakeCli = (dir) => `
const fs = require('fs'); const path = require('path');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = '';
process.stdin.on('data', async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== 'user') continue;
    const text = JSON.stringify(msg.message || msg);
    const who = (/chat-(\\w+)/.exec(text) || [])[1] || 'Q';
    const hold = new RegExp('HOLD-' + who).test(text);
    const sid = 'sess-' + who;
    out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b-' + who, name: 'Bash', input: { command: 'echo ' + who + '-step', description: who + ' step' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b-' + who, content: who + '-step done' }] } });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
    for (let n = 1; ; n++) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: who + '-word-' + n + ' ' } } });
      await wait(120);
      if (!hold && n >= 6) break;
      if (hold && fs.existsSync(path.join(${JSON.stringify(dir)}, 'go-' + who))) break;
      if (n > 600) break;
    }
    const answer = who + ' finished';
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } });
    out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sid, total_cost_usd: 0, usage: {} });
  }
});
`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpar-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const fake = path.join(root, 'fake-claude.js'); fs.writeFileSync(fake, fakeCli(root));
  const spawnModule = path.join(root, 'cli-spawn.js'); // what the engines call in place of child_process.spawn (features/ai-agents.js cliSpawn)
  fs.writeFileSync(spawnModule, "const cp = require('child_process'); exports.spawn = (bin, argv, opts) => cp.spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } });");
  const go = (who) => fs.writeFileSync(path.join(root, `go-${who}`), '');
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: fake, LUMEN_TEST_CLI_SPAWN: spawnModule } });
  const timings = { tab: [], chat: [] };
  try {
    const stderr = [];
    app.process().stderr?.on('data', (d) => stderr.push(String(d)));
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => { const s = global.__settings.backend; s.set('sidebarNewChat', false); s.set('oneChatPerTab', true); s.set('claudeCodeFullAccess', true); s.set('groupAiTabs', false); });

    const active = () => app.evaluate(() => global.__windows.list()[0].activeId);
    const openTab = (url) => app.evaluate((_e, u) => { const id = global.__agent.browser.openTab(u).id; global.__tabChats.setSidebar(id, true); return id; }, url);
    const showTab = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
    const text = () => ui.evaluate(() => document.getElementById('messages').innerText);
    const running = () => app.evaluate(() => global.__tabChats.runs().filter((r) => r.live).length);
    const send = async (msg) => { await ui.fill('#prompt', msg); await ui.press('#prompt', 'Enter'); };
    const useClaudeCode = async () => {
      let ids = [];
      for (let i = 0; i < 30 && !ids.includes('claudecode:default'); i++) { ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value)); if (!ids.includes('claudecode:default')) await sleep(300); }
      await ui.selectOption('#model', 'claudecode:default');
    };
    const onlyWords = (t, who, other) => new RegExp(`${who}-word-`).test(t) && !new RegExp(`${other}-word-|${other} finished`).test(t);

    // ---- 1. two Claude Code chats in two tabs, streaming at once
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    const tabA = await active();
    await useClaudeCode();
    await send('chat-A HOLD-A work on A');
    check('chat A streams from its Claude Code process', Boolean(await waitFor(async () => /A-word-1/.test(await text()), 20000)), `${await text()} | stderr: ${stderr.join('').slice(-1200)}`);
    const tabB = await openTab('about:blank');
    await waitFor(async () => (await active()) === tabB);
    await waitFor(async () => !/A-word-/.test(await text()), 5000);
    await useClaudeCode();
    await send('chat-B HOLD-B work on B');
    check('chat B streams too, while A still works', Boolean(await waitFor(async () => /B-word-1/.test(await text()), 20000)) && (await running()) === 2, `${await running()} ${await text()}`);
    check("tab B shows only chat B's words", onlyWords(await text(), 'B', 'A'), await text());

    // switching tabs while both stream: each tab shows only its own chat, soon
    for (let i = 0; i < 4; i++) {
      const [to, who, other] = i % 2 === 0 ? [tabA, 'A', 'B'] : [tabB, 'B', 'A'];
      const t0 = Date.now();
      await showTab(to);
      const ok = await waitFor(async () => onlyWords(await text(), who, other), 5000);
      timings.tab.push(Date.now() - t0);
      if (!ok) { check(`switching to tab ${who} shows only chat ${who}`, false, await text()); break; }
    }
    check("switching tabs while both stream shows each tab's own chat, never the other's", timings.tab.length === 4, JSON.stringify(timings.tab));
    await sleep(600);
    const stay = await text();
    check('...and it stays that way while both keep streaming (B\'s words stay, none of A\'s land later)', onlyWords(stay, 'B', 'A'), `${stay} | runs ${JSON.stringify(await app.evaluate(() => global.__tabChats.runs()))}`);
    await showTab(tabA);
    check('tab A shows chat A again, with its words', Boolean(await waitFor(async () => onlyWords(await text(), 'A', 'B'), 5000)), await text());

    // ---- 2. Stop in a chat with nothing running leaves the other chat going
    go('A');
    check('chat A finishes', Boolean(await waitFor(async () => /A finished/.test(await text()), 20000)), `${await text()} | runs ${JSON.stringify(await app.evaluate(() => global.__tabChats.runs()))}`);
    await waitFor(async () => (await running()) === 1, 8000);
    await ui.evaluate(() => window.assistant.stop()); // (an old-style Stop with no chat id, from chat A that has nothing running)
    await ui.evaluate(() => window.chatStopReply?.());
    await sleep(1500);
    check('a Stop pressed in chat A (nothing running there) does not stop chat B', (await running()) === 1, String(await running()));
    await showTab(tabB);
    check('chat B is still streaming', Boolean(await waitFor(async () => { const t = await text(); const n = Math.max(0, ...[...t.matchAll(/B-word-(\d+)/g)].map((m) => Number(m[1]))); await sleep(400); const t2 = await text(); return Math.max(0, ...[...t2.matchAll(/B-word-(\d+)/g)].map((m) => Number(m[1]))) > n; }, 6000)) && !/Stopped/.test(await text()), await text());
    go('B');
    check('chat B finishes', Boolean(await waitFor(async () => /B finished/.test(await text()), 20000)), await text());
    check('no chat is left running', await waitFor(async () => (await running()) === 0, 8000) === true, String(await running()));
    await showTab(tabA);
    check("chat A's reply is there after switching back", Boolean(await waitFor(async () => /A finished/.test(await text()) && !/B finished/.test(await text()), 5000)), await text());

    // ---- 3. two chats swapped in one sidebar while one streams
    await ui.click('#new-chat');
    await sleep(400);
    await useClaudeCode();
    await send('chat-C HOLD-C work on C');
    check('chat C streams in tab A', Boolean(await waitFor(async () => /C-word-1/.test(await text()), 20000)), await text());
    const chatC = await app.evaluate(() => global.__tabChats.chatId());
    const list = await ui.evaluate(() => window.assistant.chats.list());
    const chatA = (list.chats || list).find((c) => /chat-A/.test(c.title || '') || /A finished/.test(c.preview || ''))?.id || (list.chats || list).find((c) => c.id !== chatC)?.id;
    for (let i = 0; i < 4; i++) {
      const [id, want, not] = i % 2 === 0 ? [chatA, /A finished/, /C-word-/] : [chatC, /C-word-/, /A finished/];
      const t0 = Date.now();
      await ui.evaluate((x) => window.chatList.openChat(x), id);
      const ok = await waitFor(async () => { const t = await text(); return want.test(t) && !not.test(t); }, 5000);
      timings.chat.push(Date.now() - t0);
      if (!ok) { check('swapping chats in one sidebar shows the chat opened', false, `${i} ${await text()}`); break; }
    }
    check('swapping between a finished chat and a streaming one in one sidebar shows each, never mixed', timings.chat.length === 4, JSON.stringify(timings.chat));
    check('chat C kept running through the swaps', (await running()) === 1, String(await running()));

    // ---- 4. a background task on Claude Code beside it
    const task = await ui.evaluate(() => window.assistant.tasks.create({ prompt: 'chat-T background job', model: 'claudecode:default', schedule: { type: 'now' }, confirmed: true }));
    const taskDone = await waitFor(() => app.evaluate(() => global.__bg.tasks().find((x) => /chat-T/.test(x.prompt))?.status === 'done'), 30000);
    check('a background task on Claude Code finishes beside the streaming chat', Boolean(task) && Boolean(taskDone), JSON.stringify(await app.evaluate(() => global.__bg.tasks().map((x) => ({ s: x.status, e: x.error })))));
    check("...and none of its words land in chat C", !/T-word-|T finished/.test(await text()), await text());
    go('C');
    check('chat C finishes', Boolean(await waitFor(async () => /C finished/.test(await text()), 20000)), await text());
    check('nothing is left running', await waitFor(async () => (await running()) === 0, 8000) === true, String(await running()));

    const worst = Math.max(...timings.tab, ...timings.chat);
    console.log('      switch times (ms): tabs', JSON.stringify(timings.tab), 'chats', JSON.stringify(timings.chat));
    check('every switch showed the other chat within 1500 ms', worst <= 1500, String(worst));
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall chat-parallel-claude-code checks passed');
  process.exit(failures ? 1 : 0);
})();
