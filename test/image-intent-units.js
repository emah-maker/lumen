// Picture requests reach generate_image on every engine. Plain Node: the real Agent and engines with fake CLIs
// (test/acceptance/chat-harness.js) and FAKE image providers: no Electron window, no network, no key, no real generation.
//  - features/gen-images.js pictureIntent: "generate an image on how to do the problem" after "look at the pdf ..." counts, a
//    screenshot of the page or "what's in this image" does not.
//  - A message that needs reading first is not sent straight to a provider: the model is told (hidden browser_state block) to call
//    generate_image, not to write an HTML / SVG file or preview anything in a tab. A bare "generate an image please" is routed
//    straight to a provider, Claude Code with full access included.
//  - generate_image with svg draws exact math / graphs to a PNG shown inline; open_tab will not preview a file during a picture request.
const path = require('path');
const gen = require('../src/features/gen-images');
const router = require('../src/ai/image-router');
const { Agent } = require('../src/ai/agent');
const H = require('./acceptance/chat-harness');

const { check, chat, send, until, msgOf, release, toolCall, errorsOf, finish, hardStop, agent, tmp, readLog } = H;
const J = JSON.stringify;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
hardStop();

// ---- the intent
const HW5 = 'look at the pdf i just downloaded and generate an image on how to do the problem, include graphs diagrams and everything i need to do to show my work';
const yes = ['generate an image of a sunset', 'make a picture', 'draw a diagram image', HW5, 'generate an image please', 'Create an illustration of the water cycle', 'read the notes and then draw me a picture of the setup', 'can you generate images for each step'];
const no = ['image of the page', 'what\'s in this image', 'what is in this image?', 'take an image of the page', 'how do I generate an image in python?', 'make the image bigger', 'create an image gallery component in React', 'summarize this pdf', 'draw a conclusion from this', 'don\'t generate an image, just explain', 'save this image to my desktop'];
check('picture requests are detected (HW5 phrasing, "generate an image please", "draw a diagram image")', yes.every((t) => gen.pictureIntent(t)), J(yes.filter((t) => !gen.pictureIntent(t))));
check('talk about pictures is not a request (the page screenshot, "what\'s in this image", code, questions, negations)', no.every((t) => !gen.pictureIntent(t)), J(no.filter((t) => gen.pictureIntent(t))));
check('a bare request is direct (routed straight to a provider), one that needs reading first is loose (a hint)', gen.pictureIntent('generate an image please')?.loose === false && gen.pictureIntent(HW5)?.loose === true && gen.imageRequest(HW5) === null, J([gen.pictureIntent('generate an image please'), gen.pictureIntent(HW5)]));
check('the HW5 request carries on as one for the model: the whole message is the prompt', gen.pictureIntent(HW5)?.prompt === HW5);

