// Small helpers shared by the connectors' providers. Pure: no Electron, no network.
'use strict';

// One line of plain text: control characters gone, runs of space folded, cut at `max`.
const flat = (v, max = 300) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Text kept with its line breaks, cut at `max` with a note of how much was left out.
function clip(text, max = 6000) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}\n[… ${t.length - max} more characters left out]` : t;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '-', mdash: '-', rsquo: '\'', lsquo: '\'', rdquo: '"', ldquo: '"', hellip: '...' };
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

// HTML (a Canvas announcement, a mail part) as readable text. Nothing is rendered or run.
function htmlToText(html) {
  const s = String(html ?? '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
}

// "2026-10-14T23:59:00Z" -> "Wed Oct 14, 11:59 PM" in the given zone (the computer's own by default), or '' when it isn't a date.
function when(iso, { timeZone, dateOnly = false } = {}) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const opts = { weekday: 'short', month: 'short', day: 'numeric', ...(dateOnly ? {} : { hour: 'numeric', minute: '2-digit' }), ...(timeZone ? { timeZone } : {}) };
  try { return new Date(t).toLocaleString('en-US', opts); } catch { return new Date(t).toISOString(); }
}

// A Link header's rel="next" address, or ''.
function nextLink(header) {
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(String(header || ''));
  return m ? m[1] : '';
}

class ConnectorError extends Error {
  // kind: 'auth' (sign in again / bad token), 'rate', 'missing', 'args' (the model's input), 'other'
  constructor(message, kind = 'other') {
    super(message);
    this.name = 'ConnectorError';
    this.kind = kind;
  }
}

module.exports = { flat, clip, htmlToText, decodeEntities, when, nextLink, ConnectorError };
