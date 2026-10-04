// Image generation routing (ai/image-router.js, ai/image-grok.js, the generate_image tool, Settings > AI > Image generation),
// plain Node: no Electron, no network, no key, no CLI. Fake providers stand in for every backend.
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = require('../src/ai/image-router');
const providers = require('../src/ai/providers');
const fallback = require('../src/ai/fallback');
const imageGrok = require('../src/ai/image-grok');
const gen = require('../src/features/gen-images');
const settingsBackend = require('../src/settings/settings-backend');
const { Agent, EXTERNAL_TOOLS, validateInput, transcriptFor } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const png = PNG.toString('base64');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-imgroute-'));
const ALL = { grokbuild: true, xai: true, gemini: true, openai: true, openrouter: true };
const picture = (model) => async () => ({ images: [{ data: png, alt: 'x' }], model, said: '' });
const limitErr = () => Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details'), { status: 429 });
const netErr = () => Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
const keyErr = () => Object.assign(new Error('401 Incorrect API key provided'), { status: 401 });
const policyErr = (m = 'Your request was rejected by the safety system.') => Object.assign(new Error(m), { status: 400, code: 'moderation_blocked' });
const isPolicy = (e) => providers.isPolicyError(e);
const classify = (e) => fallback.classify(e);

(async () => {
  // ---- the order
  {
    const order = (o) => router.plan({ connected: ALL, ...o }).order;
    check('Automatic: the chat\'s own provider first, then Grok Build, the API keys in a fixed order', J(order({ current: 'openai:gpt-5.6' })) === J(['openai', 'grokbuild', 'xai', 'gemini', 'openrouter']), J(order({ current: 'openai:gpt-5.6' })));
    check('Automatic on Claude, Claude Code, Antigravity or Codex: nothing is "own", Grok Build leads', ['claude-opus-5', 'claudecode:default', 'antigravity:default', 'codex:default'].every((m) => order({ current: m })[0] === 'grokbuild'));
    check('a Grok Build chat uses Grok Build\'s own image tool first', order({ current: 'grokbuild:default' })[0] === 'grokbuild');
    check('only connected providers are ever in the order', J(order({ connected: { gemini: true }, current: 'claude-opus-5' })) === J(['gemini']) && order({ connected: {} }).length === 0);
    check('providers out of usage go last, in the same order', J(order({ current: 'openai:gpt-5.6', cooling: (k) => k === 'openai' || k === 'grokbuild' })) === J(['xai', 'gemini', 'openrouter', 'openai', 'grokbuild']), J(order({ current: 'openai:gpt-5.6', cooling: (k) => k === 'openai' || k === 'grokbuild' })));
    check('providers turned off for Auto are left out (but not the chat\'s own)', J(order({ current: 'claude-opus-5', exclude: ['grokbuild', 'openai'] })) === J(['xai', 'gemini', 'openrouter']) && order({ current: 'openai:gpt-5.6', exclude: ['openai'] })[0] === 'openai');
    check('one chosen provider is the only one asked, whatever the chat is on, and ignores the Auto exclusions', J(order({ setting: 'gemini', current: 'openai:gpt-5.6', exclude: ['gemini'] })) === J(['gemini']));
    check('a chosen provider that is not connected asks nobody (it names which one is missing)', router.plan({ setting: 'openai', connected: { gemini: true } }).order.length === 0 && router.plan({ setting: 'openai', connected: { gemini: true } }).missing === 'openai');
    check('off asks nobody', router.plan({ setting: 'off', connected: ALL }).order.length === 0);
    check('editing only goes to providers that edit (Grok\'s API does not)', J(order({ edit: true, current: 'xai:grok-4' })) === J(['grokbuild', 'gemini', 'openai', 'openrouter']), J(order({ edit: true, current: 'xai:grok-4' })));
    check('unknown settings mean Automatic', router.cleanSetting('banana') === 'auto' && router.cleanSetting(undefined) === 'auto' && router.cleanSetting('off') === 'off' && router.cleanSetting('xai') === 'xai');
  }

  // ---- routing, fallback, refusals
  {
    const calls = [];
    const backend = (key, impl) => async (a) => { calls.push(key); return impl(a); };
    const run = (backends, o = {}) => router.route({ prompt: 'a cat', connected: ALL, current: 'claude-opus-5', backends, isPolicy, classify, ...o });
    const ok = (key) => backend(key, picture(`${key}-model`));
    const bad = (key, err) => backend(key, async () => { throw err(); });

    calls.length = 0;
    let r = await run({ grokbuild: ok('grokbuild'), xai: ok('xai'), gemini: ok('gemini'), openai: ok('openai'), openrouter: ok('openrouter') });
    check('the first provider in order makes the picture and is named (provider, label, model, credit)', r.provider === 'grokbuild' && r.label === 'Grok Build' && r.credit === 'Grok Build · grokbuild-model' && r.images.length === 1 && J(calls) === J(['grokbuild']), J({ ...r, images: 1 }));

    calls.length = 0;
    r = await run({ grokbuild: bad('grokbuild', limitErr), xai: bad('xai', netErr), gemini: bad('gemini', keyErr), openai: ok('openai'), openrouter: ok('openrouter') });
    check('usage limit, network failure and a rejected key each hand the request to the next provider', r.provider === 'openai' && J(calls) === J(['grokbuild', 'xai', 'gemini', 'openai']) && r.tried.length === 3, J({ calls, tried: r.tried }));
    check('the failures are recorded with a reason', r.tried.map((t) => t.why).join() === 'out of usage,unreachable,not signed in or key rejected', J(r.tried));

    calls.length = 0;
    r = await run({ grokbuild: backend('grokbuild', async () => ({ images: [] })), xai: ok('xai') });
    check('a provider that returns no picture hands on to the next', r.provider === 'xai' && J(calls) === J(['grokbuild', 'xai']));

    calls.length = 0;
    r = await run({ grokbuild: bad('grokbuild', () => new Error('Something odd happened')), xai: ok('xai') });
    check('an unclassified technical error also hands on', r.provider === 'xai');

    // a content-policy refusal: the answer, never retried elsewhere
    for (const [label, err] of [['OpenAI moderation_blocked', policyErr()], ['a flagged error flag', Object.assign(new Error('Blocked'), { policy: true })], ['text naming a content policy violation', Object.assign(new Error('400 Your request was rejected as a result of our safety system: content_policy_violation'), { status: 400 })]]) {
      calls.length = 0;
      let thrown = null;
      try { await run({ grokbuild: bad('grokbuild', () => err), xai: ok('xai'), openai: ok('openai') }); } catch (e) { thrown = e; }
      check(`${label}: stops at once, nothing else is asked`, thrown?.code === 'refused' && J(calls) === J(['grokbuild']), J({ code: thrown?.code, calls }));
      check(`${label}: the provider's own refusal is shown, with who said it`, /Grok Build declined this picture/.test(thrown?.userMessage || '') && thrown.provider === 'grokbuild', thrown?.userMessage);
    }
    calls.length = 0;
    let refusal = null;
    try { await run({ grokbuild: bad('grokbuild', limitErr), xai: bad('xai', () => policyErr('Image violates policy')), gemini: ok('gemini') }); } catch (e) { refusal = e; }
    check('a refusal after an earlier outage still ends the run (Grok said no: not Gemini)', refusal?.code === 'refused' && refusal.provider === 'xai' && !calls.includes('gemini'), J(calls));

    // everything fails
    let failed = null;
    try { await run({ grokbuild: bad('grokbuild', limitErr), xai: bad('xai', netErr), gemini: bad('gemini', keyErr), openai: bad('openai', limitErr), openrouter: bad('openrouter', netErr) }); } catch (e) { failed = e; }
    check('every provider failed: one message naming each and why', failed?.code === 'failed' && /Grok Build \(out of usage\)/.test(failed.message) && /OpenRouter \(unreachable\)/.test(failed.message) && /Gemini/.test(failed.userMessage), failed?.message);

    // never an unconnected provider, never when off
    calls.length = 0;
    r = await run({ grokbuild: ok('grokbuild'), xai: ok('xai'), gemini: ok('gemini'), openai: ok('openai'), openrouter: ok('openrouter') }, { connected: { gemini: true } });
    check('a provider that is not connected is never asked, even when it would be first', r.provider === 'gemini' && J(calls) === J(['gemini']));
    let none = null;
    try { await run({ openai: ok('openai') }, { connected: {} }); } catch (e) { none = e; }
    check('nothing connected: says so, and never asks for a key in the chat', none?.code === 'none' && /Settings > AI/.test(none.message) && /not ask for a key/.test(none.message), none?.message);
    let off = null;
    calls.length = 0;
    try { await run({ openai: ok('openai') }, { setting: 'off' }); } catch (e) { off = e; }
    check('off: refuses with a line the model can pass on, asks nobody', off?.code === 'off' && /turned off/.test(off.message) && calls.length === 0);
    let missing = null;
    try { await run({ openai: ok('openai') }, { setting: 'openai', connected: { gemini: true } }); } catch (e) { missing = e; }
    check('a chosen provider that is not connected: named, no silent switch to another', missing?.code === 'none' && /OpenAI is chosen/.test(missing.message), missing?.message);

    // a stopped request
    const ctl = new AbortController();
    let aborted = null;
    try { await run({ grokbuild: async () => { ctl.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, xai: ok('xai') }, { signal: ctl.signal }); } catch (e) { aborted = e; }
    check('Stop ends the request (no fallback)', aborted?.code === 'aborted');

    // editing hands the source along
    let seen = null;
    r = await run({ grokbuild: async (a) => { seen = a.source; return picture('image_edit')(); } }, { source: { buffer: PNG, mime: 'image/png' } });
    check('an edit request carries the source picture to the backend', seen?.buffer?.equals(PNG) && r.provider === 'grokbuild');
    let tried = [];
    await run({ grokbuild: ok('grokbuild'), openai: ok('openai') }, { onTry: (k) => tried.push(k) });
    check('onTry is told who is being asked', J(tried) === J(['grokbuild']));
  }

  // ---- providers: policy flags, editing, OpenRouter
  {
    check('isPolicyError: moderation code, flag, and policy text on a 400', providers.isPolicyError(policyErr()) && providers.isPolicyError({ policy: true }) && providers.isPolicyError(Object.assign(new Error('violates our content policy'), { status: 400 })));
    check('isPolicyError: usage, network and key errors are not refusals', !providers.isPolicyError(limitErr()) && !providers.isPolicyError(netErr()) && !providers.isPolicyError(keyErr()) && !providers.isPolicyError(Object.assign(new Error('violates content policy'), { status: 500 })));
    let err = null;
    try { await providers.generateImage({ provider: 'gemini', apiKey: 'k', prompt: 'x', model: 'm', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }) }) }); } catch (e) { err = e; }
    check('Gemini blocking a picture on safety is a refusal; an empty answer is not', err?.policy === true || /IMAGE_SAFETY|no picture/.test(err?.message || ''), err?.message);
    let empty = null;
    try { await providers.generateImage({ provider: 'gemini', apiKey: 'k', prompt: 'x', model: 'm', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }) }) }); } catch (e) { empty = e; }
    check('Gemini with no picture and no block: technical, not a refusal', empty && !empty.policy);
    let bodySent = null;
    const out = await providers.generateImage({ provider: 'gemini', apiKey: 'k', prompt: 'make it blue', model: 'gemini-2.5-flash-image', source: { buffer: PNG, mime: 'image/png' }, fetchImpl: async (_u, init) => { bodySent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }) }; } });
    check('Gemini edit: the source picture rides in the request as inline data', bodySent?.contents?.[0]?.parts?.[1]?.inlineData?.data === png && out.images.length === 1);
    let edited = null;
    const oa = await providers.generateImage({ provider: 'openai', apiKey: 'k', prompt: 'make it blue', model: 'gpt-image-1', source: { buffer: PNG, mime: 'image/png' }, client: { images: { edit: async (body) => { edited = body; return { data: [{ b64_json: png }] }; }, generate: async () => { throw new Error('should edit'); } } } });
    check('OpenAI edit: images.edit is used with the picture as a file', edited?.model === 'gpt-image-1' && edited.image && oa.images.length === 1, J(Object.keys(edited || {})));
    let xaiErr = null;
    try { await providers.generateImage({ provider: 'xai', apiKey: 'k', prompt: 'x', model: 'grok-2-image', source: { buffer: PNG, mime: 'image/png' }, client: {} }); } catch (e) { xaiErr = e; }
    check('Grok\'s API does not edit here: said plainly (the router never sends it an edit)', /can't edit/.test(xaiErr?.message || '') && !providers.canEditImages('xai'));
    let sent = null;
    const orOut = await providers.generateImage({ provider: 'openrouter', apiKey: 'k', prompt: 'a cat', model: 'google/gemini-2.5-flash-image', client: { chat: { completions: { create: async (b) => { sent = b; return { choices: [{ message: { content: 'ok', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] } }] }; } } } } });
    check('OpenRouter: a picture model is asked with modalities and its message.images come back', J(sent.modalities) === '["image","text"]' && orOut.images.length === 1);
    let orErr = null;
    try { await providers.generateImage({ provider: 'openrouter', apiKey: 'k', prompt: 'a cat', model: 'x/y', client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'I cannot do that' }, finish_reason: 'content_filter' }] }) } } } }); } catch (e) { orErr = e; }
    check('OpenRouter: a content_filter finish is a refusal', orErr?.policy === true);
  }

  // ---- Grok Build's own image tool (ai/image-grok.js), with a fake `grok`
  {
    const home = path.join(tmp, 'grok-home');
    const spawnFake = (behave) => (_bin, argv, opts) => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => { behave({ argv, cwd: opts.cwd, child }); child.emit('close', 0); });
      return child;
    };
    const write = () => { const dir = path.join(home, 'sessions', 'some%2Ffolder', 'abc', 'images'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '1.png'), PNG); };
    let argvSeen = null;
    const made = await imageGrok.generate({ bin: 'grok', prompt: 'a red fox', home, tmpRoot: tmp, spawn: spawnFake(({ argv }) => { argvSeen = argv; write(); }) });
    check('Grok Build: one headless run with only image_gen allowed, sandboxed to a temp folder; the picture is read back', made.images[0].data === png && made.model === 'image_gen' && argvSeen.includes('--allow') && argvSeen[argvSeen.indexOf('--allow') + 1] === 'image_gen' && argvSeen.includes('--sandbox') && /Use image_gen: a red fox/.test(argvSeen.at(-1)), J(argvSeen));
    check('Grok Build: no shell, no --always-approve, no bypass flags', !argvSeen.some((a) => /always-approve|dangerously|bypass/i.test(a)));
    check('Grok Build: the temp folder is removed', !fs.readdirSync(tmp).some((n) => n.startsWith('lumen-grok-image-')));
    fs.rmSync(home, { recursive: true, force: true });
    let textOnly = null;
    try { await imageGrok.generate({ bin: 'grok', prompt: 'x', home, tmpRoot: tmp, spawn: spawnFake(({ child }) => child.stdout.emit('data', "I can't create that image because it violates my guidelines.")) }); } catch (e) { textOnly = e; }
    check('Grok Build: it answered in words that refuse: a refusal (policy), shown as it said it', textOnly?.policy === true && /guidelines/.test(textOnly.message), textOnly?.message);
    let broke = null;
    try { await imageGrok.generate({ bin: 'grok', prompt: 'x', home, tmpRoot: tmp, spawn: spawnFake(({ child }) => child.stderr.emit('data', 'network error')) }); } catch (e) { broke = e; }
    check('Grok Build: no picture and no refusal wording: a technical failure', broke && !broke.policy && /network error/.test(broke.message));
    let noBin = null;
    try { await imageGrok.generate({ bin: null, prompt: 'x' }); } catch (e) { noBin = e; }
    check('Grok Build: not installed is an error, not a hang', /not installed/.test(noBin?.message || ''));
    const old = path.join(home, 'sessions', 'f', 's', 'images'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, '0.png'), PNG); fs.utimesSync(path.join(old, '0.png'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    check('Grok Build: a picture that was already there is never taken for this run\'s', imageGrok.findNewImage(home, Date.now() - 1000) === null && imageGrok.findNewImage(home, 0) !== null);
  }

  // ---- settings
  {
    check('the setting defaults to Automatic and takes only Automatic, Off or a provider', settingsBackend.DEFAULTS.imageGen === 'auto' && ['auto', 'off', 'grokbuild', 'xai', 'gemini', 'openai', 'openrouter'].every((v) => settingsBackend.validate('imageGen', v) === v) && settingsBackend.validate('imageGen', 'codex') === null && settingsBackend.validate('imageGen', 'antigravity') === null && settingsBackend.validate('imageGen', '') === null);
    const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/locales/en.json'), 'utf8'));
    check('Settings > AI shows the choice, with every option named in the locale', /select\('imageGen'/.test(ui) && router.SETTINGS.every((v) => en[`settings.ai.imageGen.${v}`]) && en['settings.ai.imageGen'] && en['settings.ai.imageGenDesc'] && en['genimg.madeWith'] === 'Made with {name}');
  }

  // ---- the tool, every engine
  {
    const tool = EXTERNAL_TOOLS.find((t) => t.name === 'generate_image');
    check('generate_image is in the tool list every engine gets (API list and MCP), with a short description', tool && tool.description.length <= 60 && JSON.stringify(tool).length < 260 && J(tool.input_schema.required) === '["prompt"]', J(tool));
    check('its input is validated like any tool\'s', !validateInput('generate_image', { prompt: 'a cat' }) && !validateInput('generate_image', { prompt: 'a cat', edit: true }) && Boolean(validateInput('generate_image', { prompt: 'a cat', edit: 'yes' })));
    let bad = null;
    try { bad = validateInput('generate_image', {}); } catch (e) { bad = e.message; }
    check('a call without a prompt is refused by validation', Boolean(bad));
  }

  // ---- in the chat: the tool, the picture and its "Made with" line, a refused request, the tainted gate
  {
    const store = gen.createImageStore({ dir: path.join(tmp, 'store') });
    const CHAT = 'abcdef0123456789';
    const events = [];
    const emit = (e) => events.push(e);
    const calls = [];
    const make = (settings = {}, keys = ['openai']) => {
      const agent = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '', ...settings }, () => null, () => ({}), (p) => (keys.includes(p) ? `key-${p}` : null));
      agent.imageStore = store;
      agent.engines = {};
      return agent;
    };
    const chatOf = (model) => { const m = []; m.settings = { model }; return m; };
    const inChat = (agent, messages, fn, meta = {}) => agent.inTask(null, new AbortController().signal, fn, messages, null, { chatId: CHAT, ...meta });

    // Claude Code asks (an MCP call arrives as execute): the picture is queued on the run's scope and shown with its credit
    {
      const agent = make();
      agent.imageBackendOverrides = { openai: async (a) => { calls.push(['openai', a.prompt]); return { images: [{ data: png, alt: '' }], model: 'gpt-image-1', said: '' }; }, gemini: async () => { calls.push(['gemini']); return { images: [{ data: png }], model: 'gemini-2.5-flash-image' }; } };
      const messages = chatOf('claudecode:default');
      events.length = 0;
      let blocks = null;
      let text = null;
      await inChat(agent, messages, async () => {
        text = await agent.execute('generate_image', { prompt: 'a lighthouse at dawn' });
        blocks = await agent.enginePictures('Here it is.', { imageRoots: () => [] }, emit);
      });
      const pic = events.find((e) => e.type === 'image');
      check('Claude Code asks: a connected provider (OpenAI, from the key) makes it, with the model\'s words as the prompt', J(calls) === J([['openai', 'a lighthouse at dawn']]), J(calls));
      check('the tool answers in text: made with OpenAI, shown to the user, no picture sent back to the model', /made with OpenAI · gpt-image-1/i.test(text) && /shown to the user/.test(text) && !text.includes(png), text);
      check('the picture is shown in the chat with the provider and model that made it', pic && pic.credit === 'OpenAI · gpt-image-1' && blocks.length === 1 && blocks[0].credit === 'OpenAI · gpt-image-1', J(events));
      const items = transcriptFor([{ role: 'assistant', content: blocks }], { model: 'claudecode:default' });
      check('the saved chat keeps who made it (the line survives a reopen)', items.at(-1)?.generated?.[0]?.credit === 'OpenAI · gpt-image-1', J(items));
      const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/gen-images.js'), 'utf8');
      const core = fs.readFileSync(path.join(__dirname, '../src/renderer/chat-core.js'), 'utf8');
      check('the chat draws "Made with …" under the picture, live and restored', /pic\.credit/.test(renderer) && /genimg\.madeWith/.test(renderer) && /credit: event\.credit/.test(core));
    }

    // a refused request through the tool: the refusal text, the next provider is not asked
    {
      const agent = make({}, ['openai', 'gemini']);
      calls.length = 0;
      agent.imageBackendOverrides = { openai: async () => { calls.push('openai'); throw policyErr('Image violates policy'); }, gemini: async () => { calls.push('gemini'); return { images: [{ data: png }], model: 'g' }; } };
      let err = null;
      await inChat(agent, chatOf('openai:gpt-5.6'), async () => { try { await agent.execute('generate_image', { prompt: 'x' }); } catch (e) { err = e; } });
      check('a provider\'s refusal comes back as the tool error, and Gemini is not tried', /OpenAI declined this picture/.test(err?.message || '') && J(calls) === J(['openai']), J({ err: err?.message, calls }));
    }
    // an outage on the first provider: the next one answers
    {
      const agent = make({}, ['openai', 'gemini']);
      calls.length = 0;
      agent.imageBackendOverrides = { openai: async () => { calls.push('openai'); throw limitErr(); }, gemini: async () => { calls.push('gemini'); return { images: [{ data: png }], model: 'gemini-2.5-flash-image' }; } };
      let text = null;
      await inChat(agent, chatOf('openai:gpt-5.6'), async () => { text = await agent.execute('generate_image', { prompt: 'x' }); });
      check('the chat\'s own provider is out of usage: the next connected one makes it, and says so', /Gemini/.test(text) && J(calls) === J(['openai', 'gemini']), text);
    }
    // an outside agent over MCP has no chat: refused (it would spend the user's keys with nowhere to show the picture)
    {
      const agent = make();
      agent.imageBackendOverrides = { openai: async () => { throw new Error('must not run'); } };
      let err = null;
      await agent.inTask(null, new AbortController().signal, async () => { try { await agent.execute('generate_image', { prompt: 'x' }); } catch (e) { err = e; } });
      check('outside agents (no chat of Lumen\'s own) cannot spend the user\'s image providers', /own chat/.test(err?.message || ''), err?.message);
    }
    // off
    {
      const agent = make({ imageGen: () => 'off' });
      let err = null;
      await inChat(agent, chatOf('claude-sonnet-5'), async () => { try { await agent.execute('generate_image', { prompt: 'x' }); } catch (e) { err = e; } });
      check('Image generation off: the tool refuses, with a line the model can pass on', /turned off/.test(err?.message || ''));
    }
    // editing: the newest picture of the chat goes along
    {
      const agent = make();
      let source = null;
      agent.imageBackendOverrides = { openai: async (a) => { source = a.source; return { images: [{ data: png }], model: 'gpt-image-1' }; } };
      const messages = chatOf('claude-sonnet-5');
      const saved = store.save(CHAT, PNG);
      messages.push({ role: 'assistant', content: [{ type: 'generated_image', id: saved.id, mime: 'image/png', alt: '' }] });
      await inChat(agent, messages, () => agent.execute('generate_image', { prompt: 'make it blue', edit: true }));
      check('edit: true sends the chat\'s latest picture to a provider that edits', source?.buffer?.equals(PNG));
      let none = null;
      await inChat(agent, chatOf('claude-sonnet-5'), async () => { try { await agent.execute('generate_image', { prompt: 'x', edit: true }); } catch (e) { none = e; } });
      check('edit: true with no earlier picture: says so', /no earlier picture/i.test(none?.message || ''));
    }
    // "draw a cat" on Claude: no longer a dead end
    {
      const agent = make();
      calls.length = 0;
      agent.imageBackendOverrides = { openai: async (a) => { calls.push(a.prompt); return { images: [{ data: png }], model: 'gpt-image-1' }; } };
      for (const model of ['claude-sonnet-5', 'claudecode:default', 'antigravity:default', 'codex:default']) {
        const messages = chatOf(model);
        messages.push({ role: 'user', content: [{ type: 'text', text: 'draw a cat' }] });
        events.length = 0;
        const handled = await inChat(agent, messages, () => agent.imageTurn(messages, 'draw a cat', new AbortController().signal, emit));
        const pic = events.find((e) => e.type === 'image');
        check(`${model}: "draw a cat" is routed to the connected provider and is the whole reply, with "Made with"`, handled === true && pic?.credit === 'OpenAI · gpt-image-1' && messages.at(-1).content[0]?.type === 'generated_image' && !events.some((e) => e.type === 'notice'), J(events));
      }
      // refusal in the direct turn: shown as the reply, history valid, nothing else tried
      const refuser = make({}, ['openai', 'gemini']);
      calls.length = 0;
      refuser.imageBackendOverrides = { openai: async () => { calls.push('openai'); throw policyErr('Not allowed'); }, gemini: async () => { calls.push('gemini'); return { images: [{ data: png }] }; } };
      const messages = chatOf('openai:gpt-5.6');
      events.length = 0;
      const handled = await inChat(refuser, messages, () => refuser.imageTurn(messages, 'draw a cat', new AbortController().signal, emit));
      check('a refused "draw …": the provider\'s refusal is the reply and nothing else is tried', handled === true && /OpenAI declined this picture: Not allowed/.test(messages.at(-1).content[0].text) && J(calls) === J(['openai']), J({ calls, last: messages.at(-1) }));
      // all providers down: an error the chat shows
      const down = make({}, ['openai', 'gemini']);
      down.imageBackendOverrides = { openai: async () => { throw netErr(); }, gemini: async () => { throw limitErr(); } };
      let err = null;
      try { await inChat(down, chatOf('openai:gpt-5.6'), () => down.imageTurn(chatOf('openai:gpt-5.6'), 'draw a cat', new AbortController().signal, emit)); } catch (e) { err = e; }
      check('every provider down: the chat gets one error naming them', /Couldn't make the picture: OpenAI \(unreachable\); Gemini \(out of usage\)/.test(err?.message || ''), err?.message);
      // nothing connected: the old notice, no spend
      const bare = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '' }, () => null, () => ({}), () => null);
      bare.imageStore = store;
      events.length = 0;
      const unhandled = await inChat(bare, chatOf('claude-sonnet-5'), () => bare.imageTurn(chatOf('claude-sonnet-5'), 'draw a cat', new AbortController().signal, emit));
      check('no provider connected: the model says it can\'t make pictures (as before), nothing is called', unhandled === false && /can't make pictures/.test(events.find((e) => e.type === 'notice')?.text || ''), J(events));
    }
    // a tainted run (page text was read): the prompt is shown to the user before it leaves
    {
      const agent = make();
      let asked = null;
      agent.askApproval = async (host, _emit, _signal, card) => { asked = { host, card }; return false; };
      agent.imageBackendOverrides = { openai: async () => { throw new Error('must not run'); } };
      const messages = chatOf('claude-sonnet-5');
      messages.tainted = true;
      let err = null;
      await inChat(agent, messages, async () => {
        try { await agent.ensureAllowed('generate_image', emit, new AbortController().signal, { input: { prompt: 'secret from the page' }, run: messages }); } catch (e) { err = e; }
      });
      check('after page content was read, the picture request waits for the user\'s OK (it carries the prompt)', asked && /image AI/.test(asked.card?.title || '') && /secret from the page/.test(asked.card.title) && /did not allow/.test(err?.message || ''), J({ asked, err: err?.message }));
    }
  }

  console.log(failures ? `\n${failures} failed` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

