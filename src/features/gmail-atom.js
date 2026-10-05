// The default way the Gmail widget reads your inbox: Gmail's own Atom feed, fetched with the Google
// sign-in you already have in Lumen's normal browsing session. No Google Cloud project, no OAuth client,
// no API key. (The other way, your own Google Cloud OAuth client, is features/gmail-view.js + oauth.js.)
//
// What the feed is, and is not (it is not a documented API; it has served Gmail notifiers since 2004):
//   - https://mail.google.com/mail/u/N/feed/atom answers with the UNREAD messages of account N's inbox:
//     the total unread count (<fullcount>) and at most the 20 newest unread messages (subject, sender,
//     a short summary, a link, a time). It cannot list read mail and it cannot show more than 20.
//   - Signed out, it answers 401 (or sends you to a sign-in page).
// Everything is read-only: only GET requests, nothing is ever sent, marked read or deleted.
//
// Pure functions, no Electron and no network: main.js fetches (with the session's cookies, to
// mail.google.com only) and features/widgets.js shapes the answer. The answer is parsed strictly:
// no DOCTYPE or entities, only the few XML entities, markup inside a text field makes that entry
// invalid, and every value is cut down to plain text. Only text reaches the new-tab page.
'use strict';

const MAX_ACCOUNT = 9; // /mail/u/0 .. /mail/u/9: more than anyone signs in to at once
const MAX_BODY = 1e6;
const MAX_ENTRIES = 20; // what the feed itself returns at most
const MESSAGE_ID = /^[0-9a-f]{6,32}$/i;
const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F';

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// An account index from a form or a stored widget: a whole number 0..9, else 0 (the first account).
function cleanAccount(v) {
  const n = typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n <= MAX_ACCOUNT ? n : 0;
}
const feedUrl = (account) => `https://mail.google.com/mail/u/${cleanAccount(account)}/feed/atom`;
const inboxUrl = (account) => `https://mail.google.com/mail/u/${cleanAccount(account)}/`;
// The only addresses Lumen ever requests for this: the inbox feed of one account, on mail.google.com, over https.
function isFeedUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  return u.protocol === 'https:' && u.hostname === 'mail.google.com' && !u.port && !u.username && !u.password && !u.search && !u.hash && /^\/mail\/u\/[0-9]\/feed\/atom$/.test(u.pathname);
}

