// [connectors] Gmail drafts: the email the AI's Gmail connector puts in the user's Drafts (create_draft), built here as an
// RFC 5322 message for Gmail's drafts.create. Pure: no network and no Electron. Loaded only when a draft is made.
//
// Lumen makes drafts and never sends. Google's gmail.compose permission would allow sending, so the one request that
// leaves Lumen with it is checked by composePath(): only POST /users/me/drafts, and never a path with a "send" part.
//
//   parseAddresses(text)        "a@x.org, Ada <b@y.org>" -> [{ name, address }] (throws a message for a bad one)
//   encodeWords(text)           a header value: plain ASCII as it is, anything else as RFC 2047 encoded words
//   buildMessage(draft)         { to, cc?, subject, body, inReplyTo?, references? } -> the message text (CRLF lines)
//   toRaw(text)                 base64url, what Gmail's `raw` field takes
//   replyHeaders(original)      a message's Message-ID and References -> { inReplyTo, references } for a reply
//   composePath(path)           the drafts path, or throws for anything else
'use strict';

const MAX_RECIPIENTS = 50;
const MAX_BODY_BYTES = 200000; // the text of one draft (the connector's own cap on its argument is lower)
// An address: a plain local part and a domain with at least one dot. No quoted local parts, comments or IP literals.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

class DraftError extends Error {}
const refuse = (message) => { throw new DraftError(message); };

// Header text can't hold a line break (header injection: a "\r\nBcc: …" in a subject would add a header) or another control character.
function oneLine(value, what) {
  const s = typeof value === 'string' ? value : '';
  if (/[\r\n]/.test(s)) refuse(`${what} can’t have a line break in it.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) refuse(`${what} has a character that can’t go in an email header.`);
  return s;
}

function parseAddresses(text, what = 'To') {
  const s = oneLine(text, what).trim();
  if (!s) return [];
  const out = [];
  for (const part of s.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const angle = /^(.*?)\s*<([^<>\s]+)>$/.exec(p);
    const address = angle ? angle[2] : p;
    let name = angle ? angle[1].trim().replace(/^"(.*)"$/, '$1').trim() : '';
    if (!ADDRESS.test(address)) refuse(`${what}: “${address.slice(0, 80)}” isn’t an email address.`);
    if (/[<>"\\]/.test(name) || name.length > 100) refuse(`${what}: the name “${name.slice(0, 40)}” can’t be used.`);
    name = name.replace(/\s+/g, ' ');
    out.push({ name, address });
    if (out.length > MAX_RECIPIENTS) refuse(`${what}: at most ${MAX_RECIPIENTS} addresses.`);
  }
  return out;
}

// RFC 2047: text that isn't printable ASCII goes as =?UTF-8?B?…?= words of at most 75 characters each (a character's
// bytes are never split between two words), folded onto continuation lines.
function encodeWords(text) {
  const s = String(text);
  if (/^[\x20-\x7e]*$/.test(s) && !/=\?/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; } // 45 bytes -> 60 base64 characters + 12 around them
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

const formatAddress = ({ name, address }) => {
  if (!name) return address;
  return /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${address}>` : `${encodeWords(name)} <${address}>`;
};
const addressHeader = (list) => list.map(formatAddress).join(',\r\n ');

// A Message-ID (or one References entry): <…> with no spaces or angle brackets inside.
const MSG_ID = /^<[^<>\s\u0000-\u001f\u007f]{1,900}>$/;
// (Both come from Gmail's copy of the original, which may fold a long References over lines: whitespace is only a separator here,
// and only <…> ids are kept, so nothing else from them reaches the draft's headers.)
function replyHeaders(messageId, references) {
  const id = String(messageId || '').replace(/\s+/g, ' ').trim();
  if (!MSG_ID.test(id)) return null;
  const earlier = String(references || '').replace(/\s+/g, ' ').match(/<[^<>\s\u0000-\u001f\u007f]{1,900}>/g) || [];
  const refs = [...earlier.filter((r) => r !== id).slice(-19), id]; // the thread's last few, then the message replied to
  return { inReplyTo: id, references: refs.join(' ') };
}

// The text, base64 in lines of 76 (any line length and any characters are safe that way).
function bodyLines(text) {
  const b = Buffer.from(String(text).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  if (b.length > MAX_BODY_BYTES) refuse('The text is too long for one draft.');
  return b.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
}

function buildMessage({ to, cc = '', subject, body, inReplyTo = '', references = '' }) {
  const toList = parseAddresses(to, 'To');
  if (!toList.length) refuse('A draft needs at least one address in To.');
  const ccList = parseAddresses(cc, 'Cc');
  const subj = oneLine(subject, 'The subject').trim();
  if (subj.length > 250) refuse('The subject is too long.');
  if (typeof body !== 'string') refuse('The draft has no text.');
  const headers = [`To: ${addressHeader(toList)}`];
  if (ccList.length) headers.push(`Cc: ${addressHeader(ccList)}`);
  headers.push(`Subject: ${encodeWords(subj)}`);
  if (inReplyTo) {
    const r = replyHeaders(inReplyTo, references);
    if (!r) refuse('The message replied to has no usable Message-ID.');
    headers.push(`In-Reply-To: ${r.inReplyTo}`, `References: ${r.references}`);
  }
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
  return `${headers.join('\r\n')}\r\n\r\n${bodyLines(body)}\r\n`;
}

const toRaw = (text) => Buffer.from(String(text), 'utf8').toString('base64url');

// The only Gmail API path a draft goes to. Anything with a "send" part (drafts.send, messages.send) is refused outright,
// whatever else the path is, and so is every path other than the drafts list itself.
const DRAFTS_PATH = '/users/me/drafts';
function composePath(path) {
  const p = String(path || '');
  const parts = p.split(/[?#]/)[0].split('/').map((x) => { try { return decodeURIComponent(x).toLowerCase(); } catch { return x.toLowerCase(); } });
  if (parts.some((x) => x === 'send' || x.endsWith(':send'))) throw new DraftError('Lumen never sends email.');
  if (p !== DRAFTS_PATH) throw new DraftError('Not a Gmail drafts request.');
  return p;
}

module.exports = { ADDRESS, MAX_RECIPIENTS, DRAFTS_PATH, DraftError, parseAddresses, encodeWords, buildMessage, toRaw, replyHeaders, composePath };
