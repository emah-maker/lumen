// The plan meter's popover (chat-extras.js draws it): everything it says, worked out from the usage summary the strip
// and Settings → Usage already hold (features/usage.js summary(): bars, plan, meter, providers, rate, codex). Pure
// formatting, no window and no network, so it also runs in node (test/usage-popover-units.js). Missing data is left
// out, never guessed: no number is better than a made-up one.
//
//   view(key, state, { now, name }) -> { name, plan, windows, counted, rates, updatedAt, updated, note, message } | null
//     windows  [{ key, label, percent, percentText, level, text }]   text: "resets 3:40 PM, in 1 h 12 m" ('' when unknown)
//     counted  [{ label, text }]                  what Lumen counted: "Today": "12.3k tokens · 4 messages · ≈$0.40"
//     rates    [{ label, percent, percentText, text }]   per-minute limits an API key's replies carried
//   percentText(p), relative(ms, now), updatedText(ms, now), countText(c, unit)  the pieces, for the tests
(function (root) {
'use strict';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const tr = (key, fallback, vars) => {
  let s = root.t ? root.t(key, vars) : key;
  if (!s || s === key) s = fallback;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : '')) : s;
};
const bars = () => (typeof module !== 'undefined' && module.exports ? require('./usage-bars') : root.usageBars);

// "42%" for a real number, '' for a missing one.
const percentText = (p) => (finite(p) ? `${Math.round(Math.max(0, Math.min(100, p)))}%` : '');

// "in 1 h 12 m", "in 2 d 3 h", "in 40 m", "in 12 s"; '' when the time is unknown or already past.
function relative(ms, now = Date.now()) {
  if (!finite(ms)) return '';
  const left = ms - now;
  if (left <= 0) return '';
  const s = Math.ceil(left / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  let t;
  if (d > 0) t = h ? `${d} d ${h} h` : `${d} d`;
  else if (h > 0) t = m ? `${h} h ${m} m` : `${h} h`;
  else if (m > 0) t = `${m} m`;
  else t = `${s} s`;
  return tr('usage.pop.in', 'in {time}', { time: t });
}

// "Updated just now", "Updated 5 min ago", "Updated 2 h ago"; '' when unknown.
function updatedText(ms, now = Date.now()) {
  if (!finite(ms) || ms <= 0) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return tr('usage.pop.updated', 'Updated {time}', { time: tr('usage.pop.justNow', 'just now') });
  const t = s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
  return tr('usage.pop.updated', 'Updated {time}', { time: tr('usage.pop.ago', '{time} ago', { time: t }) });
}

const compact = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const money = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

// "12.3k tokens · 4 messages · ≈$0.40": only the parts that exist (a cost only when the provider or the price table gave
// one). '' when nothing was counted.
function countText(c, unit = 'messages') {
  if (!c || !(c.tokens > 0 || c.turns > 0 || c.sessions > 0)) return '';
  const parts = [];
  if (c.tokens > 0) parts.push(tr('usage.tokens', '{tokens} tokens', { tokens: compact(c.tokens) }));
  const n = unit === 'sessions' ? c.sessions : c.turns;
  if (n > 0) parts.push(unit === 'sessions' ? tr('usage.pop.sessions', '{count} sessions', { count: n }) : tr('usage.pop.messages', '{count} messages', { count: n }));
  if (c.costUSD > 0) parts.push(`≈${money(c.costUSD)}`);
  return parts.join(' · ');
}

const clockOf = (ms, now) => {
  const d = new Date(ms);
  return d.toDateString() === new Date(now).toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
// "resets 3:40 PM, in 1 h 12 m" from a time; "resets Mon 12:00 AM" from the CLI's own words; '' when neither is known.
function resetLine(source, now = Date.now()) {
  if (source && finite(source.resetsAt) && source.resetsAt > now) {
    return `${tr('usage.resets', 'resets {time}', { time: clockOf(source.resetsAt, now) })}, ${relative(source.resetsAt, now)}`;
  }
  const words = source && typeof source.resetsText === 'string' ? source.resetsText.trim() : '';
  return words ? tr('usage.resets', 'resets {time}', { time: words }) : '';
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
function planName(key, state) {
  if (key === 'claudecode' && state.plan && state.plan.available && state.plan.subscription) return tr('usage.pop.plan.claude', 'Claude subscription');
  if (key === 'codex' && state.codex && state.codex.planType) return tr('usage.pop.plan.named', '{plan} plan', { plan: cap(state.codex.planType) });
  return '';
}

// When the numbers were last read: the meter's reading (Claude Code), Codex's own log reading, the newest rate-limit headers.
function updatedAt(key, state) {
  const candidates = [];
  if (key === 'claudecode' && state.meter) candidates.push(state.meter.at);
  if (key === 'codex' && state.codex) candidates.push(state.codex.readAt);
  if (state.rate && state.rate[key]) candidates.push(state.rate[key].at);
  const known = candidates.filter((n) => finite(n) && n > 0);
  return known.length ? Math.max(...known) : null;
}

function countedFor(key, state) {
  if (key === 'codex') {
    const c = state.codex;
    return c && c.available ? { today: c.today, week: c.week, unit: 'sessions' } : null;
  }
  const p = state.providers && state.providers[key];
  if (p) return { today: p.today, week: p.week, unit: 'messages' };
  if (key === 'claudecode' && state.lumen) return { today: state.lumen.today, week: state.lumen.week, unit: 'messages' };
  return null;
}

function view(key, state, { now = Date.now(), name = '' } = {}) {
  if (!key || !state || typeof state !== 'object') return null;
  const bar = state.bars ? state.bars[key] : null;
  const windows = bars().windowsOf(bar, now).map((w) => ({
    key: w.key, label: w.label, percent: w.percent, level: w.level, percentText: percentText(w.percent),
    text: w.resetsAt ? resetLine({ resetsAt: w.resetsAt }, now) : w.reset, // (w.reset: the CLI's own words, already "resets Mon 12:00 AM")
  }));
  const counted = [];
  const c = countedFor(key, state);
  if (c) {
    const today = countText(c.today, c.unit);
    const week = countText(c.week, c.unit);
    if (today) counted.push({ label: tr('usage.pop.today', 'Today'), text: today });
    if (week) counted.push({ label: tr('usage.pop.week', 'Last 7 days'), text: week });
  }
  const rate = state.rate && state.rate[key];
  const rates = rate && Array.isArray(rate.buckets)
    ? rate.buckets.filter((b) => !b.expired && finite(b.percent)).map((b) => ({
      label: b.label, percent: b.percent, percentText: percentText(b.percent),
      text: [finite(b.limit) && finite(b.remaining) ? tr('usage.pop.left', '{left} of {limit} left', { left: compact(b.remaining), limit: compact(b.limit) }) : '', resetLine({ resetsAt: b.resetsAt }, now)].filter(Boolean).join(', '),
    }))
    : [];
  const at = updatedAt(key, state);
  const note = !windows.length && !rates.length ? (state.notes && state.notes[key]) || '' : '';
  return { name, plan: planName(key, state), windows, counted, rates, updatedAt: at, updated: updatedText(at, now), note, message: bar && bar.kind === 'limit' && bar.message ? bar.message : '' };
}

const api = { view, percentText, relative, updatedText, countText, resetLine };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.usagePopover = api;
})(typeof window !== 'undefined' ? window : globalThis);
