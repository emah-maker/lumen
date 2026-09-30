// What a Gmail widget shows: its per-widget settings (validated), the Gmail API requests it makes
// (read-only: the inbox label and its newest messages' headers), and the answers cut down to display
// data (an unread count and the latest few subjects, senders and snippets). Pure functions, no
// network and no Electron: features/widgets.js does the fetching and features/oauth.js the sign-in.
// Only text goes to the new-tab page, and the page sets it with textContent.
'use strict';

// Read-only. gmail.metadata would show headers but Google documents no snippet under it, so this is
// gmail.readonly, the narrowest scope that is certain to include the snippet. Nothing is ever written.
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MIN_COUNT = 3;
const MAX_COUNT = 10;
const DEFAULT_COUNT = 5;
const MAX_CLIENT_ID = 200;

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const count = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : null);

// A Google OAuth client ID: 12345-abc.apps.googleusercontent.com. '' when it isn't one.
function cleanClientId(v) {
  const id = typeof v === 'string' ? v.trim() : '';
  return id.length <= MAX_CLIENT_ID && /^[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com$/i.test(id) ? id : '';
}
// The client secret Google shows next to a Desktop client ID (GOCSPX-...). Not confidential in the
// usual sense for an installed app, but it is stored encrypted like a password anyway.
function cleanClientSecret(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[A-Za-z0-9_-]{8,200}$/.test(s) ? s : '';
}
// The stored (or form) config -> a checked one, or null for a Client ID that isn't one. No Client ID
// ('') means Lumen's built-in Google client signs in (features/google-client.js).
function cleanConfig(c) {
  const i = c && typeof c === 'object' ? c : {};
  const raw = typeof i.clientId === 'string' ? i.clientId.trim() : '';
  const clientId = cleanClientId(raw);
  if (raw && !clientId) return null;
  return { clientId, count: count(Number(i.count), MIN_COUNT, MAX_COUNT) ?? DEFAULT_COUNT, snippets: i.snippets !== false };
}

// ---- Gmail API ----
const INBOX_LABEL = 'INBOX';
const encodeId = (id) => encodeURIComponent(String(id));
// The requests: the label (its unread count), the newest inbox ids, and one message's headers each.
const labelPath = () => `/users/me/labels/${INBOX_LABEL}?fields=messagesUnread,messagesTotal`;
const listPath = (n) => `/users/me/messages?${new URLSearchParams({ labelIds: INBOX_LABEL, maxResults: String(n), fields: 'messages/id' })}`;
const messagePath = (id) => `/users/me/messages/${encodeId(id)}?${new URLSearchParams({ format: 'metadata', fields: 'id,snippet,internalDate,labelIds,payload/headers' })}&metadataHeaders=Subject&metadataHeaders=From`;

const MESSAGE_ID = /^[0-9a-f]{6,32}$/i;
const isMessageId = (id) => typeof id === 'string' && MESSAGE_ID.test(id);
// The ids in a list answer (garbage skipped), at most n.
function messageIds(body, n) {
  return (Array.isArray(body?.messages) ? body.messages : []).map((m) => m?.id).filter(isMessageId).slice(0, n);
}

// ---- header text ----
// RFC 2047 encoded words ("=?UTF-8?B?...?=", "=?utf-8?Q?...?="), as Gmail leaves them in headers.
function decodeWords(text) {
  const joined = String(text).replace(/(\?=)\s+(=\?)/g, '$1$2'); // whitespace between two encoded words is dropped
  return joined.replace(/=\?([\w-]{1,40})\?([bBqQ])\?([^?]{0,2000})\?=/g, (whole, charset, enc, data) => {
    try {
      const bytes = /^b$/i.test(enc)
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(charset.toLowerCase() === 'utf8' ? 'utf-8' : charset).decode(bytes);
    } catch { return whole; }
  });
}
// The snippet field is HTML-escaped text.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole; } catch { return whole; }
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}
// "Ada Lovelace <ada@example.com>", '"Lovelace, Ada" <ada@x.org>' or "ada@x.org" -> { name, address }.
function parseSender(header) {
  const raw = decodeWords(flat(header, 600));
  const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(raw);
  const address = flat(angle ? angle[2] : /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(raw)?.[1] || '', 200);
  const name = flat((angle ? angle[1] : '').replace(/^\s*"(.*)"\s*$/, '$1').replace(/\\(.)/g, '$1'), 100);
  return { name: name || address, address };
}
function headerValue(headers, name) {
  const h = (Array.isArray(headers) ? headers : []).find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === name);
  return typeof h?.value === 'string' ? h.value : '';
}

