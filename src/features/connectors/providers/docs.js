// Google Docs through the shared Google sign-in (connectors/google-auth.js), with the Docs API v1 at docs.googleapis.com.
// Reads: the text of a document. Writes (each asks the user on a card first): make a new document (with its first text) and add text to
// the end of one. Text is inserted as plain text: a page or an email can't plant a link, a script or formatting through the AI.
'use strict';
const { flat, clip, ConnectorError } = require('../util');
const G = require('./_google');

const MAX_TEXT = 20000;

// The id out of what the AI was given: the bare id, or a docs.google.com/document/d/<id>/... address.
const idOf = (v) => (/\/document\/d\/([A-Za-z0-9_-]+)/.exec(String(v)) || /^([A-Za-z0-9_-]+)/.exec(String(v)) || [])[1] || '';
const path = (id) => `/documents/${encodeURIComponent(idOf(id))}`;
const linkOf = (id) => `https://docs.google.com/document/d/${encodeURIComponent(idOf(id))}/edit`;

// The document's text, in reading order, out of its structural elements (paragraphs, and the cells of tables and their rows).
function textOf(content, out = [], depth = 0) {
  if (!Array.isArray(content) || depth > 6) return out;
  for (const el of content) {
    if (el?.paragraph) {
      let line = '';
      for (const e of Array.isArray(el.paragraph.elements) ? el.paragraph.elements : []) if (typeof e?.textRun?.content === 'string') line += e.textRun.content;
      out.push(line.replace(/\n$/, ''));
    } else if (el?.table) {
      for (const row of Array.isArray(el.table.tableRows) ? el.table.tableRows : []) {
        const cells = [];
        for (const cell of Array.isArray(row.tableCells) ? row.tableCells : []) cells.push(textOf(cell.content, [], depth + 1).join(' ').trim());
        out.push(cells.join(' | '));
      }
    }
  }
  return out;
}

async function verify(ctx) {
  // Docs has no request that asks nothing of any document: asking for one that can't exist proves the sign-in and the API are on (404, not 401 or 403).
  const res = await ctx.http('/documents/lumen-check-0000000000', { allowAuth: true });
  if (res.status === 404 || res.status === 400) return { status: 200, account: ctx.email };
  if (res.status === 403) { const e = G.errorOf(res.text); return { status: 403, message: /accessNotConfigured|SERVICE_DISABLED/i.test(e.reason) ? 'The Google Docs API isn’t turned on in the Google Cloud project Lumen signs in with. With your own Google Cloud client, enable the Google Docs API there.' : '' }; }
  return { status: res.status };
}

const needText = (text, what) => {
  const t = String(text ?? '');
  if (!t.trim()) throw new ConnectorError(`${what} is empty. Nothing was written.`, 'args');
  if (t.length > MAX_TEXT) throw new ConnectorError(`At most ${MAX_TEXT} characters at a time. Nothing was written.`, 'args');
  return t.replace(/\r\n?/g, '\n');
};

async function write(ctx, what, where, request) {
  let res;
  try { res = await request(); } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe(what, where);
    throw err;
  }
  if (res.status >= 500 || res.status === 408) throw G.maybe(what, where);
  return res;
}

const actions = {
  async read(ctx, { id }) {
    const b = G.json(ctx, await ctx.http(path(id), { query: { fields: 'title,body.content' } }), { thing: 'that document' });
    const text = textOf(b.body?.content).join('\n').trim();
    return `${flat(b.title, 200)}\n${linkOf(id)}\n\n${text ? clip(text, 12000) : '(empty document)'}`;
  },

  async create(ctx, { title, body }) {
    const text = body ? needText(body, 'body') : '';
    const res = await write(ctx, 'document', 'Google Drive', () => ctx.http('/documents', { method: 'POST', json: { title: flat(title, 200) } }));
    const d = G.json(ctx, res, { thing: 'Google Docs' });
    const newId = flat(d.documentId, 100);
    if (text && newId) {
      const r2 = await ctx.http(`/documents/${encodeURIComponent(newId)}:batchUpdate`, { method: 'POST', json: { requests: [{ insertText: { location: { index: 1 }, text } }] } }).catch(() => null);
      if (!r2?.ok) return { text: `Made the document “${flat(d.title, 200)}” (id ${newId}) but couldn’t put the text in it. Tell the user; don’t make it again.`, link: linkOf(newId), done: `Made “${flat(d.title, 60)}” (empty)` };
    }
    return { text: `Made the document “${flat(d.title, 200)}” (id ${newId}).`, link: newId ? linkOf(newId) : '', done: `Made “${flat(d.title, 60)}”` };
  },

  async append(ctx, { id, text }) {
    const t = needText(text, 'text');
    const res = await write(ctx, 'text', 'the document', () => ctx.http(`${path(id)}:batchUpdate`, { method: 'POST', json: { requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text: t.startsWith('\n') ? t : `\n${t}` } }] } }));
    G.json(ctx, res, { thing: 'that document' });
    return { text: 'Added the text to the end of the document.', link: linkOf(id), done: 'Added text' };
  },
};

async function beforeCard(ctx, action, args) {
  if (action === 'create' && args.body) needText(args.body, 'body');
  if (action === 'append') needText(args.text, 'text');
}
async function cardNames(ctx, action, args) {
  if (action !== 'append') return {};
  const b = G.json(ctx, await ctx.http(path(args.id), { query: { fields: 'title' } }), { thing: 'that document' });
  return { doc: flat(b.title, 120) };
}
function describeWhere(action, args, names = {}) {
  if (action === 'append') return `Adds the text below to the end of ${names.doc ? `“${names.doc}”` : `the document ${idOf(args.id)}`} in your Google Docs. Existing text is not changed.`;
  if (action === 'create') return 'Makes a new document in your Google Drive.';
  return '';
}
function describeWrite(action, args, names = {}) {
  if (action === 'append') return `${describeWhere(action, args, names)}\n\n${args.text}`;
  if (action === 'create') return `${describeWhere(action, args, names)}\n\nTitle: ${args.title}${args.body ? `\n\n${args.body}` : ''}`;
  return '';
}

module.exports = { verify, actions, beforeCard, cardNames, describeWrite, describeWhere, textOf };
