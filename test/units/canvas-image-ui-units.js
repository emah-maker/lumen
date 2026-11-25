// The canvas, picture and HTML round, plain Node: no Electron.
//   designed HTML   chat-canvas.js frameDocument gives plain HTML Lumen's base styles (in a cascade layer, the user's accent, light and
//                   dark), leaves a page with its own CSS alone, keeps a doctype first, and never lets the accent carry CSS of its own
//   the panel       chat-canvas-panel.js is the lumen://chat canvas (views, edit, versions, widths, expand) and stays out of the sidebar bundle;
//                   its preview is still the sandboxed, no-network frame
//   picture card    generate_image tells the chat who is making the picture, then done or why it failed (status events with `image`),
//                   and the renderer turns them into a progress card, an error card, and Try again / Variation / Edit on the picture
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const canvas = require('../../src/renderer/chat-canvas');
const gen = require('../../src/features/gen-images');
const { Agent } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const noComments = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

(async () => {
  // ---- designed HTML
  {
    const plain = canvas.frameDocument('html', '<!DOCTYPE html><html><body><h1>Report</h1><table><tr><td>1</td></tr></table></body></html>', { accent: '#ff375f' });
    check('plain HTML gets the base styles', plain.includes('@layer lumen-base') && plain.includes('max-width:760px'), plain.slice(0, 300));
    check('they are in a cascade layer, so any CSS the page adds wins', /<style>@layer lumen-base\{/.test(plain));
    check('they use the accent given', plain.includes('--a:#ff375f'));
    check('they follow light and dark', plain.includes('color-scheme:light dark') && plain.includes('prefers-color-scheme:dark'));
    check('the doctype stays first (standards mode), the policy right after it', /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"/.test(plain), plain.slice(0, 120));
    check('without a doctype the policy is first, as before', canvas.frameDocument('html', '<p>hi</p>').startsWith('<meta http-equiv="Content-Security-Policy"'));
    const own = canvas.frameDocument('html', '<!doctype html><style>body{background:red}</style><p>x</p>');
    check('a page with its own <style> is left alone', !own.includes('lumen-base') && own.includes('background:red'));
    check('so is one that links a stylesheet', !canvas.frameDocument('html', '<link rel="stylesheet" href="a.css"><p>x</p>').includes('lumen-base'));
    check('plain: true turns them off', !canvas.frameDocument('html', '<p>x</p>', { plain: true }).includes('lumen-base'));
    check('an SVG is not given page styles', !canvas.frameDocument('svg', '<svg></svg>').includes('lumen-base'));
    check('accent: a colour passes', canvas.cleanAccent('#0a84ff') === '#0a84ff' && canvas.cleanAccent('rgb(10, 132, 255)') === 'rgb(10, 132, 255)');
    const evil = canvas.frameDocument('html', '<p>x</p>', { accent: 'red}</style><script>alert(1)</script>' });
    check('accent: anything else falls back, so it can never close the style or add CSS', canvas.cleanAccent('red;}body{x:1') === '#0a84ff' && !evil.includes('alert(1)'), evil.slice(0, 400));
    check('the base styles carry no network address (the frame allows none anyway)', !/url\(|https?:|@import/.test(canvas.baseCss('#000')));
    check('ownStyles', canvas.ownStyles('<STYLE>') && canvas.ownStyles('<link href=x rel="stylesheet">') && !canvas.ownStyles('<p style="color:red">'));
  }

  // ---- the panel
  {
    const panel = noComments(read('src/renderer/chat-canvas-panel.js'));
    const page = read('src/renderer/chat-page.html');
    const sidebar = read('src/renderer/index.src.html');
    const order = ['chat-canvas.js', 'chat-canvas-panel.js', 'ai-files.js', 'chat-core.js'].map((f) => page.indexOf(`<script src="${f}"`));
    check('the chat page loads the panel after the canvas core and before ai-files.js and chat-core.js', order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), J(order));
    check('the sidebar bundle does not carry the panel', !sidebar.includes('chat-canvas-panel.js') && sidebar.includes('chat-canvas.js'));
    check('the preview is still sandbox="allow-scripts" only, with no features, on canvas-frame.html', /setAttribute\('sandbox', 'allow-scripts'\)/.test(panel) && /setAttribute\('allow', ''\)/.test(panel) && /frame\.src = 'canvas-frame\.html'/.test(panel) && !/allow-same-origin|srcdoc|allow-popups|allow-top-navigation/.test(panel));
    check('the document goes in by postMessage, with the accent', /postMessage\(\{ lumenCanvas: html \}, '\*'\)/.test(panel) && /frameDocument\(kind, code, \{ accent: core\.accent\(\) \}\)/.test(panel));
    check('the code is shown as text and edited in a textarea, never as markup', !/innerHTML|insertAdjacentHTML|outerHTML/.test(panel) && /el\('textarea'/.test(panel));
    check('Code, Split and Preview views; Full, Tablet and Phone widths', ["tab('code'", "tab('split'", "tab('preview'"].every((s) => panel.includes(s)) && /full: 0, tablet: 768, phone: 390/.test(panel));
    check('versions: Undo, Redo, Original, the original always kept', /function record\(/.test(panel) && /splice\(1, 1\)/.test(panel) && /state\.versions\[0\]/.test(panel));
    check('Expand, Reload, Copy, Download and Close are there', ['canvas.expand', 'canvas.reload', 'chat.copyCode', 'canvas.download', 'canvas.close'].every((k) => panel.includes(`'${k}'`)));
    check('Escape leaves Expand first, then closes', /cv-wide'\)\) expand\.click\(\); else closePanel\(true\)/.test(panel));
    const en = JSON.parse(read('src/locales/en.json'));
    const strings = en.strings || en;
    const keys = [...new Set([...read('src/renderer/chat-canvas-panel.js').matchAll(/say\('([\w.]+)'/g)].map((m) => m[1]))];
    const missing = keys.filter((k) => typeof strings[k] !== 'string');
    check('every string the panel shows is in locales/en.json', keys.length > 20 && missing.length === 0, missing.join());
    const css = read('src/renderer/chat-canvas.css');
    check('the panel styles use Lumen\'s tokens, no palette of their own', /var\(--accent/.test(css) && /var\(--field\)/.test(css) && !/#[0-9a-f]{3,8}\b/i.test(css.replace(/#fff\b/gi, '')), (css.match(/#[0-9a-f]{3,8}\b/gi) || []).join());
  }

  // ---- the picture card: what main says while a picture is made
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-imgcard-'));
    const store = gen.createImageStore({ dir: path.join(tmp, 'store') });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64').toString('base64');
    const make = () => {
      const agent = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '' }, () => null, () => ({}), (p) => (p === 'openai' ? 'key-openai' : null));
      agent.imageStore = store;
      agent.engines = {};
      return agent;
    };
    const chatOf = (model) => { const m = []; m.settings = { model }; return m; };
    const run = async (agent, prompt) => {
      const events = [];
      const emit = (e) => events.push(e);
      const messages = chatOf('claudecode:default');
      let err = null;
      await agent.inTask(null, new AbortController().signal, async () => {
        await agent.ensureAllowed('generate_image', emit, new AbortController().signal, { input: { prompt }, run: messages });
        try { await agent.execute('generate_image', { prompt }); } catch (e) { err = e; }
      }, messages, null, { chatId: 'abcdef0123456789' });
      return { events: events.filter((e) => e.type === 'status' && e.image), err };
    };
    {
      const agent = make();
      agent.imageBackendOverrides = { openai: async () => ({ images: [{ data: png, alt: '' }], model: 'gpt-image-1', said: '' }) };
      const { events } = await run(agent, 'a lighthouse at dawn');
      check('making: the chat is told who is making it and the prompt', events[0]?.image?.state === 'making' && events[0].image.provider === 'OpenAI' && events[0].image.prompt === 'a lighthouse at dawn', J(events));
      check('then done (the picture takes the card\'s place)', events.at(-1)?.image?.state === 'done', J(events));
    }
    {
      const agent = make();
      agent.imageBackendOverrides = { openai: async () => { throw Object.assign(new Error('Your request was rejected by the safety system.'), { status: 400, code: 'moderation_blocked' }); } };
      const { events, err } = await run(agent, 'something');
      const last = events.at(-1)?.image;
      check('a failure tells the chat why, in the words the tool error uses', Boolean(err) && last?.state === 'failed' && last.message.length > 0 && err.message.includes(last.message.slice(0, 20)), J({ events, err: err?.message }));
    }
    const core = read('src/renderer/chat-core.js');
    const renderer = noComments(read('src/renderer/gen-images.js'));
    check('chat-core hands image status to the card and puts the picture in its place', /window\.genImages\?\.progress\?\.\(turn\.imgPending, event\.image, appendToTurn\)/.test(core) && /turn\.imgPending\.replaceWith\(bubble\)/.test(core));
    check('a progress card no picture came for goes when the reply ends; a failure card stays', /if \(turn\.imgPending && !turn\.imgPending\.classList\.contains\('gen-img-failed'\)\) turn\.imgPending\.remove\(\)/.test(core));
    check('Try again and Variation send, Edit only fills the message box', /genimg\.againAsk[^\n]*send: true/.test(renderer) && /genimg\.variationAsk[^\n]*send: true/.test(renderer) && /genimg\.editAsk[^\n]*\)\)\)/.test(renderer) && !/genimg\.editAsk[^\n]*send: true/.test(renderer));
    check('a draft in the message box is kept and then nothing is sent', /prompt\.value = typed \? `\$\{typed\}\\n\$\{text\}` : text/.test(core) && /if \(send && !typed\) sendComposer\(\)/.test(core));
    check('the card is built from text only', !/innerHTML|insertAdjacentHTML/.test(renderer));
    check('Save and Copy stay their own row; Open and the asks sit beside them', /className: 'gen-img-bar' \}, button\(tr\('genimg\.save'\)/.test(renderer) && /className: 'gen-img-acts' \}, button\(tr\('genimg\.open'\)/.test(renderer));
    // which pictures get Try again: only ones a provider made from a prompt
    const made = (credit) => Boolean(credit) && !/^(From |Lumen\b|Drawn by Lumen)/.test(String(credit));
    check('the rule in gen-images.js matches: a provider\'s picture yes; a web one, an SVG drawing or a marked screenshot no', renderer.includes("!/^(From |Lumen\\b|Drawn by Lumen)/.test(String(pic.credit))") && made('OpenAI · gpt-image-1') && !made('From example.com') && !made('Drawn by Lumen') && !made('Lumen') && !made(''));
    const en = JSON.parse(read('src/locales/en.json'));
    const strings = en.strings || en;
    const keys = [...new Set([...read('src/renderer/gen-images.js').matchAll(/tr\('([\w.]+)'/g)].map((m) => m[1]))];
    const missing = keys.filter((k) => typeof strings[k] !== 'string');
    check('every string the picture card shows is in locales/en.json', missing.length === 0, missing.join());
  }

  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
