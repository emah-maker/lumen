// [project templates] features/job-sync.js: a Job applications project kept with the user's own tracker sheet (its header read by name,
// Status text turned into stages, one sync's plan: rows added, moves both ways, cells written, rows appended, found again by address after
// the sheet was sorted) and with Gmail (application emails sorted into received, interview, offer and rejection, the company named, and
// suggestions that change only what an email can); the chat store keeping the link without making the project "changed"; the runtime
// applying a plan and an email. Plain Node; every folder is a temp folder.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../src/features/job-sync');
const T = require('../../src/features/project-templates');
const runtime = require('../../src/features/automations-runtime');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const NOW = new Date(2026, 10, 24, 12).getTime();
const DAY = 86400000;

(async () => {
  // ---- the sheet: two real layouts (a summer internship tracker and a co-op tracker)
  const summer = [
    ['Company', 'Area', 'Role', 'Deadline', 'Gates', 'Status', 'Apply URL', 'Notes'],
    ['Garmin', 'Cary, NC', 'ME Intern', 'Listing closed Oct 18 2026', 'None listed', 'Applied (user-reported)', 'https://customcareer.miami.edu/jobs/garmin-mechanical-engineering-intern-2/', 'Confirm in portal'],
    ['Northwood Space', 'Torrance, CA', 'Mechanical Design Eng Intern', 'Nov 3 2026', 'None listed', 'Not started', '', 'Verify on site'],
    ['Anduril', 'Various US', 'ME Intern', 'Rolling', 'U.S. Person', 'Blocked until citizenship confirmed', 'https://boards.greenhouse.io/anduril/jobs/1', ''],
    ['', '', '', '', '', '', '', ''],
    ['Zipline', 'South SF', 'ME Intern', 'Rolling', 'None', 'Ask Sam', 'https://startup.jobs/zipline-1', ''],
  ];
  const coop = [
    ['Company', 'Role', 'Location', 'Co-op Term', 'Deadline', 'Gates', 'Status', 'Apply URL', 'Notes', 'Date Applied'],
    ['General Motors', '2027 Co-op - Manufacturing', 'Flint, MI', 'Co-op', 'Check posting', 'Unknown', 'Interviewing', 'https://search-careers.gm.com/en/jobs/jr-1/', '', '10/28/2026'],
    ['Ford Motor Company', 'Co-op search', 'Multiple', 'Co-op', '', '', 'Rejected', 'https://www.careers.ford.com/search-jobs/Co-op', '', 'Oct 20'],
  ];
  {
    const a = S.readSheet(summer, NOW);
    check('sheet: the header is read by name (Area is the location, Apply URL the address)', a.header.company === 0 && a.header.location === 1 && a.header.role === 2 && a.header.status === 5 && a.header.url === 6 && a.header.applied === undefined, J(a.header));
    check('sheet: the empty row is skipped, the rest numbered as the sheet numbers them', J(a.rows.map((r) => r.row)) === J([2, 3, 4, 6]), J(a.rows.map((r) => r.row)));
    check('sheet: the statuses turned into stages ("Ask Sam" says nothing)', J(a.rows.map((r) => r.stage)) === J(['applied', 'saved', 'saved', '']), J(a.rows.map((r) => r.stage)));
    const b = S.readSheet(coop, NOW);
    check('sheet: the co-op layout too, with its Date Applied', b.header.applied === 9 && b.rows[0].stage === 'interview' && b.rows[1].stage === 'rejected' && new Date(b.rows[0].applied).getDate() === 28, J(b.rows));
    check('sheet: "Oct 20" with no year is this year (or last year when that would be ahead)', new Date(b.rows[1].applied).getFullYear() === 2026 && new Date(S.parseDate('Dec 20', NOW)).getFullYear() === 2025);
    const dash = { tab: 'Dashboard', row: ['Odds', 'Listings by odds'] };
    const tracker = { tab: 'internship-tracker', row: ['Company', 'Area', 'Role', 'Deadline', 'Gates', 'Status', 'Apply URL', 'Notes', 'Referral', 'Odds', 'Link'] };
    check('tab: a summary tab first is passed over for the tab with the tracker columns', S.pickTab([dash, tracker]) === 'internship-tracker');
    check('tab: an Apply URL column alone is enough, and none at all finds nothing', S.pickTab([{ tab: 'L', row: ['Link'] }]) === 'L' && S.pickTab([dash, { tab: 'E', row: [] }]) === '' && S.pickTab(null) === '');
    const mine = S.readSheet([tracker.row, ['Zipline', 'South SF, CA', 'ME Intern', 'Rolling', 'None', 'Applied Oct 24, 2026', 'https://startup.jobs/x', 'n', '', 'Applied', 'Apply'], ['Northwood', 'Torrance, CA', 'Design Intern', 'Nov 3', 'None', 'Closed — expired (confirmed Oct 23, 2026)', 'https://jobs.ashbyhq.com/a/b', '', '', 'Med', 'Apply']], NOW);
    check('sheet: a tracker with both Apply URL and Link reads the Apply URL, Area as location', mine.header.url === 6 && mine.header.location === 1 && mine.rows[0].url.startsWith('https://startup.jobs/') && J(mine.rows.map((r) => r.stage)) === J(['applied', 'withdrawn']), J(mine.rows));
    check('sheet: one with no Company or Apply URL column says so', Boolean(S.readSheet([['Name', 'Status'], ['x', 'y']]).error));
    const stages = { 'Offer!': 'offer', 'Offer declined': 'offer', 'Rejected after OA': 'rejected', 'OA sent': 'interview', 'Phone screen 11/2': 'interview', 'Submitted': 'applied', 'Backup': 'saved', 'Skip': 'withdrawn', 'Withdrew': 'withdrawn', '': 'saved' };
    const got = Object.fromEntries(Object.keys(stages).map((k) => [k, S.stageFromStatus(k)]));
    check('sheet: Status words people use', J(got) === J(stages), J(got));
  }

  // ---- one sync's plan
  {
    const sheet = S.readSheet(coop, NOW);
    const first = S.plan([], sheet, { tab: 'fall-coop-tracker', now: NOW });
    check('plan: a first sync adds the sheet\'s rows to the tracker, at their stage and applied date', first.add.length === 2 && first.add[0].stage === 'interview' && first.add[0].submittedAt === sheet.rows[0].applied && first.add[0].automation === 'Google Sheet' && first.add[0].sheet.status === 'Interviewing', J(first.add[0]));
    check('plan: nothing written to the sheet on a first sync', first.cells.length === 0 && first.append.length === 0);
    // the entries as the tracker keeps them after that sync
    const entries = first.add.map((e) => ({ ...e }));
    // nothing changed anywhere: nothing to do
    const quiet = S.plan(entries, sheet, { tab: 'fall-coop-tracker', now: NOW });
    check('plan: nothing changed, nothing to do', quiet.add.length === 0 && quiet.moves.length === 0 && quiet.cells.length === 0 && quiet.append.length === 0, J(quiet));
    // moved in Lumen (GM: interview -> offer): its Status cell is written
    T.setStage(entries[0], 'offer', NOW);
    const out = S.plan(entries, sheet, { tab: 'fall-coop-tracker', now: NOW });
    check('plan: a move in Lumen writes the Status cell of that row, the tab quoted', J(out.cells) === J([{ range: "'fall-coop-tracker'!G2", value: 'Offer' }]), J(out.cells));
    check('plan: "Keep the sheet updated" off writes nothing', S.plan(entries, sheet, { write: false }).cells.length === 0);
    // the user sorted the sheet and changed Ford's status there; a new application was logged in Lumen
    const sorted = S.readSheet([coop[0], ['Ford Motor Company', 'Co-op search', 'Multiple', 'Co-op', '', '', 'Interview 12/1', 'https://www.careers.ford.com/search-jobs/Co-op', '', 'Oct 20'], ['General Motors', '2027 Co-op - Manufacturing', 'Flint, MI', 'Co-op', '', '', 'Interviewing', 'https://search-careers.gm.com/en/jobs/jr-1/?utm_source=x', '', '10/28/2026']], NOW);
    const logged = T.manualEntry({ company: 'Tesla', role: 'Manufacturing co-op', url: 'https://tesla.com/careers/1' }, { projectId: 'p', now: NOW }).entry;
    const after = S.plan([...entries, logged], sorted, { tab: 'fall-coop-tracker', now: NOW });
    check('plan: the sheet\'s change moves the tracker (Ford rejected -> interview)', J(after.moves.map((m) => [m.key, m.stage])) === J([[T.entryKey(entries[1]), 'interview']]), J(after.moves));
    check('plan: after a sort, the cell written is GM\'s new row (found by its address, tracking parameters and all)', J(after.cells) === J([{ range: "'fall-coop-tracker'!G3", value: 'Offer' }]), J(after.cells));
    check('plan: an application logged in Lumen becomes a new row, in the sheet\'s own columns', after.append.length === 1 && after.append[0].cells[0] === 'Tesla' && after.append[0].cells[6] === 'Applied' && after.append[0].cells[7] === 'https://tesla.com/careers/1' && /^11\/24\/2026$/.test(after.append[0].cells[9]) && after.append[0].cells.length === 10, J(after.append));
    const gone = { ...entries[1], sheet: { status: 'Rejected', row: 3 } };
    check('plan: an entry taken out of the sheet by the user is not added back', S.plan([gone], S.readSheet([coop[0]], NOW)).append.length === 0);
    check('plan: a row whose Status says nothing known is not added', S.plan([], S.readSheet(summer, NOW)).add.length === 3);
  }

  // ---- email
  {
    const m = (from, subject, snippet = '') => ({ from, subject, snippet });
    const cases = [
      [m('Acme Careers <no-reply@myworkday.com>', 'Thank you for applying to Acme Robotics'), 'applied', 'Acme Robotics'],
      [m('"Draper Talent Acquisition" <talent@draper.com>', 'Update on your application', 'Thank you for applying. Unfortunately, we have decided to move forward with other candidates.'), 'rejected', 'Draper'],
      [m('recruiting@formlabs.com', 'Interview invitation - Hardware co-op', 'We would like to invite you to interview'), 'interview', 'Formlabs'],
      [m('Boston Dynamics <no-reply@greenhouse.io>', 'Boston Dynamics - next steps', 'Please complete the coding challenge on HackerRank'), 'interview', 'Boston Dynamics'],
      [m('Moderna University Relations <ur@modernatx.com>', 'Your co-op offer', 'We are pleased to offer you the Process engineering co-op'), 'offer', 'Moderna'],
      [m('GE Aerospace <careers@ge.com>', 'We received your application', 'Your application has been received'), 'applied', 'GE Aerospace'],
    ];
    for (const [msg, kind, company] of cases) {
      const c = S.classifyEmail(msg);
      check(`email: "${msg.subject}" is ${kind} from ${company}`, c?.kind === kind && c?.company === company, J(c));
    }
    check('email: a message about something else is none', S.classifyEmail(m('Sam <sam@gmail.com>', 'lunch tomorrow?', 'want to grab food')) === null && S.classifyEmail(m('Amazon <ship@amazon.com>', 'Your order has shipped')) === null);
    const entries = [
      { id: 'a1', company: 'Acme Robotics', role: 'ME co-op', stage: 'saved' },
      { id: 'd1', company: 'Draper', role: 'Mechanical co-op', stage: 'applied', submittedAt: NOW - 20 * DAY },
      { id: 'f1', company: 'Formlabs', role: 'Hardware co-op', stage: 'interview', submittedAt: NOW - 30 * DAY },
      { id: 'm1', company: 'Moderna', role: 'Process', stage: 'rejected', submittedAt: NOW - 30 * DAY },
    ];
    const msgs = cases.map(([msg], i) => ({ ...msg, id: `abc00${i}`, at: NOW - i * DAY }));
    const sug = S.emailSuggestions(entries, msgs);
    const by = Object.fromEntries(sug.map((s) => [s.company, s]));
    check('suggest: a saved posting confirmed by email moves to applied', by['Acme Robotics']?.key === 'a1' && by['Acme Robotics'].stage === 'applied', J(by['Acme Robotics']));
    check('suggest: a rejection moves an open application to rejected', by.Draper?.key === 'd1' && by.Draper.stage === 'rejected');
    check('suggest: an interview email for one at the interview already is nothing', !by.Formlabs);
    check('suggest: a closed one is not reopened by an offer email', !by.Moderna);
    check('suggest: an email from a company not in the tracker is a new application', by['GE Aerospace']?.key === '' && by['GE Aerospace'].stage === 'applied' && by['Boston Dynamics']?.key === '' && by['Boston Dynamics'].stage === 'interview', J(sug));
    check('suggest: newest first, one per change', sug.every((s, i) => !i || sug[i - 1].at >= s.at) && new Set(sug.map((s) => `${s.company}:${s.stage}`)).size === sug.length);
    check('suggest: one already applied or ignored is not suggested again', !S.emailSuggestions(entries, msgs, ['abc001']).some((s) => s.company === 'Draper'));
    check('suggest: the Gmail search asks for the last 120 days only', /newer_than:120d/.test(S.GMAIL_QUERY));
  }

  // ---- the chat store keeps the link (and doesn't call it a change of the project)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-job-sync-store-'));
    let clock = NOW;
    const enc = (s) => Buffer.from(s).toString('base64');
    const dec = (s) => Buffer.from(s, 'base64').toString();
    const store = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ++clock });
    const p = store.saveProject({ name: 'Co-op search', template: 'job-applications' });
    const before = store.projects()[0].updated;
    check('store: the sync state is kept', store.setJobSync(p.id, { sheet: { id: '1ntk3gFKDSOJfWtqwjnr87maPPiFA0aV_tpGFZBRXpYo', tab: 'fall-coop-tracker', write: true, at: NOW }, emailDone: ['18c2a9f00d', 'not an id!'], emailAt: NOW, junk: 1 }));
    const kept = store.projects()[0];
    check('store: cleaned (a bad message id and anything else dropped)', kept.jobSync.sheet.tab === 'fall-coop-tracker' && J(kept.jobSync.emailDone) === J(['18c2a9f00d']) && !('junk' in kept.jobSync), J(kept.jobSync));
    check('store: a sync is not an edit (updated stays)', kept.updated === before);
    check('store: a sheet id of the wrong shape is no sheet', !store.setJobSync(p.id, { sheet: { id: '../x' } }) || !store.projects()[0].jobSync?.sheet);
  }

  // ---- the runtime applies a plan and an email
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-job-sync-rt-'));
    const enc = (s) => Buffer.from(s).toString('base64');
    const dec = (s) => Buffer.from(s, 'base64').toString();
    const rt = runtime.create({ file: path.join(dir, 'automations.json'), encrypt: enc, decrypt: dec, available: () => true, now: () => NOW, saveCsv: async () => ({ ok: true }), changed: () => {} });
    const sheet = S.readSheet(coop, NOW);
    const r = rt.applySheetPlan('p1', S.plan(rt.applications('p1'), sheet, { now: NOW }));
    check('runtime: the sheet\'s rows are in the project\'s tracker', r.added === 2 && rt.applications('p1').length === 2 && rt.applications('p1').every((e) => e.projectId === 'p1'));
    const again = S.plan(rt.applications('p1'), sheet, { now: NOW });
    check('runtime: and the next sync finds them (no doubles, nothing to write)', again.add.length === 0 && again.cells.length === 0 && again.append.length === 0, J(again));
    const st = T.stats(rt.applications('p1'), NOW);
    check('runtime: the sheet\'s rows count in the stats', st.total === 2 && st.interviews === 1 && st.rejections === 1, J(st));
    const viaEmail = rt.applyEmail('p1', { id: 'abc', company: 'Tesla', stage: 'applied', at: NOW - 2 * DAY, subject: 'Thank you for applying' });
    check('runtime: an email\'s new application is logged, dated by the email', viaEmail.ok && rt.applications('p1').some((e) => e.company === 'Tesla' && e.submittedAt === NOW - 2 * DAY && e.automation === 'Gmail'));
    const gm = rt.applications('p1').find((e) => e.company === 'General Motors');
    check('runtime: an email\'s move goes to the entry it matched', rt.applyEmail('p1', { id: 'abd', key: T.entryKey(gm), stage: 'offer' }).ok && rt.applications('p1').find((e) => e.company === 'General Motors').stage === 'offer');
  }

  console.log(failures ? `\n${failures} failed` : '\nAll job sync checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
