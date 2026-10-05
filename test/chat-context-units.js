// A chat's context usage and /compact (features/chat-usage.js context part, features/chat-compact.js, and what
// agent.js does with them), plain Node: no Electron, no network, no real CLI. Covers the context figures and the
// /context report parser, the command parser, where an API chat is cut and how its summary replaces the older turns
// (they still show), Regenerate keeping the summary, the API engine's /compact, /context and auto-compact with a fake
// Claude client, Claude Code's /compact and /context going to the CLI as typed without full access (a fake `claude`
// speaking stream-json, as checked against Claude Code 2.1.287), and skills named like the new commands.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CU = require('../src/features/chat-usage');
const CC = require('../src/features/chat-compact');
const { Agent, transcriptFor } = require('../src/ai/agent');
const { ClaudeCodeEngine } = require('../src/ai/claude-code');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = (v) => JSON.stringify(v);

// ---- context figures (chat-usage.js)
{
  check('context: the whole input of a request (fresh, cache reads and writes)', CU.contextTokensOf({ input_tokens: 10, cache_creation_input_tokens: 7102, cache_read_input_tokens: 500, output_tokens: 99 }) === 7612);
  check('context: Chat Completions usage counts its prompt', CU.contextTokensOf({ prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 200 } }) === 1200);
  check('context: no usage, no figure', CU.contextTokensOf(null) === 0 && CU.contextTokensOf({}) === 0);
  check('window: what the engine reported wins', CU.windowFor('claudecode:opus', 1_000_000) === 1_000_000 && CU.windowFor('gpt-5', 400_000) === 400_000);
  check('window: a [1m] model is 1M, anything else 200k', CU.windowFor('claudecode:opus[1m]') === 1_000_000 && CU.windowFor('claudecode:default') === 200_000 && CU.windowFor(null) === 200_000);
  check('window: Codex, Antigravity and Grok Build without a reported window use the engine\'s usual one; a reported one still wins', CU.windowFor('codex:default') === 272_000 && CU.windowFor('codex:gpt-5.5') === 272_000 && CU.windowFor('antigravity:default') === 1_000_000 && CU.windowFor('grokbuild:default') === 256_000 && CU.windowFor('codex:default', 400_000) === 400_000 && CU.windowFor('codex:default', 0) === 272_000);
  check('window: a codex chat\'s context records against 272k (never 0, so the strip can show a total)', (() => { const s = {}; CU.setContext(s, { tokens: 26_878, model: 'codex:default', estimated: true }); const v = CU.contextView(s.context); return v.window === 272_000 && Math.round(v.percent) === 10 && v.estimated; })());
  const settings = {};
  CU.setContext(settings, { tokens: 50_000, window: 200_000, now: 5 });
  check('setContext: saved on the chat\'s settings', J(settings.context) === J({ tokens: 50000, window: 200000, at: 5 }), J(settings.context));
  const v = CU.contextView(settings.context);
  check('contextView: percent of the window', v.percent === 25 && v.tokens === 50000 && v.window === 200000 && v.estimated === false, J(v));
  CU.setContext(settings, { tokens: 900_000, window: 200_000, estimated: true });
  check('contextView: clamped at 100, and marked when estimated', CU.contextView(settings.context).percent === 100 && CU.contextView(settings.context).estimated === true);
  check('contextView: unknown is null', CU.contextView(null) === null && CU.contextView({ tokens: 3 }) === null);
  check('setContext: nonsense is not recorded', CU.setContext({}, { tokens: 'x' }) === null && CU.setContext(null, { tokens: 1 }) === null);
  check('parseCount: k, M and commas', CU.parseCount('18.1k') === 18100 && CU.parseCount('1M') === 1e6 && CU.parseCount('2,048') === 2048 && CU.parseCount('lots') === null);
  const report = '## Context Usage\n\n**Model:** claude-haiku-4-5-20251001  \n**Tokens:** 18.1k / 200k (9%)\n\n| Category | Tokens |';
  check('parseContextReport: Claude Code\'s /context header', J(CU.parseContextReport(report)) === J({ tokens: 18100, window: 200000 }), J(CU.parseContextReport(report)));
  check('parseContextReport: anything else is null', CU.parseContextReport('no numbers here') === null && CU.parseContextReport('') === null);
}

