// Gmail, read-only, through the same two paths the Gmail widget uses (features/gmail-view.js, gmail-atom.js):
//  - 'oauth': the Google sign-in the widget's "Sign in with Google" made (scope gmail.readonly). Search and read a message.
//  - 'session': the Google sign-in already in Lumen, through Gmail's own unread feed. The unread list only.
// Nothing is ever sent, marked read or deleted. The service hands in ctx.google (main.js decides how it reaches Google).
'use strict';
const GV = require('../../gmail-view');
const GA = require('../../gmail-atom');
const { flat, clip, htmlToText, when, ConnectorError } = require('../util');

const NEEDS_FULL = 'This needs the full Google sign-in. Tell the user to connect Gmail again in Settings → You and AI → Connectors and finish the Google sign-in. Meanwhile unread mail can still be listed.';

const line = (m) => `${m.id}  ${when(m.at ? new Date(m.at).toISOString() : '')}  ${flat(m.from, 60)}: ${flat(m.subject, 160)}${m.snippet ? ` | ${flat(m.snippet, 160)}` : ''}${m.unread ? ' [unread]' : ''}`;

async function api(ctx, path) {
  try { return await ctx.google.api(path); } catch (err) {
    throw new ConnectorError(String(err?.message || err), err?.reconnect ? 'auth' : 'other');
  }
}

async function listMessages(ctx, q, max) {
  const params = new URLSearchParams({ maxResults: String(max), fields: 'messages/id' });
  if (q) params.set('q', q);
  const ids = GV.messageIds(await api(ctx, `/users/me/messages?${params}`), max);
  const got = await Promise.all(ids.map((id) => api(ctx, GV.messagePath(id)).catch(() => null)));
  return got.filter(Boolean).map((m) => GV.normalizeMessage(m)).filter(Boolean);
}

async function verify(ctx) {
  const st = await ctx.google.status();
  if (st.oauth) return { status: 200, account: flat(st.email, 80), mode: 'oauth' };
  if (st.session) return { status: 200, account: flat(st.email, 80), mode: 'session' };
  return { status: 401 };
}

// A message's text: the plain part if there is one, else the HTML one as text.
function bodyOf(payload) {
  const found = { plain: '', html: '' };
  const walk = (p, depth = 0) => {
    if (!p || depth > 8) return;
    const data = p.body?.data;
    if (data && /^text\/(plain|html)/.test(p.mimeType || '')) {
      const text = Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (p.mimeType.startsWith('text/plain')) found.plain ||= text; else found.html ||= text;
    }
    for (const child of Array.isArray(p.parts) ? p.parts : []) walk(child, depth + 1);
  };
  walk(payload);
  return found.plain || htmlToText(found.html);
}

const actions = {
  async unread(ctx, { max = 10 } = {}) {
    if (ctx.config.mode === 'oauth') {
      const list = await listMessages(ctx, 'is:unread in:inbox', max);
      return list.length ? list.map(line).join('\n') : 'No unread mail.';
    }
    const res = await ctx.google.feed();
    if (res.status !== 200) throw new ConnectorError('Google isn’t signed in in Lumen. Sign in to Google in a Lumen tab.', 'auth');
    const parsed = GA.parseFeed(res.body);
    if (!parsed.ok) throw new ConnectorError('Google isn’t signed in in Lumen. Sign in to Google in a Lumen tab.', 'auth');
    const list = parsed.messages.slice(0, max);
    return list.length ? `${parsed.unread} unread in all.\n${list.map(line).join('\n')}` : 'No unread mail.';
  },

  async search(ctx, { query, max = 10 }) {
    if (ctx.config.mode !== 'oauth') throw new ConnectorError(NEEDS_FULL, 'args');
    const list = await listMessages(ctx, query, max);
    return list.length ? list.map(line).join('\n') : 'No messages match.';
  },

  async message(ctx, { id }) {
    if (ctx.config.mode !== 'oauth') throw new ConnectorError(NEEDS_FULL, 'args');
    if (!GV.isMessageId(id)) throw new ConnectorError('id is a message id from search or unread.', 'args');
    const m = await api(ctx, `/users/me/messages/${encodeURIComponent(id)}?format=full`);
    const head = GV.normalizeMessage(m);
    const header = (n) => flat(GV.decodeWords(flat((m.payload?.headers || []).find((h) => String(h?.name).toLowerCase() === n)?.value, 600)), 300);
    return `From: ${header('from')}\nTo: ${header('to')}\nDate: ${header('date')}\nSubject: ${head?.subject || header('subject')}\n\n${clip(bodyOf(m.payload) || m.snippet || '(no text)', 6000)}`;
  },
};

module.exports = { verify, actions };
