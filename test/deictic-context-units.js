// "this", "that", "it" mean the assistant's latest reply. Plain Node: the real Agent and engines with fake CLIs
// (test/acceptance/chat-harness.js) and a FAKE image provider: no Electron window, no network, no key.
//  - A homework chat (PDF attached, 4a asked and answered, 4b asked and answered) then "generate an image to show this": the
//    picture prompt the provider gets is built from the 4b reply (4a is not in it), and the hidden instruction for the model
//    says "this/that/it" is its latest reply.
//  - "draw a cat" (an explicit subject) is not changed; a request with nothing to point at goes on as typed.
//  - "explain this more simply": the history the model gets (API request, CLI handover) has the latest reply in full, last.
const path = require('path');
const gen = require('../src/features/gen-images');
const router = require('../src/ai/image-router');
const { Agent, requestFor, transcriptFor, fitContext, handoffTurns } = require('../src/ai/agent');
const H = require('./acceptance/chat-harness');

const { check, chat, send, errorsOf, finish, hardStop, tmp } = H;
const J = JSON.stringify;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
hardStop();

const U = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const A = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const A4 = 'Problem 4a: the beam is a simple cantilever. The reaction at the wall is R = wL, and the moment M = wL^2/2. ALPHA-4A-CANTILEVER';
const A4B = 'Problem 4b: now the beam is supported at both ends. Each support carries wL/2 and the maximum moment is wL^2/8 at midspan. BRAVO-4B-SIMPLY-SUPPORTED';
const history = () => [
  U('<browser_state>\nActive tab id: 1\nTitle: hw4.pdf\n</browser_state>\n\nHere is hw4.pdf, solve 4a'),
  A(A4),
  U('now 4b'),
  A(A4B),
];
const flat = (m) => (Array.isArray(m.content) ? m.content.map((b) => b.text || '').join('') : String(m.content));

// ---- the pure parts
{
  const yes = ['generate an image to show this', 'generate image to show this', 'draw it', 'generate an image please', 'make a picture of what you just said', 'draw the last one', 'illustrate the above', '/image this'];
  const no = ['draw a cat', 'generate an image of a sunset over the sea', 'create a logo for my cafe', 'draw a cat that is smiling', 'make a picture of the water cycle'];
  check('requests that point at the chat (or name nothing) are found', yes.every((t) => gen.pointsAtChat(t)), J(yes.filter((t) => !gen.pointsAtChat(t))));
  check('requests with their own subject are left alone', no.every((t) => !gen.pointsAtChat(t)), J(no.filter((t) => gen.pointsAtChat(t))));
  const items = transcriptFor([...history(), U('generate an image to show this')], null);
  const built = gen.imagePromptFrom('generate an image to show this', items);
  check('the image prompt is built from the 4b reply, with the user\'s words first', built.prompt.startsWith('generate an image to show this') && built.prompt.includes('BRAVO-4B-SIMPLY-SUPPORTED'), built.prompt);
  check('the image prompt does not carry the 4a reply, the PDF note or the browser state', !built.prompt.includes('ALPHA-4A') && !/browser_state|hw4\.pdf/.test(built.prompt), built.prompt);
  check('only the question the 4b reply answered rides along, as background', /Background only[^\n]*now 4b/.test(built.prompt) && !/solve 4a/.test(built.prompt), built.prompt);
  const plain = gen.imagePromptFrom('draw a cat', items);
  check('"draw a cat" goes to the provider as typed', plain.prompt === 'draw a cat' && plain.shown === 'draw a cat', J(plain));
  const lone = gen.imagePromptFrom('generate an image to show this', transcriptFor([U('generate an image to show this')], null));
  check('with nothing to point at, the request goes on as typed', lone.prompt === 'generate an image to show this', J(lone));
  const onlyUser = gen.imagePromptFrom('draw it', transcriptFor([U('the water cycle for a 5th grader'), U('draw it')], null));
  check('no reply yet: the user\'s own latest earlier message is the subject', /water cycle for a 5th grader/.test(onlyUser.prompt) && /user's latest earlier message/.test(onlyUser.prompt), onlyUser.prompt);
  const long = gen.imagePromptFrom('show this as a picture', transcriptFor([U('q'), A(`OPENING ${'x'.repeat(6000)} CLOSING`), U('show this as a picture')], null));
  check('a very long reply is clipped to its opening and its end, not dropped', long.prompt.includes('OPENING') && long.prompt.includes('CLOSING') && long.prompt.length < 4200, String(long.prompt.length));
  check('the hidden instruction says "this/that/it" is the latest reply', /"this\/that\/it" = your most recent reply/.test(router.PICTURE_NOTE));
}

// ---- the text follow-up: what the model is sent
{
  const messages = [...history(), U('explain this more simply')];
  messages.settings = { model: 'claude-opus-5-5', adhdMode: true };
  const sent = requestFor(messages.settings, messages).messages;
  check('API request: the 4b reply is in the history in full, and the last message is the follow-up', sent[sent.length - 1].role === 'user' && /explain this more simply/.test(flat(sent[sent.length - 1])) && sent[sent.length - 2].role === 'assistant' && flat(sent[sent.length - 2]) === A4B, J(sent.map((m) => [m.role, flat(m).slice(0, 40)])));
  // a window too small for everything: the oldest turns go, the newest (the 4b reply and the follow-up) stay
  const tight = fitContext(messages, 520);
  check('over budget: the oldest turns are cut, the 4b reply and the follow-up are kept in order', flat(tight[tight.length - 2]) === A4B && /explain this more simply/.test(flat(tight[tight.length - 1])) && !tight.some((m) => flat(m).includes('ALPHA-4A')), J(tight.map((m) => [m.role, flat(m).slice(0, 30)])));
  const turns = handoffTurns(transcriptFor(messages, null).slice(0, -1));
  check('CLI handover: the 4b reply is the last turn, in full, after the 4a turns', turns.endsWith(`Assistant: ${A4B}`) && turns.indexOf('ALPHA-4A') < turns.indexOf('BRAVO-4B'), turns.slice(-200));
  const big = [...history().slice(0, 3), A(`${'x'.repeat(9000)} LAST-WORDS`), U('explain this more simply')];
  const bigTurns = handoffTurns(transcriptFor(big, null).slice(0, -1), 6000);
  check('CLI handover over budget: the latest reply is still the last turn (clipped), not an older one', /Assistant: x/.test(bigTurns.split('\n\n').slice(-1)[0]), bigTurns.slice(-120));
}

// ---- the chat, with a fake provider
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

  const events = await send(chat('claudecode:default', history()), 'generate an image to show this', 1).done;
  check('chat: "generate an image to show this" makes a picture with the provider', events.some((e) => e.type === 'image') && asked.length === 1, J({ types: events.map((e) => e.type), errors: errorsOf(events) }));
  check('chat: the provider was given the 4b reply, not 4a', asked[0]?.includes('BRAVO-4B-SIMPLY-SUPPORTED') && !asked[0].includes('ALPHA-4A'), asked[0]);

  asked.length = 0;
  await send(chat('claudecode:default', history()), 'draw a cat', 1).done;
  check('chat: "draw a cat" is sent as typed', asked.length === 1 && asked[0] === 'draw a cat', J(asked));
  finish();
})().catch((e) => { console.error(e); check('suite ran to the end', false, e.message); finish(); });
