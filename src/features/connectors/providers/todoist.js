// Todoist through the user's API token, api.todoist.com only (the unified v1 API). Reads tasks and projects;
// adding a task is the one write, and the AI asks the user first.
'use strict';
const { flat, ConnectorError } = require('../util');

async function call(ctx, path, opts) {
  const res = await ctx.http(path, opts);
  if (res.status === 401 || res.status === 403) throw new ConnectorError('Todoist refused the token. Connect Todoist again with a new one.', 'auth');
  if (res.status === 429) throw new ConnectorError('Todoist is limiting requests right now. Try again in a minute.', 'rate');
  if (res.status === 400) throw new ConnectorError(`Todoist didn’t accept that: ${flat(res.text, 160)}`, 'args');
  if (!res.ok) throw new ConnectorError(`Todoist answered ${res.status}.`);
  try { return JSON.parse(res.text); } catch { throw new ConnectorError('Todoist sent something unexpected.'); }
}
const results = (body) => (Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : []);

async function verify(ctx) {
  const res = await ctx.http('/user');
  if (!res.ok) return { status: res.status };
  let me = {};
  try { me = JSON.parse(res.text); } catch { /* an answer without a name */ }
  return { status: 200, account: flat(me.email || me.full_name, 80) };
}

const due = (t) => (t.due ? ` · due ${flat(t.due.datetime || t.due.date || t.due.string, 30)}` : '');
const line = (t) => `${flat(t.id, 30)}  ${flat(t.content, 200)}${due(t)}${t.priority > 1 ? ` · p${5 - t.priority}` : ''}`;

const actions = {
  async tasks(ctx, { filter, project_id: project } = {}) {
    const query = project ? { project_id: project, limit: '50' } : { query: filter || 'today | overdue', limit: '50' };
    const list = results(await call(ctx, project ? '/tasks' : '/tasks/filter', { query }));
    return list.length ? list.slice(0, 50).map(line).join('\n') : 'No tasks match.';
  },

  async projects(ctx) {
    const list = results(await call(ctx, '/projects', { query: { limit: '100' } }));
    return list.length ? list.map((p) => `${flat(p.id, 30)}  ${flat(p.name, 80)}`).join('\n') : 'No projects.';
  },

  async add_task(ctx, { content, due: dueString, project_id: project }) {
    const body = { content };
    if (dueString) body.due_string = dueString;
    if (project) body.project_id = project;
    const t = await call(ctx, '/tasks', { method: 'POST', json: body });
    return `Added: ${line(t)}`;
  },
};

// What the confirm card shows before add_task runs.
const describeWrite = (action, args) => (action === 'add_task' ? `Add this task to Todoist:\n${args.content}${args.due ? `\nDue: ${args.due}` : ''}${args.project_id ? `\nProject id: ${args.project_id}` : ''}` : '');

module.exports = { verify, actions, describeWrite };