// ---- the command parser and the cut (chat-compact.js)
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const reply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolCall = (id) => ({ role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id, name: 'read_page', input: {} }] });
const toolResult = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'page text '.repeat(20) }] });
{
  check('command: /compact with instructions', J(CC.chatCommand('  /compact keep the prices ')) === J({ name: 'compact', args: 'keep the prices' }));
  check('command: /context, any case', J(CC.chatCommand('/Context')) === J({ name: 'context', args: '' }));
  check('command: anything else is a message', CC.chatCommand('/compacting') === null && CC.chatCommand('please /compact') === null && CC.chatCommand('/goal x') === null && CC.chatCommand('') === null && CC.chatCommand(null) === null);
  const chat = [user('one'), toolCall('t1'), toolResult('t1'), reply('first answer'), user('two'), reply('second answer'), user('three'), reply('third')];
  check('turn starts: user messages with something typed, never tool results', J(CC.turnStarts(chat)) === '[0,4,6]', J(CC.turnStarts(chat)));
  check('plan: everything before the last exchange', J(CC.compactPlan(chat)) === '{"cut":6}');
  check('plan: one exchange is nothing to compact', CC.compactPlan([user('one'), reply('a')]) === null && CC.compactPlan([]) === null);
  const items = transcriptFor(chat.slice(0, 6), null);
  const req = CC.summaryRequest({ items, prior: 'old summary', instructions: 'the prices' });
  check('summary request: the turns, the summary so far and what the user asked to keep', /User: one/.test(req) && /Assistant: second answer/.test(req) && /<summary_so_far>\nold summary/.test(req) && /focus on: the prices/.test(req) && !/three/.test(req), req.slice(0, 300));
  const m = [...chat];
  m.settings = { model: 'claude-opus-5' };
  check('apply: an empty summary changes nothing', CC.applySummary(m, 6, '  ', items) === false && m.length === 8);
  check('apply: replaces the older turns', CC.applySummary(m, 6, 'They talked about one and two.', items) && m.length === 2 && m[0].content[0].text.startsWith('<earlier_conversation_summary>') && m[0].content[1].text === 'three', J(m[0]));
  check('apply: the summary can be read back', CC.summaryOf(m) === 'They talked about one and two.', CC.summaryOf(m));
  check('apply: the replaced turns are kept for the view, text only', m.settings.compactedItems.length === items.length && m.settings.compactions === 1 && m.settings.compactedItems.every((it) => Array.isArray(it.images) && !it.images.length));
  const view = transcriptFor(m);
  check('transcript: the compacted turns still show, the summary itself does not', view.map((x) => x.text).join('|') === 'one|Looking.|first answer|two|second answer|three|third', view.map((x) => x.text).join('|'));
  m.push(user('four'), reply('fourth'));
  CC.applySummary(m, 2, 'Second summary.', transcriptFor(m.slice(0, 2), null));
  check('apply again: one summary block, the newest', m[0].content.filter((b) => CC.SUMMARY_BLOCK.test(b.text)).length === 1 && CC.summaryOf(m) === 'Second summary.' && m.settings.compactions === 2);
  check('auto-compact: past 80% of what a request may carry', CC.shouldAutoCompact(81, 100) && !CC.shouldAutoCompact(79, 100) && !CC.shouldAutoCompact(10, 0));
}

// ---- the agent
const fakeBrowser = (extra = {}) => ({ activeTab: () => null, tabById: () => null, listTabs: () => [], effectiveModel: (x) => x, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, ...extra });
const newAgent = (getClient, extra) => {
  const agent = new Agent(fakeBrowser(extra), getClient, () => ({ model: 'claude-opus-5' }));
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  return agent;
};
const runOn = (agent, text) => new Promise((resolve) => { const events = []; agent.run(text, (e) => { events.push(e); if (e.type === 'done') resolve(events); }); });
const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');
const notices = (events) => events.filter((e) => e.type === 'notice').map((e) => e.text);

