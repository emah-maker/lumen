// Settings → Routines' pure part (renderer/settings-routines.js), no Electron: the schedule in words (the same wording as the sidebar's
// Routines tab), what a row says about the last and next run, a late run, a history line, and which templates can still be added.
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const X = require('../../src/renderer/settings-routines');
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locales', 'en.json'), 'utf8'));
const T = (key, vars) => (en[key] ?? key).replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w));

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const rs = (s) => ({ type: 'routine', days: [1, 2, 3, 4, 5, 6, 0], ...s });

// ---- the schedule in words
const text = (s) => X.scheduleText(rs(s), T);
check('daily', /^Every day at 8:00\s?AM$/.test(text({ repeat: 'daily', time: '08:00' })), text({ repeat: 'daily', time: '08:00' }));
check('weekdays', /^Weekdays at 7:30\s?AM$/.test(text({ repeat: 'weekdays', time: '07:30' })), text({ repeat: 'weekdays', time: '07:30' }));
check('weekly lists the chosen days Monday first', /^Mon, Thu at 9:15\s?AM$/.test(text({ repeat: 'weekly', days: [4, 1], time: '09:15' })), text({ repeat: 'weekly', days: [4, 1], time: '09:15' }));
check('Sunday sorts last', /^Fri, Sun at /.test(text({ repeat: 'weekly', days: [0, 5], time: '09:00' })), text({ repeat: 'weekly', days: [0, 5], time: '09:00' }));
check('every hour and every n hours', text({ repeat: 'hours', hours: 1 }) === 'Every hour' && text({ repeat: 'hours', hours: 3 }) === 'Every 3 hours');
check('cron is shown as written', text({ repeat: 'cron', cron: '30 8 * * 1-5' }) === 'Cron: 30 8 * * 1-5');
check('once names the date', /^Once, Oct 20, 3:00\s?PM$/.test(text({ repeat: 'once', at: at(2026, 10, 20, 15) })), text({ repeat: 'once', at: at(2026, 10, 20, 15) }));
check('cron every n minutes is said in words', text({ repeat: 'cron', cron: '*/30 * * * *' }) === 'Every 30 minutes');
check('the event triggers are said in words', text({ repeat: 'webhook' }) === 'When its web link is called' && text({ repeat: 'email', minutes: 10 }) === 'When new email arrives (checked every 10 min)');
check('a run with nothing to report and the new triggers have words', X.historyLine({ startedAt: at(2026, 10, 18, 8), status: 'nothing', trigger: 'webhook' }, T).includes('Nothing to report · from its web link') && T('routines.trigger.email') === 'new email');
check('the web links line: listening, port in use, or nothing when off', X.webhookStatus({ on: true, listening: true, port: 47821 }, T) === 'Listening on 127.0.0.1:47821.' && /Port 47821 is used by another program/.test(X.webhookStatus({ on: true, listening: false, port: 47821, error: 'in-use' }, T)) && X.webhookStatus({ on: false, port: 47821 }, T) === '');
check('a task that is not a routine has no schedule text', X.scheduleText({ type: 'task' }, T) === '' && X.scheduleText(null, T) === '');

// ---- a row
const base = { id: 'r1', title: 'Morning brief', schedule: rs({ repeat: 'daily', time: '08:00' }), enabled: true, status: 'done', template: '', nextRun: at(2026, 10, 19, 8), lastRun: at(2026, 10, 18, 8), unseen: false, pending: 0, runs: 3,
  last: { status: 'done', at: at(2026, 10, 18, 8, 1), trigger: 'schedule', snippet: 'Five stories.' } };