// ---- the SVG drawing
(async () => {
  const seen = [];
  const rasterize = async (svg, w, h) => { seen.push({ svg, w, h }); return PNG; };
  const out = await router.renderSvg('<?xml version="1.0"?><svg viewBox="0 0 400 200"><text x="5" y="20">x = 3</text></svg>', { rasterize });
  check('renderSvg: a viewBox-only SVG gets a namespace and a size of 800-1600 px, and comes back as the PNG', out.equals(PNG) && /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(seen[0].svg) && seen[0].w === 800 && seen[0].h === 400 && /^<svg xmlns=[^>]* width="800" height="400" viewBox/.test(seen[0].svg), J(seen[0]));
  let bad = null;
  await router.renderSvg('<html><body>hi</body></html>', { rasterize }).catch((e) => { bad = e; });
  check('renderSvg: anything but one <svg> element is refused (never an HTML page)', Boolean(bad), '');

  // ---- the chat, with fake providers and a fake drawing
  agent.execute = Agent.prototype.execute;
  agent.imageStore = gen.createImageStore({ dir: path.join(tmp, 'pictures') });
  agent.getKey = (p) => (p === 'openai' ? 'fake-key-openai' : null);
  agent.engines.grokbuild.status = async () => ({ installed: false, signedIn: false });
  let setting = 'auto';
  agent.browser.imageGen = () => setting;
  agent.browser.autoExcluded = () => [];
  const drawn = [];
  agent.svgRasterizer = async (svg, w, h) => { drawn.push({ svg, w, h }); return PNG; };
  const asked = [];
  agent.imageBackendOverrides = { openai: async (a) => { asked.push(a.prompt); return { images: [{ data: PNG.toString('base64'), alt: '' }], model: 'gpt-image-1', said: '' }; } };
  const cliRuns = () => readLog().filter((e) => e.ev === 'msg').length;
  const hinted = (e) => Boolean(e) && e.prompt.includes(router.PICTURE_NOTE);

  // Claude Code with full access: "generate an image please" goes straight to a provider, the CLI (and its skills) never runs
  {
    H.agent.browser.claudeCodeFullAccess = () => true;
    const before = cliRuns();
    const events = await send(chat('claudecode:default'), 'generate an image please', 1).done;
    check('Claude Code (full access): "generate an image please" is made by a provider and shown inline, the CLI never runs', events.some((e) => e.type === 'image' && /^OpenAI/.test(e.credit)) && cliRuns() === before && asked.length === 1, J({ types: events.map((e) => e.type), asked, ran: cliRuns() - before }));
    check('Claude Code (full access): no notice, no error', !events.some((e) => e.type === 'notice' || e.type === 'error'), J(errorsOf(events)));
  }

  // The HW5 request: the CLI gets it with the instruction, calls generate_image (a picture and an exact drawing), and tries to open the file
  for (const [engine, model] of [['Claude Code (full access)', 'claudecode:default'], ['Claude Code', 'claudecode:default']]) {
    H.agent.browser.claudeCodeFullAccess = () => engine.includes('full');
    asked.length = 0; drawn.length = 0;
    const tag = engine.includes('full') ? 'HWF' : 'HWP';
    const messages = chat(model);
    const run = send(messages, `RUN-${tag} HOLD-${tag} ${HW5}`, 1);
    const m = await until(() => msgOf(`RUN-${tag}`), 15000);
    check(`${engine}: the HW5 request reaches the CLI with the generate_image instruction (not sent to a provider unread)`, hinted(m) && asked.length === 0, J({ prompt: m?.prompt?.slice(0, 400), asked }));
    check(`${engine}: the instruction forbids an HTML / SVG file and a browser preview`, /Never write an HTML, SVG or other file/.test(m?.prompt || '') && /never open a browser or tab/.test(m?.prompt || ''));
    const pic = m?.token ? await toolCall(m.token, 'generate_image', { prompt: 'worked solution to problem 1 of HW5, labelled steps' }) : null;
    const drawing = m?.token ? await toolCall(m.token, 'generate_image', { prompt: 'the exact graph and equations', svg: '<svg viewBox="0 0 600 400"><path d="M0 0L600 400" stroke="black"/></svg>' }) : null;
    const preview = m?.token ? await toolCall(m.token, 'open_tab', { url: 'file:///C:/Users/me/Downloads/HW5_Problem1_solution.html' }) : null;
    const previewSvg = m?.token ? await toolCall(m.token, 'open_tab', { url: 'C:\\Users\\me\\solution.svg' }) : null;
    check(`${engine}: generate_image makes the picture with a connected provider`, pic && !pic.isError && asked.length === 1, J({ pic, asked }));
    check(`${engine}: generate_image with svg draws it to a PNG here (no provider asked, no file)`, drawing && !drawing.isError && drawn.length === 1 && drawn[0].w === 800 && drawn[0].h === 533 && asked.length === 1, J({ drawing, drawn: drawn.map((d) => [d.w, d.h]), asked }));
    check(`${engine}: open_tab refuses to preview a page or SVG during a picture request`, preview?.isError === true && previewSvg?.isError === true && /do not open a file in a tab/.test((preview.content || []).map((c) => c.text).join(' ')), J({ preview, previewSvg }));
    release(tag);
    const events = await run.done;
    const shown = events.filter((e) => e.type === 'image');
    check(`${engine}: both pictures are shown inline in the chat, one credited to the provider and one drawn by Lumen`, shown.length === 2 && shown.some((e) => /^OpenAI/.test(e.credit)) && shown.some((e) => e.credit === 'Drawn by Lumen'), J(shown.map((e) => e.credit)));
    const userTurn = messages.find((x) => x.role === 'user');
    const visible = J(userTurn?.content || '').includes('The user wants a picture');
    check(`${engine}: the instruction rides in the hidden browser_state block only`, visible && /<browser_state>[\s\S]*The user wants a picture[\s\S]*<\/browser_state>/.test((userTurn.content || []).map((b) => b.text || '').join('')), '');
  }

  // No hint when there is nothing to make, or when picture making is off
  {
    H.agent.browser.claudeCodeFullAccess = () => false;
    await send(chat('claudecode:default'), 'RUN-NOPIC summarize this page and image of the page too', 1).done;
    check('an ordinary message gets no picture instruction', !hinted(msgOf('RUN-NOPIC')) && msgOf('RUN-NOPIC'), J(msgOf('RUN-NOPIC')?.prompt?.slice(0, 200)));
    setting = 'off';
    await send(chat('claudecode:default'), `RUN-OFFIMG ${HW5}`, 1).done;
    check('picture making off: no instruction (the tool would refuse)', msgOf('RUN-OFFIMG') && !hinted(msgOf('RUN-OFFIMG')));
    setting = 'auto';
  }

  // Grok Build gets the same instruction (last: its engine sweeps the temp folder the fake CLI log lives in)
  {
    const messages = chat('grokbuild:default');
    const events = await send(messages, `RUN-HWG ${HW5}`, 1).done;
    const m = msgOf('RUN-HWG');
    check('Grok Build: the HW5 request reaches the CLI with the generate_image instruction', hinted(m), J({ prompt: m?.prompt?.slice(0, 300), errors: errorsOf(events) }));
  }

  finish();
})().catch((e) => { console.error(e); check('suite ran to the end', false, e.message); finish(); });
