// Gmail through the same two paths the Gmail widget uses (features/gmail-view.js, gmail-atom.js):
//  - 'oauth': the Google sign-in the widget's "Sign in with Google" made (scope gmail.readonly). Search and read a message.
//  - 'session': the Google sign-in already in Lumen, through Gmail's own unread feed. The unread list only.
// The one write is create_draft: an email put in the user's Drafts, after a click on its card, and only once the user pressed
// Allow drafts (Google's gmail.compose permission, added to the same sign-in). Nothing is ever sent, marked read or deleted:
// the draft goes through ctx.google.compose, which reaches the drafts list and nothing else (features/gmail-drafts.js).
// The service hands in ctx.google (main.js decides how it reaches Google).
'use strict';
const GV = require('../../gmail-view');
const GA = require('../../gmail-atom');
const { flat, clip, htmlToText, when, ConnectorError } = require('../util');

const NEEDS_FULL = 'This needs the full Google sign-in. Tell the user to connect Gmail again in Settings → You and AI → Connectors and finish the Google sign-in. Meanwhile unread mail can still be listed.';
const ALLOW_DRAFTS = 'Allow drafts first: Lumen needs Google’s permission to make Gmail drafts. Tell the user to open Settings → You and AI → Connectors and press Allow drafts on the Gmail card (Google asks them once), then ask again. Nothing was made.';

const line = (m) => `${m.id}  ${when(m.at ? new Date(m.at).toISOString() : '')}  ${flat(m.from, 60)}: ${flat(m.subject, 160)}${m.snippet ? ` | ${flat(m.snippet, 160)}` : ''}${m.unread ? ' [unread]' : ''}`;

async function api(ctx, path) {
  try { return await ctx.google.api(path); } catch (err) {
    if (err?.reconnect) throw ctx.authError();
    throw new ConnectorError(String(err?.message || err), 'other');
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

// What the AI is told when a draft can't be made yet: no full sign-in, or no Allow drafts. Before the card (so nobody is asked for
// nothing) and again before the request.
function draftsReady(ctx) {
  if (ctx.config.mode !== 'oauth') throw new ConnectorError(`${NEEDS_FULL} Making drafts also needs Allow drafts on the Gmail card.`, 'args');
  if (!ctx.google.drafts?.()) throw new ConnectorError(ALLOW_DRAFTS, 'auth');
}

// The message a reply answers: its thread, Message-ID, References, subject and sender (a read-only request).
async function original(ctx, id) {
  if (!GV.isMessageId(id)) throw new ConnectorError('reply_to_message_id is a message id from search or unread.', 'args');
  const q = ['Message-ID', 'References', 'Subject', 'From'].map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join('&');
  const m = await api(ctx, `/users/me/messages/${encodeURIComponent(id)}?format=metadata&${q}`);
  const header = (n) => (m?.payload?.headers || []).find((h) => String(h?.name).toLowerCase() === n)?.value || '';
  const head = GV.normalizeMessage(m);
  return { threadId: /^[0-9a-f]{6,32}$/i.test(String(m?.threadId || '')) ? String(m.threadId) : '', messageId: header('message-id'), references: header('references'), subject: head?.subject || '', from: head?.from || '' };
}

const actions = {
  async unread(ctx, { max = 10 } = {}) {
    if (ctx.config.mode === 'oauth') {
      const list = await listMessages(ctx, 'is:unread in:inbox', max);
      return list.length ? list.map(line).join('\n') : 'No unread mail.';
    }
    const res = await ctx.google.feed();
    const parsed = res.status === 200 ? GA.parseFeed(res.body) : null;
    if (!parsed?.ok) throw ctx.authError();
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

  // A draft in the user's Drafts. Never sent: the user opens it in Gmail and sends it, or not.
  async create_draft(ctx, { to, cc, subject, body, reply_to_message_id: replyTo }) {
    draftsReady(ctx);
    const GD = require('../../gmail-drafts');
    const orig = replyTo ? await original(ctx, replyTo) : null;
    if (orig && (!orig.threadId || !GD.replyHeaders(orig.messageId, ''))) throw new ConnectorError('Gmail didn’t give that message’s conversation or Message-ID, so the reply wasn’t made. A new draft (without reply_to_message_id) can still be made.', 'other');
    let raw;
    try {
      raw = GD.toRaw(GD.buildMessage({ to, cc, subject, body, inReplyTo: orig?.messageId || '', references: orig?.references || '' }));
    } catch (err) {
      if (err instanceof GD.DraftError) throw new ConnectorError(`${err.message} Nothing was made.`, 'args');
      throw err;
    }
    let email = '';
    try { email = (await ctx.google.status())?.email || ''; } catch { /* the link opens the first account */ }
    let made;
    try {
      made = await ctx.google.compose({ message: { raw, ...(orig ? { threadId: orig.threadId } : {}) } });
    } catch (err) {
      if (err?.kind === 'scope') throw new ConnectorError(ALLOW_DRAFTS, 'auth');
      // Sent, but no answer came back: Lumen doesn't try again (that could make two). The user looks first.
      if (err?.kind === 'maybe') throw new ConnectorError(`The draft may have been made; check Drafts before trying again: ${GD.draftsLink(email)} Don’t make it again unless the user says it isn’t there.`, 'other');
      if (err?.reconnect) throw ctx.authError();
      throw new ConnectorError(`${flat(String(err?.message || err), 200)} Nothing was made.`, 'other');
    }
    const msgId = /^[0-9a-f]{6,32}$/i.test(String(made?.message?.id || '')) ? String(made.message.id) : '';
    const what = `${orig ? 'Reply' : 'Draft'} to ${flat(to, 200)}: “${flat(subject, 120)}”`;
    return {
      text: `Draft made, not sent. ${what}. It is in the user’s Gmail Drafts; they review it and send it themselves from Gmail.`,
      link: GD.draftsLink(email, msgId),
      done: `Draft made: “${flat(subject, 60)}”`,
    };
  },
};

// The card: before it shows, a draft that can't be made says so (no card for nothing); for a reply, the message it answers.
async function beforeCard(ctx, action) {
  if (action === 'create_draft') draftsReady(ctx);
}
async function cardNames(ctx, action, args) {
  if (action !== 'create_draft' || !args.reply_to_message_id) return {};
  const o = await original(ctx, args.reply_to_message_id);
  return { replySubject: o.subject, replyFrom: o.from };
}
const NOTHING_SENT = 'This only makes a draft. Nothing is sent.';
function describeWhere(action, args, names = {}) {
  if (action !== 'create_draft') return '';
  const where = args.reply_to_message_id
    ? `A reply in your Gmail Drafts, in the conversation ${names.replySubject ? `“${flat(names.replySubject, 120)}”${names.replyFrom ? ` from ${flat(names.replyFrom, 60)}` : ''}` : `of message ${args.reply_to_message_id}`}.`
    : 'A new email in your Gmail Drafts.';
  return `${where}\n${NOTHING_SENT}`;
}
function describeWrite(action, args, names = {}) {
  if (action !== 'create_draft') return '';
  return `${describeWhere(action, args, names)}\n\nTo: ${args.to}${args.cc ? `\nCc: ${args.cc}` : ''}\nSubject: ${args.subject}\n\n${args.body}`;
}

module.exports = { verify, actions, beforeCard, cardNames, describeWrite, describeWhere };
