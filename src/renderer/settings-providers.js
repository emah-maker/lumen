// Settings → AI → AI providers, and the per-provider sections of Settings → Usage. Loaded before settings.js and called from
// it; it uses that file's h(), row(), stackRow(), toggle(), meterRow(), flash(), tokens(), dollars(), tr(), save(), usageChip() and st.
// One block per AI in the same order and layout, so a setting or a number is found in the same place for every one of them:
//   Claude Code, Grok Build, Codex CLI, Antigravity (command-line AIs: version, path, signed in as, menu, full access, effort, Auto, usage)
//   Claude (API key), OpenAI, Grok (API key), Gemini, OpenRouter (key state, effort, Auto, usage)
// Usage numbers come from features/usage.js summary(): plan windows where the provider publishes them, rate-limit headers where its
// API sends them, and always what Lumen counted itself. A provider with nothing real to show says so; no number is made up.

const PROVIDER_ORDER = ['claudecode', 'grokbuild', 'codex', 'antigravity', 'anthropic', 'openai', 'xai', 'gemini', 'openrouter', 'local'];
const PROVIDER_CLI = { claudecode: true, grokbuild: true, codex: true, antigravity: true };
// Which pref turns each CLI's model-menu entry on or off (Codex and Antigravity already had one), and what it is when never set.
const MENU_PREF = { claudecode: ['claudeCodeSidebar', true], grokbuild: ['grokSidebar', false], codex: ['codexSidebar', true], antigravity: ['antigravitySidebar', false] };
const FULL_ACCESS_PREF = { claudecode: 'claudeCodeFullAccess', grokbuild: 'grokBuildFullAccess', antigravity: 'antigravityFullAccess', codex: 'codexFullAccess' };
// ai/effort.js LEVELS (the page cannot require node modules), and what each takes.
const EFFORT_LEVELS = {
  claudecode: ['low', 'medium', 'high', 'xhigh', 'max'], grokbuild: ['low', 'medium', 'high'], antigravity: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh', 'max'],
  anthropic: ['low', 'medium', 'high'], openai: ['minimal', 'low', 'medium', 'high'], xai: ['low', 'high'], gemini: ['low', 'medium', 'high'], openrouter: ['low', 'medium', 'high'],
};
const EFFORT_NAMES = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
const EFFORT_NOTES = {
  claudecode: 'Passed to Claude Code as --effort. Lower is faster and uses less of your plan; higher thinks longer.',
  grokbuild: 'Passed to Grok Build as --reasoning-effort, for models that reason. With an effort chosen, “Keep Grok Build connected” is not used (a kept process keeps the effort it started with).',
  codex: 'Passed to Codex as model_reasoning_effort. “codex debug models” lists the levels each model takes; Codex reports its own error for one it doesn’t.',
  antigravity: 'Passed to Antigravity as --effort.',
  anthropic: 'Sent as the request’s effort, for the models Lumen already gives one (Opus 5.5). Other models are not changed.',
  openai: 'Sent as reasoning_effort, for reasoning models (o-series and GPT-5). Other models are not changed.',
  xai: 'Sent as reasoning_effort. Only Grok 3 Mini takes it; other Grok models are not changed.',
  gemini: 'Sent as reasoning_effort (the thinking level), for Gemini 2.5 and newer. Other models are not changed.',
  openrouter: 'Sent as the unified reasoning effort. A model that doesn’t reason ignores it.',
};
const providerName = (key) => ENGINE_NAMES[key] || key;
const clock = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const countLine = (label, w) => `${label}: ${w.turns} turn${w.turns === 1 ? '' : 's'} · ${tokens(w.tokens)} tokens${w.costUSD > 0 ? ` · ≈${dollars(w.costUSD)} at API prices${w.unpriced ? ' (some turns have no known price)' : ''}` : w.turns && w.unpriced === w.turns ? ' · no price known' : ''}`;
const heading = (key, sub) => { const r = row(providerName(key), sub); r.classList.add('usage-head'); r.dataset.provider = key; return r; };

