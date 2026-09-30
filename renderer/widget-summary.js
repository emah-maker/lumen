// Settings > Home > Widgets: the words. A name and one plain line for each kind of widget (for the Add
// widget picker), and a one-line summary of a widget's current settings (for the list), e.g.
// "Boston · °F · 7 days". Pure functions, no DOM: renderer/settings.js draws them and test/units.js runs them.
//
//   KINDS                  type -> [name, what it is]
//   widgetSummary(w, ctx)  the list's second line; ctx = the widget state's { secrets, connections, slack, spotify, feedPresets }
//   accountStatus(w, ctx)  null for a widget with nothing to sign in to, else { connected, text }
(function () {
'use strict';

const KINDS = {
  weather: ['Weather', 'Forecast for one or more places'],
  worldclock: ['World clock', 'Times, dates and sunrise for places'],
  calendar: ['Calendar', 'Upcoming events from a calendar link'],
  todoist: ['Todoist', 'Your tasks'],
  feed: ['Headlines', 'News from an RSS or Atom feed'],
  spotify: ['Spotify', 'What is playing, with play and skip'],
  gmail: ['Gmail', 'Unread count and latest messages'],
  slack: ['Slack', 'Unread direct messages, mentions and channels'],
  github: ['GitHub', 'Review requests, assigned items, notifications'],
  stocks: ['Stocks', 'A watchlist and a paper portfolio'],
  crypto: ['Crypto', 'Coin prices and a paper portfolio'],
  muse: ['Muse', 'Ask Meta’s Muse model with a saved prompt'],
  embed: ['Web page', 'Any page that allows being shown in a frame'],
};
// The order the Add widget picker lists them in: everyday first, accounts and keys after.
const ORDER = ['weather', 'worldclock', 'calendar', 'todoist', 'feed', 'spotify', 'gmail', 'slack', 'github', 'stocks', 'crypto', 'muse', 'embed'];

const kindName = (type) => (KINDS[type] ? KINDS[type][0] : String(type || 'Widget'));
const kindHint = (type) => (KINDS[type] ? KINDS[type][1] : 'Set up in Settings');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (items, max = 2) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} +${items.length - max}`);
const host = (u) => { try { return new URL(String(u).replace(/^webcal:/i, 'https:')).hostname.replace(/^www\./, ''); } catch { return ''; } };

const TODO_SOURCES = { todayOverdue: 'Today and overdue', today: 'Today', upcoming: 'Upcoming', inbox: 'Inbox', all: 'All tasks' };
const CLOCKS = { 12: '12-hour', 24: '24-hour' };

// Whether a widget that needs an account or key has one, and a short line saying so.
function accountStatus(w, ctx = {}) {
  const secrets = ctx.secrets || {};
  switch (w && w.type) {
    case 'spotify': {
      if (w.mode === 'web') return null; // Spotify's own site in the card: nothing to connect here
      const on = Boolean(secrets.spotify);
      const name = ctx.spotify && ctx.spotify.name;
      return { connected: on, text: on ? (name ? `Connected as ${name}` : 'Connected') : 'Not connected' };
    }
    case 'gmail': { const on = Boolean(ctx.connections && ctx.connections.gmail); return { connected: on, text: on ? 'Connected' : 'Not connected' }; }
    case 'slack': {
      const s = ctx.slack || {};
      if (s.connected && s.reconnect) return { connected: false, text: 'Needs to be connected again' };
      return { connected: Boolean(s.connected), text: s.connected ? `Connected${s.team ? ` to ${s.team}` : ''}` : 'Not connected' };
    }
    case 'github': return { connected: Boolean(secrets.github), text: secrets.github ? 'Token saved' : 'Not connected' };
    case 'todoist': return { connected: Boolean(secrets.todoist), text: secrets.todoist ? 'Token saved' : 'Not connected' };
    case 'muse': return { connected: Boolean(secrets.muse), text: secrets.muse ? 'Key saved' : 'No key yet' };
    case 'stocks': return { connected: Boolean(secrets.twelvedata), text: secrets.twelvedata ? 'Key saved' : 'No key yet' };
    default: return null;
  }
}

function widgetSummary(w, ctx = {}) {
  if (!w || typeof w !== 'object') return '';
  const parts = [];
  const acct = accountStatus(w, ctx);
  try {
    switch (w.type) {
      case 'weather': {
        const wx = w.wx || {};
        const places = (wx.places || []).map((p) => (p.here ? 'My location' : p.nick || String(p.name || '').split(',')[0].trim())).filter(Boolean);
        parts.push(places.length ? list(places) : 'No place yet');
        parts.push(`°${String(wx.units || 'f').toUpperCase()}`);
        parts.push(`${wx.days || 7} days`);
        break;
      }
      case 'worldclock': {
        const wc = w.wc || {};
        const places = (wc.places || []).map((p) => p.nick || String(p.name || '').split(',')[0].trim()).filter(Boolean);
        parts.push(places.length ? list(places, 3) : 'No place yet');
        if (CLOCKS[wc.clock]) parts.push(CLOCKS[wc.clock]);
        break;
      }
      case 'calendar': parts.push(host(w.url) || 'No calendar link yet'); break;
      case 'feed': {
        const preset = (ctx.feedPresets || []).find((p) => p.id === w.preset);
        parts.push(preset ? preset.name : host(w.url) || 'No feed yet');
        if (w.count) parts.push(plural(w.count, 'headline', 'headlines'));
        break;
      }
      case 'todoist': {
        const t = w.todo || {};
        if (acct && !acct.connected) { parts.push(acct.text); break; }
        parts.push(TODO_SOURCES[t.source] || (t.source === 'project' ? (t.projectName ? `Project ${t.projectName}` : 'A project') : t.source === 'label' ? `Label @${t.label || ''}` : t.source === 'custom' ? 'Your filter' : ''));
        if (t.max) parts.push(`${t.max} shown`);
        break;
      }
      case 'spotify': if (!acct) { parts.push('Web player'); break; } parts.push(acct.text); if (acct.connected && w.art === false) parts.push('no album art'); break;
      case 'gmail': parts.push(acct.text); if (acct.connected && w.count) parts.push(`${w.count} latest`); break;
      case 'slack': parts.push(acct.text); break;
      case 'github': {
        if (!acct.connected) { parts.push(acct.text); break; }
        const g = w.gh || {};
        const shows = [g.reviews !== false && 'Reviews', g.assigned !== false && 'Assigned', g.notifications !== false && 'Notifications'].filter(Boolean);
        parts.push(shows.length ? shows.join(' · ') : 'Nothing switched on');
        break;
      }
      case 'stocks': {
        const s = ((w.mk && w.mk.symbols) || []).map(String);
        parts.push(s.length ? list(s, 4) : 'No symbols yet');
        if (acct && !acct.connected) parts.push(acct.text);
        break;
      }
      case 'crypto': {
        const c = ((w.mk && w.mk.coins) || []).map((k) => k.sym || k.id);
        parts.push(c.length ? list(c, 4) : 'No coins yet');
        break;
      }
      case 'muse': {
        if (!acct.connected) { parts.push(acct.text); break; }
        const m = w.muse || {};
        parts.push(m.model || 'muse-spark-1.3');
        if (m.search) parts.push('web search');
        break;
      }
      case 'embed': parts.push(host(w.url) || 'No address yet'); if (w.height) parts.push(`${w.height} height`); break;
      default: break;
    }
  } catch { /* fall through to the backend's own line */ }
  const line = parts.filter(Boolean).join(' · ');
  return line || (typeof w.summary === 'string' ? w.summary : '');
}

const api = { KINDS, ORDER, kindName, kindHint, accountStatus, widgetSummary };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetSummary = api;
})();