(async () => {
  {
    // Rewind (Retry / Regenerate) of the exchange a summary rides on keeps the summary.
    const agent = newAgent(() => null);
    const m = [user('one'), reply('a'), user('two'), reply('b')];
    m.settings = { model: 'claude-opus-5' };
    CC.applySummary(m, 2, 'About one.', []);
    agent.messages = m;
    check('rewind: the last exchange goes', agent.rewindLast('two') === 'rewound');
    check('rewind: ... but the summary it carried stays for the next message', agent.messages.length === 1 && CC.summaryOf(agent.messages) === 'About one.', J(agent.messages));
  }

  {
    // An API chat: context from each reply's usage, /compact, /context, auto-compact.
    const requests = [];
    let answer = 'OK';
    const client = { beta: { messages: { stream: (params) => {
      requests.push(params);
      const isSummary = /Summarize the conversation below/.test(J(params.messages));
      const message = { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: isSummary ? 'SUMMARY: the user asked about cats and dogs.' : answer }], stop_reason: 'end_turn', usage: { input_tokens: 40, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 1000, output_tokens: 50 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_start', content_block: { type: 'text' } }; yield { type: 'content_block_delta', delta: { type: 'text_delta', text: message.content[0].text } }; }, finalMessage: async () => message };
    } } } };
    let auto = true;
    const agent = newAgent(() => client, { autoCompact: () => auto });
    answer = `OK${' cats'.repeat(4000)}`; // (a long first reply: compacting it frees something)
    let events = await runOn(agent, 'tell me about cats');
    answer = 'OK';
    const ctx = agent.messages.settings.context;
    check('api: a reply records the chat\'s context (its request\'s whole input)', ctx?.tokens === 31_040 && ctx.window === 200_000 && !ctx.estimated, J(ctx));
    check('api: ... and the sidebar is told', events.some((e) => e.type === 'context' && e.context.tokens === 31_040 && Math.round(e.context.percent) === 16), J(events.filter((e) => e.type === 'context')));
    events = await runOn(agent, '/compact');
    check('api: /compact with one exchange says there is nothing to compact', notices(events).some((n) => /Nothing to compact yet/.test(n)) && agent.messages.length === 2, J(notices(events)));
    await runOn(agent, 'and dogs?');
    const before = requests.length;
    events = await runOn(agent, '/compact keep the breeds');
    const summaryReq = requests[before];
    check('api: /compact asks the same model for a summary, with what to keep, tools off', requests.length === before + 1 && /focus on: keep the breeds/.test(J(summaryReq.messages)) && summaryReq.tool_choice?.type === 'none' && summaryReq.model === 'claude-opus-5', J(summaryReq?.tool_choice));
    check('api: the older exchange is replaced by the summary; the last stays', agent.messages.length === 2 && CC.summaryOf(agent.messages) === 'SUMMARY: the user asked about cats and dogs.' && /and dogs\?/.test(J(agent.messages[0])), J(agent.messages).slice(0, 300));
    check('api: the command is not a message of the chat', !J(agent.messages).includes('/compact'));
    check('api: it says what it freed, and the meter is an estimate until the next reply', notices(events).some((n) => /^Compacted: about 31\.0k → /.test(n)) && agent.messages.settings.context.estimated === true && agent.messages.settings.context.tokens < 31_040, J([notices(events), agent.messages.settings.context]));
    const shown = agent.transcript().map((x) => x.text.slice(0, 12)).join('|');
    check('api: the compacted turns still show in the chat', shown === 'tell me abou|OK cats cats|and dogs?|OK', shown);
    check('api: the summary call is counted in the chat\'s usage', agent.messages.settings.usage.turns === 3, J(agent.messages.settings.usage));
    await runOn(agent, 'and birds?');
    const sent = requests[requests.length - 1].messages;
    check('api: the next request starts with the summary', J(sent[0]).includes('earlier_conversation_summary') && J(sent).includes('and birds?') && !J(sent).includes('tell me about cats'), J(sent).slice(0, 200));
    events = await runOn(agent, '/context');
    check('api: /context reports the chat\'s figure in words, as a reply', /\*\*Tokens:\*\* 31\.0k \/ 200\.0k \(16%\)/.test(textOf(events)) && /Compacted once/.test(textOf(events)) && !J(agent.messages).includes('/context'), textOf(events));

    // auto-compact: a history near what one request may carry is summarized first
    agent.contextBudget = () => 200; // (characters: this chat is well over 80% of it)
    const n0 = requests.length;
    events = await runOn(agent, 'and fish?');
    check('auto-compact: summarized before the request, and said so', requests.length === n0 + 2 && /Summarize the conversation/.test(J(requests[n0].messages)) && notices(events).some((n) => /getting long/.test(n)), J(notices(events)));
    check('auto-compact: the message itself still gets its answer', textOf(events).endsWith('OK') && /and fish\?/.test(J(agent.messages[0])), textOf(events));
    auto = false;
    const n1 = requests.length;
    events = await runOn(agent, 'and frogs?');
    check('auto-compact off (the setting): no summary request', requests.length === n1 + 1 && !notices(events).some((n) => /getting long/.test(n)), requests.length - n1);

    // A failed summary changes nothing.
    agent.contextBudget = () => 1e6;
    const broken = newAgent(() => ({ beta: { messages: { stream: (params) => {
      if (/Summarize the conversation below/.test(J(params.messages))) throw new Error('boom');
      const message = { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } };
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
    } } } }));
    await runOn(broken, 'one');
    await runOn(broken, 'two');
    events = await runOn(broken, '/compact');
    check('api: a failed summary leaves the chat as it was, and says so', broken.messages.length === 4 && notices(events).some((n) => /Couldn’t compact this chat \(boom\)\. Nothing was changed\./.test(n)) && !events.some((e) => e.type === 'error'), J(notices(events)));
  }

  {
    // Grok Build and Antigravity compact their own sessions.
    const agent = newAgent(() => null);
    agent.messages = [];
    agent.messages.settings = { model: 'grokbuild:default' };
    const events = await runOn(agent, '/compact');
    check('grok build: /compact says it compacts by itself', notices(events).some((n) => /Grok Build keeps this conversation in its own session/.test(n)), J(notices(events)));
  }

  // ---- Claude Code: /compact and /context go to the chat's own CLI session as typed, without full access
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ctx-units-'));
  const fake = path.join(dir, 'fake-claude.js');
  const log = path.join(dir, 'stdin.log');
  fs.writeFileSync(fake, `
const fs = require('fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const argv = process.argv.slice(2);
const session = argv[argv.indexOf('--session-id') + 1] && argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : argv[argv.indexOf('--resume') + 1];
const modelUsage = { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 7102, costUSD: 0.01, contextWindow: 200000 } };
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    const text = msg.message.content[0].text;
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ text, argv }) + '\\n');
    out({ type: 'system', subtype: 'init', session_id: session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    const result = (extra) => out({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: 0.01, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage, ...extra });
    if (text.startsWith('/compact')) {
      out({ type: 'system', subtype: 'status', status: 'compacting', session_id: session });
      out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: session });
      out({ type: 'system', subtype: 'compact_boundary', session_id: session, compact_metadata: { trigger: 'manual', pre_tokens: 7244, post_tokens: 495 } });
      out({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, isReplay: true });
      result({ result: '', num_turns: 0 });
    } else if (text === '/context') {
      const report = '## Context Usage\\n\\n**Model:** claude-haiku-4-5  \\n**Tokens:** 18.1k / 200k (9%)\\n';
      out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: report }], usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null });
      result({ result: report, num_turns: 0 });
    } else {
      if (/AUTO/.test(text)) out({ type: 'system', subtype: 'compact_boundary', session_id: session, compact_metadata: { trigger: 'auto', pre_tokens: 160000, post_tokens: 9000 } });
      const usage = /AUTO/.test(text) ? { input_tokens: 3, cache_read_input_tokens: 9500, cache_creation_input_tokens: 200, output_tokens: 20 } : { input_tokens: 10, cache_creation_input_tokens: 7102, cache_read_input_tokens: 0, output_tokens: 3 };
      out({ type: 'assistant', message: { model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }], usage }, parent_tool_use_id: null });
      result({ result: 'Hello there.', num_turns: 1, usage });
    }
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 20));
`);
  process.env.LUMEN_CLAUDE_BIN = fake;
  const fakeSpawn = (bin, argv, opts) => spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1', FAKE_LOG: log } });
  const engine = new ClaudeCodeEngine({ userData: dir, mcpCommand: () => ({ command: process.execPath, args: ['-e', ''], env: {} }), ensureServer: () => {}, keepAlive: false, spawn: fakeSpawn });
  const agent = newAgent(() => null, { claudeCodeFullAccess: () => false, autoModel: () => false });
  agent.engines = { claudecode: engine };
  const sentTexts = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  try {
    agent.messages = [];
    agent.messages.settings = { model: 'claudecode:haiku' };
    let events = await runOn(agent, '/compact');
    check('claude code: /compact before any message says there is nothing yet (no CLI started)', notices(events).some((n) => /Nothing to compact yet/.test(n)) && !fs.existsSync(log), J(notices(events)));
    events = await runOn(agent, 'hello');
    const ctx = agent.messages.settings.context;
    check('claude code: a reply records the context of its last model call, against the window the CLI reported', ctx?.tokens === 7112 && ctx.window === 200_000, J(ctx));
    check('claude code: ... and the sidebar is told', events.some((e) => e.type === 'context' && e.context.tokens === 7112), J(events.filter((e) => e.type === 'context')));
    const msgCount = agent.messages.length;
    events = await runOn(agent, '/compact keep the greeting');
    const last = sentTexts().pop();
    check('claude code: /compact goes to the session as typed, with full access off', last.text === '/compact keep the greeting' && last.argv.includes('--resume') && last.argv[last.argv.indexOf('--tools') + 1] === '' && last.argv.includes('dontAsk'), J(last));
    check('claude code: it shows a working line, then says what it freed', events.some((e) => e.type === 'status' && /Compacting/.test(e.text)) && notices(events).includes('Compacted: 7.2k → 495 tokens.'), J(notices(events)));
    check('claude code: the meter takes the CLI\'s after-figure, as an estimate', agent.messages.settings.context.tokens === 495 && agent.messages.settings.context.estimated === true, J(agent.messages.settings.context));
    check('claude code: the command is not added to the chat', agent.messages.length === msgCount, agent.messages.length);
    events = await runOn(agent, '/context');
    check('claude code: /context goes to the CLI and its report shows as the reply', sentTexts().pop().text === '/context' && /\*\*Tokens:\*\* 18\.1k \/ 200k/.test(textOf(events)), textOf(events));
    check('claude code: the report sets the meter exactly', agent.messages.settings.context.tokens === 18_100 && !agent.messages.settings.context.estimated, J(agent.messages.settings.context));
    events = await runOn(agent, 'AUTO please');
    check('claude code: a compaction the CLI ran by itself mid-reply is said in the chat', notices(events).some((n) => /compacted this conversation to make room \(160\.0k → 9\.0k tokens\)/.test(n)), J(notices(events)));
    check('claude code: ... and the meter is the call after it', agent.messages.settings.context.tokens === 9703, J(agent.messages.settings.context));
  } finally {
    engine.dispose?.();
    delete process.env.LUMEN_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }

  // ---- skills: the new commands' names are taken, and a skill saved under one is kept, renamed
  {
    const skills = require('../src/features/skills');
    check('skills: the chat commands are reserved', ['clear', 'compact', 'context', 'cost', 'usage', 'model', 'help'].every((n) => skills.RESERVED.has(n)));
    check('skills: a new skill can\'t take one', skills.normalizeSkill({ name: 'compact', title: 'C', prompt: 'x' }).ok === false);
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ctx-skills-'));
    const file = path.join(sdir, 'skills.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, skills: [{ id: 'u1', name: 'context', title: 'My context', prompt: 'Give context on {{page}}', source: 'user', createdAt: 1 }], known: skills.BUILTINS.map((b) => b.name) }));
    const store = skills.createStore({ file });
    const kept = store.list().find((s) => s.id === 'u1');
    check('skills: one saved as /context before is kept as /context-skill', kept?.name === 'context-skill' && kept.title === 'My context', J(store.list().map((s) => s.name)));
    fs.rmSync(sdir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
