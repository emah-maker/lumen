// Small usage bars: one shared formatter and one bar element for every place that helps you choose an AI by how
// much of its plan is left (the model pickers, the AI status card, Settings → AI). It reads the numbers Lumen
// already holds (features/usage.js summary(): the plan windows, Grok's budget and limit message, and the
// cooldowns of models that hit a limit) and never asks a network: the data is main's cached summary
// (usage:get with `cached`), re-read after a reply finishes and when a menu opens, at most every few seconds.
// No data for a provider (an API key has no plan window): no bar, never a made-up one.
//
//   describe(bar, opts)      one provider's bar -> { percent, level, out, text, windows, title, valuetext } | null
//   forModel(id, state, now) the same for a picker id ('claudecode:sonnet'), plus a model-only limit | null
//   forProvider(key, state)  for a provider heading
//   element(desc)            a <span class="ubar"> (role=progressbar; the percent is written beside it, so colour is never the only signal)
//   annotate(text, id)       text for a native <option> that cannot hold a bar: "Name · 82% used"
// The visual style is picker.css's .ubar rules (the design tokens of the page it sits in); `level` is
// 'ok' | 'warn' (from 80%) | 'high' (at 100%), the same levels as the sidebar meter (features/usage.js levelOf).
(function (root) {
'use strict';

const WARN_AT = 80;
const HIGH_AT = 100;
const levelOf = (percent) => (percent >= HIGH_AT ? 'high' : percent >= WARN_AT ? 'warn' : 'ok');
const clamp = (p) => Math.max(0, Math.min(100, p));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

const tr = (key, fallback, vars) => {
  let s = root.t ? root.t(key, vars) : key;
  if (!s || s === key) s = fallback;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : '')) : s;
};

const providerOf = (id) => {
  const m = /^([a-z][a-z0-9]*):/.exec(String(id || ''));
  return m ? m[1] : 'anthropic';
};

const clockOf = (ms, now) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
// "resets 8:09 PM" ("resets Mon 12:00 AM" on another day), from a time or from the CLI's own words; '' when unknown.
function resetText(w, now = Date.now()) {
  if (w && finite(w.resetsAt) && w.resetsAt > now) return tr('usage.resets', 'resets {time}', { time: clockOf(w.resetsAt, now) });
  if (w && typeof w.resetsText === 'string' && w.resetsText.trim()) return tr('usage.resets', 'resets {time}', { time: w.resetsText.trim() });
  return '';
}

// The windows a features/usage.js bar describes, each { key, label, percent, level, reset }. Only real plan windows, the
// limit-reached state and the budget the user set: a chat's context fill is not usage of a plan, so it has no window here.
function windowsOf(bar, now = Date.now()) {
  if (!bar || typeof bar !== 'object') return [];
  const out = [];
  const add = (key, label, percent, source) => {
    if (!finite(percent)) return;
    if (finite(source.resetsAt) && source.resetsAt <= now) return; // that window has reset since the reading: stale, so no number
    const p = clamp(percent);
    out.push({ key, label, percent: p, level: levelOf(p), reset: resetText(source, now), resetsAt: finite(source.resetsAt) ? source.resetsAt : null });
  };
  if (bar.kind === 'plan') {
    add('5h', tr('usage.bar.window.5h', '5-hour limit'), bar.percent, { resetsAt: bar.resetsAt, resetsText: bar.resetsText });
    if (bar.weekly) add('week', tr('usage.bar.window.week', 'weekly limit'), bar.weekly.percent, { resetsText: bar.weekly.resetsText, resetsAt: bar.weekly.resetsAt });
  } else if (bar.kind === 'limit') {
    add('limit', tr('usage.bar.window.limit', 'limit reached'), 100, { resetsAt: bar.resetsAt });
  } else if (bar.kind === 'budget') {
    add(bar.period === 'weekly' ? 'budget-week' : 'budget-day', tr(bar.period === 'weekly' ? 'usage.bar.window.budgetWeek' : 'usage.bar.window.budgetDay', bar.period === 'weekly' ? 'weekly budget' : 'daily budget'), bar.percent, { resetsAt: bar.resetsAt });
  }
  return out;
}

// A cooldown entry (ai/fallback.js snapshot) that keeps this provider (or model) out of use right now.
function coolingFor(cooling, provider, modelId, now) {
  const e = cooling && cooling[provider];
  if (!e || e.kind !== 'limit' || !(Number(e.until) > now)) return null;
  if (e.scope === 'model') {
    const bare = String(modelId || '').replace(/^[a-z][a-z0-9]*:/, '').toLowerCase();
    return bare && e.model && bare.includes(String(e.model).toLowerCase()) ? e : null;
  }
  return e;
}

