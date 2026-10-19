// parallel_tasks: helpers that act side by side, each in a background tab of its own (ai/acting-helpers.js, Agent.parallelTasks in
// agent.js). Plain Node: no Electron, no network; the model, the tabs and the tools are mocked. Covers the tool allowlist, the
// limits, approval cards marked per helper (Ask, Auto-allow, Bypass, sites approved earlier), stopping, and the capped results.
require('./_tmp-cleanup');
const A = require('../src/ai/acting-helpers');
const { Agent, requestFor, validateInput, EXTERNAL_TOOLS } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const use = (name, input, id = `u${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input });
const reply = (content) => ({ content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', model: 'mock', usage: { input_tokens: 100, output_tokens: 10 } });
const text = (t) => ({ type: 'text', text: t });

// A browser with tabs the helpers can open: each tab's address is what the mocked navigate set.
function makeBrowser(extra = {}) {
  const tabs = new Map();
  const front = { id: 1, url: 'https://home.test/' };
  const wc = (t) => ({ id: 100 + t.id, getURL: () => t.url, isDestroyed: () => false });
  tabs.set(1, { id: 1, webContents: wc(front) });
  const opened = [];
  let next = 10;
  const browser = {
    activeTab: () => tabs.get(1), tabById: (id) => tabs.get(id) || null, listTabs: () => [], effectiveModel: (m) => m, aiOff: undefined, noTabReason: () => '', maxSteps: () => 0,
    autoApprove: () => false, bypassPermissions: () => false, actingHelpers: () => true,
    openTab: (url, opts) => { const t = { id: next++, url: url || '' }; tabs.set(t.id, { id: t.id, webContents: wc(t), state: t }); opened.push({ id: t.id, opts }); return { id: t.id }; },
    ...extra,
  };
  browser.opened = opened;
  browser.setUrl = (id, url) => { tabs.get(id).state.url = url; };
  browser.close = (id) => tabs.delete(id);
  return browser;
}
const makeAgent = (extra = {}) => {
  const browser = makeBrowser(extra);
  const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5-5' }));
  agent.closeSignedInTabs = () => {};
  return { agent, browser };
};
const chatOf = () => { const m = []; m.settings = { model: 'claude-opus-5-5' }; return m; };
// Runs fn inside a sidebar chat's tool call, as runTask would: the chat's gate is set by ensureAllowed('parallel_tasks').
const inChat = (agent, chat, fn, { signal = new AbortController().signal, hosts = new Set() } = {}) => agent.inTask(1, signal, async () => {
  const events = [];
  await agent.ensureAllowed('parallel_tasks', (e) => events.push(e), signal, { input: {}, hosts });
  let value;
  let error = null;
  try { value = await fn(events); } catch (e) { error = e; }
  return { value, events, error };
}, chat, null, { hosts, chatId: 'c1', runId: 7 });
// A mocked tool layer: navigate sets the tab's address; every call is logged with the tab it ran in.
const mockExecute = (agent, browser, ran) => {
  agent.execute = async (name, args) => {
    const tab = agent.taskTab();
    ran.push({ name, args, tab: tab?.id });
    if (name === 'navigate') browser.setUrl(tab.id, args.url);
    return `<untrusted_page_content>${name} ok</untrusted_page_content>`;
  };
};

(async () => {
  // ---- the allowlist
  check('allowlist: the tab tools, nothing else', J([...A.ACT_TOOLS].sort()) === J(['click', 'fill_form', 'find', 'go_back', 'navigate', 'press_key', 'read_page', 'screenshot', 'scroll', 'type_text', 'wait_for']));
  check('allowlist: no scripts, uploads, apps, connectors, memory, plans, skills, delegation or tab switching', ['run_script', 'upload_file', 'desktop', 'connector', 'memory', 'propose_plan', 'use_skill', 'reading_list', 'delegate', 'parallel_tasks', 'open_tab', 'switch_tab', 'close_tab', 'read_urls', 'batch', 'drag'].every((n) => !A.isActTool(n)));
  check('input: read_page is always compact, screenshot never names another tab, navigate opens web pages only', A.prepareInput('read_page', { mode: 'full', extract: 'links' }).mode === 'compact' && !('extract' in A.prepareInput('read_page', { extract: 'links' })) && !('tab_id' in A.prepareInput('screenshot', { tab_id: 1 })) && (() => { try { A.prepareInput('navigate', { url: 'file:///etc/passwd' }); return false; } catch (e) { return /web pages only/.test(e.message); } })() && A.prepareInput('navigate', { url: 'https://a.test' }).url === 'https://a.test');
  check('prompt: the helpers are told never to buy, send or submit, and to hand that step back to the lead', /NEVER buy/.test(A.SYSTEM) && /send/.test(A.SYSTEM) && /submit/.test(A.SYSTEM) && /lead decides/.test(A.SYSTEM));

  // ---- the limits
  const cleaned = A.cleanTasks({ tasks: [{ task: 'a', url: 'https://a.test' }, 'b', { task: '' }, { task: 'c' }, { task: 'd' }] });
  check('limits: at most 3 helpers per call, the rest counted', cleaned.tasks.length === 3 && cleaned.dropped === 1 && J(cleaned.tasks[0].urls) === '["https://a.test"]', J(cleaned));
  check('limits: 20 steps and 5 minutes each', A.MAX_STEPS === 20 && A.TIME_MS === 300000 && A.MAX_TASKS === 3);
  {
    const calls = [];
    const greedy = async ({ noTools }) => { calls.push(noTools); return noTools ? reply([text('wrapped')]) : reply([use('scroll', { direction: 'down', n: calls.length })]); };
    const [r] = await A.runAll({ tasks: [{ task: 't', urls: [] }], turn: greedy, exec: async () => 'ok', tools: [], maxSteps: 100, timeMs: 10 * 60 * 1000 });
    check('limits: a larger step limit is held to 20, the 20th turn has tools off', r.steps <= 20 && calls[calls.length - 1] === true && r.text === 'wrapped', J([r, calls.length]));
  }
  {
    let live = 0;
    let peak = 0;
    const turn = async ({ messages }) => (messages.length === 1 ? reply([use('click', { element_id: 1 }), use('type_text', { element_id: 2, text: 'x' }), use('press_key', { key: 'Enter' })]) : reply([text('ok')]));
    await A.runAll({ tasks: [{ task: 't', urls: [] }], turn, exec: async () => { live++; peak = Math.max(peak, live); await sleep(20); live--; return 'ok'; }, tools: [] });
    check('one tab: a helper\'s calls in one turn run one after another', peak === 1, String(peak));
  }

  // ---- Agent.parallelTasks: tabs, approvals, stop, results
  {
    const { agent, browser } = makeAgent();
    const ran = [];
    mockExecute(agent, browser, ran);
    const seenTools = [];
    agent.helperCall = async (model, { messages, tools }) => {
      seenTools.push(tools.map((t) => t.name));
      const n = /job (\d)/.exec(messages[0].content)[1];
      if (messages.length === 1) return reply([use('navigate', { url: `https://site${n}.test/` }), use('read_page', { mode: 'full' }), use('run_script', { code: '1' })]);
      return reply([text(`report ${n} `.repeat(800))]); // ~7k characters: capped
    };
    const chat = chatOf();
    const { value, events, error } = await inChat(agent, chat, () => agent.parallelTasks({ tasks: [{ task: 'job 1' }, { task: 'job 2' }] }));
    check('runs: two helpers finish and come back as one result', !error && /Helper 1 \[done/.test(value) && /Helper 2 \[done/.test(value), String(error || value).slice(0, 300));
    check('tabs: each helper opens its own background tab, marked as the AI\'s', browser.opened.length === 2 && browser.opened.every((o) => o.opts.ai === true && o.opts.show === false), J(browser.opened));
    const tabOf = (host) => ran.find((r) => r.name === 'navigate' && r.args.url.includes(host))?.tab;
    check('tabs: each helper\'s tools act in its own tab, never the user\'s', tabOf('site1') !== tabOf('site2') && ran.every((r) => r.tab !== 1 && browser.opened.some((o) => o.id === r.tab)), J(ran));
    check('allowlist: run_script asked for by a helper is refused and never runs; read_page ran compact', !ran.some((r) => r.name === 'run_script') && ran.filter((r) => r.name === 'read_page').every((r) => r.args.mode === 'compact'), J(ran));
    check('allowlist: the helper model is offered the tab tools only (screenshot without tab_id)', seenTools.every((names) => J([...names].sort()) === J([...A.ACT_TOOLS].sort())));
    check('model: helpers use the cheaper model', /on Haiku/.test(value), value.slice(0, 200));
    const cards = events.filter((e) => e.type === 'helper_card');
    check('cards: each helper has a live card with its status, step and tab, ending done', [1, 2].every((n) => cards.some((c) => c.n === n && c.status === 'working' && c.step) && cards.some((c) => c.n === n && Number.isInteger(c.tabId)) && cards.filter((c) => c.n === n).pop().status === 'done'), J(cards.map((c) => [c.n, c.status, c.tabId])));
    check('results: untrusted, each helper\'s report capped at 3000 characters', /^<untrusted_page_content>/.test(value) && value.split('Helper ').slice(1).every((part) => part.length < A.ANSWER_CHARS + 200), String(value.length));
    check('taint: the chat counts as having read page content after', chat.tainted === true);
    check('cleanup: no helper scope or Stop is left behind', agent.helperStops.size === 0 && [...agent.scopes].every((s) => !s.actingHelper));
  }
  {
    // Ask: an acting step on a new site shows the chat's usual card, marked with the helper's number; "no" fails that step only.
    const { agent, browser } = makeAgent();
    const ran = [];
    mockExecute(agent, browser, ran);
    agent.helperCall = async (model, { messages }) => {
      const n = /job (\d)/.exec(messages[0].content)[1];
      if (messages.length === 1) return reply([use('navigate', { url: `https://shop${n}.test/` })]);
      if (messages.length === 3) return reply([use('click', { element_id: 4 })]);
      return reply([text(`helper ${n}: ${String(messages[4].content[0].content || messages[4].content).slice(0, 80)}`)]);
    };
    const chat = chatOf();
    const chatHosts = new Set(['shop3.test']);
    const pending = inChat(agent, chat, async (events) => {
      const answering = (async () => {
        for (let i = 0; i < 200; i++) {
          for (const e of events.filter((x) => x.type === 'approval' && !x.answered)) { e.answered = true; agent.resolveApproval(e.approvalId, e.host !== 'shop2.test'); }
          await sleep(5);
        }
      })();
      const v = await agent.parallelTasks({ tasks: [{ task: 'job 1' }, { task: 'job 2' }] });
      void answering;
      return v;
    }, { hosts: chatHosts });
    const { value, events } = await pending;
    const asks = events.filter((e) => e.type === 'approval');
    check('approval: each helper\'s first act on a site goes through the chat\'s card, marked with its number', asks.length === 2 && asks.every((a) => a.helper === Number(a.host.match(/shop(\d)/)[1])), J(asks));
    check('approval: a "no" refuses that helper\'s click only', ran.filter((r) => r.name === 'click').length === 1 && /did not allow/.test(value) && /Helper 1 \[done/.test(value), J([ran.map((r) => r.name), value.slice(0, 400)]));
    check('approval: a site the user approved on a helper\'s card counts for the chat; a refused one does not', chatHosts.has('shop1.test') && !chatHosts.has('shop2.test'), J([...chatHosts]));
  }
  {
    // Sites the user already approved in this chat carry over.
    const { agent, browser } = makeAgent();
    mockExecute(agent, browser, []);
    agent.helperCall = async (model, { messages }) => (messages.length === 1 ? reply([use('navigate', { url: 'https://known.test/' }), use('click', { element_id: 1 })]) : reply([text('ok')]));
    const { events } = await inChat(agent, chatOf(), () => agent.parallelTasks({ tasks: [{ task: 'job 1' }] }), { hosts: new Set(['known.test']) });
    check('approval: a site already approved in this chat is not asked about again', !events.some((e) => e.type === 'approval'), J(events.filter((e) => e.type === 'approval')));
  }
  {
    // Auto-allow and Bypass answer as in the chat.
    const auto = makeAgent({ autoApprove: () => true });
    mockExecute(auto.agent, auto.browser, []);
    const flow = async (model, { messages }) => (messages.length === 1 ? reply([use('navigate', { url: 'https://new.test/' }), use('click', { element_id: 1 })]) : reply([text('ok')]));
    auto.agent.helperCall = flow;
    const a = await inChat(auto.agent, chatOf(), () => auto.agent.parallelTasks({ tasks: [{ task: 'job 1' }] }));
    check('Auto-allow: no card, as in the chat', !a.events.some((e) => e.type === 'approval') && /Helper 1 \[done/.test(a.value));
    const by = makeAgent({ bypassPermissions: () => true });
    mockExecute(by.agent, by.browser, []);
    by.agent.helperCall = flow;
    const b = await inChat(by.agent, chatOf(), () => by.agent.parallelTasks({ tasks: [{ task: 'job 1' }] }));
    const rows = b.events.filter((e) => e.type === 'tool' && e.name === 'auto_allowed');
    check('Bypass: no card, and the "allowed" step names the helper', !b.events.some((e) => e.type === 'approval') && rows.length === 1 && /^Helper 1: /.test(rows[0].label), J(rows));
  }
  {
    // Stopping the chat stops every helper; a helper's own Stop stops that one only.
    const { agent, browser } = makeAgent();
    mockExecute(agent, browser, []);
    const hang = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    agent.helperCall = async (model, { messages, signal }) => {
      if (/job 1/.test(messages[0].content)) return messages.length === 1 ? reply([use('navigate', { url: 'https://a.test/' })]) : hang(signal);
      return messages.length === 1 ? reply([use('navigate', { url: 'https://b.test/' })]) : (await sleep(80), reply([text('two done')]));
    };
    const one = await inChat(agent, chatOf(), async (events) => {
      setTimeout(() => { const c = events.find((e) => e.type === 'helper_card' && e.n === 1); agent.stopHelper(c.key); }, 40);
      return agent.parallelTasks({ tasks: [{ task: 'job 1' }, { task: 'job 2' }] });
    });
    check('stop: a helper card\'s Stop stops that helper only', /Helper 1 \[stopped\]/.test(one.value) && /Helper 2 \[done/.test(one.value) && /two done/.test(one.value), String(one.error || one.value).slice(0, 300));
    const ctl = new AbortController();
    const seen = [];
    const all = makeAgent();
    mockExecute(all.agent, all.browser, []);
    all.agent.helperCall = async (model, { messages, signal }) => (messages.length === 1 ? reply([use('navigate', { url: 'https://c.test/' })]) : hang(signal));
    setTimeout(() => ctl.abort(), 60);
    const r = await inChat(all.agent, chatOf(), async (events) => { const v = await all.agent.parallelTasks({ tasks: [{ task: 'job 1' }, { task: 'job 2' }, { task: 'job 3' }] }).finally(() => seen.push(...events)); return v; }, { signal: ctl.signal });
    const last = [1, 2, 3].map((n) => seen.filter((e) => e.type === 'helper_card' && e.n === n).pop()?.status);
    check('stop: stopping the chat stops every helper and ends the call', r.error !== null && J(last) === '["stopped","stopped","stopped"]' && all.agent.helperStops.size === 0, J([String(r.error), last]));
    check('stop: an unknown key stops nothing', agent.stopHelper('nope') === false);
  }

  // ---- the setting and the tool
  {
    const chat = chatOf();
    const off = requestFor(chat.settings, chat);
    const on = requestFor(chat.settings, chat, undefined, { acting: true });
    check('setting: the tool is offered only while it is on (off by default)', !off.tools.some((t) => t.name === 'parallel_tasks') && on.tools.some((t) => t.name === 'parallel_tasks'));
    check('tool: a short definition, and input checked like any other', JSON.stringify(on.tools.find((t) => t.name === 'parallel_tasks')).length < 700 && validateInput('parallel_tasks', { tasks: [{ task: 'x' }] }) === null && validateInput('parallel_tasks', { tasks: [{}] }) !== null);
    check('tool: not listed to MCP clients or the CLI engines', !EXTERNAL_TOOLS.some((t) => t.name === 'parallel_tasks'));
    const { agent } = makeAgent({ actingHelpers: () => false });
    const r = await inChat(agent, chatOf(), () => agent.parallelTasks({ tasks: [{ task: 'job 1' }] }));
    check('setting: off, a call is refused with where to turn it on', /Let helpers act in tabs/.test(String(r.error?.message)), String(r.error));
    const outside = makeAgent();
    let err = '';
    try { await outside.agent.parallelTasks({ tasks: [{ task: 'x' }] }); } catch (e) { err = e.message; }
    check('scope: outside a sidebar chat (an outside agent, a task) it is refused', /sidebar chat/.test(err), err);
    const params = [];
    const wired = makeAgent();
    wired.agent.getClient = () => ({ beta: { messages: { stream: (p) => { params.push(p); return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => reply([text('hi')]) }; } } } });
    await wired.agent.claudeTurn(chat, new AbortController().signal, () => {});
    check('setting: claudeTurn offers the tool while the setting is on', params[0].tools.some((t) => t.name === 'parallel_tasks'));
  }
  {
    // [plan mode] while planning, parallel_tasks is neither offered nor allowed
    const pm = require('../src/ai/plan-mode');
    check('plan mode: parallel_tasks is not in the planning allowlist', !pm.PLAN_TOOLS.has('parallel_tasks'));
    const { agent } = makeAgent();
    let refused = '';
    await agent.inTask(1, new AbortController().signal, async () => {
      try { await agent.ensureAllowed('parallel_tasks', () => {}, new AbortController().signal, { input: { tasks: [{ task: 'x' }] } }); } catch (e) { refused = e.message; }
    }, chatOf(), null, { planMode: true, hosts: new Set() });
    check('plan mode: a parallel_tasks call while planning is refused before anything runs', refused.length > 0, refused);
    const params = [];
    agent.getClient = () => ({ beta: { messages: { stream: (p) => { params.push(p); return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => reply([text('hi')]) }; } } } });
    await agent.inTask(1, new AbortController().signal, () => agent.claudeTurn(chatOf(), new AbortController().signal, () => {}), chatOf(), null, { planMode: true });
    check('plan mode: the tool is not offered while planning', params.length === 1 && !params[0].tools.some((t) => t.name === 'parallel_tasks'));
  }
  {
    check('label events: approval cards carry the helper number; other helper events stay out of the chat', A.labelEvent({ type: 'approval', approvalId: 1, host: 'x' }, 2).helper === 2 && A.labelEvent({ type: 'tool', name: 'click', id: 'a' }, 2) === null && A.labelEvent({ type: 'approval_done', approvalId: 1 }, 2).approvalId === 1);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
