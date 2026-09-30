// What a Slack widget shows and how it signs in: the per-widget settings (validated), the OAuth v2
// pieces that are Slack's own, and how the answers of Slack's Web API become the card's display data
// (counts, names and short plain-text messages: nothing else ever reaches the page). Pure functions,
// no Electron and no network: features/widgets.js hands collect() a function that calls Slack, and
// the tests hand it a fake. The generic parts (state, expiry, storage) are in features/oauth.js.
//
// Sign-in, and why it is not a loopback listener. Slack requires an https redirect URL: its docs say a
// redirect_uri "must use HTTPS" and do not list http://127.0.0.1 or localhost as an exception, so
// Spotify's RFC 8252 loopback redirect cannot be used. Instead the user's own Slack app registers an
// https address that never has to work (default https://localhost/lumen-slack), Lumen opens Slack's
// approval page, and after approving the browser lands on that address (an error page is fine): the
// user pastes the address back into Settings, and Lumen takes the code out of it (oauth.parseRedirect
// checks the state) and trades it for a user token with the app's client secret. Slack has no PKCE for
// this exchange, so the client secret (encrypted, like the token) is required. As a simpler fallback the
// user may paste a user token (xoxp-…) from their app's "OAuth & Permissions" page instead.
'use strict';

const OAuth = require('./oauth');

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const DEFAULT_REDIRECT = 'https://localhost/lumen-slack';
// Read-only user scopes: see channels and their messages, DMs and group DMs (and who is who). Nothing
// that can post, edit, delete or join anything. (search:read is left out on purpose.)
const USER_SCOPES = ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history', 'users:read'];
const MAX_CHANNELS = 4;
const MAX_DMS = 8; // direct messages looked at per refresh (Slack rate limits)
const COUNTS = [3, 5, 8, 10];
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,20}$/;
const USER_ID = /^[UW][A-Z0-9]{2,20}$/;

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

