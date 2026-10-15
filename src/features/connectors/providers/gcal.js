// Google Calendar (or any calendar) through its secret iCal address, the way the Calendar widget reads one
// (features/ics.js). The address is the secret: it is stored encrypted, and requests go to that address only.
'use strict';
const { eventsBetween } = require('../../ics');
const { flat, when, ConnectorError } = require('../util');

async function load(ctx) {
  const res = await ctx.http(ctx.secret, { raw: true, accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1', max: 5e6 });
  if (res.status === 404 || res.status === 403 || res.status === 401 || res.status === 410) throw new ConnectorError('Google no longer accepts that calendar address. Copy the secret iCal address again (it changes if you reset it).', 'auth');
  if (!res.ok) throw new ConnectorError(`The calendar answered ${res.status}.`);
  if (!/BEGIN:VCALENDAR/i.test(res.text)) throw new ConnectorError('That address isn’t a calendar (.ics) feed.', 'auth');
  return res.text;
}

async function verify(ctx) {
  const res = await ctx.http(ctx.secret, { raw: true, accept: 'text/calendar, */*;q=0.1', max: 5e6 });
  if (!res.ok) return { status: res.status };
  if (!/BEGIN:VCALENDAR/i.test(res.text)) return { status: 422 };
  const name = /^X-WR-CALNAME:(.{1,100})$/im.exec(res.text)?.[1];
  return { status: 200, account: flat(name, 80) || 'Calendar' };
}

const actions = {
  async events(ctx, { days = 7 } = {}) {
    const { events } = eventsBetween(await load(ctx), { from: ctx.now(), days, limit: 60 });
    if (!events.length) return `Nothing on the calendar in the next ${days} day${days === 1 ? '' : 's'}.`;
    return events.map((e) => {
      const iso = new Date(e.start).toISOString();
      return `${e.allDay ? `${when(iso, { dateOnly: true })} (all day)` : when(iso)}  ${flat(e.title, 160)}${e.location ? ` · ${flat(e.location, 100)}` : ''}`;
    }).join('\n');
  },
};

module.exports = { verify, actions };
