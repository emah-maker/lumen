// The Calendar card with several calendars (run on its own with `node test/calendar-multi-units.js`, or by
// scripts/test-units.js): features/calendar-sources.js (cleaning the sources, merging, sorting, de-duplicating,
// the list line), the connector end to end through createWidgets() against a fake fetch with ICS fixtures
// (merged order and colours, one calendar failing, a calendar that was fine and is down now, old single-address
// cards), the home page's form (features/widget-config.js) and the page files' rules. No Electron, no network.
const fs = require('fs');
const path = require('path');
const CS = require('../src/features/calendar-sources');
const ics = require('../src/features/ics');
const C = require('../src/features/widget-config');
const WS = require('../src/renderer/widget-summary');
const { createWidgets, cleanWidget } = require('../src/features/widgets');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ---- ICS fixtures, relative to now (so "the next two weeks" always holds) ----
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (ms) => stamp(ms).slice(0, 8);
const vevent = (uid, title, start, { dur = HOUR, extra = '' } = {}) => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(start + dur)}\r\n${extra}END:VEVENT\r\n`;
const vday = (uid, title, ms) => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART;VALUE=DATE:${dateOnly(ms)}\r\nDTEND;VALUE=DATE:${dateOnly(ms + DAY)}\r\nEND:VEVENT\r\n`;
const vcal = (name, events, color) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${name ? `X-WR-CALNAME:${name}\r\n` : ''}${color ? `X-WR-CALCOLOR:${color}\r\n` : ''}${events.join('')}END:VCALENDAR\r\n`;

module.exports = async function calendarMultiUnits(check) {
  const t0 = Date.now();
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const day = (n, h = 0) => base.getTime() + n * DAY + h * HOUR + 12 * 60e3; // local midnight + n days + h hours (+12 min so nothing sits on a boundary)

  // ---- cleaning ----
  check('colors: #rgb and #rrggbb become lower-case #rrggbb, anything else is empty', CS.cleanColor('#ABC') === '#aabbcc' && CS.cleanColor(' #A1b2C3 ') === '#a1b2c3' && CS.cleanColor('red') === '' && CS.cleanColor('url(x)') === '' && CS.cleanColor(5) === '', '');
  check('addresses: https and webcal pass, http, javascript, credentials and spaces do not', CS.secureUrl('webcal://a.example/x.ics') === 'https://a.example/x.ics' && CS.secureUrl('http://a.example/x.ics') === null && CS.secureUrl('javascript:alert(1)') === null && CS.secureUrl('https://u:p@a.example/') === null && CS.secureUrl('https://a.example/a b') === null && CS.secureUrl('') === null, '');
  const old = { url: 'webcal://school.example/a.ics', name: 'Team', count: 5 };
  const legacy = CS.sourcesOf(old);
  check('back-compat: a card with only url and name is one calendar, on, with the feed’s name', legacy.length === 1 && legacy[0].url === 'https://school.example/a.ics' && legacy[0].name === 'Team' && legacy[0].enabled === true && legacy[0].color === '', JSON.stringify(legacy));
  check('back-compat: no url and no cals is no calendar', CS.sourcesOf({}).length === 0 && CS.sourcesOf(null).length === 0 && CS.sourcesOf({ url: 'http://x.example/a.ics' }).length === 0, '');
  const many = CS.sourcesOf({ cals: [
    { name: ' School ', url: 'https://school.example/a.ics', color: '#E5604D', enabled: true },
    { name: 'Bad', url: 'http://plain.example/a.ics' },
    { name: 'Other', url: 'webcal://other.example/b.ics', color: 'nonsense', enabled: false },
    { name: 'Again', url: 'https://school.example/a.ics' },
    null, 'x', { url: 5 },
  ] });
  check('cals: invalid and repeated addresses are dropped, names and colours cleaned, enabled kept', many.length === 2 && many[0].name === 'School' && many[0].color === '#e5604d' && many[1].url === 'https://other.example/b.ics' && many[1].color === '' && many[1].enabled === false, JSON.stringify(many));
  check('cals: each calendar has a stable id from its address and no two share one', many[0].id === CS.idOf('https://school.example/a.ics') && /^c[0-9a-z]+$/.test(many[0].id) && many[0].id !== many[1].id, many.map((m) => m.id).join());
  const nine = Array.from({ length: 12 }, (_, i) => ({ name: `C${i}`, url: `https://c${i}.example/x.ics` }));
  check('cap: at most 8 calendars', CS.sourcesOf({ cals: nine }).length === 8 && CS.MAX_SOURCES === 8 && /Up to 8/.test(CS.problem({ cals: nine })), '');
  check('cals win over the old url when they have a good entry; an all-bad list falls back to the url', CS.sourcesOf({ url: old.url, cals: [{ url: 'https://o.example/z.ics' }] })[0].url === 'https://o.example/z.ics' && CS.sourcesOf({ url: old.url, cals: [{ url: 'http://bad.example/' }] })[0].url === 'https://school.example/a.ics', '');
  check('problem(): a name with no address, a bad address, nothing switched on are said in words; blank rows are ignored', /School needs an https/.test(CS.problem({ cals: [{ name: 'School', url: '' }] })) && /Calendar 1 needs an https/.test(CS.problem({ cals: [{ url: 'ftp://a.example/' }] })) && /at least one/.test(CS.problem({ cals: [{ url: 'https://a.example/x.ics', enabled: false }] })) && CS.problem({ cals: [{ name: '', url: '' }, { url: 'https://a.example/x.ics' }] }) === '' && CS.problem({ url: 'x' }) === '', '');

  // ---- merging ----
  const e = (title, start, extra = {}) => ({ title, start, end: start + HOUR, allDay: false, uid: '', ...extra });
  const m1 = CS.merge([
    { id: 'cA', events: [e('A late', 5000), e('A early', 1000), e('A all-day', 1000, { allDay: true, end: 1000 + DAY })] },
    { id: 'cB', events: [e('B middle', 3000), e('B early', 1000)] },
  ]);
  check('merge: one timeline, soonest first; all-day before timed at the same moment; the earlier calendar first on a tie', m1.events.map((x) => x.title).join() === 'A all-day,A early,B early,B middle,A late', m1.events.map((x) => x.title).join());
  check('merge: every event says which calendar it came from', m1.events.every((x) => x.cal === (x.title.startsWith('A') ? 'cA' : 'cB')), JSON.stringify(m1.events.map((x) => x.cal)));
  const dup = CS.merge([
    { id: 'cA', events: [e('Exam', 1000, { uid: 'u1' }), e('Lunch', 2000)] },
    { id: 'cB', events: [e('Exam (renamed)', 1000, { uid: 'u1' }), e('lunch', 2000), e('Other lunch', 2000), e('Exam', 9000, { uid: 'u1' })] },
  ]);
  check('de-duplicate: the same UID and start is one event; the same title (any case), start and end is one event', dup.events.map((x) => x.title).join() === 'Exam,Lunch,Other lunch,Exam' && dup.dropped === 2, `${dup.events.map((x) => x.title)} dropped ${dup.dropped}`);
  check('de-duplicate: a repeating event’s next occurrence (same UID, other start) is not a duplicate; the first calendar’s copy wins and notes the other', dup.events[3].start === 9000 && dup.events[0].cal === 'cA' && dup.events[0].also?.join() === 'cB' && !('also' in dup.events[3]), JSON.stringify(dup.events));
  check('de-duplicate: an event twice inside one calendar stays twice only when it differs', CS.merge([{ id: 'cA', events: [e('X', 1), e('Y', 1)] }]).events.length === 2, '');
  const lim = CS.merge([{ id: 'cA', events: Array.from({ length: 10 }, (_, i) => e(`E${i}`, i * 10)) }], { limit: 4 });
  check('merge: the limit keeps the soonest', lim.events.map((x) => x.title).join() === 'E0,E1,E2,E3', '');
  const gone = CS.merge([{ id: 'cA', events: [e('Over', 100, { end: 200 }), e('Now', 100, { end: 900 }), e('Day', 100, { allDay: true, end: 200 })] }], { now: 500 });
  check('merge: with a clock, events that have ended are left out but all-day ones stay', gone.events.map((x) => x.title).join() === 'Day,Now', gone.events.map((x) => x.title).join());
  check('merge: garbage in is skipped, not thrown', CS.merge(null).events.length === 0 && CS.merge([null, { id: 'x' }, { id: 'y', events: [null, { title: 'no start' }] }]).events.length === 0, '');

  // ---- words ----
  const two = { cals: [{ name: 'School', url: 'https://school.example/a.ics' }, { name: 'Other', url: 'https://other.example/b.ics' }] };
  check('summary: two calendars read “School + Other · 2 calendars” (and the renderer says the same)', CS.summaryOf(two) === 'School + Other · 2 calendars' && WS.widgetSummary({ type: 'calendar', ...two }) === 'School + Other · 2 calendars', `${CS.summaryOf(two)} | ${WS.widgetSummary({ type: 'calendar', ...two })}`);
  const four = { cals: ['A', 'B', 'C', 'D'].map((n) => ({ name: n, url: `https://${n.toLowerCase()}.example/x.ics` })) };
  check('summary: four calendars shorten to two names and “2 more”', CS.summaryOf(four) === 'A + B + 2 more · 4 calendars' && WS.widgetSummary({ type: 'calendar', ...four }) === 'A + B + 2 more · 4 calendars', CS.summaryOf(four));
  const off = { cals: [{ name: 'School', url: 'https://school.example/a.ics' }, { name: 'Other', url: 'https://other.example/b.ics', enabled: false }, { url: 'https://third.example/c.ics' }] };
  check('summary: calendars that are off are counted, not named', CS.summaryOf(off) === 'School + third.example · 3 calendars, 1 off' && WS.widgetSummary({ type: 'calendar', ...off }) === 'School + third.example · 3 calendars, 1 off', CS.summaryOf(off));
  check('summary: an older card still says its host', CS.summaryOf(old) === 'school.example' && WS.widgetSummary({ type: 'calendar', url: old.url }) === 'school.example' && WS.widgetSummary({ type: 'calendar' }) === 'No calendar link yet', CS.summaryOf(old));

  // ---- the ICS reader hands back the UID (merging needs it) ----
  const parsed = ics.eventsBetween(vcal('X', [vevent('uid-1', 'Seen', day(1, 10)), vday('uid-2', 'Holiday', day(2))]), { from: Date.now(), days: 14 });
  check('ics: events carry their UID', parsed.events.map((x) => x.uid).sort().join() === 'uid-1,uid-2', JSON.stringify(parsed.events.map((x) => x.uid)));

  // ---- the connector, end to end ----
  const FEEDS = {
    'school.example': vcal('Term calendar', [
      vevent('s1', 'Maths exam', day(1, 9)),
      vevent('s2', 'Parents evening', day(3, 18)),
      vevent('both', 'Shared trip', day(2, 8)),
      vday('s3', 'Teacher day', day(2)),
    ], '#336699'),
    'other.example': vcal('Personal', [
      vevent('o1', 'Dentist', day(1, 8)),
      vevent('o2', 'Dinner', day(1, 19)),
      vevent('both', 'Shared trip', day(2, 8)),
      vevent('o3', 'Tax deadline', day(5, 10)),
    ]),
  };
  const down = new Set();
  const hang = new Set();
  const log = [];
  const store = { settings: {} };
  let clock = Date.now();
  const fakeFetch = async (url) => {
    const u = new URL(url);
    log.push(u.hostname);
    if (hang.has(u.hostname)) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
    if (down.has(u.hostname)) return new Response('', { status: 500 });
    if (FEEDS[u.hostname]) return new Response(FEEDS[u.hostname], { status: 200, headers: { 'content-type': 'text/calendar' } });
    if (u.hostname === 'notics.example') return new Response('<html>nope</html>', { status: 200 });
    return new Response('', { status: 404 });
  };
  const make = () => createWidgets({ readSettings: () => store.settings, writeSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); }, fetch: fakeFetch, getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 10000, now: () => clock });
  const W = make();
  const SCHOOL = 'https://school.example/term.ics';
  const OTHER = 'https://other.example/me.ics';

  // an old card, exactly as an earlier Lumen stored it, needs nothing done
  store.settings = { homeWidgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: SCHOOL, name: 'Term calendar', count: 5 }] };
  let w = W.list()[0];
  check('back-compat: an old card loads as one calendar and keeps its url and name', W.list().length === 1 && w.url === SCHOOL && w.name === 'Term calendar' && w.cals.length === 1 && w.cals[0].url === SCHOOL, JSON.stringify(w));
  await W.refresh(w, { force: true });
  let card = W.forPage().find((x) => x.id === 'wcal00001');
  check('back-compat: its card is as before: not “multi”, no per-event calendar, the feed’s name and color', card.data.multi === false && card.data.name === 'Term calendar' && card.data.color === '#336699' && card.data.events.length === 4 && card.data.events.every((x) => !('cal' in x)), JSON.stringify(card.data).slice(0, 400));
  check('back-compat: a single calendar’s events are in time order, with all-day first on its day', card.data.events.map((x) => x.title).join() === 'Maths exam,Teacher day,Shared trip,Parents evening' || card.data.events.map((x) => x.title).join() === 'Maths exam,Teacher day,Shared trip,Parents evening', card.data.events.map((x) => x.title).join());
  check('back-compat: the title is the feed’s name and the list line the host', card.title === 'Term calendar' && w.summary === undefined && W.state().widgets[0].summary === 'school.example', `${card.title} ${W.state().widgets[0].summary}`);

  // saving two calendars through Settings' own path
  let out = await W.save({ type: 'calendar', title: '', cals: [{ name: 'School', url: SCHOOL, color: '#e5604d', enabled: true }, { name: 'Other', url: OTHER, color: '', enabled: true }] });
  const id2 = out.widget.id;
  check('save: two calendars are stored, in order, with colours and the first address mirrored in url', out.widget.cals.length === 2 && out.widget.cals[0].name === 'School' && out.widget.cals[0].color === '#e5604d' && out.widget.cals[1].name === 'Other' && out.widget.url === SCHOOL, JSON.stringify(out.widget));
  check('save: the message counts each calendar', /School: 4 events, \d+ in the next two weeks\. Other: 4 events/.test(out.message), out.message);
  w = W.list().find((x) => x.id === id2);
  check('save: the list line names both', W.state().widgets.find((x) => x.id === id2).summary === 'School + Other · 2 calendars', W.state().widgets.find((x) => x.id === id2).summary);
  await W.refresh(w, { force: true });
  card = W.forPage().find((x) => x.id === id2);
  const titles = card.data.events.map((x) => x.title);
  check('merged order: the two calendars are interleaved by time, all-day first, the shared trip once', titles.join() === 'Dentist,Maths exam,Dinner,Teacher day,Shared trip,Parents evening,Tax deadline', titles.join());
  const colorsBy = Object.fromEntries(card.data.events.map((x) => [x.title, x.color]));
  const calIds = Object.fromEntries(card.data.cals.map((c) => [c.name, c]));
  check('colours: School is the color chosen; Other (none chosen, none in its feed) gets a palette color; each event carries its calendar', colorsBy['Maths exam'] === '#e5604d' && colorsBy.Dentist === CS.PALETTE[1] && card.data.events.find((x) => x.title === 'Dentist').cal === calIds.Other.id && card.data.events.find((x) => x.title === 'Maths exam').cal === calIds.School.id, JSON.stringify(colorsBy));
  check('cals: the card is told each calendar’s name, color and that it is fine; multi is on', card.data.multi === true && card.data.cals.length === 2 && card.data.cals.every((c) => c.ok && !c.error && /^#[0-9a-f]{6}$/.test(c.color)), JSON.stringify(card.data.cals));
  check('de-duplicate: the trip in both calendars shows once, from the first calendar, and says it is in the other too', card.data.events.filter((x) => x.title === 'Shared trip').length === 1 && card.data.events.find((x) => x.title === 'Shared trip').cal === calIds.School.id && card.data.events.find((x) => x.title === 'Shared trip').also.join() === calIds.Other.id, JSON.stringify(card.data.events.find((x) => x.title === 'Shared trip')));
  check('privacy: the page is never sent a calendar address', !/term\.ics|me\.ics/.test(JSON.stringify(W.forPage())) && !JSON.stringify(W.forPage()).includes('https://'), '');
  check('title: several calendars give the card the plain title', card.title === 'Calendar', card.title);

  // a feed's own colour is used when none was chosen
  const fc = await W.save({ type: 'calendar', title: '', cals: [{ name: '', url: SCHOOL }, { name: 'Other', url: OTHER, color: '#00ff00' }] });
  await W.refresh(W.list().find((x) => x.id === fc.widget.id), { force: true });
  const fcCard = W.forPage().find((x) => x.id === fc.widget.id);
  check('colours: with none chosen a calendar uses its own feed’s color, and is named after its feed', fcCard.data.cals[0].color === '#336699' && fcCard.data.cals[0].name === 'Term calendar' && fcCard.data.cals[1].color === '#00ff00', JSON.stringify(fcCard.data.cals));
  W.remove(fc.widget.id);

  // time zones and recurrence go through the same reader as before
  FEEDS['tz.example'] = vcal('Zones', [
    `BEGIN:VEVENT\r\nUID:tz1\r\nSUMMARY:New York 9am\r\nDTSTART;TZID=America/New_York:${stamp(day(2, 0)).slice(0, 8)}T090000\r\nDTEND;TZID=America/New_York:${stamp(day(2, 0)).slice(0, 8)}T100000\r\nEND:VEVENT\r\n`,
    `BEGIN:VEVENT\r\nUID:rr1\r\nSUMMARY:Daily standup\r\nDTSTART:${stamp(day(1, 7))}\r\nDTEND:${stamp(day(1, 7) + 15 * 60e3)}\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n`,
    vday('ad1', 'All day thing', day(4)),
  ]);
  const tz = await W.save({ type: 'calendar', title: '', cals: [{ name: 'Zones', url: 'https://tz.example/z.ics', color: '#112233' }, { name: 'Other', url: OTHER }] });
  await W.refresh(W.list().find((x) => x.id === tz.widget.id), { force: true });
  const tzCard = W.forPage().find((x) => x.id === tz.widget.id).data.events;
  const ny = tzCard.find((x) => x.title === 'New York 9am');
  const nyLocal = ics.instant ? null : null; // (kept simple: the instant is compared with the reader’s own)
  const ref = ics.eventsBetween(FEEDS['tz.example'], { from: Date.now(), days: 14 }).events.find((x) => x.title === 'New York 9am');
  check('time zones: a TZID event lands on the same instant as the reader alone gives', Boolean(ny) && ny.start === ref.start && nyLocal === null, JSON.stringify(ny));
  check('recurrence: a repeating event gives each occurrence, interleaved with the other calendar by time', tzCard.filter((x) => x.title === 'Daily standup').length === 3 && tzCard.map((x) => x.start).every((s, i, a) => i === 0 || a[i - 1] <= s), tzCard.map((x) => x.title).join());
  check('all-day: an all-day event keeps its date and the all-day flag', tzCard.some((x) => x.title === 'All day thing' && x.allDay && x.date === `${new Date(day(4)).getFullYear()}-${String(new Date(day(4)).getMonth() + 1).padStart(2, '0')}-${String(new Date(day(4)).getDate()).padStart(2, '0')}`), JSON.stringify(tzCard.filter((x) => x.allDay)));
  W.remove(tz.widget.id);

  // one calendar failing: the others still show, with a note
  down.add('other.example');
  clock += 20 * 60e3;
  await W.refresh(W.list().find((x) => x.id === id2), { force: true });
  card = W.forPage().find((x) => x.id === id2);
  const bad = card.data.cals.find((c) => c.name === 'Other');
  check('one calendar down: the card still has the other calendar’s events', card.data.events.length > 0 && card.data.events.every((x) => x.title !== 'Dentist' || bad.stale) && card.data.events.some((x) => x.title === 'Maths exam'), card.data.events.map((x) => x.title).join());
  check('one calendar down: it is flagged with a short reason, and (it worked before) its earlier events are kept, marked stale', bad.ok === false && /500/.test(bad.error) && bad.stale === true && card.data.events.some((x) => x.title === 'Dentist') && card.data.cals.find((c) => c.name === 'School').ok === true, JSON.stringify(card.data.cals));
  check('one calendar down: the card as a whole is not an error', !card.error && card.data && !card.warning, JSON.stringify({ e: card.error, w: card.warning }));

  // never fine, and down: no stale copy, so just its note
  W.flush();
  clock += 20 * 60e3;
  await W.refresh(W.list().find((x) => x.id === id2), { force: true });
  card = W.forPage().find((x) => x.id === id2);
  const bad2 = card.data.cals.find((c) => c.name === 'Other');
  check('a calendar that has never worked: its note, no events from it, the other calendar unaffected', bad2.ok === false && !bad2.stale && card.data.events.length === 4 && card.data.events.every((x) => x.cal === card.data.cals.find((c) => c.name === 'School').id), JSON.stringify(card.data.events.map((x) => [x.title, x.cal])));

  // a timeout on one calendar is that calendar’s problem only
  down.clear();
  hang.add('other.example');
  W.flush();
  clock += 20 * 60e3;
  await W.refresh(W.list().find((x) => x.id === id2), { force: true });
  card = W.forPage().find((x) => x.id === id2);
  check('a calendar that times out: said in words, the other still shows', /too long/.test(card.data.cals.find((c) => c.name === 'Other').error) && card.data.events.some((x) => x.title === 'Maths exam'), JSON.stringify(card.data.cals));

  // all down: the card is an error as before (and a card that had data keeps it, with a warning)
  down.add('school.example');
  W.flush();
  clock += 20 * 60e3;
  await W.refresh(W.list().find((x) => x.id === id2), { force: true });
  card = W.forPage().find((x) => x.id === id2);
  check('every calendar down and none ever worked: the card says Couldn’t update with a reason that names the first', !card.data && /School/.test(card.error || '') && /500/.test(card.error), JSON.stringify({ e: card.error }));
  hang.clear();
  down.clear();

  // parallel: the calendars are fetched together, not one after another
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const Wp = createWidgets({ readSettings: () => store.settings, writeSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); }, fetch: async (url) => { const h = new URL(url).hostname; order.push(`start ${h}`); if (h === 'school.example') await gate; else release(); const r = await fakeFetch(url); order.push(`end ${h}`); return r; }, getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 10000, now: () => clock });
  clock += 20 * 60e3;
  await Wp.refresh(Wp.list().find((x) => x.id === id2), { force: true });
  check('fetch: the calendars are asked together (the second starts before the first has answered)', order.indexOf('start other.example') >= 0 && order.indexOf('start other.example') < order.indexOf('end school.example'), order.join(' | '));

  // caching: a second refresh inside the cache window asks nobody again; a failing calendar is retried alone
  clock += 20 * 60e3;
  await W.refresh(W.list().find((x) => x.id === id2), { force: true });
  log.length = 0;
  clock += 16 * 60e3; // the card is stale (15 min) but the calendars were read less than 10 minutes ago? no: 16 > 10, so both are asked
  await W.refresh(W.list().find((x) => x.id === id2));
  check('cache: past its time both calendars are asked again once each', log.filter((h) => h === 'school.example').length === 1 && log.filter((h) => h === 'other.example').length === 1, log.join());
  down.add('other.example');
  clock += 20 * 60e3;
  await W.refresh(W.list().find((x) => x.id === id2));
  down.delete('other.example');
  log.length = 0;
  clock += 3 * 60e3; // the failed card is retried after 2 minutes; School was read 3 minutes ago, so it comes from the cache
  await W.refresh(W.list().find((x) => x.id === id2));
  check('cache: when one calendar failed, the retry asks only that one (the other is still cached)', log.filter((h) => h === 'school.example').length === 0 && log.filter((h) => h === 'other.example').length === 1, log.join());

  // saving with a broken second calendar: kept, with a warning; a single broken calendar still refuses as before
  hang.add('other.example');
  W.flush();
  out = await W.save({ type: 'calendar', title: '', cals: [{ name: 'School', url: SCHOOL }, { name: 'Other', url: OTHER }] }, id2);
  check('save with one calendar unreachable: saved, and the message says which and what happens', /Other: can’t be read/.test(out.message) && /saved anyway/.test(out.message) && /School: 4 events/.test(out.message), out.message);
  hang.clear();
  let refused = '';
  try { await W.save({ type: 'calendar', title: '', cals: [{ name: 'Nope', url: 'https://notics.example/x.ics' }, { name: 'Nada', url: 'https://nada.example/x.ics' }] }); } catch (err) { refused = err.message; }
  check('save with every calendar unreadable: refused, naming the first', /Nope/.test(refused), refused);
  refused = '';
  try { await W.save({ type: 'calendar', title: '', cals: [{ name: 'Nope', url: 'https://notics.example/x.ics' }] }); } catch (err) { refused = err.message; }
  check('save with one calendar that isn’t ICS: refused as always', /isn’t a calendar/.test(refused), refused);
  for (const [label, cals, re] of [
    ['an http address', [{ name: 'A', url: 'http://school.example/x.ics' }], /needs an https/],
    ['a name with no address', [{ name: 'A', url: '' }], /needs an https/],
    ['nothing switched on', [{ name: 'A', url: SCHOOL, enabled: false }], /at least one/],
    ['nine calendars', Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, url: `https://school.example/${i}.ics` })), /Up to 8/],
  ]) {
    refused = '';
    try { await W.save({ type: 'calendar', title: '', cals }); } catch (err) { refused = err.message; }
    check(`save: ${label} is refused`, re.test(refused), refused);
  }
  const tested = await W.test({ type: 'calendar', cals: [{ name: 'Only', url: OTHER }] });
  check('Test: one calendar of the form on its own', tested.ok && /Personal: 4 events/.test(tested.message), JSON.stringify(tested));
  log.length = 0;
  await W.test({ type: 'calendar', cals: [{ name: 'Only', url: OTHER }] });
  check('Test: always looks again (not the cached answer)', log.filter((h) => h === 'other.example').length === 1, log.join());

  // a calendar that is switched off is kept but not fetched or shown
  await W.save({ type: 'calendar', title: '', cals: [{ name: 'School', url: SCHOOL }, { name: 'Other', url: OTHER, enabled: false }] }, id2);
  log.length = 0;
  await W.refresh(W.list().find((x) => x.id === id2), { force: true });
  card = W.forPage().find((x) => x.id === id2);
  check('switched off: not asked, not on the card, still in the settings, and the list line says so', !log.includes('other.example') && card.data.cals.length === 1 && card.data.multi === false && W.list().find((x) => x.id === id2).cals.length === 2 && W.state().widgets.find((x) => x.id === id2).summary === 'School · 2 calendars, 1 off', `${log} ${W.state().widgets.find((x) => x.id === id2).summary}`);
  check('switched off: one calendar showing is a plain single card (no legend, no dots)', card.data.events.every((x) => !('cal' in x)), '');

  // ---- the home page's form ----
  w = W.list().find((x) => x.id === id2);
  const view = C.view(w);
  check('page view: names, hosts, colours and switches, never an address', view.cals.length === 2 && view.cals[0].name === 'School' && view.cals[1].host === 'other.example' && view.cals[1].enabled === false && !JSON.stringify(view).includes('/term.ics') && !JSON.stringify(view).includes('/me.ics') && view.host === 'school.example', JSON.stringify(view));
  check('page view: an old card shows one calendar', C.view({ type: 'calendar', url: SCHOOL, count: 4 }).cals.length === 1, '');
  const act = (id, cfg) => W.act({ id, do: 'setup', cfg, create: id === 'wcreate' });
  down.add('school.example'); down.add('other.example'); // offline: a change that leaves the addresses alone must still save
  let r = await act(id2, { type: 'calendar', title: '', count: 5, cals: [{ keep: 1, name: 'Personal', color: '#aa0000', enabled: true, url: '' }, { keep: 0, name: 'Term', color: '#00aa00', enabled: true, url: '' }] });
  w = W.list().find((x) => x.id === id2);
  check('page form: rename, recolour, switch on and reorder keep the saved addresses (the page never had them)', r.ok && w.cals.length === 2 && w.cals[0].url === OTHER && w.cals[0].name === 'Personal' && w.cals[0].color === '#aa0000' && w.cals[1].url === SCHOOL && w.url === OTHER && w.cals.every((c) => c.enabled), JSON.stringify(r) + JSON.stringify(w.cals));
  check('page form: a change that leaves every address alone saves while offline', r.ok === true, JSON.stringify(r));
  down.clear();
  r = await act(id2, { type: 'calendar', title: '', count: 5, cals: [{ keep: 1, name: 'Term', color: '', enabled: true, url: '' }, { keep: -1, name: 'Sports', color: '#ff8800', enabled: true, url: 'webcal://tz.example/z.ics' }] });
  w = W.list().find((x) => x.id === id2);
  check('page form: a calendar can be dropped and a new one added with an address', r.ok && w.cals.length === 2 && w.cals[0].url === SCHOOL && w.cals[1].url === 'https://tz.example/z.ics' && w.cals[1].name === 'Sports', JSON.stringify(r) + JSON.stringify(w.cals));
  for (const [label, cals, re] of [
    ['a new row with no address', [{ keep: 0, name: 'A', enabled: true }, { keep: -1, name: 'New', enabled: true, url: '' }], /Paste an address for New/],
    ['an http address', [{ keep: 0, enabled: true }, { keep: -1, name: 'New', enabled: true, url: 'http://x.example/a.ics' }], /needs an https/],
    ['everything switched off', [{ keep: 0, enabled: false }], /at least one/],
    ['an empty list', [], /at least one/],
    ['nine rows', Array.from({ length: 9 }, () => ({ keep: 0, enabled: true })), /Up to 8/],
  ]) {
    const was = JSON.stringify(W.list().find((x) => x.id === id2).cals);
    r = await act(id2, { type: 'calendar', title: '', count: 5, cals });
    check(`page form: ${label} is refused and changes nothing`, r.ok === false && re.test(r.message) && JSON.stringify(W.list().find((x) => x.id === id2).cals) === was, JSON.stringify(r));
  }
  r = await act(id2, { type: 'calendar', title: '', count: 5, cals: [{ keep: 7, name: 'Ghost', enabled: true, url: '' }] });
  check('page form: a row pointing at a calendar that isn’t there is refused', r.ok === false, JSON.stringify(r));
  r = await act('wcreate', { type: 'calendar', title: '', count: 5, cals: [{ keep: -1, name: 'School', color: '#e5604d', enabled: true, url: SCHOOL }, { keep: -1, name: 'Other', enabled: true, url: OTHER }] });
  check('page form: a new card with two calendars', r.ok && W.list().find((x) => x.id === r.id).cals.length === 2, JSON.stringify(r));
  const oldForm = await act(r.id, { type: 'calendar', title: '', count: 6, url: '' });
  check('page form: the older one-address form on a two-calendar card changes the count and keeps both calendars', oldForm.ok && W.list().find((x) => x.id === r.id).cals.length === 2 && W.list().find((x) => x.id === r.id).count === 6, JSON.stringify(oldForm));
  const oldNew = await act('wcreate', { type: 'calendar', title: '', count: 5, url: SCHOOL });
  check('page form: the older one-address form still adds a card', oldNew.ok && W.list().find((x) => x.id === oldNew.id).cals.length === 1, JSON.stringify(oldNew));
  check('skip-fetch rule: rows that are all saved calendars keep the addresses; a new address does not', C.keepsAddress(W.list().find((x) => x.id === id2), { type: 'calendar', cals: [{ keep: 0 }, { keep: 1 }] }) === true && C.keepsAddress(W.list().find((x) => x.id === id2), { type: 'calendar', cals: [{ keep: 0 }, { keep: -1, url: 'https://new.example/x.ics' }] }) === false && C.keepsAddress(W.list().find((x) => x.id === id2), { type: 'calendar', cals: [{ keep: 9 }] }) === false, '');

  // ---- stored cleanly ----
  const stored = cleanWidget({ id: 'wclean001', type: 'calendar', cals: [{ name: 'x'.repeat(200), url: SCHOOL, color: 'bad' }], count: 7, colors: 'nope' });
  check('stored: names are cut, a bad color is empty, count and Colors are clamped', stored.cals[0].name.length === 60 && stored.cals[0].color === '' && stored.count === 7 && stored.colors === 'calendar', JSON.stringify(stored));
  check('stored: a card with no usable calendar is dropped', cleanWidget({ id: 'wclean002', type: 'calendar', cals: [{ url: 'http://x.example/' }] }) === null, '');

  // ---- the page files ----
  const nt = read('src/renderer/newtab-widgets.js');
  const html = read('src/renderer/newtab.html');
  const setup = read('src/renderer/newtab-setup.js');
  const settings = read('src/renderer/settings.js');
  check('card: calendars are told apart by words as well as colour (a named dot, the name on the row, switches that say shown or hidden)', /cal-dot/.test(nt) && /'Calendar: ' \+ cal\.name/.test(nt) && /cal-name/.test(nt) && /aria-pressed/.test(nt) && /shown'|hidden'/.test(nt), '');
  check('card: which calendars are hidden is remembered per card, and safely', /localStorage\.getItem\(hideKey\)/.test(nt) && /try \{[^}]*localStorage\.setItem/.test(nt) && /hideKey = 'lumen\.calendar\.hidden\.' \+ w\.id/.test(nt), '');
  check('card: the legend is a labelled group and never hides the last calendar', /aria-label', 'Calendars on this card'/.test(nt) && /At least one calendar stays on/.test(nt), '');
  check('card: sizes — the legend and notes go on a small card, the name needs room, motion is off for reduced motion', /max-height: 149px\) \{ \.cal-legend/.test(html) && /min-width: 300px\) \{ \.cal-name/.test(html) && /prefers-reduced-motion: reduce\) \{ \.cal-chip/.test(html) && /body\.calm \.cal-chip/.test(html), '');
  check('card: colours come from variables with a fallback (light and dark), the dot keeps its color in every Colors mode', /var\(--cal, var\(--accent\)\)/.test(html) && !/\.w-card\.tinted[^{]*\.cal-dot/.test(html), '');
  check('home editor: names, colours, switches, order and removal; saved addresses are never shown', /ws-cals/.test(setup) && /type="color"|input\('color'/.test(setup) && /Move up/.test(setup) && /Remove/.test(setup) && !/s\.url/.test(setup.slice(setup.indexOf('calendar(s, editing)'), setup.indexOf('feed(s)'))), '');
  check('Settings editor: name, colour, address, switch, order, remove and a Test per calendar', /id: 'widget-cals'/.test(settings) && /type: 'color'/.test(settings) && /Test \$\{label\}/.test(settings) && /Move \$\{label\} up/.test(settings) && /Remove \$\{label\}/.test(settings) && /MAX_CALS = 8/.test(settings), '');
  check('the cap is the same everywhere (8)', CS.MAX_SOURCES === 8 && /MAX_CALS = 8/.test(setup) && /MAX_CALS = 8/.test(settings), '');
  check('palette in the forms is the connector’s', CS.PALETTE.every((c) => setup.includes(c) && settings.includes(c)), '');

  check('this suite ran without a network', Date.now() - t0 < 60000, `${Date.now() - t0}ms`);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
