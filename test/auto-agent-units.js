// Auto inside the agent (ai/agent.js routeAuto / escalateFor, runOnce's restore of the pick), plain Node: no Electron, no network,
// no CLI. A stand-in browser object gives the agent the router the way main.js does; the model turns are scripts.
const { Agent } = require('../src/ai/agent');
const fallback = require('../src/ai/fallback');
const A = require('../src/ai/auto-model');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = JSON.stringify;
const api = (name, status, type, message) => Object.assign(new Error(message), { name, status, error: { type: 'error', error: { type, message } } });
const HEAVY = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders', '4. Also make sure the API docs stay accurate'].join('\n');

const OPTS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', name: 'Opus 5.5', group: 'Claude' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', name: 'Sonnet 5', group: 'Claude' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', name: 'Haiku 4.5', group: 'Claude' },
  { id: 'openai:gpt-5.6', label: 'GPT-5.6', name: 'GPT-5.6', group: 'OpenAI' },
  { id: 'openai:gpt-5.6-mini', label: 'GPT-5.6 mini', name: 'GPT-5.6 mini', group: 'OpenAI' },
  { id: 'claudecode:sonnet', label: 'Claude Code · Sonnet', name: 'Sonnet', group: 'Your Claude account', signedIn: true },
  { id: 'claudecode:haiku', label: 'Claude Code · Haiku', name: 'Haiku', group: 'Your Claude account', signedIn: true },
];

function makeAgent({ options = OPTS, scripts = {}, others = 0, home = null } = {}) {
  const log = { turns: [], events: [], ran: [], denied: [], routed: [], changed: 0 };
  const denied = A.createDenied();
  const browser = {
    fallbackOptions: () => options, autoFallback: () => true, maxSteps: () => 0, onFallback() {}, aiOff: () => false, noTabReason: () => 'x', effectiveModel: (m) => m, activeTab: () => null,
    autoRoute: ({ request, last, allowEngines }) => { const d = A.route({ options, request, last, prefer: A.preferFrom({ lastId: last, home }), denied: denied.set(), cooldowns: fallback.shared, allowEngines }); log.routed.push({ request, allowEngines, id: d.id }); return d; },
    autoEscalate: ({ current, failure, request, tried, allowEngines }) => A.escalate({ options, current, failure, request, tried, denied: denied.set(), cooldowns: fallback.shared, allowEngines }),
    autoDeny: (id) => { log.denied.push(id); denied.add(id); },
    onAuto: () => { log.changed++; },
  };
  const agent = Object.assign(Object.create(Agent.prototype), {
    scopes: new Set(), runs: new Map(), approvedHosts: new Set(), browser, engines: { claudecode: { warm() {}, release() {} } },
    isExternalTool: () => false, async describeStep() { return 'step'; }, async ensureAllowed() {}, closeSignedInTabs() {}, guardRedirects: () => null,
    async pageContextFor() { return ''; }, newActionLog: () => ({}), undoSummary: () => null,
    async claudeTurn(messages) { return this.scripted(messages.settings.model, messages); },
    async otherTurn(messages) { return this.scripted(messages.settings.model, messages); },
    async scripted(model, messages) {
      log.turns.push(model);
      const step = (scripts[model] || []).shift();
      if (step instanceof Error) throw step;
      if (step) return { ...step, model };
      return { content: [{ type: 'text', text: `${model} answers` }], stop_reason: 'end_turn', model };
    },
    async claudeCodeTurn(messages) { log.turns.push(messages.settings.model); },
  });
  // runOnce's own steps, with the task itself recorded: what the model was when the turn would start
  agent.inTask = async (_tab, _signal, fn) => fn();
  agent.runTask = async function (messages, tab, userText, images, controller, emit) { log.ran.push({ model: messages.settings.model, text: userText, autoFrom: messages.settings.autoFrom }); await Agent.prototype.runTask.call(this, messages, tab, userText, images, controller, emit, {}); };
  return { agent, log, denied };
}
const fresh = (model = 'auto') => { const m = []; m.settings = { model, adhdMode: false }; return m; };
const once = async (agent, messages, text, log, extra = {}, images = []) => { await agent.runOnce(text, (e) => log.events.push(e), images, extra, null, messages); return messages; };
const tier = (id) => A.tierOf(OPTS.find((o) => o.id === id) || id);
const notices = (log) => log.events.filter((e) => e.type === 'notice').map((e) => e.text);