let m = X.rowModel(base, T);
check('an on routine shows its next run', /^Next run Oct 19, 8:00\s?AM$/.test(m.next), m.next);
check('the last result names the status and time', /^Last run Oct 18, 8:01\s?AM: Done$/.test(m.last) && m.late === false, m.last);
check('the last result carries its snippet', m.snippet === 'Five stories.' && !m.failed);
check('it can run and has a result to open', !m.active && m.hasResult && !m.canStop && !m.needsOk);
m = X.rowModel({ ...base, enabled: false, nextRun: null }, T);
check('a switched off routine says so instead of a next run', m.next === 'Switched off', m.next);
m = X.rowModel({ ...base, last: { ...base.last, trigger: 'catch-up', scheduledFor: at(2026, 10, 18, 8) } }, T);
check('a late run is marked ran late', m.late && /\(ran late\)$/.test(m.last), m.last);
m = X.rowModel({ ...base, last: { status: 'failed', at: at(2026, 10, 18, 8), trigger: 'schedule', snippet: '', error: 'Offline' } }, T);
check('a failed run shows its error', m.failed && m.snippet === 'Offline' && /Failed$/.test(m.last), `${m.snippet} ${m.last}`);
m = X.rowModel({ ...base, status: 'running', pending: 0 }, T);
check('a running routine cannot be run again and can be stopped', m.active && m.canStop && m.last === 'Running' && m.snippet === '', m.last);
m = X.rowModel({ ...base, status: 'waiting-approval', pending: 2 }, T);
check('a routine waiting for an OK says so', m.needsOk && m.active && m.last === 'Needs your OK', m.last);
m = X.rowModel({ ...base, last: null, lastRun: null, runs: 0, status: 'scheduled' }, T);
check('a routine that never ran says so and has no result to open', m.last === 'Not run yet' && !m.hasResult, m.last);

// ---- a history line
check('a history line names time, status and trigger', /^Oct 18, 8:00\s?AM · Done · on schedule$/.test(X.historyLine({ status: 'done', startedAt: at(2026, 10, 18, 8), trigger: 'schedule' }, T)), X.historyLine({ status: 'done', startedAt: at(2026, 10, 18, 8), trigger: 'schedule' }, T));
check('a late run in the history says when it was due', /ran late · was due Oct 18, 2:00\s?AM$/.test(X.historyLine({ status: 'done', startedAt: at(2026, 10, 18, 9), trigger: 'catch-up', scheduledFor: at(2026, 10, 18, 2) }, T)), X.historyLine({ status: 'done', startedAt: at(2026, 10, 18, 9), trigger: 'catch-up', scheduledFor: at(2026, 10, 18, 2) }, T));

// ---- templates
const view = { routines: [{ template: 'news' }], connected: ['gmail'] };
let tp = X.templateModel({ key: 'news' }, view, T);
check('a template already added is marked, and one without a connector has no connector line', tp.have && tp.ready === null && tp.connectorText === '', JSON.stringify(tp));
tp = X.templateModel({ key: 'email', connector: 'gmail' }, view, T);
check('a template whose app is connected says so', !tp.have && tp.ready === true && tp.connectorText === 'Gmail is connected.', tp.connectorText);
tp = X.templateModel({ key: 'canvas', connector: 'canvas' }, view, T);
check('a template whose app is not connected says where to connect it', tp.ready === false && /^Needs Canvas\. Connect it in Settings/.test(tp.connectorText), tp.connectorText);

// ---- strings
const used = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'settings-routines.js'), 'utf8');
const keys = [...new Set([...used.matchAll(/T\('([a-z][\w.-]*)'/g)].map((x) => x[1]))].filter((k) => !k.includes('${'));
const missing = keys.filter((k) => !(k in en));
check(`every string key the section uses (${keys.length}) is in en.json`, missing.length === 0, missing.join(', '));
const dyn = ['routines.history.status.done', 'routines.history.status.failed', 'routines.trigger.schedule', 'routines.trigger.manual', 'routines.trigger.catch-up', 'tasks.status.running', 'tasks.status.queued', 'tasks.status.waiting-approval',
  'routines.connector.gmail', 'routines.connector.canvas', 'routines.connector.gcal', 'routines.template.email.name', 'routines.template.canvas.name', 'routines.template.news.name', 'routines.template.calendar.name'];
check('the keys built from a status, trigger, connector or template name exist', dyn.every((k) => k in en), dyn.filter((k) => !(k in en)).join(', '));

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll checks passed');
