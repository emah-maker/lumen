// Google Calendar through the shared Google sign-in (connectors/google-auth.js), with the Calendar API v3 at www.googleapis.com/calendar/v3.
// Reads: events on the user's main calendar (a window of days, or a search). Writes (each asks the user on a card first): add an event and
// change one. No guests are ever added and no invitation or update is ever emailed (sendUpdates is "none"); Lumen never deletes events.
// This is separate from the older secret-address calendar (gcal.js), which can only read.
'use strict';
const { flat, when, ConnectorError } = require('../util');
const G = require('./_google');

const { DAY, MS, zone, point, shifted, span } = require('../dates');

const CAL = '/calendars/primary';
const linkOf = (e) => (/^https:\/\/www\.google\.com\/calendar\//.test(String(e?.htmlLink)) ? String(e.htmlLink) : '');

async function verify(ctx) {
  // (events.list: calendar.events does not cover calendars.get, which would be refused)
  const res = await ctx.http(`${CAL}/events`, { query: { maxResults: '1', fields: 'items(id)' }, allowAuth: true });
  return res.ok ? { status: 200, account: ctx.email } : { status: res.status, message: res.status === 403 ? G.failure(ctx, res).message : '' };
}

function line(e) {
  const s = e.start || {};
  const allDay = Boolean(s.date && !s.dateTime);
  const iso = s.dateTime || (s.date ? `${s.date}T12:00:00Z` : '');
  const at = allDay ? `${when(iso, { dateOnly: true, timeZone: 'UTC' })} (all day)` : when(iso, s.timeZone ? { timeZone: s.timeZone } : {});
  return `${flat(e.id, 100)}  ${at || 'no time'}  ${flat(e.summary, 160) || '(no title)'}${e.location ? ` · ${flat(e.location, 100)}` : ''}${e.status === 'cancelled' ? ' (cancelled)' : ''}`;
}

const actions = {
  async events(ctx, { days = 7, query, max = 25 } = {}) {
    const from = ctx.now();
    const q = { timeMin: new Date(from).toISOString(), timeMax: new Date(from + days * 86400e3).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(max), fields: 'items(id,summary,location,status,start,end)' };
    if (query) q.q = query;
    const b = G.json(ctx, await ctx.http(`${CAL}/events`, { query: q }), { thing: 'the calendar' });
    const items = (Array.isArray(b.items) ? b.items : []).filter((e) => e.status !== 'cancelled');
    if (!items.length) return `Nothing${query ? ` matching “${flat(query, 80)}”` : ''} on the calendar in the next ${days} day${days === 1 ? '' : 's'}.`;
    return items.slice(0, max).map(line).join('\n');
  },

  async event(ctx, { id }) {
    const e = G.json(ctx, await ctx.http(`${CAL}/events/${encodeURIComponent(id)}`, { query: { fields: 'id,summary,description,location,status,start,end,htmlLink' } }), { thing: 'that event' });
    return `${line(e)}\nEnds: ${flat(e.end?.dateTime || e.end?.date, 40)}${e.description ? `\n\n${String(e.description).slice(0, 3000)}` : ''}`;
  },

  async create_event(ctx, { title, start, end, location, description }) {
    const tz = zone(ctx);
    const s = point(start, 'start', tz);
    const e = end ? point(end, 'end', tz) : null;
    const range = span(s, e, tz);
    const body = { summary: flat(title, 250), start: s, end: range };
    if (location) body.location = flat(location, 300);
    if (description) body.description = String(description).slice(0, 8000);
    let res;
    try { res = await ctx.http(`${CAL}/events`, { method: 'POST', query: { sendUpdates: 'none' }, json: body }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('event', 'the calendar');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('event', 'the calendar');
    const b = G.json(ctx, res, { thing: 'the calendar' });
    const link = linkOf(b);
    return { text: `Added: ${line(b)}`, link, done: `Added “${flat(b.summary, 60)}”` };
  },

  async update_event(ctx, { id, title, start, end, location, description }) {
    if (title === undefined && !start && !end && location === undefined && description === undefined) throw new ConnectorError('Nothing to change: give at least one of title, start, end, location, description.', 'args');
    const tz = zone(ctx);
    const patch = {};
    if (title !== undefined) patch.summary = flat(title, 250);
    if (location !== undefined) patch.location = flat(location, 300);
    if (description !== undefined) patch.description = String(description).slice(0, 8000);
    if (start || end) {
      const cur = G.json(ctx, await ctx.http(`${CAL}/events/${encodeURIComponent(id)}`, { query: { fields: 'start,end' } }), { thing: 'that event' });
      const s = start ? point(start, 'start', tz) : null;
      const e = end ? point(end, 'end', tz) : null;
      if (s) { // a new start with no new end keeps the event's length
        const len = cur.start?.dateTime && cur.end?.dateTime ? Date.parse(cur.end.dateTime) - Date.parse(cur.start.dateTime) : MS.day;
        patch.start = s;
        patch.end = e ? span(s, e, tz) : shifted(s, s.date ? Math.max(MS.day, len) : len, tz);
      } else {
        const keep = cur.start?.dateTime ? point(cur.start.dateTime.replace(/(?:[+-]\d{2}:\d{2}|Z)$/, '').slice(0, 19), 'start', tz) : point(cur.start?.date, 'start', tz);
        patch.end = span(keep, e, tz);
      }
    }
    let res;
    try { res = await ctx.http(`${CAL}/events/${encodeURIComponent(id)}`, { method: 'PATCH', query: { sendUpdates: 'none' }, json: patch }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('change', 'the calendar');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('change', 'the calendar');
    const b = G.json(ctx, res, { thing: 'that event' });
    const link = linkOf(b);
    return { text: `Changed: ${line(b)}`, link, done: `Changed “${flat(b.summary, 60)}”` };
  },
};

async function cardNames(ctx, action, args) {
  if (action !== 'update_event') return {};
  const b = G.json(ctx, await ctx.http(`${CAL}/events/${encodeURIComponent(args.id)}`, { query: { fields: 'summary,start' } }), { thing: 'that event' });
  return { event: flat(b.summary, 120), at: flat(b.start?.dateTime || b.start?.date, 40) };
}
function describeWhere(action, args, names = {}) {
  if (action === 'create_event') return 'Adds an event to your main Google Calendar. No guests are added and nothing is emailed.';
  if (action === 'update_event') return `Changes ${names.event ? `“${names.event}”${names.at ? ` (${names.at})` : ''}` : `the event ${args.id}`} on your main Google Calendar. No invitation or update is emailed.`;
  return '';
}
function describeWrite(action, args, names = {}) {
  const parts = [];
  if (action === 'create_event') {
    parts.push(`Title: ${args.title}`, `Starts: ${args.start}`, `Ends: ${args.end || (DAY.test(args.start) ? 'the same day (all day)' : 'one hour later')}`);
  } else if (action === 'update_event') {
    if (args.title !== undefined) parts.push(`New title: ${args.title}`);
    if (args.start) parts.push(`New start: ${args.start}`);
    if (args.end) parts.push(`New end: ${args.end}`);
  } else return '';
  if (args.location) parts.push(`Place: ${args.location}`);
  if (args.description) parts.push(`Notes: ${args.description}`);
  return `${describeWhere(action, args, names)}\n\n${parts.join('\n')}`;
}

module.exports = { verify, actions, cardNames, describeWrite, describeWhere, point };
