// Pictures the AI makes or returns, plain Node (no Electron, no network, no key, no CLI): every response shape that can carry
// one, the images APIs and the streamed chat form with fake clients, the saved store (encrypted, per chat, cleaned up), the
// "draw a cat" request, web pictures, pictures a CLI engine names by path, markdown images, and how a made picture enters the
// chat, its history and its export. Each backend is a row in the PR's audit table; the checks here are its evidence.
const fs = require('fs');
const os = require('os');
const path = require('path');
const gen = require('../src/features/gen-images');
const providers = require('../src/ai/providers');
const { Agent, transcriptFor, requestFor } = require('../src/ai/agent');
const { toMarkdown } = require('../src/features/chat-store');
const { render } = require('../src/renderer/markdown');
const mcp = require('../src/features/mcp-client');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const J = JSON.stringify;

// A real 1x1 PNG, JPEG, GIF and WebP (first bytes are what counts).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(20)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(20)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const b64 = (b) => b.toString('base64');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-genimg-'));

(async () => {
  // ---- what counts as a picture
  check('PNG, JPEG, GIF and WebP are recognised by their bytes', [PNG, JPG, GIF, WEBP].map((b) => gen.sniff(b)?.mime).join() === 'image/png,image/jpeg,image/gif,image/webp');
  check('SVG, HTML and text are never pictures', !gen.sniff(SVG) && !gen.sniff(Buffer.from('<html>hello world</html>')) && !gen.sniff(Buffer.alloc(3)));
  check('a data URL of a picture parses; other types, bad base64 and fakes do not', gen.parseDataUrl(`data:image/png;base64,${b64(PNG)}`)?.mime === 'image/png'
    && !gen.parseDataUrl(`data:image/svg+xml;base64,${b64(SVG)}`) && !gen.parseDataUrl('data:image/png;base64,@@@') && !gen.parseDataUrl(`data:image/png;base64,${b64(SVG)}`) && !gen.parseDataUrl('javascript:alert(1)'));

  // ---- every response shape (OpenAI, xAI, Responses, Gemini, OpenRouter, Anthropic-style, MCP)
  const png = b64(PNG);
  const shapes = [
    ['OpenAI / xAI images API (b64_json)', { data: [{ b64_json: png, revised_prompt: 'a cat' }] }, 1, 'a cat'],
    ['xAI images API (url)', { data: [{ url: 'https://imgen.x.ai/a.png' }] }, 1],
    ['OpenAI Responses image_generation_call', { output: [{ type: 'message', content: [] }, { type: 'image_generation_call', result: png, revised_prompt: 'a dog' }] }, 1, 'a dog'],
    ['Gemini inlineData (REST camelCase)', { candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: png } }] } }] }, 1],
    ['Gemini inline_data (snake_case)', { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: png } }] } }] }, 1],
    ['OpenRouter message.images (data URL)', { choices: [{ message: { content: 'ok', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] } }] }, 1],
    ['OpenRouter streamed delta.images', { choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] } }] }, 1],
    ['Anthropic-style tool_result image blocks', [{ type: 'text', text: 'x' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }], 1],
    ['MCP tool result image content', { content: [{ type: 'text', text: 'x' }, { type: 'image', data: png, mimeType: 'image/png' }] }, 1],
    ['plain text and nothing', { choices: [{ message: { content: 'just words' } }] }, 0],
  ];
  for (const [label, json, count, alt] of shapes) {
    const found = gen.extractImages(json);
    check(`shape: ${label}`, found.length === count && (!alt || found[0].alt === alt), J(found).slice(0, 160));
  }
  {
    const entry = gen.extractImages({ data: [{ b64_json: png }] })[0];
    const got = await gen.resolveImage(entry);
    check('a base64 entry resolves to bytes and a type', got?.mime === 'image/png' && got.buffer.equals(PNG));
    check('base64 that is not a picture resolves to nothing', (await gen.resolveImage({ data: b64(SVG) })) === null && (await gen.resolveImage({ data: 'not base64!' })) === null);
  }

  // ---- OpenAI / xAI: the images API, with a fake client; Gemini: generateContent, with a fake fetch
  {
    const seen = [];
    const client = { images: { generate: async (body) => { seen.push(body); return { data: [{ b64_json: png }] }; } } };
    const openai = await providers.generateImage({ provider: 'openai', apiKey: 'k', prompt: 'a cat', model: 'gpt-image-1', client });
    check('OpenAI: images.generate with gpt-image-1, no response_format (it always answers base64)', seen[0].model === 'gpt-image-1' && seen[0].prompt === 'a cat' && !('response_format' in seen[0]) && openai.images.length === 1, J(seen[0]));
    const grok = await providers.generateImage({ provider: 'xai', apiKey: 'k', prompt: 'a cat', model: 'grok-2-image', client });
    check('Grok: images.generate with b64_json asked for', seen[1].model === 'grok-2-image' && seen[1].response_format === 'b64_json' && grok.images[0].alt === 'a cat', J(seen[1]));
    const urlClient = { images: { generate: async () => ({ data: [{ url: 'https://imgen.x.ai/a.png' }] }) } };
    const byUrl = await providers.generateImage({ provider: 'xai', apiKey: 'k', prompt: 'x', model: 'grok-2-image', client: urlClient });
    check('Grok: an answer by address is returned as an address (fetched later, without cookies)', byUrl.images[0].url === 'https://imgen.x.ai/a.png');
    const empty = { images: { generate: async () => ({ data: [] }) } };
    let err = null;
    try { await providers.generateImage({ provider: 'openai', apiKey: 'k', prompt: 'x', model: 'gpt-image-1', client: empty }); } catch (e) { err = e; }
    check('OpenAI: no picture in the answer is an error with words', /made no picture/.test(err?.message || ''), err?.message);
  }
  {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'A cat.' }, { inlineData: { mimeType: 'image/png', data: png } }] } }] }) }; };
    const out = await providers.generateImage({ provider: 'gemini', apiKey: 'AIza-test', prompt: 'a cat', model: 'gemini-2.5-flash-image', fetchImpl });
    const body = JSON.parse(calls[0].init.body);
    check('Gemini: generateContent on the image model, key in a header (not the address), TEXT+IMAGE asked for', /models\/gemini-2\.5-flash-image:generateContent$/.test(calls[0].url) && calls[0].init.headers['x-goog-api-key'] === 'AIza-test' && !calls[0].url.includes('AIza') && J(body.generationConfig.responseModalities) === '["TEXT","IMAGE"]' && calls[0].init.credentials === 'omit', J(calls[0]).slice(0, 300));
    check('Gemini: the picture and the words that came with it', out.images.length === 1 && out.said === 'A cat.' && out.images[0].alt === 'A cat.');
    let err = null;
    try { await providers.generateImage({ provider: 'gemini', apiKey: 'k', prompt: 'x', model: 'm', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) }) }); } catch (e) { err = e; }
    check('Gemini: an API error keeps its message and status', err?.status === 403 && /API key not valid/.test(err.message), err?.message);
    try { await providers.generateImage({ provider: 'gemini', apiKey: 'k', prompt: 'x', model: 'm', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }) }) }); err = null; } catch (e) { err = e; }
    check('Gemini: a blocked prompt says so', /SAFETY/.test(err?.message || ''), err?.message);
  }
  check('which providers can make pictures', providers.canGenerateImages('openai', 'gpt-5.6') && providers.canGenerateImages('xai', 'grok-4') && providers.canGenerateImages('gemini', 'gemini-2.5-pro') && !providers.canGenerateImages('anthropic', 'claude-opus-5') && !providers.canGenerateImages('openrouter', 'meta/llama'));

  // ---- OpenRouter: image models answer in the chat stream; the request asks for pictures
  {
    providers.resetCatalog();
    const catalogFetch = async () => ({ ok: true, json: async () => ({ data: [
      { id: 'google/gemini-2.5-flash-image', name: 'Gemini Image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] }, supported_parameters: [] },
      { id: 'meta/llama', name: 'Llama', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
    ] }) });
    await providers.openRouterCatalog({ fetchImpl: catalogFetch });
    check('OpenRouter: the catalog marks models that make pictures', providers.openRouterInfo('google/gemini-2.5-flash-image')?.imageOut === true && !providers.openRouterInfo('meta/llama')?.imageOut && providers.canGenerateImages('openrouter', 'google/gemini-2.5-flash-image'));
    const sent = [];
    const stream = () => (async function* () {
      yield { choices: [{ delta: { content: 'Here you go. ' } }] };
      yield { choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })();
    const fake = { chat: { completions: { create: async (params) => { sent.push(params); return stream(); } } } };
    const out = await providers.streamTurn({ provider: 'openrouter', model: 'google/gemini-2.5-flash-image', apiKey: 'k', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'draw a cat' }] }], tools: [], signal: new AbortController().signal, emit: () => {}, client: fake });
    check('OpenRouter: an image model is asked for pictures (modalities) and its streamed delta.images come back', J(sent[0].modalities) === '["image","text"]' && out.pictures?.length === 1 && out.content[0].text === 'Here you go. ', J({ sent: sent[0], out }).slice(0, 300));
    const textOnly = await providers.streamTurn({ provider: 'openrouter', model: 'meta/llama', apiKey: 'k', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], signal: new AbortController().signal, emit: () => {}, client: { chat: { completions: { create: async (params) => { sent.push(params); return (async function* () { yield { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }; })(); } } } } });
    check('OpenRouter: a text model is not asked for pictures and has none', !('modalities' in sent[1]) && !textOnly.pictures, J(sent[1]));
  }

  // ---- the chat: a request for a picture, a made picture in the history, the transcript, the notices
  const store = gen.createImageStore({ dir: path.join(tmp, 'store'), encrypt: (s) => `ENC:${s}`, decrypt: (s) => s.replace(/^ENC:/, '') });
  const agent = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '' }, () => null, () => ({}), (p) => (p === 'openai' ? 'sk-test' : null));
  agent.imageStore = store;
  const CHAT = 'abcdef0123456789';
  const events = [];
  const emit = (e) => events.push(e);
  const inChat = (fn) => agent.inTask(null, new AbortController().signal, fn, [], null, { chatId: CHAT });
  const chat = (model) => { const m = []; m.settings = { model }; return m; };

  check('"draw a cat" and friends ask for a picture', ['draw a cat', 'Draw me a dragon over a castle', 'generate an image of a sunset', 'Create a logo for my cafe', 'can you make a picture of a red car?', '/image a lighthouse at dawn', 'please paint a portrait of a robot'].every((t) => gen.imageRequest(t)));
  check('questions and code talk about pictures are left to the model', ['how do I make an image upload form?', 'draw a conclusion from this', 'what is a good image format for logos', 'create an image gallery component in React', 'summarize this page', 'make the picture bigger on my site'].every((t) => !gen.imageRequest(t)), J(['how do I make an image upload form?', 'draw a conclusion from this', 'create an image gallery component in React'].map((t) => gen.imageRequest(t))));
  check('/image takes the rest as the prompt and is explicit', J(gen.imageRequest('/image a lighthouse')) === J({ prompt: 'a lighthouse', explicit: true }));

  {
    const real = providers.generateImage;
    const prompts = [];
    providers.generateImage = async (opts) => { prompts.push(opts); return { images: [{ data: png, alt: 'a cat' }], model: 'gpt-image-1', said: '' }; };
    try {
      const messages = chat('openai:gpt-5.6');
      messages.push({ role: 'user', content: [{ type: 'text', text: 'draw a cat' }] });
      events.length = 0;
      const handled = await inChat(() => agent.imageTurn(messages, 'draw a cat', new AbortController().signal, emit));
      const pic = events.find((e) => e.type === 'image');
      check('GPT: "draw a cat" calls the images API with the user\'s words and is the whole reply', handled === true && prompts[0].prompt === 'draw a cat' && prompts[0].provider === 'openai' && prompts[0].apiKey === 'sk-test', J(prompts));
      check('the picture is announced to the chat with an id, a type and its description', pic && /^abcdef0123456789~[0-9a-f]{16}$/.test(pic.id) && pic.mime === 'image/png' && pic.alt === 'a cat', J(events));
      const last = messages[messages.length - 1];
      check('the history keeps a reference, not the picture itself', last.role === 'assistant' && last.content[0].type === 'generated_image' && last.content[0].id === pic.id && !J(last).includes(png), J(last));
      const items = transcriptFor(messages, messages.settings);
      check('the transcript (what the chat shows again) lists the picture on the reply', items.at(-1).generated?.[0]?.id === pic.id && items.at(-1).text === '', J(items.at(-1)));
      const read = store.read(pic.id);
      check('the saved file holds the picture, encrypted on disk', read?.buffer.equals(PNG) && fs.readFileSync(path.join(tmp, 'store', CHAT, `${pic.id.split('~')[1]}.img`), 'utf8').includes('ENC:'), 'read');
      check('the picture comes back as a data URL', store.dataUrl(pic.id) === `data:image/png;base64,${png}`);
      // later requests carry a note in its place (no API takes the block) and never the picture
      messages.push({ role: 'user', content: [{ type: 'text', text: 'make it blue' }] });
      const req = requestFor({ model: 'claude-opus-5' }, messages).messages;
      check('Claude requests carry a note in place of the picture', J(req).includes('A picture was generated') && !J(req).includes('generated_image') && !J(req).includes(png), J(req).slice(0, 300));
      const chatMsgs = providers.toChatMessages('sys', messages);
      check('OpenAI-style requests drop the block (the note rides on the text)', !J(chatMsgs).includes('generated_image') && !J(chatMsgs).includes(png));
      const md = toMarkdown({ title: 'T' }, items, { pictureFile: () => 'pics/picture-1.png' });
      check('export links the picture and names it', md.includes('![a cat](pics/picture-1.png)') && /not included/.test(toMarkdown({ title: 'T' }, items)), md);
    } finally { providers.generateImage = real; }
  }
  {
    // Claude, a CLI engine, or an OpenRouter model without picture output: a clear notice, and the text answer still comes
    // (Settings > AI > Image generation off: nothing is routed to another provider, so the model's own notice is what shows. Routing: test/image-router-units.js)
    agent.browser.imageGen = () => 'off';
    for (const [model, who] of [['claude-sonnet-5', 'Claude'], ['claudecode:default', 'Claude Code'], ['grokbuild:default', 'Grok Build'], ['antigravity:default', 'Antigravity']]) {
      const messages = chat(model);
      events.length = 0;
      const consumed = await inChat(() => agent.imageTurn(messages, 'draw a cat', new AbortController().signal, emit));
      const notice = events.find((e) => e.type === 'notice');
      check(`${who}: "draw a cat" says it can't make pictures and still goes on to answer in text`, consumed === false && new RegExp(`${who} can't make pictures`).test(notice?.text || '') && (model.startsWith('claudecode') ? /full access to this computer/.test(notice.text) && /OpenAI/.test(notice.text) && /already set/.test(notice.text) && !/Grok|Gemini/.test(notice.text) : /GPT, Grok or Gemini/.test(notice.text)), J(events));
      events.length = 0;
      await inChat(() => agent.imageTurn(messages, 'draw another cat', new AbortController().signal, emit));
      check(`${who}: the notice is shown once per chat`, !events.some((e) => e.type === 'notice'));
    }
    const messages = chat('claude-sonnet-5');
    messages.push({ role: 'user', content: [{ type: 'text', text: '/image a cat' }] });
    events.length = 0;
    const consumed = await inChat(() => agent.imageTurn(messages, '/image a cat', new AbortController().signal, emit));
    check('/image on a model that can\'t: answered with the notice alone, history stays valid', consumed === true && messages.at(-1).role === 'assistant' && /can't make pictures/.test(messages.at(-1).content[0].text), J(messages.at(-1)));
    const orMessages = chat('openrouter:meta/llama');
    events.length = 0;
    await inChat(() => agent.imageTurn(orMessages, 'draw a cat', new AbortController().signal, emit));
    check('OpenRouter text-only model: the notice names the model', /meta\/llama can't make pictures/.test(events.find((e) => e.type === 'notice')?.text || ''), J(events));
    events.length = 0;
    const missing = chat('xai:grok-4');
    let err = null;
    try { await inChat(() => agent.imageTurn(missing, 'draw a cat', new AbortController().signal, emit)); } catch (e) { err = e; }
    check('Grok without a key: asked to add one', /Add your Grok API key/.test(err?.message || ''), err?.message);
  }

  // ---- OpenRouter pictures kept from a streamed turn; tool pictures; engine files
  {
    events.length = 0;
    const blocks = await inChat(() => agent.keepImages([{ data: png, alt: 'from a model' }, { data: b64(SVG) }, { data: 'junk' }], emit));
    check('keepImages saves the pictures and skips what is not one', blocks.length === 1 && blocks[0].type === 'generated_image' && events.filter((e) => e.type === 'image').length === 1, J(blocks));
    events.length = 0;
    const none = await inChat(() => agent.keepImages([{ data: b64(SVG) }], emit));
    check('only unusable pictures: one notice, no block', none.length === 0 && events.some((e) => e.type === 'notice' && /could not show/.test(e.text)), J(events));
  }
  {
    const text = mcp.resultText({ content: [{ type: 'text', text: 'done' }, { type: 'image', data: png, mimeType: 'image/png' }, { type: 'image', data: b64(SVG), mimeType: 'image/svg+xml' }] }, 'mcp:s/t', []);
    const images = [];
    const withCollector = mcp.resultText({ content: [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'image', data: b64(SVG), mimeType: 'image/svg+xml' }] }, 'mcp:s/t', images);
    check('an MCP tool\'s picture is collected for the chat (and told to the model as shown); a fake one is not', images.length === 1 && /shown to the user/.test(withCollector) && /not shown/.test(withCollector) && /not shown/.test(text), withCollector);
    const turn = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 's__t', input: {} }] };
    const mcpAgent = new Agent({ activeTab: () => null, listTabs: () => [], externalTools: { call: async (_name, _input, opts) => { opts.images.push({ data: png }); return 'tool text'; } } }, () => null);
    mcpAgent.imageStore = store;
    events.length = 0;
    await mcpAgent.inTask(null, new AbortController().signal, async () => {
      mcpAgent.externalGrant = 's__t';
      const text = await mcpAgent.runExternal('s__t', {});
      await mcpAgent.flushToolImages(turn, emit);
      check('MCP tool picture: the tool still answers in text, the picture is shown and kept on the turn that called it', text === 'tool text' && events.some((e) => e.type === 'image') && turn.content.at(-1).type === 'generated_image' && /MCP|from s__t/.test(events.find((e) => e.type === 'image').alt), J(events));
    }, [], null, { chatId: CHAT });
  }
  {
    const work = path.join(tmp, 'engine'); fs.mkdirSync(work, { recursive: true });
    const outside = path.join(tmp, 'elsewhere'); fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(work, 'cat.png'), PNG);
    fs.writeFileSync(path.join(work, 'fake.png'), SVG);
    fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
    let linked = false;
    try { fs.symlinkSync(path.join(outside, 'secret.png'), path.join(work, 'link.png')); linked = true; } catch { /* no symlink rights */ }
    const reply = `Saved the picture to ${path.join(work, 'cat.png')} and a decoy ${path.join(work, 'fake.png')}, also ${path.join(outside, 'secret.png')}${linked ? ` and ${path.join(work, 'link.png')}` : ''} and /etc/passwd.png`;
    const found = gen.findLocalImages(reply, [work]);
    check('CLI engines: only real pictures inside the engine\'s own folder are taken', found.length === 1 && path.basename(found[0].file) === 'cat.png', J(found.map((f) => f.file)));
    check('CLI engines: a path elsewhere, a link out of the folder and non-image bytes are all skipped', !found.some((f) => /secret|link|fake/.test(f.file)));
    const engine = { imageRoots: () => [work] };
    events.length = 0;
    const blocks = await inChat(() => agent.enginePictures(reply, engine, emit));
    check('CLI engines: the picture the reply names is saved and shown', blocks.length === 1 && events.some((e) => e.type === 'image') && store.read(blocks[0].id)?.buffer.equals(PNG), J(blocks));
    check('an engine that names no folders shows nothing', (await inChat(() => agent.enginePictures(reply, {}, emit))).length === 0);
  }

  // ---- [full access] Claude Code with its own tools: no "can't make pictures" notice, "/image" goes to it as words, and the
  // pictures it wrote during the run (and only those) are shown
  {
    const full = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '', claudeCodeFullAccess: () => true }, () => null, () => ({}), () => null);
    full.imageStore = store;
    const fullChat = () => chat('claudecode:default');
    const inFull = (fn) => full.inTask(null, new AbortController().signal, fn, [], null, { chatId: CHAT });
    events.length = 0;
    const consumed = await inFull(() => full.imageTurn(fullChat(), 'draw a small blue paper plane icon', new AbortController().signal, emit));
    check('full access: "draw …" goes to Claude Code with no "can\'t make pictures" notice', consumed === false && !events.some((e) => e.type === 'notice'), J(events));
    events.length = 0;
    const slash = await inFull(() => full.imageTurn(fullChat(), '/image a paper plane', new AbortController().signal, emit));
    check('full access: "/image …" is not answered with the notice either', slash === false && !events.some((e) => e.type === 'notice'), J(events));
    const seenByCli = [];
    full.getClient = () => null;
    const m = fullChat();
    full.messages = m;
    // runTask turns the slash command into words before the message is built (the CLI has no /image command)
    const taskText = await (async () => { let got = null; const orig = full.pageContextFor; full.pageContextFor = async () => ''; full.claudeCodeTurn = async (_ms, prompt) => { got = prompt; seenByCli.push(prompt); }; full.engines = { claudecode: {} }; try { await inFull(() => full.runTask(m, null, '/image a paper plane', [], new AbortController(), emit, {})); } finally { full.pageContextFor = orig; } return got; })();
    check('full access: "/image a paper plane" reaches Claude Code as plain words', /Generate an image: a paper plane/.test(taskText || '') && !/\/image/.test(taskText || ''), taskText);
    events.length = 0;
    const off = await inChat(() => agent.imageTurn(chat('claudecode:default'), 'draw a cat', new AbortController().signal, emit));
    check('full access off: the notice still shows, and says how to turn on drawing', off === false && /Settings > AI/.test(events.find((e) => e.type === 'notice')?.text || ''), J(events));
    const grokFull = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '', claudeCodeFullAccess: () => true, grokBuildFullAccess: () => true }, () => null, () => ({}), () => null);
    events.length = 0;
    await grokFull.inTask(null, new AbortController().signal, () => grokFull.imageTurn(chat('grokbuild:default'), 'draw a cat', new AbortController().signal, emit), [], null, { chatId: CHAT });
    check('Grok Build keeps its own behaviour (the notice), whatever Claude Code\'s setting', /Grok Build can't make pictures/.test(events.find((e) => e.type === 'notice')?.text || ''), J(events));

    delete agent.browser.imageGen;
    // pictures: written during the run under the home folder / a folder the run was pointed at -> shown; the rest -> not
    const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, 'Pictures'), { recursive: true });
    const pointed = path.join(tmp, 'pointed-out'); fs.mkdirSync(pointed, { recursive: true });
    const elsewhere = path.join(tmp, 'elsewhere2'); fs.mkdirSync(elsewhere, { recursive: true });
    const runStart = Date.now() - 2000;
    const old = path.join(home, 'Pictures', 'old.png'); fs.writeFileSync(old, PNG); fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    const fresh = path.join(home, 'Pictures', 'plane.jpg'); fs.writeFileSync(fresh, JPG);
    const inPointed = path.join(pointed, 'out.png'); fs.writeFileSync(inPointed, PNG);
    const outside = path.join(elsewhere, 'new.png'); fs.writeFileSync(outside, PNG);
    const svgish = path.join(home, 'Pictures', 'plane.png'); fs.writeFileSync(svgish, SVG);
    const svgFile = path.join(home, 'Pictures', 'plane.svg'); fs.writeFileSync(svgFile, SVG);
    const engine = { imageRoots: () => [], freshRoots: () => [home, pointed] };
    const reply = `Done: ${fresh}, ${old}, ${inPointed}, ${outside}, ${svgish}, ${svgFile}`;
    const opts = { roots: engine.freshRoots(), since: runStart, until: Date.now(), home };
    const found = gen.findLocalImages(reply, engine.imageRoots(), { fresh: opts });
    const names = found.map((f) => path.basename(f.file)).sort();
    check('full access pictures: only files written during the run, inside home or a folder the run was pointed at, and real pictures', J(names) === J(['out.png', 'plane.jpg']), J(names));
    check('without the run window nothing outside the engine\'s own folders is taken', gen.findLocalImages(reply, [], {}).length === 0);
    const big = path.join(home, 'Pictures', 'big.png'); fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(300)]));
    check('full access pictures: a size cap applies', gen.findLocalImages(big, [], { max: 100, fresh: opts }).length === 0 && gen.findLocalImages(big, [], { fresh: opts }).length === 1);
    check('full access pictures: ~/ and Git Bash style paths are read as the folder they stand for', gen.pathsIn('saved ~/Pictures/plane.jpg', { home }).includes(path.join(home, 'Pictures', 'plane.jpg')) && gen.pathsIn('at /c/Users/me/x.png', { home, platform: 'win32' }).includes('C:/Users/me/x.png') && gen.pathsIn('at /c/Users/me/x.png', { home, platform: 'linux' }).includes('/c/Users/me/x.png'));
    let linked = false;
    const link = path.join(home, 'Pictures', 'link.png');
    try { fs.symlinkSync(outside, link); linked = true; } catch { /* no symlink rights */ }
    check('full access pictures: a link out of the allowed folders is not followed', !linked || gen.findLocalImages(link, [], { fresh: opts }).length === 0);
    // through the agent: kept in the chat's store, shown as an image event, and the fresh window starts at the run
    events.length = 0;
    const kept = await inFull(() => full.enginePictures(`Saved ${fresh} and ${old} and ${outside}`, engine, emit, { since: runStart }));
    check('agent: the fresh picture is saved with the chat and shown; the old one and the one elsewhere are not', kept.length === 1 && events.filter((e) => e.type === 'image').length === 1 && store.read(kept[0].id)?.buffer.equals(JPG), J(events));
    events.length = 0;
    const plain = await inFull(() => full.enginePictures(`Saved ${fresh}`, engine, emit));
    check('agent: without full access (no run window) the same path is not shown', plain.length === 0 && !events.some((e) => e.type === 'image'), J(events));
    const claudecode = require('../src/ai/claude-code');
    check('Bash --cwd / --add-dir folders are noticed', J(claudecode.dirsInCommand('grok --cwd "C:\\a b\\out" --add-dir /tmp/x --cwd=/y/z -p "hi"')) === J(['C:\\a b\\out', '/tmp/x', '/y/z']), J(claudecode.dirsInCommand('grok --cwd "C:\\a b\\out" --add-dir /tmp/x --cwd=/y/z -p "hi"')));
    const eng = new claudecode.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({}), ensureServer: () => {} });
    eng.runDirs = new Set([pointed, path.parse(pointed).root, 'relative/dir', path.join(tmp, 'missing')]);
    check('freshRoots: home plus the existing folders the run named; never a drive root, a relative or missing folder', J(eng.freshRoots()) === J([os.homedir(), pointed]), J(eng.freshRoots()));
  }

  // ---- web pictures: https only, no cookies, no private addresses, real images only
  {
    const fetched = [];
    const ok = async (url, init) => { fetched.push({ url, init }); return { ok: true, status: 200, headers: new Map([['content-length', String(PNG.length)]]), arrayBuffer: async () => PNG }; };
    const got = await gen.fetchRemoteImage('https://images.example.com/a.png', { fetchImpl: ok });
    check('web picture: fetched without cookies or referrer, kept as a picture', got?.mime === 'image/png' && fetched[0].init.credentials === 'omit' && fetched[0].init.referrerPolicy === 'no-referrer', J(fetched[0]));
    for (const bad of ['http://images.example.com/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://192.168.1.5/a.png', 'https://10.0.0.1/a.png', 'https://169.254.169.254/latest', 'https://[::1]/a.png', 'https://printer.local/a.png', 'https://user:pw@example.com/a.png', 'file:///C:/x.png', 'javascript:alert(1)', 'https://nodots/a.png']) {
      check(`web picture refused: ${bad}`, (await gen.fetchRemoteImage(bad, { fetchImpl: ok })) === null);
    }
    const redirect = async (url) => (url.includes('start') ? { ok: false, status: 302, headers: new Map([['location', 'https://192.168.0.1/x.png']]) } : ok(url, {}));
    check('web picture: a redirect to a private address is refused', (await gen.fetchRemoteImage('https://example.com/start', { fetchImpl: redirect })) === null);
    const html = async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('<html>not an image at all</html>') });
    check('web picture: an HTML page or SVG is not a picture', (await gen.fetchRemoteImage('https://example.com/a.png', { fetchImpl: html })) === null);
    const big = async () => ({ ok: true, status: 200, headers: new Map([['content-length', String(50 * 1024 * 1024)]]), arrayBuffer: async () => PNG });
    check('web picture: a huge one is refused by its size', (await gen.fetchRemoteImage('https://example.com/a.png', { fetchImpl: big })) === null);
    const down = async () => { throw new Error('offline'); };
    check('web picture: a failed fetch is just null', (await gen.fetchRemoteImage('https://example.com/a.png', { fetchImpl: down })) === null);
  }

  // ---- markdown images in a reply
  {
    const dataImg = render(`![a cat](data:image/png;base64,${png})`);
    check('markdown: a data URL picture is drawn as an <img> with its alt', /<img class="md-img" src="data:image\/png;base64,/.test(dataImg) && dataImg.includes('alt="a cat"'), dataImg.slice(0, 200));
    const remote = render('![a cat](https://example.com/cat.png)');
    check('markdown: a web picture is a placeholder, never an <img> of that address', remote.includes('class="md-img-remote"') && remote.includes('data-src="https://example.com/cat.png"') && !/<img/.test(remote), remote);
    const evil = ['![x](javascript:alert(1))', '![x](data:text/html;base64,PHNjcmlwdD4=)', '![x](data:image/svg+xml;base64,PHN2Zz4=)', '![x](file:///C:/Windows/win.ini)', '![x](http://example.com/a.png)', '![x](//example.com/a.png)', '![x" onerror="alert(1)](https://example.com/a.png)'];
    for (const md of evil) {
      const html = render(md);
      const bare = html.replace(/="[^"]*"/g, '="…"'); // (what is left once every quoted attribute value is set aside)
      check(`markdown: ${md.slice(0, 44)} makes no <img>, no script, no live handler or javascript: link`, !/<img/i.test(html) && !/onerror=|<script/i.test(bare) && !/href="javascript:/i.test(html), html);
    }
    check('markdown: alt text is escaped', !/<b>/.test(render('![<b>x</b>](https://example.com/a.png)')));
    check('markdown: an ordinary link is still a link', /<a href="https:\/\/example.com">site<\/a>/.test(render('[site](https://example.com)')));
    check('markdownImages lists them', gen.markdownImages('a ![one](https://x.test/1.png) b ![](data:image/png;base64,AAAA) c').length === 2);
  }

  // ---- the store: per chat, cleaned up, memory-only without a keychain
  {
    const a = store.save('1111111111111111', PNG, { alt: 'a' });
    const b = store.save('2222222222222222', JPG);
    check('store: ids are chat~random; ids from elsewhere are refused', /^1{16}~[0-9a-f]{16}$/.test(a.id) && store.read('../../etc/passwd') === null && store.read('1111111111111111~../../x') === null && store.read(`${a.id}/..`) === null);
    check('store: not-a-picture and over-size bytes are refused', store.save(CHAT, SVG) === null && gen.createImageStore({ dir: path.join(tmp, 's2'), maxBytes: 20 }).save(CHAT, Buffer.concat([PNG, Buffer.alloc(40)])) === null);
    store.removeChat('1111111111111111');
    check('store: deleting a chat removes its pictures only', store.read(a.id) === null && store.read(b.id) !== null && !fs.existsSync(path.join(tmp, 'store', '1111111111111111')));
    const stray = store.save('3333333333333333', GIF);
    const pruned = store.prune(new Set(['2222222222222222']));
    check('store: prune removes the folders of chats that are gone', pruned >= 1 && store.read(stray.id) === null && store.read(b.id) !== null, String(pruned));
    const memory = gen.createImageStore({ dir: path.join(tmp, 'mem'), available: () => false });
    const m = memory.save(CHAT, PNG);
    check('store: with no keychain nothing is written (kept in memory only)', memory.read(m.id)?.buffer.equals(PNG) && !fs.existsSync(path.join(tmp, 'mem')));
    const wrong = gen.createImageStore({ dir: path.join(tmp, 'store'), encrypt: (s) => s, decrypt: () => { throw new Error('keys changed'); } });
    check('store: unreadable (other keys) is just "gone"', wrong.read(b.id) === null);
  }

  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