(async () => {
  // 1) A turn on Auto: the model is concrete while it runs, the pick comes back for the next.
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent({ home: 'claude-opus-5-5' });
    const messages = fresh();
    await once(agent, messages, 'hi', log);
    check('Auto: a quick message runs on a fast model, never "auto"', log.ran.length === 1 && tier(log.ran[0].model) === 'fast' && log.ran[0].model !== 'auto', J(log.ran));
    check('Auto: the turn is told the pick is Auto (autoFrom) and keeps the reason', messages.settings.autoFrom === 'auto' && /^Auto: /.test(messages.settings.autoLast.reason) && /^Auto · /.test(messages.settings.autoLast.label), J(messages.settings));
    check('Auto: an event names the model and why; done carries it too', log.events.some((e) => e.type === 'auto' && e.model === log.ran[0].model && /^Auto: /.test(e.reason)) && log.events.find((e) => e.type === 'done')?.auto?.reason, J(log.events.map((e) => e.type)));
    check('Auto: the model that answered is the one the history was built for (a Claude API turn ran)', log.turns[0] === log.ran[0].model, J(log.turns));
    check('Auto: the picker is told (so its row can say what Auto chose)', log.changed >= 1);
    await once(agent, messages, HEAVY, log);
    check('Auto: the next, harder message is routed afresh to a strong model', tier(log.ran[1].model) === 'strong' && messages.settings.autoFrom === 'auto', J(log.ran));
    await once(agent, messages, 'continue', log);
    check('Auto: a short follow-up after a hard task does not drop to the smallest model (hysteresis)', tier(log.ran[2].model) !== 'fast', J(log.ran.map((r) => r.model)));
    check('Auto: the stay-with-provider rule keeps the chat on one provider', log.ran.every((r) => (r.model.startsWith('openai:') ? 'o' : r.model.startsWith('claudecode:') ? 'c' : 'a') === (log.ran[0].model.startsWith('openai:') ? 'o' : log.ran[0].model.startsWith('claudecode:') ? 'c' : 'a')), J(log.ran.map((r) => r.model)));
  }

  // 2) /think, /deep, /fast: this message only, never sent as words
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent();
    const messages = fresh();
    await once(agent, messages, '/think why is the sky blue', log);
    await once(agent, messages, 'hello', log);
    await once(agent, messages, '/fast ' + HEAVY, log);
    check('/think: the strongest model, the command stripped from the text', tier(log.ran[0].model) === 'strong' && log.ran[0].text === 'why is the sky blue', J(log.ran));
    check('the next message is back to the normal choice', tier(log.ran[1].model) !== undefined && log.ran[1].text === 'hello', J(log.ran));
    check('/fast: the quickest model even for a hard-looking brief', tier(log.ran[2].model) === 'fast' && !log.ran[2].text.startsWith('/fast'), J(log.ran.map((r) => r.model)));
  }

  // 3) a model picked by hand is never touched
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent();
    const messages = fresh('claude-opus-5-5');
    await once(agent, messages, 'hi', log);
    check('a picked model is used as picked (Auto steps aside, no autoFrom, no routing)', log.ran[0].model === 'claude-opus-5-5' && !messages.settings.autoFrom && log.routed.length === 0, J(log.ran));
    const typed = fresh('claude-opus-5-5');
    await once(agent, typed, '/think hello', log);
    check('with a model picked, /think is not a hint: the text goes as typed', log.ran.pop().text === '/think hello');
    agent.messages = messages;
    messages.settings.model = 'auto';
    messages.settings.autoFrom = 'auto';
    messages.settings.autoLast = { id: 'x' };
    agent.setModel('claude-sonnet-5');
    check('picking a model by hand ends Auto in that chat', messages.settings.model === 'claude-sonnet-5' && !messages.settings.autoFrom && !messages.settings.autoLast);
  }

  // 4) nothing to choose from: a plain message, not a crash into a provider
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent({ options: [] });
    const messages = fresh();
    await once(agent, messages, 'hi', log);
    const err = log.events.find((e) => e.type === 'error');
    check('no model available: the turn ends with a plain error, nothing ran', Boolean(err) && log.turns.length === 0 && log.ran.length === 0, J(log.events));
  }

  // 5) CLI engines run beside other chats (each run has its own MCP connection): Auto may pick one while another chat runs
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent({ options: OPTS.filter((o) => o.id.startsWith('claudecode:')).concat([OPTS[1]]), home: 'claudecode:sonnet' });
    agent.runs.set(fresh(), { controller: new AbortController() });
    const messages = fresh();
    await once(agent, messages, 'hi', log);
    check('another chat is running: Auto may still hand this turn to a CLI engine', log.routed[0].allowEngines === true && log.ran[0].model.startsWith('claudecode:'), J(log.routed));
    agent.runs.clear();
    const m2 = fresh();
    await once(agent, m2, 'hi', log);
    check('...and when nothing else is running', log.routed[1].allowEngines === true && log.ran[1].model.startsWith('claudecode:'), J(log.ran));
  }

  // 6) escalation: too long for the cheap model -> the next one, once
  {
    fallback.shared.clear();
    const long = api('BadRequestError', 400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum');
    const first = A.route({ options: OPTS, request: { prompt: 'hi' } }).id;
    const { agent, log } = makeAgent({ scripts: { [first]: [long] } });
    const messages = fresh();
    await once(agent, messages, 'hi', log);
    check('too long: the same turn goes on another model, once', log.turns.length === 2 && log.turns[0] === first && log.turns[1] !== first, J(log.turns));
    check('too long: a quiet note says which and why', notices(log).some((t) => /^Auto: .+ for a longer conversation/.test(t)), J(notices(log)));
    check('too long: the chat keeps Auto as its pick', messages.settings.autoFrom === 'auto', J(messages.settings));
  }

  // 7) escalation: not on this plan -> another model at the same tier, and the model is remembered as refused
  {
    fallback.shared.clear();
    const denied = api('NotFoundError', 404, 'not_found_error', 'The model `claude-opus-5-5` does not exist or you do not have access to it.');
    const { agent, log } = makeAgent({ scripts: { 'claude-opus-5-5': [denied] }, home: 'claude-opus-5-5' });
    const messages = fresh();
    await once(agent, messages, HEAVY, log);
    check('a model not on this plan: refused once, another takes the turn', log.turns[0] === 'claude-opus-5-5' && log.turns.length === 2 && log.turns[1] !== 'claude-opus-5-5', J(log.turns));
    check('...and Auto remembers it', log.denied.includes('claude-opus-5-5'), J(log.denied));
    await once(agent, messages, HEAVY, log);
    check('...so the next message does not try it again', log.ran[1].model !== 'claude-opus-5-5', J(log.ran));
  }

  // 8) escalation: a refusal from a cheap model is retried on a stronger one, once
  {
    fallback.shared.clear();
    const first = A.route({ options: OPTS, request: { prompt: 'hi' } }).id;
    const { agent, log } = makeAgent({ scripts: { [first]: [{ content: [{ type: 'text', text: '' }], stop_reason: 'refusal' }] } });
    const messages = fresh();
    await once(agent, messages, 'hi', log);
    check('a refusal: one more try on a stronger model', log.turns.length === 2 && tier(log.turns[1]) !== 'fast', J(log.turns));
    const { agent: a2, log: l2 } = makeAgent({ scripts: { [first]: [{ content: [{ type: 'text', text: '' }], stop_reason: 'refusal' }], [log.turns[1]]: [{ content: [{ type: 'text', text: '' }], stop_reason: 'refusal' }] } });
    await once(a2, fresh(), 'hi', l2);
    check('a second refusal stands (no loop of retries)', l2.turns.length === 2 && notices(l2).some((t) => /declined/.test(t)), J(l2.turns));
  }

  // 9) a usage limit is the fallback's business: it still works, and the pick is Auto again next turn
  {
    fallback.shared.clear();
    const first = A.route({ options: OPTS, request: { prompt: 'hi' } }).id;
    const rl = api('RateLimitError', 429, 'rate_limit_error', 'rate limited');
    const { agent, log } = makeAgent({ scripts: { [first]: [rl] } });
    const messages = fresh();
    await once(agent, messages, 'hi', log);
    check('a limit on the chosen model: the fallback takes the turn on another', log.turns[0] === first && log.turns.length === 2 && log.turns[1] !== first, J(log.turns));
    await once(agent, messages, 'hi again', log);
    check('the next message is Auto again, and the limited model is left alone', log.ran[1].model !== first && messages.settings.autoFrom === 'auto' && fallback.shared.cooling(first.replace(/^anthropic:/, '')), J(log.ran));
  }

  // 10) an ordinary error is not an escalation (the error stands)
  {
    fallback.shared.clear();
    const first = A.route({ options: OPTS, request: { prompt: 'hi' } }).id;
    const { agent, log } = makeAgent({ scripts: { [first]: [new Error('boom')] } });
    await once(agent, fresh(), 'hi', log);
    check('an ordinary error: no second model, the error shows', log.turns.length === 1 && log.events.some((e) => e.type === 'error'), J(log.events.map((e) => e.type)));
  }

  // 11) a skill's own model, and images
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent({ options: [{ id: 'openrouter:vendor/blind', label: 'Blind', vision: false, group: 'OpenRouter' }, OPTS[1]] });
    const messages = fresh();
    await once(agent, messages, 'what is in this picture', log, {}, [{ media_type: 'image/png', data: 'AAAA' }]);
    check('an image in the message: a model that can see it', log.ran[0].model === 'claude-sonnet-5', J(log.ran));
  }

  if (failures) { console.log(`\n${failures} auto-agent check(s) failed`); process.exit(1); }
  console.log('\nAll auto-agent checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
