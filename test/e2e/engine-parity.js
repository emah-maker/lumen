// [engine parity] In a real (invisible) window with fake engines and a fake MCP server (nothing real is run or visited): a Lumen-owned CLI run
// (Codex, Claude Code) is offered use_skill when the chat lists skills, and the tools of the MCP servers the user added; both calls go through
// Lumen's MCP path; an outside MCP client gets neither.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const profile = process.env.CLAUDE_BROWSER_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'parity-e2e-profile-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    // A fake MCP server the user "added": one running tool, always allowed, so its call needs no card.
    await app.evaluate(() => {
      const ext = global.__mcpClient;
      const def = { name: 'fakesrv__echo', description: '[Tool from the MCP server “fakesrv”, which the user added.] Echo', input_schema: { type: 'object', properties: { text: { type: 'string' } } } };
      Object.assign(ext, {
        readyDefs: () => [def],
        tools: async () => ({ defs: [def], failed: [] }),
        isExternal: (n) => n === 'fakesrv__echo',
        lookupTool: (n) => (n === 'fakesrv__echo' ? { id: 'x', server: 'fakesrv', tool: 'echo' } : null),
        isAlwaysAllowed: () => true,
        isReadOnlyPreset: () => false,
        call: async (_n, args) => `echo: ${args.text}`,
      });
    });
    const skills = '<skills>\nThe user saved these skills: ... call use_skill with its name first.\n- weekly-report: The Friday report\n</skills>';
    for (const [model, turn] of [['codex:default', 'codexTurn'], ['claudecode:default', 'claudeCodeTurn']]) {
      const out = await app.evaluate(async (_e, { model, turn, skills }) => {
        const agent = global.__agent;
        agent.messages.settings = { model, adhdMode: true, skillsList: skills };
        const res = {};
        agent[turn] = async (_m, _t, _i, signal, emit) => {
          global.__fakeEngine = { owns: (t) => t === 'parity-tag', active: { emit, signal, scope: agent.runScope } };
          const own = { engine: 'parity-tag', approvedHosts: new Set(), clientName: 'Codex', controller: new AbortController() };
          const outside = { approvedHosts: new Set(), clientName: 'Some other app', controller: new AbortController() };
          const mine = global.__mcpToolsFor(own);
          const theirs = global.__mcpToolsFor(outside);
          res.listed = { skill: mine.includes('use_skill'), server: mine.includes('fakesrv__echo'), outsideSkill: theirs.includes('use_skill'), outsideServer: theirs.includes('fakesrv__echo') };
          const s = await global.__mcpCallTool('use_skill', { name: 'not-a-skill' }, own);
          res.skill = (s.content || []).map((b) => b.text).join(' ');
          const e = await global.__mcpCallTool('fakesrv__echo', { text: 'hi' }, own);
          res.echo = { isError: e.isError, text: (e.content || []).map((b) => b.text).join(' ') };
          const o = await global.__mcpCallTool('fakesrv__echo', { text: 'hi' }, outside);
          res.outside = { isError: o.isError };
        };
        await new Promise((resolve) => agent.run('hello', (ev) => { if (ev.type === 'done') resolve(); }));
        global.__fakeEngine = null;
        return res;
      }, { model, turn, skills });
      const who = model.split(':')[0];
      check(`${who}: the run is offered use_skill and the added server's tool; an outside client neither`, out.listed?.skill && out.listed.server && !out.listed.outsideSkill && !out.listed.outsideServer, JSON.stringify(out.listed));
      check(`${who}: use_skill answers through Lumen's skills`, /No skill named/.test(out.skill || ''), out.skill);
      check(`${who}: the added server's tool runs; an outside client is refused`, out.echo?.isError !== true && /echo: hi/.test(out.echo?.text || '') && out.outside?.isError === true, JSON.stringify([out.echo, out.outside]));
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    if (!process.env.CLAUDE_BROWSER_PROFILE) fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
