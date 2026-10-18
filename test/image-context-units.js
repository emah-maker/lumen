// "generate an image for each problem ... how to draw the free body diagrams" must not go to a picture model with only those words.
// Plain Node: the real Agent and the real Claude Code engine with a fake CLI (test/acceptance/chat-harness.js, its DIAGRAMS behaviour
// follows ai/image-router.js DIAGRAM_NOTE) and FAKE image providers: no Electron window, no network, no key, no real generation.
//  - features/gen-images.js: technical / diagramish / context hints on the request.
//  - A page with three numbered statics problems + the user's exact message: the page text reaches the model with the diagram instruction,
//    no picture provider is asked, and the reply holds three inline SVG diagrams (arrows with markers, labels), one per problem.
//  - "draw a cat astronaut" is still a picture made by a provider.
//  - Nothing to read (no tab, no attachment, no earlier message): asked once, naming what was looked at; no model, no provider.
//  - A Grok Build refusal of a chart/diagram request: one notice line, then the model draws it as SVG (direct path and generate_image tool).
const path = require('path');
const gen = require('../src/features/gen-images');
const router = require('../src/ai/image-router');
const { Agent } = require('../src/ai/agent');
const H = require('./acceptance/chat-harness');

const { check, chat, send, until, msgOf, release, toolCall, errorsOf, finish, hardStop, agent, tmp, readLog, state } = H;
const J = JSON.stringify;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
hardStop();

const USER = 'generate an image for each problem that explains how to do it and how to draw the free body diagrams needed to get full credit';

