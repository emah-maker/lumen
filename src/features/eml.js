// ---------- .eml files (saved emails): parsing and plain text ----------
// One parser for the viewer (features/eml-viewer.js) and for the AI (toText: headers, body and attachment list as clean
// text). The MIME work is postal-mime (MIT-0, no dependencies; headers with RFC 2047 words, multipart, quoted-printable,
// base64, charsets), loaded on first use so it costs nothing at startup. A file's content is untrusted: this module never
// runs or fetches anything. HTML is passed through as text for the viewer to sanitize and sandbox; toText converts it
// to readable text (links kept as text) and never fetches an image.
const path = require('path');

const MAX_FILE_BYTES = 50 * 1024 * 1024;   // a larger .eml is refused
const MAX_BODY_CHARS = 2 * 1024 * 1024;    // body text or HTML beyond this is cut (truncated: true)
const MAX_INLINE_IMAGE = 4 * 1024 * 1024;  // one cid: picture the viewer may embed
const MAX_INLINE_TOTAL = 16 * 1024 * 1024; // all of them together
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']); // never SVG
// Attachments that open in a tab (never run): documents, pictures, text and other emails.
const OPEN_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|avif)|text\/plain|message\/rfc822)$/i;
const OPEN_EXTS = /\.(pdf|png|jpe?g|gif|webp|bmp|avif|txt|eml)$/i;

class EmlError extends Error {}

