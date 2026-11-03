// Antigravity's plan quota (ai/agy-quota.js), with recorded and fake agy output only, never the real agy:
//  - the status line JSON agy 1.4.12 really passes (test/fixtures/agy-statusline.json, recorded 2026-11-02, email and paths replaced)
//    -> the Gemini and the Claude/GPT ("3p") groups, each a 5-hour and a weekly window, used percent and reset time;
//  - the plan bar (features/usage.js barFor), the chat's model picking its group's bar (renderer/usage-bars.js barOf), the popover;
//  - when the usage log re-reads it (only after Antigravity was used, at most once a minute after a reply, else every 5 minutes);
//  - on Windows, the whole probe in a pseudo console against a fake agy TUI (test/fixtures/fake-agy-tui.js through a .cmd shim):
//    the reading arrives, nothing is left running, the temp folder goes; a fake that passes no quota gives null.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AQ = require('../../src/ai/agy-quota');
const U = require('../../src/features/usage');
const PU = require('../../src/features/provider-usage');
const UB = require('../../src/renderer/usage-bars');
const UP = require('../../src/renderer/usage-popover');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'agy-statusline.json');
const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-agy-tui.js');

module.exports = async function agyQuotaUnits(check) {
  const recorded = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const NOW = Date.parse('2026-11-02T23:30:00Z');
  const H = 3600e3;

  // ---- the recorded status line
  const r = AQ.parseStatus(recorded, NOW);
  const g = r && r.groups.gemini;
  const p3 = r && r.groups['3p'];
  check('parse: two groups, Gemini and the Claude/GPT ("3p") one, each a 5-hour then a weekly window', g && p3 && g.windows.map((w) => w.minutes).join() === '300,10080' && p3.windows.map((w) => w.minutes).join() === '300,10080', JSON.stringify(r));
  check('parse: used percent is 1 - remaining_fraction (3p 5-hour used up, its week about half, Gemini barely touched)', p3.windows[0].percent === 100 && Math.round(p3.windows[1].percent) === 51 && g.windows[0].percent < 1, JSON.stringify(r.groups));
  check('parse: the reset is agy\'s own reset_time', p3.windows[0].resetsAt === Date.parse('2026-11-03T03:57:08Z') && g.windows[1].resetsAt === Date.parse('2026-11-09T22:25:51Z'), JSON.stringify(p3.windows[0]));
  check('parse: the plan\'s name is kept, the email and the paths are not', r.tier === 'Google AI Pro' && !/someone|Users/.test(JSON.stringify(r)), JSON.stringify(r));
  check('parse: no quota (signed out, an older agy), a broken bucket or no JSON gives null', AQ.parseStatus({ ...recorded, quota: undefined }) === null && AQ.parseStatus({ quota: { 'gemini-5h': { remaining_fraction: 'x' } } }) === null && AQ.parseStatus(null) === null, '');
  const bySeconds = AQ.parseStatus({ quota: { 'gemini-5h': { remaining_fraction: 0.25, reset_in_seconds: 60 } } }, NOW);
  check('parse: without reset_time, reset_in_seconds from the reading\'s time', bySeconds.groups.gemini.windows[0].resetsAt === NOW + 60e3 && bySeconds.groups.gemini.windows[0].percent === 75, JSON.stringify(bySeconds));
  check('window lengths by name: 5h, weekly, daily, 12h, 30d; an unknown one null', AQ.minutesOf('5h') === 300 && AQ.minutesOf('weekly') === 10080 && AQ.minutesOf('daily') === 1440 && AQ.minutesOf('12h') === 720 && AQ.minutesOf('30d') === 43200 && AQ.minutesOf('hourly') === null, '');
  check('model groups: Gemini, Auto and the default are "gemini"; Claude and GPT-OSS are "3p"', AQ.groupOf('antigravity:gemini-3.8-flash-high') === 'gemini' && AQ.groupOf('antigravity:auto') === 'gemini' && AQ.groupOf('antigravity:default') === 'gemini' && AQ.groupOf('antigravity:claude-sonnet-4-6') === '3p' && AQ.groupOf('gpt-oss-120b-medium') === '3p', '');

  // ---- what the probe runs
  const s = AQ.settingsFor(path.join(os.tmpdir(), 'a b', 'work'));
  check('settings: the statusLine command has no path and no quote (agy hands it to cmd.exe); the workspace is trusted', s.statusLine.type === 'command' && s.statusLine.command === `more > ${AQ.STATUS_FILE}` && !/["\\/]/.test(s.statusLine.command) && s.trustedWorkspaces[0] === path.resolve(os.tmpdir(), 'a b', 'work'), JSON.stringify(s));
  check('command line: plain words as they are, spaces and quotes quoted the way CreateProcess reads them back', AQ.quoteArg('agy.exe') === 'agy.exe' && AQ.quoteArg('C:\\a b\\agy.exe') === '"C:\\a b\\agy.exe"' && AQ.quoteArg('say "hi"') === '"say \\"hi\\""' && AQ.quoteArg('C:\\a b\\') === '"C:\\a b\\\\"' && AQ.quoteArg('') === '""', AQ.quoteArg('C:\\a b\\'));
  check('command line: a .cmd (a test\'s fake agy) goes through cmd.exe; an .exe does not', /cmd\.exe"? \/d \/s \/c ""C:\\a b\\agy\.cmd" --settings x"$/i.test(AQ.commandLine('C:\\a b\\agy.cmd', ['--settings', 'x'])) && AQ.commandLine('C:\\agy.exe', ['--mode', 'plan']) === 'C:\\agy.exe --mode plan', AQ.commandLine('C:\\a b\\agy.cmd', ['--settings', 'x']));
  check('readQuota: not on Windows, or with no agy, gives null at once (nothing is started)', await AQ.readQuota({ bin: 'agy', platform: 'linux', spawn: () => { throw new Error('started'); } }) === null && await AQ.readQuota({ bin: null, platform: 'win32', spawn: () => { throw new Error('started'); } }) === null, '');

  // ---- the plan bar
  const q = AQ.summaryOf(r, NOW);
  const bar = U.barFor('antigravity', { antigravity: q });
  check('bar: a plan bar for the Gemini models by default, with the weekly window as the second number', bar && bar.kind === 'plan' && bar.group === 'gemini' && bar.minutes === 300 && bar.weekly && bar.weekly.minutes === 10080 && bar.percent < 1 && bar.tier === 'Google AI Pro', JSON.stringify(bar));
  check('bar: every group\'s own bar in `groups`; the Claude/GPT one is used up', bar.groups['3p'].percent === 100 && bar.groups['3p'].level === 'high' && bar.groups.gemini.percent === bar.percent, JSON.stringify(bar.groups['3p']));
  check('bar: a quota message newer than the reading still wins (the limit state); an older one does not', U.barFor('antigravity', { antigravity: q, limits: { antigravity: { at: NOW + 1000, resetsAt: NOW + 5 * H, text: 'Quota exhausted' } } }).kind === 'limit' && U.barFor('antigravity', { antigravity: q, limits: { antigravity: { at: NOW - 1000, resetsAt: NOW + 5 * H, text: 'Quota exhausted' } } }).kind === 'plan', '');
  const later = AQ.summaryOf(r, Date.parse('2026-11-03T04:00:00Z'));
  check('bar: after the 3p 5-hour window resets, its weekly one is the bar; when every window reset, no number', U.barFor('antigravity', { antigravity: later }).groups['3p'].minutes === 10080 && U.barFor('antigravity', { antigravity: AQ.summaryOf(r, NOW + 30 * 24 * H) }) === null, '');
  check('bar: no reading keeps the old behaviour (no plan bar, never a guess)', U.barFor('antigravity', {}) === null && U.barFor('antigravity', { antigravity: null }) === null, '');

  // ---- the chat's model picks its group's bar
  const state = { bars: { antigravity: bar }, cooling: {}, antigravity: q };
  const claude = UB.forModel('antigravity:claude-sonnet-4-6', state, NOW);
  const gem = UB.forModel('antigravity:gemini-3.8-flash-high', state, NOW);
  check('picker: a Claude model on Antigravity reads the used-up 3p quota, a Gemini one its own', claude && claude.out === true && gem && gem.out === false && gem.percent < 1, JSON.stringify({ claude, gem }));
  check('picker: barOf gives the default bar with no model, and none for a group the reading lacks', UB.barOf('antigravity', state) === bar && UB.barOf('antigravity', { bars: { antigravity: { ...bar, groups: { gemini: bar.groups.gemini } } } }, 'antigravity:claude-opus-4-6-thinking') === null, '');
  const d = UB.describe(bar.groups['3p'], { now: NOW });
  check('describe: "Out of usage" with the reset time, then the 5-hour and weekly lines', /^Out of usage, resets /.test(d.title) && /weekly limit: 51% used/.test(d.title), d.title);
  const pop = UP.view('antigravity', state, { now: NOW, name: 'Antigravity', model: 'antigravity:claude-sonnet-4-6' });
  check('popover: the chat\'s group\'s windows, the plan\'s name, and when the numbers were read', pop.windows.length === 2 && pop.windows[0].label === '5-hour limit' && pop.windows[0].percent === 100 && pop.plan === 'Google AI Pro' && pop.updatedAt === NOW && pop.note === '', JSON.stringify(pop));
  check('settings note: says where the quota comes from and what shows when it cannot be read', /status line/.test(PU.noPlanText('antigravity')) && /Resets in 110h/.test(PU.noPlanText('antigravity')), PU.noPlanText('antigravity'));

  // ---- when the usage log reads it
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agyq-units-'));
  let clock = NOW;
  let calls = 0;
  let answer = () => AQ.parseStatus(recorded, clock);
  const usage = U.createUsage({ app: { getPath: () => ud }, now: () => clock, claudeBin: async () => null, otherActivity: async () => false, agyQuota: async () => { calls++; return answer(); } });
  usage.load();
  let sum = await usage.summary({});
  check('refresh: never read before Lumen has used Antigravity (no agy started for someone who doesn\'t use it)', calls === 0 && sum.antigravity === null && sum.bars.antigravity === null, String(calls));
  sum = await usage.summary({ refresh: true });
  check('refresh: a Refresh reads it anyway', calls === 1 && sum.bars.antigravity.kind === 'plan', String(calls));
  clock += 30e3;
  usage.record('antigravity', { usage: { inputTokens: 10, outputTokens: 5 }, ok: true, model: 'gemini-3.8-flash-high' });
  await usage.summary({});
  check('refresh: a reply 30 s after the reading does not re-read it yet', calls === 1, String(calls));
  clock += 31e3;
  await usage.summary({});
  check('refresh: a minute after the reading, with a reply since, it is read again', calls === 2, String(calls));
  clock += 2 * 60e3;
  await usage.summary({});
  check('refresh: no reply since: not before 5 minutes', calls === 2, String(calls));
  clock += 4 * 60e3;
  await usage.summary({});
  check('refresh: after 5 minutes it is read again', calls === 3, String(calls));
  await usage.summary({ cached: true, refresh: false });
  check('refresh: the pickers\' cached look never starts agy', calls === 3, String(calls));
  answer = () => null;
  clock += 6 * 60e3;
  sum = await usage.summary({});
  check('refresh: a failed read keeps the last reading (and its plan name)', calls === 4 && sum.antigravity && sum.antigravity.tier === 'Google AI Pro' && sum.bars.antigravity.kind === 'plan', JSON.stringify(sum.antigravity));
  clock += 10e3;
  usage.record('antigravity', { usage: { inputTokens: 1, outputTokens: 1 }, ok: true });
  await usage.summary({});
  clock += 30e3;
  await usage.summary({});
  check('refresh: after a failed read agy is not started again on every look (the attempt counts, not only a success)', calls === 4, String(calls));
  clock += 61e3;
  await usage.summary({});
  check('refresh: a minute after the failed attempt, with a reply since, it is tried again', calls === 5, String(calls));
  const both = await Promise.all([usage.summary({ refresh: true }), usage.summary({ refresh: true })]);
  check('refresh: two summaries at once share one agy run', calls === 6 && both.length === 2, String(calls));
  usage.flush();
  const kept = JSON.parse(fs.readFileSync(path.join(ud, 'usage.json'), 'utf8')).agyQuota;
  check('kept: usage.json holds the numbers and the plan name only', kept && kept.groups && kept.tier === 'Google AI Pro' && !/someone|@/.test(JSON.stringify(kept)), JSON.stringify(kept));
  const again = U.createUsage({ app: { getPath: () => ud }, now: () => clock, claudeBin: async () => null, agyQuota: async () => { throw new Error('not now'); } });
  again.load();
  check('kept: a restart shows the kept reading before agy is read again', (await again.summary({ cached: true })).antigravity.readAt === kept.at, '');

  // ---- the whole probe, in a pseudo console, against a fake agy (Windows only: ConPTY)
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agyq fake-'));
  const trace = path.join(dir, 'trace.txt');
  const shim = (name, extra = '') => {
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, `@echo off\r\nset FAKE_AGY_TRACE=${trace}\r\n${extra}"${process.execPath}" "${FAKE}" %*\r\n`);
    return file;
  };
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('lumen-agy-quota-')));
  const t0 = Date.now();
  const got = await AQ.readQuota({ bin: shim('agy'), timeoutMs: 20000 });
  const took = Date.now() - t0;
  check('probe: the fake agy\'s status line comes back as the reading', got && got.groups.gemini && got.groups['3p'].windows[0].percent === 100 && got.tier === 'Google AI Pro', JSON.stringify(got));
  check('probe: well inside its time limit', took < 15000, `${took} ms`);
  const lines = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n') : [];
  check('probe: agy ran in a real terminal (the pseudo console), with --settings and plan mode, and no prompt', lines.length === 1 && lines[0].startsWith('true ') && /"--settings"/.test(lines[0]) && /"--mode","plan"/.test(lines[0]) && !/"-p"|--print/.test(lines[0]), lines.join(' | '));
  const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('lumen-agy-quota-') && !before.has(f));
  await new Promise((res) => setTimeout(res, 1500)); // (removeDir retries while the tree lets go of the folder)
  check('probe: its temp folder (settings, workspace, HOME) is removed', fs.readdirSync(os.tmpdir()).filter((f) => left.includes(f)).length === 0, left.join(','));
  const running = String(spawnSync('wmic', ['process', 'where', `CommandLine like '%fake-agy-tui%'`, 'get', 'ProcessId'], { encoding: 'utf8', windowsHide: true }).stdout || '').replace(/ProcessId/g, '').trim();
  check('probe: the fake agy is not left running', running === '', running);
  const quiet = await AQ.readQuota({ bin: shim('agy-silent', 'set FAKE_AGY_MODE=silent\r\n'), timeoutMs: 5000 });
  check('probe: an agy that passes no quota gives null after the wait', quiet === null, JSON.stringify(quiet));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
