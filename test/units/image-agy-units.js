// [image routing] Antigravity (agy) as a picture engine (ai/image-agy.js, "Make pictures with: Antigravity"). Plain Node, no network,
// and never the real agy: LUMEN_AGY_BIN names a stand-in file, and a spawn hook runs a small fake agy (a Node script written here)
// that reads its argv like agy would and, depending on FAKE_AGY_MODE, saves a picture, saves nothing, says it is signed out, or refuses.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
const router = require('../../src/ai/image-router');
const imageAgy = require('../../src/ai/image-agy');
const providers = require('../../src/ai/providers');
const fallback = require('../../src/ai/fallback');
const settingsBackend = require('../../src/settings/settings-backend');
const { Agent } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agyimg-'));

// The stand-in agy: only its path matters (LUMEN_AGY_BIN). The spawn hook below runs FAKE in its place.
const STAND_IN = path.join(tmp, process.platform === 'win32' ? 'agy.exe' : 'agy');
fs.writeFileSync(STAND_IN, '');
const FAKE = path.join(tmp, 'fake-agy.js');
fs.writeFileSync(FAKE, `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(argv) + '\\n');
const dir = argv[argv.indexOf('--add-dir') + 1];
const mode = process.env.FAKE_AGY_MODE || 'ok';
const png = Buffer.from(${J(PNG)}, 'base64');
const conv = 'conv-' + process.pid;
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const brain = path.join(process.env.HOME || dir, '.gemini', 'antigravity-cli', 'brain', conv);
const reply = (text) => { say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: text } }); };
if (mode !== 'noinit') say({ event: 'init', conversation_id: conv, init: { model: 'gemini-3.8-flash-medium' } });
say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent' } });
const art = (name, bytes) => { fs.mkdirSync(brain, { recursive: true }); const f = path.join(brain, name); fs.writeFileSync(f, bytes); return f; };
// ok: like agy 1.5.1, the picture goes into its own artifact folder (never the one the prompt names), then it goes on for a minute
if (mode === 'ok' || mode === 'noinit') { const f = art('picture_1793931749384.png', png); reply('Generated: [picture](file:///' + f.split(path.sep).join('/') + ')'); setTimeout(() => say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS' } }), 20000); }
else if (mode === 'jpgname') { fs.writeFileSync(path.join(dir, 'generated_image.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)])); }
else if (mode === 'notpicture') { art('picture_1.png', 'this is not a picture'); reply('Done.'); }
else if (mode === 'signedout') { console.error('Error: not signed in. Run agy and sign in with your Google account.'); process.exit(1); }
else if (mode === 'refuse') { reply("I can't create that image because it violates the content policy."); say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS' } }); }
else if (mode === 'slow') { setTimeout(() => {}, 60000); }
else { reply('Done.'); say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS' } }); }
`);
const LOG = path.join(tmp, 'agy-calls.log');
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
let mode = 'ok';
const spawned = [];
const fakeSpawn = (bin, argv, opts) => {
  spawned.push({ bin, opts });
  if (bin !== STAND_IN) throw new Error(`the test would have run a real program: ${bin}`);
  return nodeSpawn(process.execPath, [FAKE, ...argv], { ...opts, env: { ...(opts.env || {}), FAKE_AGY_LOG: LOG, FAKE_AGY_MODE: mode } });
};

