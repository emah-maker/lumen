// Settings → AI → AI providers, and the per-provider sections of Settings → Usage. Loaded before settings.js and called from
// it; it uses that file's h(), row(), stackRow(), toggle(), meterRow(), tokens(), dollars(), tr(), save(), usageChip() and st.
// One block per AI in the same order and layout, so a setting or a number is found in the same place for every one of them:
//   Claude Code, Grok Build, Codex CLI, Antigravity (command-line AIs: version, path, signed in as, menu, full access, effort, Auto, usage)
//   Claude (API key), OpenAI, Grok (API key), Gemini, OpenRouter (key state, effort, Auto, usage)
// Usage numbers come from features/usage.js summary(): plan windows where the provider publishes them, rate-limit headers where its
// API sends them, and always what Lumen counted itself. A provider with nothing real to show says so; no number is made up.

const PROVIDER_ORDER = ['claudecode', 'grokbuild', 'codex', 'antigravity', 'anthropic', 'openai', 'xai', 'gemini', 'openrouter'];
const PROVIDER_CLI = { claudecode: true, grokbuild: true, codex: true, antigravity: true };
// Which pref turns each CLI's model-menu entry on or off (Codex and Antigravity already had one), and what it is when never set.
const MENU_PREF = { claudecode: ['claudeCodeSidebar', true], grokbuild: ['grokSidebar', false], codex: ['codexSidebar', true], antigravity: ['antigravitySidebar', false] };
const FULL_ACCESS_PREF = { claudecode: 'claudeCodeFullAccess', grokbuild: 'grokBuildFullAccess', antigravity: 'antigravityFullAccess' };
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
  if (!t || !t.week.turns) return [row(`${providerName(key)}: what Lumen counted`, 'Nothing in the last 7 days.')];
  const rows = [];
  rows.push(row('Last used', `${clock(t.lastAt)}${t.lastModel ? ` · ${t.lastModel}` : ''}`));
  rows.push(row(`${providerName(key)}: what Lumen counted`, `${countLine('Today', t.today)}. ${countLine('Last 7 days', t.week)}. Lumen’s own use only, not what is left of a plan.`));
  const days = h('div', { class: 'list', id: `usage-days-${key}` }, t.days.filter((d) => d.turns).map((d) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: new Date(d.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) }),
    h('span', { class: 'note', text: `${d.turns} turn${d.turns === 1 ? '' : 's'} · ${tokens(d.tokens)} tokens${d.costUSD > 0 ? ` · ≈${dollars(d.costUSD)}` : ''}` }))));
  rows.push(stackRow('Per day', null, days));
  const models = h('div', { class: 'list', id: `usage-models-${key}` }, t.models.map((m) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: m.model || 'Unknown model' }),
    h('span', { class: 'note', text: `${m.turns} turn${m.turns === 1 ? '' : 's'} · ${tokens(m.tokens)} tokens${m.costUSD > 0 ? ` · ≈${dollars(m.costUSD)}` : ''}` }))));
  rows.push(stackRow('Per model', null, models));
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
    rows.push(meterRow(`${providerName(key)} ${p.kind === 'daily' ? 'daily' : 'weekly'} budget`, p.percent, `${fmt(p.used)} of ${fmt(p.limit)} · resets ${clock(p.resetsAt)}`));
  }
  const unit = h('select', { id: `${idp}-unit`, 'aria-label': `${providerName(key)} budget unit` }, h('option', { value: 'usd', text: 'Dollars (API prices)' }), h('option', { value: 'tokens', text: 'Tokens' }));
  unit.value = cfg.unit;
  const amount = (id, label, value) => h('input', { type: 'number', id, min: '0', step: 'any', placeholder: 'None', 'aria-label': label, value: value ? String(value) : '' });
  const daily = amount(`${idp}-daily`, `${providerName(key)} daily budget`, cfg.daily);
  const weekly = amount(`${idp}-weekly`, `${providerName(key)} weekly budget`, cfg.weekly);
  rows.push(stackRow(`${providerName(key)} budget (optional)`, 'An alert, not a limit: Lumen tells you at 80% and 100% of what it counted for this AI, shows a bar toward it, and never blocks anything. A day ends at midnight, a week on Monday. Leave both empty for none.',
    h('div', { class: 'controls' }, unit, h('label', { class: 'note', text: 'Daily' }), daily, h('label', { class: 'note', text: 'Weekly' }), weekly,
      h('button', { id: `${idp}-save`, text: 'Save budget', onclick: async () => { await S.setUsageBudget({ unit: unit.value, daily: daily.value, weekly: weekly.value, ...(key === 'grokbuild' ? {} : { engine: key }) }); refresh(); } }))));
  return rows;
}

