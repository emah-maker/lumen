// Focus mode (features/focus.js, renderer/focus-phrase.js): which pages are blocked, schedules ("weekdays 7-9 pm"), the chat phrase that starts it,
// and the controller (the gate, "I need this for school", the ten-second End focus hold, a session that survives a restart), on a fake clock and
// a temp folder. Plain node: no window, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/features/focus');
const P = require('../src/renderer/focus-phrase');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- sites
check('cleanSite: a pasted address becomes its host', F.cleanSite('https://www.YouTube.com/watch?v=1#t') === 'youtube.com', F.cleanSite('https://www.YouTube.com/watch?v=1#t'));
check('cleanSite: port, trailing dot and www are dropped', F.cleanSite('www.Reddit.com.:8080/r/x') === 'reddit.com', F.cleanSite('www.Reddit.com.:8080/r/x'));
check('cleanSite: junk is refused', ['', '  ', 'a b', 'user@host.com', 'a..b', '-a.com', 'exa_mple.com', '<script>'].every((x) => F.cleanSite(x) === ''), 'accepted one');
check('cleanSites: not a list is null (the setting keeps what it had)', F.cleanSites('youtube.com') === null && F.cleanSites(null) === null);
check('cleanSites: de-duplicated, cleaned, junk dropped', eq(F.cleanSites(['YouTube.com', 'www.youtube.com', 'x', 'a b', 'https://reddit.com/r/all']), ['youtube.com', 'x', 'reddit.com']), JSON.stringify(F.cleanSites(['YouTube.com', 'www.youtube.com', 'x', 'a b', 'https://reddit.com/r/all'])));
check('cleanSites: an empty list is allowed (block nothing)', eq(F.cleanSites([]), []));
check('cleanSites: capped', F.cleanSites(Array.from({ length: 500 }, (_, i) => `s${i}.com`)).length === F.LIMITS.sites);
const list = F.DEFAULT_SITES;
check('the default list is the eight named sites (youtube, reddit, tiktok, instagram, x/twitter, facebook, twitch, netflix)',
  ['youtube.com', 'reddit.com', 'tiktok.com', 'instagram.com', 'x.com', 'twitter.com', 'facebook.com', 'twitch.tv', 'netflix.com'].every((s) => list.includes(s)), list.join(','));
check('matchSite: the site and its subdomains', F.matchSite('youtube.com', list) === 'youtube.com' && F.matchSite('www.youtube.com', list) === 'youtube.com' && F.matchSite('m.youtube.com', list) === 'youtube.com' && F.matchSite('old.reddit.com', list) === 'reddit.com');
check('matchSite: another site that only ends the same way is not matched', F.matchSite('dropbox.com', list) === null && F.matchSite('notyoutube.com', list) === null && F.matchSite('youtube.com.evil.test', list) === null && F.matchSite('box.com', list) === null);
check('matchSite: nothing listed, or no host', F.matchSite('youtube.com', []) === null && F.matchSite('', list) === null && F.matchSite(null, list) === null);
check('matchSite: case and a trailing dot do not matter', F.matchSite('WWW.TikTok.com.', list) === 'tiktok.com');
check('hostOf: http(s) only', F.hostOf('https://www.Netflix.com/browse') === 'www.netflix.com' && F.hostOf('http://x.com/') === 'x.com' && F.hostOf('file:///c:/a.html') === '' && F.hostOf('lumen://settings') === '' && F.hostOf('nonsense') === '');