(async () => {
  process.env.LUMEN_AGY_BIN = STAND_IN;
  const bin = await require('../../src/ai/antigravity').findAgy();
  check('LUMEN_AGY_BIN names the agy Lumen runs (the stand-in, never the real one)', bin === STAND_IN, bin);

  // ---- the run itself
  {
    const userData = path.join(tmp, 'profile');
    fs.mkdirSync(userData);
    const steps = [];
    const start = Date.now();
    const made = await imageAgy.generate({ bin, prompt: 'a red "fox" in the snow', userData, spawn: fakeSpawn, tmpRoot: tmp, pollMs: 50, onProgress: (t) => steps.push(t) });
    const took = Date.now() - start;
    const argv = calls().at(-1);
    check('the picture agy saved in its own artifact folder (brain/<conversation>/) comes back, checked as a real PNG', made.images.length === 1 && made.images[0].data === PNG && made.model === 'agy', J({ ...made, images: made.images.length }));
    check(`the run is ended as soon as the picture is there, not when agy exits a minute later (${took} ms)`, took < 8000, took);
    check('progress for the card: starting, drawing, saving', J(steps) === J(['Starting Antigravity…', 'Antigravity is drawing your picture…', 'Saving the picture…']), J(steps));
    const home0 = imageAgy.imageHomeFor(userData);
    check('the conversation\'s artifact folder is removed afterwards', !fs.existsSync(path.join(home0, '.gemini', 'antigravity-cli', 'brain')) || fs.readdirSync(path.join(home0, '.gemini', 'antigravity-cli', 'brain')).length === 0, '');
    check('the run: --sandbox, --mode accept-edits, --add-dir the temp folder, --print-timeout, stream-json, no slash commands', argv[0] === '--sandbox' && argv[argv.indexOf('--mode') + 1] === 'accept-edits' && argv.includes('--add-dir') && argv[argv.indexOf('--print-timeout') + 1] === imageAgy.PRINT_TIMEOUT && argv[argv.indexOf('--output-format') + 1] === 'stream-json' && argv.includes('--disable-slash-commands'), J(argv));
    const ask = argv[argv.indexOf('-p') + 1];
    check('the prompt: generate_image once, the picture left where it is saved, no other tool, reply with its path', /^Use your generate_image tool once to make this picture: a red 'fox' in the snow\. Leave the image where generate_image saves it \(do not copy, move or convert it\) and use no other tool\. Then reply with only the image's full path\.$/.test(ask), ask);
    check('never auto-approve or skip permissions', !argv.some((a) => /always-approve|dangerously|skip-permissions/.test(a)), J(argv));
    const dir = argv[argv.indexOf('--add-dir') + 1];
    check('the output folder is a fresh temp folder, removed afterwards', path.basename(dir).startsWith('lumen-agy-image-') && path.dirname(dir) === tmp && !fs.existsSync(dir), dir);
    const home = imageAgy.imageHomeFor(userData);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
    const env = spawned.at(-1).opts.env;
    check('its own home: commands, URLs and MCP tools denied, only the temp folder trusted, no MCP servers', env.HOME === home && env.USERPROFILE === home && ['command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'].every((d) => settings.permissions.deny.includes(d)) && J(settings.trustedWorkspaces) === J([dir]) && !fs.existsSync(path.join(home, '.gemini', 'config', 'mcp_config.json')), J({ settings, home: env.HOME }));
    check('the user\'s other environment stays behind (no API keys of other providers)', !('OPENAI_API_KEY' in env) && !('ANTHROPIC_API_KEY' in env), Object.keys(env).join());

    mode = 'jpgname';
    const jpg = await imageAgy.generate({ bin, prompt: 'x', userData, spawn: fakeSpawn, tmpRoot: tmp });
    check('a picture saved in the temp folder, under another name or type, is found too', jpg.images.length === 1 && Buffer.from(jpg.images[0].data, 'base64')[0] === 0xff);
    mode = 'noinit';
    const noinit = await imageAgy.generate({ bin, prompt: 'x', userData, spawn: fakeSpawn, tmpRoot: tmp, pollMs: 50 });
    check('no conversation id in the stream: a new artifact folder (or the path in the reply) is looked in', noinit.images.length === 1, '');
    check('namedImages: only paths inside the allowed folders count', J(imageAgy.namedImages('see file:///C:/a/b/picture_1.jpg and /etc/x.png', [path.resolve('C:/a')])) === J([path.resolve('C:/a/b/picture_1.jpg')]) || process.platform !== 'win32', '');

    mode = 'edit';
    await imageAgy.generate({ bin, prompt: 'make it blue', source: { buffer: Buffer.from(PNG, 'base64'), mime: 'image/png' }, userData, spawn: fakeSpawn, tmpRoot: tmp }).catch(() => null);
    const editArgv = calls().at(-1);
    check('an edit puts the picture in the folder and names it in the prompt (and it is never taken for the result)', /^Use your generate_image tool once to edit the image .+source\.png as follows: make it blue\./.test(editArgv[editArgv.indexOf('-p') + 1]), J(editArgv));

    for (const [m, label, test] of [
      ['none', 'agy saved nothing: an error, no picture', (e) => e && !e.policy && /Done\.|no picture/.test(e.message)],
      ['notpicture', 'a file that is not a picture is not returned', (e) => e && !e.policy],
      ['signedout', 'agy not signed in: said, and marked so the next provider is asked', (e) => e?.message === 'Antigravity is not signed in.' && fallback.classify(e).kind === 'auth'],
      ['refuse', 'agy refused in words: its content policy (never retried elsewhere)', (e) => e?.policy === true && providers.isPolicyError(e)],
    ]) {
      mode = m;
      let err = null;
      try { await imageAgy.generate({ bin, prompt: 'x', userData, spawn: fakeSpawn, tmpRoot: tmp }); } catch (e) { err = e; }
      check(label, test(err), J({ message: err?.message, policy: err?.policy, kind: err && fallback.classify(err).kind }));
    }
    mode = 'slow';
    let late = null;
    const t0 = Date.now();
    try { await imageAgy.generate({ bin, prompt: 'x', userData, spawn: fakeSpawn, tmpRoot: tmp, timeoutMs: 800 }); } catch (e) { late = e; }
    check('a run that hangs is ended, and its temp folder is gone (the exit is waited for)', late?.code === 'ETIMEDOUT' && Date.now() - t0 < 5000 && !fs.readdirSync(tmp).some((n) => n.startsWith('lumen-agy-image-')), J({ code: late?.code, left: fs.readdirSync(tmp) }));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    let stopped = null;
    try { await imageAgy.generate({ bin, prompt: 'x', userData, spawn: fakeSpawn, tmpRoot: tmp, signal: ctl.signal }); } catch (e) { stopped = e; }
    check('Stop ends the run, and its temp folder is gone', stopped?.name === 'AbortError' && !fs.readdirSync(tmp).some((n) => n.startsWith('lumen-agy-image-')), J(fs.readdirSync(tmp)));
    let none = null;
    try { await imageAgy.generate({ bin: null, prompt: 'x' }); } catch (e) { none = e; }
    check('agy not installed: says so', /not installed/.test(none?.message || ''));
  }

  // ---- the router and the setting
  {
    check('Antigravity is a choice for "Make pictures with", and Settings validates it', router.SETTINGS.includes('antigravity') && settingsBackend.validate('imageGen', 'antigravity') === 'antigravity' && router.labelOf('antigravity') === 'Antigravity');
    const ALL = { grokbuild: true, xai: true, gemini: true, openai: true, openrouter: true, antigravity: true };
    check('an Antigravity chat: its pictures are agy\'s own (first), then Grok Build and the API keys', J(router.plan({ connected: ALL, current: 'antigravity:gemini-3.8-flash-medium' }).order) === J(['antigravity', 'grokbuild', 'xai', 'gemini', 'openai', 'openrouter']), J(router.plan({ connected: ALL, current: 'antigravity:gemini-3.8-flash-medium' }).order));
    check('Automatic on another chat: Antigravity last, after Grok Build and every API key', J(router.plan({ connected: ALL, current: 'claude-opus-5' }).order) === J(['grokbuild', 'xai', 'gemini', 'openai', 'openrouter', 'antigravity']));
    check('Automatic with no API key and no Grok Build: agy makes the picture', J(router.plan({ connected: { antigravity: true }, current: 'claude-opus-5' }).order) === J(['antigravity']));
    check('Grok Build picked (grok first, agy as the fallback), even in an Antigravity chat: Grok Build, then agy', J(router.plan({ setting: 'grokbuild', connected: { grokbuild: true, antigravity: true }, current: 'antigravity:default' }).order) === J(['grokbuild', 'antigravity']));
    check('picked: Antigravity first, then the Automatic order', J(router.plan({ setting: 'antigravity', connected: ALL }).order) === J(['antigravity', 'grokbuild', 'xai', 'gemini', 'openai', 'openrouter']));
    check('picked but not installed or signed out: the others, and Antigravity is named', J(router.plan({ setting: 'antigravity', connected: { ...ALL, antigravity: false } }).order) === J(['grokbuild', 'xai', 'gemini', 'openai', 'openrouter']) && router.notReady('antigravity') === 'Antigravity is not installed or signed in');
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locales', 'en.json'), 'utf8'));
    const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'settings.js'), 'utf8');
    check('Settings lists it, with its name in the locale', /IMAGE_ENGINES = \[[^\]]*'antigravity'/.test(ui) && en['settings.ai.imageGen.antigravity'] === 'Antigravity (agy)');
  }

  // ---- end to end through the agent: generate_image with "Make pictures with: Antigravity"
  {
    const make = (status, keys = ['openai']) => {
      const agent = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '', imageGen: () => 'antigravity' }, () => null, () => ({}), (p) => (keys.includes(p) ? `key-${p}` : null));
      agent.engines = { antigravity: { status: async () => status, ensureBin: () => require('../../src/ai/antigravity').findAgy(), userData: path.join(tmp, 'profile') }, grokbuild: { status: async () => ({ installed: false }) } };
      agent.imageAgySpawn = fakeSpawn;
      agent.imageBackendOverrides = { openai: async () => ({ images: [{ data: PNG }], model: 'gpt-image-1' }) };
      return agent;
    };
    const chat = () => { const m = []; m.settings = { model: 'claude-sonnet-5' }; return m; };
    const route = (agent) => agent.routeImage({ prompt: 'a lighthouse', current: 'claude-sonnet-5', signal: new AbortController().signal });
    mode = 'ok';
    const before = calls().length;
    let r = await route(make({ installed: true, signedIn: 'unknown' }));
    check('picked, installed: generate_image goes to agy, and the picture is credited to it', r.provider === 'antigravity' && r.credit === 'Antigravity · agy' && !r.insteadOf && calls().length === before + 1, J({ ...r, images: r.images.length }));
    mode = 'signedout';
    const gone = make({ installed: true, signedIn: 'unknown' });
    r = await route(gone);
    check('agy turns out signed out: OpenAI makes it, credited "instead of Antigravity" with the reason', r.provider === 'openai' && r.insteadOf === 'antigravity' && r.credit === 'OpenAI · gpt-image-1 (instead of Antigravity: not signed in)' && r.insteadWhy === 'not signed in or key rejected', J({ ...r, images: r.images.length }));
    check('… and agy is remembered as signed out (not run again until a run works)', gone.engines.antigravity.signedOut === true, '');
    mode = 'none';
    r = await route(make({ installed: true, signedIn: 'unknown' }));
    check('agy saves no picture: the next engine makes it, and the credit says what agy did', r.provider === 'openai' && r.insteadOf === 'antigravity' && /instead of Antigravity: failed: Done\./.test(r.credit), J({ provider: r.provider, credit: r.credit }));
    const n = calls().length;
    r = await route(make({ installed: false, signedIn: false }));
    check('agy not installed: it is never run, the next engine makes it, and why is said', r.provider === 'openai' && r.insteadOf === 'antigravity' && /not installed or signed in/.test(r.insteadWhy) && calls().length === n, J({ provider: r.provider, why: r.insteadWhy }));
    const statuses = [];
    mode = 'ok';
    await make({ installed: false, signedIn: false }).routedImageTurn(chat(), { prompt: 'a cat' }, 'claude-sonnet-5', new AbortController().signal, (e) => { if (e.type === 'status' && e.text) statuses.push(e.text); });
    check('the status line says Antigravity isn\'t available', statuses.some((s) => /with OpenAI \(Antigravity isn’t available\)/.test(s)), J(statuses));
    let off = null;
    try { await route(make({ installed: false, signedIn: false }, [])); } catch (e) { off = e; }
    check('agy picked, not installed, and nothing else connected: one clear message, no key asked for', off?.code === 'none' && /Antigravity is chosen for pictures/.test(off.userMessage || ''), off?.message);
  }

  // ---- an Antigravity chat on Automatic: "generate an image of a cat" is made by agy itself (it used to go to Grok Build)
  {
    const make = (grokImpl) => {
      const agent = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '', imageGen: () => 'auto' }, () => null, () => ({}), () => null);
      const eng = { detect: async () => 'agy', imageReady: () => require('../../src/ai/antigravity').AntigravityEngine.prototype.imageReady.call(eng), status: async () => { throw new Error('status() runs agy models: not for routing'); }, ensureBin: () => require('../../src/ai/antigravity').findAgy(), userData: path.join(tmp, 'profile-auto') };
      agent.engines = { antigravity: eng, grokbuild: { status: async () => ({ installed: true, signedIn: true }) } };
      agent.imageAgySpawn = fakeSpawn;
      agent.imageBackendOverrides = { grokbuild: grokImpl };
      return agent;
    };
    const grokCalls = [];
    const grok = async () => { grokCalls.push(1); return { images: [{ data: PNG }], model: 'image_gen' }; };
    const cat = (agent) => agent.routeImage({ prompt: 'a cat', current: 'antigravity:gemini-3.8-flash-medium', signal: new AbortController().signal });
    mode = 'ok';
    let r = await cat(make(grok));
    // Automatic outside an Antigravity chat: agy only once a run has shown it is signed in (it has no sign-in check that costs nothing)
    {
      const claude = make(grok);
      let conn = await claude.imageConnected('claude-sonnet-5');
      check('Automatic in another chat: an installed agy nobody has seen work is not asked', conn.antigravity === false, J(conn));
      conn = await claude.imageConnected('antigravity:gemini-3.8-flash-medium');
      check('… but in an Antigravity chat it is (the user is using agy)', conn.antigravity === true, J(conn));
      claude.engines.antigravity.signedOut = false; // an agy run worked
      conn = await claude.imageConnected('claude-sonnet-5');
      check('… and once an agy run has worked, Automatic asks it (last) in any chat', conn.antigravity === true, J(conn));
      claude.engines.antigravity.signedOut = true;
      conn = await claude.imageConnected('antigravity:gemini-3.8-flash-medium');
      check('… and never after a run said it is signed out, not even in an Antigravity chat', conn.antigravity === false, J(conn));
    }
    check('Antigravity chat, Automatic, Grok Build signed in too: agy makes the cat, credited to it, Grok Build never asked', r.provider === 'antigravity' && r.credit === 'Antigravity · agy' && grokCalls.length === 0, J({ provider: r.provider, credit: r.credit, grok: grokCalls.length }));
    mode = 'none';
    r = await cat(make(grok));
    check('agy actually fails: Grok Build makes it, and the card says why ("instead of Antigravity: failed: …")', r.provider === 'grokbuild' && /^Grok Build · image_gen \(instead of Antigravity: failed: /.test(r.credit) && grokCalls.length === 1, r.credit);
    mode = 'ok';
    const statuses = [];
    const chat = []; chat.settings = { model: 'antigravity:gemini-3.8-flash-medium' };
    const agent = make(grok);
    await agent.routedImageTurn(chat, { prompt: 'a cat' }, 'antigravity:gemini-3.8-flash-medium', new AbortController().signal, (e) => { if (e.type === 'status' && e.text) statuses.push(e.text); });
    check('the card shows agy\'s progress: who, then starting and drawing', statuses[0] === 'Making your picture with Antigravity…' && statuses.includes('Starting Antigravity…') && statuses.includes('Antigravity is drawing your picture…'), J(statuses));
  }

  delete process.env.LUMEN_AGY_BIN;
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