// ---------- Settings → Usage ----------

// What Lumen counted for one provider, the same rows for each: last used, today and 7 days, per day, per model.
function usageCountRows(key, u) {
  const t = u.providers?.[key];
  if (!t || !t.week.turns) return [row(tr('settings.row.whatLumenCounted', `{providerName}: what Lumen counted`, { providerName: providerName(key) }), tr('settings.row.nothingInTheLast', 'Nothing in the last 7 days.'))];
  const rows = [];
  rows.push(row(tr('settings.row.lastUsed', 'Last used'), `${clock(t.lastAt)}${t.lastModel ? ` · ${t.lastModel}` : ''}`));
  rows.push(row(tr('settings.row.whatLumenCounted', `{providerName}: what Lumen counted`, { providerName: providerName(key) }), tr('settings.row.lumenSOwnUse', `{countLine}. {countLine2}. Lumen’s own use only, not what is left of a plan.`, { countLine: countLine('Today', t.today), countLine2: countLine('Last 7 days', t.week) })));
  const days = h('div', { class: 'list', id: `usage-days-${key}` }, t.days.filter((d) => d.turns).map((d) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: new Date(d.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) }),
    h('span', { class: 'note', text: `${d.turns} turn${d.turns === 1 ? '' : 's'} · ${tokens(d.tokens)} tokens${d.costUSD > 0 ? ` · ≈${dollars(d.costUSD)}` : ''}` }))));
  rows.push(stackRow(tr('settings.row.perDay', 'Per day'), null, days));
  const models = h('div', { class: 'list', id: `usage-models-${key}` }, t.models.map((m) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: m.model || 'Unknown model' }),
    h('span', { class: 'note', text: `${m.turns} turn${m.turns === 1 ? '' : 's'} · ${tokens(m.tokens)} tokens${m.costUSD > 0 ? ` · ≈${dollars(m.costUSD)}` : ''}` }))));
  rows.push(stackRow(tr('settings.row.perModel', 'Per model'), null, models));
  return rows;
}

// A budget the user sets for one provider (Lumen's own use; never blocks). Grok's keeps its original control ids.
function usageBudgetRows(key, u, refresh) {
  const b = key === 'grokbuild' ? u.grok?.budget : u.budgets?.[key];
  const cfg = b?.config || { unit: 'usd', daily: 0, weekly: 0 };
  const idp = key === 'grokbuild' ? 'usage-budget' : `usage-budget-${key}`;
  const rows = [];
  for (const p of b?.status?.periods || []) {
    const fmt = b.status.unit === 'tokens' ? (n) => `${tokens(Math.round(n))} tokens` : dollars;
    rows.push(meterRow(p.kind === 'daily' ? tr('settings.row.providerDailyBudget', '{name} daily budget', { name: providerName(key) }) : tr('settings.row.providerWeeklyBudget', '{name} weekly budget', { name: providerName(key) }), p.percent, tr('settings.row.usedOfResets', '{used} of {limit} · resets {when}', { used: fmt(p.used), limit: fmt(p.limit), when: clock(p.resetsAt) })));
  }
  const unit = h('select', { id: `${idp}-unit`, 'aria-label': `${providerName(key)} budget unit` }, h('option', { value: 'usd', text: 'Dollars (API prices)' }), h('option', { value: 'tokens', text: 'Tokens' }));
  unit.value = cfg.unit;
  const amount = (id, label, value) => h('input', { type: 'number', id, min: '0', step: 'any', placeholder: 'None', 'aria-label': label, value: value ? String(value) : '' });
  const daily = amount(`${idp}-daily`, `${providerName(key)} daily budget`, cfg.daily);
  const weekly = amount(`${idp}-weekly`, `${providerName(key)} weekly budget`, cfg.weekly);
  rows.push(stackRow(tr('settings.row.budgetOptional', `{providerName} budget (optional)`, { providerName: providerName(key) }), tr('settings.row.anAlertNotA', 'An alert, not a limit: Lumen tells you at 80% and 100% of what it counted for this AI, shows a bar toward it, and never blocks anything. A day ends at midnight, a week on Monday. Leave both empty for none.'),
    h('div', { class: 'controls' }, unit, h('label', { class: 'note', text: 'Daily' }), daily, h('label', { class: 'note', text: 'Weekly' }), weekly,
      h('button', { id: `${idp}-save`, text: 'Save budget', onclick: async () => { await S.setUsageBudget({ unit: unit.value, daily: daily.value, weekly: weekly.value, ...(key === 'grokbuild' ? {} : { engine: key }) }); refresh(); } }))));
  return rows;
}