// bar: features/usage.js barFor(); cooling: the cooldown entry for it, if any. Returns null with nothing real to show.
function describe(bar, { cooling = null, now = Date.now(), name = '' } = {}) {
  const windows = windowsOf(bar, now);
  const hold = cooling && Number(cooling.until) > now ? cooling : null;
  if (!windows.length && !hold) return null;
  const tight = windows.reduce((a, w) => (!a || w.percent > a.percent ? w : a), null);
  const out = Boolean(hold) || windows.some((w) => w.key === 'limit') || Boolean(tight && tight.percent >= HIGH_AT);
  const percent = out ? 100 : tight.percent;
  const level = out ? 'high' : tight.level;
  const rounded = Math.round(percent);
  const lines = windows.filter((w) => w.key !== 'limit').map((w) => `${w.label}: ${tr('usage.bar.used', '{percent}% used', { percent: Math.round(w.percent) })}${w.reset ? `, ${w.reset}` : ''}`);
  const when = hold ? resetText({ resetsAt: hold.until }, now) : (windows.find((w) => w.key === 'limit') || {}).reset || (tight && tight.percent >= HIGH_AT ? tight.reset : '');
  if (out) lines.unshift(`${tr('usage.bar.out.title', 'Out of usage')}${when ? `, ${when}` : ''}`);
  const text = out ? tr('usage.bar.out', 'out') : `${rounded}%`;
  const valuetext = out ? lines[0] : (lines.length === 1 ? lines[0] : lines.join('; '));
  return {
    percent, level, out, text, windows, resetsAt: hold ? hold.until : (tight && tight.resetsAt) || null,
    valuetext: name ? `${name}: ${valuetext}` : valuetext,
    title: lines.join('\n'),
  };
}

// state: { bars: { claudecode, grokbuild, codex }, cooling, showBars } (the cached summary)
const usable = (state) => Boolean(state && state.showBars !== false);
function forProvider(key, state, now = Date.now(), modelId = null) {
  if (!usable(state) || !key) return null;
  return describe(state.bars ? state.bars[key] : null, { cooling: coolingFor(state.cooling, key, modelId, now), now });
}
function forModel(id, state, now = Date.now()) {
  if (!id || id === 'auto' || String(id).endsWith(':__more')) return null;
  return forProvider(providerOf(id), state, now, id);
}

// Text for an option in a native <select>: it cannot hold a bar, so the number goes in its text.
function annotate(text, id, state = root.usageBars && root.usageBars.state(), now = Date.now()) {
  const d = forModel(id, state, now);
  if (!d) return text;
  return `${text} · ${d.out ? tr('usage.bar.out.option', 'out of usage') : tr('usage.bar.used', '{percent}% used', { percent: Math.round(d.percent) })}`;
}

function element(desc, { label = '' } = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'ubar';
  wrap.dataset.level = desc.level;
  if (desc.out) wrap.dataset.out = '1';
  wrap.setAttribute('role', 'progressbar');
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '100');
  wrap.setAttribute('aria-valuenow', String(Math.round(desc.percent)));
  wrap.setAttribute('aria-valuetext', desc.valuetext);
  wrap.setAttribute('aria-label', label || tr('usage.bar.label', 'Plan usage'));
  wrap.title = desc.title;
  const track = document.createElement('span');
  track.className = 'ubar-track';
  const fill = document.createElement('i');
  fill.style.width = `${Math.round(desc.percent)}%`; // through the CSSOM: a page's CSP may drop inline style attributes
  track.append(fill);
  const text = document.createElement('span');
  text.className = 'ubar-text';
  text.textContent = desc.text;
  wrap.append(track, text);
  return wrap;
}

// ---- the cached data (a page only; the formatter above also runs in node) ----
let state = null;
let lastAt = 0;
let inflight = null;
const source = () => {
  if (root.lumenExtras && root.lumenExtras.usage) return () => root.lumenExtras.usage(false, true);
  if (root.lumenSettings && root.lumenSettings.usage) return () => root.lumenSettings.usage({ cached: true });
  return null;
};
function load(force = false) {
  const get = source();
  if (!get) return Promise.resolve(state);
  if (inflight) return inflight;
  if (!force && Date.now() - lastAt < 4000) return Promise.resolve(state);
  inflight = Promise.resolve().then(get).then((s) => {
    lastAt = Date.now();
    const next = s && typeof s === 'object' ? { bars: s.bars || {}, cooling: s.cooling || {}, showBars: s.showBars !== false } : null;
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (changed) { try { root.dispatchEvent(new CustomEvent('lumen-usage-bars')); } catch { /* not a page */ } }
    return state;
  }, () => state).finally(() => { inflight = null; });
  return inflight;
}

const api = { levelOf, windowsOf, resetText, describe, forModel, forProvider, annotate, element, providerOf, WARN_AT, HIGH_AT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else {
  root.usageBars = { ...api, state: () => state, load, touch: () => load(false) };
  setTimeout(() => load(true), 800); // after the page's own start-up; the data is already in main's memory
  // A reply finished or the plan meter moved (the same events the composer's meter follows): look again.
  if (root.assistant && root.assistant.onEvent) root.assistant.onEvent((e) => { if (e && (e.type === 'done' || e.type === 'rate_limit')) setTimeout(() => load(true), 400); });
  root.addEventListener('focus', () => load(false));
}
})(typeof window !== 'undefined' ? window : globalThis);
