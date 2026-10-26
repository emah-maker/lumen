// Microsoft Calendar (Outlook calendar, Microsoft 365 or outlook.com) through the shared Microsoft sign-in (connectors/microsoft-auth.js), with
// Microsoft Graph at graph.microsoft.com. Reads: events on the user's main calendar in a window of days. Writes (each behind a card): add an event
// and change one. No attendees are ever added, so no invitation is ever emailed; Lumen never deletes events.
'use strict';
const { flat, when, ConnectorError } = require('../util');
const { MS, zone, point, shifted, span } = require('../dates');
const X = require('./_graph');

const SELECT = 'id,subject,start,end,location,isAllDay,isCancelled,webLink';
const q = (o) => `?${Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
const idOf = (id) => encodeURIComponent(String(id));

async function verify(ctx) {
  const res = await ctx.http(`/me${q({ $select: 'mail,userPrincipalName' })}`, { allowAuth: true });
  if (!res.ok) return { status: res.status, message: res.status === 403 ? X.failure(ctx, res).message : '' };
  let b = {};
  try { b = JSON.parse(res.text); } catch { /* an answer without a name */ }
  return { status: 200, account: flat(b.mail || b.userPrincipalName, 80) || ctx.email };
}

// Graph gives a wall-clock time in the zone the request asked for ("2026-11-03T14:00:00.0000000"): shown as that wall-clock time.
const wall = (d) => `${String(d?.dateTime || '').slice(0, 19)}Z`;
function line(e) {
  const allDay = e.isAllDay === true;
  const at = allDay ? `${when(wall(e.start), { dateOnly: true, timeZone: 'UTC' })} (all day)` : when(wall(e.start), { timeZone: 'UTC' });
  return `${flat(e.id, 200)}  ${at || 'no time'}  ${flat(e.subject, 160) || '(no title)'}${e.location?.displayName ? ` · ${flat(e.location.displayName, 100)}` : ''}${e.isCancelled ? ' (cancelled)' : ''}`;
}
const tzHeader = (tz) => ({ Prefer: `outlook.timezone="${tz}"` });
// A point -> Graph's { dateTime, timeZone } (an all day event is midnight to midnight, with isAllDay).
const graphPoint = (p, tz) => ({ dateTime: p.date ? `${p.date}T00:00:00` : p.dateTime, timeZone: p.timeZone || tz });

const actions = {
  async events(ctx, { days = 7, query, max = 25 } = {}) {
    const tz = zone(ctx);
    const from = ctx.now();
    const b = X.json(ctx, await ctx.http(`/me/calendarView${q({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(from + days * 86400e3).toISOString(), $orderby: 'start/dateTime', $top: query ? '100' : String(max), $select: SELECT })}`, { headers: tzHeader(tz) }), { thing: 'the calendar' });
    let items = (Array.isArray(b.value) ? b.value : []).filter((e) => !e.isCancelled);
    if (query) { const needle = String(query).toLowerCase(); items = items.filter((e) => `${e.subject || ''} ${e.location?.displayName || ''}`.toLowerCase().includes(needle)); }
    if (!items.length) return `Nothing${query ? ` matching “${flat(query, 80)}”` : ''} on the calendar in the next ${days} day${days === 1 ? '' : 's'}.`;
    return items.slice(0, max).map(line).join('\n');
  },

  async create_event(ctx, { title, start, end, location, description }) {
    const tz = zone(ctx);
    const s = point(start, 'start', tz);
    const e = span(s, end ? point(end, 'end', tz) : null, tz);
    const body = { subject: flat(title, 250), start: graphPoint(s, tz), end: graphPoint(e, tz), isAllDay: Boolean(s.date) };
    if (location) body.location = { displayName: flat(location, 300) };
    if (description) body.body = { contentType: 'Text', content: String(description).slice(0, 8000) };
    const res = await X.send('event', 'the calendar', () => ctx.http('/me/events', { method: 'POST', json: body, headers: tzHeader(tz) }));
    const b = X.json(ctx, res, { thing: 'the calendar' });
    return { text: `Added: ${line(b)}`, link: X.webLink(b.webLink), done: `Added “${flat(b.subject, 60)}”` };
  },

  async update_event(ctx, { id, title, start, end, location, description }) {
    if (title === undefined && !start && !end && location === undefined && description === undefined) throw new ConnectorError('Nothing to change: give at least one of title, start, end, location, description.', 'args');
    const tz = zone(ctx);
    const patch = {};
    if (title !== undefined) patch.subject = flat(title, 250);
    if (location !== undefined) patch.location = { displayName: flat(location, 300) };
    if (description !== undefined) patch.body = { contentType: 'Text', content: String(description).slice(0, 8000) };
    if (start || end) {
      const cur = X.json(ctx, await ctx.http(`/me/events/${idOf(id)}${q({ $select: 'start,end,isAllDay' })}`, { headers: tzHeader(tz) }), { thing: 'that event' });
      const was = (d) => (cur.isAllDay ? point(String(d?.dateTime).slice(0, 10), 'start', tz) : point(String(d?.dateTime).slice(0, 19), 'start', tz));
      const e = end ? point(end, 'end', tz) : null;
      if (start) {
        const s = point(start, 'start', tz);
        const len = cur.isAllDay ? MS.day : Date.parse(wall(cur.end)) - Date.parse(wall(cur.start));
        const to = e ? span(s, e, tz) : shifted(s, s.date ? MS.day : (len > 0 ? len : MS.hour), tz);
        Object.assign(patch, { start: graphPoint(s, tz), end: graphPoint(to, tz), isAllDay: Boolean(s.date) });
      } else {
        const keep = was(cur.start);
        Object.assign(patch, { end: graphPoint(span(keep, e, tz), tz) });
      }
    }
    const res = await X.send('change', 'the calendar', () => ctx.http(`/me/events/${idOf(id)}`, { method: 'PATCH', json: patch, headers: tzHeader(tz) }));
    const b = X.json(ctx, res, { thing: 'that event' });
    return { text: `Changed: ${line(b)}`, link: X.webLink(b.webLink), done: `Changed “${flat(b.subject, 60)}”` };
  },
};

async function cardNames(ctx, action, args) {
  if (action !== 'update_event') return {};
  const b = X.json(ctx, await ctx.http(`/me/events/${idOf(args.id)}${q({ $select: 'subject,start' })}`, { headers: tzHeader(zone(ctx)) }), { thing: 'that event' });
  return { event: flat(b.subject, 120), at: flat(String(b.start?.dateTime || '').slice(0, 16).replace('T', ' '), 40) };
}
function describeWhere(action, args, names = {}) {
  if (action === 'create_event') return 'Adds an event to your main Outlook calendar. No attendees are added and nothing is emailed.';
  if (action === 'update_event') return `Changes ${names.event ? `“${names.event}”${names.at ? ` (${names.at})` : ''}` : `the event ${String(args.id).slice(0, 40)}…`} on your main Outlook calendar. No invitation or update is emailed.`;
  return '';
}
function describeWrite(action, args, names = {}) {
  const parts = [];
  if (action === 'create_event') parts.push(`Title: ${args.title}`, `Starts: ${args.start}`, `Ends: ${args.end || (/^\d{4}-\d{2}-\d{2}$/.test(args.start) ? 'the same day (all day)' : 'one hour later')}`);
  else if (action === 'update_event') {
    if (args.title !== undefined) parts.push(`New title: ${args.title}`);
    if (args.start) parts.push(`New start: ${args.start}`);
    if (args.end) parts.push(`New end: ${args.end}`);
  } else return '';
  if (args.location) parts.push(`Place: ${args.location}`);
  if (args.description) parts.push(`Notes: ${args.description}`);
  return `${describeWhere(action, args, names)}\n\n${parts.join('\n')}`;
}

module.exports = { verify, actions, cardNames, describeWrite, describeWhere };
