// Helpers that run as CLI processes (ai/cli-helpers.js, Agent.runCliHelpers / cliHelperOnce in agent.js). Plain Node: fake engines and
// fake runs only, no real grok / claude / codex / agy, no network. Covers the engine order, the process limit, stopping, the fallback
// from one engine to the next, normal mode (never full access unless the chat has it), the step rows, and the result text.
require('../helpers/_tmp-cleanup');
const lib = require('../../src/ai/cli-helpers');
const { Agent } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

(async () => {
  // ---- order
  const ready = { installed: true, signedIn: true, enabled: true };
  const status = { claudecode: ready, codex: ready, grokbuild: ready, antigravity: { ...ready, enabled: false } };
  check('order: the chat\'s own engine first, then the other signed-in CLIs, then an API key', J(lib.candidates({ own: 'grokbuild', status, apiKey: true })) === J([{ type: 'cli', kind: 'grokbuild' }, { type: 'cli', kind: 'claudecode' }, { type: 'cli', kind: 'codex' }, { type: 'api' }]), J(lib.candidates({ own: 'grokbuild', status, apiKey: true })));
  check('order: a CLI that is not signed in, not installed or not offered is left out', J(lib.candidates({ own: null, status: { claudecode: { installed: true, signedIn: false, enabled: true }, codex: { installed: false, signedIn: true, enabled: true }, grokbuild: { installed: true, signedIn: 'unknown', enabled: true }, antigravity: { installed: true, signedIn: true, enabled: false } } })) === '[]', 'x');
  check('order: no API key is needed when a CLI is signed in; a key is the last choice only when there is one', !lib.candidates({ own: null, status }).some((c) => c.type === 'api') && lib.candidates({ own: null, status: {}, apiKey: true }).length === 1, 'x');
  check('jobs: at most 3, empty ones dropped, the rest counted', (() => { const r = lib.cleanJobs([{ task: 'a' }, '', { task: 'b' }, 'c', { task: 'd' }]); return r.jobs.length === 3 && r.dropped === 1; })(), 'x');

  // ---- pool, events, fallback, stopping
  const runBatch = async ({ n = 5, runOn, signal, list = [{ type: 'cli', kind: 'grokbuild' }], api = null, timeMs }) => {
    const pool = lib.createPool(3);
    const events = [];
    const results = await lib.runJobs({ jobs: Array.from({ length: n }, (_, i) => ({ task: `job ${i + 1}` })), list, runOn, api, pool, signal, onEvent: (e) => events.push(e), ...(timeMs ? { timeMs } : {}) });
    return { pool, events, results };
  };
  {
    let live = 0;
    const { pool, results, events } = await runBatch({ runOn: async (c, { prompt }) => { live++; await sleep(20); live--; return { text: `answer to ${prompt.split('Job: ')[1]}` }; } });
    check('limit: five jobs, never more than 3 helper processes at once', pool.peak === 3 && results.length === 5 && results.every((r) => r.status === 'done'), `${pool.peak} ${J(results.map((r) => r.status))}`);
    check('steps: every helper is a start, a step and a done event (its row in the chat)', [1, 2, 3, 4, 5].every((n) => ['start', 'step', 'done'].every((t) => events.some((e) => e.n === n && e.type === t))), J(events.slice(0, 4)));
    check('results: each answer is its own job\'s', results[2].text === 'answer to job 3', J(results[2]));
  }
  {
    // stop: the parent run's signal reaches every helper's run (the engine kills its process tree on it), queued ones never start
    const ctrl = new AbortController();
    const started = [];
    const sawAbort = [];
    const p = runBatch({ signal: ctrl.signal, n: 5, runOn: (c, { signal }) => new Promise((resolve) => { started.push(1); signal.addEventListener('abort', () => { sawAbort.push(1); resolve({ stopped: true, text: '' }); }, { once: true }); }) });
    await sleep(30);
    ctrl.abort();
    const { results, pool } = await p;
    check('stop: the helpers running are stopped through their signals and the queued ones never start', started.length === 3 && sawAbort.length === 3 && results.every((r) => r.status === 'stopped') && pool.active === 0, J({ started: started.length, sawAbort: sawAbort.length, results: results.map((r) => r.status), active: pool.active }));
  }
  {
    // fallback: the first engine fails with nothing to show, the next one answers; a failed last one is a failed job; an API key last
    const tried = [];
    const list = [{ type: 'cli', kind: 'grokbuild' }, { type: 'cli', kind: 'claudecode' }, { type: 'api' }];
    const { results } = await runBatch({ n: 2, list, runOn: async (c) => { tried.push(c.kind); return c.kind === 'grokbuild' ? { failed: true, text: '', error: 'usage limit' } : { text: `via ${c.kind}` }; }, api: async () => 'api answer' });
    check('fallback: a failed engine hands the job to the next signed-in CLI', results.every((r) => r.status === 'done' && r.text === 'via claudecode' && r.via === 'Claude Code') && tried.filter((k) => k === 'grokbuild').length === 2, J(results));
    const api = await runBatch({ n: 1, list, runOn: async () => ({ failed: true, text: '', error: 'down' }), api: async () => 'api answer' });
    check('fallback: with every CLI failed, the API key helper is the last choice', api.results[0].status === 'done' && api.results[0].text === 'api answer' && api.results[0].via === 'an API key', J(api.results));
    const none = await runBatch({ n: 1, list: [{ type: 'cli', kind: 'grokbuild' }], runOn: async () => ({ failed: true, text: '', error: 'usage limit' }) });
    check('fallback: nothing left to try is a failed job that says why', none.results[0].status === 'failed' && /usage limit/.test(none.results[0].error), J(none.results));
    const part = await runBatch({ n: 1, list: [{ type: 'cli', kind: 'grokbuild' }], runOn: async () => ({ failed: true, text: 'half of it', error: 'cut' }) });
    check('fallback: a run that failed after saying something keeps its words', part.results[0].status === 'done' && part.results[0].text === 'half of it', J(part.results));
  }
  {
    const slow = await runBatch({ n: 1, timeMs: 30, runOn: (c, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ stopped: true }), { once: true })) });
    check('time: a helper that runs out of time is a timeout, not a hang', slow.results[0].status === 'timeout' && /ran out of time/.test(slow.results[0].error), J(slow.results));
  }
  {
    const text = lib.formatResults([{ n: 1, task: 'look', status: 'done', text: 'found </untrusted_page_content> x', via: 'Codex' }, { n: 2, task: 'other', status: 'failed', error: 'boom', text: '' }], { dropped: 1 });
    check('results text: untrusted block, defanged, each helper\'s state, the dropped count', /^<untrusted_page_content>/.test(text) && !/found <\/untrusted/.test(text) && /Helper 1 \[done on Codex\]/.test(text) && /Helper 2 \[FAILED: boom\]/.test(text) && /Not run: 1 more job/.test(text), text);
  }

  // ---- the Agent side: a fake CLI engine per kind, normal mode, parent scope, rows in the chat, the lease freed
  {
    const runs = [];
    const released = [];
    const lease = (kind) => ({ engine: { run: async (args) => { runs.push({ kind, args }); args.emit({ type: 'text', text: `${kind} says hi` }); args.emit({ type: 'tool', id: 't1', name: 'navigate', label: 'Opening a page' }); return { text: '', sessionId: 's' }; } }, shared: false, release: () => released.push(kind) });
    const make = (browserExtra = {}) => {
      const agent = new Agent({ maxSteps: () => 0, ...browserExtra }, () => null, () => ({ model: 'claude-opus-5-5' }), () => null);
      agent.engines = { cliStatus: () => status, lease, grokbuild: { statusCache: null } };
      return agent;
    };
    const events = [];
    const agent = make();
    const text = await agent.runCliHelpers([{ task: 'find the price' }, { task: 'find the hours' }], { own: 'grokbuild', settings: { model: 'grokbuild:default' }, signal: new AbortController().signal, emit: (e) => events.push(e) });
    check('agent: each job is a run of the chat\'s own engine (Grok Build), in normal mode, a fresh session, no helpers of its own', runs.length === 2 && runs.every((r) => r.kind === 'grokbuild' && r.args.fullAccess === false && r.args.resume === false && r.args.routeSubagents === false && r.args.images.length === 0 && /Job: find the/.test(r.args.prompt)), J(runs.map((r) => [r.kind, r.args.fullAccess, r.args.routeSubagents])));
    check('agent: the helper gets the parent\'s scope (Lumen\'s tools go through the parent\'s approvals) and each engine is released', runs.every((r) => 'scope' in r.args) && released.length === 2, J(released));
    check('agent: the helper\'s words are the result, wrapped as untrusted', /grokbuild says hi/.test(text) && /^<untrusted_page_content>/.test(text), text);
    check('agent: every helper is a step row (start, label, its own tool steps, done)', events.filter((e) => e.type === 'tool' && e.name === 'helper').length === 2 && events.some((e) => e.type === 'tool_update' && /Helper 1 on Grok Build/.test(e.label)) && events.some((e) => e.type === 'tool' && /^helper-.*:t1$/.test(e.id) && /Helper \d · Opening a page/.test(e.label)) && events.filter((e) => e.type === 'tool_done' && e.ok === true).length >= 2, J(events.map((e) => [e.type, e.id, e.label])));

    // full access only where the chat already has it, and only on its own engine
    runs.length = 0;
    const full = make({ grokBuildFullAccess: () => true, codexFullAccess: () => true });
    await full.runCliHelpers([{ task: 'x' }], { own: 'grokbuild', settings: { model: 'grokbuild:default' }, signal: new AbortController().signal, emit: () => {} });
    check('agent: full access reaches a helper only when the chat is on that engine and has it on', runs[0].args.fullAccess === true, J(runs[0].args.fullAccess));
    runs.length = 0;
    const other = make({ grokBuildFullAccess: () => true, codexFullAccess: () => true });
    other.engines.cliStatus = () => ({ ...status, grokbuild: { ...ready, signedIn: false } });
    const viaApi = await other.runCliHelpers([{ task: 'x' }], { own: 'codex', settings: { model: 'codex:default' }, signal: new AbortController().signal, emit: () => {} });
    check('agent: a Codex chat with full access on gives its Codex helper the same', runs.length === 1 && runs[0].kind === 'codex' && runs[0].args.fullAccess === true && viaApi.includes('codex says hi'), J(runs.map((r) => [r.kind, r.args.fullAccess])));
    runs.length = 0;
    const cross = make({ grokBuildFullAccess: () => true });
    cross.engines.cliStatus = () => ({ claudecode: ready });
    await cross.runCliHelpers([{ task: 'x' }], { own: null, settings: { model: 'claude-opus-5-5' }, signal: new AbortController().signal, emit: () => {} });
    check('agent: an API chat\'s helper on a CLI is in normal mode (not the chat\'s own engine)', runs.length === 1 && runs[0].kind === 'claudecode' && runs[0].args.fullAccess === false, J(runs.map((r) => [r.kind, r.args.fullAccess])));
    const none = make();
    none.engines.cliStatus = () => ({});
    check('agent: nothing signed in and no key is null (the caller says what to do)', (await none.runCliHelpers([{ task: 'x' }], { own: null, settings: {}, signal: new AbortController().signal, emit: () => {} })) === null, 'x');
  }
  // ---- every engine: the delegate tool of a CLI chat, and the API chats' fallback onto a CLI
  {
    check('jobs: numbers kept and a bigger cap taken (the API helpers\' fallback)', (() => { const r = lib.cleanJobs([{ task: 'a', n: 2 }, { task: 'b', n: 4 }, 'c', 'd', 'e'], 5); return r.jobs.length === 5 && r.jobs[1].n === 4 && !('n' in r.jobs[2]) && r.dropped === 0; })(), 'x');
    check('needs more: files, a terminal, or a helper that asked for a tool it lacks', lib.needsMore('run the command npm test in the terminal') && lib.needsMore('read the local file notes.txt') && lib.needsMore('x', { refused: ['click'] }) && !lib.needsMore('find the price of a flight on two sites') && !lib.needsMore('summarize this page', { status: 'done' }), 'x');
    const mk = (extra = {}, model = 'claude-opus-5-5') => {
      const tab = { id: 1, webContents: { id: 101, getURL: () => 'https://t.test/', isDestroyed: () => false } };
      const browser = { activeTab: () => tab, tabById: () => tab, listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => '', maxSteps: () => 0, autoApprove: () => false, ...extra };
      const agent = new Agent(browser, () => null, () => ({ model }));
      agent.closeSignedInTabs = () => {};
      return agent;
    };
    // the tool: which engines list it
    const on = mk();
    check('tool: Claude Code (no full access), Codex and Antigravity are offered delegate; Grok Build is not (its spawn_subagent is answered directly)', ['claudecode', 'codex', 'antigravity'].every((k) => on.cliHelperToolDefs(k).length === 1 && on.cliHelperToolDefs(k)[0].name === 'delegate') && on.cliHelperToolDefs('grokbuild').length === 0, 'x');
    check('tool: Claude Code with full access keeps its own Agent tool, so no second one; helpers off lists nothing; a helper\'s own engine is never offered it', mk({ claudeCodeFullAccess: () => true }).cliHelperToolDefs('claudecode').length === 0 && mk({ claudeCodeFullAccess: () => true }).cliHelperToolDefs('codex').length === 1 && mk({ subagents: () => false }).cliHelperToolDefs('codex').length === 0, 'x');
    check('tool: the description stays short (the shared tool list and Grok prompt do not grow)', on.cliHelperToolDefs('codex')[0].description.length <= 200, String(on.cliHelperToolDefs('codex')[0].description.length));
    // a CLI chat's delegate runs its own engine's helpers, with the parent's scope, normal mode
    const runs = [];
    const lease = (kind) => ({ engine: { kind, run: async (args) => { runs.push({ kind, args }); args.emit({ type: 'text', text: kind + ' report' }); return { text: kind + ' report' }; } }, release() {} });
    const chatOf = (model) => { const m = []; m.settings = { model }; return m; };
    const inChat = (agent, chat, fn, signal = new AbortController().signal) => agent.inTask(1, signal, async () => {
      const events = [];
      await agent.ensureAllowed('delegate', (e) => events.push(e), signal, { input: {} });
      return { value: await fn(), events };
    }, chat);
    for (const kind of ['claudecode', 'codex', 'antigravity']) {
      runs.length = 0;
      const agent = mk({}, kind + ':default');
      agent.engines = { cliStatus: () => status, lease };
      const { value, events } = await inChat(agent, chatOf(kind + ':default'), () => agent.delegate({ tasks: [{ task: 'look A', urls: ['https://a.test'] }, { task: 'look B' }] }));
      check('delegate on ' + kind + ': two helpers run on its own engine in normal mode, with the chat\'s scope, as step rows', runs.length === 2 && runs.every((r) => r.kind === kind && r.args.fullAccess === false && 'scope' in r.args && /Start with: https:\/\/a\.test|look B/.test(r.args.prompt)) && /Helper 2 \[done on /.test(value) && events.filter((e) => e.type === 'tool' && e.name === 'helper').length === 2, J(runs.map((r) => [r.kind, r.args.fullAccess])));
    }
    {
      const agent = mk({}, 'codex:default');
      agent.engines = { cliStatus: () => ({}), lease };
      let err = '';
      await inChat(agent, chatOf('codex:default'), () => agent.delegate({ tasks: [{ task: 'x' }] }).catch((e) => { err = e.message; }));
      check('delegate on a CLI chat with nothing else signed in still has its own engine; with no tasks it says what is missing', runs.length > 0, 'x');
      await inChat(agent, chatOf('codex:default'), () => agent.delegate({ tasks: [] }).catch((e) => { err = e.message; }));
      check('delegate: no tasks is a plain error', /needs tasks/.test(err), err);
    }
    // an API chat: the API model first, a signed-in CLI when it fails or the job needs files / a terminal
    const reply = (content) => ({ content, stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } });
    const text = (t) => ({ type: 'text', text: t });
    {
      runs.length = 0;
      const agent = mk();
      agent.engines = { cliStatus: () => ({ codex: ready }), lease };
      const used = [];
      agent.helperCall = async (model, { messages }) => { used.push(messages[0].content); if (/B job/.test(messages[0].content)) throw Object.assign(new Error('rate limit'), { status: 429 }); return reply([text('api answer')]); };
      agent.execute = async () => 'page';
      const { value, events } = await inChat(agent, chatOf('claude-opus-5-5'), () => agent.delegate({ tasks: [{ task: 'A job' }, { task: 'B job' }, { task: 'run the command dir in the terminal' }] }));
      check('api fallback: the API model first; the failed job and the terminal job run on a signed-in CLI, in order and numbered as asked', used.length === 2 && runs.length === 2 && runs.every((r) => r.kind === 'codex' && r.args.fullAccess === false) && /Helper 1 \[done, 1 step/.test(value) && /Helper 2 \[done on Codex\]/.test(value) && /Helper 3 \[done on Codex\]/.test(value), value);
      check('api fallback: the CLI helpers show as step rows, and the result says some ran as CLI runs', events.filter((e) => e.type === 'tool' && e.name === 'helper').length === 2 && /separate CLI runs/.test(value), J(events.map((e) => e.type)));
      const rows = events.filter((e) => e.type === 'tool' && e.name === 'helper').map((e) => e.label);
      check('api fallback: the rows keep the job numbers (Helper 2, Helper 3)', rows.some((l) => /^Helper 2:/.test(l)) && rows.some((l) => /^Helper 3:/.test(l)), J(rows));
    }
    {
      runs.length = 0;
      const agent = mk();
      agent.engines = { cliStatus: () => ({}), lease };
      agent.helperCall = async () => { throw Object.assign(new Error('no key'), { status: 401 }); };
      const { value } = await inChat(agent, chatOf('claude-opus-5-5'), () => agent.delegate({ tasks: [{ task: 'A job' }] }));
      check('api fallback: no CLI signed in leaves the API failure as it was (nothing runs)', runs.length === 0 && /Helper 1 \[FAILED: no key/.test(value), value);
      const agent2 = mk();
      agent2.engines = { cliStatus: () => ({ codex: ready }), lease };
      agent2.helperCall = async (model, { messages }) => (messages.length === 1 ? reply([{ type: 'tool_use', id: 'u1', name: 'click', input: { text: 'x' } }]) : reply([text('could not click')]));
      agent2.execute = async () => 'x';
      runs.length = 0;
      const out = await inChat(agent2, chatOf('claude-opus-5-5'), () => agent2.delegate({ tasks: [{ task: 'press the button' }] }));
      check('api fallback: a helper that needed a tool it lacks (a click) is run again on a CLI', runs.length === 1 && /done on Codex/.test(out.value), out.value);
      // the API run that was given a model (the CLI chats' last-resort API helper) never falls back again
      const agent3 = mk();
      agent3.engines = { cliStatus: () => ({ codex: ready }), lease };
      agent3.helperCall = async () => { throw new Error('down'); };
      runs.length = 0;
      await inChat(agent3, chatOf('claude-opus-5-5'), () => agent3.delegate({ tasks: [{ task: 'A job' }] }, { model: 'claude-haiku-5-5' }));
      check('api fallback: delegate called with a model (a CLI chat\'s API helper) does not hand the job to a CLI again', runs.length === 0, J(runs.length));
    }
    {
      // stopping the chat stops the fallback's helpers too
      const ctrl = new AbortController();
      const agent = mk();
      let sawAbort = false;
      agent.engines = { cliStatus: () => ({ codex: ready }), lease: () => ({ engine: { kind: 'codex', run: (args) => new Promise((resolve) => { args.signal.addEventListener('abort', () => { sawAbort = true; resolve({ stopped: true, text: '' }); }, { once: true }); }) }, release() {} }) };
      agent.helperCall = async () => { throw new Error('down'); };
      const p = inChat(agent, chatOf('claude-opus-5-5'), () => agent.delegate({ tasks: [{ task: 'A job' }] }), ctrl.signal).catch((e) => e);
      await sleep(80);
      ctrl.abort();
      const r = await p;
      check('api fallback: Stop reaches the CLI helper', sawAbort && r instanceof Error, String(r));
    }
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.log(`FAIL  cli-helpers-units  -> ${err?.stack || err}`); process.exit(1); });
