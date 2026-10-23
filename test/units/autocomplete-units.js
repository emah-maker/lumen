// [autocomplete] Tab to finish the message being typed, plain Node (no Electron, no network): the guess's prompt and cleanup
// (ai/autocomplete.js), which model makes it, and the chat box's core (renderer/chat-autocomplete.js createCore): the pause before
// asking, a newer prefix stopping the older guess, typing through a guess, Tab / Ctrl+Right taking it, and what drops it.
const fs = require('fs');
const path = require('path');
const lib = require('../../src/ai/autocomplete');
const { createCore } = require('../../src/renderer/chat-autocomplete');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = (v) => JSON.stringify(v);
const tick = () => new Promise((r) => setImmediate(r));

// ---- what is worth a guess, and the prompt
check('wants: a few typed letters', lib.wants('make a'));
check('wants: not one or two letters', !lib.wants('ok') && !lib.wants('  a  '));
check('wants: not a slash command', !lib.wants('/btw what was'));
{
  const [m] = lib.buildMessages({ transcript: 'User: hi\n\nAssistant: hello', prefix: 'make each one take', tab: { title: 'Canvas' } });
  check('prompt: the conversation, the tab and what was typed', m.role === 'user' && m.content.includes('User: hi') && m.content.includes('<current_tab>Canvas</current_tab>') && m.content.includes('<typed_so_far>make each one take</typed_so_far>'), m.content);
  const [empty] = lib.buildMessages({ prefix: 'abc' });
  check('prompt: an empty chat says so, no tab line', empty.content.includes('(nothing yet)') && !empty.content.includes('current_tab'), empty.content);
  const [long] = lib.buildMessages({ prefix: 'x'.repeat(5000) + 'END' });
  check('prompt: a long message keeps its end', long.content.includes('END</typed_so_far>') && long.content.length < 2300, long.content.length);
  check('system: no answering, only the continuation', /ONLY the text that comes right after/.test(lib.SYSTEM) && /Never answer the message/.test(lib.SYSTEM));
}

// ---- cleaning the model's reply
const cases = [
  ['a plain continuation', ' like 1-2 hours', 'make each one take', ' like 1-2 hours'],
  ['first line only', ' like 1-2 hours\nSure! Here is more', 'make each one take', ' like 1-2 hours'],
  ['quotes go', '" like 1-2 hours"', 'make each one take', ' like 1-2 hours'],
  ['a repeat of the whole prefix goes', 'make each one take like 1-2 hours', 'make each one take', ' like 1-2 hours'],
  ['a repeat of its last words goes', 'each one take like 1-2 hours', 'please make each one take', ' like 1-2 hours'],
  ['no double space after a typed space', ' like 1-2 hours', 'make each one take ', 'like 1-2 hours'],
  ['mid-word stays glued', 'ework', 'download all the hom', 'ework'],
  ['nothing is nothing', '   \n ', 'abc', ''],
  ['a code fence goes', '```\n more words\n```', 'abc def', ' more words'],
];
for (const [label, raw, prefix, want] of cases) check(`clean: ${label}`, lib.clean(raw, prefix) === want, J(lib.clean(raw, prefix)));
{
  const long = lib.clean(` ${'word '.repeat(80)}`, 'abc');
  check('clean: a long guess is cut at a word', long.length <= lib.MAX_CHARS && /word$/.test(long), long.length);
}

