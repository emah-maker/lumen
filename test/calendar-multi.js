// The Calendar card with several calendars, in the real app (run it with `node test/calendar-multi.js`; needs openssl on
// PATH, as test/widgets.js does). Two fixture ICS feeds (and one that fails) are served by a local https server with a
// throwaway certificate; Lumen runs with a throwaway profile. Checks: the card shows one merged, time-ordered agenda with
// each event's calendar colour and name, the legend toggles (remembered per card), a failing calendar gets a note while
// the others show, an older single-address card is unchanged, and the Settings editor edits the list of calendars.
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const vevent = (uid, title, start) => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(start + HOUR)}\r\nEND:VEVENT\r\n`;
const vcal = (name, events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:${name}\r\n${events.join('')}END:VCALENDAR\r\n`;

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-calmulti-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the browser checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
  }
  // Events two and three days from now, at fixed hours, so the merged order is known: they interleave across the calendars.
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const at = (days, hour) => d0.getTime() + days * DAY + hour * HOUR + 7 * 60e3;
  const FEEDS = {
    '/school.ics': vcal('Term', [vevent('s1', 'Maths exam', at(2, 9)), vevent('s2', 'Chemistry lab', at(2, 14)), vevent('s3', 'Parents evening', at(3, 18)), vevent('dup', 'Shared trip', at(3, 8))]),
    '/other.ics': vcal('Personal', [vevent('o1', 'Dentist', at(2, 8)), vevent('o2', 'Dinner out', at(2, 19)), vevent('o3', 'Gym', at(3, 7)), vevent('dup', 'Shared trip', at(3, 8))]),
  };
  const asked = [];
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    asked.push(u.pathname);
    if (FEEDS[u.pathname]) { res.writeHead(200, { 'content-type': 'text/calendar' }); return res.end(FEEDS[u.pathname]); }
    res.writeHead(500);
    return res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-calmulti-profile-'));
  const SCHOOL = '#e5604d';
  const OTHER = '#2f6fed';
  const widgets = [
    { id: 'wcalm0001', type: 'calendar', title: 'Schedule', span: 6, x: 0, y: 0, w: 6, h: 9, cals: [{ name: 'School', url: `${base}/school.ics`, color: SCHOOL, enabled: true }, { name: 'Other', url: `${base}/other.ics`, color: OTHER, enabled: true }], url: `${base}/school.ics`, name: '', count: 5 },
    { id: 'wcal00001', type: 'calendar', title: '', span: 3, x: 6, y: 0, w: 6, h: 9, url: `${base}/school.ics`, name: 'Term', count: 5 }, // exactly what an older Lumen stored
  ];
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: widgets, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));

  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
  await W('flush');
  await app.evaluate(() => { global.__widgetRateMax = 5000; });

  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  const card = `document.querySelector('.w-card[data-id="wcalm0001"]')`;
  const read = () => page(`(() => {
    const c = ${card};
    if (!c) return null;
    const rows = [...c.querySelectorAll('.w-row')];
    return {
      titles: rows.map((r) => (r.querySelector('a, .w-title') || {}).textContent),
      times: rows.map((r) => r.querySelector('.w-time').textContent),
      colors: rows.map((r) => r.style.getPropertyValue('--ev')),
      dots: rows.map((r) => (r.querySelector('.cal-dot') || { getAttribute: () => '' }).getAttribute('aria-label')),
      dotColors: rows.map((r) => { const d = r.querySelector('.cal-dot'); return d ? d.style.getPropertyValue('--cal') : ''; }),
      names: rows.map((r) => (r.querySelector('.cal-name') || {}).textContent || ''),
      days: [...c.querySelectorAll('.w-day')].map((d) => d.textContent),
      chips: [...c.querySelectorAll('.cal-chip')].map((b) => ({ id: b.dataset.cal, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), text: b.textContent })),
      warns: [...c.querySelectorAll('.cal-warn')].map((n) => n.textContent),
      legendLabel: (c.querySelector('.cal-legend') || { getAttribute: () => '' }).getAttribute('aria-label'),
    };
  })()`);
  let s = null;
  for (let i = 0; i < 60; i++) { s = await read(); if (s && s.titles.length >= 7) break; await sleep(250); }
  const EXPECT = ['Dentist', 'Maths exam', 'Chemistry lab', 'Dinner out', 'Gym', 'Shared trip', 'Parents evening'];
  check('merged: the two calendars’ events are one agenda in time order (the shared trip once)', s && s.titles.join() === EXPECT.join(), JSON.stringify(s));
  const school = new Set(['Maths exam', 'Chemistry lab', 'Shared trip', 'Parents evening']);
  check('colours: every event carries its calendar’s color (School red, Other blue)', s && s.titles.every((t, i) => s.colors[i] === (school.has(t) ? SCHOOL : OTHER) && s.dotColors[i] === (school.has(t) ? SCHOOL : OTHER)), JSON.stringify(s && s.colors));
  check('names: each row has a dot named for screen readers and the calendar’s name', s && s.titles.every((t, i) => s.dots[i] === `Calendar: ${school.has(t) ? 'School' : 'Other'}` && s.names[i] === (school.has(t) ? 'School' : 'Other')), JSON.stringify(s && [s.dots, s.names]));
  check('days: events are grouped by day as before', s && s.days.length === 2, JSON.stringify(s && s.days));
  check('legend: one switch per calendar, labelled, all shown to begin with', s && s.legendLabel === 'Calendars on this card' && s.chips.length === 2 && s.chips.every((c) => c.pressed === 'true' && /, shown$/.test(c.label)) && s.chips.map((c) => c.text).join() === 'School,Other', JSON.stringify(s && s.chips));
  check('page data: no calendar address reaches the new-tab page', !(await page('document.documentElement.outerHTML + JSON.stringify(location.href)')).includes('school.ics'), '');

  // The older single-address card is as it was: no legend, no dots.
  const old = await page(`(() => { const c = document.querySelector('.w-card[data-id="wcal00001"]'); return c && { rows: c.querySelectorAll('.w-row').length, legend: c.querySelectorAll('.cal-legend').length, dots: c.querySelectorAll('.cal-dot').length, title: c.querySelector('h2').textContent, titles: [...c.querySelectorAll('.w-row')].map((r) => (r.querySelector('a, .w-title') || {}).textContent) }; })()`);
  check('an older single-calendar card is unchanged: its events, the feed’s name, no legend, no dots', old && old.rows === 4 && old.legend === 0 && old.dots === 0 && old.title === 'Term' && old.titles.join() === 'Maths exam,Chemistry lab,Shared trip,Parents evening', JSON.stringify(old));

  // A screenshot for the pull request.
  const shots = path.join(os.tmpdir(), 'lumen-calendar-multi');
  fs.mkdirSync(shots, { recursive: true });
  const shot = async (name) => {
    try {
      const png = await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shots, name), Buffer.from(png, 'base64'));
    } catch (err) { console.log(`NOTE  no screenshot ${name}: ${err.message}`); }
  };
  await shot('merged-agenda.png');

  // Toggle School off: only Other's events remain, the switch says hidden, the choice is remembered across a redraw and a reload.
  await page(`${card}.querySelector('.cal-chip[data-cal="${s.chips[0].id}"]').click()`);
  await sleep(200);
  s = await read();
  check('toggle: hiding School leaves only Other’s events, and the switch says so (not by color alone)', s.titles.join() === 'Dentist,Dinner out,Gym' && s.chips[0].pressed === 'false' && /, hidden$/.test(s.chips[0].label) && s.chips[1].pressed === 'true', JSON.stringify(s));
  check('toggle: focus stays on the switch', await page(`document.activeElement && document.activeElement.classList.contains('cal-chip') && document.activeElement.dataset.cal === "${s.chips[0].id}"`), '');
  await page(`${card}.querySelector('.cal-chip[data-cal="${s.chips[1].id}"]').click()`);
  await sleep(200);
  check('toggle: the last calendar that is showing cannot be hidden', (await read()).chips[1].pressed === 'true', '');
  await app.evaluate(() => new Promise((res) => { global.__wtab.webContents.once('did-finish-load', res); global.__wtab.webContents.reload(); }));
  for (let i = 0; i < 60; i++) { s = await read(); if (s && s.chips.length === 2) break; await sleep(250); }
  check('toggle: School is still hidden after the page is reloaded', s && s.chips[0].pressed === 'false' && s.titles.join() === 'Dentist,Dinner out,Gym', JSON.stringify(s));
  await shot('school-hidden.png');
  await page(`${card}.querySelector('.cal-chip[data-cal="${s.chips[0].id}"]').click()`);
  await sleep(200);
  check('toggle: switching it back on brings the merged agenda back', (await read()).titles.join() === EXPECT.join(), '');

  // One calendar failing: add a third that the server refuses; the others show, the card says which and why.
  const saved = await app.evaluate(async (_e, b) => {
    const w = global.__widgets;
    const it = w.list().find((x) => x.id === 'wcalm0001');
    const out = await w.save({ type: 'calendar', title: 'Schedule', cals: [...it.cals, { name: 'Club', url: `${b}/club.ics`, color: '#8b5cf6', enabled: true }] }, 'wcalm0001');
    return out.message;
  }, base);
  check('save: a third calendar that can’t be read is kept, and the message says so', /Club: can’t be read/.test(saved) && /saved anyway/.test(saved), saved);
  await W('flush');
  for (let i = 0; i < 60; i++) { s = await read(); if (s && s.chips.length === 3 && s.warns.length) break; await sleep(250); }
  check('partial failure: the other calendars still show every event', s && s.titles.join() === EXPECT.join() && s.chips.length === 3, JSON.stringify(s));
  check('partial failure: a small note names the calendar and what went wrong, and its switch says it could not be read', s && s.warns.length === 1 && /^Club: /.test(s.warns[0]) && /500/.test(s.warns[0]) && /could not be read/.test(s.chips[2].label), JSON.stringify(s && [s.warns, s.chips[2]]));
  await shot('one-failing.png');

  // The Settings editor.
  const settingsId = await app.evaluate(() => global.__settings.open('appearance'));
  const sp = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [settingsId, code]);
  const waitFor = async (code, tries = 60) => { for (let i = 0; i < tries; i++) { if (await sp(code).catch(() => false)) return true; await sleep(150); } return false; };
  await waitFor("Boolean(document.body.dataset.ready && document.querySelector('.widget-item'))");
  check('Settings: the list line names the calendars', (await sp("[...document.querySelectorAll('.widget-item')].map((e) => e.querySelector('.desc').textContent)")).includes('School + Other + Club · 3 calendars'), JSON.stringify(await sp("[...document.querySelectorAll('.widget-item')].map((e) => e.querySelector('.desc').textContent)")));
  await sp("document.querySelector('.widget-item[data-id=\"wcalm0001\"]').click()");
  check('Settings: the editor lists each calendar with its name, color, address and switch', await waitFor("document.querySelectorAll('.cal-edit').length === 3") && (await sp("[...document.querySelectorAll('.cal-edit .cal-name')].map((i) => i.value).join()")) === 'School,Other,Club' && (await sp("[...document.querySelectorAll('.cal-edit .cal-color')].map((i) => i.value).join()")).startsWith(`${SCHOOL},${OTHER}`) && (await sp("document.querySelectorAll('.cal-edit .cal-url')[0].value")).endsWith('/school.ics'), JSON.stringify(await sp("document.getElementById('widget-form') && document.getElementById('widget-form').innerText.slice(0, 600)")));
  await sp("document.querySelectorAll('.cal-edit')[1].querySelector('.cal-actions button').click()");
  check('Settings: a calendar’s Test says what it found', await waitFor("/Personal: 4 events/.test(document.querySelectorAll('.cal-edit')[1].querySelector('.cal-test').textContent)"), await sp("document.querySelectorAll('.cal-edit')[1].querySelector('.cal-test').textContent"));
  await sp("document.querySelectorAll('.cal-edit')[2].querySelector('.cal-actions button').click()");
  check('Settings: a calendar that fails its Test says so in the row', await waitFor("/500/.test(document.querySelectorAll('.cal-edit')[2].querySelector('.cal-test').textContent)"), await sp("document.querySelectorAll('.cal-edit')[2].querySelector('.cal-test').textContent"));
  // Remove Club, move Other up, rename.
  await sp("[...document.querySelectorAll('.cal-edit')[2].querySelectorAll('button')].find((b) => /^Remove/.test(b.textContent)).click()");
  await sp("[...document.querySelectorAll('.cal-edit')[1].querySelectorAll('button')].find((b) => b.textContent === '↑').click()");
  check('Settings: Remove and Move up change the list in place', await waitFor("document.querySelectorAll('.cal-edit').length === 2") && (await sp("[...document.querySelectorAll('.cal-edit .cal-name')].map((i) => i.value).join()")) === 'Other,School', '');
  await sp("(() => { const i = document.querySelectorAll('.cal-edit .cal-name')[0]; i.value = 'Personal'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sp("document.getElementById('widget-save').click()");
  let list = [];
  for (let i = 0; i < 60; i++) { list = await W('list'); const it = list.find((x) => x.id === 'wcalm0001'); if (it && it.cals.length === 2 && it.cals[0].name === 'Personal') break; await sleep(200); }
  const it = list.find((x) => x.id === 'wcalm0001');
  check('Settings: Save stores the new order, name and colors; the addresses stay', it.cals.length === 2 && it.cals[0].name === 'Personal' && it.cals[1].name === 'School' && it.cals[1].color === SCHOOL && it.cals[0].url.endsWith('/other.ics') && it.url === it.cals[0].url, JSON.stringify(it.cals));
  await W('flush');
  for (let i = 0; i < 60; i++) { s = await read(); if (s && s.chips.length === 2 && s.chips[0].text === 'Personal' && s.titles.length === 7) break; await sleep(250); }
  check('page: the card follows (legend order and names, same agenda)', s && s.chips.map((c) => c.text).join() === 'Personal,School' && s.titles.join() === EXPECT.join(), JSON.stringify(s));
  check('the fixture server only saw the feeds’ own paths', asked.every((p) => ['/school.ics', '/other.ics', '/club.ics'].includes(p)), asked.join());

  const proc = app.process();
  await Promise.race([app.close().catch(() => {}), sleep(10000)]);
  if (proc.exitCode === null) proc.kill();
  srv.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`screenshots: ${shots}`);
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
