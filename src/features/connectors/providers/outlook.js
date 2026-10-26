// Outlook mail (Microsoft 365 or outlook.com) through the shared Microsoft sign-in (connectors/microsoft-auth.js), with Microsoft Graph at
// graph.microsoft.com. Reads: unread mail, a search, one message's text. One write, behind a card: make a draft in the Drafts folder.
// Lumen never sends, moves or deletes mail (the permission Mail.ReadWrite could, which is why this file only ever makes a draft).
'use strict';
const { flat, clip, htmlToText, when, ConnectorError } = require('../util');
const X = require('./_graph');

const SELECT = 'id,subject,from,receivedDateTime,bodyPreview,isRead';
const q = (o) => `?${Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`; // ($ stays a $: Graph's own spelling)
const idOf = (id) => encodeURIComponent(String(id));

async function verify(ctx) {
  const res = await ctx.http(`/me${q({ $select: 'mail,userPrincipalName' })}`, { allowAuth: true });
  if (!res.ok) return { status: res.status, message: res.status === 403 ? X.failure(ctx, res).message : '' };
  let b = {};
  try { b = JSON.parse(res.text); } catch { /* an answer without a name */ }
  return { status: 200, account: flat(b.mail || b.userPrincipalName, 80) || ctx.email };
}

const who = (a) => flat(a?.emailAddress?.name, 60) || flat(a?.emailAddress?.address, 80) || 'unknown';
const line = (m) => `${flat(m.id, 200)}  ${when(m.receivedDateTime)}  ${who(m.from)}: ${flat(m.subject, 160) || '(no subject)'}${m.bodyPreview ? ` — ${flat(m.bodyPreview, 100)}` : ''}`;

// "a@x.org, Ada Lovelace <b@y.org>" -> Graph recipients.
function recipients(text) {
  return String(text || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^(?:"?([^<>"]*?)"?\s*)?<([^<>\s]+)>$/.exec(p);
    const address = m ? m[2] : p;
    const name = m ? flat(m[1], 100) : '';
    return { emailAddress: { address, ...(name ? { name } : {}) } };
  });
}

const actions = {
  async unread(ctx, { max = 10 } = {}) {
    const b = X.json(ctx, await ctx.http(`/me/mailFolders/inbox/messages${q({ $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false', $orderby: 'receivedDateTime desc', $top: String(max), $select: SELECT })}`), { thing: 'the inbox' });
    const items = Array.isArray(b.value) ? b.value : [];
    return items.length ? items.map(line).join('\n') : 'No unread mail.';
  },

  async search(ctx, { query, max = 10 }) {
    const term = String(query).replace(/["\\]/g, ' ').trim();
    const b = X.json(ctx, await ctx.http(`/me/messages${q({ $search: `"${term}"`, $top: String(max), $select: SELECT })}`), { thing: 'your mail' });
    const items = Array.isArray(b.value) ? b.value : [];
    return items.length ? items.map(line).join('\n') : `No mail matches “${flat(query, 80)}”.`;
  },

  async message(ctx, { id }) {
    const b = X.json(ctx, await ctx.http(`/me/messages/${idOf(id)}${q({ $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments' })}`, { headers: { Prefer: 'outlook.body-content-type="text"' } }), { thing: 'that message' });
    const to = (Array.isArray(b.toRecipients) ? b.toRecipients : []).slice(0, 10).map(who).join(', ');
    const cc = (Array.isArray(b.ccRecipients) ? b.ccRecipients : []).slice(0, 10).map(who).join(', ');
    const text = b.body?.contentType === 'html' ? htmlToText(b.body.content) : String(b.body?.content ?? '');
    return `From: ${who(b.from)}\nTo: ${to || '-'}${cc ? `\nCc: ${cc}` : ''}\nDate: ${when(b.receivedDateTime)}\nSubject: ${flat(b.subject, 250)}${b.hasAttachments ? '\n(has attachments, not read)' : ''}\n\n${clip(text, 8000)}`;
  },

  async create_draft(ctx, { to, cc, subject, body }) {
    const toList = recipients(to);
    if (!toList.length) throw new ConnectorError('to is empty. Nothing was made.', 'args');
    const msg = { subject: flat(subject, 250), body: { contentType: 'Text', content: String(body).replace(/\r\n?/g, '\n') }, toRecipients: toList, ...(cc ? { ccRecipients: recipients(cc) } : {}) };
    const res = await X.send('draft', 'your Outlook Drafts folder', () => ctx.http('/me/messages', { method: 'POST', json: msg }));
    const b = X.json(ctx, res, { thing: 'Outlook' });
    return { text: `Made a draft “${flat(b.subject, 120)}” in the Outlook Drafts folder. It was not sent: the user sends it from Outlook.`, link: X.webLink(b.webLink), done: 'Draft created' };
  },
};

function describeWhere(action) {
  return action === 'create_draft' ? 'Puts an email in your Outlook Drafts folder. It is never sent: you send it from Outlook.' : '';
}
function describeWrite(action, args) {
  if (action !== 'create_draft') return '';
  return `${describeWhere(action)}\n\nTo: ${args.to}${args.cc ? `\nCc: ${args.cc}` : ''}\nSubject: ${args.subject}\n\n${args.body}`;
}

module.exports = { verify, actions, describeWrite, describeWhere, recipients };