(async () => {
  // ---- which model guesses, and the call
  {
    const seen = [];
    const call = async (model, o) => { seen.push({ model, max: o.maxTokens, sys: o.system === lib.SYSTEM }); return { content: [{ type: 'text', text: ' like 1-2 hours' }], usage: { input_tokens: 10, output_tokens: 5 } }; };
    const used = [];
    const r = await lib.run({ chatModel: 'claude-opus-5', options: [], transcript: '', prefix: 'make each one take', call, onUsage: (m, model) => used.push(model) });
    check('run: an Anthropic chat guesses on Haiku', r.ok && seen[0].model === 'claude-haiku-5-5' && seen[0].max === lib.MAX_TOKENS && seen[0].sys, J(seen));
    check('run: the guess comes back cleaned', r.text === ' like 1-2 hours', J(r));
    check('run: the usage is reported', J(used) === J(['claude-haiku-5-5']), J(used));
    const none = await lib.run({ chatModel: 'claudecode:sonnet', options: [], prefix: 'make each one', call });
    check('run: an engine chat with no API model makes no call', !none.ok && none.error === 'no-provider' && seen.length === 1, J(none));
    const api = await lib.run({ chatModel: 'claudecode:sonnet', options: [{ id: 'claude-sonnet-5-5' }], prefix: 'make each one', call });
    check('run: an engine chat uses a connected API model, cheaply', api.ok && seen[1].model === 'claude-haiku-5-5', J(seen[1]));
    const short = await lib.run({ chatModel: 'claude-opus-5', prefix: 'ok', call });
    check('run: too short makes no call', short.error === 'short' && seen.length === 2);
    const refused = [];
    const r2 = await lib.run({ chatModel: 'claude-opus-5', prefix: 'make each', call: async (model) => { refused.push(model); if (/haiku/.test(model)) throw Object.assign(new Error('model not found'), { status: 404 }); return { content: [{ type: 'text', text: ' one' }] }; } });
    check('run: a refused cheap model falls back to the chat\'s own, once', r2.ok && J(refused) === J(['claude-haiku-5-5', 'claude-opus-5']), J(refused));
    const slow = await lib.run({ chatModel: 'claude-opus-5', prefix: 'make each', timeMs: 30, call: (m, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    check('run: a slow guess times out quietly', !slow.ok && slow.error === 'timeout', J(slow));
    const ctrl = new AbortController();
    const p = lib.run({ chatModel: 'claude-opus-5', prefix: 'make each', signal: ctrl.signal, call: (m, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    ctrl.abort();
    const stopped = await p;
    check('run: a newer keystroke stops it', !stopped.ok && stopped.error === 'stopped', J(stopped));
  }

  // ---- privacy: what is typed only goes to the provider the chat itself uses (#744, #746 follow-up)
  {
    const seen = [];
    const call = async (model) => { seen.push(model); return { content: [{ type: 'text', text: ' more' }] }; };
    const KEYS = [{ id: 'openai:gpt-5.6' }, { id: 'xai:grok-4' }];
    for (const engine of ['claudecode:default', 'codex:default', 'grokbuild:default', 'antigravity:default']) {
      const r = await lib.run({ chatModel: engine, options: [], prefix: 'make each one', call });
      check(`privacy: a ${engine} chat with no key of its own vendor makes no request`, !r.ok && r.error === 'no-provider' && seen.length === 0, J(r));
    }
    // (other vendors' keys are connected, but the chat is Claude Code's: nothing goes to OpenAI or xAI)
    const other = await lib.run({ chatModel: 'claudecode:default', options: KEYS, prefix: 'make each one', call });
    check('privacy: a Claude Code chat never sends to another company\'s API, even when its key is connected', !other.ok && seen.length === 0, J({ other, seen }));
    const codexOther = await lib.run({ chatModel: 'codex:default', options: [{ id: 'claude-sonnet-5-5' }, { id: 'xai:grok-4' }], prefix: 'make each one', call });
    check('privacy: a Codex chat with no OpenAI key makes no request', !codexOther.ok && seen.length === 0, J(codexOther));
    const same = await lib.run({ chatModel: 'codex:default', options: [{ id: 'claude-sonnet-5-5' }, { id: 'openai:gpt-5.6' }], prefix: 'make each one', call });
    check('privacy: a Codex chat with an OpenAI key uses OpenAI (same vendor), on the mini', same.ok && J(seen) === J(['openai:gpt-5.6-mini']), J(seen));
    seen.length = 0;
    const anth = await lib.run({ chatModel: 'claudecode:sonnet', options: [{ id: 'claude-opus-5-5' }, { id: 'openai:gpt-5.6' }], prefix: 'make each one', call });
    check('privacy: a Claude Code chat with an Anthropic key uses Anthropic only', anth.ok && J(seen) === J(['claude-haiku-5-5']), J(seen));
    seen.length = 0;
    const own = await lib.run({ chatModel: 'xai:grok-4', options: KEYS, prefix: 'make each one', call });
    check('privacy: an API chat stays on its own provider', own.ok && J(seen) === J(['xai:grok-4']), J(seen));
    seen.length = 0;
    // (the engine row and the "More models" row are not API keys)
    const rows = await lib.run({ chatModel: 'claudecode:default', options: [{ id: 'openrouter:__more' }, { id: 'claudecode:default' }], prefix: 'make each one', call });
    check('privacy: engine and "more models" rows are not an API to send to', !rows.ok && seen.length === 0, J(rows));
  }

  // ---- 'auto' is never sent as a model
  {
    const seen = [];
    const call = async (model) => { seen.push(model); return { content: [{ type: 'text', text: ' more' }] }; };
    for (const chatModel of ['auto', 'openai:auto', 'claudecode:auto', '']) {
      const r = await lib.run({ chatModel, options: [{ id: 'claude-opus-5-5' }], prefix: 'make each one', call });
      check(`auto: an unresolved ${J(chatModel)} makes no request`, !r.ok && r.error === 'no-provider' && seen.length === 0, J(r));
    }
    check('auto: plan never returns auto', lib.plan({ chatModel: 'auto' }) === null && lib.plan({ chatModel: 'openai:auto' }) === null);
    const btw = require('../../src/ai/btw');
    const bp = btw.plan({ chatModel: 'auto', defaultModel: 'auto', options: [{ id: 'openai:gpt-5.6' }] });
    check('auto: /btw does not send auto either (it takes a connected API model, or none)', bp?.model === 'openai:gpt-5.6-mini' && btw.plan({ chatModel: 'auto', defaultModel: 'auto', options: [] }) === null, J(bp));
  }

  // ---- agent.autocomplete: 'auto' resolved by Auto's own router, the setting, and the real request
  {
    const providers = require('../../src/ai/providers');
    const { Agent } = require('../../src/ai/agent');
    const OPTIONS = [{ id: 'claude-opus-5-5', label: 'Opus' }, { id: 'openai:gpt-5.6', label: 'GPT' }, { id: 'claudecode:default', label: 'Claude Code' }];
    const sent = [];
    const client = { messages: { create: async (params) => { sent.push(params.model); return { content: [{ type: 'text', text: ' like 1-2 hours' }], usage: { input_tokens: 5, output_tokens: 3 } }; } } };
    const routes = [];
    const make = ({ model = 'auto', route, on = true, options = OPTIONS, getKey = () => 'sk-test' } = {}) => {
      const browser = { fallbackOptions: () => options, effectiveModel: (x) => x, ...(route ? { autoRoute: (a) => { routes.push(a); return route(a); } } : {}), ...(on === 'unset' ? {} : { chatAutocomplete: () => on }) };
      const agent = new Agent(browser, () => client, () => ({ model }), getKey);
      const chat = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
      chat.settings = { model: 'auto' };
      return { agent, chat };
    };
    const ask = ({ agent, chat }) => agent.autocomplete({ messages: chat, prefix: 'make each one take' });
    let m = make({ route: () => ({ id: 'claude-sonnet-5-5' }) });
    let r = await ask(m);
    check('agent: a chat on auto asks Auto\'s router for a quick job, with the chat\'s scope', r.ok && routes.length === 1 && routes[0].request.kind === 'quick' && routes[0].scope === null, J(routes));
    check('agent: ...and sends the real model (the cheap sibling), never auto', J(sent) === J(['claude-haiku-5-5']) && r.model === 'claude-haiku-5-5', J({ sent, r }));
    sent.length = 0; routes.length = 0;
    m = make({ route: () => ({ id: null, reason: 'Auto: no model is available right now' }) });
    r = await ask(m);
    check('agent: auto with nothing to resolve to makes no request', !r.ok && r.error === 'no-provider' && sent.length === 0, J({ r, sent }));
    m = make({ route: () => ({ id: 'claudecode:sonnet' }), options: [OPTIONS[1], OPTIONS[2]] });
    r = await ask(m);
    check('agent: auto that lands on a CLI engine makes no request without that vendor\'s key', !r.ok && sent.length === 0, J({ r, sent }));
    m = make({ model: 'openai:auto', route: (a) => ({ id: a.scope === 'openai' ? 'openai:gpt-5.6' : null }) });
    m.chat.settings = { model: 'openai:auto' };
    const realStream = providers.streamTurn;
    const viaProviders = [];
    providers.streamTurn = async (a) => { viaProviders.push(a.model); return { content: [{ type: 'text', text: ' more' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }; };
    try { r = await ask(m); } finally { providers.streamTurn = realStream; }
    check('agent: a provider\'s own Auto resolves inside that provider', r.ok && J(viaProviders) === J(['gpt-5.6-mini']) && sent.length === 0, J({ r, viaProviders }));
    m = make({ route: () => { throw new Error('boom'); } });
    r = await ask(m);
    check('agent: a router that throws makes no request', !r.ok && sent.length === 0, J({ r, sent }));
    // no pick in the chat: the user's default (on auto here) is resolved the same way
    m = make({ model: 'auto', route: () => ({ id: 'claude-opus-5-5' }) });
    m.chat.settings = {};
    r = await ask(m);
    check('agent: no model saved in the chat falls back to the default, resolved too', r.ok && sent.at(-1) === 'claude-haiku-5-5', J(sent));
    sent.length = 0;
    // a concrete chat model never asks the router
    routes.length = 0;
    m = make({ model: 'claude-opus-5-5', route: () => ({ id: 'openai:gpt-5.6' }) });
    m.chat.settings = { model: 'claude-opus-5-5' };
    r = await ask(m);
    check('agent: a chat on a concrete model does not use the router', r.ok && routes.length === 0 && J(sent) === J(['claude-haiku-5-5']), J({ routes, sent }));
    sent.length = 0;
    m = make({ model: 'claude-opus-5-5', on: false });
    m.chat.settings = { model: 'claude-opus-5-5' };
    r = await ask(m);
    check('agent: with the setting off there is no request', !r.ok && r.error === 'off' && sent.length === 0, J({ r, sent }));
    m = make({ model: 'claude-opus-5-5', on: 'unset' });
    m.chat.settings = { model: 'claude-opus-5-5' };
    check('agent: on by default for an API chat', (await ask(m)).ok && sent.length === 1, J(sent));
    // the setting itself: main.js turns off only on an explicit false
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
    check('setting: main.js passes chatAutocomplete through (off only when false) and the IPC checks it too', /chatAutocomplete: \(\) => readSettings\(\)\.chatAutocomplete !== false/.test(main) && /readSettings\(\)\.chatAutocomplete === false\) return \{ ok: false, error: 'off'/.test(main));
  }

  // ---- the chat box's core, with fake timers
  const harness = (answer = (prefix) => ({ ok: true, text: ` after ${prefix.length}` })) => {
    const timers = new Map();
    let id = 0;
    const h = { asked: [], cancels: 0, shown: [], pending: [] };
    h.core = createCore({
      request: (prefix) => { h.asked.push(prefix); return new Promise((resolve) => h.pending.push(() => resolve(answer(prefix)))); },
      cancel: () => { h.cancels++; },
      render: (g) => h.shown.push(g),
      delayMs: 450,
      timers: { set: (fn) => { timers.set(++id, fn); return id; }, clear: (t) => timers.delete(t) },
      wants: (v) => v.replace(/\s/g, '').length >= 3,
    });
    h.fire = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); };
    h.timers = timers;
    h.answerAll = async () => { const p = h.pending.splice(0); p.forEach((f) => f()); await tick(); };
    return h;
  };
  {
    const h = harness();
    h.core.input('ma');
    check('core: too short starts no timer', h.timers.size === 0);
    h.core.input('mak'); h.core.input('make'); h.core.input('make each');
    check('core: typing only restarts the pause (one timer)', h.timers.size === 1 && h.asked.length === 0);
    h.fire();
    check('core: after the pause it asks with the latest text', J(h.asked) === J(['make each']));
    await h.answerAll();
    check('core: the guess shows', h.core.ghost === ' after 9' && h.core.base === 'make each', J({ g: h.core.ghost, b: h.core.base }));
    h.core.input('make each a');
    check('core: typing the guess\'s own letters keeps the rest', h.core.ghost === 'fter 9' && h.timers.size === 0, J(h.core.ghost));
    h.core.input('make each ax');
    check('core: a different letter drops it and waits again', h.core.ghost === '' && h.timers.size === 1, J(h.core.ghost));
    h.fire();
    await h.answerAll();
    const text = h.core.accept();
    check('core: Tab takes the whole guess', text === ' after 12' && h.core.ghost === '', J(text));
    check('core: with no guess Tab is left alone', h.core.accept() === null);
  }
  {
    const h = harness();
    h.core.input('first try'); h.fire();
    h.core.input('second try'); h.fire();
    check('core: a newer prefix cancels the guess in flight', h.cancels >= 1 && J(h.asked) === J(['first try', 'second try']), J({ c: h.cancels, a: h.asked }));
    await h.answerAll();
    check('core: only the newest guess shows', h.core.ghost === ' after 10' && h.core.base === 'second try', J(h.core.ghost));
    h.core.input('first try');
    check('core: going back to an earlier prefix whose guess was dropped asks again', h.timers.size === 1, h.timers.size);
  }
  {
    const h = harness(() => ({ ok: true, text: ' like 1-2 hours each' }));
    h.core.input('make each one take'); h.fire(); await h.answerAll();
    const w1 = h.core.acceptWord();
    check('core: Ctrl+Right takes one word', w1 === ' like' && h.core.ghost === ' 1-2 hours each', J({ w1, g: h.core.ghost }));
    h.core.acceptWord(); h.core.acceptWord();
    const last = h.core.acceptWord();
    check('core: ...word by word to the end', last === ' each' && h.core.ghost === '' && h.core.accept() === null, J({ last, g: h.core.ghost }));
    h.core.input('make each one take');
    check('core: a prefix it already guessed shows at once from the cache', h.core.ghost === ' like 1-2 hours each' && h.timers.size === 0, J(h.core.ghost));
    h.core.dismiss();
    check('core: Esc / a click / send drops it', h.core.ghost === '');
  }
  {
    const h = harness();
    h.core.input('make each', { atEnd: false });
    check('core: no guess with the caret mid-text', h.timers.size === 0);
    h.core.input('make each', { blocked: true });
    check('core: no guess while a menu owns the keys', h.timers.size === 0);
    const off = harness(() => ({ ok: false, error: 'off', text: '' }));
    off.core.input('make each'); off.fire(); await off.answerAll();
    check('core: switched off: nothing shows', off.core.ghost === '' && off.shown.every((g) => g === ''), J(off.shown));
    const failing = harness();
    failing.core.input('make each'); failing.fire();
    failing.pending.splice(0); // (the request never settles: nothing breaks, nothing shows)
    check('core: a guess that never comes shows nothing', failing.core.ghost === '');
  }

  // ---- the default timers, as the browser calls them: setTimeout/clearTimeout called on another object throw "Illegal invocation" there
  {
    const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
    const strict = (fn) => function (...a) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return fn(...a); };
    globalThis.setTimeout = strict(real.set);
    globalThis.clearTimeout = strict(real.clear);
    let err = null;
    try {
      const core = createCore({ request: async () => ({ ok: true, text: ' more' }), delayMs: 1 });
      core.input('hello there');
      core.input('hello there!');
      core.dismiss();
    } catch (e) { err = e; } finally { globalThis.setTimeout = real.set; globalThis.clearTimeout = real.clear; }
    check('core: the default timers work when called the way the browser checks them (no "Illegal invocation")', !err, String(err));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