// An API provider's per-minute rate limits, read from the headers of replies Lumen already had (no request of its own).
function usageRateRows(key, u) {
  const v = u.rate?.[key];
  if (!v) return [row(`${providerName(key)} rate limits`, key === 'gemini' ? 'Gemini’s endpoint sends no rate-limit headers, so there is nothing to show.' : 'None seen yet. They are read from the headers of a reply, so they appear after your next message with this AI.')];
  const rows = v.buckets.map((b) => (b.expired
    ? row(b.label, 'Reset since the last reply; the next one shows the new reading.')
    : meterRow(b.label, b.percent, `${Math.round(b.remaining).toLocaleString()} of ${Math.round(b.limit).toLocaleString()} left${b.resetsAt ? ` · resets ${new Date(b.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : ''}`)));
  rows.push(row('', `As of ${clock(v.at)}, from the last reply. These are the API’s per-minute limits, not a plan balance.`));
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
  if (lim) out.push(row('Antigravity limit reached', `${lim.resetsAt ? `Resets ${clock(lim.resetsAt)}` : 'No reset time was given'}${lim.model ? ` (${lim.model})` : ''}. ${lim.text || ''} This clears after your next Antigravity reply that works.`.trim()));
  out.push(...usageCountRows('antigravity', u), ...usageBudgetRows('antigravity', u, refresh));
  for (const key of ['anthropic', 'openai', 'xai', 'gemini', 'openrouter']) {
    out.push(heading(key, u.notes?.[key]), ...usageRateRows(key, u), ...usageCountRows(key, u), ...usageBudgetRows(key, u, refresh));
  }
  return out;
}

// ---------- Settings → AI → AI providers ----------

function providerInfoText(i) {
  if (!i.installed) return 'Not installed';
  const signed = i.signedIn === true ? `signed in${i.account ? ` as ${i.account}` : ''}` : i.signedIn === false ? 'not signed in' : 'sign-in unknown until a message runs';
  return ['Installed', i.version ? `version ${i.version}` : null, signed, i.offered ? 'in the model menu' : 'not in the model menu'].filter(Boolean).join(' · ');
}

async function buildProviders(page) {
  const ai = await S.ai.get();
  const info = Object.fromEntries((await S.cliInfo().catch(() => [])).map((i) => [i.id, i]));
  const autoKeys = new Set((ai.autoProviders || []).map((p) => p.key));
  const keys = { anthropic: { stored: ai.hasStoredKey, env: ai.hasEnvKey }, ...ai.providerKeys };
  const rowsFor = (key) => {
    const out = [];
    if (PROVIDER_CLI[key]) {
      const i = info[key] || { installed: false };
      const state = h('span', { class: `note${i.installed && i.signedIn === false ? ' err' : ''}`, id: `provider-state-${key}`, text: providerInfoText(i), title: i.path || '' });
      out.push(row('Status', i.path ? `Found at ${i.path}` : 'Where Lumen looks is listed under Connect an AI agent.', state));
      const [pref, fallback] = MENU_PREF[key];
      out.push(toggle(pref, tr('settings.ai.offerMenu', 'Offer in the model menu'), `Shows ${providerName(key)} and its models in every model picker. Off hides it without uninstalling or signing out.`, undefined, { id: `provider-menu-${key}`, fallback }));
      if (FULL_ACCESS_PREF[key]) out.push(toggle(FULL_ACCESS_PREF[key], 'Full access to this computer', `${providerName(key)} works as in your terminal: its own shell and file tools run without asking. The same switch as under Full access (advanced). Off by default.`, () => { if (typeof syncCliAccess === 'function') syncCliAccess(); }, { id: `provider-full-${key}` }));
      else out.push(row('Full access', 'Codex runs read-only with no shell or file tools, by design: it has no full-access mode here.'));
    } else {
      const k = keys[key] || {};
      const state = k.stored ? 'Key saved' : k.env ? 'Key from the environment' : 'No key';
      out.push(row('Connection', 'Add or change the key under API keys and sign-ins.', h('span', { class: `note key-state${k.stored || k.env ? ' set' : ''}`, id: `provider-state-${key}`, text: state })));
    }
    const picker = h('select', { id: `provider-effort-${key}`, 'aria-label': `${providerName(key)} reasoning effort` },
      h('option', { value: '', text: 'Default' }), ...EFFORT_LEVELS[key].map((l) => h('option', { value: l, text: EFFORT_NAMES[l] })));
    picker.value = (st.prefs.aiEffort || {})[key] || '';
    picker.addEventListener('change', async () => { const next = { ...(st.prefs.aiEffort || {}) }; if (picker.value) next[key] = picker.value; else delete next[key]; await save('aiEffort', next); });
    window.addEventListener('lumen-pref', (e) => { if (e.detail.key === 'aiEffort') picker.value = (st.prefs.aiEffort || {})[key] || ''; });
    out.push(row('Reasoning effort', EFFORT_NOTES[key], picker));
    if (autoKeys.has(key)) {
      const box = h('input', { type: 'checkbox', class: 'switch', id: `provider-auto-${key}`, role: 'switch', 'aria-label': `Auto may use ${providerName(key)}` });
      const sync = () => { box.checked = !(st.prefs.autoExclude || []).includes(key); };
      sync();
      window.addEventListener('lumen-pref', (e) => { if (e.detail.key === 'autoExclude') sync(); });
      box.addEventListener('change', async () => { const next = new Set(st.prefs.autoExclude || []); if (box.checked) next.delete(key); else next.add(key); await save('autoExclude', [...next]); });
      out.push(row('Auto may use it', 'When you choose Auto in the model menu, Lumen may pick this AI for a message.', box));
    }
    out.push(row('Usage', 'Plan or rate limits where the provider publishes them, and what Lumen counted. Usage has the days, the models and a budget.', usageChip(key), h('button', { text: 'Open Usage', onclick: () => { location.hash = '#usage'; } })));
    return out;
  };
  for (const key of PROVIDER_ORDER) {
    page.group(providerName(key));
    page.append(...rowsFor(key));
  }
}