// ---- the hints
{
  const i = gen.pictureIntent(USER);
  check('the exact message is a picture request that is technical (free body diagrams) and points at the page (each problem)', i && i.technical === true && i.context === true && i.loose === false, J(i));
  const cat = gen.pictureIntent('draw a cat astronaut');
  check('"draw a cat astronaut" is none of those: it stays a plain picture request', cat && !cat.technical && !cat.context && !cat.diagramish, J(cat));
  const tech = ['draw the circuit diagram for each problem', 'make an image of a free-body diagram', 'generate a picture of the truss with the loads', 'create an image of the flowchart'];
  check('circuits, FBDs, trusses and flowcharts are technical', tech.every((t) => gen.technicalIntent(t)), J(tech.filter((t) => !gen.technicalIntent(t))));
  const plain = ['generate an image of a sunset', 'draw a cat astronaut', 'Create an illustration of the water cycle', 'make a picture of a dragon', 'draw me a logo for my cafe'];
  check('illustrative requests are neither technical, diagram-like nor pointing at anything', plain.every((t) => !gen.technicalIntent(t) && !gen.contextRef(t) && !gen.diagramishIntent(t)), J(plain.filter((t) => gen.technicalIntent(t) || gen.contextRef(t) || gen.diagramishIntent(t))));
  const points = ['draw this', 'generate an image for each problem', 'make a picture of these', 'draw the figure in the pdf'];
  check('"this", "each problem", "these", "the pdf" point at something', points.every((t) => gen.contextRef(t)), J(points.filter((t) => !gen.contextRef(t))));
  check('PICTURE_NOTE (the loose-request hint) is unchanged for requests that are not technical', /The user wants a picture: call generate_image/.test(router.PICTURE_NOTE));
  check('DIAGRAM_NOTE: no image model, collect the items first, ask once naming what was looked at, one svg per item with arrows and labels', /Do not use an image model/.test(router.DIAGRAM_NOTE) && /current tab/.test(router.DIAGRAM_NOTE) && /attached files/.test(router.DIAGRAM_NOTE) && /earlier messages/.test(router.DIAGRAM_NOTE) && /ask once, naming what you looked at/.test(router.DIAGRAM_NOTE) && /ONE inline ```svg block/.test(router.DIAGRAM_NOTE) && /<marker>/.test(router.DIAGRAM_NOTE), router.DIAGRAM_NOTE);
  const ask = router.noContextAsk({ tab: 'no tab is open' });
  check('the one question names the tab, attachments and chat it looked at, and what to give', /current tab \(no tab is open\)/.test(ask) && /attachments \(none\)/.test(ask) && /this chat/.test(ask) && /paste/i.test(ask), ask);
}

(async () => {
  agent.execute = Agent.prototype.execute;
  agent.imageStore = gen.createImageStore({ dir: path.join(tmp, 'pictures') });
  agent.getKey = (p) => (p === 'openai' ? 'fake-key-openai' : null);
  agent.engines.grokbuild.status = async () => ({ installed: true, signedIn: true });
  agent.browser.imageGen = () => 'auto';
  agent.browser.autoExcluded = () => [];
  agent.browser.claudeCodeFullAccess = () => false;
  const asked = [];
  let grok = 'refuse';
  agent.imageBackendOverrides = {
    grokbuild: async (a) => {
      asked.push({ name: 'grokbuild', prompt: a.prompt });
      if (grok === 'refuse') throw Object.assign(new Error("I can't generate those diagrams yet. This message doesn't include the problems."), { imageApi: true, policy: true });
      return { images: [{ data: PNG.toString('base64'), alt: '' }], model: 'image_gen', said: '' };
    },
    openai: async (a) => { asked.push({ name: 'openai', prompt: a.prompt }); return { images: [{ data: PNG.toString('base64'), alt: '' }], model: 'gpt-image-1', said: '' }; },
  };
  const cliRuns = () => readLog().filter((e) => e.ev === 'msg').length;
  const PROBLEMS = '<untrusted_page_content title="Statics HW 3" url="https://canvas.test/hw3">\nText of the user\'s current tab, attached automatically.\n\n1. A 10 m beam is pinned at A and on a roller at B and carries a 5 kN load at midspan. Find the reactions.\n2. A 200 N crate rests on a 30 degree incline with friction. Find the friction force.\n3. A cable holds a 50 kg lamp at 40 degrees from the ceiling. Find the tension.\n</untrusted_page_content>\n\n';
  const realPage = agent.pageContextFor;
  agent.pageContextFor = async () => PROBLEMS; // (the page the user is on: three numbered statics problems)

  // ---- 3 problems on the page + the user's exact message: 3 inline SVG diagrams, no picture provider
  {
    asked.length = 0;
    const messages = chat('claudecode:default');
    const before = cliRuns();
    const events = await send(messages, `${USER} RUN-P3`, 1).done;
    const m = msgOf('RUN-P3');
    const reply = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    check('3 problems: the message reaches the chat model (not a picture provider), no image engine asked', cliRuns() === before + 1 && asked.length === 0 && !events.some((e) => e.type === 'image'), J({ ran: cliRuns() - before, asked, types: events.map((e) => e.type), errors: errorsOf(events) }));
    check('3 problems: the model is sent the page text with the three problems', m && /5 kN load at midspan/.test(m.prompt) && /30 degree incline/.test(m.prompt) && /50 kg lamp/.test(m.prompt), J(m?.prompt?.slice(0, 300)));
    check('3 problems: the model is told to draw them as SVG, one per problem (hidden browser_state block), not to use an image model', m && m.prompt.includes(router.DIAGRAM_NOTE) && !m.prompt.includes(router.PICTURE_NOTE) && /<browser_state>[\s\S]*Do not use an image model[\s\S]*<\/browser_state>/.test(m.prompt), J(m?.prompt?.slice(0, 200)));
    const svgs = [...reply.matchAll(/```svg\n([\s\S]*?)```/g)].map((x) => x[1]);
    check('3 problems: the reply holds three inline SVG blocks', svgs.length === 3, `${svgs.length}: ${reply.slice(0, 300)}`);
    check('3 problems: each is labelled with its problem number', [1, 2, 3].every((n) => new RegExp(`Problem ${n}\\n\`\`\`svg`).test(reply) && svgs[n - 1]?.includes(`Problem ${n}`)), reply.slice(0, 300));
    check('3 problems: each SVG has force arrows (<line>/<path> with a marker) and text labels', svgs.every((s) => /<marker\b/.test(s) && /<(?:line|path)\b[^>]*marker-end="url\(#/.test(s) && /<text\b[^>]*>[^<]+<\/text>/.test(s) && /<line\b/.test(s) && /<path\b/.test(s)), J(svgs));
    check('3 problems: the steps follow each diagram', (reply.match(/Draw the body alone/g) || []).length === 3);
    const userTurn = messages.find((x) => x.role === 'user');
    check('3 problems: the instruction is in the hidden block of the user turn only', /<browser_state>[\s\S]*Do not use an image model[\s\S]*<\/browser_state>/.test(J(userTurn?.content || '')) === true || /Do not use an image model/.test((userTurn?.content || []).map((b) => b.text || '').join('')));
  }

  // ---- the same message, the page is short of the problems: the model is still the one that asks (page has none)
  // ---- an illustrative request is still a picture made by a provider
  {
    asked.length = 0; grok = 'ok';
    const before = cliRuns();
    const events = await send(chat('claudecode:default'), 'draw a cat astronaut', 1).done;
    check('"draw a cat astronaut": made by an image provider, as typed, the CLI never runs', asked.length === 1 && asked[0].prompt === 'draw a cat astronaut' && events.some((e) => e.type === 'image') && cliRuns() === before, J({ asked, types: events.map((e) => e.type), errors: errorsOf(events) }));
    grok = 'refuse';
  }

  // ---- nothing to read: asked once, naming what was looked at
  {
    asked.length = 0;
    state.active = null; // no tab open
    const messages = chat('claudecode:default');
    const before = cliRuns();
    agent.pageContextFor = realPage;
    const events = await send(messages, USER, undefined).done;
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    check('no context: the AI asks for the problems, naming the tab, attachments and chat it looked at', /I looked at the current tab \(no tab is open\), your attachments \(none\) and this chat/.test(text) && /paste/i.test(text), J({ text, errors: errorsOf(events) }));
    check('no context: no model run, no picture provider asked, no picture', cliRuns() === before && asked.length === 0 && !events.some((e) => e.type === 'image'), J({ ran: cliRuns() - before, asked }));
    check('no context: the question is the reply in the chat history, so it is asked once', messages.filter((x) => x.role === 'assistant').length === 1, J(messages.map((x) => x.role)));
    state.active = 1;
    agent.pageContextFor = async () => PROBLEMS;
  }

  // ---- a stub Grok Build refusal of a chart: one notice line, then SVG
  {
    asked.length = 0; grok = 'refuse';
    const messages = chat('claudecode:default');
    const events = await send(messages, 'generate an image of a bar chart of monthly sales RUN-FB', 1).done;
    const m = msgOf('RUN-FB');
    const notices = events.filter((e) => e.type === 'notice').map((e) => e.text);
    check('Grok refusal: Grok Build was asked first and refused (once, nobody else asked)', asked.length === 1 && asked[0].name === 'grokbuild', J(asked));
    check('Grok refusal: the user gets one line saying it is drawn as SVG instead, and no confusing "declined" text or error', notices.length === 1 && /Grok Build couldn't make this picture, so I'll draw it as SVG diagrams here instead\./.test(notices[0]) && !events.some((e) => e.type === 'error' || (e.type === 'text' && /declined/.test(e.text || ''))), J({ notices, errors: errorsOf(events) }));
    check('Grok refusal: the model then runs with the diagram instruction in place of the picture one', m && m.prompt.includes(router.DIAGRAM_NOTE) && !m.prompt.includes(router.PICTURE_NOTE), J(m?.prompt?.slice(0, 200)));
    const plain = await send(chat('claudecode:default'), 'generate an image of a sunset RUN-FB2', 1).done;
    const said = plain.filter((e) => e.type === 'text').map((e) => e.text).join('');
    check('Grok refusal of a plain picture is still its own answer (no SVG fallback for a sunset)', /declined this picture/.test(said) && !readLog().some((e) => e.marker === 'RUN-FB2'), J({ said, errors: errorsOf(plain) }));
  }

  // ---- the generate_image tool: the engine refuses a diagram, the model is told to draw it
  {
    asked.length = 0; grok = 'refuse';
    const run = send(chat('claudecode:default'), 'RUN-TOOLFB HOLD-TOOLFB please look at the page and make a picture', 1);
    const m = await until(() => msgOf('RUN-TOOLFB'), 15000);
    const out = m?.token ? await toolCall(m.token, 'generate_image', { prompt: 'free body diagram of the beam with a 5 kN load' }) : null;
    const text = (out?.content || []).map((c) => c.text || '').join(' ');
    check('generate_image: a refused diagram comes back to the model as an instruction to draw it as SVG and tell the user in one line', out?.isError === true && /Do not retry it with an image model/.test(text) && /ONE inline ```svg block/.test(text), J(out));
    release('TOOLFB');
    await run.done;
  }
  finish();
})().catch((e) => { console.error(e); check('suite ran to the end', false, e.message); finish(); });