// An API provider's per-minute rate limits, read from the headers of replies Lumen already had (no request of its own).
function usageRateRows(key, u) {
  const v = u.rate?.[key];
  if (!v) return [row(tr('settings.row.rateLimits', `{providerName} rate limits`, { providerName: providerName(key) }), key === 'gemini' ? 'Gemini’s endpoint sends no rate-limit headers, so there is nothing to show.' : 'None seen yet. They are read from the headers of a reply, so they appear after your next message with this AI.')];
  const rows = v.buckets.map((b) => (b.expired
    ? row(b.label, tr('settings.row.resetSinceTheLast2', 'Reset since the last reply; the next one shows the new reading.'))
    : meterRow(b.label, b.percent, tr('settings.row.remainingOfLeft', '{remaining} of {limit} left{reset}', { remaining: Math.round(b.remaining).toLocaleString(), limit: Math.round(b.limit).toLocaleString(), reset: b.resetsAt ? tr('settings.row.resetSuffix', ' · resets {time}', { time: new Date(b.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) }) : '' }))));
  rows.push(row('', tr('settings.row.asOfFromThe', `As of {clock}, from the last reply. These are the API’s per-minute limits, not a plan balance.`, { clock: clock(v.at) })));
  return rows;
}

// All the sections below Claude Code's (whose plan windows stay at the top of the page, as before). Grok Build and Codex keep their own plan rows.
function providerUsageRows(u, refresh) {
  const out = [];
  out.push(heading('claudecode', 'Plan windows are above. Below: what Lumen counted.'), ...usageCountRows('claudecode', u), ...usageBudgetRows('claudecode', u, refresh));
  // Grok Build and Codex keep their own first row (what the numbers are and are not); it becomes the section's heading.
  const headOf = (rows, key) => { if (rows[0]) { rows[0].classList.add('usage-head'); rows[0].dataset.provider = key; } return rows; };
  out.push(...headOf(grokUsageRows(u, refresh), 'grokbuild'), ...usageCountRows('grokbuild', u));
  out.push(...headOf(codexUsageRows(u), 'codex'), ...usageCountRows('codex', u), ...usageBudgetRows('codex', u, refresh));
  // Antigravity: no plan numbers; the quota message with its reset time when a run hit it.
  const lim = u.limits?.antigravity;
  out.push(heading('antigravity', u.notes?.antigravity));
  if (lim) out.push(row(tr('settings.row.antigravityLimitReached', 'Antigravity limit reached'), `${lim.resetsAt ? `Resets ${clock(lim.resetsAt)}` : 'No reset time was given'}${lim.model ? ` (${lim.model})` : ''}. ${lim.text || ''} This clears after your next Antigravity reply that works.`.trim()));
  out.push(...usageCountRows('antigravity', u), ...usageBudgetRows('antigravity', u, refresh));
  for (const key of ['anthropic', 'openai', 'xai', 'gemini', 'openrouter']) {
    out.push(heading(key, u.notes?.[key]), ...usageRateRows(key, u), ...usageCountRows(key, u), ...usageBudgetRows(key, u, refresh));
  }
  return out;
}