// ---- XML text ----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
// The five XML entities and numeric references; anything else (an undeclared entity) stays as written.
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(n > 0 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return whole;
      return String.fromCodePoint(n);
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}
// The inner XML of the first <name> element in `xml`, or null. Not for nested same-name elements (the feed has none).
function inner(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`).exec(xml);
  return m ? (m[1] ?? '') : null;
}
// The text of an element: CDATA taken as is, entities decoded, and null when real markup is inside
// (a text field with elements in it is not something this feed sends; it is dropped, not guessed at).
function textOf(xml, name, max) {
  const raw = inner(xml, name);
  if (raw === null) return null;
  let out = '';
  let rest = raw;
  for (;;) {
    const i = rest.indexOf('<![CDATA[');
    if (i < 0) break;
    const j = rest.indexOf(']]>', i);
    if (j < 0) return null;
    const before = rest.slice(0, i);
    if (before.includes('<')) return null;
    out += decodeEntities(before) + rest.slice(i + 9, j);
    rest = rest.slice(j + 3);
  }
  if (rest.includes('<')) return null;
  out += decodeEntities(rest);
  return flat(out, max);
}
function attr(xml, tag, name) {
  for (const m of xml.matchAll(new RegExp(`<${tag}(\\s[^>]*)?/?>`, 'g'))) {
    const a = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(m[1] || '');
    if (a) return decodeEntities(a[2] ?? a[3] ?? '');
  }
  return null;
}
// An entry's link -> the message id (hex) Gmail puts in it (?message_id=...), or '' when it isn't a mail.google.com link.
function messageIdFromLink(href) {
  let u;
  try { u = new URL(href); } catch { return ''; }
  if (u.protocol !== 'https:' || u.hostname !== 'mail.google.com') return '';
  const id = u.searchParams.get('message_id') || '';
  return MESSAGE_ID.test(id) ? id.toLowerCase() : '';
}
// tag:gmail.google.com,2004:1234567890123456789 -> the same id in hex (what Gmail's #inbox/<id> addresses use).
function messageIdFromTag(id) {
  const m = /^tag:gmail\.google\.com,2004:(\d{1,24})$/.exec(id || '');
  if (!m) return '';
  try { const hex = BigInt(m[1]).toString(16); return MESSAGE_ID.test(hex) ? hex : ''; } catch { return ''; }
}
// "Ada Lovelace" / "ada@example.com" -> a sender line.
function parseEntry(block, { snippets = true } = {}) {
  const subject = textOf(block, 'title', 200);
  const summary = textOf(block, 'summary', 400);
  const author = inner(block, 'author');
  const name = author === null ? '' : textOf(author, 'name', 100);
  const address = author === null ? '' : textOf(author, 'email', 200);
  if (subject === null || summary === null || name === null || address === null) return null; // markup where text belongs
  const id = messageIdFromLink(attr(block, 'link', 'href') || '') || messageIdFromTag(textOf(block, 'id', 80) || '');
  if (!id) return null; // without an id there is nothing to open
  const modified = Date.parse(textOf(block, 'modified', 40) || textOf(block, 'issued', 40) || '');
  return {
    id,
    from: name || address || 'Unknown sender',
    address: /^[^\s<>@]+@[^\s<>@]+$/.test(address) ? address : '',
    subject: subject || '(no subject)',
    snippet: snippets ? flat(summary, 160) : '',
    at: Number.isFinite(modified) && modified > 0 && modified < 8.64e15 ? modified : 0,
    unread: true, // the feed lists unread messages only
  };
}

// The feed text -> { ok: true, email, unread, messages } or { ok: false, reason }.
//   reason 'html'    a web page (a sign-in page), not a feed
//   reason 'invalid' anything else that is not the feed
function parseFeed(xml, opts = {}) {
  if (typeof xml !== 'string' || xml.length > MAX_BODY) return { ok: false, reason: 'invalid' };
  const body = (xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml).replace(/^\s*<\?xml[^>]*\?>/, '').trimStart();
  if (/^<!doctype\s+html|^<html[\s>]/i.test(body)) return { ok: false, reason: 'html' };
  if (/<!doctype|<!entity/i.test(body)) return { ok: false, reason: 'invalid' }; // no DTDs: no entity tricks
  if (!/^<feed[\s>]/.test(body) || !/<\/feed\s*>\s*$/.test(body)) return { ok: false, reason: 'invalid' };
  const head = body.slice(0, body.indexOf('<entry') < 0 ? body.length : body.indexOf('<entry'));
  const title = textOf(head, 'title', 300) || '';
  const email = /\bfor\s+([^\s<>@]+@[^\s<>@]+)\s*$/.exec(title)?.[1] || '';
  const entries = [];
  for (const m of body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/g)) {
    const e = parseEntry(m[1], opts);
    if (e) entries.push(e);
    if (entries.length >= MAX_ENTRIES) break;
  }
  const full = /^\d{1,9}$/.test(textOf(head, 'fullcount', 12) || '') ? Number(textOf(head, 'fullcount', 12)) : null;
  return { ok: true, email: flat(email, 200), unread: Math.max(full ?? 0, entries.length), messages: entries };
}

// The card's data for a good answer: { state: 'ok', source: 'google', ... }; the same shape gmail-view.js
// shapes for the API, plus `account`, `email`, `unreadOnly` (this feed lists unread messages only) and `more`.
function shape(parsed, { account = 0, count = 5, snippets = true } = {}) {
  const messages = parsed.messages.slice(0, count).map((m) => (snippets ? m : { ...m, snippet: '' }));
  return {
    state: 'ok', source: 'google', unreadOnly: true,
    unread: parsed.unread, total: 0, messages,
    account: cleanAccount(account), email: parsed.email,
    open: inboxUrl(account),
  };
}

// What the card shows when it can't read the feed because nobody is signed in to Google (in Lumen): its
// button opens the sign-in in a normal tab (oneClick + google).
function signedOut(account = 0) {
  const n = cleanAccount(account);
  return {
    state: 'reconnect', google: true, oneClick: true, account: n,
    message: n === 0 ? 'Sign in to Google in Lumen to see your unread mail here. Read-only: Lumen only reads the unread list.'
      : `Lumen can’t see Google account ${n + 1}. Sign in to it in Lumen, or choose another account in Settings.`,
  };
}

// Several accounts: the e-mail address at each index (from probing each feed), duplicates and gaps dropped.
function accountList(found) {
  const seen = new Set();
  const out = [];
  for (const [i, email] of (Array.isArray(found) ? found : []).entries()) {
    const e = flat(email, 200).toLowerCase();
    if (!e || seen.has(e) || i > MAX_ACCOUNT) break;
    seen.add(e);
    out.push({ index: i, email: flat(email, 200) });
  }
  return out;
}

module.exports = { MAX_ACCOUNT, MAX_BODY, MAX_ENTRIES, SIGN_IN_URL, cleanAccount, feedUrl, inboxUrl, isFeedUrl, decodeEntities, parseFeed, shape, signedOut, accountList };
