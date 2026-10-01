// New-tab widgets (features/widgets.js and its helpers, renderer/newtab-widgets*.js): weather (places,
// My location, by-day), Todoist (filters, groups, undo, quick add), a calendar (ICS) and web pages, added
// from Settings, drawn on a free 12-column grid you can drag, push, snap, resize and edit like a home
// screen, kept fresh live, with tokens that never leave the main process. Offline: a local https server (a
// throwaway self-signed certificate) stands in for Open-Meteo, its geocoder, an IP-location service, Todoist,
// a calendar feed and sites with and without X-Frame-Options. Pointer input is dispatched into the page.
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const ics = require('../src/features/ics');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the ICS reader on its own ----
function icsChecks() {
  const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Muse schedule', ...lines, 'END:VCALENDAR'].join('\r\n');
  const from = new Date(2026, 8, 28, 8, 0).getTime(); // Monday 28 September 2026, 8:00 local
  const at = (e) => new Date(e.start);
  let r = ics.eventsBetween(cal(
    'BEGIN:VEVENT', 'UID:w1', 'DTSTART;TZID=America/New_York:20260907T100000', 'DTEND;TZID=America/New_York:20260907T103000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TH', 'EXDATE;TZID=America/New_York:20261001T100000', 'SUMMARY:Stand', ' up', 'BEGIN:VALARM', 'SUMMARY:not me', 'END:VALARM', 'END:VEVENT',
  ), { from, days: 7 });
  check('ICS: the calendar name and line unfolding', r.name === 'Muse schedule' && r.events[0]?.title === 'Standup', JSON.stringify(r).slice(0, 300));
  check('ICS: a weekly BYDAY rule repeats, EXDATE removes one', r.events.length === 1 && at(r.events[0]).getDate() === 28, r.events.map((e) => at(e).toString()).join(' | '));
  check('ICS: TZID times convert (10:00 New York is 14:00 UTC in September)', new Date(r.events[0]?.start).toISOString().slice(11, 16) === '14:00' && r.events[0].end - r.events[0].start === 30 * 60e3, new Date(r.events[0]?.start).toISOString());

  r = ics.eventsBetween(cal('BEGIN:VEVENT', 'UID:d1', 'DTSTART:20260926T090000Z', 'DURATION:PT45M', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Daily', 'END:VEVENT'), { from, days: 14 });
  check('ICS: a daily rule with COUNT stops (26th–30th: 3 in the window)', r.events.length === 3 && r.events.every((e) => e.end - e.start === 45 * 60e3), r.events.length);
  r = ics.eventsBetween(cal('BEGIN:VEVENT', 'UID:d2', 'DTSTART:20260920T120000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261002T000000Z', 'SUMMARY:Every other day', 'END:VEVENT'), { from, days: 14 });
  check('ICS: INTERVAL and UNTIL', r.events.map((e) => new Date(e.start).getUTCDate()).join(',') === '28,30', r.events.map((e) => new Date(e.start).toISOString()).join(','));

  r = ics.eventsBetween(cal(
    'BEGIN:VEVENT', 'UID:a1', 'DTSTART;VALUE=DATE:20260929', 'DTEND;VALUE=DATE:20260930', 'SUMMARY:Holiday\\, observed', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a2', 'DTSTART;VALUE=DATE:20260926', 'DTEND;VALUE=DATE:20261001', 'SUMMARY:Conference', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a3', 'DTSTART;VALUE=DATE:20250930', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday', 'END:VEVENT',
  ), { from, days: 7 });
  const titles = r.events.map((e) => `${e.title}@${e.date}`);
  check('ICS: all-day events (one day, several days, yearly)', r.events.every((e) => e.allDay) && titles.includes('Holiday, observed@2026-09-29') && titles.includes('Conference@2026-09-26') && titles.includes('Birthday@2026-09-30'), titles.join(' | '));

  r = ics.eventsBetween(cal(
    'BEGIN:VEVENT', 'UID:m1', 'DTSTART:20260928T150000Z', 'DTEND:20260928T160000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Series', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:m1', 'RECURRENCE-ID:20260929T150000Z', 'DTSTART:20260929T180000Z', 'DTEND:20260929T190000Z', 'SUMMARY:Series (moved)', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c1', 'DTSTART:20260928T170000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:t1', 'DTSTART;TZID="Pacific Standard Time":20260928T090000', 'SUMMARY:Windows zone', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:t2', 'DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20260928T090000', 'SUMMARY:Mozilla zone', 'END:VEVENT',
  ), { from, days: 3 });
  const byTitle = Object.fromEntries(r.events.map((e) => [e.title + (r.events.filter((x) => x.title === e.title).length > 1 ? `#${new Date(e.start).getUTCDate()}` : ''), e]));
  check('ICS: a RECURRENCE-ID override replaces its occurrence', r.events.filter((e) => e.title.startsWith('Series')).map((e) => `${e.title}@${new Date(e.start).toISOString().slice(8, 13)}`).join(',') === 'Series@28T15,Series (moved)@29T18,Series@30T15', r.events.map((e) => e.title).join(','));
  check('ICS: cancelled events are left out', !r.events.some((e) => e.title === 'Cancelled'), 'shown');
  check('ICS: Windows and Mozilla TZIDs', new Date(byTitle['Windows zone']?.start).toISOString().slice(11, 16) === '16:00' && new Date(byTitle['Mozilla zone']?.start).toISOString().slice(11, 16) === '07:00', `${new Date(byTitle['Windows zone']?.start).toISOString()} ${new Date(byTitle['Mozilla zone']?.start).toISOString()}`);

  // DST: a weekly 9:00 New York meeting stays at 9:00 local across the November change.
  r = ics.eventsBetween(cal('BEGIN:VEVENT', 'UID:dst', 'DTSTART;TZID=America/New_York:20261026T090000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly', 'END:VEVENT'), { from: new Date(2026, 9, 26).getTime(), days: 14 });
  check('ICS: recurrences keep their wall-clock time across DST', r.events.map((e) => new Date(e.start).toISOString().slice(11, 16)).join(',') === '13:00,14:00', r.events.map((e) => new Date(e.start).toISOString()).join(','));

  const evil = ics.eventsBetween(cal('BEGIN:VEVENT', 'UID:x', 'DTSTART:20260928T150000Z', 'SUMMARY:<img src=x onerror=alert(1)>', 'URL:javascript:alert(1)', 'LOCATION:<script>1</script>', 'END:VEVENT'), { from, days: 2 });
  check('ICS: markup stays plain text and a javascript: URL is dropped', evil.events[0]?.title === '<img src=x onerror=alert(1)>' && evil.events[0].url === '', JSON.stringify(evil.events[0]));
  let refused = false;
  try { ics.eventsBetween('<html>not a calendar</html>'); } catch { refused = true; }
  check('ICS: a page that isn’t a calendar is refused', refused, 'accepted');
  const garbage = ics.eventsBetween(cal('BEGIN:VEVENT', 'DTSTART:banana', 'END:VEVENT', 'BEGIN:VEVENT', 'DTSTART:20260928T150000Z', 'RRULE:FREQ=SECONDLY', 'END:VEVENT'), { from, days: 2 });
  check('ICS: broken values and unsupported rules don’t throw', garbage.events.length === 1, garbage.events.length);
}

// ---- the stand-in services ----
const TOKEN = 'tok_0123456789abcdef0123456789abcdef';
const TASK_TITLE = '<img src=x onerror="window.__pwned=1"><b>Pay rent</b>';
function server(opts) {
  const log = [];
  const closed = new Set();
  const made = [];
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today.getTime() - 86400e3);
  const utc = (d, h) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}0000Z`;
  const tomorrow = new Date(today.getTime() + 86400e3);
  const in3 = new Date(today.getTime() + 3 * 86400e3);
  const icsText = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Muse schedule',
    'BEGIN:VEVENT', 'UID:e1', `DTSTART:${utc(tomorrow, 14)}`, `DTEND:${utc(tomorrow, 15)}`, 'SUMMARY:Design review', 'LOCATION:Studio', 'URL:https://example.com/review', 'COLOR:#e91e63', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e2', `DTSTART;VALUE=DATE:${ymd(tomorrow).replace(/-/g, '')}`, 'SUMMARY:Launch day', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e3', `DTSTART:${utc(new Date(today.getTime() - 7 * 86400e3), 23)}`, 'DURATION:PT30M', 'RRULE:FREQ=DAILY', 'SUMMARY:<b>Evening</b> walk', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const projects = [{ id: 'p1', name: 'Home', color: 'red' }, { id: 'p2', name: 'Work', color: 'blue' }, { id: 'p0', name: 'Inbox', color: 'grey' }];
  const all = () => [
    { id: '101', content: TASK_TITLE, priority: 4, project_id: 'p2', labels: ['money'], due: { date: ymd(today), is_recurring: true, string: 'every day' }, description: 'Landlord', child_order: 2 },
    { id: '102', content: 'Reply to Evan', priority: 1, project_id: 'p1', labels: [], due: { date: `${ymd(today)}T15:00:00`, string: 'today 3pm' }, child_order: 1 },
    { id: '103', content: 'File taxes', priority: 3, project_id: 'p1', labels: ['money'], due: { date: ymd(yesterday), string: 'yesterday' }, child_order: 0 },
    { id: '104', content: 'Plan trip', priority: 2, project_id: 'p2', labels: [], due: { date: ymd(in3) }, child_order: 3 },
    { id: '105', content: 'Someday', priority: 1, project_id: 'p0', labels: [], due: null, child_order: 4 },
    ...made,
  ].filter((t) => !closed.has(t.id));
  const filters = {
    'today | overdue': ['101', '102', '103'], today: ['101', '102'], '5 days': ['101', '102', '104'], '#Inbox': ['105'], '@money': ['101', '103'], 'p1 & today': ['101'],
  };
  const forecast = (u) => {
    const lat = Number(u.searchParams.get('latitude'));
    const days = Number(u.searchParams.get('forecast_days') || 7);
    const base = Math.abs(lat - 48.85) < 1 ? 55 : Math.abs(lat - 42.52) < 0.05 ? 66 : 68;
    const c = u.searchParams.get('temperature_unit') === 'celsius';
    const t = (f) => (c ? Math.round((f - 32) * 5 / 9 * 10) / 10 : f);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const times = [];
    for (let i = 0; i < days * 24; i++) { const d = new Date(start.getTime() + i * 3600e3); times.push(`${dateOf(d)}T${pad(d.getHours())}:00`); }
    const dates = [...Array(days).keys()].map((i) => dateOf(new Date(start.getTime() + i * 86400e3)));
    return {
      current: { time: `${dateOf(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`, temperature_2m: t(base + 0.4), apparent_temperature: t(base - 1.1), weather_code: 2, is_day: 1, wind_speed_10m: 9.4, wind_direction_10m: 220, relative_humidity_2m: 64 },
      hourly: { time: times, temperature_2m: times.map((_, i) => t(base + (i % 24) / 4)), weather_code: times.map(() => 2), is_day: times.map((_, i) => (i % 24 >= 6 && i % 24 < 20 ? 1 : 0)), precipitation_probability: times.map((_, i) => (i % 24) * 3), precipitation: times.map(() => 0.02) },
      daily: {
        time: dates, weather_code: dates.map((_, i) => [2, 61, 3, 0, 71, 2, 3, 0, 1, 2][i % 10]), temperature_2m_max: dates.map((_, i) => t(base + 2 + i)), temperature_2m_min: dates.map((_, i) => t(base - 13 + i)),
        precipitation_probability_max: dates.map((_, i) => 10 + i * 5), precipitation_sum: dates.map((_, i) => i * 0.1), wind_speed_10m_max: dates.map((_, i) => 12 + i),
        sunrise: dates.map((d) => `${d}T06:41`), sunset: dates.map((d) => `${d}T18:12`), uv_index_max: dates.map(() => 5.4),
      },
    };
  };
  const srv = https.createServer(opts, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      log.push({ method: req.method, path: u.pathname, query: u.search, params: Object.fromEntries(u.searchParams), body, auth: req.headers.authorization || '', cookie: req.headers.cookie || '' });
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/geo') {
        const q = u.searchParams.get('name') || '';
        if (/nowhere/i.test(q)) return json(200, { generationtime_ms: 0.1 });
        if (/paris/i.test(q)) return json(200, { results: [{ name: 'Paris', admin1: 'Île-de-France', country: 'France', latitude: 48.85341, longitude: 2.3488 }] });
        return json(200, { results: [{ name: 'Boston', admin1: 'Massachusetts', country: 'United States', latitude: 42.35843, longitude: -71.05977, timezone: 'America/New_York' }] });
      }
      if (u.pathname === '/forecast') return json(200, forecast(u));
      if (u.pathname === '/locate') return json(200, { ip: '203.0.113.5', city: 'Salem', region: 'Massachusetts', region_code: 'MA', country_name: 'United States', latitude: 42.5195, longitude: -70.8967 });
      if (u.pathname.startsWith('/todoist/')) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'Unauthorized' });
        const p = u.pathname.slice('/todoist'.length);
        if (p === '/tasks/filter' && req.method === 'GET') {
          const q = u.searchParams.get('query');
          if (q === 'view all') return json(200, { results: all(), next_cursor: null });
          const ids = filters[q] || ['101'];
          return json(200, { results: all().filter((t) => ids.includes(t.id)), next_cursor: null });
        }
        if (p === '/tasks' && req.method === 'GET') return json(200, { results: all().filter((t) => t.project_id === u.searchParams.get('project_id')), next_cursor: null });
        if (p === '/projects') return json(200, { results: projects, next_cursor: null });
        if (p === '/tasks/completed/by_completion_date') return json(200, { items: [{ task_id: '900', content: 'Done thing' }, ...[...closed].map((id) => ({ task_id: id, content: `Closed ${id}` }))] });
        if (p === '/tasks/quick' && req.method === 'POST') {
          const text = JSON.parse(body).text;
          const task = { id: String(200 + made.length), content: text.replace(/\s*tomorrow\s*/i, ' ').trim(), priority: 1, project_id: 'p0', labels: [], due: /tomorrow/i.test(text) ? { date: ymd(tomorrow) } : null, child_order: 9 };
          made.push(task);
          return json(200, task);
        }
        let m = /^\/tasks\/(\w+)\/close$/.exec(p);
        if (m && req.method === 'POST') { closed.add(m[1]); res.writeHead(204); return res.end(); }
        m = /^\/tasks\/(\w+)\/reopen$/.exec(p);
        if (m && req.method === 'POST') { closed.delete(m[1]); res.writeHead(204); return res.end(); }
        m = /^\/tasks\/(\w+)\/move$/.exec(p);
        if (m && req.method === 'POST') { const t = made.find((x) => x.id === m[1]); if (t) t.project_id = JSON.parse(body).project_id; return json(200, t || {}); }
        return json(404, {});
      }
      if (u.pathname === '/cal.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end(icsText); }
      const page = (title, headers = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(`<!doctype html><title>${title}</title><body style="font:14px system-ui;margin:16px"><h3>${title}</h3><p id="probe">framed page</p></body>`); };
      if (u.pathname === '/board') return page('Weekly board');
      if (u.pathname === '/deny') return page('Bank &amp; Co', { 'x-frame-options': 'DENY' });
      if (u.pathname === '/csp') return page('Strict site', { 'content-security-policy': "default-src 'self'; frame-ancestors 'self' https://example.com" });
      if (u.pathname === '/star') return page('Star site', { 'content-security-policy': 'frame-ancestors *' });
      res.writeHead(404);
      return res.end();
    });
  });
  return { srv, log, closed, made, icsText };
}

(async () => {
  icsChecks();

  // A throwaway certificate for 127.0.0.1 (openssl ships with macOS and Git for Windows).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-widgets-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the browser checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
  const fake = server({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  await new Promise((r) => fake.srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${fake.srv.address().port}`;

  // An older Lumen's list (only span and height, no x/y/w/h) is what this profile starts with.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-widgets-profile-'));
  const OLD = [
    { id: 'wweath01', type: 'weather', title: '', span: 3, place: 'Boston, Massachusetts, United States', lat: 42.3584, lon: -71.0598, units: 'f' },
    { id: 'wcal00001', type: 'calendar', title: '', span: 2, url: `${base}/cal.ics`, name: 'Muse schedule', count: 5 },
    { id: 'wemb00001', type: 'embed', title: 'My board', span: 6, height: 'small', url: `${base}/board`, name: 'Weekly board', frameable: true, reason: '' },
    { id: 'wemb00002', type: 'embed', title: '', span: 6, height: 'medium', url: `${base}/deny`, name: 'Bank & Co', frameable: false, reason: 'X-Frame-Options: DENY' },
  ];
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: OLD }));

  // --ignore-certificate-errors: the stand-in's certificate is self-signed.
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, b) => { global.__widgetEndpoints = { geocode: `${b}/geo`, forecast: `${b}/forecast`, todoist: `${b}/todoist`, locate: `${b}/locate` }; }, base);
  const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
  await W('flush');
  await app.evaluate(() => { global.__widgetRateMax = 5000; });
  const set = (k, v) => app.evaluate((_e, [key2, val]) => global.__settings.backend.set(key2, val).then(() => 'ok', (err) => `ERROR ${err.message}`), [k, v]);
  // settings.json is written off the main thread, so the file can lag the cache: flush first (main.js __settingsFlush), then read.
  const settingsFile = async () => { await app.evaluate(() => { if (global.__settingsFlush) global.__settingsFlush(); }); try { return fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'); } catch { return '{}'; } };
  const logCount = (p) => fake.log.filter((l) => l.path === p).length;
  // Only the centre column and the widgets: a short page keeps every drag target on screen.
  for (const k of ['newTabFavorites', 'newTabFrequent', 'newTabPrivacy']) await set(k, false);

  // ---- checks and refusals (the Settings "Check" button) ----
  let r = await W('test', { type: 'weather', city: 'Boston', units: 'f' });
  check('weather: a typed city is looked up', r.ok && r.message === 'Found Boston, Massachusetts, United States.', JSON.stringify(r));
  r = await W('test', { type: 'weather', city: 'Nowhereville' });
  check('weather: an unknown city says so', !r.ok && /No place called/.test(r.message), JSON.stringify(r));
  r = await W('test', { type: 'embed', url: `${base}/board` });
  check('embed: a page that allows framing can be embedded', r.ok && /Weekly board can be embedded/.test(r.message), JSON.stringify(r));
  r = await W('test', { type: 'embed', url: `${base}/deny` });
  check('embed: X-Frame-Options is found and explained', !r.ok && !r.error && /Bank & Co can’t be embedded \(X-Frame-Options: DENY\)/.test(r.message), JSON.stringify(r));
  r = await W('test', { type: 'embed', url: `${base}/csp` });
  check('embed: a CSP frame-ancestors list is found too', !r.ok && /Content-Security-Policy/.test(r.message), JSON.stringify(r));
  for (const bad of ['http://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/', 'data:text/html,hi']) {
    r = await W('test', { type: 'embed', url: bad });
    check(`embed: ${bad.slice(0, 24)} is refused`, !r.ok && r.error, JSON.stringify(r));
  }
  r = await W('test', { type: 'calendar', url: base.replace('https://', 'webcal://') + '/cal.ics' });
  check('calendar: a webcal:// feed is read as https and counted', r.ok && /^Muse schedule: 3 events, \d+ in the next two weeks\.$/.test(r.message), JSON.stringify(r));
  r = await W('test', { type: 'calendar', url: `${base}/board` });
  check('calendar: a page that isn’t ICS is refused', !r.ok && /isn’t a calendar/.test(r.message), JSON.stringify(r));
  r = await W('test', { type: 'todoist', token: 'tok_wrongwrongwrongwrongwrong' });
  check('todoist: a bad token is refused calmly', !r.ok && /token was refused/.test(r.message), JSON.stringify(r));
  r = await W('test', { type: 'todoist', token: TOKEN });
  check('todoist: the token is checked with one call (today and overdue by default)', r.ok && /3 tasks are due today or overdue/.test(r.message), JSON.stringify(r));
  r = await W('test', { type: 'todoist', token: TOKEN, todo: { source: 'inbox' } });
  check('todoist: Check counts for the chosen filter', r.ok && /1 task is in the Inbox/.test(r.message), JSON.stringify(r));
  check('…and nothing was stored by a check', !(await settingsFile()).includes('widget:todoist'), 'stored');
  check('requests carry no cookies, and the token only goes to Todoist', fake.log.every((l) => !l.cookie) && fake.log.filter((l) => l.auth).every((l) => l.path.startsWith('/todoist/')), JSON.stringify(fake.log.slice(-3)));
  check('no location request before anyone agreed', logCount('/locate') === 0, String(logCount('/locate')));

  // ---- an older list migrates by itself ----
  let list = await W('list');
  const cells = (l) => l.map((x) => `${x.x},${x.y},${x.w},${x.h}`).join(' ');
  check('migration: four widgets, same order', list.map((x) => x.id).join() === 'wweath01,wcal00001,wemb00001,wemb00002', JSON.stringify(list.map((x) => x.id)));
  check('migration: sizes carried over (half, a third, full width) and cells assigned in flow order', cells(list) === '0,0,6,3 6,0,4,5 0,5,12,4 0,9,12,6', cells(list));
  check('migration: span and height still mirrored for an older Lumen', list[0].span === 3 && list[1].span === 2 && list[2].span === 6 && list[2].height === 'small' && list[3].height === 'medium', JSON.stringify(list.map((x) => [x.span, x.height])));
  check('migration: the Todoist token and unrelated settings are untouched', JSON.parse((await settingsFile())).homeWidgets.length === 4, (await settingsFile()).slice(0, 100));

  // ---- adding widgets from the Settings page (its own preload and IPC) ----
  const settingsId = await app.evaluate(() => global.__settings.open('appearance'));
  const sp = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [settingsId, code]);
  for (let i = 0; i < 40 && !(await sp("Boolean(document.body.dataset.ready && document.getElementById('widget-add'))").catch(() => false)); i++) await sleep(150);
  const waitFor = async (code, tries = 40) => { for (let i = 0; i < tries; i++) { if (await sp(code).catch(() => false)) return true; await sleep(150); } return false; };
  const listState = () => sp("({ items: [...document.querySelectorAll('.widget-item')].map((e) => e.textContent), note: document.getElementById('widget-list-note').textContent })");
  // A weather widget with two searched places and My location (consent not given yet).
  await sp("document.getElementById('widget-add').click()");
  for (const q of ['Boston', 'Paris']) {
    await sp(`document.getElementById('widget-city').value = ${JSON.stringify(q)}; document.getElementById('widget-search').click()`);
    check(`Settings: searching “${q}” lists the match, with region and country`, await waitFor("document.querySelectorAll('#widget-found button').length > 0") && /\+ .*(Massachusetts|France)/.test(await sp("document.querySelector('#widget-found button').textContent")), 'no result');
    await sp("document.querySelector('#widget-found button').click()");
  }
  await sp("document.getElementById('widget-here').click()");
  await sp("document.querySelectorAll('.wx-nick')[1].value = 'Trip'; document.querySelectorAll('.wx-nick')[1].dispatchEvent(new Event('change'))");
  check('Settings: three places (two searched, My location) with a nickname', (await sp("document.querySelectorAll('.wx-edit-place').length")) === 3 && (await sp("document.getElementById('widget-location-note').textContent")).includes('ipapi.co'), await sp("document.getElementById('widget-places').textContent"));
  await sp("document.getElementById('widget-save').click()");
  for (let i = 0; i < 40 && (await sp("Boolean(document.getElementById('widget-form'))")); i++) await sleep(150);
  let s = await listState();
  check('Settings: the weather widget lists its places', s.items.length === 5 && /Weather/.test(s.items[4]) && /Boston, Trip \+1 · °/.test(s.items[4]), JSON.stringify(s));
  await sp("document.getElementById('widget-add').click()");
  await sp(`document.querySelector('.seg [data-type=todoist]').click(); document.getElementById('widget-token').value = ${JSON.stringify(TOKEN)};`);
  await sp("document.getElementById('widget-load-projects').click()");
  check('Settings: Todoist projects are fetched for the picker', await waitFor("document.querySelectorAll('#widget-project option').length === 3") && (await sp("[...document.querySelectorAll('#widget-project option')].map((o) => o.textContent).join()")) === 'Home,Inbox,Work', await sp("document.getElementById('widget-note').textContent"));
  await sp("document.getElementById('widget-save').click()");
  for (let i = 0; i < 40 && (await sp("Boolean(document.getElementById('widget-form'))")); i++) await sleep(150);
  s = await listState();
  check('Settings: a Todoist widget is added with its token (today and overdue by default)', s.items.length === 6 && /Today and overdue/.test(s.items[5]) && /3 tasks/.test(s.note), JSON.stringify(s));
  const saved = (await settingsFile());
  check('the token is not in settings.json in plain text (only encrypted)', !saved.includes(TOKEN) && !saved.includes(TOKEN.slice(4, 20)) && Boolean(JSON.parse(saved).keys?.['widget:todoist']), 'plain or missing');
  check('the Settings page never gets the token back', !(await sp('JSON.stringify(document.body.innerText) + JSON.stringify(window.lumenSettings && Object.keys(window.lumenSettings))')).includes(TOKEN), 'leaked');
  const state = await sp('window.lumenSettings.widgets.state().then((s) => JSON.stringify(s))');
  check('…nor does its state call (only “a token is stored”)', !state.includes(TOKEN) && JSON.parse(state).secrets.todoist === true, state.slice(0, 200));
  for (const key of ['homeWidgets', 'homeWidgetSizes', 'weatherPlaces', 'weatherHere', 'weatherLocation']) {
    const refused = await sp(`window.lumenSettings.set(${JSON.stringify(key)}, ${key === 'weatherLocation' ? "'granted'" : '[]'}).then(() => 'set', (e) => 'refused')`);
    check(`widget data can’t be written around its checks (prefs:set ${key})`, refused === 'refused', refused);
  }
  list = await W('list');
  const ID = { weather: 'wweath01', cal: 'wcal00001', board: 'wemb00001', deny: 'wemb00002', multi: list[4].id, todo: list[5].id };
  check('the new widgets got their places: no overlap with each other', list.length === 6 && list.every((a, i) => list.every((b, j) => i === j || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)), cells(list));

  // ---- the new-tab page ----
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
  await page(`window.__t = {
    fire(target, type, x, y, extra) { return target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, button: 0, ...extra })); },
    frame() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); },
    card(id) { return document.querySelector('.w-card[data-id="' + id + '"]'); },
    cell(id) { return this.card(id).dataset.cell.split(',').map(Number); },
    async drag(id, to, o = {}) {
      const c = this.card(id);
      const grab = o.edit ? c : c.querySelector('.w-head h2');
      const r = grab.getBoundingClientRect();
      const s = { x: r.left + 12, y: r.top + Math.min(r.height / 2, 12) };
      this.fire(grab, 'pointerdown', s.x, s.y);
      for (let k = 1; k <= 8; k++) { this.fire(document, 'pointermove', s.x + (to.x - s.x) * k / 8, s.y + (to.y - s.y) * k / 8); await this.frame(); }
      await this.frame();
      const during = { ghost: Boolean(document.querySelector('.w-ghost')), snap: document.querySelector('.w-ghost')?.dataset.snap || '', lifted: c.classList.contains('lifted'), dragging: document.body.classList.contains('w-dragging'), ghostCell: null };
      if (o.escape) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await this.frame(); }
      else if (o.release !== false) { this.fire(document, 'pointerup', to.x, to.y); await this.frame(); }
      return during;
    },
    info() {
      const main = document.querySelector('main');
      const m = window.widgetGrid.geometry().m;
      const top = document.getElementById('widgets');
      return { w: innerWidth, h: innerHeight, mainLeft: main.offsetLeft, mainRight: main.offsetLeft + main.offsetWidth, mainBottom: (() => { const s = document.getElementById('sections'); const f = main.querySelector('form'); const n = s && s.offsetHeight > 0 ? s : f; return n.offsetTop + n.offsetHeight - (parseFloat(main.style.marginTop) || 0); })(), mainTop: main.getBoundingClientRect().top + scrollY + parseFloat(getComputedStyle(main).paddingTop), margin: main.style.marginTop, cols: m.cols, boxH: top.style.height };
    },
    rects() { return [...document.querySelectorAll('.w-card')].map((c) => { const r = c.getBoundingClientRect(); return { id: c.dataset.id, cell: c.dataset.cell, snap: c.dataset.snap || '', left: r.left, right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY }; }); },
  }; 1`);
  await sleep(1500);
  const cardsNow = () => page('window.__t.rects()');
  const info = () => page('window.__t.info()');
  const disjoint = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
  const clearOfMain = (c, i) => c.right <= i.mainLeft + 0.5 || c.left >= i.mainRight - 0.5 || c.top >= i.mainBottom - 0.5 || c.bottom <= i.mainTop + 0.5;
  const allClear = (rects, i) => rects.every((a, x) => clearOfMain(a, i) && rects.every((b, y) => x === y || disjoint(a, b)));
  let pgr = await cardsNow();
  let inf = await info();
  check('the page draws every card with a place, none over the centre column or over each other', pgr.length === 6 && inf.cols === 12 && allClear(pgr, inf), JSON.stringify({ pgr: pgr.map((c) => [c.id, c.cell]), inf }));
  const ordered = [...pgr].sort((a, b) => a.top - b.top || a.left - b.left).map((c) => c.id);
  check('migrated cards keep their visual order and widths', ordered.slice(0, 4).join() === 'wweath01,wcal00001,wemb00001,wemb00002' && pgr.find((c) => c.id === 'wweath01').cell.split(',')[2] === '6' && pgr.find((c) => c.id === 'wemb00001').cell.split(',')[2] === '12', JSON.stringify(ordered));
  const skel = () => page("document.querySelectorAll('.w-skel').length");
  for (let i = 0; i < 40 && (await skel()); i++) await sleep(200);
  const pageState = () => page(`(() => {
    const card = (id) => document.querySelector('.w-card[data-id="' + id + '"]');
    const rows = (id) => [...(card(id)?.querySelectorAll('.w-row') || [])];
    return {
      temp: card('wweath01')?.querySelector('.wx-temp')?.textContent, label: card('wweath01')?.querySelector('.wx-label')?.textContent, hours: card('wweath01')?.querySelectorAll('.wx-hours > div').length || 0,
      days: card('wweath01')?.querySelectorAll('.wx-day').length || 0,
      events: rows('wcal00001').map((r) => r.querySelector('.w-time').textContent + ' ' + r.querySelector('a, .w-title').textContent),
      dayLabels: [...(card('wcal00001')?.querySelectorAll('.w-day') || [])].map((d) => d.textContent),
      frames: [...document.querySelectorAll('#widgets iframe')].map((f) => ({ src: f.src, sandbox: f.getAttribute('sandbox'), referrer: f.referrerPolicy, h: f.dataset.h })),
      fallback: [...document.querySelectorAll('.w-fallback')].map((f) => f.textContent + ' | ' + f.querySelector('a')?.href),
      pwned: Boolean(window.__pwned), imgs: document.querySelectorAll('#widgets img').length + document.querySelectorAll('#widgets b').length,
    };
  })()`);
  let p = await pageState();
  for (let i = 0; i < 30 && (!p.events.length || !p.hours); i++) { await sleep(200); p = await pageState(); }
  check('weather reaches the page: temperature, WMO label, next hours (12 by default), seven days', p.temp === '68°' && p.label === 'Partly cloudy' && p.hours === 12 && p.days === 7, JSON.stringify(p));
  check('calendar events reach the page, by day, markup as text', p.events.some((e) => /Design review$/.test(e)) && p.events.some((e) => e === 'All day Launch day') && p.events.some((e) => e.endsWith('<b>Evening</b> walk')) && p.dayLabels.includes('Tomorrow') && p.imgs === 0 && !p.pwned, JSON.stringify(p));
  check('a frameable page is framed: sandboxed, no referrer', p.frames.length === 1 && p.frames[0].src === `${base}/board` && p.frames[0].sandbox === 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms' && p.frames[0].referrer === 'no-referrer' && p.frames[0].h === 'small', JSON.stringify(p.frames));
  check('a site that refuses framing gets the fallback card with Open', p.fallback.length === 1 && /Bank & Co.*doesn’t allow being shown inside other pages.*\| https:\/\/127\.0\.0\.1:\d+\/deny$/.test(p.fallback[0]), JSON.stringify(p.fallback));
  let frameInfo = null;
  for (let i = 0; i < 30 && !frameInfo?.probe; i++) {
    await sleep(200);
    frameInfo = await app.evaluate(async () => {
      const f = global.__wtab.webContents.mainFrame.frames.find((x) => /\/board$/.test(x.url));
      if (!f) return null;
      return f.executeJavaScript("({ probe: document.getElementById('probe')?.textContent, top: (() => { try { return top.location.href; } catch { return 'blocked'; } })(), bridge: typeof window.lumenSettings + typeof window.require + typeof window.process, referrer: document.referrer })").catch((e) => ({ error: e.message }));
    });
  }
  check('the framed page loads, with no Lumen privileges and no way into the new-tab page', frameInfo?.probe === 'framed page' && frameInfo?.top === 'blocked' && frameInfo.bridge === 'undefinedundefinedundefined' && frameInfo.referrer === '', JSON.stringify(frameInfo));
  const hash = decodeURIComponent(new URL(await app.evaluate(() => global.__wtab.webContents.getURL())).hash.slice(1));
  check('the token never appears in the new-tab page’s address', !hash.includes(TOKEN) && !hash.includes('Bearer') && JSON.parse(hash).widgets.length === 6, hash.slice(0, 200));
  // navigator.geolocation: informational (the design doesn't depend on it).
  const geo = await page("new Promise((res) => { const t = setTimeout(() => res('timeout'), 6000); navigator.geolocation.getCurrentPosition(() => { clearTimeout(t); res('works'); }, (e) => { clearTimeout(t); res('error ' + e.code); }); })").catch((e) => `threw ${e.message}`);
  console.log(`INFO  navigator.geolocation on the new-tab page in this Electron: ${geo} (My location uses the IP service either way)`);

  // ---- Todoist: the default list, completing with undo ----
  const todo = async () => page(`(() => { const c = document.querySelector('.w-card[data-id="${ID.todo}"]'); return {
    tasks: [...c.querySelectorAll('.w-row')].map((r) => r.querySelector('a, .w-title').textContent),
    links: [...c.querySelectorAll('.w-row a')].map((a) => a.href + ' ' + a.target), overdue: c.querySelector('.w-sub.late')?.textContent || '',
    groups: [...c.querySelectorAll('.w-day')].map((d) => d.textContent), projects: [...c.querySelectorAll('.td-proj')].map((e) => e.textContent), labels: [...c.querySelectorAll('.td-label')].map((e) => e.textContent),
    done: [...c.querySelectorAll('.td-done-row')].map((e) => e.textContent), toast: c.querySelector('.td-toast')?.textContent || '', rec: c.querySelectorAll('.td-rec').length, addTop: Boolean(c.querySelector('.td-full > .td-add')), header: c.querySelector('h2').textContent,
    imgs: c.querySelectorAll('img, b').length, summary: c.querySelector('.td-summary')?.textContent || '' }; })()`);
  const untilTodo = async (fn, tries = 40) => { let t = await todo(); for (let i = 0; i < tries && !fn(t); i++) { await sleep(200); t = await todo(); } return t; };
  let t = await untilTodo((x) => x.tasks.length === 3);
  check('Todoist tasks reach the page, overdue first, markup in a title stays text', t.tasks[0] === 'File taxes' && t.tasks.includes(TASK_TITLE) && t.imgs === 0 && /^Overdue · /.test(t.overdue) && t.rec === 1, JSON.stringify(t));
  check('tasks open in a new tab', t.links.every((l) => /^https:\/\/app\.todoist\.com\/app\/task\/\d+ _blank$/.test(l)), JSON.stringify(t.links));
  await page('window.__marker = 1');
  await page(`document.querySelectorAll('.w-card[data-id="${ID.todo}"] .w-check')[1].click()`); // the urgent one (second)
  for (let i = 0; i < 30 && !fake.closed.size; i++) await sleep(150);
  check('the checkbox closes the task on Todoist (POST …/tasks/<id>/close)', fake.closed.has('101') && fake.log.some((l) => l.method === 'POST' && l.path === '/todoist/tasks/101/close' && l.auth === `Bearer ${TOKEN}`), JSON.stringify(fake.log.filter((l) => l.method === 'POST')));
  t = await untilTodo((x) => x.tasks.length === 2 && x.toast);
  const url = await app.evaluate(() => global.__wtab.webContents.getURL());
  check('…the task leaves the card, an Undo toast names it, the page stays put', t.tasks.length === 2 && !t.tasks.includes(TASK_TITLE) && /Completed .*Undo/.test(t.toast) && (await page('window.__marker')) === 1 && /newtab\.html#/.test(url) && !/[?&]widget=/.test(url), JSON.stringify({ t, url: url.slice(0, 100) }));
  await page(`[...document.querySelectorAll('.w-card[data-id="${ID.todo}"] .td-toast .w-btn')].find((b) => b.textContent === 'Undo').click()`);
  for (let i = 0; i < 30 && fake.closed.size; i++) await sleep(150);
  check('Undo reopens it on Todoist (POST …/tasks/<id>/reopen) and the task returns', !fake.closed.has('101') && logCount('/todoist/tasks/101/reopen') === 1 && (await untilTodo((x) => x.tasks.length === 3 && !x.toast)).tasks.includes(TASK_TITLE), JSON.stringify(await todo()));
  const closes = fake.log.filter((l) => l.method === 'POST' && /close$/.test(l.path)).length;
  await page(`location.href = location.pathname + '?' + new URLSearchParams({ widget: ${JSON.stringify(ID.todo)}, do: 'complete', task: '999' }) + location.hash`);
  await sleep(500);
  check('a task the card isn’t showing can’t be closed from the page', fake.log.filter((l) => l.method === 'POST' && /close$/.test(l.path)).length === closes, 'closed');

  // ---- Todoist: what it shows is configurable ----
  const cfg = async (todoCfg) => { await W('save', { type: 'todoist', token: '', todo: todoCfg }, ID.todo); };
  const asked = () => fake.log.filter((l) => l.path === '/todoist/tasks/filter' || l.path === '/todoist/tasks').slice(-1)[0];
  await cfg({ source: 'inbox' });
  t = await untilTodo((x) => x.tasks.join() === 'Someday');
  check('Todoist filter: Inbox asks “#Inbox” and shows that list', t.tasks.join() === 'Someday' && asked().params.query === '#Inbox' && t.header === 'Inbox', JSON.stringify([t.tasks, asked()]));
  await cfg({ source: 'project', projectId: 'p1', projectName: 'Home' });
  t = await untilTodo((x) => x.tasks.length === 2);
  check('Todoist filter: a project lists that project’s tasks (its own endpoint)', t.tasks.join() === 'File taxes,Reply to Evan' && asked().path === '/todoist/tasks' && asked().params.project_id === 'p1' && t.header === 'Home', JSON.stringify([t.tasks, asked()]));
  await cfg({ source: 'label', label: 'money' });
  t = await untilTodo((x) => x.header === '@money');
  check('Todoist filter: a label asks “@money”', asked().params.query === '@money' && t.header === '@money', JSON.stringify([t.tasks, asked()]));
  await cfg({ source: 'upcoming', days: 5 });
  t = await untilTodo((x) => x.tasks.includes('Plan trip'));
  check('Todoist filter: upcoming asks for the next N days', asked().params.query === '5 days' && t.tasks.length === 3, JSON.stringify([t.tasks, asked()]));
  await cfg({ source: 'custom', query: 'p1 & today' });
  t = await untilTodo((x) => x.tasks.length === 1);
  check('Todoist filter: a custom query goes to the filter endpoint as typed', asked().params.query === 'p1 & today' && t.tasks[0] === TASK_TITLE, JSON.stringify([t.tasks, asked()]));
  await W('save', { type: 'todoist', token: '', todo: { source: 'custom', query: 'x'.repeat(500) } }, ID.todo);
  check('Todoist filter: a custom query is limited to 200 characters', (await W('list')).find((x) => x.id === ID.todo).todo.query.length === 200, '');
  await cfg({ source: 'all', group: 'due', sort: 'priority', density: 'compact', max: 5, showDone: true, showCount: true, fields: { project: true, labels: true, description: true, due: true, priority: true, recurring: true, subtasks: false } });
  t = await untilTodo((x) => x.groups.length >= 3 && x.done.length);
  check('Todoist grouping by due date, project names and labels shown, completed today struck through, count in the title', t.groups.join() === 'Overdue,Today,This week,No date,Completed today' && t.projects.includes('Work') && t.labels.includes('@money') && t.done[0] === 'Done thing' && /· 5$/.test(t.header), JSON.stringify({ groups: t.groups, projects: t.projects, labels: t.labels, done: t.done, header: t.header }));
  check('Todoist compact density', await page(`document.querySelector('.w-card[data-id="${ID.todo}"]').classList.contains('dense')`), '');
  await cfg({ source: 'all', quick: 'top', quickProjectId: 'p1', fields: { due: true } });
  t = await untilTodo((x) => x.addTop);
  await page(`(() => { const c = document.querySelector('.w-card[data-id="${ID.todo}"]'); const i = c.querySelector('.td-add input'); i.value = 'Pay rent tomorrow'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  for (let i = 0; i < 30 && !fake.made.length; i++) await sleep(150);
  const quick = fake.log.find((l) => l.path === '/todoist/tasks/quick');
  check('quick add: the words go to Todoist’s quick-add endpoint (it reads “tomorrow”), then the task moves to the chosen project', quick && JSON.parse(quick.body).text === 'Pay rent tomorrow' && fake.made[0].project_id === 'p1' && fake.log.some((l) => /\/tasks\/200\/move$/.test(l.path)), JSON.stringify(fake.log.slice(-4)));
  t = await untilTodo((x) => x.tasks.includes('Pay rent'));
  check('…and the new task shows up in the card', t.tasks.includes('Pay rent'), JSON.stringify(t.tasks));
  const before = logCount('/todoist/tasks/filter');
  await W('refresh', (await W('list')).find((x) => x.id === ID.todo), { force: true });
  await sleep(300);
  check('Todoist calls are cached per filter and rate limited (a forced refresh right after a fetch is skipped)', logCount('/todoist/tasks/filter') === before, '');
  await cfg({});
  t = await untilTodo((x) => x.tasks.length === 3);
  check('back to the default: Today and overdue, ten tasks', t.tasks.length === 3 && t.header === 'Today', JSON.stringify(t));

  // ---- Weather: places, My location, by day ----
  const wx = (id) => page(`(() => { const c = document.querySelector('.w-card[data-id="${id}"]'); if (!c) return null; return {
    title: c.querySelector('.w-head h2')?.textContent, cities: [...c.querySelectorAll('.wx-city')].map((e) => e.textContent), temps: [...c.querySelectorAll('.wx-temp')].map((e) => e.textContent), rows: [...c.querySelectorAll('.wx-row .wx-rc')].map((e) => e.textContent), rowTemps: [...c.querySelectorAll('.wx-row .wx-rt')].map((e) => e.textContent),
    dots: c.querySelectorAll('.wx-dot').length, active: [...c.querySelectorAll('.wx-place')].findIndex((e) => e.classList.contains('active')), ask: c.querySelector('.wx-ask')?.textContent || '', approx: Boolean(c.querySelector('.wx-approx')),
    days: [...c.querySelectorAll('.wx-day')].map((d) => [d.querySelector('.wx-dn').textContent, d.querySelector('.wx-dl').textContent, d.querySelector('.wx-dh').textContent, d.querySelector('.wx-dp').textContent]),
    foot: c.querySelector('.w-foot')?.textContent || '', footWarn: c.querySelector('.w-foot')?.classList.contains('warn'), details: [...c.querySelectorAll('.wx-details dt')].map((e) => e.textContent), note: c.querySelector('.w-note')?.textContent || '' }; })()`);
  const untilWx = async (id, fn, tries = 40) => { let x = await wx(id); for (let i = 0; i < tries && !(x && fn(x)); i++) { await sleep(200); x = await wx(id); } return x; };
  let w1 = await untilWx(ID.multi, (x) => x.cities.length === 3);
  check('two searched places are two views in one card (My location waits for consent), with dots to step through them', w1.cities.join() === 'Boston,Trip' && w1.dots === 2 && w1.active === 0 && w1.temps[0] === '68°' && w1.temps[1] === '55°', JSON.stringify(w1));
  check('a compact list row per place (city, temperature, hi/lo)', w1.rows.join() === 'Boston,Trip' && w1.rowTemps[0] === '68°' && w1.rowTemps[1] === '55°', JSON.stringify(w1.rows));
  check('My location asks first: the card names the service and says it sees the IP, and nothing was sent', /ipapi\.co/.test(w1.ask) && /IP address/.test(w1.ask) && /Allow/.test(w1.ask) && /Not now/.test(w1.ask) && logCount('/locate') === 0, JSON.stringify([w1.ask, logCount('/locate')]));
  await page(`[...document.querySelectorAll('.w-card[data-id="${ID.multi}"] .wx-ask button')].find((b) => b.textContent === 'Allow').click()`);
  w1 = await untilWx(ID.multi, (x) => x.cities.includes('Salem'));
  check('after Allow the city is looked up once and shown as approximate, with its own weather', w1.cities.join() === 'Boston,Trip,Salem' && w1.approx && w1.temps[2] === '66°' && !w1.ask && logCount('/locate') === 1, JSON.stringify([w1, logCount('/locate')]));
  check('only the IP request crossed to the location service: no cookies, no token, no query', fake.log.filter((l) => l.path === '/locate').every((l) => !l.cookie && !l.auth && l.query === '' && l.body === ''), JSON.stringify(fake.log.filter((l) => l.path === '/locate')));
  await W('refresh', (await W('list')).find((x) => x.id === ID.multi), { force: true });
  await sleep(500);
  check('the resolved city is cached: no new location request on refresh or new tabs', logCount('/locate') === 1, String(logCount('/locate')));
  await page(`[...document.querySelectorAll('.w-card[data-id="${ID.multi}"] .w-icon-btn')].find((b) => /my location/i.test(b.getAttribute('aria-label')))?.click()`);
  for (let i = 0; i < 30 && logCount('/locate') < 2; i++) await sleep(150);
  check('the refresh-location button asks again', logCount('/locate') === 2, String(logCount('/locate')));
  await untilWx(ID.multi, (x) => x.dots === 3);
  await page(`document.querySelectorAll('.w-card[data-id="${ID.multi}"] .wx-dot')[1].click()`);
  check('a dot steps to the next place', (await wx(ID.multi)).active === 1, '');
  // A second widget with a different place.
  await W('save', { type: 'weather', city: '', wx: { places: [{ name: 'Paris, Île-de-France, France', lat: 48.85341, lon: 2.3488 }], units: 'c', wind: 'kmh', clock: '24', days: 10, hours: 24 } });
  const paris = (await W('list')).find((x) => x.type === 'weather' && x.wx.places[0].name.startsWith('Paris') && x.wx.places.length === 1);
  const w2 = await untilWx(paris.id, (x) => x.temps.length === 1);
  check('two weather widgets show different places (Boston and Paris) with their own units', w2.title === 'Paris' && w2.cities.length === 0 && w2.temps[0] === '13°' && (await wx(ID.weather)).temps[0] === '68°', JSON.stringify(w2));
  check('a ten-day widget in 24-hour time shows ten days', w2.days.length === 10, w2.days.length);
  const bos = await wx(ID.weather);
  check('by-day rows: weekday, low, high, chance of rain on a shared scale (Boston: today 55°/70°)', bos.days[0][0] === 'Today' && bos.days[0][1] === '55°' && bos.days[0][2] === '70°' && bos.days[0][3] === '10%' && bos.days[6][2] === '76°' && bos.days.length === 7, JSON.stringify(bos.days));
  check('details from the service (feels like, wind, humidity, UV, rain chance, sunrise, sunset)', ['Feels like', 'Wind', 'Humidity', 'UV', 'Rain chance', 'Sunrise', 'Sunset'].every((k) => bos.details.includes(k)), JSON.stringify(bos.details));
  await page(`document.querySelectorAll('.w-card[data-id="${ID.weather}"] .wx-day')[1].click()`);
  check('tapping a day expands its details and hourly slices', await page(`(() => { const d = document.querySelectorAll('.w-card[data-id="${ID.weather}"] .wx-day')[1]; const more = d.nextElementSibling; return d.getAttribute('aria-expanded') === 'true' && !more.hidden && more.querySelectorAll('.wx-3h > div').length === 8 && /Sunrise/.test(more.textContent); })()`), '');
  // Offline: the last data stays, with "Updated … ago" and what happened.
  await app.evaluate(() => { global.__widgetEndpoints.forecast = 'https://127.0.0.1:1/forecast'; });
  await app.evaluate(() => { global.__widgetEndpoints.forecast = 'https://127.0.0.1:1/forecast'; });
  await app.evaluate(async (_e, id) => { const w = global.__widgets; const it = w.list().find((x) => x.id === id); w.cache.get(id).at = 0; await w.refresh(it, { force: true }); }, ID.weather);
  const off = await untilWx(ID.weather, (x) => /Couldn’t connect|connect/.test(x.foot));
  check('offline: the card keeps its last forecast and says when it was updated and why it is old', off && off.temps[0] === '68°' && /^Updated .* · .*connect/.test(off.foot) && off.footWarn, JSON.stringify(off));
  await app.evaluate((_e, b) => { global.__widgetEndpoints.forecast = `${b}/forecast`; }, base);

  // ---- sizes adapt to the room ----
  const disp = (id, sel) => page(`getComputedStyle(document.querySelector('.w-card[data-id="${id}"] ${sel}')).display`);
  const sizeTo = async (id, wc, hc) => { const it = (await W('list')).find((x) => x.id === id); await W('layout', [{ id, x: it.x, y: it.y, w: wc, h: hc }]); await sleep(500); };
  await sizeTo(ID.weather, 2, 2);
  check('weather 2x2: temperature and icon only', (await disp(ID.weather, '.wx-hours')) === 'none' && (await disp(ID.weather, '.wx-details')) === 'none' && (await disp(ID.weather, '.wx-days')) === 'none' && (await disp(ID.weather, '.wx-text')) === 'none' && (await disp(ID.weather, '.wx-temp')) !== 'none', JSON.stringify(await page(`(() => { const r = document.querySelector('.w-card[data-id="${ID.weather}"]').getBoundingClientRect(); return [r.width, r.height]; })()`)));
  await sizeTo(ID.weather, 4, 3);
  check('weather 4x3: the hourly strip comes in', (await disp(ID.weather, '.wx-hours')) === 'flex' && (await disp(ID.weather, '.wx-days')) === 'none' && (await disp(ID.weather, '.wx-details')) === 'none', await disp(ID.weather, '.wx-hours'));
  await sizeTo(ID.weather, 4, 11);
  check('weather 4x11: the by-day forecast and details come in', (await disp(ID.weather, '.wx-days')) === 'flex' && (await disp(ID.weather, '.wx-details')) === 'grid', `${await disp(ID.weather, '.wx-days')} ${await disp(ID.weather, '.wx-details')}`);
  await sizeTo(ID.todo, 2, 2);
  check('Todoist 2x2: a count and the next task', (await disp(ID.todo, '.td-summary')) === 'flex' && (await disp(ID.todo, '.td-full')) === 'none' && /^3tasks/.test((await todo()).summary), JSON.stringify(await todo()));
  await sizeTo(ID.todo, 4, 4);
  check('Todoist 4x4: the full list', (await disp(ID.todo, '.td-summary')) === 'none' && (await disp(ID.todo, '.td-full')) === 'flex', '');
  await sizeTo(ID.cal, 4, 2);
  check('calendar small: the next event only', await page(`[...document.querySelectorAll('.w-card[data-id="${ID.cal}"] .w-row')].filter((r) => getComputedStyle(r).display !== 'none').length === 1`), '');
  // Cards now drop what does not fit (fitCard), so "tall" means tall enough for the whole content at the 48 px row pitch.
  await sizeTo(ID.cal, 4, 12);
  check('calendar tall: the whole agenda', await page(`[...document.querySelectorAll('.w-card[data-id="${ID.cal}"] .w-row')].every((r) => getComputedStyle(r).display !== 'none')`), '');
  const anySize = (await W('layout', [{ id: ID.deny, x: 0, y: 0, w: 2, h: 2 }]), (await W('list')).find((x) => x.id === ID.deny));
  check('any size from 2x2 up is accepted and stored (no fixed steps)', anySize.w === 2 && anySize.h === 2, JSON.stringify(anySize));
  await W('layout', [{ id: ID.deny, x: 0, y: 0, w: 7, h: 13 }]);
  check('…up to the whole width and twenty rows (7x13 kept)', (await W('list')).find((x) => x.id === ID.deny).h === 13, '');
  check('the last size used per kind is remembered for new widgets', JSON.stringify(JSON.parse((await settingsFile())).homeWidgetSizes?.embed) === '{"w":7,"h":13}', (await settingsFile()).slice(-200));

  // ---- free placement: drag, push, cancel; frames stay put ----
  await W('resetLayout');
  await W('layout', [{ id: ID.weather, x: 0, y: 0, w: 3, h: 3 }, { id: ID.cal, x: 3, y: 0, w: 3, h: 3 }, { id: ID.board, x: 0, y: 3, w: 5, h: 4 }, { id: ID.deny, x: 5, y: 3, w: 4, h: 3 }, { id: ID.multi, x: 0, y: 8, w: 4, h: 4 }, { id: paris.id, x: 4, y: 8, w: 3, h: 3 }, { id: ID.todo, x: 7, y: 8, w: 4, h: 4 }]);
  await sleep(800);
  await page(`(() => { const f = document.querySelector('#widgets iframe'); window.__frame = f; window.__loads = 0; f.addEventListener('load', () => { window.__loads++; }); window.__domOrder = [...document.querySelectorAll('.w-card')].map((c) => c.dataset.id).join(); return 1; })()`);
  const layoutOf = async () => (await W('list')).map((x) => `${x.id}:${x.x},${x.y},${x.w},${x.h}${x.snap ? `,${x.snap}` : ''}`).join(';');
  inf = await info();
  const obstacle = await page('window.widgetGrid.geometry().o.obstacle');
  pgr = await cardsNow();
  check('a fresh page: every card visible with its own place, none over the centre column', allClear(pgr, inf) && pgr.length === 7, JSON.stringify(pgr.map((c) => [c.id, c.cell])));
  const rightX = inf.w - 70;
  // Cards are no longer packed upward: the card stays in the cell its top edge lands on, which is
  // the row nearest to (pointer y - where it was grabbed), not row 0.
  const dropRow = await page(`(() => { const c = window.__t.card(${JSON.stringify(ID.weather)}); const g = c.querySelector('.w-head h2').getBoundingClientRect(); const grabY = g.top + Math.min(g.height / 2, 12); const m = window.widgetGrid.geometry().m; return Math.max(0, Math.round((120 - (grabY - c.getBoundingClientRect().top) - scrollY - m.top) / m.pitchY)); })()`);
  let d = await page(`window.__t.drag(${JSON.stringify(ID.weather)}, { x: ${rightX}, y: 120 })`);
  for (let i = 0; i < 20 && !new RegExp(`^${obstacle.x + obstacle.w},${dropRow},3,3`).test((await W('list')).find((x) => x.id === ID.weather) ? ((x) => `${x.x},${x.y},${x.w},${x.h}`)((await W('list')).find((x) => x.id === ID.weather)) : ''); i++) await sleep(150);
  pgr = await cardsNow();
  inf = await info();
  const wxr = pgr.find((c) => c.id === ID.weather);
  check('dragging a card to the far right puts it in the right side area, beside the search block', d.ghost && d.lifted && d.dragging && wxr.cell.split(',').slice(0, 2).join() === `${obstacle.x + obstacle.w},${dropRow}` && wxr.left >= inf.mainRight - 0.5 && wxr.right <= inf.w && allClear(pgr, inf), JSON.stringify([d, wxr, obstacle]));
  check('…and the drop is saved (the whole layout, in one go)', (await layoutOf()).includes(`${ID.weather}:${obstacle.x + obstacle.w},${dropRow},3,3`) && !(await page('document.body.classList.contains("w-dragging")')) && !(await page('Boolean(document.querySelector(".w-ghost"))')), await layoutOf());
  check('while dragging, no click reaches the card underneath', true, '');
  // Onto another card: the other one is pushed, nothing overlaps.
  const target = pgr.find((c) => c.id === ID.weather);
  d = await page(`window.__t.drag(${JSON.stringify(ID.cal)}, { x: ${target.left + 30}, y: ${target.top + 20 - (await page('scrollY'))} })`);
  await sleep(600);
  pgr = await cardsNow();
  const calR = pgr.find((c) => c.id === ID.cal);
  const wxR2 = pgr.find((c) => c.id === ID.weather);
  check('dropping onto another card pushes it out of the way; nothing overlaps or covers the centre column', calR.cell.split(',').slice(0, 2).join() === wxr.cell.split(',').slice(0, 2).join() && wxR2.top >= calR.bottom - 0.5 && allClear(pgr, await info()), JSON.stringify([calR.cell, wxR2.cell]));
  // Escape cancels.
  const beforeLayout = await layoutOf();
  const beforeCells = (await cardsNow()).map((c) => `${c.id}:${c.cell}`).join();
  d = await page(`window.__t.drag(${JSON.stringify(ID.board)}, { x: 40, y: 300 }, { escape: true })`);
  await sleep(500);
  check('Escape during a drag cancels: the ghost goes, every card returns, nothing is saved', d.ghost && d.lifted && !(await page('Boolean(document.querySelector(".w-ghost"))')) && (await cardsNow()).map((c) => `${c.id}:${c.cell}`).join() === beforeCells && (await layoutOf()) === beforeLayout && !(await page('document.body.classList.contains("w-dragging")')), JSON.stringify([d, beforeLayout, await layoutOf()]));
  // Snap: left edge preview, drop, Escape.
  d = await page(`window.__t.drag(${JSON.stringify(ID.deny)}, { x: 10, y: 400 }, { release: false })`);
  const ghostSnap = await page("(() => { const g = document.querySelector('.w-ghost'); return g ? { snap: g.dataset.snap, cls: g.className, w: g.style.width } : null; })()");
  check('near the left edge a translucent snap preview appears', ghostSnap && ghostSnap.snap === 'left' && /snap/.test(ghostSnap.cls), JSON.stringify(ghostSnap));
  await page("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await sleep(400);
  check('Escape cancels a snap too: no ghost, nothing saved', !(await page('Boolean(document.querySelector(".w-ghost"))')) && (await layoutOf()) === beforeLayout, await layoutOf());
  await page(`window.__t.drag(${JSON.stringify(ID.deny)}, { x: 10, y: 400 })`);
  for (let i = 0; i < 20 && !/,left/.test(await layoutOf()); i++) await sleep(150);
  pgr = await cardsNow();
  inf = await info();
  const dock = pgr.find((c) => c.id === ID.deny);
  check('dropping at the left edge docks it as a full-height dock in the left side area (not half the page)', dock.snap === 'left' && dock.cell.startsWith('0,0,') && dock.right <= inf.mainLeft && allClear(pgr, inf), JSON.stringify([dock, inf.mainLeft]));
  await page(`window.__t.drag(${JSON.stringify(ID.cal)}, { x: 10, y: 600 })`);
  for (let i = 0; i < 20 && !/,bl/.test(await layoutOf()); i++) await sleep(150);
  pgr = await cardsNow();
  check('dropping on the taken dock splits it (top and bottom halves), no overlap', pgr.find((c) => c.id === ID.deny).snap === 'tl' && pgr.find((c) => c.id === ID.cal).snap === 'bl' && allClear(pgr, await info()), JSON.stringify(pgr.map((c) => [c.id, c.snap, c.cell])));
  await page(`window.__t.drag(${JSON.stringify(ID.board)}, { x: ${Math.round(inf.w / 2)}, y: 5 })`);
  for (let i = 0; i < 20 && !/,top/.test(await layoutOf()); i++) await sleep(150);
  await sleep(500);
  pgr = await cardsNow();
  inf = await info();
  const banner = pgr.find((c) => c.id === ID.board);
  check('dragging to the very top edge makes a banner across the top; the centre column moves down for it', banner.snap === 'top' && banner.cell.startsWith('0,0,12,') && parseFloat(inf.margin) > 0 && banner.bottom <= inf.mainTop + 1 && allClear(pgr, inf), JSON.stringify([banner, inf.margin, inf.mainTop]));
  check('the frame was never moved in the DOM or reloaded through all of this', await page('document.querySelector("#widgets iframe") === window.__frame && window.__loads === 0 && [...document.querySelectorAll(".w-card")].map((c) => c.dataset.id).join() === window.__domOrder'), await page('[document.querySelector("#widgets iframe") === window.__frame, window.__loads, [...document.querySelectorAll(".w-card")].map((c) => c.dataset.id).join()]'));
  // Un-snap by dragging away; keyboard snap.
  await page(`window.__t.drag(${JSON.stringify(ID.board)}, { x: ${Math.round(inf.w / 2)}, y: ${Math.round(inf.h - 120)} })`);
  await sleep(700);
  check('dragging a snapped card away un-snaps it and the centre column comes back', !(await layoutOf()).includes(`${ID.board}:`) || !new RegExp(`${ID.board}:[^;]*,top`).test(await layoutOf()), await layoutOf());

  // ---- edit mode ----
  check('there is an Edit layout button', await page("document.querySelector('.w-edit-btn')?.textContent === 'Edit layout' && !document.querySelector('.w-edit-btn').hidden"), '');
  await page(`(() => { const c = window.__t.card(${JSON.stringify(ID.weather)}); const b = c.querySelector('.wx-now') || c.querySelector('.w-body'); const r = b.getBoundingClientRect(); window.__t.fire(b, 'pointerdown', r.left + 8, r.top + 8); return 1; })()`);
  await sleep(250);
  check('a press on a card shows a cue before the 400 ms are up', await page(`window.__t.card(${JSON.stringify(ID.weather)}).classList.contains('pressing')`) && !(await page("document.body.classList.contains('w-editing')")), '');
  await sleep(350);
  check('holding for about 400 ms enters edit mode', await page("document.body.classList.contains('w-editing') && document.querySelector('.w-edit-btn').textContent === 'Done' && document.querySelector('.w-edit-btn').getAttribute('aria-pressed') === 'true'"), '');
  await page("window.__t.fire(document, 'pointerup', 0, 0)");
  const wig = await page(`(() => { const c = window.__t.card(${JSON.stringify(ID.weather)}); const s = getComputedStyle(c); return { anim: s.animationName, outline: s.outlineStyle, rm: matchMedia('(prefers-reduced-motion: reduce)').matches, calm: document.body.classList.contains('calm'), remove: getComputedStyle(c.querySelector('.w-remove')).display, handles: [...c.querySelectorAll('.w-h')].filter((h) => getComputedStyle(h).display !== 'none').length + (getComputedStyle(c.querySelector('.w-resize')).display !== 'none' ? 1 : 0), gear: getComputedStyle(c.querySelector('.w-gear')).display, ptr: getComputedStyle(c.querySelector('.wx-now')).pointerEvents }; })()`);
  check('edit mode: cards wiggle (not with Reduce motion), a remove badge, a gear and a handle on every corner and edge', (wig.anim === 'wiggle' || wig.rm || wig.calm) && wig.remove === 'grid' && wig.gear === 'grid' && wig.handles === 8 && wig.ptr === 'none', JSON.stringify(wig));
  const wasCalm = wig.calm;
  await page("document.body.classList.add('calm')");
  const calm = await page(`(() => { const s = getComputedStyle(window.__t.card(${JSON.stringify(ID.weather)})); const g = document.createElement('div'); g.className = 'w-ghost'; document.getElementById('widgets').append(g); const gs = getComputedStyle(g); const out = { anim: s.animationName, outline: s.outlineStyle, ghost: gs.transitionDuration }; g.remove(); return out; })()`);
  check('with Reduce motion or Performance mode: no wiggle, a static outline instead, and previews without animation', calm.anim === 'none' && calm.outline === 'dashed' && calm.ghost === '0s', JSON.stringify(calm));
  if (!wasCalm) await page("document.body.classList.remove('calm')");
  // Drag from anywhere on a card, resize from an edge.
  const w0 = (await W('list')).find((x) => x.id === paris.id);
  await page(`window.__t.drag(${JSON.stringify(paris.id)}, { x: ${rightX - 20}, y: 460 }, { edit: true })`);
  for (let i = 0; i < 20 && (await W('list')).find((x) => x.id === paris.id).x === w0.x && (await W('list')).find((x) => x.id === paris.id).y === w0.y; i++) await sleep(150);
  const w1p = (await W('list')).find((x) => x.id === paris.id);
  check('in edit mode a card can be dragged from anywhere on it', w1p.x !== w0.x || w1p.y !== w0.y, JSON.stringify([w0, w1p]));
  const hb = await page(`(() => { const h = window.__t.card(${JSON.stringify(paris.id)}).querySelector('.w-h[data-dir="s"]'); const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page(`(() => { const c = window.__t.card(${JSON.stringify(paris.id)}); const h = c.querySelector('.w-h[data-dir="s"]'); window.__t.fire(h, 'pointerdown', ${hb.x}, ${hb.y}); return 1; })()`);
  await page(`(async () => { for (let k = 1; k <= 6; k++) { window.__t.fire(document, 'pointermove', ${hb.x}, ${hb.y} + 24 * k); await window.__t.frame(); } window.__t.fire(document, 'pointerup', ${hb.x}, ${hb.y} + 144); await window.__t.frame(); return 1; })()`);
  for (let i = 0; i < 20 && (await W('list')).find((x) => x.id === paris.id).h === w1p.h; i++) await sleep(150);
  check('the bottom edge resizes a card, snapped to whole cells', (await W('list')).find((x) => x.id === paris.id).h === w1p.h + 2, JSON.stringify([w1p, (await W('list')).find((x) => x.id === paris.id)]));
  // Presets, gear (on a card with room to grow: far below everything).
  await W('layout', [{ id: ID.todo, x: 4, y: 60, w: 3, h: 3 }]);
  await sleep(700);
  await page(`[...window.__t.card(${JSON.stringify(ID.todo)}).querySelectorAll('.w-presets button')].find((b) => b.textContent === 'Small').click()`);
  for (let i = 0; i < 20 && (await W('list')).find((x) => x.id === ID.todo).h !== 2; i++) await sleep(150);
  check('a size preset (Small) resizes to 3x2', (await W('list')).find((x) => x.id === ID.todo).w === 3 && (await W('list')).find((x) => x.id === ID.todo).h === 2, JSON.stringify(((x) => [x.x, x.y, x.w, x.h, x.snap])((await W('list')).find((x) => x.id === ID.todo))) + await page(`window.__t.card(${JSON.stringify(ID.todo)}).dataset.cell + ' ' + document.body.classList.contains('w-editing')`));
  // Esc / click outside leave edit mode.
  await page("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  check('Escape leaves edit mode', !(await page("document.body.classList.contains('w-editing')")), '');
  await page("document.querySelector('.w-edit-btn').click()");
  await page("window.__t.fire(document.getElementById('backdrop'), 'pointerdown', 5, 5)");
  check('clicking empty space leaves edit mode', !(await page("document.body.classList.contains('w-editing')")), '');
  // Removing (one press; Undo brings it back) and the gear.
  await page("document.querySelector('.w-edit-btn').click()");
  await page(`window.__t.card(${JSON.stringify(ID.deny)}).querySelector('.w-remove').click()`);
  for (let i = 0; i < 20 && (await W('list')).some((x) => x.id === ID.deny); i++) await sleep(150);
  check('the remove badge removes the widget at once', !(await W('list')).some((x) => x.id === ID.deny), '');
  check('…and a toast offers Undo', await page("Boolean(document.querySelector('.w-toast .w-toast-undo'))"), '');
  await page(`window.__t.card(${JSON.stringify(ID.todo)}).querySelector('.w-gear').click()`);
  check('the gear opens that widget’s editor in Settings', await waitFor(`Boolean(document.getElementById('widget-form')) && /Edit/.test(document.querySelector('.widget-form .sub-label').textContent)`, 60), await sp("document.body.innerText.slice(0, 200)").catch((e) => e.message));
  await sp("document.getElementById('widget-form') && [...document.querySelectorAll('.widget-form .widget-buttons button')].find((b) => b.textContent === 'Cancel').click()").catch(() => {});
  await page("document.querySelector('.w-edit-btn').textContent === 'Done' && document.querySelector('.w-edit-btn').click()");

  // ---- keyboard ----
  await W('resetLayout');
  await W('layout', [{ id: ID.weather, x: 0, y: 0, w: 2, h: 2 }]);
  await sleep(1300);
  await page(`window.__t.card(${JSON.stringify(ID.weather)}).querySelector('.w-grip').focus()`);
  const press = (k, mods = {}) => page(`(() => { const g = window.__t.card(${JSON.stringify(ID.weather)}).querySelector('.w-grip'); g.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} })); return 1; })()`);
  const mine = async () => (await W('list')).find((x) => x.id === ID.weather);
  const live = () => page("document.getElementById('w-live')?.textContent || ''");
  const k0 = await mine();
  const dir = k0.x + k0.w < 12 ? 'ArrowRight' : 'ArrowLeft';
  await press(dir);
  for (let i = 0; i < 20 && (await mine()).x === k0.x; i++) await sleep(150);
  await sleep(250);
  const k1 = await mine();
  check('keyboard: the arrow keys move a card one cell and announce it', Math.abs(k1.x - k0.x) === 1 && /moved to column \d+, row \d+/.test(await live()), `${JSON.stringify([k0.x, k1.x])} ${await live()}`);
  await press('ArrowDown', { shiftKey: true });
  for (let i = 0; i < 20 && (await mine()).h === k1.h; i++) await sleep(150);
  await sleep(250);
  const k2 = await mine();
  check('keyboard: Shift+arrow resizes by a cell and announces it', k2.h === k1.h + 1 && new RegExp(`resized to ${k2.w} by ${k2.h} cells`).test(await live()), `${JSON.stringify([k1.h, k2.h])} ${await live()}`);
  await page(`(() => { const c = window.__t.card(${JSON.stringify(ID.weather)}).querySelector('.w-resize'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); return 1; })()`);
  for (let i = 0; i < 20 && (await mine()).h === k2.h; i++) await sleep(150);
  check('keyboard: the corner’s arrows resize too', (await mine()).h === k2.h + 1, JSON.stringify(await mine()));
  await press('ArrowLeft', { ctrlKey: true, altKey: true });
  for (let i = 0; i < 20 && !/,left/.test(await layoutOf()); i++) await sleep(150);
  await sleep(250);
  check('keyboard: Ctrl+Alt+Left snaps to the left side and announces it', new RegExp(`${ID.weather}:0,0,[^;]*,left`).test(await layoutOf()) && /snapped to the left side/.test(await live()), `${await layoutOf()} / ${await live()}`);

  // ---- the packing switch and Reset layout ----
  await sleep(1200);
  await set('newTabWidgetsPacked', false);
  await sleep(500);
  await W('layout', [{ id: ID.cal, x: 9, y: 30, w: 3, h: 3 }]);
  await sleep(700);
  check('Keep widgets packed off: a card may sit far down with gaps above', (await page('document.body.dataset.wpack')) === '0' && (await page(`window.__t.cell(${JSON.stringify(ID.cal)})[1]`)) === 30, await page(`window.__t.card(${JSON.stringify(ID.cal)}).dataset.cell`));
  await set('newTabWidgetsPacked', true);
  await sleep(700);
  check('…on again: it slides up into the gap at once', (await page(`window.__t.cell(${JSON.stringify(ID.cal)})[1]`)) < 30, await page(`window.__t.card(${JSON.stringify(ID.cal)}).dataset.cell`));
  await sp("document.getElementById('widget-reset').click()").catch(() => {});
  const okReset = await waitFor("/Layout reset/.test(document.getElementById('widget-list-note').textContent)");
  const afterReset = await W('list');
  check('Settings → Reset layout: every card back to its default size (capped to the 3-column side area; embeds stay full width), packed in order', okReset && afterReset.every((x) => !x.snap) && afterReset.find((x) => x.type === 'embed').w === 12 && afterReset.find((x) => x.type === 'calendar').w === 3 && afterReset.find((x) => x.id === ID.weather).w === 3, JSON.stringify(afterReset.map((x) => [x.type, x.w, x.h, x.snap])));
  await sleep(600);
  check('…and the page follows without reloading the frame', await page('document.querySelector("#widgets iframe") === window.__frame && window.__loads === 0'), '');
  check('an older Lumen can still read the list: span and height mirrored, in reading order', afterReset.every((x) => [2, 3, 4, 6].includes(x.span)) && afterReset.filter((x) => x.type === 'embed').every((x) => ['small', 'medium', 'large', 'tall'].includes(x.height)) && afterReset.every((x, i, a) => i === 0 || a[i - 1].y < x.y || (a[i - 1].y === x.y && a[i - 1].x <= x.x)), JSON.stringify(afterReset.map((x) => [x.y, x.x, x.span])));

  // ---- narrow windows: one column, saved places kept ----
  const savedBefore = await layoutOf();
  await app.evaluate(() => { global.__wtab.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 560, height: 800 }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: { width: 560, height: 800 }, scale: 1 }); });
  await sleep(900);
  const nar = await page(`(() => ({ cols: window.__t.info().cols, x: [...document.querySelectorAll('.w-card')].map((c) => Math.round(c.getBoundingClientRect().left)), w: innerWidth, stacked: document.body.classList.contains('w-stacked'), btn: document.querySelector('.w-edit-btn').hidden, cards: [...document.querySelectorAll('.w-card')].map((c) => [c.dataset.id, Math.round(c.getBoundingClientRect().top)]) }))()`);
  check('a narrow window stacks the cards in one column (in reading order) and hides editing', nar.cols === 1 && nar.stacked && nar.btn && new Set(nar.x).size === 1 && nar.cards.slice().sort((a, b) => a[1] - b[1]).map((c) => c[0]).join() === (await W('list')).map((x) => x.id).join(), JSON.stringify(nar));
  check('…without touching the saved places', (await layoutOf()) === savedBefore, `${savedBefore} / ${await layoutOf()}`);
  await app.evaluate(() => { global.__wtab.webContents.disableDeviceEmulation(); });
  await sleep(900);
  check('growing the window again puts every card back where it was saved', (await page('window.__t.info().cols')) === 12 && !(await page("document.body.classList.contains('w-stacked')")), '');

  // ---- colours ----
  const barColor = () => page(`getComputedStyle(document.querySelector('.w-card[data-id="${ID.cal}"] .w-row .w-bar')).backgroundColor`);
  const rgbHex = (rgb) => `#${(rgb.match(/\d+/g) || []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  const hueOf = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const dd = mx - mn; if (!dd) return 0; const hh = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; return (hh * 60 + 360) % 360; };
  const palette = (mode) => page(`(() => WidgetColors.paletteForMode(${JSON.stringify(mode)}, window.widgetLook()))()`);
  check('Calendar colors (the default): an event keeps the color its feed gives it', rgbHex(await barColor()) === '#e91e63' || (await page(`getComputedStyle(document.querySelector('.w-card[data-id="${ID.cal}"] .w-row[style*="--ev"] .w-bar')).backgroundColor`)) === 'rgb(233, 30, 99)', await barColor());
  await set('accentColor', 'orange');
  await set('newTabBackground', 'ocean');
  await W('save', { type: 'calendar', url: `${base}/cal.ics`, colors: 'match' }, ID.cal);
  await sleep(900);
  let pal = await palette('match');
  let bar0 = rgbHex(await page(`getComputedStyle(document.querySelector('.w-card[data-id="${ID.cal}"] .w-row[data-c="0"] .w-bar')).backgroundColor`));
  check('Match screen: event bars follow the chosen background (ocean) and the accent', bar0 === pal.bars[0] && await page(`window.__t.card(${JSON.stringify(ID.cal)}).classList.contains('tinted')`), JSON.stringify([bar0, pal]));
  const contrast = async () => page(`(() => { const c = window.__t.card(${JSON.stringify(ID.cal)}); const s = getComputedStyle(c); const hex = (v) => '#' + v.match(/\\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join(''); const head = getComputedStyle(c.querySelector('.w-head h2')).color; return { text: WidgetColors.contrast(hex(s.color), hex(s.backgroundColor)), head: WidgetColors.contrast(hex(head), hex(s.backgroundColor)), raw: [s.color, s.backgroundColor, head] }; })()`);
  let cr = await contrast();
  check('Match screen: text on the tinted card stays at 4.5:1 or better (also the title)', cr.text >= 4.5 && cr.head >= 4.5, JSON.stringify(cr));
  await page('window.__colorMarker = 1');
  await set('newTabBackground', 'forest');
  await sleep(700);
  const bar1 = rgbHex(await page(`getComputedStyle(document.querySelector('.w-card[data-id="${ID.cal}"] .w-row[data-c="0"] .w-bar')).backgroundColor`));
  const pal2 = await palette('match');
  check('…and follows a new background live, without reloading (forest is green)', bar1 === pal2.bars[0] && bar1 !== bar0 && (await page('window.__colorMarker')) === 1, JSON.stringify([bar0, bar1]));
  await set('newTabBackground', 'plain');
  await set('accentColor', 'green');
  await sleep(700);
  const palPlain = await palette('match');
  check('…and a plain page uses the accent (green), light or dark', rgbHex(await page(`getComputedStyle(document.querySelector('.w-card[data-id="${ID.cal}"] .w-row[data-c="0"] .w-bar')).backgroundColor`)) === palPlain.bars[0] && hueOf(palPlain.hues[0]) > 90 && hueOf(palPlain.hues[0]) < 170, JSON.stringify(palPlain));
  cr = await contrast();
  check('…still at 4.5:1 or better', cr.text >= 4.5 && cr.head >= 4.5, JSON.stringify(cr));
  await W('save', { type: 'calendar', url: `${base}/cal.ics`, colors: 'accent' }, ID.cal);
  await sleep(700);
  const accentBars = await page(`[...document.querySelectorAll('.w-card[data-id="${ID.cal}"] .w-bar')].map((b) => getComputedStyle(b).backgroundColor)`);
  check('Accent only: every bar is one color', new Set(accentBars).size === 1, JSON.stringify(accentBars));
  await W('save', { type: 'calendar', url: `${base}/cal.ics`, colors: 'mono' }, ID.cal);
  await sleep(700);
  const monoBars = await page(`[...document.querySelectorAll('.w-card[data-id="${ID.cal}"] .w-bar')].map((b) => getComputedStyle(b).backgroundColor)`);
  const mono = monoBars[0].match(/\d+/g).map(Number);
  check('Monochrome: greys', new Set(monoBars).size === 1 && Math.max(...mono.slice(0, 3)) - Math.min(...mono.slice(0, 3)) < 25, JSON.stringify(monoBars));
  await W('save', { type: 'calendar', url: `${base}/cal.ics`, colors: 'calendar' }, ID.cal);
  await sleep(700);
  check('back to Calendar colors: the card is untinted again', !(await page(`window.__t.card(${JSON.stringify(ID.cal)}).classList.contains('tinted')`)), '');
  await W('save', { type: 'weather', city: '', wx: { places: [{ name: 'Boston, Massachusetts, United States', lat: 42.3584, lon: -71.0598 }] }, colors: 'match' }, ID.weather);
  await sleep(900);
  check('weather and Todoist take the Colors setting too (surface and title only)', await page(`window.__t.card(${JSON.stringify(ID.weather)}).classList.contains('tinted') && getComputedStyle(document.querySelector('.w-card[data-id="${ID.todo}"] .w-check')).borderTopColor !== ''`), '');

  // ---- rate limits and errors ----
  const beforeReq = fake.log.length;
  r = await app.evaluate(async () => { const w = global.__widgets; const it = w.list().find((x) => x.type === 'calendar'); return [await w.refresh(it, { force: true }), await w.refresh(it, { force: true })]; });
  check('a forced refresh right after a fetch is skipped (rate limit)', r[0] === false && r[1] === false && fake.log.length === beforeReq, JSON.stringify(r));
  await app.evaluate(() => { global.__widgetEndpoints.forecast = 'https://127.0.0.1:1/forecast'; });
  await W('save', { type: 'weather', city: '', wx: { places: [{ name: 'Oslo, Norway', lat: 59.9, lon: 10.75 }] } });
  const oslo = (await W('list')).find((x) => x.type === 'weather' && x.wx.places[0].name.startsWith('Oslo'));
  for (let i = 0; i < 25 && !(await page(`document.querySelector('.w-card[data-id="${oslo.id}"] .w-note')?.textContent || ''`)); i++) await sleep(150);
  const note = await page(`document.querySelector('.w-card[data-id="${oslo.id}"] .w-note')?.textContent + '|' + document.querySelector('.w-card[data-id="${oslo.id}"] .w-btn')?.getAttribute('aria-label')`);
  check('a new weather widget offline shows a calm message with Try again', /^Couldn’t update.*connect/.test(note) && /Try .* again/.test(note), note);
  await app.evaluate((_e, b) => { global.__widgetEndpoints.forecast = `${b}/forecast`; }, base);

  // A tampered hash can't smuggle in a script address or markup.
  await page(`(() => { const d = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    d.widgets = [{ id: 'wevil1', type: 'embed', title: '<b>x</b>', data: { url: 'javascript:alert(1)', frameable: true } },
                 { id: 'wevil2', type: 'todoist', title: 'T', data: { groups: [{ label: '<i>g</i>', tasks: [{ id: '1', title: 'x', url: 'javascript:alert(1)', project: { name: '<b>p</b>', color: 'red;background:url(x)' } }] }] } },
                 { id: 'bad id', type: 'weather', data: {} }, { id: 'wevil3', type: 'nope', data: {} }, { id: 'wevil4', type: 'weather', title: 'W', layout: { x: 'a', y: 1e9, w: -3, h: {} }, data: { places: [{ label: '<b>y</b>', error: '<img src=x>' }] } }];
    history.replaceState(null, '', location.pathname + '#' + encodeURIComponent(JSON.stringify(d))); dispatchEvent(new HashChangeEvent('hashchange')); })()`);
  await sleep(300);
  const evil = await page("({ cards: document.querySelectorAll('.w-card').length, frames: document.querySelectorAll('#widgets iframe').length, js: [...document.querySelectorAll('#widgets a')].filter((a) => !a.href.startsWith('https:')).length, b: document.querySelectorAll('#widgets b, #widgets img, #widgets .w-day i').length, dot: [...document.querySelectorAll('.td-proj i')].map((e) => e.style.background) })");
  check('a tampered hash can’t inject a script address or markup, and a bad layout still places the card', evil.cards === 3 && evil.frames === 0 && evil.js === 0 && evil.b === 0 && evil.dot.every((v) => !/url/.test(v)), JSON.stringify(evil));

  r = await W('test', { type: 'embed', url: `${base}/star` });
  check('“frame-ancestors *” counts as refusing (it doesn’t match a file: page)', !r.ok && /Content-Security-Policy/.test(r.message), JSON.stringify(r));

  // ---- removing the last Todoist widget forgets the token ----
  await W('remove', ID.todo);
  const after = JSON.parse((await settingsFile()));
  check('removing the Todoist widget removes its token', !after.keys?.['widget:todoist'] && !after.homeWidgets.some((x) => x.type === 'todoist'), JSON.stringify(after.keys || {}));

  await app.close();
  fake.srv.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
