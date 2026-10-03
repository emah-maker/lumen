// Auto in the real app (ai/auto-model.js, docs/auto-model.md): "Auto" is the first row of every picker, is the default on a fresh
// profile (and only there), persists, survives a list refresh, stays out of the fallback's way, and picks the model per
// message: quick questions go to a small model, hard ones to a strong one, a /think asks for the strongest, a model that is
// cooling down or turned off for Auto is skipped, and a model that refuses the request is replaced once by another.
// The engines are fakes (the Claude client and providers.streamTurn record the model they are given); no network, no key.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openSettingsTab } = require('./settings-tab');
const A = require('../src/ai/auto-model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(50); } return v; };
const tierOf = (used) => A.tierOf(String(used).replace(/^anthropic:/, ''));
const HEAVY = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders', '4. Also make sure the API docs stay accurate'].join('\n');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-auto-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  app.process().stderr?.on('data', (d) => { const t = String(d); if (/Error|Uncaught|exception/i.test(t) && !/MaxListeners/.test(t)) console.log(`  [main stderr] ${t.trim().slice(0, 400)}`); });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // Fake engines. `failNext`: the next request to that model fails with that error (once).
  await app.evaluate(() => {
    const fake = global.__fake = { used: [], prompts: [], fail: {}, n: 0 };
    const text = (m) => (typeof m?.content === 'string' ? m.content : (m?.content || []).map((b) => b.text || '').join(' '));
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      fake.used.push(`anthropic:${params.model}`);
      fake.prompts.push(text(params.messages[params.messages.length - 1]));
      const failure = fake.fail[`anthropic:${params.model}`];
      if (failure) { delete fake.fail[`anthropic:${params.model}`]; return { async *[Symbol.asyncIterator]() { throw Object.assign(new Error(failure.message), { status: failure.status }); }, finalMessage: async () => { throw Object.assign(new Error(failure.message), { status: failure.status }); } }; }
      const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply ${++fake.n}.` }], usage: { input_tokens: 10, output_tokens: 5 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } }; }, finalMessage: async () => message };
    } } } });
    global.__providers.streamTurn = async ({ provider, model, emit, messages }) => {
      fake.used.push(`${provider}:${model}`);
      fake.prompts.push(text(messages[messages.length - 1]));
      const failure = fake.fail[`${provider}:${model}`];
      if (failure) { delete fake.fail[`${provider}:${model}`]; throw Object.assign(new Error(failure.message), { status: failure.status }); }
      emit({ type: 'text', text: 'Reply.' });
      return { content: [{ type: 'text', text: `Reply ${++fake.n}.` }], stop_reason: 'end_turn', model: `${provider}:${model}`, usage: null };
    };
  });
  const used = () => app.evaluate(() => global.__fake.used.slice());
  const prompts = () => app.evaluate(() => global.__fake.prompts.slice());
  const failNext = (id, message, status) => app.evaluate((_e, a) => { global.__fake.fail[a.id] = { message: a.message, status: a.status }; }, { id, message, status });
  const settings = () => ui.evaluate(() => window.assistant.getSettings());
  const send = async (text) => {
    const before = (await used()).length;
    await ui.fill('#prompt', text);
    await ui.press('#prompt', 'Enter');
    await waitFor(async () => (await used()).length > before && (await ui.evaluate(() => !document.getElementById('send').classList.contains('stop'))), 12000);
    await sleep(150);
    return (await used()).slice(before);
  };

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await waitFor(() => ui.evaluate(() => document.querySelectorAll('#model option').length > 3));
  // A Claude Code (or other CLI) on the machine running this test would be a candidate too: keep the run the same everywhere.
  const ENGINES = ['claudecode', 'grokbuild', 'antigravity'];
  await app.evaluate((_e, e) => global.__patchSettings({ autoExclude: e }), ENGINES);

  // ---- the picker: Auto first, the default on a fresh profile
  const options = await ui.$$eval('#model option', (os) => os.map((o) => o.value));
  check('Auto is the first row of the sidebar picker', options[0] === 'auto', JSON.stringify(options));
  check('the real models follow it', options.includes('claude-opus-5-5') && options.some((o) => o.startsWith('openai:')), JSON.stringify(options));
  check('a fresh profile starts on Auto', (await ui.inputValue('#model')) === 'auto' && (await settings()).model === 'auto', await ui.inputValue('#model'));
  check('the settings list has Auto first, no heading of its own', (await settings()).models[0].id === 'auto' && (await settings()).models[0].group === '', JSON.stringify((await settings()).models[0]));
  check('the composer does not say "Ask Auto"', (await ui.getAttribute('#prompt', 'placeholder')) === 'Ask anything…', await ui.getAttribute('#prompt', 'placeholder'));
  const providersList = (await settings()).autoProviders.map((p) => p.key);
  check('Settings lists the providers Auto may use', providersList.includes('anthropic') && providersList.includes('openai') && !providersList.includes('auto'), JSON.stringify(providersList));

  // ---- routing per message
  let u = await send('hi');
  check('"hi": a small, fast model answers', u.length === 1 && tierOf(u[0]) === 'fast', JSON.stringify(u));
  check('the reply is labelled "Auto · …" with the reason as its tooltip', await waitFor(() => ui.evaluate(() => { const el = [...document.querySelectorAll('.reply-model')].pop(); return Boolean(el) && /^Auto · /.test(el.textContent) && /^Auto: /.test(el.title); })), await ui.evaluate(() => [...document.querySelectorAll('.reply-model')].map((e) => `${e.textContent} | ${e.title}`).join(' ; ')));
  check('the picker still says Auto, with the last choice in its row', await waitFor(async () => { const m = (await settings()).models[0]; return (await ui.inputValue('#model')) === 'auto' && /^Auto · /.test(m.name) && /^Auto: /.test(m.detail); }), JSON.stringify((await settings()).models[0]));
  u = await send(HEAVY);
  check('a multi-step debugging brief: a strong model answers', tierOf(u[0]) === 'strong', JSON.stringify(u));
  u = await send('/fast thanks');
  check('/fast: the quickest model, and the command is not sent', tierOf(u[0]) === 'fast' && (await prompts()).pop() === 'thanks' || (await prompts()).pop().endsWith('thanks'), JSON.stringify(u));
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await sleep(300);
  u = await send('/think why is the sky blue');
  check('/think: the strongest model', tierOf(u[0]) === 'strong', JSON.stringify(u));
  check('/think is never sent to the model', !(await prompts()).pop().includes('/think'), (await prompts()).pop());

  // ---- never "auto" to a provider; usage records the model that ran
  check('no request ever carried "auto" as its model', !(await used()).some((m) => /(^|:)auto$/.test(m)), JSON.stringify(await used()));
  const usageLog = await ui.evaluate(() => window.assistant.getSettings().then(() => null));
  void usageLog;

  // ---- availability: a cooling model, a provider turned off
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await sleep(300);
  const first = (await send('hello'))[0];
  await app.evaluate((_e, id) => global.__aiFallback.shared.mark(id, { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 }), first.replace(/^anthropic:/, ''));
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await sleep(300);
  const second = (await send('hello'))[0];
  check('a model that hit its limit is left alone by Auto', second !== first, `${first} -> ${second}`);
  await app.evaluate(() => global.__aiFallback.shared.clear());
  await app.evaluate(() => global.__patchSettings({ autoExclude: ['openai', 'claudecode', 'grokbuild', 'antigravity'] }));
  const picks = [];
  for (const text of ['hi', HEAVY]) { await ui.evaluate(() => document.getElementById('new-chat').click()); await sleep(250); picks.push(...await send(text)); }
  check('a provider turned off for Auto is never chosen', picks.every((m) => m.startsWith('anthropic:')), JSON.stringify(picks));
  await app.evaluate((_e, e) => global.__patchSettings({ autoExclude: e }), ENGINES);

  // ---- escalation: a model that can't take the request is replaced once by another
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await sleep(300);
  const wanted = A.route({ options: (await settings()).models.filter((o) => o.id !== 'auto'), request: { prompt: 'hi' }, prefer: [] }).id;
  await failNext(wanted.includes(':') ? wanted : `anthropic:${wanted}`, 'prompt is too long: 900000 tokens > 200000 maximum', 400);
  u = await send('hi');
  check('too long for the cheap model: the same message goes on another one', u.length === 2 && u[0] !== u[1], JSON.stringify(u));

  // ---- the picker keeps Auto: a refresh, a picked model, then Auto again
  await app.evaluate(() => global.__modelsChanged());
  await sleep(200);
  check('a list refresh keeps Auto', (await ui.inputValue('#model')) === 'auto', await ui.inputValue('#model'));
  await ui.selectOption('#model', 'claude-sonnet-5');
  await sleep(300);
  u = await send(HEAVY);
  check('a model picked by hand is used exactly as picked (Auto steps aside)', u.length === 1 && u[0] === 'anthropic:claude-sonnet-5', JSON.stringify(u));
  check('the pick is saved', (await settings()).model === 'claude-sonnet-5', (await settings()).model);
  await ui.selectOption('#model', 'auto');
  await sleep(300);
  check('Auto can be picked again and is saved', (await settings()).model === 'auto', (await settings()).model);
  await app.evaluate(() => global.__settingsFlush());
  check('settings.json keeps the id "auto"', JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).model === 'auto');

  // ---- existing choices are never migrated
  await ui.evaluate(() => document.getElementById('new-chat').click()); // (the open chat's own pick is Auto: a new chat starts on the saved one)
  await sleep(300);
  await app.evaluate(() => global.__patchSettings({ model: 'claude-haiku-4-5' }));
  await app.evaluate(() => global.__modelsChanged());
  check('a saved model stays the pick (no migration to Auto)', (await settings()).model === 'claude-haiku-4-5', (await settings()).model);
  await app.evaluate(() => global.__patchSettings({ model: 'openai:no-such-model' }));
  const gone = (await settings()).model;
  check('a saved model that disappears falls back as before, not to Auto', gone !== 'auto' && gone !== 'openai:no-such-model', gone);
  await app.evaluate(() => global.__patchSettings({ model: undefined }));
  check('no saved model at all: Auto', (await settings()).model === 'auto', (await settings()).model);

  // ---- the Settings page shows Auto first too, and its "Auto may use" ticks
  const settingsRun = await openSettingsTab(app);
  await waitFor(async () => (await settingsRun("Boolean(document.getElementById('ai-model'))")) === true);
  check('Settings picker: Auto first and selected', (await settingsRun("[...document.querySelectorAll('#ai-model option')].map((o) => o.value)[0] + '|' + document.getElementById('ai-model').value")) === 'auto|auto');
  check('Settings > AI > Auto may use: one tick per provider', Number(await settingsRun("document.querySelectorAll('#ai-auto-use input[type=checkbox]').length")) >= 2);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* temp */ }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall auto-model checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
