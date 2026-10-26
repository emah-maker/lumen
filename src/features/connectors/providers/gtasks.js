// Google Tasks through the shared Google sign-in (connectors/google-auth.js), with the Tasks API v1 at tasks.googleapis.com.
// Reads: the task lists and the tasks in one. Writes (each asks the user on a card first): add a task and mark one done. Lumen never deletes tasks.
'use strict';
const { flat, ConnectorError } = require('../util');
const G = require('./_google');

const DEFAULT_LIST = '@default';
const listPath = (id) => `/lists/${encodeURIComponent(id || DEFAULT_LIST)}`;

async function verify(ctx) {
  const res = await ctx.http('/users/@me/lists', { query: { maxResults: '1', fields: 'items(id)' }, allowAuth: true });
  return res.ok ? { status: 200, account: ctx.email } : { status: res.status, message: res.status === 403 ? G.failure(ctx, res).message : '' };
}

// "2026-11-03" (a day, the only thing Tasks keeps of a due date) -> what Google wants.
function dueOf(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new ConnectorError('due must be a date like 2026-11-03. Nothing was added.', 'args');
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
}

const line = (t) => `${flat(t.id, 100)}  ${t.status === 'completed' ? '[done] ' : ''}${flat(t.title, 200) || '(no title)'}${t.due ? ` · due ${flat(t.due, 10)}` : ''}${t.notes ? ` · ${flat(t.notes, 120)}` : ''}`;

const actions = {
  async lists(ctx) {
    const b = G.json(ctx, await ctx.http('/users/@me/lists', { query: { maxResults: '50', fields: 'items(id,title)' } }), { thing: 'Google Tasks' });
    const items = Array.isArray(b.items) ? b.items : [];
    return items.length ? items.map((l) => `${flat(l.id, 100)}  ${flat(l.title, 100)}`).join('\n') : 'No task lists.';
  },

  async tasks(ctx, { list_id: listId, done = '' } = {}) {
    const q = { maxResults: '100', showCompleted: done === 'yes' ? 'true' : 'false', showHidden: 'false', fields: 'items(id,title,notes,due,status)' };
    const b = G.json(ctx, await ctx.http(`${listPath(listId)}/tasks`, { query: q }), { thing: 'that task list' });
    const items = Array.isArray(b.items) ? b.items : [];
    return items.length ? items.slice(0, 100).map(line).join('\n') : 'No tasks.';
  },

  async add_task(ctx, { title, notes, due, list_id: listId }) {
    const body = { title: flat(title, 1024) };
    if (notes) body.notes = String(notes).slice(0, 8000);
    if (due) body.due = dueOf(due);
    let res;
    try { res = await ctx.http(`${listPath(listId)}/tasks`, { method: 'POST', json: body }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('task', 'Google Tasks');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('task', 'Google Tasks');
    const t = G.json(ctx, res, { thing: 'that task list' });
    return { text: `Added: ${line(t)}`, link: 'https://tasks.google.com/tasks/', done: `Added “${flat(t.title, 60)}”` };
  },

  async complete_task(ctx, { id, list_id: listId }) {
    const res = await ctx.http(`${listPath(listId)}/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', json: { status: 'completed' } });
    if (res.status >= 500 || res.status === 408) throw G.maybe('change', 'Google Tasks');
    const t = G.json(ctx, res, { thing: 'that task' });
    return { text: `Marked done: ${line(t)}`, link: 'https://tasks.google.com/tasks/', done: `Marked “${flat(t.title, 60)}” done` };
  },
};

async function beforeCard(ctx, action, args) {
  if (action === 'add_task' && args.due) dueOf(args.due);
}
async function cardNames(ctx, action, args) {
  if (action !== 'complete_task') return {};
  const t = G.json(ctx, await ctx.http(`${listPath(args.list_id)}/tasks/${encodeURIComponent(args.id)}`, { query: { fields: 'title' } }), { thing: 'that task' });
  return { task: flat(t.title, 160) };
}
function describeWhere(action, args) {
  if (action === 'add_task') return `Adds a task to ${args.list_id ? `the Google Tasks list ${args.list_id}` : 'your default Google Tasks list'}.`;
  if (action === 'complete_task') return 'Marks a task done in your Google Tasks.';
  return '';
}
function describeWrite(action, args, names = {}) {
  if (action === 'add_task') return `${describeWhere(action, args)}\n\nTask: ${args.title}${args.due ? `\nDue: ${args.due}` : ''}${args.notes ? `\nNotes: ${args.notes}` : ''}`;
  if (action === 'complete_task') return `${describeWhere(action, args)}\n\nTask: ${names.task || args.id}`;
  return '';
}

module.exports = { verify, actions, beforeCard, cardNames, describeWrite, describeWhere };
