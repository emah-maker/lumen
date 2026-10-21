// Focus mode (features/focus.js) in the real browser, against a local stand-in for "the web" (no real site is ever visited: every *.test host
// maps to a local server, and the blocked site is "blocked.test"):
// - off by default: nothing loads the feature, a page on the list loads;
// - "focus for 25 minutes" typed in the chat starts it, the toolbar button shows the time left;
// - a listed page never reaches the server: the tab shows the block page (the time left, the address in the address bar), unlisted pages load;
// - "I need this for school" opens the site (and is logged); End focus needs the whole ten-second hold, a script that skips the hold is refused;
// - Settings → General → Focus mode lists and edits the sites and schedules, and takes a schedule in words;
// - a schedule that covers now starts focus by itself; while it is on, the lists can't be edited.
// Run through the lock with a hidden window: node scripts/test/e2e-lock.js run --owner focus-mode -- timeout 400 node test/e2e/focus.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn().catch(() => null))) return v; await sleep(100); } return v; };

  const visits = [];
  const web = http.createServer((req, res) => {
    const where = `${(req.headers.host || '').split(':')[0]}${req.url}`;
    visits.push(where);
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Page ${where}</title><p>${where}</p>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => web.once('listening', r));
  const port = web.address().port;
  const at = (host, p = '/') => `http://${host}:${port}${p}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-focus-'));
  const env = { ...process.env, LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..'), '--host-resolver-rules=MAP *.test 127.0.0.1'], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  const url = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  const load = (u) => app.evaluate((_e, u) => { global.__agent.browser.activeTab().webContents.loadURL(u).catch(() => {}); }, u);
  const inTab = (js) => app.evaluate((_e, js) => global.__agent.browser.activeTab().webContents.executeJavaScript(js, true), js);
  const loaded = (u) => waitFor(() => url().then((x) => x === u && x));
  const onBlockPage = () => waitFor(() => url().then((u) => u.includes('focus-block.html') && u));
  const state = () => app.evaluate(() => global.__focus.ctl().state());
  const toolbar = () => ui.evaluate(() => ({ on: document.getElementById('focus-btn').classList.contains('on'), time: document.getElementById('focus-time').textContent, hidden: document.getElementById('focus-time').hidden, label: document.getElementById('focus-btn').getAttribute('aria-label') }));
  const setPref = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v), [key, value]);
  const holdEnd = async () => { // the whole ten seconds, on the block page
    await inTab("document.getElementById('hold').dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 7, bubbles: true })); true");
    return waitFor(() => state().then((s) => !s.active), 14000);
  };

  // 1. Off by default.
  check('off by default: the feature is not even loaded', await app.evaluate(() => global.__focus.idle()));
  check('the default list has the named sites', await app.evaluate(() => ['youtube.com', 'reddit.com', 'tiktok.com', 'instagram.com', 'x.com', 'twitter.com', 'facebook.com', 'twitch.tv', 'netflix.com'].every((s) => global.__settings.backend.prefs().focusSites.includes(s))));
  check('the toolbar button is there, quiet', (await toolbar()).on === false && (await toolbar()).hidden === true && /Focus mode/.test((await toolbar()).label), JSON.stringify(await toolbar()));
  await setPref('focusSites', ['blocked.test']);
  await load(at('blocked.test', '/before'));
  check('off: a page on the list loads like any other', Boolean(await loaded(at('blocked.test', '/before'))), await url());

  // 2. "focus for 25 minutes" in the chat.
  await ui.evaluate(() => { document.getElementById('prompt').value = 'focus for 25 minutes'; return window.sendComposer(); });
  const on = await waitFor(() => state().then((s) => s.active && s));
  check('"focus for 25 minutes" in the chat starts it, and does not go to the AI', Boolean(on) && on.source === 'manual' && Math.abs(on.remainingMs - 25 * 60000) < 5000 && (await ui.evaluate(() => /Focus mode is on until/.test(document.getElementById('messages').textContent) && !document.querySelector('#messages .msg.user'))), JSON.stringify(on));
  const bar = await waitFor(() => toolbar().then((b) => b.on && !b.hidden && /^\d+:\d\d/.test(b.time) && b));
  check('the toolbar shows the time left', Boolean(bar) && /left/.test(bar.label), JSON.stringify(await toolbar()));

  // 3. A listed page is blocked before it loads; others load.
  visits.length = 0;
  await load(at('blocked.test', '/video'));
  const page = await onBlockPage();
  check('a listed page shows the block page instead', Boolean(page), await url());
  check('the listed page itself was never requested', !visits.some((v) => v.startsWith('blocked.test')), visits.join());
  await waitFor(() => inTab("document.readyState === 'complete' && document.getElementById('timer').textContent !== ''"));
  const text = await inTab('document.body.innerText');
  check('the block page names the site and shows the time left', /blocked\.test is blocked while you focus/.test(text) && /\b24:\d\d\b|\b25:00\b/.test(text), text);
  check('...with "I need this for school" and End focus', /I need this for school/.test(text) && /Hold to end focus/.test(text), text);
  check('the address bar shows the address that was blocked', (await ui.inputValue('#address')).includes('blocked.test'), await ui.inputValue('#address'));
  await load(at('other.test', '/fine'));
  check('a page that is not on the list loads', Boolean(await loaded(at('other.test', '/fine'))), await url());
  await load(at('sub.blocked.test', '/deep'));
  check('a subdomain of a listed site is blocked too', Boolean(await onBlockPage()) && !visits.some((v) => v.startsWith('sub.blocked.test')), visits.join());

  // 4. I need this for school.
  await load(at('blocked.test', '/homework'));
  await onBlockPage();
  await waitFor(() => inTab("document.getElementById('allow').hidden === false"));
  await inTab("document.getElementById('allow').click(); true");
  check('"I need this for school" opens the site', Boolean(await loaded(at('blocked.test', '/homework'))), await url());
  check('...for ten minutes, and the log has it (the host only)', await app.evaluate(() => { const s = global.__focus.ctl().state(); const l = global.__focus.ctl().log().filter((e) => e.type === 'allow'); return s.allows.length === 1 && s.allows[0].site === 'blocked.test' && l.length === 1 && l[0].site === 'blocked.test' && !JSON.stringify(l).includes('homework'); }));

  // 5. End focus is a hold.
  await load(at('sub.blocked.test', '/again'));
  await loaded(at('sub.blocked.test', '/again')); // (allowed for ten minutes: the subdomain belongs to the site)
  check('while focus is on, the lists cannot be changed (editing them is no way out)', await app.evaluate(() => global.__settings.backend.set('focusSites', []).then(() => false, (e) => /Focus mode is on/.test(e.message))));
  check('...and the list is as it was', await app.evaluate(() => global.__settings.backend.prefs().focusSites.join()) === 'blocked.test', await app.evaluate(() => global.__settings.backend.prefs().focusSites.join()));
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.loadURL(global.__focus.ctl().statusUrl()).catch(() => {})); // the toolbar menu's "End focus…"
  await onBlockPage();
  await waitFor(() => inTab("Boolean(window.lumenFocus) && document.getElementById('end').hidden === false"));
  const skip = await inTab("lumenFocus.hold(true).then(() => lumenFocus.end()).then((r) => r.ok)"); // a script that does not wait
  check('End focus: a script that asks to end without holding is refused', skip === false && (await state()).active === true, String(skip));
  await inTab("document.getElementById('hold').dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 7, bubbles: true })); true");
  await sleep(2500);
  await inTab("document.getElementById('hold').dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 7, bubbles: true })); true");
  await sleep(500);
  check('End focus: letting go early keeps it on', (await state()).active === true && (await toolbar()).on === true);
  await sleep(8200); // (a hold that began 11 s ago and was released does not count)
  check('End focus: ...even when the page asks later', (await inTab('lumenFocus.end().then((r) => r.ok)')) === false && (await state()).active === true);
  const ended = await holdEnd();
  check('End focus: the whole ten seconds ends it', Boolean(ended), JSON.stringify(await state()));
  const endedText = await waitFor(() => inTab('document.getElementById("title").textContent').then((t) => /ended/.test(t) && t));
  check('the page says focus has ended', Boolean(endedText), await inTab('document.body.innerText'));
  check('the toolbar button is quiet again', Boolean(await waitFor(() => toolbar().then((b) => !b.on && b.hidden))), JSON.stringify(await toolbar()));
  await load(at('blocked.test', '/after'));
  check('after it ends the listed site loads again', Boolean(await loaded(at('blocked.test', '/after'))), await url());
  check('the log has the start and an early end', await app.evaluate(() => { const l = global.__focus.ctl().log(); return l.some((e) => e.type === 'start') && l.some((e) => e.type === 'end' && e.how === 'early'); }));
  check('no session file is left', !fs.existsSync(path.join(profile, 'focus-session.json')));

  // 6. Settings → General → Focus mode.
  const sid = await app.evaluate(() => global.__settings.open('focus'));
  const inSettings = (js) => app.evaluate(async (_e, [i, c]) => global.__settings.contents(i).executeJavaScript(c, true), [sid, js]);
  await waitFor(() => inSettings("Boolean(document.getElementById('focus-sites'))"));
  check('Settings lists the blocked sites and says it is off', await inSettings("document.getElementById('focus-sites').textContent.includes('blocked.test') && /Off/.test(document.getElementById('focus-status').textContent)"));
  await inSettings("{ const i = document.getElementById('focus-site-add'); i.value = 'https://www.Study.test/page'; document.getElementById('focus-site-button').click(); }; true");
  const added = await waitFor(() => app.evaluate(() => global.__settings.backend.prefs().focusSites.join()).then((s) => s === 'blocked.test,study.test' && s));
  check('adding a site there stores its host', Boolean(added), await app.evaluate(() => global.__settings.backend.prefs().focusSites.join()));
  await inSettings("document.getElementById('focus-site-add').value = 'a b'; document.getElementById('focus-site-button').click(); true");
  await sleep(300);
  check('a made-up entry is not stored', await app.evaluate(() => global.__settings.backend.prefs().focusSites.join()) === 'blocked.test,study.test');
  await inSettings("{ const i = document.getElementById('focus-phrase'); i.value = 'weekdays 7-9 pm'; document.getElementById('focus-phrase-add').click(); }; true");
  const sched = await waitFor(() => app.evaluate(() => global.__settings.backend.prefs().focusSchedules).then((l) => l.length === 1 && l[0]));
  check('a schedule typed in words ("weekdays 7-9 pm") is stored', Boolean(sched) && sched.days.join() === '1,2,3,4,5' && sched.from === '19:00' && sched.to === '21:00' && sched.on === true, JSON.stringify(sched));
  check('...and listed', await waitFor(() => inSettings("document.getElementById('focus-schedules').textContent.includes('Weekdays')")));
  await inSettings("{ const i = document.getElementById('focus-phrase'); i.value = 'whenever'; document.getElementById('focus-phrase-add').click(); }; true");
  await sleep(400);
  check('words that are no schedule are refused, with a hint', (await app.evaluate(() => global.__settings.backend.prefs().focusSchedules.length)) === 1 && await inSettings("/weekdays 7/.test(document.getElementById('focus-schedules-note').textContent)"));
  await inSettings("document.querySelector('#focus-schedules [data-schedule] button').click(); true");
  check('Remove deletes it', Boolean(await waitFor(() => app.evaluate(() => global.__settings.backend.prefs().focusSchedules.length === 0))));
  await inSettings("document.getElementById('focus-sites-reset').click(); true");
  check('"Restore the default list" brings the default sites back', Boolean(await waitFor(() => app.evaluate(() => global.__settings.backend.prefs().focusSites.includes('youtube.com') && global.__settings.backend.prefs().focusSites.length === 10))));
  await setPref('focusSites', ['blocked.test']);

  await app.evaluate((_e, id) => global.__closeTabInteractive(id), sid);
  await waitFor(() => url().then((u) => !u.includes('settings.html')));

  // 7. A schedule that covers now starts it by itself.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const from = new Date(now.getTime() - 20 * 60000);
  const to = new Date(now.getTime() + 40 * 60000);
  await setPref('focusSchedules', [{ id: 'now', days: [0, 1, 2, 3, 4, 5, 6], from: `${pad(from.getHours())}:${pad(from.getMinutes())}`, to: `${pad(to.getHours())}:${pad(to.getMinutes())}`, on: true }]);
  const scheduled = await waitFor(() => state().then((s) => s.active && s));
  check('a schedule that covers now starts focus by itself', Boolean(scheduled) && scheduled.source === 'schedule' && scheduled.remainingMs > 30 * 60000 && scheduled.remainingMs < 41 * 60000, JSON.stringify(scheduled));
  check('...and the toolbar shows it', Boolean(await waitFor(() => toolbar().then((b) => b.on && /^\d+:\d\d/.test(b.time)))));
  const sid2 = await app.evaluate(() => global.__settings.open('focus'));
  const lockedNote = () => app.evaluate(async (_e, id) => global.__settings.contents(id).executeJavaScript("/schedule/.test(document.getElementById('focus-status').textContent) && document.getElementById('focus-site-button').disabled && document.getElementById('focus-start').disabled", true), sid2);
  check('Settings says so, and the lists are locked', Boolean(await waitFor(lockedNote, 12000)));
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), sid2);
  await waitFor(() => url().then((u) => !u.includes('settings.html')));
  await load(at('blocked.test', '/scheduled'));
  check('...and blocks the listed site', Boolean(await onBlockPage()));
  check('while a schedule is on, the schedules cannot be edited either', await app.evaluate(() => global.__settings.backend.set('focusSchedules', []).then(() => false, (e) => /Focus mode is on/.test(e.message))));
  const endedSchedule = await holdEnd();
  check('End focus ends a schedule window too, and it stays off for the rest of it', Boolean(endedSchedule) && (await sleep(1500), !(await state()).active));
  await load(at('blocked.test', '/free'));
  check('...so the site loads', Boolean(await loaded(at('blocked.test', '/free'))), await url());

  await app.close();
  web.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
