// The chat's own reasoning effort (the Effort row of the composer's model menu): which levels each model offers, how a chat's
// level (messages.settings.effort) is resolved against Settings → AI → AI providers, and what each engine is given. Plain Node.
const effort = require('../src/ai/effort');
const { Agent, MODELS } = require('../src/ai/agent');
const claudeCode = require('../src/ai/claude-code');
const codex = require('../src/ai/codex');
const grok = require('../src/ai/grok-build');
const agy = require('../src/ai/antigravity');
const providers = require('../src/ai/providers');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const has = (xs, ys) => JSON.stringify(xs) === JSON.stringify(ys);

(async () => {
  // ---- which levels each model offers (none: the row is hidden)
  check('Claude Code, Codex and Antigravity offer low to max', ['claudecode:default', 'codex:default', 'antigravity:default'].every((id) => has(effort.offered(id), ['low', 'medium', 'high', 'xhigh', 'max'])));
  check('Grok Build offers low, medium, high', has(effort.offered('grokbuild:default'), ['low', 'medium', 'high']));
  check('Claude API: only a model that already takes an effort (Opus 5.5) offers it', has(effort.offered('claude-opus-5-5', { anthropicHasEffort: true }), ['low', 'medium', 'high']) && has(effort.offered('claude-haiku-4-5'), []) && Boolean(MODELS['claude-opus-5-5']?.effort));
  check('OpenAI: reasoning models offer minimal..high, others none', has(effort.offered('openai:gpt-5'), ['minimal', 'low', 'medium', 'high']) && has(effort.offered('openai:o3'), ['minimal', 'low', 'medium', 'high']) && has(effort.offered('openai:gpt-4o'), []));
  check('xAI: only Grok 3 Mini (low, high)', has(effort.offered('xai:grok-3-mini'), ['low', 'high']) && has(effort.offered('xai:grok-4'), []));
  check('Gemini 2.5 and newer offer low..high; older do not', has(effort.offered('gemini:gemini-2.5-pro'), ['low', 'medium', 'high']) && has(effort.offered('gemini:gemini-3-pro'), ['low', 'medium', 'high']) && has(effort.offered('gemini:gemini-1.5-pro'), []));
  check('OpenRouter offers low..high for any model', has(effort.offered('openrouter:anthropic/claude-sonnet-4'), ['low', 'medium', 'high']));
  check('Auto, a provider’s own Auto, local models and unknown ids offer nothing', ['auto', 'auto:openai', 'local:llama3', 'weird:thing', '', undefined].every((id) => effort.offered(id).length === 0));
  check('only levels the engine takes are offered (never "minimal" for a CLI)', !effort.offered('claudecode:default').includes('minimal'));

  // ---- a chat's level against Settings
  check('Auto (no chat level): Settings decides, as before', effort.pick('openai', '', 'low') === 'low' && effort.pick('codex', undefined, '') === '' && effort.pick('claudecode', '', 'bogus') === '');
  check('a chat level wins over Settings', effort.pick('claudecode', 'high', 'low') === 'high' && effort.pick('openai', 'minimal', 'high') === 'minimal');
  check('a level the AI does not take is the nearest it does (High stays High, Max becomes High)', effort.pick('openai', 'max', '') === 'high' && effort.pick('xai', 'medium', '') === 'low' && effort.pick('grokbuild', 'xhigh', '') === 'high' && effort.pick('codex', 'minimal', '') === 'low');
  check('junk is not a chat level', effort.cleanChat('turbo') === '' && effort.cleanChat('HIGH') === 'high' && effort.cleanChat(null) === '');
  check('the model id decides the AI', effort.keyOfModel('claude-opus-5-5') === 'anthropic' && effort.keyOfModel('codex:gpt-5') === 'codex' && effort.keyOfModel('local:x') === '' && effort.keyOfModel('auto') === '');
  check('short labels cover every level', effort.ORDER.every((l) => effort.SHORT[l] && effort.LABELS[l]));

  // ---- what each engine is given (the chat's level through the same mapping as Settings)
  const eff = (key, chat, settings = '') => effort.pick(key, chat, settings);
  const ccArgs = claudeCode.buildArgs({ mcpConfig: 'm', sessionId: 's', effort: eff('claudecode', 'xhigh') });
  check('Claude Code: --effort <level>; Auto passes nothing', ccArgs[ccArgs.indexOf('--effort') + 1] === 'xhigh' && !claudeCode.buildArgs({ mcpConfig: 'm', sessionId: 's', effort: eff('claudecode', '') }).includes('--effort'));
  check('Codex: -c model_reasoning_effort=<level>', codex.buildArgs({ effort: eff('codex', 'max') }).includes('model_reasoning_effort=max') && !codex.buildArgs({ effort: eff('codex', '') }).some((a) => String(a).includes('model_reasoning_effort')));
  const gArgs = grok.buildArgs({ promptFile: 'p', sessionId: 's', cwd: '.', effort: eff('grokbuild', 'high') });
  check('Grok Build: --reasoning-effort <level>', gArgs[gArgs.indexOf('--reasoning-effort') + 1] === 'high' && !grok.buildArgs({ promptFile: 'p', sessionId: 's', cwd: '.', effort: eff('grokbuild', '') }).includes('--reasoning-effort'));
  const aArgs = agy.buildArgs({ prompt: 'x', effort: eff('antigravity', 'low') });
  check('Antigravity: --effort <level>', aArgs[aArgs.indexOf('--effort') + 1] === 'low' && !agy.buildArgs({ prompt: 'x', effort: '' }).includes('--effort'));
  check('API providers: reasoning_effort for reasoning models only, reasoning.effort for OpenRouter', effort.chatParams('openai', 'gpt-5', eff('openai', 'high')).reasoning_effort === 'high' && Object.keys(effort.chatParams('openai', 'gpt-4o', eff('openai', 'high'))).length === 0 && effort.chatParams('openrouter', 'x/y', eff('openrouter', 'medium')).reasoning.effort === 'medium' && effort.chatParams('gemini', 'gemini-2.5-pro', eff('gemini', 'low')).reasoning_effort === 'low');
  check('Claude API: a chat’s Max is High (the API’s top), and only for a model that carries an effort', effort.anthropicEffort(eff('anthropic', 'max'), true) === 'high' && effort.anthropicEffort(eff('anthropic', 'high'), false) === null);

  // ---- the Agent: chat level over Settings, ignored for Auto, saved with the chat, waits for the next message mid-reply
  const agent = (settings, global = {}) => ({ browser: { effort: (k) => global[k] || '' }, messages: settings === undefined ? [] : Object.assign([], { settings }), getOptions: () => ({}), effortFor: Agent.prototype.effortFor, setEffort: Agent.prototype.setEffort, openEffort: Agent.prototype.openEffort });
  const a1 = agent({ model: 'claudecode:default', effort: 'high' }, { claudecode: 'low' });
  check('Agent.effortFor: the chat’s level beats Settings', a1.effortFor('claudecode', a1.messages.settings) === 'high');
  const a2 = agent({ model: 'claudecode:default' }, { claudecode: 'low' });
  check('Agent.effortFor: a chat on Auto effort keeps today’s Settings value', a2.effortFor('claudecode', a2.messages.settings) === 'low' && a2.effortFor('codex', a2.messages.settings) === '');
  const a3 = agent({ model: 'auto', autoFrom: 'auto', effort: 'high' }, { openai: 'low' });
  check('Agent.effortFor: a chat on the Auto model ignores its own level (no single model to apply it to)', a3.effortFor('openai', a3.messages.settings) === 'low' && a3.effortFor('openai', { model: 'openai:gpt-5', autoFrom: 'auto', effort: 'high' }) === 'low');
  const a4 = agent(undefined);
  a4.running = false;
  check('setEffort on a chat with no message yet starts its settings on the shown model', a4.setEffort('medium', 'openai:gpt-5') === false && a4.messages.settings.effort === 'medium' && a4.messages.settings.model === 'openai:gpt-5');
  a4.setEffort('');
  check('Auto removes the chat’s level', !('effort' in a4.messages.settings) && a4.openEffort() === '');
  a4.setEffort('turbo');
  check('an unknown level is Auto', a4.openEffort() === '');
  a4.running = true;
  check('mid-reply the pick waits for the next message', a4.setEffort('max') === true && a4.messages.settings.effort === undefined && a4.openEffort() === 'max');

  // ---- the request really carries it (a stand-in client)
  let body = null;
  const client = { chat: { completions: { create: (b) => { body = b; return Promise.resolve((async function* () { yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }; })()); } } } };
  await providers.streamTurn({ provider: 'openai', model: 'gpt-5', apiKey: 'k', system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [], signal: new AbortController().signal, emit: () => {}, client, effort: a1.effortFor('openai', { model: 'openai:gpt-5', effort: 'high' }) });
  check('a chat’s High reaches an OpenAI request as reasoning_effort', body?.reasoning_effort === 'high', JSON.stringify(body));

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