const isEmlName = (name) => /\.eml$/i.test(String(name || '').split(/[?#]/)[0]);

let PostalMime = null;
const postal = () => PostalMime || (PostalMime = require('postal-mime').default);

const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
const cut = (s, n) => (s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false });

// "Name <a@b.c>", groups flattened.
function addressText(list) {
  const out = [];
  const walk = (a) => {
    if (!a) return;
    if (a.group) { a.group.forEach(walk); return; }
    const name = clean(a.name), addr = clean(a.address);
    out.push(name && addr && name !== addr ? `${name} <${addr}>` : addr || name);
  };
  (Array.isArray(list) ? list : [list]).forEach(walk);
  return out.filter(Boolean);
}

// A safe attachment name: no path, no control or bidi characters, bounded.
function safeName(name, fallback = 'attachment') {
  const base = clean(name).split(/[\\/]/).pop().replace(/[<>:"|?*]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || fallback;
}

// Buffer -> { model, parts }. `model` is plain JSON for the viewer; `parts[i]` is the bytes of model.attachments[i].
async function parse(buffer) {
  if (!buffer || !buffer.length) throw new EmlError('This email file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new EmlError('This email is too large to open here.');
  let mail;
  try {
    mail = await new (postal())({ attachmentEncoding: 'arraybuffer', forceRfc822Attachments: true, maxNestingDepth: 24, maxRfc822NestingDepth: 3 }).parse(buffer);
  } catch (err) {
    throw new EmlError(`The email could not be read (${clean(err && err.message).slice(0, 80) || 'bad format'}).`);
  }
  if (!mail.headers || !mail.headers.length) throw new EmlError('This file does not look like an email message.');
  const html = mail.html ? cut(mail.html, MAX_BODY_CHARS) : null;
  const text = mail.text ? cut(mail.text, MAX_BODY_CHARS) : null;
  const images = {};
  let inlineTotal = 0;
  const parts = [];
  const attachments = (mail.attachments || []).map((a, index) => {
    const bytes = a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : a.content instanceof Uint8Array ? a.content : Buffer.from(String(a.content || ''), a.encoding === 'base64' ? 'base64' : 'utf8');
    parts.push(bytes);
    const type = clean(a.mimeType).toLowerCase() || 'application/octet-stream';
    const cid = clean(a.contentId).replace(/^<|>$/g, '');
    const ext = type === 'message/rfc822' ? '.eml' : '';
    const name = safeName(a.filename, `attachment-${index + 1}${ext}`);
    if (cid && INLINE_IMAGE_TYPES.has(type) && bytes.length <= MAX_INLINE_IMAGE && inlineTotal + bytes.length <= MAX_INLINE_TOTAL) {
      inlineTotal += bytes.length;
      images[cid] = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
    }
    return { index, name, type, size: bytes.length, cid: cid || null, inline: Boolean(cid) && a.disposition !== 'attachment', openable: OPEN_TYPES.test(type) || OPEN_EXTS.test(name) };
  });
  const model = {
    subject: clean(mail.subject),
    from: addressText(mail.from), to: addressText(mail.to), cc: addressText(mail.cc), bcc: addressText(mail.bcc), replyTo: addressText(mail.replyTo),
    date: mail.date || '',
    html: html ? html.text : '', text: text ? text.text : '',
    truncated: Boolean((html && html.truncated) || (text && text.truncated)),
    images, attachments,
  };
  return { model, parts };
}

// ---- HTML -> readable text (for the AI). Regex based on purpose: nothing is parsed into a DOM, nothing is fetched.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '(c)', reg: '(R)', hellip: '...', mdash: '-', ndash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: '*', middot: '.', euro: 'EUR', trade: '(TM)' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : '';
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
});
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head|title|template|noscript|object|embed|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (m, a, b, c, inner) => {
    const href = decodeEntities(a ?? b ?? c ?? '').trim();
    const label = inner.replace(/<[^>]*>/g, '').trim();
    if (!/^(https?:|mailto:)/i.test(href)) return ` ${label} `;
    return label && label !== href ? ` ${label} (${href}) ` : ` ${href} `;
  });
  s = s.replace(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (m, a, b) => ((a ?? b ?? '').trim() ? ` [image: ${(a ?? b).trim()}] ` : ' '));
  s = s.replace(/<img\b[^>]*>/gi, ' ');
  s = s.replace(/<li\b[^>]*>/gi, '\n* ').replace(/<br\s*\/?>|<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote|li)\s*>/gi, '\n').replace(/<\/t[dh]\s*>/gi, '\t');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s).replace(/\r/g, '').replace(/[  ]+\n/g, '\n').replace(/\t+\n/g, '\n').replace(/[  ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const TEXT_ATTACHMENT = /^text\/(plain|csv|markdown)$/i;
const MAX_TEXT_ATTACHMENT = 20000;

// The email as clean text for the AI: headers, body (text part, else HTML converted), attachment list, the text of small
// text-like attachments. `limit` caps the whole result; "[truncated]" says so. Remote images are never fetched.
function toText({ model, parts }, { limit = 20000 } = {}) {
  const lines = [];
  const head = (label, value) => { if (value && value.length) lines.push(`${label}: ${Array.isArray(value) ? value.join(', ') : value}`); };
  head('From', model.from); head('To', model.to); head('Cc', model.cc); head('Reply-To', model.replyTo);
  head('Date', model.date);
  lines.push(`Subject: ${model.subject || '(no subject)'}`, '');
  const body = model.text.trim() || htmlToText(model.html) || '(no text in this email)';
  lines.push(body);
  if (model.attachments.length) {
    lines.push('', `Attachments (${model.attachments.length}):`);
    for (const a of model.attachments) lines.push(`- ${a.name} (${a.type}, ${kb(a.size)})${a.inline ? ' [inline]' : ''}`);
    for (const a of model.attachments) {
      if (!TEXT_ATTACHMENT.test(a.type) || a.size > 200000) continue;
      const t = Buffer.from(parts[a.index]).toString('utf8').replace(/\u0000/g, '');
      lines.push('', `--- ${a.name} ---`, t.length > MAX_TEXT_ATTACHMENT ? `${t.slice(0, MAX_TEXT_ATTACHMENT)}\n[attachment truncated]` : t);
    }
  }
  if (model.truncated) lines.push('', '[the email body was cut: it is very large]');
  const out = lines.join('\n');
  return out.length > limit ? `${out.slice(0, limit)}\n[truncated: ${out.length - limit} more characters]` : out;
}

// Parse a file on disk (the AI's read paths). Resolves { model, parts }.
async function parseFile(file) {
  const fs = require('fs');
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new EmlError('This is not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new EmlError('This email is too large to open here.');
  return parse(await fs.promises.readFile(file));
}

module.exports = { EmlError, MAX_FILE_BYTES, isEmlName, parse, parseFile, toText, htmlToText, safeName, kb, nameOf: (file) => path.basename(String(file)) };
