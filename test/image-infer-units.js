// A picture request in a chat with earlier turns goes to the MODEL with the whole conversation, and the model writes the generate_image
// prompt (it resolves "this", "the second one", "the graph you described" as any assistant does; Lumen has no rule for what a pronoun
// means). Only a chat's first message with nothing attached ("draw a cat") goes straight to the picture provider.
// Plain Node: the real Agent and the real Claude Code engine with a fake CLI (test/acceptance/chat-harness.js) and a FAKE image provider.
const path = require('path');
const gen = require('../src/features/gen-images');
const router = require('../src/ai/image-router');
const { Agent, requestFor } = require('../src/ai/agent');
const H = require('./acceptance/chat-harness');

const { check, chat, send, errorsOf, finish, hardStop, tmp, readLog } = H;
const J = JSON.stringify;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
hardStop();

const U = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const A = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const A4 = 'Problem 4a: the beam is a simple cantilever. The reaction at the wall is R = wL. ALPHA-4A-CANTILEVER';
const A4B = 'Problem 4b: the beam is supported at both ends. Each support carries wL/2. BRAVO-4B-SIMPLY-SUPPORTED';
const homework = () => [
  U('<browser_state>\nActive tab id: 1\nTitle: hw4.pdf\n</browser_state>\n\nHere is hw4.pdf, solve 4a'),
  A(A4),
  U('now 4b'),
  A(A4B),
];
const diagrams = () => [
  U('describe three diagrams for the lecture'),
  A('Diagram one: a FIRST-DIAGRAM-FLOWCHART of the login steps.'),
  U('next'),
  A('Diagram two: a SECOND-DIAGRAM-SEQUENCE between client and server.'),
  U('and the last'),
  A('Diagram three: a THIRD-DIAGRAM-STATE-MACHINE for the session.'),
];

// ---- the wording the model is given: nothing about what a pronoun means, and the tool says the provider sees only the prompt
{
  check('the hidden picture instruction has no pronoun rule and does not favour a file', !/this\/that|"this"|most recent reply|read any file|pdf/i.test(router.PICTURE_NOTE), router.PICTURE_NOTE);
  check('the hidden picture instruction: generate_image, a self-contained prompt, no file or tab, svg for exact math', /generate_image/.test(router.PICTURE_NOTE) && /self-contained prompt/.test(router.PICTURE_NOTE) && /Never write an HTML, SVG or other file/.test(router.PICTURE_NOTE) && /never open a browser or tab/.test(router.PICTURE_NOTE) && /svg option/.test(router.PICTURE_NOTE), router.PICTURE_NOTE);
  check('the tool says the image model sees only the prompt, so the subject must be spelled out', /sees only prompt/.test(router.TOOL.description) && /describe subject fully/.test(router.TOOL.description), router.TOOL.description);
  check('the #471 helpers are gone', gen.pointsAtChat === undefined && gen.chatSubject === undefined && gen.imagePromptFrom === undefined);
}

// ---- the API request for a picture request in a chat: every earlier turn, in order, and the request last
{
  const flat = (m) => (Array.isArray(m.content) ? m.content.map((b) => b.text || '').join('') : String(m.content));
  const messages = [...homework(), U('generate an image to show this')];
  messages.settings = { model: 'claude-opus-5-5', adhdMode: true };
  const sent = requestFor(messages.settings, messages).messages;
  check('API request: the whole history reaches the model, the 4b reply included, the request last', sent.length === 5 && flat(sent[1]).includes('ALPHA-4A') && flat(sent[3]) === A4B && /generate an image to show this/.test(flat(sent[4])), J(sent.map((m) => [m.role, flat(m).slice(0, 40)])));
}

