// Canvas LMS, read through the user's own signed-in Lumen session: the site's JSON endpoints (/api/v1/...) with the
// session cookies, GET only. Lumen never sees the password; a signed-out session answers 401 or a redirect, which the
// service turns into "Needs sign-in". The base address is the school's own (https://<domain>).
'use strict';
const { flat, clip, htmlToText, when, nextLink, ConnectorError } = require('../util');

const ID = /^\d{1,20}$/;
// Canvas puts "while(1);" in front of some JSON answers (a guard against script inclusion).
const parse = (res) => {
  try { return JSON.parse(String(res.text).replace(/^\s*while\s*\(\s*1\s*\)\s*;?/, '')); } catch { throw new ConnectorError('Canvas sent something Lumen couldn’t read.'); }
};

async function get(ctx, path, query) {
  const res = await ctx.http(path, { query });
  if (!res.ok) throw new ConnectorError(res.status === 404 ? 'Canvas has nothing there (check the course id).' : `Canvas answered ${res.status}.`, res.status === 404 ? 'missing' : 'other');
  return { body: parse(res), next: nextLink(res.headers.get('link')) };
}
// Follows Link: rel="next" (same site only, at most `pages` pages).
async function getAll(ctx, path, query, pages = 3) {
  const out = [];
  let url = path;
  let q = query;
  for (let i = 0; i < pages && url; i++) {
    const { body, next } = await get(ctx, url, q);
    if (!Array.isArray(body)) throw new ConnectorError('Canvas sent something unexpected.');
    out.push(...body);
    url = next;
    q = undefined;
  }
  return out;
}

async function verify(ctx) {
  const res = await ctx.http('/api/v1/users/self');
  if (!res.ok) return { status: res.status };
  const me = parse(res);
  return { status: 200, account: flat(me?.name || me?.short_name || me?.login_id, 80) };
}

async function activeCourses(ctx) {
  const list = await getAll(ctx, '/api/v1/courses', { enrollment_state: 'active', per_page: '50', 'include[]': 'term' }, 2);
  return list.filter((c) => c && ID.test(String(c.id)) && !c.access_restricted_by_date).map((c) => ({ id: String(c.id), name: flat(c.name || c.course_code, 120), code: flat(c.course_code, 40), term: flat(c.term?.name, 40) }));
}

const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };

const actions = {
  async courses(ctx) {
    const courses = await activeCourses(ctx);
    if (!courses.length) return 'No active courses.';
    return courses.map((c) => `${c.id}  ${c.name}${c.code && c.code !== c.name ? ` (${c.code})` : ''}${c.term ? ` · ${c.term}` : ''}`).join('\n');
  },

  async upcoming(ctx, { days = 14, course_id: only } = {}) {
    if (only && !ID.test(only)) throw new ConnectorError('course_id is the number from the course list.', 'args');
    const courses = only ? [{ id: only, name: `course ${only}` }] : await activeCourses(ctx);
    if (!courses.length) return 'No active courses.';
    const start = dayStart(ctx.now());
    const end = new Date(start.getTime() + days * 86400e3);
    const events = await getAll(ctx, '/api/v1/calendar_events', {
      type: 'assignment', start_date: start.toISOString(), end_date: end.toISOString(), per_page: '100', 'context_codes[]': courses.map((c) => `course_${c.id}`),
    });
    const name = new Map(courses.map((c) => [`course_${c.id}`, c.name]));
    const rows = events.filter((e) => e && (e.assignment?.due_at || e.end_at || e.start_at)).map((e) => {
      const due = e.assignment?.due_at || e.end_at || e.start_at;
      return { t: Date.parse(due) || 0, due, title: flat(e.title || e.assignment?.name, 160), course: flat(name.get(e.context_code) || e.context_name, 80), points: e.assignment?.points_possible, submitted: e.assignment?.has_submitted_submissions === true, url: flat(e.html_url, 300) };
    }).sort((a, b) => a.t - b.t);
    if (!rows.length) return `Nothing due in the next ${days} day${days === 1 ? '' : 's'}.`;
    return rows.map((r) => `${when(r.due)}  ${r.title} (${r.course})${typeof r.points === 'number' ? ` · ${r.points} pts` : ''}${r.submitted ? ' · submitted' : ''}${r.url ? `\n  ${r.url}` : ''}`).join('\n');
  },

  async announcements(ctx, { course_id: only, days = 14 } = {}) {
    if (only && !ID.test(only)) throw new ConnectorError('course_id is the number from the course list.', 'args');
    const courses = only ? [{ id: only, name: `course ${only}` }] : await activeCourses(ctx);
    if (!courses.length) return 'No active courses.';
    const start = new Date(ctx.now() - days * 86400e3);
    const list = await getAll(ctx, '/api/v1/announcements', { start_date: start.toISOString(), end_date: new Date(ctx.now() + 86400e3).toISOString(), per_page: '30', 'context_codes[]': courses.map((c) => `course_${c.id}`) }, 2);
    const name = new Map(courses.map((c) => [`course_${c.id}`, c.name]));
    const rows = list.filter((a) => a && ID.test(String(a.id))).sort((a, b) => (Date.parse(b.posted_at) || 0) - (Date.parse(a.posted_at) || 0)).slice(0, 25);
    if (!rows.length) return `No announcements in the last ${days} day${days === 1 ? '' : 's'}.`;
    return rows.map((a) => {
      const cid = String(a.context_code || '').replace(/^course_/, '') || only || '';
      return `[course ${cid}, id ${a.id}] ${when(a.posted_at, { dateOnly: true })} · ${flat(name.get(a.context_code), 60)}\n  ${flat(a.title, 160)}: ${flat(htmlToText(a.message), 220)}`;
    }).join('\n');
  },

  async announcement(ctx, { course_id: cid, id }) {
    if (!ID.test(String(cid)) || !ID.test(String(id))) throw new ConnectorError('course_id and id are the numbers shown by announcements.', 'args');
    const { body } = await get(ctx, `/api/v1/courses/${cid}/discussion_topics/${id}`);
    return `${flat(body?.title, 200)}\nPosted ${when(body?.posted_at)} by ${flat(body?.author?.display_name || body?.user_name, 80) || 'the instructor'}\n\n${clip(htmlToText(body?.message), 6000)}`;
  },
};

module.exports = { verify, actions };