// the setting's default is the same list (settings-backend.js DEFAULTS)
const backend = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings', 'settings-backend.js'), 'utf8');
const m = /focusSites: (\[[^\]]*\])/.exec(backend);
check('settings-backend DEFAULTS.focusSites is features/focus.js DEFAULT_SITES', m && eq(JSON.parse(m[1].replace(/'/g, '"')), F.DEFAULT_SITES), m && m[1]);
check('settings-backend DEFAULTS has focusSchedules: []', /focusSchedules: \[\]/.test(backend));

// ---- schedules
check('cleanTime', F.cleanTime('7:05') === '07:05' && F.cleanTime('19:00') === '19:00' && F.cleanTime('24:00') === '' && F.cleanTime('7pm') === '');
const sch = F.cleanSchedule({ days: [5, 1, 1, 9, 'x'], from: '19:00', to: '21:00' });
check('cleanSchedule: days sorted, de-duplicated, valid; id made; on by default', sch && eq(sch.days, [1, 5]) && sch.from === '19:00' && sch.to === '21:00' && sch.on === true && /^[A-Za-z0-9_-]+$/.test(sch.id), JSON.stringify(sch));
check('cleanSchedule: no day, no time, or the same time twice is refused', F.cleanSchedule({ days: [], from: '19:00', to: '21:00' }) === null && F.cleanSchedule({ days: [1], from: '', to: '21:00' }) === null && F.cleanSchedule({ days: [1], from: '19:00', to: '19:00' }) === null && F.cleanSchedule(null) === null);
check('cleanSchedules: not a list is null; duplicates by id dropped; capped', F.cleanSchedules(5) === null
  && F.cleanSchedules([{ id: 'a', days: [1], from: '8:00', to: '9:00' }, { id: 'a', days: [2], from: '8:00', to: '9:00' }]).length === 1
  && F.cleanSchedules(Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, days: [1], from: '8:00', to: '9:00' }))).length === F.LIMITS.schedules);
// Monday 19 October 2026, local time
const at = (day, h, min = 0) => new Date(2026, 9, day, h, min).getTime();
const weekdays = [F.cleanSchedule({ id: 'w', days: [1, 2, 3, 4, 5], from: '19:00', to: '21:00' })];
check('windowAt: inside the window', F.windowAt(weekdays, at(19, 20)).end === at(19, 21) && F.windowAt(weekdays, at(19, 20)).start === at(19, 19));
check('windowAt: at the start, not at the end', F.windowAt(weekdays, at(19, 19)) !== null && F.windowAt(weekdays, at(19, 21)) === null);
check('windowAt: before, after and on a weekend day', F.windowAt(weekdays, at(19, 18, 59)) === null && F.windowAt(weekdays, at(19, 22)) === null && F.windowAt(weekdays, at(24, 20)) === null && F.windowAt(weekdays, at(25, 20)) === null);
check('windowAt: Friday evening is in, Saturday evening is out', F.windowAt(weekdays, at(23, 20)) !== null && F.windowAt(weekdays, at(24, 20)) === null);
const night = [F.cleanSchedule({ id: 'n', days: [5], from: '22:00', to: '01:00' })]; // Friday 22:00 to Saturday 01:00
check('windowAt: a window across midnight is on after midnight, on the day after the listed one', F.windowAt(night, at(23, 23)) !== null && F.windowAt(night, at(24, 0, 30)).end === at(24, 1) && F.windowAt(night, at(24, 1, 1)) === null && F.windowAt(night, at(23, 21)) === null);
check('windowAt: a switched-off schedule is ignored', F.windowAt([{ ...weekdays[0], on: false }], at(19, 20)) === null);
check('windowAt: the window that ends last wins', F.windowAt([...weekdays, F.cleanSchedule({ id: 'x', days: [1], from: '20:00', to: '23:00' })], at(19, 20, 30)).end === at(19, 23));
check('windowAt: no schedules', F.windowAt([], at(19, 20)) === null && F.windowAt(undefined, at(19, 20)) === null);
check('nextStart: today when it is ahead, the next weekday when it is not', F.nextStart(weekdays, at(19, 18)) === at(19, 19) && F.nextStart(weekdays, at(19, 20)) === at(20, 19) && F.nextStart(weekdays, at(23, 20)) === at(26, 19), String(new Date(F.nextStart(weekdays, at(23, 20)))));
check('nextStart: none', F.nextStart([], at(19, 18)) === null);

// ---- schedule phrases
const phrase = (s) => JSON.stringify(F.parseSchedulePhrase(s));
check('phrase: "weekdays 7-9 pm"', phrase('weekdays 7-9 pm') === JSON.stringify({ days: [1, 2, 3, 4, 5], from: '19:00', to: '21:00' }), phrase('weekdays 7-9 pm'));
check('phrase: an en dash and "7–9 pm"', phrase('weekdays 7–9 pm') === phrase('weekdays 7-9 pm') && phrase('Weekdays 7 to 9 PM') === phrase('weekdays 7-9 pm'));
check('phrase: named days with minutes', phrase('mon, wed and fri 4:30 pm-6 pm') === JSON.stringify({ days: [1, 3, 5], from: '16:30', to: '18:00' }), phrase('mon, wed and fri 4:30 pm-6 pm'));
check('phrase: "every sunday 3-5 pm", "weekends", "daily"', phrase('every sunday 3-5 pm') === JSON.stringify({ days: [0], from: '15:00', to: '17:00' }) && F.parseSchedulePhrase('weekends 10 am-12 pm').days.join() === '0,6' && F.parseSchedulePhrase('daily 19:00-21:00').days.length === 7);
check('phrase: "11-1 pm" is 11 am to 1 pm; "9 am-12" ends at noon; 24-hour with neither', F.parseSchedulePhrase('weekdays 11-1 pm').from === '11:00' && F.parseSchedulePhrase('weekdays 9 am-12').to === '12:00' && F.parseSchedulePhrase('weekdays 19-21').from === '19:00');
check('phrase: overnight with both marked ("10 pm to 1 am")', phrase('daily 10 pm to 1 am').includes('"from":"22:00","to":"01:00"'), phrase('daily 10 pm to 1 am'));
check('phrase: nonsense, the same time twice, impossible clocks', ['', 'hello', 'weekdays', 'weekdays 7 pm', 'weekdays 7 pm-7 pm', 'weekdays 13 pm-14 pm', 'weekdays 7:75-9', 'someday 7-9 pm'].every((s) => F.parseSchedulePhrase(s) === null), 'parsed one');

// ---- the chat phrase and /focus lengths
check('chat phrase: "focus for 90 minutes"', P.parseStart('focus for 90 minutes') === 90 && P.parseStart('Focus for 90 minutes.') === 90 && P.parseStart('focus 45 min') === 45);
check('chat phrase: hours, words, decimals', P.parseStart('start focus mode for 2 hours') === 120 && P.parseStart('focus for an hour') === 60 && P.parseStart('focus for half an hour') === 30 && P.parseStart('please start a focus session for 1.5 hours') === 90 && P.parseStart('focus for 1,5h') === 90);
check('chat phrase: anything else goes to the AI', ['focus', 'focus on my essay for 2 hours', 'how do I focus for 2 hours', 'focus for 5 days', 'focus for 13 hours', 'focus for 0 minutes', 'I want to focus for 2 hours today', ''].every((s) => P.parseStart(s) === null), 'matched one');
check('/focus length', P.parseLength('90 minutes') === 90 && P.parseLength('2h') === 120 && P.parseLength('45') === null && P.parseLength('forever') === null);

// ---- the controller
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-focus-units-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
const MIN = 60000;
function rig({ settings = {}, dir = fs.mkdtempSync(path.join(tmp, 'p-')), start = at(19, 12) } = {}) {
  const r = { clock: start, timers: [], settings: { ...settings }, tabs: [], sent: [], dir, loads: [] };
  r.tabWc = (url, { tab = true } = {}) => { const wc = { id: r.tabs.length + 100, tab, destroyed: false, url, isDestroyed: () => wc.destroyed, getURL: () => wc.url, loadURL: (u) => { r.loads.push([wc.id, u]); wc.url = u; return Promise.resolve(); } }; r.tabs.push(wc); return wc; };
  r.ctl = F.create({
    dir, now: () => r.clock, holdMs: 10000,
    setTimer: (fn, ms) => { const t = { fn, at: r.clock + ms, unref() {} }; r.timers.push(t); return t; },
    clearTimer: (t) => { const i = r.timers.indexOf(t); if (i >= 0) r.timers.splice(i, 1); },
    readSettings: () => r.settings, pageUrl: 'file:///app/renderer/focus-block.html', isTab: (wc) => wc.tab, tabContents: () => r.tabs, broadcast: (s) => r.sent.push(s),
  });
  r.advance = (ms) => { const end = r.clock + ms; for (;;) { const due = r.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; r.timers.splice(r.timers.indexOf(due), 1); r.clock = Math.max(r.clock, due.at); due.fn(); } r.clock = end; };
  r.request = (url, wc = r.tabWc('about:blank')) => { let answer = null; const handled = r.ctl.gate({ url, resourceType: 'mainFrame', webContents: wc }, (a) => { answer = a; }); return { handled, answer, wc }; };
  return r;
}

{
  const r = rig();
  check('off by default: nothing is blocked', r.ctl.state().active === false && r.request('https://www.youtube.com/watch').handled === false);
  check('off by default: no files are written', fs.readdirSync(r.dir).length === 0, fs.readdirSync(r.dir).join());
  const s = r.ctl.start(90);
  check('start(90): on, until 90 minutes from now, from the toolbar button', s.active && s.source === 'manual' && s.until === r.clock + 90 * MIN && s.remainingMs === 90 * MIN, JSON.stringify(s));
  check('start: tells the windows', r.sent.length > 0 && r.sent[r.sent.length - 1].active === true);
  const b = r.request('https://www.youtube.com/watch?v=1');
  check('on: a listed page is cancelled before it loads', b.handled && eq(b.answer, { cancel: true }), JSON.stringify(b));
  check('on: the tab then gets the block page, with the address and the site', (() => { const page = r.ctl.blockPage(b.wc, 'https://www.youtube.com/watch?v=1', -20); const u = new URL(page); return page.startsWith('file:///app/renderer/focus-block.html?') && u.searchParams.get('url') === 'https://www.youtube.com/watch?v=1' && u.searchParams.get('site') === 'youtube.com'; })());
  check('blockPage answers once, and only for a blocked load', r.ctl.blockPage(b.wc, 'https://www.youtube.com/watch?v=1', -20) === null && r.ctl.blockPage(r.tabWc('x'), 'https://a.test/', -20) === null);
  check('blockPage: another error code is not the gate\'s', (() => { const w = r.request('https://reddit.com/').wc; return r.ctl.blockPage(w, 'https://reddit.com/', -105) === null; })());
  check('on: a page that is not listed loads', r.request('https://www.wikipedia.org/').handled === false && r.request('https://khanacademy.org/').handled === false);
  check('on: a subdomain of a listed site is blocked, a look-alike is not', r.request('https://m.youtube.com/').handled === true && r.request('https://notyoutube.com/').handled === false && r.request('https://youtube.com.evil.test/').handled === false);
  check('on: the AI\'s hidden tabs (not a tab) are not blocked', r.request('https://www.youtube.com/', r.tabWc('hidden', { tab: false })).handled === false);
  check('on: only web pages are looked at', r.request('file:///c:/youtube.com/a.html').handled === false && r.request('lumen://settings').handled === false);
  check('on: a destroyed tab is not asked', (() => { const w = r.tabWc('x'); w.destroyed = true; return r.request('https://www.youtube.com/', w).handled === false; })());

  // I need this for school
  check('allow: only for a listed site', r.ctl.allow('https://www.wikipedia.org/').ok === false && r.ctl.allow('nonsense').ok === false);
  const a = r.ctl.allow('https://www.youtube.com/watch?v=1');
  check('allow: that site, ten minutes', a.ok && a.site === 'youtube.com' && a.until === r.clock + 10 * MIN, JSON.stringify(a));
  check('allow: the site (and its subdomains) loads; the others stay blocked', r.request('https://www.youtube.com/watch?v=2').handled === false && r.request('https://m.youtube.com/').handled === false && r.request('https://reddit.com/').handled === true);
  r.advance(9 * MIN);
  check('allow: still open at 9 minutes', r.request('https://www.youtube.com/').handled === false);
  r.advance(2 * MIN);
  check('allow: blocked again after ten minutes', r.request('https://www.youtube.com/').handled === true);
  check('allow: it is in the log, with the host and no address', (() => { const l = r.ctl.log().filter((e) => e.type === 'allow'); return l.length === 1 && l[0].site === 'youtube.com' && l[0].minutes === 10 && !JSON.stringify(l).includes('watch'); })());
  check('state lists the allowance while it lasts', (() => { r.ctl.allow('https://reddit.com/'); const s2 = r.ctl.state(); return s2.allows.length === 1 && s2.allows[0].site === 'reddit.com' && s2.allows[0].until === r.clock + 10 * MIN; })());

  // End focus: a hold
  r.ctl.endBegin();
  r.advance(3000);
  let end = r.ctl.endConfirm();
  check('End focus: confirmed after 3 s of holding is refused, and focus stays on', end.ok === false && r.ctl.state().active === true, JSON.stringify(end));
  check('End focus: a confirm with no hold at all is refused', r.ctl.endConfirm().ok === false && r.ctl.state().active);
  r.ctl.endBegin();
  r.advance(5000);
  r.ctl.endCancel();
  r.advance(6000);
  check('End focus: letting go cancels the hold (a later confirm is refused)', r.ctl.endConfirm().ok === false && r.ctl.state().active);
  r.ctl.endBegin();
  r.advance(9700);
  check('End focus: 9.7 s is a little short', r.ctl.endConfirm().ok === false && r.ctl.state().active);
  r.ctl.endBegin();
  r.advance(10000);
  end = r.ctl.endConfirm();
  check('End focus: held for 10 s ends it', end.ok === true && end.state.active === false && r.ctl.state().active === false, JSON.stringify(end));
  check('ended: nothing is blocked, the allowances are gone, the session file is gone', r.request('https://www.youtube.com/').handled === false && r.ctl.state().allows.length === 0 && !fs.existsSync(path.join(r.dir, 'focus-session.json')));
  const types = r.ctl.log().map((e) => `${e.type}${e.how ? `:${e.how}` : ''}`);
  check('log: start, the allowances, then the end ("early")', types[0] === 'start' && types.includes('allow') && types[types.length - 1] === 'end:early', types.join());
  r.ctl.stop();
}

{ // a session ends by itself, and survives a restart
  const r = rig();
  r.ctl.start(25);
  const dir = r.dir;
  check('a started session is on disk (so a restart keeps it)', fs.existsSync(path.join(dir, 'focus-session.json')));
  r.clock += 10 * MIN;
  const again = rig({ dir, start: r.clock });
  check('restart 10 minutes later: still on, 15 minutes left', again.ctl.state().active && again.ctl.state().remainingMs === 15 * MIN, JSON.stringify(again.ctl.state()));
  check('restart: the gate is up at once', again.request('https://www.twitch.tv/').handled === true);
  again.ctl.stop();
  const later = rig({ dir, start: r.clock + 20 * MIN });
  check('restart after it would have ended: off, and the stale file is removed', later.ctl.state().active === false && !fs.existsSync(path.join(dir, 'focus-session.json')));
  later.ctl.stop();
  r.advance(26 * MIN);
  check('it ends by itself when the time is up', r.ctl.state().active === false && r.request('https://www.youtube.com/').handled === false);
  check('log: it ended "finished"', r.ctl.log().some((e) => e.type === 'end' && e.how === 'finished'), JSON.stringify(r.ctl.log()));
  r.ctl.stop();
}

{ // extend, restart over a session, the range
  const r = rig();
  check('start: under a minute or over twelve hours is refused', (() => { let n = 0; for (const x of [0, -5, 721, 'x', NaN]) { try { r.ctl.start(x); } catch { n++; } } return n === 5 && !r.ctl.state().active; })());
  r.ctl.start(30);
  r.ctl.extend(15);
  check('extend adds time to a started session', r.ctl.state().remainingMs === 45 * MIN);
  r.ctl.start(60);
  check('starting again restarts the clock', r.ctl.state().remainingMs === 60 * MIN);
  r.ctl.stop();
}

{ // open tabs on a listed site go to the block page when focus starts
  const r = rig();
  const yt = r.tabWc('https://www.youtube.com/watch?v=1');
  const ok = r.tabWc('https://www.wikipedia.org/');
  r.ctl.start(30);
  check('start: a tab already on a listed site is sent to the block page; others are left alone', r.loads.length === 1 && r.loads[0][0] === yt.id && r.loads[0][1].includes('focus-block.html') && ok.url === 'https://www.wikipedia.org/', JSON.stringify(r.loads));
  r.ctl.stop();
}

{ // the user's own list
  const r = rig({ settings: { focusSites: ['example.test', 'Other.TEST'] } });
  r.ctl.start(30);
  check('the user\'s list replaces the default', r.request('https://sub.example.test/').handled && r.request('https://other.test/').handled && !r.request('https://www.youtube.com/').handled);
  r.settings.focusSites = [];
  check('an empty list blocks nothing', r.request('https://example.test/').handled === false && r.ctl.state().active === true);
  r.settings.focusSites = 'garbage';
  check('a damaged setting falls back to the default list', r.request('https://www.youtube.com/').handled === true);
  r.ctl.stop();
}

{ // schedules: on by themselves, off at the end, the user can end one early
  const r = rig({ settings: { focusSchedules: [{ id: 'w', days: [1, 2, 3, 4, 5], from: '19:00', to: '21:00', on: true }] }, start: at(19, 18) });
  check('before the window: off, and the next start is known', r.ctl.state().active === false && r.ctl.state().next === at(19, 19) && r.request('https://www.youtube.com/').handled === false);
  r.advance(61 * MIN);
  const s = r.ctl.state();
  check('at 19:00 it starts by itself (a schedule), until 21:00', s.active && s.source === 'schedule' && s.until === at(19, 21), JSON.stringify(s));
  check('the window blocks the listed sites', r.request('https://www.youtube.com/').handled === true);
  check('log: the schedule start', r.ctl.log().some((e) => e.type === 'start' && e.source === 'schedule'));
  r.advance(2 * HOUR());
  check('at 21:00 it ends by itself', r.ctl.state().active === false && r.request('https://www.youtube.com/').handled === false && r.ctl.state().next === at(20, 19), JSON.stringify(r.ctl.state()));

  const e = rig({ settings: { focusSchedules: [{ id: 'w', days: [1, 2, 3, 4, 5], from: '19:00', to: '21:00', on: true }] }, start: at(19, 20) });
  check('starting inside a window: on', e.ctl.state().active && e.ctl.state().source === 'schedule');
  e.ctl.endBegin();
  e.advance(10000);
  check('End focus on a schedule window: ended', e.ctl.endConfirm().ok === true && e.ctl.state().active === false);
  e.advance(30 * MIN);
  check('...and it stays off for the rest of that window', e.ctl.state().active === false && e.request('https://www.youtube.com/').handled === false);
  e.advance(24 * 60 * MIN);
  check('...and the next evening starts by itself again', e.ctl.state().active === true && e.ctl.state().source === 'schedule' && e.ctl.state().until === at(20, 21), JSON.stringify(e.ctl.state()));
  e.ctl.stop();

  r.settings.focusSchedules = [];
  r.ctl.settingsChanged();
  check('schedules removed: nothing starts', r.ctl.state().active === false);
  r.ctl.stop();
}

{ // a manual session inside a schedule window: ending it ends the window's block too
  const r = rig({ settings: { focusSchedules: [{ id: 'w', days: [1, 2, 3, 4, 5], from: '19:00', to: '21:00', on: true }] }, start: at(19, 19, 30) });
  r.ctl.start(30);
  r.ctl.endBegin();
  r.advance(10000);
  r.ctl.endConfirm();
  check('End focus with a session and a window both on: both end', r.ctl.state().active === false);
  r.ctl.stop();
}

{ // after the schedule's window, a started session is its own
  const r = rig({ settings: { focusSchedules: [{ id: 'w', days: [1], from: '19:00', to: '21:00', on: true }] }, start: at(19, 10) });
  r.ctl.start(60);
  check('a started session shows as manual', r.ctl.state().source === 'manual' && r.ctl.state().next === null);
  r.ctl.stop();
}

{ // the menu
  const r = rig();
  const t = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;
  const menu = r.ctl.menuTemplate({ t, openStatus: () => 'status', openSettings: () => 'settings' });
  const starts = menu.filter((x) => x.click && x.label.startsWith('focus.dur'));
  check('menu (off): lengths to start, and Focus settings', starts.length === 6 && menu.some((x) => x.label === 'focus.menu.settings'), menu.map((x) => x.label).join());
  starts[3].click();
  check('menu: the 90 minute entry starts 90 minutes', r.ctl.state().active && r.ctl.state().remainingMs === 90 * MIN);
  const on = r.ctl.menuTemplate({ t, openStatus: () => 'status', openSettings: () => 'settings' });
  check('menu (on): the time left, add time, End focus', on[0].enabled === false && on[0].label.startsWith('focus.menu.on') && on.some((x) => x.label.startsWith('focus.menu.add')) && on.some((x) => x.label === 'focus.menu.end' && x.click() === 'status'));
  r.ctl.stop();
}

function HOUR() { return 60 * MIN; }
check('durationText', F.durationText(75 * MIN, (k, v) => `${k}:${JSON.stringify(v)}`).startsWith('focus.left.hm') && F.durationText(5 * MIN, (k) => k) === 'focus.left.m' && F.durationText(20000, (k) => k) === 'focus.left.s');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
