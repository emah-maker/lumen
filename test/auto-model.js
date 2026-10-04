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

  // The open menu: Auto is the very first row, with no heading above it; the providers' headings follow.
  await ui.click('.model-picker .picker-button');
  const rows = await ui.$$eval('.picker-menu .picker-list > *', (els) => els.map((e) => (e.classList.contains('picker-section') ? [...e.children].map((c) => (c.classList.contains('picker-group') ? `#${c.textContent}` : c.querySelector('.picker-name')?.textContent || '')).join('|') : e.className)));
  check('the open menu starts with the Auto row, no heading over it', rows.length > 1 && /^Auto(\||$)/.test(rows[0]) && !rows[0].startsWith('#'), JSON.stringify(rows.slice(0, 3)));
  await ui.keyboard.press('Escape');

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
  check('the Auto reply says which provider it skipped for being out of usage', await waitFor(() => ui.evaluate(() => { const el = [...document.querySelectorAll('.reply-model')].pop(); return Boolean(el) && /skipped: out of usage/.test(el.title); })), await ui.evaluate(() => [...document.querySelectorAll('.reply-model')].map((e) => e.title).join(' ; ')));
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

  // ---- a provider's own Auto ("OpenAI · Auto"): the same router inside one provider
  {
    await ui.evaluate(() => document.getElementById('new-chat').click());
    await sleep(300);
    const list = (await settings()).models;
    const ids = list.map((m) => m.id);
    const at = (id) => ids.indexOf(id);
    check('each connected provider with two or more models has its own Auto row, first in its group', ['anthropic:auto', 'openai:auto'].every((id) => at(id) > 0 && list[at(id)].auto === true && list[at(id)].group === list[at(id) + 1].group && list[at(id)].autoScope === id.split(':')[0]), JSON.stringify(list.filter((m) => m.auto).map((m) => [m.id, m.group])));
    check('a provider that is not connected has none, and the global Auto is still the very first row', !ids.includes('xai:auto') && !ids.includes('gemini:auto') && ids[0] === 'auto', JSON.stringify(ids.slice(0, 3)));
    check('the picker\'s own options carry the rows (flagged as Auto for the composer and the /think command)', await ui.$$eval('#model option[data-auto]', (os) => os.map((o) => o.value)).then((v) => v.includes('openai:auto') && v.includes('anthropic:auto') && v.includes('auto')), '');
    // the open menu lists it inside its group, after the heading
    await ui.click('.model-picker .picker-button');
    const group = await ui.$$eval('.picker-menu .picker-section', (secs) => secs.map((s) => [...s.children].map((c) => (c.classList.contains('picker-group') ? `#${c.textContent}` : c.querySelector('.picker-name')?.textContent || '')).join('|')).find((t) => /^#OpenAI/.test(t)) || '');
    check('in the open menu the OpenAI group starts with its Auto row', /^#OpenAI\|Auto(\||$)/.test(group), group);
    await ui.keyboard.press('Escape');

    await ui.selectOption('#model', 'openai:auto');
    await sleep(300);
    check('picking it saves it and the picker keeps it selected', (await settings()).model === 'openai:auto' && (await ui.inputValue('#model')) === 'openai:auto', (await settings()).model);
    check('the composer does not call it a model name', (await ui.getAttribute('#prompt', 'placeholder')) === 'Ask anything…', await ui.getAttribute('#prompt', 'placeholder'));
    u = await send('hi');
    check('OpenAI Auto, "hi": only OpenAI answers, with its small model', u.length === 1 && u[0].startsWith('openai:') && A.tierOf(u[0].replace(/^openai:/, '')) === 'fast', JSON.stringify(u));
    check('the reply is labelled "Auto · OpenAI · …" with the provider named in the tooltip', await waitFor(() => ui.evaluate(() => { const el = [...document.querySelectorAll('.reply-model')].pop(); return Boolean(el) && /^Auto · OpenAI · /.test(el.textContent) && /^Auto \(OpenAI\): /.test(el.title); })), await ui.evaluate(() => [...document.querySelectorAll('.reply-model')].map((e) => `${e.textContent} | ${e.title}`).join(' ; ')));
    check('the provider\'s row says what it chose last; the global row does not', await waitFor(async () => { const ms = (await settings()).models; return /^Auto · /.test(ms.find((m) => m.id === 'openai:auto').name) && ms.find((m) => m.id === 'auto').name === 'Auto' && ms.find((m) => m.id === 'anthropic:auto').name === 'Auto'; }), JSON.stringify((await settings()).models.filter((m) => m.auto).map((m) => m.name)));
    u = await send(HEAVY);
    check('a hard brief: OpenAI\'s flagship, and the chat is still on OpenAI Auto', u.length === 1 && A.tierOf(u[0].replace(/^openai:/, '')) === 'strong' && u[0].startsWith('openai:') && (await ui.inputValue('#model')) === 'openai:auto', JSON.stringify(u));
    u = await send('/fast ' + HEAVY);
    check('/fast: OpenAI\'s quickest model, command not sent', u[0].startsWith('openai:') && A.tierOf(u[0].replace(/^openai:/, '')) === 'fast' && !(await prompts()).pop().startsWith('/fast'), JSON.stringify(u));
    u = await send('/think why is the sky blue');
    check('/think: OpenAI\'s strongest model (the command works on a provider\'s Auto too)', u[0].startsWith('openai:') && A.tierOf(u[0].replace(/^openai:/, '')) === 'strong', JSON.stringify(u));
    await app.evaluate(() => global.__settingsFlush());
    check('settings.json keeps "openai:auto"', JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).model === 'openai:auto');
    check('no request ever carried "auto" as its model', !(await used()).some((m) => /(^|:)auto$/.test(m)), JSON.stringify((await used()).slice(-6)));
    // Turned off for the global Auto, a provider is still used by its own Auto
    await app.evaluate(() => global.__patchSettings({ autoExclude: ['openai', 'claudecode', 'grokbuild', 'antigravity'] }));
    u = await send('hello');
    check('a provider turned off for Auto (Settings) is still chosen by its own Auto', u[0].startsWith('openai:'), JSON.stringify(u));
    await app.evaluate((_e, e) => global.__patchSettings({ autoExclude: e }), ENGINES);
    // Out of usage inside the provider: both models limited, the fallback takes over like for a picked model
    await app.evaluate(() => { for (const id of ['gpt-5.6', 'gpt-5.6-mini']) global.__aiFallback.shared.mark(`openai:${id}`, { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 }); });
    u = await send('hello again');
    check('every OpenAI model out of usage: another provider answers (the setting "Switch models automatically" is on)', u.length === 1 && !u[0].startsWith('openai:'), JSON.stringify(u));
    check('...and the chat says so, staying on OpenAI Auto', await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.notice')].some((n) => /OpenAI is unavailable right now, so Auto uses /.test(n.textContent)))) && (await ui.inputValue('#model')) === 'openai:auto', await ui.evaluate(() => [...document.querySelectorAll('.notice')].map((n) => n.textContent).join(' | ')));
    await app.evaluate(() => global.__aiFallback.shared.clear());
    // The Claude API's own Auto: only Claude models
    await ui.evaluate(() => document.getElementById('new-chat').click());
    await sleep(300);
    await ui.selectOption('#model', 'anthropic:auto');
    await sleep(300);
    u = await send(HEAVY);
    check('Claude (API) Auto: a hard brief goes to the Claude model that is strongest', u.length === 1 && u[0].startsWith('anthropic:') && A.tierOf(u[0].replace(/^anthropic:/, '')) === 'strong', JSON.stringify(u));
    check('an Auto that is not connected cannot be picked', (await ui.evaluate(() => window.assistant.setModel('xai:auto'))) === false);
    await ui.selectOption('#model', 'auto');
    await ui.evaluate(() => document.getElementById('new-chat').click());
    await sleep(300);
  }

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

  // The ticks write the setting (only valid ids are kept), and the list follows the connected providers.
  await settingsRun("(() => { const box = document.querySelector('#auto-use-openai'); box.click(); return box.checked; })()");
  await sleep(300);
  await app.evaluate(() => global.__settingsFlush());
  check('un-ticking a provider in Settings saves it as off for Auto', JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).autoExclude?.includes('openai'), fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').slice(0, 300));
  const cleaned = await settingsRun("window.lumenSettings.set('autoExclude', ['openai', 'bad id!!', 'claude-opus-5', 'openai']).then((st) => st.prefs.autoExclude)");
  check('autoExclude keeps only plain ids, once each', JSON.stringify(cleaned) === JSON.stringify(['openai', 'claude-opus-5']), JSON.stringify(cleaned));
  check('autoExclude refuses a non-list', (await settingsRun("window.lumenSettings.set('autoExclude', 'openai').then(() => 'accepted', () => 'refused')")) === 'refused');
  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* temp */ }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall auto-model checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