(async () => {
  const ag = H.agent;
  ag.execute = Agent.prototype.execute;
  ag.imageStore = gen.createImageStore({ dir: path.join(tmp, 'pictures') });
  ag.getKey = (p) => (p === 'openai' ? 'fake-key-openai' : null);
  ag.engines.grokbuild.status = async () => ({ installed: false, signedIn: false });
  ag.browser.imageGen = () => 'auto';
  ag.browser.autoExcluded = () => [];
  ag.browser.claudeCodeFullAccess = () => true;
  const asked = [];
  ag.imageBackendOverrides = { openai: async (a) => { asked.push(a.prompt); return { images: [{ data: PNG.toString('base64'), alt: '' }], model: 'gpt-image-1', said: '' }; } };
  const modelPrompt = (marker) => readLog().find((e) => e.ev === 'msg' && e.marker === marker)?.prompt || '';

  // when is there a conversation to resolve against
  {
    check('hasConversation: a brand-new chat has none', ag.hasConversation([U('draw a cat')]) === false);
    check('hasConversation: any earlier turn is one', ag.hasConversation([U('hi'), A('hello'), U('draw it')]) === true && ag.hasConversation([...homework(), U('draw this')]) === true);
    check('hasConversation: a file attached to the first message is context too', ag.hasConversation([U('draw this')], { attachedFiles: 1 }) === true);
  }

  // the 4a / 4b conversation: the model gets the whole history, the provider is not called with the user's words
  {
    const events = await send(chat('claudecode:default', homework()), 'generate an image to show this RUN-IMGAB', 1).done;
    const prompt = modelPrompt('RUN-IMGAB');
    check('4a/4b: no direct provider call (nothing sent with only the user words)', asked.length === 0 && !events.some((e) => e.type === 'image'), J({ asked, types: events.map((e) => e.type), errors: errorsOf(events) }));
    check('4a/4b: the request reached the model', prompt.includes('generate an image to show this'), prompt.slice(0, 300));
    check('4a/4b: the model got the full history, the latest reply (4b) included', prompt.includes('BRAVO-4B-SIMPLY-SUPPORTED') && prompt.includes('ALPHA-4A-CANTILEVER') && prompt.indexOf('ALPHA-4A') < prompt.indexOf('BRAVO-4B'), prompt.slice(0, 600));
    check('4a/4b: the model is told to use generate_image and nothing says what "this" means', /generate_image/.test(prompt) && !/most recent reply|this\/that/.test(prompt), prompt.slice(-600));
  }

  // "this" is not the latest reply: the model has everything, so nothing forces the latest one
  {
    asked.length = 0;
    const events = await send(chat('claudecode:default', diagrams()), 'make an image of the first diagram you described RUN-IMGFIRST', 1).done;
    const prompt = modelPrompt('RUN-IMGFIRST');
    check('first diagram: no direct provider call', asked.length === 0 && !events.some((e) => e.type === 'image'), J(asked));
    check('first diagram: all three replies reach the model, in order, so it can pick the first', ['FIRST-DIAGRAM-FLOWCHART', 'SECOND-DIAGRAM-SEQUENCE', 'THIRD-DIAGRAM-STATE-MACHINE'].every((w) => prompt.includes(w)) && prompt.indexOf('FIRST-DIAGRAM') < prompt.indexOf('SECOND-DIAGRAM') && prompt.indexOf('SECOND-DIAGRAM') < prompt.indexOf('THIRD-DIAGRAM'), prompt.slice(0, 800));
    check('first diagram: the request is not rewritten around the latest reply', /make an image of the first diagram you described/.test(prompt) && !/Subject \(/.test(prompt), prompt.slice(0, 400));
  }

  // the same through the router entry point, on a chat model that has its own image API: still not the user's words alone
  {
    asked.length = 0;
    const text = 'draw it';
    const handled = await ag.imageTurn(chat('openai:gpt-5.6', [...homework(), U(text)]), text, new AbortController().signal, () => {});
    check('imageTurn with a conversation on an image-capable model: left to the model, no provider call', handled === false && asked.length === 0, J({ handled, asked }));
    const emitted = [];
    const slash = await ag.imageTurn(chat('claudecode:default', [...homework(), U('/image a cat')]), '/image a cat', new AbortController().signal, (e) => emitted.push(e));
    check('imageTurn with a conversation and "/image ...": also the model, which writes the prompt', slash === false && asked.length === 0, J({ slash, asked, emitted }));
  }

  // a brand-new chat that names its subject: the direct path, unchanged
  {
    asked.length = 0;
    const events = await send(chat('claudecode:default'), 'draw a cat', 1).done;
    check('new chat: "draw a cat" goes straight to the provider, as typed', asked.length === 1 && asked[0] === 'draw a cat' && events.some((e) => e.type === 'image'), J({ asked, types: events.map((e) => e.type), errors: errorsOf(events) }));
    asked.length = 0;
    const direct = await ag.imageTurn(chat('openai:gpt-5.6', [U('draw a cat')]), 'draw a cat', new AbortController().signal, () => {});
    check('new chat on an image-capable model: handled directly, as typed', direct === true && asked.length === 1 && asked[0] === 'draw a cat', J({ direct, asked }));
    asked.length = 0;
    const withFile = await ag.imageTurn(chat('openai:gpt-5.6', [U('draw this')]), 'draw this', new AbortController().signal, () => {}, { attachedFiles: 1 });
    check('new chat with a file attached: the model sees the file, no direct call', withFile === false && asked.length === 0, J({ withFile, asked }));
  }
  finish();
})().catch((e) => { console.error(e); check('suite ran to the end', false, e.message); finish(); });