// ---------- Settings → AI → AI providers → Local (Ollama / LM Studio) ----------
// The switch, the server and its address, Detect, and the installed models with what each can do. The address and models are kept
// by main.js (settings.localAI, ai/local-models.js); an address that isn't on this computer asks once before it is used.
async function localRows() {
  const L = S.ai.local;
  let state = await L.get();
  const flavor = h('select', { id: 'local-flavor', 'aria-label': tr('settings.local.server', 'Server') }, h('option', { value: 'ollama', text: 'Ollama' }), h('option', { value: 'lmstudio', text: 'LM Studio' }));
  const url = h('input', { type: 'text', id: 'local-url', class: 'grow', autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('settings.local.address', 'Server address') });
  const sw = h('input', { type: 'checkbox', class: 'switch', id: 'local-enabled', role: 'switch', 'aria-label': tr('settings.local.use', 'Use local models') });
  const note = h('span', { class: 'note', id: 'local-status', role: 'status' });
  const ask = h('span', { id: 'local-confirm-box' });
  const list = h('div', { class: 'list', id: 'local-models' });
  const toolsText = (m) => (m.tools === true ? tr('settings.local.tools', 'Can use tools') : m.tools === false ? tr('settings.local.chatOnly', 'Chat only') : tr('settings.local.toolsUnknown', 'Tools not known yet'));
  // LM Studio: every downloaded model with what LM Studio says about it (loaded or not, architecture, quantization, context),
  // Load / Unload, and Test speed, which shows the stats LM Studio returns with a short reply.
  let lms = null; // [{ id, loaded, arch, quant, format, context, tools, type }] from LM Studio, or null (not LM Studio, or it didn't answer)
  const bench = new Map(); // model id -> its last Test speed stats
  const busy = new Set(); // model ids with a load, unload or test running
  const kTokens = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));
  const infoText = (m) => [m.loaded ? tr('settings.local.loaded', 'Loaded') : tr('settings.local.notLoaded', 'Not loaded'), m.arch, m.quant, m.format, m.context ? tr('settings.local.context', '{n} context', { n: kTokens(m.context) }) : null].filter(Boolean).join(' · ');
  const statsText = (s) => [
    s.tokensPerSecond != null ? tr('settings.local.tps', '{n} tokens/s', { n: s.tokensPerSecond.toFixed(1) }) : null,
    s.firstTokenSeconds != null ? tr('settings.local.ttft', 'first token in {n} s', { n: s.firstTokenSeconds.toFixed(2) }) : null,
    s.completionTokens != null && s.generationSeconds != null ? tr('settings.local.gen', '{n} tokens in {s} s', { n: s.completionTokens, s: s.generationSeconds.toFixed(2) }) : null,
    s.runtime ? `${s.runtime}${s.runtimeVersion ? ` ${s.runtimeVersion}` : ''}` : null,
  ].filter(Boolean).join(' · ');
  const lmsRefresh = async () => {
    if (state.flavor !== 'lmstudio') { lms = null; return; }
    const r = await L.lmsStatus().catch(() => null);
    lms = r?.ok ? r.models.filter((m) => !/embed/i.test(m.type || '')) : null;
  };
  const lmsAct = async (kind, id) => {
    busy.add(id);
    draw();
    flash(note, kind === 'load' ? tr('settings.local.loading', 'Loading {model}…', { model: id }) : kind === 'unload' ? tr('settings.local.unloading', 'Unloading {model}…', { model: id }) : tr('settings.local.testing', 'Testing {model}…', { model: id }), '');
    let r;
    try { r = await L[{ load: 'lmsLoad', unload: 'lmsUnload', bench: 'lmsBench' }[kind]](id); } catch (err) { r = { ok: false, error: String(err.message) }; }
    busy.delete(id);
    if (!r.ok) flash(note, r.error, 'err');
    else if (kind === 'bench') { bench.set(id, r.stats); flash(note, tr('settings.local.tested', '{model}: {stats}', { model: id, stats: statsText(r.stats) }), 'ok'); }
    else if (kind === 'load') flash(note, r.seconds != null ? tr('settings.local.loadedIn', 'Loaded {model} in {s} s.', { model: id, s: r.seconds.toFixed(1) }) : tr('settings.local.loadedDone', 'Loaded {model}.', { model: id }), 'ok');
    else flash(note, tr('settings.local.unloaded', 'Unloaded {model}.', { model: id }), 'ok');
    await lmsRefresh();
    draw();
  };
  const lmsItem = (m) => {
    const saved = state.models.find((x) => x.id === m.id);
    const tools = saved ? saved.tools : m.tools;
    const stats = bench.get(m.id);
    const wait = busy.has(m.id);
    return h('div', { class: 'item', 'data-model': m.id, 'data-loaded': String(m.loaded) },
      h('div', { class: 'grow' }, h('span', { text: m.id }), h('div', { class: 'note lms-info', text: infoText(m) }), ...(stats ? [h('div', { class: 'note lms-stats', text: statsText(stats) })] : [])),
      h('span', { class: 'note', text: toolsText({ tools }) }),
      h('button', { class: 'lms-load', text: m.loaded ? tr('settings.local.unload', 'Unload') : tr('settings.local.load', 'Load'), disabled: wait, onclick: () => lmsAct(m.loaded ? 'unload' : 'load', m.id) }),
      h('button', { class: 'lms-bench', text: tr('settings.local.test', 'Test speed'), title: tr('settings.local.testDesc', 'A short reply, to see how fast this model runs here. LM Studio loads it first if it isn’t loaded.'), disabled: wait, onclick: () => lmsAct('bench', m.id) }));
  };
  const draw = () => {
    flavor.value = state.flavor;
    url.value = state.url;
    url.placeholder = state.defaults[state.flavor];
    sw.checked = state.enabled;
    if (state.flavor === 'lmstudio' && lms && lms.length) { list.replaceChildren(...lms.map(lmsItem)); return; }
    list.replaceChildren(...(state.models.length
      ? state.models.map((m) => h('div', { class: 'item', 'data-model': m.id }, h('span', { class: 'grow', text: m.id }), h('span', { class: 'note', text: toolsText(m) })))
      : [h('span', { class: 'note', text: tr('settings.local.none', 'No models yet. Start the server, then press Detect.') })]));
  };
  const entered = () => ({ enabled: sw.checked, flavor: flavor.value, url: url.value.trim() });
  const run = async (kind, extra = {}) => {
    ask.replaceChildren();
    flash(note, kind === 'detect' ? tr('settings.local.looking', 'Looking for models…') : '', '');
    let r;
    try { r = await L[kind]({ ...entered(), ...extra }); } catch (err) { r = { ok: false, error: String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }; }
    if (r.needsConfirm) {
      flash(note, r.error, 'warn');
      ask.replaceChildren(h('button', { id: 'local-confirm', text: tr('settings.local.confirm', 'Use this address anyway'), onclick: () => run(kind, { confirmRemote: true }) }));
      return;
    }
    if (!r.ok) { flash(note, r.error, 'err'); return; }
    state = { ...state, enabled: r.enabled, flavor: r.flavor, url: r.url, confirmedHost: r.confirmedHost, models: r.models };
    draw();
    lmsRefresh().then(draw);
    flash(note, kind === 'detect' ? (r.note || tr('settings.local.found', 'Found {n} on {server}.', { n: r.models.length === 1 ? tr('settings.local.one', '1 model') : tr('settings.local.many', '{n} models', { n: r.models.length }), server: state.names[state.flavor] })) : tr('settings.local.saved', 'Saved.'), 'ok');
  };
  sw.addEventListener('change', () => run('save'));
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) run('save'); });
  url.addEventListener('change', () => run('save'));
  flavor.addEventListener('change', () => {
    const other = state.defaults[state.flavor];
    if (!url.value.trim() || url.value.trim() === other) url.value = state.defaults[flavor.value];
    state = { ...state, flavor: flavor.value };
    run('save');
  });
  draw();
  // Nothing set up yet: look for LM Studio or Ollama at their usual addresses and fill in the one that is running.
  // The switch stays as it is. Nothing found is not an error: the row keeps its "start the server" hint.
  (async () => {
    if (!state.models.length) {
      flash(note, tr('settings.local.autoLooking', 'Looking for LM Studio or Ollama on this computer…'), '');
      const r = await L.auto().catch(() => null);
      if (r?.ok && !r.skipped) {
        state = { ...state, flavor: r.flavor, url: r.url, confirmedHost: r.confirmedHost, models: r.models };
        flash(note, r.note || tr('settings.local.autoFound', 'Found {server} with {n}. Turn on Use local models to chat with them.', { server: state.names[r.flavor], n: r.models.length === 1 ? tr('settings.local.one', '1 model') : tr('settings.local.many', '{n} models', { n: r.models.length }) }), 'ok');
      } else flash(note, '', '');
    }
    await lmsRefresh();
    draw();
  })();
  const detect = h('button', { id: 'local-detect', text: tr('settings.local.detect', 'Detect'), onclick: () => run('detect') });
  return [
    row(tr('settings.local.use', 'Use local models'), tr('settings.local.useDesc', 'Chat with models that run on this computer through Ollama or LM Studio. No key, and nothing leaves this computer.'), sw),
    row(tr('settings.local.server', 'Server'), tr('settings.local.serverDesc', 'The program that runs your models.'), flavor),
    row(tr('settings.local.address', 'Server address'), tr('settings.local.addressDesc', 'Ollama is usually http://127.0.0.1:11434 and LM Studio http://127.0.0.1:1234/v1. Only addresses on this computer work unless you confirm another.'), url, detect),
    stackRow(tr('settings.local.models', 'Installed models'), tr('settings.local.modelsDesc', 'Models that can use tools can click and type in your tabs. The others answer as plain chat: browser actions need a tool-capable model.'), list, h('div', { class: 'controls' }, note, ask)),
  ];
}

