// Images a message carries, plain Node (no Electron, no network, no CLI): the check at the door, the request each
// backend gets (Anthropic content blocks; the OpenAI-style image_url used for OpenAI, Grok, Gemini and OpenRouter;
// each CLI engine's handoff), what the user is told when images are left out or a model can't see them, and the
// saved chat / export keeping them. Fake clients and fake spawns only.
const fs = require('fs');
const path = require('path');
const images = require('../src/features/chat-images');
const providers = require('../src/ai/providers');
const { Agent, requestFor, withoutImages, hasImages, transcriptFor } = require('../src/ai/agent');
const claudeCode = require('../src/ai/claude-code');
const grokBuild = require('../src/ai/grok-build');
const antigravity = require('../src/ai/antigravity');
const { toMarkdown, autoTitle } = require('../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const J = JSON.stringify;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64').toString('base64');
const img = (media_type = 'image/png', data = PNG) => ({ media_type, data });
const block = (i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } });

(async () => {
  // ---- the check at the door (main's agent:ask)
  {
    const { valid, rejected } = images.cleanImages([img(), img('image/jpeg'), img('image/webp'), img('image/gif')]);
    check('PNG, JPEG, WebP and GIF pass', valid.length === 4 && rejected.length === 0, J(rejected));
  }
  {
    const { valid, rejected } = images.cleanImages([img('image/svg+xml', 'PHN2Zz4='), img('image/png', 'not base64!!'), img('image/png', ''), img('image/bmp'), null, img('image/png', 'A'.repeat(7_000_000))]);
    check('SVG, bad base64, empty, BMP, null and an over-size image are all refused', valid.length === 0 && rejected.length === 6, J(rejected));
    check('each refusal has its reason', J(rejected.map((r) => r.reason)) === J(['type', 'data', 'data', 'type', 'type', 'size']), J(rejected));
  }
  {
    const { valid, rejected } = images.cleanImages(Array.from({ length: 8 }, () => img()));
    check('more than 5 images: the first 5 go, the rest are counted', valid.length === 5 && rejected.length === 3 && rejected.every((r) => r.reason === 'count'), J(rejected));
    const note = images.rejectionNotice(rejected);
    check('the notice says how many and why', /Left out 3 images/.test(note) && /limit of 5/.test(note) && /text was sent|rest of your message was sent/.test(note), note);
  }
  check('nothing refused: no notice', images.rejectionNotice([]) === null && images.rejectionNotice(undefined) === null);
  check('a single refusal reads in the singular', /Left out 1 image: 1 image not a PNG/.test(images.rejectionNotice([{ index: 0, reason: 'type' }])), images.rejectionNotice([{ index: 0, reason: 'type' }]));
  check('non-array input is no images', images.cleanImages(undefined).valid.length === 0 && images.cleanImages('x').valid.length === 0);

  // ---- Anthropic: base64 image blocks, before the text, kept in the request
  {
    const messages = [{ role: 'user', content: [block(img()), block(img('image/jpeg')), { type: 'text', text: 'what is this?' }] }];
    messages.settings = { model: 'claude-sonnet-5' };
    const sent = requestFor({ model: 'claude-sonnet-5' }, messages).messages[0].content;
    check('Anthropic request: [image, image, text] with base64 sources', J(sent.map((b) => b.type)) === '["image","image","text"]' && sent[0].source.type === 'base64' && sent[0].source.media_type === 'image/png' && sent[0].source.data === PNG && sent[1].source.media_type === 'image/jpeg', J(sent).slice(0, 200));
  }

  // ---- OpenAI / Grok / Gemini / OpenRouter: Chat Completions image_url (a data URL), also on follow-ups
  {
    const history = [
      { role: 'user', content: [block(img()), { type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a pixel' }] },
      { role: 'user', content: [{ type: 'text', text: 'and the colour?' }] },
    ];
    const out = providers.toChatMessages('sys', history);
    const first = out[1].content;
    check('OpenAI-style: the image is an image_url data URL, before the text', first[0].type === 'image_url' && first[0].image_url.url === `data:image/png;base64,${PNG}` && first[1].type === 'text', J(first).slice(0, 200));
    check('a picture the user attached is still sent on later turns (not turned into a placeholder)', !J(out).includes('omitted'), J(out).slice(0, 300));
    check('the same shape for every provider (they share the Chat Completions form)', ['openai', 'xai', 'gemini', 'openrouter'].every((p) => providers.PROVIDERS[p]));
    // A screenshot a tool returned is still dropped from older turns.
    const withShot = [
      { role: 'user', content: [{ type: 'text', text: 'look' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [block(img())] }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ];
    check('an old tool screenshot is still omitted (token saving)', J(providers.toChatMessages('sys', withShot)).includes('earlier screenshot omitted'));
  }

  // ---- provider errors for a model that takes no images
  {
    providers.clientFor('openai', 'sk-test'); // (loads the SDK; describeProviderError reads its error classes)
    const OpenAI = require('openai');
    const H = new Headers();
    const err = new OpenAI.APIError(400, { message: 'Invalid content type. image_url is only supported by certain models.' }, 'Invalid content type. image_url is only supported by certain models.', H);
    const out = providers.describeProviderError(err, 'openai');
    check('a 400 about image_url becomes a plain "can\'t read images" message', /can't read images/.test(out?.text || ''), J(out));
    const orErr = new OpenAI.APIError(404, { message: 'No endpoints found that support image input' }, 'No endpoints found that support image input', H);
    check('OpenRouter\'s "no endpoints support image input" too', /can't read images/.test(providers.describeProviderError(orErr, 'openrouter')?.text || ''));
    const other = new OpenAI.APIError(404, { message: 'model not found' }, 'model not found', H);
    check('other 404s keep their message', /isn't available for your key/.test(providers.describeProviderError(other, 'openai')?.text || ''));
  }

  // ---- text-only models: the images are left out of the request, said once, the text still goes
  {
    const sent = [];
    const realStream = providers.streamTurn;
    providers.streamTurn = async (opts) => { sent.push(opts); return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; };
    try {
      const agent = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '' }, () => null, () => ({}), () => 'sk-test');
      const make = (model) => { const m = [{ role: 'user', content: [block(img()), { type: 'text', text: 'what is this?' }] }]; m.settings = { model }; return m; };
      const notices = [];
      const emit = (e) => { if (e.type === 'notice') notices.push(e.text); };
      const blind = make('openai:gpt-3.5-turbo');
      await agent.otherTurn(blind, new AbortController().signal, emit);
      await agent.otherTurn(blind, new AbortController().signal, emit);
      const request = sent[0].messages;
      check('text-only model: no image in the request, the text is', !J(request).includes('base64') && J(request).includes('what is this?') && J(request).includes('[image omitted]'), J(request).slice(0, 300));
      check('text-only model: one notice naming the model, not two', notices.length === 1 && /gpt-3\.5-turbo can't see images/.test(notices[0]) && /text was sent/.test(notices[0]), J(notices));
      const sighted = make('openai:gpt-5.6');
      const before = notices.length;
      await agent.otherTurn(sighted, new AbortController().signal, emit);
      check('a model that sees images gets them, with no notice', J(sent[2].messages).includes('base64') && notices.length === before, J(notices));
      check('the chat itself keeps its images', hasImages(blind) && hasImages(withoutImages(blind)) === false);
    } finally { providers.streamTurn = realStream; }
  }

  // ---- CLI engines
  {
    const line = claudeCode.stdinMessage('hi', [img(), img('image/webp')]);
    const content = line.message.content;
    check('Claude Code: stream-json user line, text first then image blocks', line.type === 'user' && J(content.map((b) => b.type)) === '["text","image","image"]' && content[1].source.type === 'base64' && content[2].source.media_type === 'image/webp', J(content).slice(0, 200));
    const blocks = JSON.parse(grokBuild.promptBlocks('hi', [img()]));
    check('Grok Build: --prompt-file blocks carry flat ACP image blocks', blocks[0].type === 'text' && blocks[1].type === 'image' && blocks[1].data === PNG && blocks[1].mimeType === 'image/png', J(blocks).slice(0, 200));
    const text = antigravity.promptFor({ prompt: 'hi', systemPrompt: 'sys', resume: false, imageFiles: ['C:\\x\\a.png', 'C:\\x\\b.jpg'] });
    check('Antigravity: the prompt names the image files', /2 images/.test(text) && text.includes('C:\\x\\a.png') && text.includes('C:\\x\\b.jpg'), text);
    const notes = [];
    const kept = antigravity.capImages([img(), img('image/bmp'), img('image/svg+xml')], (e) => notes.push(e.text));
    check('Antigravity: a type it can\'t read is left out with a notice', kept.length === 1 && /Left out 2 images/.test(notes[0] || ''), J(notes));
  }
  {
    const agent = new Agent({ activeTab: () => null, listTabs: () => [] }, () => null);
    const notices = [];
    const emit = (e) => notices.push(e.text);
    const list = [img(), img()];
    check('engine with a model that sees images: all images go', agent.engineImages('Grok Build', 'grok-4', list, emit).length === 2 && !notices.length);
    check('engine with an unknown or default model: images go (the CLI decides)', agent.engineImages('Grok Build', 'default', list, emit).length === 2 && !notices.length);
    const none = agent.engineImages('Grok Build', 'grok-code-fast-1', list, emit);
    check('engine with a text-only model: images left out, with a notice', none.length === 0 && /Grok Build \(grok-code-fast-1\) can't see images/.test(notices[0] || '') && /text was sent/.test(notices[0]), J(notices));
  }

  // ---- saved chats and what the sidebar shows again
  {
    const messages = [
      { role: 'user', content: [block(img()), { type: 'text', text: 'what is this?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a pixel' }] },
      { role: 'user', content: [block(img('image/jpeg')), { type: 'text', text: 'The user attached the image(s) above without a message.' }] },
    ];
    const items = transcriptFor(messages, {});
    check('a restored chat shows each message with its images as data URLs', items[0].images[0] === `data:image/png;base64,${PNG}` && items[2].role === 'user' && items[2].text === '' && items[2].images.length === 1, J(items).slice(0, 300));
    check('an image-only message is titled "Image"', autoTitle({ messages: [{ role: 'user', content: [block(img())] }] }) === 'Image');
    check('images survive a JSON round trip (the encrypted chat file)', J(JSON.parse(J(messages))) === J(messages));
    const md = toMarkdown({ title: 'T' }, items);
    check('export says how many images were attached (the pictures themselves are not written)', /1 image attached \(not included\)/.test(md) && !md.includes('base64'), md);
    check('a privacy check: no module under src/ai or features/chat-images logs image data', !/console\.(log|info|debug)\([^)]*(\.data|base64)/.test(['../src/ai/agent.js', '../src/ai/providers.js', '../src/features/chat-images.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n')));
  }
  {
    const messages = [{ role: 'user', content: [block(img()), { type: 'text', text: 'x' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [block(img())] }] }];
    check('userImageCount counts attachments, not tool screenshots', images.userImageCount(messages) === 1);
  }

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