const cleanClientId = (v) => { const s = typeof v === 'string' ? v.trim() : ''; return /^\d{6,20}\.\d{6,20}$/.test(s) ? s : ''; };
const cleanClientSecret = (v) => { const s = typeof v === 'string' ? v.trim() : ''; return /^[0-9a-f]{20,64}$/i.test(s) ? s : ''; };
const cleanUserToken = (v) => { const s = typeof v === 'string' ? v.trim() : ''; return /^xoxp-[A-Za-z0-9-]{10,200}$/.test(s) || /^xoxe\.xoxp-[A-Za-z0-9-]{10,200}$/.test(s) ? s : ''; };
// An https address (no credentials, spaces or quotes), or ''.
function cleanRedirect(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return DEFAULT_REDIRECT;
  if (!/^https:\/\//i.test(s) || s.length > 300 || /[\s"'<>\\]/.test(s)) return '';
  try { const u = new URL(s); return u.protocol === 'https:' && u.hostname && !u.username && !u.password && !u.hash ? u.href : ''; } catch { return ''; }
}

function authorizeUrl({ clientId, redirectUri, state }) {
  return OAuth.authorizeUrl(AUTHORIZE_URL, { client_id: clientId, user_scope: USER_SCOPES.join(','), redirect_uri: redirectUri, state });
}
// oauth.v2.access with a code, or (token rotation) with a refresh token.
const codeForm = ({ clientId, clientSecret, code, redirectUri }) => OAuth.form({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
const refreshForm = ({ clientId, clientSecret, refresh }) => OAuth.form({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refresh });

// oauth.v2.access answers { ok, authed_user: { id, access_token, refresh_token?, expires_in? }, team: { id, name } }
// (a refresh answers the token at the top level). -> the stored fields, or throws with Slack's error.
function parseAccess(body, now, previous) {
  let b;
  try { b = typeof body === 'string' ? JSON.parse(body) : body; } catch { b = null; }
  if (!b || typeof b !== 'object') throw new SlackError('bad_response');
  if (!b.ok) throw new SlackError(typeof b.error === 'string' ? b.error.replace(/[^\w]/g, '').slice(0, 60) : 'unknown_error');
  const src = b.authed_user && typeof b.authed_user === 'object' && b.authed_user.access_token ? b.authed_user : b;
  const tok = OAuth.normalizeToken({ ...src, access_token: src.access_token }, now, previous);
  if (!tok) throw new SlackError('no_user_token'); // the app was installed without user scopes
  return {
    ...tok,
    userId: USER_ID.test(String(b.authed_user?.id || '')) ? b.authed_user.id : previous?.userId || '',
    teamId: flat(b.team?.id, 40) || previous?.teamId || '',
    teamName: flat(b.team?.name, 120) || previous?.teamName || '',
  };
}

class SlackError extends Error {
  constructor(code) { super(explain(code)); this.code = code; this.reconnect = RECONNECT.has(code); }
}
const RECONNECT = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'invalid_refresh_token', 'invalid_grant', 'no_user_token', 'missing_scope', 'org_login_required', 'two_factor_setup_required']);
const EXPLAIN = {
  invalid_auth: 'Slack no longer accepts this sign-in.', not_authed: 'Slack is not connected.', token_revoked: 'The Slack sign-in was revoked.', token_expired: 'The Slack sign-in expired.',
  account_inactive: 'That Slack account is deactivated.', invalid_refresh_token: 'The Slack sign-in expired.', invalid_grant: 'Slack refused the sign-in.', bad_redirect_uri: 'The redirect URL doesn’t match one saved in your Slack app.',
  invalid_code: 'That code was used or expired. Start again with “Open Slack”.', bad_client_secret: 'The Client Secret is wrong.', invalid_client_id: 'The Client ID is wrong.',
  invalid_client: 'The Client ID or Secret is wrong.', no_user_token: 'The app has no user token. Add the user scopes and reinstall it.', missing_scope: 'The app is missing a permission. Add the read scopes and reinstall it.',
  ratelimited: 'Slack asked Lumen to slow down.', channel_not_found: 'A chosen channel was not found.', not_in_channel: 'You are not in a chosen channel.', bad_response: 'Slack sent something unexpected.',
};
const explain = (code) => EXPLAIN[code] || `Slack said “${flat(code, 40) || 'error'}”.`;

// Slack's mrkdwn -> plain text: <@U1> becomes @name, <#C1|general> #general, <https://x|label> label, entities decoded.
function plainText(raw, nameOf = () => '') {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/<([^>]{1,500})>/g, (_m, inner) => {
    if (inner.startsWith('@')) { const id = inner.slice(1).split('|')[0]; return `@${nameOf(id) || inner.split('|')[1] || 'someone'}`; }
    if (inner.startsWith('#')) return `#${inner.split('|')[1] || 'channel'}`;
    if (inner.startsWith('!')) { const w = inner.slice(1).split('|'); return `@${w[1] || w[0].replace(/^subteam\^.*/, 'group')}`; }
    const [url, label] = inner.split('|');
    if (label) return label;
    return url.replace(/^mailto:/, '').replace(/^https?:\/\/(www\.)?/, '');
  });
  return flat(t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[*_~`]+/g, ''), 300);
}
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const tsNum = (ts) => { const n = Number(ts); return Number.isFinite(n) && n > 0 ? n : 0; }; // Slack's "1700000000.000200" (seconds)
const SKIP_SUBTYPES = new Set(['channel_join', 'channel_leave', 'group_join', 'group_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'pinned_item', 'unpinned_item']);
const visible = (m) => m && typeof m === 'object' && typeof m.ts === 'string' && !SKIP_SUBTYPES.has(m.subtype);
// The people a message names: its author and everyone it mentions.
const idsIn = (m) => [m.user, ...(String(m.text || '').match(/<@[UW][A-Z0-9]+/g) || []).map((x) => x.slice(2))];
const isMention = (m, me) => Boolean(me) && typeof m.text === 'string' && m.text.includes(`<@${me}>`);

// Stored widget config -> checked. channels: [{ id, name }] the user picked (public and private channels).
function cleanConfig(c) {
  const i = c && typeof c === 'object' ? c : {};
  const seen = new Set();
  const channels = (Array.isArray(i.channels) ? i.channels : [])
    .map((ch) => ({ id: typeof ch?.id === 'string' ? ch.id : '', name: flat(ch?.name, 80).replace(/^#/, '') }))
    .filter((ch) => /^[CG][A-Z0-9]{2,20}$/.test(ch.id) && !seen.has(ch.id) && seen.add(ch.id))
    .slice(0, MAX_CHANNELS);
  return { channels, dms: i.dms !== false, mentions: i.mentions !== false, count: pick(Number(i.count), COUNTS, 5) };
}
const nameFor = (cfg) => (cfg.channels.length === 1 ? `#${cfg.channels[0].name || 'channel'}` : 'Slack');
function summaryFor(cfg) {
  const parts = [];
  if (cfg.dms) parts.push('DMs');
  if (cfg.mentions) parts.push('mentions');
  if (cfg.channels.length) parts.push(cfg.channels.map((c) => `#${c.name || c.id}`).join(', '));
  return parts.join(' · ') || 'Nothing selected';
}

// An in-app link to a message, only ever to the workspace's own *.slack.com address.
function permalink(teamUrl, channel, ts) {
  try {
    const u = new URL(teamUrl);
    if (u.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(u.hostname) || !CHANNEL_ID.test(channel) || !/^\d+\.\d+$/.test(ts)) return null;
    return `${u.origin}/archives/${channel}/p${ts.replace('.', '')}`;
  } catch { return null; }
}

// Everything the card shows, collected through api(method, params) -> Slack's answer (rejects with a
// SlackError). users(id) -> a display name ('' when unknown). Errors about one conversation (not in it,
// not found) skip that conversation; sign-in and rate-limit errors end the whole refresh.
async function collect(api, cfg, { userId, teamName, teamUrl }, users = async () => '') {
  const notes = [];
  const soft = (err) => { if (err instanceof SlackError && !err.reconnect && err.code !== 'ratelimited') { notes.push(err.message); return null; } throw err; };
  const convs = [];
  if (cfg.dms) {
    const out = await api('users.conversations', { types: 'im,mpim', exclude_archived: 'true', limit: '100' });
    const list = (Array.isArray(out.channels) ? out.channels : []).filter((c) => c && CHANNEL_ID.test(String(c.id)));
    list.sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
    for (const c of list.slice(0, MAX_DMS)) convs.push({ id: c.id, kind: c.is_mpim ? 'mpim' : 'im', user: USER_ID.test(String(c.user || '')) ? c.user : '' });
  }
  for (const ch of cfg.channels) convs.push({ id: ch.id, kind: 'channel', name: ch.name });

  const names = new Map();
  const nameOf = (id) => names.get(id) || '';
  const learn = async (ids) => { for (const id of ids) if (USER_ID.test(id) && !names.has(id)) names.set(id, flat(await users(id).catch(() => ''), 60)); };

  const messages = [];
  const dmChats = [];
  let unread = 0;
  let mentions = 0;
  for (const c of convs) {
    try {
      const info = (await api('conversations.info', { channel: c.id })).channel || {};
      const lastRead = tsNum(info.last_read);
      const known = Number.isFinite(info.unread_count_display) ? info.unread_count_display : null;
      const isDm = c.kind !== 'channel';
      if (isDm && known === 0) continue; // nothing new: no need to read it
      const hist = await api('conversations.history', { channel: c.id, limit: '15' });
      const fresh = (Array.isArray(hist.messages) ? hist.messages : []).filter(visible);
      const newer = fresh.filter((m) => tsNum(m.ts) > lastRead && m.user !== userId); // what is new to you: not your own
      if (isDm) {
        const count = known ?? newer.length;
        if (!count) continue;
        unread += count;
        await learn([c.user, ...newer.flatMap(idsIn)]);
        const who = c.kind === 'im' ? nameOf(c.user) || 'Direct message' : cut(flat(info.name, 60).replace(/^mpdm-/, '').replace(/-+\d+$/, '').replace(/--/g, ', '), 40) || 'Group message';
        dmChats.push({ name: who, unread: count });
        for (const m of newer.slice(0, 3)) messages.push(shapeMessage(m, { where: who, dm: true, unread: true }, nameOf, cfg, c.id, teamUrl));
      } else {
        await learn(fresh.slice(0, cfg.count).flatMap(idsIn));
        if (cfg.mentions) mentions += newer.filter((m) => isMention(m, userId)).length;
        for (const m of fresh.slice(0, cfg.count)) messages.push(shapeMessage(m, { where: `#${c.name || flat(info.name, 60) || 'channel'}`, dm: false, unread: tsNum(m.ts) > lastRead && m.user !== userId }, nameOf, cfg, c.id, teamUrl));
      }
    } catch (err) { soft(err); }
  }
  messages.sort((a, b) => b.ts - a.ts);
  dmChats.sort((a, b) => b.unread - a.unread);
  return {
    team: flat(teamName, 120), teamUrl: /^https:\/\/[\w.-]+\.slack\.com/.test(teamUrl || '') ? new URL(teamUrl).origin : '',
    showDms: cfg.dms, showMentions: cfg.mentions, unread, mentions, dmChats: dmChats.slice(0, 5),
    messages: messages.slice(0, cfg.count), channelCount: cfg.channels.length, notice: notes[0] || '',
  };
}
function shapeMessage(m, { where, dm, unread }, nameOf, cfg, channel, teamUrl) {
  const from = m.user ? nameOf(m.user) || 'Someone' : flat(m.username, 60) || flat(m.bot_profile?.name, 60) || 'App';
  const text = cut(plainText(m.text, nameOf), 140) || (Array.isArray(m.files) && m.files.length ? '(a file)' : '(no text)');
  return { where, from, text, ts: Math.round(tsNum(m.ts) * 1000), dm, unread, url: permalink(teamUrl, channel, m.ts) };
}

module.exports = {
  AUTHORIZE_URL, DEFAULT_REDIRECT, USER_SCOPES, MAX_CHANNELS, MAX_DMS, COUNTS, SlackError, RECONNECT,
  cleanClientId, cleanClientSecret, cleanUserToken, cleanRedirect, authorizeUrl, codeForm, refreshForm, parseAccess,
  explain, plainText, cleanConfig, nameFor, summaryFor, permalink, collect,
};
