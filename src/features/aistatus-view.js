// [widgets] The AI status card: which AIs Lumen can use right now, from what it already knows on this
// computer (the keys and CLI sign-ins it holds, the models it is cooling down after a limit, the usage it has
// counted, the chats it is running). Nothing here asks a network, and nothing secret goes in: the card
// gets names, states, a model name and a few counts. Pure (no Electron, no settings): main.js hands shape()
// the raw facts, the page gets the result, and test/aistatus-units.js runs both.
//
//   shape(raw, now)   the card's data: { ais, counts, summary, sub, live, liveText }
//   THRESHOLDS        the card sizes (CSS px of the card's content box) where the page changes its layout;
//                     newtab.html's @container rules use the same numbers (test/aistatus-units.js checks)
//   layoutFor(size)   which layout a content box gets: 'dots' | 'rows' | 'detail', and whether the live strip fits
(function () {
'use strict';

// Fixed order, so the card doesn't reshuffle: an AI with the same state keeps its place.
const ORDER = ['anthropic', 'claudecode', 'openai', 'xai', 'grokbuild', 'gemini', 'antigravity', 'openrouter'];
const NAMES = { anthropic: 'Claude', claudecode: 'Claude Code', openai: 'OpenAI', xai: 'Grok', grokbuild: 'Grok Build', gemini: 'Gemini', antigravity: 'Antigravity', openrouter: 'OpenRouter' };
const ENGINES = ['claudecode', 'grokbuild', 'antigravity']; // the user's own CLIs: shown even when not installed (so "not installed" is an answer)
const STATES = ['ready', 'limited', 'down', 'out', 'off', 'missing'];
const RANK = { ready: 0, limited: 1, down: 2, out: 3, off: 4, missing: 5 }; // most usable first

const THRESHOLDS = {
  rows: { minWidth: 150, minHeight: 150 }, // below: a summary line and a dot per AI (a row with its state under the name is two lines: three of them need this much)
  inline: { minWidth: 210, minHeight: 112 }, // in the list: the state beside the name instead of under it (one line a row, so less height does)
  detail: { minWidth: 230, minHeight: 150 }, // a second line under each AI (the model, the usage hint)
  live: { minHeight: 160 }, // the strip of live counts under the list
  sub: { minHeight: 96 }, // the compact view's note line
};
function layoutFor({ width = 0, height = 0 } = {}) {
  const inline = width >= THRESHOLDS.inline.minWidth && height >= THRESHOLDS.inline.minHeight;
  const rows = inline || (width >= THRESHOLDS.rows.minWidth && height >= THRESHOLDS.rows.minHeight);
  const detail = rows && width >= THRESHOLDS.detail.minWidth && height >= THRESHOLDS.detail.minHeight;
  return { mode: detail ? 'detail' : rows ? 'rows' : 'dots', inline, live: rows && height >= THRESHOLDS.live.minHeight, sub: !rows && height >= THRESHOLDS.sub.minHeight };
}

const int = (v, max = 1e6) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0);
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "3:40 PM" today, "Fri 3:40 PM" within the week, else "Oct 9".
function clockText(at, now) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (ms) => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((day(at) - day(now)) / 864e5);
  if (days <= 0) return time;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const money = (v) => (v > 0 ? (v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`) : '');

// One AI: { id, name, kind: 'api' | 'cli', state, stateText, note, current, model, fullAccess }.
function describe(id, raw, now) {
  const engine = ENGINES.includes(id);
  const e = (raw.engines && raw.engines[id]) || {};
  const cool = raw.cooling && raw.cooling[id];
  let state;
  if (engine) {
    if (!e.installed) state = 'missing';
    else if (e.signedIn === false) state = 'out';
    else if (e.enabled === false) state = 'off';
    else state = 'ready';
  } else state = 'ready'; // an API provider is listed once its key is saved
  let stateText = state === 'ready' ? (engine ? 'Signed in' : 'Connected') : { out: 'Signed out', off: 'Off in the sidebar', missing: 'Not installed' }[state] || '';
  const notes = [];
  const grok = id === 'grokbuild' && raw.grokLimit ? { until: Number.isFinite(raw.grokLimit.resetsAt) ? raw.grokLimit.resetsAt : null, kind: 'limit', exact: Number.isFinite(raw.grokLimit.resetsAt), scope: 'provider' } : null;
  const lim = grok || cool;
  const active = Boolean(lim) && (lim.until === null || Number(lim.until) > now);
  const whenText = lim && Number(lim.until) > now ? clockText(lim.until, now) : '';
  if (state === 'ready' && active && lim.scope !== 'model') {
    if (lim.kind === 'unreachable') { state = 'down'; stateText = 'Unreachable'; notes.push(whenText ? `Trying again ${whenText}` : 'Trying again soon'); } else {
      state = 'limited';
      stateText = 'Limit reached';
      notes.push(!whenText ? 'Resets later' : lim.exact ? `Resets ${whenText}` : `Paused until about ${whenText}`);
    }
  } else if (state === 'ready') {
    // One model (Opus, say) being out leaves the AI usable with the others.
    if (active && lim.kind === 'limit') notes.push(`${str(lim.model, 40) || 'One model'} limit reached${whenText ? `, ${lim.exact ? 'resets' : 'paused until about'} ${whenText}` : ''}`);
    const m = id === 'claudecode' && raw.meter && Number(raw.meter.resetsAt) > now && Number.isFinite(raw.meter.percent) ? raw.meter : null;
    if (m) notes.push(`${Math.round(Math.max(0, Math.min(100, m.percent)))}% of the 5-hour limit used, resets ${clockText(m.resetsAt, now)}`);
    const t = raw.today && raw.today[id];
    if (t && money(t.costUSD)) notes.push(`${money(t.costUSD)} today`);
  } else if (state === 'out') notes.push('Sign in under Settings');
  else if (state === 'missing') notes.push('Install it to use your own account');
  else if (state === 'off') notes.push('Turn it on under Settings');
  const current = Boolean(raw.current && raw.current.provider === id);
  const full = raw.fullAccess ? raw.fullAccess[id] : undefined;
  return {
    id, name: NAMES[id], kind: engine ? 'cli' : 'api', state, stateText, note: notes.join(' · '),
    current, model: current ? str(raw.current.label, 60) : '',
    ...(full === true && engine ? { fullAccess: true } : {}),
  };
}

function shape(rawIn, nowIn) {
  const raw = rawIn && typeof rawIn === 'object' ? rawIn : {};
  const now = Number.isFinite(nowIn) ? nowIn : Date.now();
  const apis = Array.isArray(raw.apis) ? raw.apis.filter((id) => ORDER.includes(id) && !ENGINES.includes(id)) : [];
  const ids = ORDER.filter((id) => ENGINES.includes(id) || apis.includes(id));
  const ais = ids.map((id) => describe(id, raw, now)).sort((a, b) => RANK[a.state] - RANK[b.state] || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const counts = Object.fromEntries(STATES.map((s) => [s, ais.filter((a) => a.state === s).length]));
  const working = int(raw.runs && raw.runs.working, 99);
  const waiting = int(raw.runs && raw.runs.waiting, 99);
  const max = Math.max(1, int(raw.runs && raw.runs.max, 99));
  const tabs = int(raw.aiTabs, 999);
  const handsOff = Boolean(raw.handsOff);
  const live = { working, waiting, max, tabs, handsOff };
  const liveText = [
    working ? `${working} of ${max} chats working` : 'No chats working',
    ...(waiting ? [`${waiting} waiting`] : []),
    ...(tabs ? [plural(tabs, 'AI tab', 'AI tabs')] : []),
    ...(handsOff ? ['Hands-off on'] : []),
  ];
  const anyReady = counts.ready > 0;
  const summary = !ais.some((a) => a.kind === 'api' || a.state !== 'missing') ? 'No AI set up' : [`${counts.ready} ready`, working ? `${working} working` : anyReady ? 'idle' : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(' · ');
  const trouble = ais.find((a) => a.state === 'limited' || a.state === 'down');
  const sub = trouble ? `${trouble.name} ${trouble.state === 'down' ? 'unreachable' : 'limit reached'}${trouble.note && trouble.state === 'limited' ? `, ${trouble.note.charAt(0).toLowerCase()}${trouble.note.slice(1)}` : ''}` : handsOff ? (tabs ? `Hands-off on · ${plural(tabs, 'AI tab', 'AI tabs')}` : 'Hands-off on') : tabs ? plural(tabs, 'AI tab', 'AI tabs') : '';
  const summaryParts = summary === 'No AI set up' ? [summary] : [`${counts.ready} ready`, working ? `${working} working` : anyReady ? 'idle' : '', waiting ? `${waiting} waiting` : ''].filter(Boolean);
  return { ais, counts, summary, summaryParts, sub, live, liveText };
}

const api = { shape, layoutFor, clockText, THRESHOLDS, ORDER, NAMES, ENGINES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.AiStatusView = api;
})();