// One message answer -> { id, from, address, subject, snippet, at, unread }, or null when it isn't one.
function normalizeMessage(m, { snippets = true } = {}) {
  if (!m || typeof m !== 'object' || !isMessageId(m.id)) return null;
  const from = parseSender(headerValue(m.payload?.headers, 'from'));
  const subject = flat(decodeWords(flat(headerValue(m.payload?.headers, 'subject'), 1000)), 200);
  const at = Number(m.internalDate);
  return {
    id: m.id,
    from: from.name || 'Unknown sender',
    address: from.address,
    subject: subject || '(no subject)',
    snippet: snippets ? flat(decodeEntities(typeof m.snippet === 'string' ? m.snippet.slice(0, 1000) : ''), 160) : '',
    at: Number.isFinite(at) && at > 0 && at < 8.64e15 ? Math.round(at) : 0,
    unread: Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD'),
  };
}

// The card's data: the label answer and the messages (already fetched, in inbox order).
function shape(label, messages, cfg) {
  const unread = count(Number(label?.messagesUnread), 0, 1e7) ?? 0;
  const total = count(Number(label?.messagesTotal), 0, 1e9) ?? 0;
  const list = messages.map((m) => normalizeMessage(m, cfg)).filter(Boolean).slice(0, cfg.count);
  return { state: 'ok', unread, total, messages: list, open: 'https://mail.google.com/mail/u/0/#inbox' };
}
// The card's data when there is nothing to show yet: the user has to connect (again). oneClick: the
// card may offer "Sign in with Google" itself (a client is ready: Lumen's own, or the user's with its
// secret stored); otherwise its button opens Settings.
const reconnect = (message, { oneClick = false } = {}) => ({ state: 'reconnect', message: flat(message, 200) || 'Connect Gmail in Settings.', oneClick: oneClick === true });

// A failed Gmail API answer -> what the user should read (never the body: it can echo request details).
function apiError(status, text) {
  let reason = '';
  try { const b = JSON.parse(text); reason = flat(b?.error?.errors?.[0]?.reason || b?.error?.status || '', 60); } catch { /* not JSON */ }
  if (status === 401) return { message: 'Google signed Lumen out. Connect Gmail again in Settings.', reconnect: true };
  if (status === 429 || (status === 403 && /ratelimit|quota/i.test(reason))) return { message: 'Gmail asked Lumen to slow down. It will try again shortly.', rate: true };
  if (status === 403 && /accessnotconfigured|servicedisabled/i.test(reason)) return { message: 'The Gmail API is not turned on for that Google Cloud project. Enable it in the Cloud console, then try again.' };
  if (status === 403) return { message: 'Google refused access to Gmail. Connect Gmail again in Settings.', reconnect: true };
  if (status >= 500) return { message: 'Gmail is having trouble. Lumen will try again shortly.' };
  if (status === 400 && /failedprecondition|mailbox/i.test(`${reason} ${text}`)) return { message: 'This Google account has no Gmail inbox. Sign in with an account that uses Gmail.', reconnect: true };
  return { message: `Gmail answered ${status}.` };
}

// The consent URL's extra parameters: a refresh token needs offline access, and `consent` makes Google
// send one again if this account connected before. select_account lets the user pick the mailbox.
const AUTH_EXTRA = { access_type: 'offline', prompt: 'consent select_account' };

module.exports = { SCOPE, MIN_COUNT, MAX_COUNT, DEFAULT_COUNT, AUTH_EXTRA, cleanClientId, cleanClientSecret, cleanConfig, labelPath, listPath, messagePath, messageIds, isMessageId, decodeWords, decodeEntities, parseSender, normalizeMessage, shape, reconnect, apiError };
