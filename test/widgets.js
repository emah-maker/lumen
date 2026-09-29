// New-tab widgets (features/widgets.js, features/ics.js, renderer/newtab-widgets.js): weather,
// Todoist, a calendar (ICS) and web pages, added from Settings, drawn on the new-tab page, kept
// fresh live, with tokens that never leave the main process. Offline: a local https server (a
// throwaway self-signed certificate) stands in for Open-Meteo, Todoist, a calendar feed and sites
// with and without X-Frame-Options.
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const ics = require('../features/ics');

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
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today.getTime() - 86400e3);
  const utc = (d, h) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}0000Z`;
  const tomorrow = new Date(today.getTime() + 86400e3);
  const icsText = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Muse schedule',
    'BEGIN:VEVENT', 'UID:e1', `DTSTART:${utc(tomorrow, 14)}`, `DTEND:${utc(tomorrow, 15)}`, 'SUMMARY:Design review', 'LOCATION:Studio', 'URL:https://example.com/review', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e2', `DTSTART;VALUE=DATE:${ymd(tomorrow).replace(/-/g, '')}`, 'SUMMARY:Launch day', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e3', `DTSTART:${utc(new Date(today.getTime() - 7 * 86400e3), 23)}`, 'DURATION:PT30M', 'RRULE:FREQ=DAILY', 'SUMMARY:<b>Evening</b> walk', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const tasks = () => [
    { id: '101', content: TASK_TITLE, priority: 4, due: { date: ymd(today), is_recurring: false, string: 'today' } },
    { id: '102', content: 'Reply to Evan', priority: 1, due: { date: `${ymd(today)}T15:00:00`, string: 'today 3pm' } },
    { id: '103', content: 'File taxes', priority: 3, due: { date: ymd(yesterday), string: 'yesterday' } },
  ].filter((t) => !closed.has(t.id));
  const srv = https.createServer(opts, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    log.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization || '', cookie: req.headers.cookie || '' });
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/geo') {
      if (/nowhere/i.test(u.searchParams.get('name'))) return json(200, { generationtime_ms: 0.1 });
      return json(200, { results: [{ name: 'Boston', admin1: 'Massachusetts', country: 'United States', latitude: 42.35843, longitude: -71.05977, timezone: 'America/New_York' }] });
    }
    if (u.pathname === '/forecast') {
      const c = u.searchParams.get('temperature_unit') === 'celsius';
      const t = (f) => (c ? Math.round((f - 32) * 5 / 9 * 10) / 10 : f);
      const hours = [...Array(7)].map((_, i) => `2026-09-28T${String(13 + i).padStart(2, '0')}:00`);
      return json(200, {
        current: { time: '2026-09-28T13:30', temperature_2m: t(68.4), apparent_temperature: t(66.9), weather_code: 2, is_day: 1 },
        hourly: { time: hours, temperature_2m: hours.map((_, i) => t(68 + i)), weather_code: [2, 2, 3, 61, 61, 95, 0], is_day: [1, 1, 1, 1, 1, 1, 0] },
        daily: { time: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'], weather_code: [2, 61, 3, 0, 71], temperature_2m_max: [t(72), t(65), t(70), t(75), t(40)], temperature_2m_min: [t(55), t(54), t(57), t(61), t(30)] },
      });
    }
    if (u.pathname.startsWith('/todoist/')) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'Unauthorized' });
      if (u.pathname === '/todoist/tasks/filter' && req.method === 'GET') return json(200, { results: tasks(), next_cursor: null });
      const m = /^\/todoist\/tasks\/(\w+)\/close$/.exec(u.pathname);
      if (m && req.method === 'POST') { closed.add(m[1]); res.writeHead(204); return res.end(); }
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
  return { srv, log, closed, icsText };
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

  // --ignore-certificate-errors: the stand-in's certificate is self-signed.
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const profile = await app.evaluate(({ app: a }) => a.getPath('userData'));
  await app.evaluate((_e, b) => { global.__widgetEndpoints = { geocode: `${b}/geo`, forecast: `${b}/forecast`, todoist: `${b}/todoist` }; }, base);
  const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);

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
  check('todoist: the token is checked with one call', r.ok && /3 tasks are due today or overdue/.test(r.message), JSON.stringify(r));
  const settingsText = () => { try { return fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'); } catch { return '{}'; } };
  check('…and nothing was stored by a check', !settingsText().includes('widget:todoist'), 'stored');
  check('requests carry no cookies, and the token only goes to Todoist', fake.log.every((l) => !l.cookie) && fake.log.filter((l) => l.auth).every((l) => l.path.startsWith('/todoist/')), JSON.stringify(fake.log.slice(-3)));

  // ---- adding widgets from the Settings page (its own preload and IPC) ----
  const settingsId = await app.evaluate(() => global.__settings.open('appearance'));
  const sp = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [settingsId, code]);
  for (let i = 0; i < 40 && !(await sp("Boolean(document.body.dataset.ready && document.getElementById('widget-add'))").catch(() => false)); i++) await sleep(150);
  const addFromSettings = async (fill) => {
    await sp("document.getElementById('widget-add').click()");
    await sp(fill);
    await sp("document.getElementById('widget-save').click()");
    for (let i = 0; i < 40 && (await sp("Boolean(document.getElementById('widget-form'))")); i++) await sleep(150);
    return sp("({ items: [...document.querySelectorAll('.widget-item')].map((e) => e.textContent), note: document.getElementById('widget-list-note').textContent, formNote: document.getElementById('widget-note')?.textContent || '' })");
  };
  let s = await addFromSettings("document.getElementById('widget-city').value = 'Boston'; document.getElementById('widget-units').value = 'f';");
  check('Settings: a weather widget is added', s.items.length === 1 && /Boston, Massachusetts, United States · °F/.test(s.items[0]), JSON.stringify(s));
  s = await addFromSettings(`document.querySelector('.seg [data-type=todoist]').click(); document.getElementById('widget-token').value = ${JSON.stringify(TOKEN)};`);
  check('Settings: a Todoist widget is added with its token', s.items.length === 2 && /Today and overdue tasks/.test(s.items[1]) && /3 tasks/.test(s.note), JSON.stringify(s));
  const saved = settingsText();
  check('the token is not in settings.json in plain text (only encrypted)', !saved.includes(TOKEN) && !saved.includes(TOKEN.slice(4, 20)) && Boolean(JSON.parse(saved).keys?.['widget:todoist']), 'plain or missing');
  check('the Settings page never gets the token back', !(await sp('JSON.stringify(document.body.innerText) + JSON.stringify(window.lumenSettings && Object.keys(window.lumenSettings))')).includes(TOKEN), 'leaked');
  const state = await sp('window.lumenSettings.widgets.state().then((s) => JSON.stringify(s))');
  check('…nor does its state call (only “a token is stored”)', !state.includes(TOKEN) && JSON.parse(state).secrets.todoist === true, state.slice(0, 200));
  let refusedSet = await sp("window.lumenSettings.set('homeWidgets', [{ id: 'wabcdef', type: 'embed', url: 'https://example.com/', frameable: true }]).then(() => 'set', (e) => 'refused')");
  check('widgets can’t be written around their checks (prefs:set homeWidgets)', refusedSet === 'refused', refusedSet);

  // ---- the rest through the backend ----
  await W('save', { type: 'calendar', url: `${base}/cal.ics`.replace('https://', 'webcal://') });
  await W('save', { type: 'embed', url: `${base}/board`, height: 'small', title: 'My board' });
  await W('save', { type: 'embed', url: `${base}/deny` });
  const list = await W('list');
  check('four kinds of widget, in order', list.map((x) => x.type).join(',') === 'weather,todoist,calendar,embed,embed', JSON.stringify(list));
  check('the calendar is stored as https', /^https:\/\/127\.0\.0\.1:\d+\/cal\.ics$/.test(list[2].url), list[2].url);
  check('the embed knows whether it can be framed', list[3].frameable === true && list[4].frameable === false, JSON.stringify(list.slice(3)));

  // ---- the new-tab page ----
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  const pageState = () => page(`(() => {
    const card = (t) => document.querySelector('.w-card.' + t);
    const cards = [...document.querySelectorAll('.w-card')];
    return {
      types: cards.map((c) => c.className.replace('w-card ', '')),
      skeletons: document.querySelectorAll('.w-skel').length,
      temp: card('weather')?.querySelector('.wx-temp')?.textContent, label: card('weather')?.querySelector('.wx-label')?.textContent,
      hours: card('weather')?.querySelectorAll('.wx-hours > div').length || 0,
      tasks: [...(card('todoist')?.querySelectorAll('.w-row') || [])].map((r) => r.querySelector('a, .w-title').textContent),
      taskLinks: [...(card('todoist')?.querySelectorAll('.w-row a') || [])].map((a) => a.href + ' ' + a.target),
      imgs: document.querySelectorAll('#widgets img').length + document.querySelectorAll('#widgets b').length,
      overdue: card('todoist')?.querySelector('.w-sub.late')?.textContent || '',
      events: [...(card('calendar')?.querySelectorAll('.w-row') || [])].map((r) => r.querySelector('.w-time').textContent + ' ' + r.querySelector('a, .w-title').textContent),
      days: [...(card('calendar')?.querySelectorAll('.w-day') || [])].map((d) => d.textContent),
      frames: [...document.querySelectorAll('#widgets iframe')].map((f) => ({ src: f.src, sandbox: f.getAttribute('sandbox'), referrer: f.referrerPolicy, h: f.dataset.h })),
      fallback: [...document.querySelectorAll('.w-fallback')].map((f) => f.textContent + ' | ' + f.querySelector('a')?.href),
      pwned: Boolean(window.__pwned), marker: window.__marker || null,
    };
  })()`);
  let p = await pageState();
  check('the page draws at once, with loading placeholders or cached data', p.types.length === 5, JSON.stringify(p));
  for (let i = 0; i < 40 && (p.skeletons || !p.tasks.length || !p.events.length); i++) { await sleep(200); p = await pageState(); }
  check('weather reaches the page: temperature, WMO label, next hours', p.temp === '68°' && p.label === 'Partly cloudy' && p.hours === 5, JSON.stringify(p));
  check('Todoist tasks reach the page, overdue first then priority', p.tasks.length === 3 && p.tasks[0] === 'File taxes' && /^Overdue · /.test(p.overdue), JSON.stringify(p.tasks));
  check('markup in a task title shows as text', p.tasks.includes(TASK_TITLE) && p.imgs === 0 && !p.pwned, JSON.stringify(p));
  check('tasks open in a new tab', p.taskLinks.every((l) => /^https:\/\/app\.todoist\.com\/app\/task\/\d+ _blank$/.test(l)), JSON.stringify(p.taskLinks));
  check('calendar events reach the page, by day, markup as text', p.events.some((e) => /Design review$/.test(e)) && p.events.some((e) => e === 'All day Launch day') && p.events.some((e) => e.endsWith('<b>Evening</b> walk')) && p.days.includes('Tomorrow'), JSON.stringify(p));
  check('a frameable page is framed: sandboxed, no referrer', p.frames.length === 1 && p.frames[0].src === `${base}/board` && p.frames[0].sandbox === 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms' && p.frames[0].referrer === 'no-referrer' && p.frames[0].h === 'small', JSON.stringify(p.frames));
  check('a site that refuses framing gets the fallback card with Open', p.fallback.length === 1 && /Bank & Co.*doesn’t allow being shown inside other pages.*\| https:\/\/127\.0\.0\.1:\d+\/deny$/.test(p.fallback[0]), JSON.stringify(p.fallback));

  // The frame loads like a normal page, with no Lumen privileges.
  let frameInfo = null;
  for (let i = 0; i < 30 && !frameInfo?.probe; i++) {
    await sleep(200);
    frameInfo = await app.evaluate(async () => {
      const f = global.__wtab.webContents.mainFrame.frames.find((x) => /\/board$/.test(x.url));
      if (!f) return null;
      return f.executeJavaScript("({ probe: document.getElementById('probe')?.textContent, top: (() => { try { return top.location.href; } catch { return 'blocked'; } })(), bridge: typeof window.lumenSettings + typeof window.require + typeof window.process, referrer: document.referrer })").catch((e) => ({ error: e.message }));
    });
  }
  check('the framed page loads (the browser’s frame rules let it through)', frameInfo?.probe === 'framed page', JSON.stringify(frameInfo));
  check('…and can’t reach the new-tab page or any Lumen bridge', frameInfo?.top === 'blocked' && frameInfo.bridge === 'undefinedundefinedundefined' && frameInfo.referrer === '', JSON.stringify(frameInfo));

  // The hash carries display data only.
  const hash = decodeURIComponent(new URL(await app.evaluate(() => global.__wtab.webContents.getURL())).hash.slice(1));
  check('the token never appears in the new-tab page’s address', !hash.includes(TOKEN) && !hash.includes('Bearer') && JSON.parse(hash).widgets.length === 5, hash.slice(0, 200));

  // ---- completing a task: the checkbox POSTs close, and the task leaves the card ----
  await page('window.__marker = 1');
  await page("document.querySelectorAll('.w-card.todoist .w-check')[1].click()"); // the urgent one (sorted second)
  for (let i = 0; i < 30 && !fake.closed.size; i++) await sleep(150);
  check('the checkbox closes the task on Todoist (POST …/tasks/<id>/close)', fake.closed.has('101') && fake.log.some((l) => l.method === 'POST' && l.path === '/todoist/tasks/101/close' && l.auth === `Bearer ${TOKEN}`), JSON.stringify(fake.log.filter((l) => l.method === 'POST')));
  for (let i = 0; i < 20 && (p = await pageState()).tasks.length !== 2; i++) await sleep(150);
  const url = await app.evaluate(() => global.__wtab.webContents.getURL());
  check('…the task leaves the card, the page stays put (no reload, no ?widget)', p.tasks.length === 2 && !p.tasks.includes(TASK_TITLE) && p.marker === 1 && /newtab\.html#/.test(url) && !/[?&]widget=/.test(url), JSON.stringify({ tasks: p.tasks, marker: p.marker, url: url.slice(0, 120) }));
  const closes = fake.log.filter((l) => l.method === 'POST').length;
  await page(`location.href = location.pathname + '?' + new URLSearchParams({ widget: ${JSON.stringify(list[1].id)}, do: 'complete', task: '999' }) + location.hash`);
  await sleep(500);
  check('a task the card isn’t showing can’t be closed from the page', fake.log.filter((l) => l.method === 'POST').length === closes, 'closed');

  // ---- live refresh: an edit reaches an open page without a reload, and frames aren't reloaded ----
  await page("document.querySelector('#widgets iframe').dataset.kept = '1'");
  await W('save', { type: 'weather', city: 'Boston', units: 'c' }, list[0].id);
  for (let i = 0; i < 30 && (p = await pageState()).temp !== '20°'; i++) await sleep(150);
  check('an edit (°F to °C) reaches the open page live', p.temp === '20°' && p.marker === 1, JSON.stringify({ temp: p.temp, marker: p.marker }));
  check('…and the framed page wasn’t reloaded', (await page("document.querySelector('#widgets iframe')?.dataset.kept")) === '1', 'reloaded');
  await W('move', list[1].id, -1);
  await sleep(400);
  p = await pageState();
  check('reordering reaches the page', p.types[0] === 'todoist' && p.types[1] === 'weather', JSON.stringify(p.types));

  // ---- rate limits and errors ----
  const before = fake.log.length;
  r = await app.evaluate(async () => { const w = global.__widgets; const it = w.list().find((x) => x.type === 'calendar'); return [await w.refresh(it, { force: true }), await w.refresh(it, { force: true })]; });
  check('a forced refresh right after a fetch is skipped (rate limit)', r[0] === false && r[1] === false && fake.log.length === before, JSON.stringify(r));
  await app.evaluate(() => { global.__widgetEndpoints.forecast = 'https://127.0.0.1:1/forecast'; });
  await app.evaluate(async () => { const w = global.__widgets; const it = w.list().find((x) => x.type === 'weather'); w.cache.get(it.id).at = 0; w.cache.get(it.id).data = null; await w.refresh(it); });
  for (let i = 0; i < 20 && !(await page("document.querySelector('.w-card.weather .w-note')?.textContent || ''")); i++) await sleep(150);
  const note = await page("document.querySelector('.w-card.weather .w-note')?.textContent + '|' + document.querySelector('.w-card.weather .w-btn')?.getAttribute('aria-label')");
  check('an offline service shows a calm message with Try again', /^Couldn’t update.*connect/.test(note) && /Try .* again/.test(note), note);

  // A tampered hash can't smuggle in a script address or markup.
  await page(`(() => { const d = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    d.widgets = [{ id: 'wevil1', type: 'embed', title: '<b>x</b>', data: { url: 'javascript:alert(1)', frameable: true } },
                 { id: 'wevil2', type: 'todoist', title: 'T', data: { tasks: [{ id: '1', title: 'x', url: 'javascript:alert(1)' }] } },
                 { id: 'bad id', type: 'weather', data: {} }, { id: 'wevil3', type: 'nope', data: {} }];
    history.replaceState(null, '', location.pathname + '#' + encodeURIComponent(JSON.stringify(d))); dispatchEvent(new HashChangeEvent('hashchange')); })()`);
  const evil = await page("({ cards: document.querySelectorAll('.w-card').length, frames: document.querySelectorAll('#widgets iframe').length, js: [...document.querySelectorAll('#widgets a')].filter((a) => !a.href.startsWith('https:')).length, b: document.querySelectorAll('#widgets b').length })");
  check('a tampered hash can’t inject a script address or markup', evil.cards === 2 && evil.frames === 0 && evil.js === 0 && evil.b === 0, JSON.stringify(evil));

  // Even "frame-ancestors *" refuses the file: new-tab page (Chromium blocks the frame), so it gets
  // the fallback card too.
  r = await W('test', { type: 'embed', url: `${base}/star` });
  check('“frame-ancestors *” counts as refusing (it doesn’t match a file: page)', !r.ok && /Content-Security-Policy/.test(r.message), JSON.stringify(r));

  // ---- removing the last Todoist widget forgets the token ----
  await W('remove', list[1].id);
  const after = JSON.parse(settingsText());
  check('removing the Todoist widget removes its token', !after.keys?.['widget:todoist'] && after.homeWidgets.length === 4, JSON.stringify(after.keys || {}));

  await app.close();
  fake.srv.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  if (!process.env.CLAUDE_BROWSER_PROFILE) fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
