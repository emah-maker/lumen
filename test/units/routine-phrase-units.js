// renderer/routine-phrase.js: the fast gate that decides whether a message starts with a schedule phrase.
const { looksScheduled } = require('../../src/renderer/routine-phrase');
const R = require('../../src/features/routines');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

const yes = [
  'every day at 8am: check my email', 'Every weekday at 8am check my email', 'EVERY WEEKDAY', 'daily at 9: news brief', 'Daily summarize the news',
  'every 3 hours: look at the status page', 'every hour check this', 'hourly: ping', 'each morning, list what is due', 'every morning at 7 read me the news',
  'every evening at 6pm: plan tomorrow', 'weekly on mondays: summary', 'weekly summary of the site', 'every week at 9am: report', 'every monday and friday at 9am: standup notes',
  'every Mon, Wed at 7:30 check grades', 'each friday: wrap up', 'weekdays at 8: inbox', 'on weekdays at 8am: inbox', '  every day: leading space',
];
const no = [
  'Every time I try this it fails', 'every once in a while this happens', 'Everyone should read this', 'Every single one of them', 'each of the options',
  'What should I do every day?', 'Summarize this page', 'daily', '', null, undefined, 'weekly', 'Weekend plans?', 'every', 'every 99 apples',
  'Can you schedule something every day', 'on monday I went home', 'every dayz', 'hourlyish',
];
for (const t of yes) check(`schedule phrase: ${JSON.stringify(t)}`, looksScheduled(t) === true, String(looksScheduled(t)));
for (const t of no) check(`ordinary text: ${JSON.stringify(t)}`, looksScheduled(t) === false, String(looksScheduled(t)));

// Whatever the gate lets through that the real parser reads must agree with it; the gate may be wider than the parser, never narrower.
const parsedOk = ['every day at 8am: x', 'every weekday at 8am: check my email', 'daily at 9: news brief', 'every 3 hours: look', 'hourly: ping', 'every monday and friday at 9am: notes', 'every evening at 6pm: plan', 'weekly on mondays: summary'];
for (const t of parsedOk) check(`every phrase the parser reads passes the gate: ${t}`, R.parseScheduleText(t) !== null && looksScheduled(t), t);
check('a long message is not scanned past its start', looksScheduled(`every day: ${'x'.repeat(5000)}`) === false);
check('the gate is fast on a long line of near matches', (() => { const t0 = Date.now(); for (let i = 0; i < 20000; i++) looksScheduled(`every ${'day '.repeat(30)}`); return Date.now() - t0 < 1500; })());

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
