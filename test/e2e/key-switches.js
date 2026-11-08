// [key switches] + [image routing] in the real app, with a temp profile and a local stand-in for the OpenAI and Gemini APIs (no
// real network, no real key): Settings → AI → API keys gives each saved key an on/off switch. Off: the key stays saved, its
// models leave the model menu, nothing is sent with it, and the image router passes it over; on again, it is all back with no
// retyping. "Make pictures with" (imageGen) sends generate_image to the provider picked there, and to the next connected one,
// named, when that one is off or out of usage.
// Run with LUMEN_TEST_BACKGROUND=1 so the window stays invisible and never takes focus.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('../helpers/settings-tab');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await sleep(100); } return v; };
const J = JSON.stringify;
const KEYS = { openai: 'sk-openai-test', gemini: 'gm-gemini-test' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

  // The stand-in API: /models for either key (who asked is recorded by key), anything else refused.
  const seen = [];
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push({ key: auth, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (!Object.values(KEYS).includes(auth)) { res.statusCode = 401; return res.end(J({ error: { message: 'bad key' } })); }
    if (req.url.endsWith('/models')) return res.end(J({ object: 'list', data: auth === KEYS.openai ? [{ id: 'gpt-5.6', object: 'model' }] : [{ id: 'gemini-3.8-flash', object: 'model' }] }));
    res.statusCode = 404; return res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-keyswitch-'));
  const hide = path.join(profile, 'no-such-cli.exe'); // the user's own AI CLIs are not this test's
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: '', GEMINI_API_KEY: '', XAI_API_KEY: '', OPENROUTER_API_KEY: '', LUMEN_CLAUDE_BIN: hide, LUMEN_CODEX_BIN: hide, LUMEN_GROK_BIN: hide, LUMEN_AGY_BIN: hide },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, b) => { global.__providers.PROVIDERS.openai.baseURL = `${b}/v1`; global.__providers.PROVIDERS.gemini.baseURL = `${b}/gemini/`; }, base);
  for (const [p, k] of Object.entries(KEYS)) await ui.evaluate(([pp, kk]) => window.assistant.setProviderKey(pp, kk), [p, k]);

  const modelIds = async () => (await ui.evaluate(async () => (await window.assistant.getSettings()).models.map((m) => m.id)));
  const settingsFile = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
  await waitFor(async () => (await modelIds()).includes('openai:gpt-5.6') && (await modelIds()).includes('gemini:gemini-3.8-flash'));
  check('both keys saved: their models are in the model menu', (await modelIds()).includes('openai:gpt-5.6') && (await modelIds()).includes('gemini:gemini-3.8-flash'), J(await modelIds()));

  // ---- Settings → AI → API keys: a switch on each saved key
  const inSettings = await openSettingsTab(app, 'ai-keys');
  await waitFor(() => inSettings("Boolean(document.querySelector('[data-provider=openai] .key-switch'))"));
  const rowsState = await inSettings("JSON.stringify([...document.querySelectorAll('#ai-keys .item.key')].map((e) => ({ p: e.dataset.provider, sw: e.querySelector('.key-switch')?.checked ?? null, state: e.querySelector('.key-state')?.textContent })))");
  const rows = JSON.parse(rowsState);
  const row = (p) => rows.find((r) => r.p === p);
  check('a saved key has a switch, on; a key that is not set has none', row('openai')?.sw === true && row('gemini')?.sw === true && row('anthropic')?.sw === true && row('xai')?.sw === null && row('openrouter')?.sw === null, rowsState);
  check('the switch is named for its key', (await inSettings("document.querySelector('[data-provider=openai] .key-switch').getAttribute('aria-label')")) === 'Use the OpenAI key');

  // ---- switch OpenAI off
  const before = seen.length;
  await inSettings("document.querySelector('[data-provider=openai] .key-switch').click()");
  await waitFor(async () => (await inSettings("document.querySelector('[data-provider=openai] .key-state')?.textContent")) === 'Off');
  check('the row says Off, and the switch is off', (await inSettings("document.querySelector('[data-provider=openai] .key-state')?.textContent")) === 'Off' && (await inSettings("document.querySelector('[data-provider=openai] .key-switch').checked")) === false, await inSettings("document.querySelector('[data-provider=openai]').textContent"));
  check('it is saved as off, and the key itself stays saved', J(settingsFile().keysOff) === J(['openai']) && typeof settingsFile().keys?.openai === 'string' && settingsFile().keys.openai.length > 10, J({ off: settingsFile().keysOff, has: Boolean(settingsFile().keys?.openai) }));
  await waitFor(async () => !(await modelIds()).some((id) => id.startsWith('openai:')));
  check('OpenAI\'s models leave the model menu; Gemini\'s stay', !(await modelIds()).some((id) => id.startsWith('openai:')) && (await modelIds()).includes('gemini:gemini-3.8-flash'), J(await modelIds()));
  check('Lumen has no OpenAI key to use any more (the agent, voice input, pictures all ask providerKey)', (await app.evaluate(() => global.__agent.getKey('openai'))) === null && (await app.evaluate(() => global.__agent.getKey('gemini'))) === KEYS.gemini);
  await sleep(500);
  check('nothing is sent with the off key (the model lists were refreshed without it)', !seen.slice(before).some((r) => r.key === KEYS.openai) && seen.slice(before).some((r) => r.key === KEYS.gemini), J(seen.slice(before)));
  check('the model menu in the sidebar follows too', await waitFor(async () => { await ui.evaluate(() => document.getElementById('toggle-sidebar')?.click()); await sleep(300); const v = await ui.$$eval('#model option', (os2) => os2.map((o) => o.value)); await ui.evaluate(() => document.getElementById('toggle-sidebar')?.click()); return !v.some((x) => x.startsWith('openai:')) && v.some((x) => x.startsWith('gemini:')); }, 6000));

  // ---- "Make pictures with": OpenAI picked while its key is off -> Gemini makes it, named
  await app.evaluate((_e, png) => {
    global.__imgCalls = [];
    global.__agent.imageBackendOverrides = {
      openai: async () => { global.__imgCalls.push('openai'); return { images: [{ data: png }], model: 'gpt-image-1' }; },
      gemini: async () => { global.__imgCalls.push('gemini'); return { images: [{ data: png }], model: 'gemini-2.5-flash-image' }; },
    };
  }, PNG);
  const pickImage = async (v) => { await inSettings(`(() => { const s = document.getElementById('pref-imageGen'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await waitFor(() => settingsFile().imageGen === v); };
  await waitFor(() => inSettings("Boolean(document.getElementById('pref-imageGen'))"));
  const optionText = await inSettings("JSON.stringify([...document.getElementById('pref-imageGen').options].map((o) => [o.value, o.textContent]))");
  check('"Make pictures with" lists the engines and marks the ones not set up (no key, or its key off)', /\["openai","OpenAI \(not set up\)"\]/.test(optionText) && /\["gemini","Gemini"\]/.test(optionText) && /\["xai","Grok \(API key\) \(not set up\)"\]/.test(optionText) && /\["auto","Automatic"\]/.test(optionText), optionText);
  await pickImage('openai');
  const route = () => app.evaluate(async () => { global.__imgCalls = []; const r = await global.__agent.routeImage({ prompt: 'a lighthouse', current: 'claude-sonnet-5', signal: new AbortController().signal }); return { provider: r.provider, credit: r.credit, insteadOf: r.insteadOf || null, calls: global.__imgCalls }; });
  let made = await route();
  check('OpenAI picked but its key is off: Gemini makes the picture, and the picture says instead of whom', made.provider === 'gemini' && J(made.calls) === J(['gemini']) && made.credit === 'Gemini · gemini-2.5-flash-image (instead of OpenAI: not set up)', J(made));

  // ---- switch OpenAI back on: no retyping
  await waitFor(() => inSettings("Boolean(document.querySelector('[data-provider=openai] .key-switch'))"));
  await inSettings("document.querySelector('[data-provider=openai] .key-switch').click()");
  await waitFor(async () => (await inSettings("document.querySelector('[data-provider=openai] .key-state')?.textContent")) === 'Saved');
  check('switched back on: Saved, nothing retyped', (await inSettings("document.querySelector('[data-provider=openai] .key-state')?.textContent")) === 'Saved' && J(settingsFile().keysOff) === '[]' && (await app.evaluate(() => global.__agent.getKey('openai'))) === KEYS.openai);
  await waitFor(async () => (await modelIds()).includes('openai:gpt-5.6'));
  check('its models are back in the model menu', (await modelIds()).includes('openai:gpt-5.6'), J(await modelIds()));
  made = await route();
  check('and "Make pictures with: OpenAI" now goes to OpenAI, and only OpenAI', made.provider === 'openai' && J(made.calls) === J(['openai']) && !made.insteadOf && made.credit === 'OpenAI · gpt-image-1', J(made));
  await app.evaluate(() => { global.__agent.imageBackendOverrides.openai = async () => { global.__imgCalls.push('openai'); throw Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details'), { status: 429 }); }; });
  made = await route();
  check('the picked provider out of usage: the next connected one makes it, named', made.provider === 'gemini' && J(made.calls) === J(['openai', 'gemini']) && /instead of OpenAI/.test(made.credit), J(made));

  // ---- the Anthropic key switches too (the env key here): saved as off, and its row says so
  await inSettings("document.querySelector('[data-provider=anthropic] .key-switch').click()");
  await waitFor(async () => (await inSettings("document.querySelector('[data-provider=anthropic] .key-state')?.textContent")) === 'Off');
  check('the Anthropic key (from the environment) can be switched off too', J(settingsFile().keysOff) === J(['anthropic']) && (await ui.evaluate(async () => (await window.assistant.getSettings()).anthropicKeyOff)) === true, J(settingsFile().keysOff));
  await inSettings("document.querySelector('[data-provider=anthropic] .key-switch').click()");
  await waitFor(async () => (await inSettings("document.querySelector('[data-provider=anthropic] .key-state')?.textContent")) === 'From environment');
  check('and back on', J(settingsFile().keysOff) === '[]' && (await modelIds()).some((id) => id.startsWith('claude-')), J({ off: settingsFile().keysOff }));

  check('no page errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
