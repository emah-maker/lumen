// [engine parity] What a Claude Code chat can do, on every engine: plain Node, fake engines and fake servers only (no real CLI, no network).
// Covers Antigravity viewing its own attached pictures and message file (agy-tools.js ownFileOk, antigravity.js offToolOf), /compact on
// Grok Build / Antigravity / Codex (agent.js commandTurn, cliSummary), the user's skills and MCP servers as extras of a CLI run
// (cliSystemFor, cliSkillToolDefs, cliExternalToolDefs, cliExternalReady), and a background task on a sidebar-only CLI said plainly.
require('../helpers/_tmp-cleanup');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { agyAllowed, ownFileOk } = require('../../src/ai/agy-tools');
const { Agent } = require('../../src/ai/agent');
const bg = require('../../src/features/background-agents');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;

(async () => {
  // ---- Antigravity: its own files only
  const dir = path.join(os.tmpdir(), 'lumen-agy-sidebar');
  const img = path.join(dir, 'lumen-image-abcd1234-0.png');
  const msg = path.join(dir, 'lumen-message-abcd1234.md');
  const reads = [img, msg];
  const home = path.join(os.tmpdir(), 'agy-home');
  check('agy: view_file of an attached picture is allowed by the hook', agyAllowed({ name: 'view_file', args: { AbsolutePath: img }, home, toolNames: ['read_page'], reads }), 'x');
  check('agy: view_file of a long message\'s file is allowed too', agyAllowed({ name: 'view_file', args: { AbsolutePath: msg }, home, toolNames: [], reads }), 'x');
  check('agy: another file in the same folder is still denied', !agyAllowed({ name: 'view_file', args: { AbsolutePath: path.join(dir, 'secret.txt') }, home, toolNames: [], reads }), 'x');
  check('agy: the folder itself, a URL and a path with a NUL are denied', !ownFileOk('view_file', { AbsolutePath: dir }, reads) && !ownFileOk('view_file', { AbsolutePath: `file://${img}` }, reads) && !ownFileOk('view_file', { AbsolutePath: `${img}\0` }, reads), 'x');
  check('agy: only view_file, never a write or a listing, and nothing without the run\'s own list', !ownFileOk('write_to_file', { TargetFile: img }, reads) && !ownFileOk('list_dir', { DirectoryPath: dir }, reads) && !agyAllowed({ name: 'view_file', args: { AbsolutePath: img }, home, toolNames: [] }), 'x');
  check('agy: one path outside the list fails the whole call', !ownFileOk('view_file', { AbsolutePath: img, TargetFile: path.join(dir, 'x.png') }, reads), 'x');
  if (process.platform === 'win32') check('agy: the match ignores case on Windows', ownFileOk('view_file', { AbsolutePath: img.toUpperCase() }, reads), 'x');
  {
    const src = require('fs').readFileSync(require.resolve('../../src/ai/antigravity'), 'utf8');
    check('agy: the run hands its written files to the gate (reads: files) and the stream check', /gate\.open\(tag, sessionId \|\| tag, \{[^}]*reads: files/.test(src) && /offToolOf\(tool, [^)]*, home, reads\)/.test(src), 'x');
  }

  // ---- /compact on the CLI engines
  const chat = (model, extra = {}) => {
    const m = [
      { role: 'user', content: [{ type: 'text', text: 'Find the cheapest flight to Lisbon in May.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'TAP has one for $412 on May 3.' }] },
      { role: 'user', content: [{ type: 'text', text: 'And a hotel near Alfama?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Memmo Alfama, $180 a night.' }] },
    ];
    m.settings = { model, ...extra };
    return m;
  };
  for (const [kind, sessionKey, name] of [['codex', 'cxSession', 'Codex'], ['grokbuild', 'gbSession', 'Grok Build'], ['antigravity', 'agySession', 'Antigravity']]) {
    const runs = [];
    const lease = (k) => ({ engine: { kind: k, run: async (args) => { runs.push({ k, args }); return { text: 'They looked at flights to Lisbon (TAP, $412, May 3).' }; } }, release() {} });
    const agent = new Agent({ maxSteps: () => 0 }, () => null, () => ({ model: `${kind}:default` }), () => null);
    agent.engines = { [kind]: {}, lease, cliStatus: () => ({}) };
    agent.grokBuildSystem = () => 'system';
    const messages = chat(`${kind}:default`, { [sessionKey]: 'old-session' });
    const events = [];
    await agent.commandTurn(messages, { name: 'compact', args: '' }, { signal: new AbortController().signal }, (e) => events.push(e));
    check(`compact (${name}): the same CLI writes the summary in one fresh run`, runs.length === 1 && runs[0].k === kind && /Lisbon/.test(runs[0].args.prompt) && runs[0].args.fullAccess === false, J(runs.map((r) => r.k)));
    check(`compact (${name}): the summary is outside the chat's own session and kept process`, runs[0] && runs[0].args.sessionId !== 'old-session' && (runs[0].args.scope == null || runs[0].args.scope.chatId == null), J(runs[0]?.args.sessionId));
    check(`compact (${name}): the chat now carries the summary and its old CLI session is dropped`, Array.isArray(messages.settings.compactedItems) && messages.settings.compactedItems.length > 0 && !messages.settings[sessionKey] && J(messages).includes('TAP, $412'), J(messages.settings));
    check(`compact (${name}): it says so in the chat, not that it can't`, events.some((e) => e.type === 'notice' && /^Compacted/.test(e.text)) && !events.some((e) => /can't compact/i.test(e.text || '')), J(events));
  }
  {
    const lease = (k) => ({ engine: { kind: k, run: async () => ({ text: '', failed: true }) }, release() {} });
    const agent = new Agent({ maxSteps: () => 0 }, () => null, () => ({ model: 'codex:default' }), () => null);
    agent.engines = { codex: {}, lease, cliStatus: () => ({}) };
    const messages = chat('codex:default', { cxSession: 'keep' });
    const before = J(messages);
    const events = [];
    await agent.commandTurn(messages, { name: 'compact', args: '' }, { signal: new AbortController().signal }, (e) => events.push(e));
    check('compact: a failed summary changes nothing and says so', J(messages) === before && messages.settings.cxSession === 'keep' && events.some((e) => e.type === 'notice' && /Couldn’t compact this chat .*Nothing was changed/.test(e.text)), J(events));
  }
  {
    const agent = new Agent({ maxSteps: () => 0 }, () => null, () => ({ model: 'codex:default' }), () => null);
    agent.engines = {};
    const events = [];
    await agent.commandTurn(chat('codex:default'), { name: 'compact', args: '' }, { signal: new AbortController().signal }, (e) => events.push(e));
    check('compact: a CLI that is not there is said plainly', events.some((e) => e.type === 'notice' && /Codex isn't available right now/.test(e.text)), J(events));
  }

  // ---- skills and the user's MCP servers, as extras of a CLI run
  const skills = '<skills>\nThe user saved these skills: ... call use_skill with its name first.\n- weekly-report: The Friday report\n</skills>';
  {
    const agent = new Agent({ maxSteps: () => 0, skills: { useForAI: () => ({ text: 'Do the report like this.' }) } }, () => null, () => ({ model: 'codex:default' }), () => null);
    agent.engines = { grokbuild: { statusCache: null } };
    const withSkills = { model: 'grokbuild:default', skillsList: skills };
    check('skills: a CLI chat\'s system prompt lists the user\'s skills (Grok Build)', agent.grokBuildSystem(withSkills, false).includes('- weekly-report'), 'x');
    check('skills: and without skills nothing is added (the Grok prompt budget is unchanged)', !agent.grokBuildSystem({ model: 'grokbuild:default' }, false).includes('<skills>'), 'x');
    check('skills: use_skill (and [review loop] review_round with it) is an extra of the run only when the chat lists skills', agent.cliSkillToolDefs({ settings: withSkills }).map((t) => t.name).join() === 'use_skill,review_round' && agent.cliSkillToolDefs({ settings: { model: 'codex:default' } }).length === 0 && agent.cliSkillToolDefs(null).length === 0, 'x');
    check('skills: a call through MCP returns the skill\'s instructions', (await agent.execute('use_skill', { name: 'weekly-report' })) === 'Do the report like this.', 'x');
    const none = new Agent({ maxSteps: () => 0 }, () => null, () => ({ model: 'codex:default' }), () => null);
    check('skills: no skills feature, no tool', none.cliSkillToolDefs({ settings: withSkills }).length === 0, 'x');
    const src = require('fs').readFileSync(require.resolve('../../src/ai/agent'), 'utf8');
    check('skills: every sidebar CLI engine builds its prompt with cliSystemFor (Claude Code, Grok Build, Antigravity, Codex)', ['claudeCodeNote(autoChosen', 'grokBuildNote(known', 'antigravityNote(picked === \'default\' ? null : picked, new Date(), { fullAccess }),', 'codexNote(picked === \'default\' ? null : picked, new Date(), { fullAccess });'].every((n) => src.includes(`cliSystemFor(settings) + ${n}`)), 'x');
  }
  {
    const defs = [{ name: 'github__search_issues', description: '[Tool from the MCP server “github”…] Search issues', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }];
    let started = 0;
    const ext = { readyDefs: () => defs, tools: async () => { started++; return { defs, failed: [{ name: 'notion', error: 'did not start' }] }; }, isExternal: (n) => n === 'github__search_issues', lookupTool: () => ({ server: 'github', tool: 'search_issues' }) };
    let allowMcp = true;
    const agent = new Agent({ maxSteps: () => 0, externalTools: ext, projects: { allows: (_c, what) => (what === 'mcp' ? allowMcp : true) } }, () => null, () => ({ model: 'codex:default' }), () => null);
    check('mcp servers: a CLI run lists the tools of the servers the user added', agent.cliExternalToolDefs({ settings: {} }).map((t) => t.name).join() === 'github__search_issues', 'x');
    allowMcp = false;
    check('mcp servers: not where the chat\'s project turns them off', agent.cliExternalToolDefs({ settings: {} }).length === 0, 'x');
    allowMcp = true;
    const events = [];
    await agent.cliExternalReady((e) => events.push(e));
    await agent.cliExternalReady((e) => events.push(e));
    check('mcp servers: they are started before the run lists its tools, and a server that failed is said once', started === 2 && events.filter((e) => e.type === 'notice' && /notion/.test(e.text)).length === 1, J({ started, events }));
    const slow = new Agent({ maxSteps: () => 0, externalTools: { readyDefs: () => [], tools: () => new Promise(() => {}) } }, () => null, () => ({ model: 'codex:default' }), () => null);
    const t0 = Date.now();
    await slow.cliExternalReady(() => {}, 50);
    check('mcp servers: a server that hangs holds the message up for a bounded time only', Date.now() - t0 < 1000, String(Date.now() - t0));
    const bare = new Agent({ maxSteps: () => 0 }, () => null, () => ({ model: 'codex:default' }), () => null);
    check('mcp servers: no MCP client, nothing listed', bare.cliExternalToolDefs({}).length === 0, 'x');
    const client = require('../../src/features/mcp-client').create({ userData: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-parity-')), version: '0' });
    check('mcp servers: the client\'s readyDefs never starts a server and is empty with none running', Array.isArray(client.readyDefs()) && client.readyDefs().length === 0, 'x');
    const runTools = require('fs').readFileSync(require.resolve('../../src/features/ai-agents'), 'utf8');
    check('mcp servers: runTools adds skills and the servers\' tools to the run\'s own list, not the shared one', /deps\.skillTools\?\.\(chat\)/.test(runTools) && /deps\.mcpServerTools\?\.\(chat\)/.test(runTools), 'x');
  }

  // ---- a background task on a CLI that answers in the sidebar only
  const opts = [{ id: 'claude-opus-5', label: 'Claude Opus 5' }, { id: 'antigravity:default', label: 'Antigravity', signedIn: true }, { id: 'codex:default', label: 'Codex', signedIn: true }, { id: 'grokbuild:default', label: 'Grok Build', signedIn: true }];
  check('tasks: Codex and Antigravity are not offered for background tasks', !bg.taskModels(opts).some((m) => /^(codex|antigravity):/.test(m.id)) && bg.taskModels(opts).some((m) => m.id === 'grokbuild:default'), J(bg.taskModels(opts).map((m) => m.id)));
  check('tasks: sidebarOnly names them, and nothing else', bg.sidebarOnly('antigravity:gemini-3') === 'Antigravity' && bg.sidebarOnly('codex:default') === 'Codex' && bg.sidebarOnly('claudecode:sonnet') === null && bg.sidebarOnly('claude-opus-5') === null, 'x');
  const en = require('../../src/locales/en.json');
  check('tasks: the refusal says why in plain words', /sidebar chats only/.test(en['tasks.error.sidebarOnly'] || '') && /\{name\}/.test(en['tasks.error.sidebarOnly']), 'x');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