// ---------- Settings → AI → AI providers ----------

function providerInfoText(i) {
  if (!i.installed) return 'Not installed';
  const signed = i.signedIn === true ? `signed in${i.account ? ` as ${i.account}` : ''}` : i.signedIn === false ? 'not signed in' : 'sign-in not checked yet';
  return ['Installed', i.version ? `version ${i.version}` : null, signed, i.offered ? 'in the model menu' : 'not in the model menu'].filter(Boolean).join(' · ');
}

async function buildProviders(page) {
  const ai = await S.ai.get();
  // The CLI probes (version, sign-in) take most of a second: the rows are built without them and each Status row is filled in when they answer, so Settings search never waits for them.
  const probes = S.cliInfo().catch(() => []);
  const checking = new Map(); // CLI key -> [state span, Status row]
  const autoKeys = new Set((ai.autoProviders || []).map((p) => p.key));
  const keys = { anthropic: { stored: ai.hasStoredKey, env: ai.hasEnvKey }, ...ai.providerKeys };
  const rowsFor = (key) => {
    const out = [];
    if (PROVIDER_CLI[key]) {
      const state = h('span', { class: 'note', id: `provider-state-${key}`, text: tr('settings.ai.checking', 'Checking…') });
      // The state sits under the label and the path under it, on its own wrapped line (side by side they cut the path at "@anthropic-…"); the path is filled in with the state.
      const status = row(tr('settings.row.status', 'Status'), tr('settings.row.whereLumenLooksIs', 'Where Lumen looks is listed under Connect an AI agent.'));
      status.querySelector('.desc').classList.remove('clamp');
      status.querySelector('.desc').before(state);
      checking.set(key, [state, status]);
      out.push(status);
      const [pref, fallback] = MENU_PREF[key];
      out.push(toggle(pref, tr('settings.ai.offerMenu', 'Offer in the model menu'), tr('settings.row.showsAndItsModels', `Shows {providerName} and its models in every model picker. Off hides it without uninstalling or signing out.`, { providerName: providerName(key) }), undefined, { id: `provider-menu-${key}`, fallback }));
      if (FULL_ACCESS_PREF[key]) out.push(toggle(FULL_ACCESS_PREF[key], tr('settings.row.fullAccessToThis', 'Full access to this computer'), tr('settings.row.worksAsInYour', `{providerName} works as in your terminal: its own shell and file tools run without asking. The same switch as under Full access (advanced).`, { providerName: providerName(key) }), () => { if (typeof syncCliAccess === 'function') syncCliAccess(); }, { id: `provider-full-${key}` }));
    } else {
      const k = keys[key] || {};
      const state = k.stored ? 'Key saved' : k.env ? 'Key from the environment' : 'No key';
      out.push(row(tr('settings.row.connection', 'Connection'), tr('settings.row.addOrChangeThe', 'Add or change the key under API keys and sign-ins.'), h('span', { class: `note key-state${k.stored || k.env ? ' set' : ''}`, id: `provider-state-${key}`, text: state })));
    }
    const picker = h('select', { id: `provider-effort-${key}`, 'aria-label': `${providerName(key)} reasoning effort` },
      h('option', { value: '', text: 'Default' }), ...EFFORT_LEVELS[key].map((l) => h('option', { value: l, text: EFFORT_NAMES[l] })));
    picker.value = (st.prefs.aiEffort || {})[key] || '';
    picker.addEventListener('change', async () => { const next = { ...(st.prefs.aiEffort || {}) }; if (picker.value) next[key] = picker.value; else delete next[key]; await save('aiEffort', next); });
    window.addEventListener('lumen-pref', (e) => { if (e.detail.key === 'aiEffort') picker.value = (st.prefs.aiEffort || {})[key] || ''; });
    out.push(row(tr('settings.row.reasoningEffort', 'Reasoning effort'), EFFORT_NOTES[key], picker));
    if (autoKeys.has(key)) {
      const box = h('input', { type: 'checkbox', class: 'switch', id: `provider-auto-${key}`, role: 'switch', 'aria-label': `Auto may use ${providerName(key)}` });
      const sync = () => { box.checked = !(st.prefs.autoExclude || []).includes(key); };
      sync();
      window.addEventListener('lumen-pref', (e) => { if (e.detail.key === 'autoExclude') sync(); });
      box.addEventListener('change', async () => { const next = new Set(st.prefs.autoExclude || []); if (box.checked) next.delete(key); else next.add(key); await save('autoExclude', [...next]); });
      out.push(row(tr('settings.row.autoMayUseIt', 'Auto may use it'), tr('settings.row.whenYouChooseAuto', 'When you choose Auto in the model menu, Lumen may pick this AI for a message.'), box));
    }
    out.push(row(tr('settings.row.usage', 'Usage'), tr('settings.row.planOrRateLimits', 'Plan or rate limits where the provider publishes them, and what Lumen counted. Usage has the days, the models and a budget.'), usageChip(key), h('button', { text: 'Open Usage', onclick: () => { location.hash = '#usage'; } })));
    return out;
  };
  for (const key of PROVIDER_ORDER) {
    page.group(providerName(key));
    page.append(...(key === 'local' ? await localRows() : rowsFor(key)));
  }
  probes.then((list) => {
    const info = Object.fromEntries(list.map((i) => [i.id, i]));
    for (const [key, [state, statusRow]] of checking) {
      const i = info[key] || { installed: false };
      state.textContent = providerInfoText(i);
      state.title = i.path || '';
      state.classList.toggle('err', Boolean(i.installed && i.signedIn === false));
      const where = statusRow.querySelector('.desc');
      if (i.path) {
        where.replaceChildren('Found at ', h('span', { class: 'mono path' }, ...i.path.split(/(?<=[\\/])/).flatMap((seg, n) => (n ? [document.createElement('wbr'), seg] : [seg])))); // (a path breaks after a slash, never mid-name)
        statusRow.dataset.search = `status found at ${i.path}`.toLowerCase();
      }
    }
  });
}
