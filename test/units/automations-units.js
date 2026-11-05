// Automations' pure part (features/automations.js), no Electron: the automation and profile models, which saved answer goes in
// which form field (and which questions are left to the user, never guessed), logins and CAPTCHAs, Submit without asking only
// in Bypass permissions, a recording turned into steps + Submit + answers, the queue (moves, one at a time, the waiting cap,
// pause, stop, finishing), the search page's links, the tracker's CSV (formula-safe), a draft from a sentence, and the store
// (encrypted when it can be, an unreadable file never overwritten, a run Lumen closed on marked stopped).
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../../src/features/automations');
const page = require('../../src/ai/automation-page');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const j = (x) => JSON.stringify(x);

// ---- the profile and the fill plan
const profile = A.normalizeProfile({
  name: 'Co-op', fields: { firstName: 'Sam', lastName: 'Lee', email: 'sam@x.edu', phone: '555-0100', linkedin: 'https://linkedin.com/in/sam', school: 'Northeastern University', workAuth: 'Yes', sponsorship: 'No', junk: 'x' },
  resumePath: path.join(os.tmpdir(), 'resume.pdf'), coverLetterTemplate: 'Dear {{company}}, the {{role}} role. {{name}} {{date}}',
  answers: [{ question: 'How did you hear about us?', answer: 'Handshake' }, { question: 'Gender', answer: 'Decline to self-identify' }, { question: 'how did you hear about us', answer: 'Career fair' }, { question: '', answer: 'x' }],
});
check('a profile keeps only its known boxes, an absolute résumé path and its answers (the same question once, the last one)', !('junk' in profile.fields) && profile.resumePath && profile.answers.length === 2 && profile.answers[0].answer === 'Career fair', j(profile));
check('a relative file path is not kept', A.normalizeProfile({ resumePath: 'resume.pdf' }).resumePath === '');

const F = (ref, label, extra = {}) => ({ ref, tag: 'input', type: 'text', label, ...extra });
const fields = [
  F('a', 'First Name *', { required: true }), F('b', 'Last name', { required: true }), F('c', 'E-mail address'), F('d', 'Your name'),
  F('e', 'LinkedIn profile URL'), F('f', 'School name'), F('g', 'Resume/CV', { type: 'file', required: true }),
  { ref: 'h', tag: 'select', label: 'Are you legally authorized to work in the United States?', required: true, options: [{ value: '', text: 'Select…', placeholder: true }, { value: '1', text: 'Yes, I am' }, { value: '0', text: 'No' }] },
  { ref: 'i', tag: 'input', type: 'radio', label: 'Will you require visa sponsorship?', required: true, options: [{ value: 'y', text: 'Yes' }, { value: 'n', text: 'No' }] },
  { ref: 'j', tag: 'textarea', label: 'Cover letter' }, F('k', 'How did you hear about this position?', { required: true }),
  { ref: 'l', tag: 'input', type: 'radio', label: 'Gender', options: [{ value: 'm', text: 'Male' }, { value: 'd', text: 'Decline to self-identify' }] },
  F('m', 'Race / ethnicity', { required: true }), F('n', 'Expected salary'), F('o', 'Password', { type: 'password', required: true }),
  F('p', 'Phone', { autocomplete: 'tel', value: '617' }), F('q', 'Portfolio', { required: false }),
  { ref: 'r', tag: 'input', type: 'checkbox', label: 'I certify this is accurate', required: true },
  F('s', 'Given', { autocomplete: 'section-a given-name' }),
];
const plan = A.planFill(fields, profile, { company: 'Acme', role: 'ME Co-op', fileFields: 1, now: new Date(2026, 10, 5) });
const by = Object.fromEntries(plan.fills.map((f) => [f.ref, f]));
check('names and email from the profile; a whole name from its parts', by.a?.value === 'Sam' && by.b?.value === 'Lee' && by.c?.value === 'sam@x.edu' && by.d?.value === 'Sam Lee', j(plan.fills));
check('"LinkedIn profile URL" is LinkedIn and "School name" a school, not a website or a name', by.e?.value === 'https://linkedin.com/in/sam' && by.f?.value === 'Northeastern University');
check('the résumé goes into the file field', by.g?.kind === 'file' && by.g.value === profile.resumePath);
check('a list picks the option that says the answer ("Yes, I am" for Yes), a radio group too ("No")', by.h?.option === '1' && by.i?.option === 'n', j([by.h, by.i]));
check('the cover letter text box gets the template with the company, role and name', /^Dear Acme, the ME Co-op role\. Sam Lee 2026-11-05$/.test(by.j?.value || ''), by.j?.value);
check('a saved answer fills a question worded a little differently', by.k?.value === 'Career fair' && by.k.source === 'answer');
check('a demographic question is answered only from an answer saved for it', by.l?.option === 'd' && !by.m, j(by.l));
check('an autocomplete token counts (section-a given-name is the first name)', by.s?.value === 'Sam');
const unknown = plan.unknown.map((u) => u.ref).sort().join('');
check('required questions with no answer go to the user: race, the certification checkbox (never ticked by a guess)', unknown === 'mr', j(plan.unknown));
const left = Object.fromEntries(plan.left.map((l) => [l.ref, l.reason]));
check('optional questions with no answer, a field the page already filled and a password are left alone', left.n === 'no-answer' && left.q === 'no-answer' && left.p === 'filled' && left.o === 'secret' && !by.o && !by.p, j(plan.left));
check('the blocker for this form is its questions', A.blockerOf({ fields }, plan) === 'questions');
check('a password field means a sign-in, a CAPTCHA wins over it, no fields is no form', A.blockerOf({ fields, password: true }) === 'login' && A.blockerOf({ fields, password: true, captcha: true }) === 'captcha' && A.blockerOf({ fields: [] }) === 'noform' && A.blockerOf({ fields: [], signIn: true }) === 'login' && A.blockerOf(null) === 'noform');
check('a saved answer that is none of the choices is the user’s pick', A.planFill([{ ref: 'z', tag: 'select', label: 'Degree', required: true, options: [{ value: 'bs', text: 'BS' }] }], A.normalizeProfile({ fields: { degree: 'PhD' } })).unknown.length === 1);
check('a file field with no matching file is a file question', A.blockerOf({ fields: [F('c', 'Cover letter', { type: 'file', required: true })] }, A.planFill([F('c', 'Cover letter', { type: 'file', required: true })], profile, { fileFields: 2 })) === 'file');
check('a checkbox answered yes is ticked', A.planFill([{ ref: 'c', tag: 'input', type: 'checkbox', label: 'I certify this is accurate' }], A.normalizeProfile({ answers: [{ question: 'I certify this is accurate', answer: 'Yes' }] })).fills[0]?.checked === true);
check('matchOption: exact, starts with, yes/no and none', A.matchOption([{ value: 'a', text: 'Massachusetts' }, { value: 'b', text: 'Maine' }], 'maine')?.value === 'b' && A.matchOption([{ value: 'x', text: 'No, I do not' }], 'n')?.value === 'x' && A.matchOption([{ value: 'x', text: 'Other' }], 'Yes') === null);
check('the review preview shows a file by its name', A.preview(plan).find((r) => r.kind === 'file')?.value === 'resume.pdf' && A.preview(plan).filter((r) => r.kind === 'missing').length === 2);

// ---- after Submit
check('outcome: a thank-you page is done, fields marked wrong are refused, nothing changed is for the user to check',
  A.outcome({ url: 'https://a.com/x', text: 'Apply' }, { url: 'https://a.com/x', text: 'Thank you for applying!' }) === 'done'
  && A.outcome({ url: 'https://a.com/x', text: '' }, { url: 'https://a.com/x', text: '', invalid: ['Email'] }) === 'rejected'
  && A.outcome({ url: 'https://a.com/x', text: '' }, { url: 'https://a.com/x', text: '', alerts: ['Phone is required'] }) === 'rejected'
  && A.outcome({ url: 'https://a.com/x', text: 'Apply' }, { url: 'https://a.com/x', text: 'Apply' }) === 'check'
  && A.outcome({ url: 'https://a.com/x', text: '' }, { url: 'https://a.com/done', text: '' }) === 'done'
  && A.outcome({ url: 'https://a.com/x', text: '' }, null) === 'check');
check('the role and company from a page title', j(A.jobOf({ title: 'Mechanical Co-op - Acme | Careers', url: 'https://jobs.acme.com/1' })) === j({ role: 'Mechanical Co-op', company: 'Acme' }) && A.jobOf({ title: 'Jobs', h1: 'Design Intern', url: 'https://boards.greenhouse.io/beta/1' }).company === 'Greenhouse');

// ---- the automation
const made = A.normalizeAutomation({ name: '  ME   co-ops ', inputs: { kind: 'urls', urls: 'https://a.com/1?utm_source=x https://a.com/1 javascript:alert(1) https://b.com/2.' }, steps: [{ type: 'click', locator: { name: 'Apply' } }, { type: 'ask_ai', prompt: 'x' }], submitMode: 'auto', schedule: { repeat: 'weekdays', time: '9:00' }, scheduleOn: true, projectId: 'p1' });
check('an automation: its name tidied, its addresses cleaned and without repeats, AI steps dropped', made.ok && made.automation.name === 'ME co-ops' && made.automation.inputs.urls.length === 2 && made.automation.steps.length === 1 && made.automation.projectId === 'p1' && made.automation.schedule.time === '09:00', j(made));
check('a schedule of a kind automations don’t take is refused', !A.normalizeAutomation({ name: 'x', schedule: { repeat: 'webhook' } }).ok && !A.normalizeAutomation({ name: '' }).ok);
check('submit without asking: only set to auto AND in Bypass permissions', A.submitsAlone(made.automation, 'bypass') && !A.submitsAlone(made.automation, 'auto') && !A.submitsAlone(made.automation, 'ask') && !A.submitsAlone({ ...made.automation, submitMode: 'review' }, 'bypass'));
const rec = A.fromRecording([
  { type: 'open_url', url: 'https://a.com/job/1', target: 'current' }, { type: 'click', locator: { name: 'Apply now', text: 'Apply now' } },
  { type: 'type', locator: { name: 'First name' }, text: 'Sam' }, { type: 'select', locator: { name: 'Country' }, option: 'United States' },
  { type: 'type', locator: { name: 'Query' }, text: '{{query}}' }, { type: 'click', locator: { name: 'Submit application', text: 'Submit application' } },
]);
check('a recording: the clicks before the form are the steps, the last Submit click is the Submit button, typed values are answers to offer', rec.steps.length === 1 && rec.steps[0].locator.name === 'Apply now' && rec.submit?.name === 'Submit application' && rec.learned.length === 2 && rec.learned[0].question === 'First name' && rec.startUrl === 'https://a.com/job/1', j(rec));

// ---- the queue
const auto = A.normalizeAutomation({ name: 'Q', inputs: { kind: 'urls', urls: ['https://a.com/1', 'https://a.com/2', 'https://a.com/3?ref=x'] } }).automation;
const items = A.itemsFor(auto, { done: new Set([A.urlKey('https://a.com/3')]) });
check('items leave out pages the tracker has as submitted (tracking parameters ignored)', items.length === 2, j(items.map((i) => i.url)));
check('…unless the automation doesn’t skip them', A.itemsFor({ ...auto, inputs: { ...auto.inputs, skipDone: false } }, { done: new Set([A.urlKey('https://a.com/3')]) }).length === 3);
const run = A.newRun(auto, A.itemsFor({ ...auto, inputs: { ...auto.inputs, skipDone: false } }), { now: 1 });
const [i1, i2, i3] = run.items;
check('the first item is next; one at a time', A.nextItem(run) === i1 && A.moveItem(run, i1.id, 'running', {}, 2) && A.nextItem(run) === null);
check('a move that isn’t one is refused (running → queued)', !A.moveItem(run, i1.id, 'queued') && i1.status === 'running');
A.moveItem(run, i1.id, 'review', {}, 3);
check('while one waits for review the run goes on with the next', A.nextItem(run) === i2);
check('pause: nothing starts; resume: it does again', A.pauseRun(run) && A.nextItem(run) === null && A.resumeRun(run) && A.nextItem(run) === i2);
const many = A.newRun(auto, Array.from({ length: 12 }, (_x, k) => ({ id: `i${k}`, url: `https://a.com/${k}`, status: k < A.LIMITS.waiting ? 'needs-you' : 'queued' })));
check(`no new item starts while ${A.LIMITS.waiting} wait for the user`, A.nextItem(many) === null);
A.moveItem(run, i1.id, 'running', {}, 4); A.moveItem(run, i1.id, 'done', { submittedAt: 4 }, 4);
check('a run is not over while items are left', !A.settle(run) && run.state === 'running');
check('stop stops everything not over and ends the run', A.stopRun(run, 9) && i2.status === 'stopped' && i3.status === 'stopped' && i1.status === 'done' && run.state === 'stopped' && !A.stopRun(run));
check('a stopped item can be tried again', A.moveItem(run, i2.id, 'queued') && i2.status === 'queued' && !i2.endedAt);
const two = A.newRun(auto, A.itemsFor(auto));
for (const i of two.items) { A.moveItem(two, i.id, 'running'); A.moveItem(two, i.id, 'skipped'); }
check('a run is finished when every item is over', A.settle(two, 5) && two.state === 'finished' && A.counts(two).skipped === 3);

// ---- a search page's links
const links = [{ href: 'https://jobs.a.com/job/1-mechanical-co-op', text: 'Mechanical Co-op' }, { href: 'https://jobs.a.com/job/2', text: 'Sales Intern' }, { href: 'https://evil.com/mech-co-op', text: 'Mechanical co-op' },
  { href: 'https://jobs.a.com/search', text: 'Mechanical co-op search' }, { href: 'https://jobs.a.com/job/1-mechanical-co-op#apply', text: 'Mechanical Co-op' }, { href: 'mailto:x@a.com', text: 'Mechanical co-op' }, { href: 'https://jobs.a.com/job/3', text: 'Thermal co-op (mechanical)' }];
check('search links: on the same site, with every word, without the page itself, repeats or done ones', j(A.pickLinks(links, { base: 'https://jobs.a.com/search', match: 'mechanical co-op' })) === j(['https://jobs.a.com/job/1-mechanical-co-op', 'https://jobs.a.com/job/3']), j(A.pickLinks(links, { base: 'https://jobs.a.com/search', match: 'mechanical co-op' })));
check('…and the limit', A.pickLinks(links, { base: 'https://jobs.a.com/search', match: 'co-op', limit: 1 }).length === 1 && A.pickLinks(links, { base: 'https://jobs.a.com/search', match: 'mechanical', done: new Set([A.urlKey('https://jobs.a.com/job/1-mechanical-co-op')]) }).length === 1);

// ---- the tracker
const entry = A.logEntry(run, { ...i1, company: '=HYPERLINK("x")', role: 'R "1"', filled: [{ label: 'Email', value: 'a@b', source: 'profile:email' }] }, auto, { now: Date.UTC(2026, 10, 5, 14, 30) });
const csv = A.toCsv([entry]);
check('CSV: a header, every value quoted, quotes doubled, a formula made plain text, CRLF rows', csv.startsWith('"Date","Automation","Company"') && csv.includes('"\'=HYPERLINK(""x"")"') && csv.includes('"R ""1"""') && csv.includes('"Email: a@b"') && csv.endsWith('\r\n') && csv.split('\r\n').length === 3, csv);
check('done keys are the submitted ones', A.doneKeys([{ url: 'https://a.com/1', status: 'done', submittedAt: 1 }, { url: 'https://a.com/2', status: 'skipped' }]).size === 1);

// ---- a draft from a sentence
const d = A.draftFromText('Apply to new mechanical co-op postings matching "mechanical co-op" on https://jobs.example.com/search?q=coop every weekday at 9am');
check('a sentence: a search with its words, its schedule, a short name', d.inputs.kind === 'search' && d.inputs.match === 'mechanical co-op' && d.schedule?.repeat === 'weekdays' && d.schedule.time === '09:00' && d.name === 'Apply to new mechanical co-op postings' && d.submitMode === 'review', j(d));
const d2 = A.draftFromText('Fill out https://a.com/1 and https://b.com/2');
check('a sentence with addresses: those pages, no schedule', d2.inputs.kind === 'urls' && d2.inputs.urls.length === 2 && !d2.schedule, j(d2));

// ---- the store
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-automations-units-'));
const file = path.join(dir, 'automations.json');
const enc = (s) => Buffer.from(s).toString('base64');
const dec = (s) => Buffer.from(s, 'base64').toString();
const store = A.createStore({ file, encrypt: enc, decrypt: dec, available: () => true });
const p = store.saveProfile({ fields: { email: 'sam@x.edu' } }).profile;
const a = store.saveAutomation({ name: 'S', profileId: p.id, inputs: { urls: ['https://a.com/1'] } }).automation;
const r = A.newRun(a, A.itemsFor(a));
store.addRun(r);
const raw = fs.readFileSync(file, 'utf8');
check('the store is encrypted on disk when it can be', /"enc"/.test(raw) && !raw.includes('sam@x.edu'));
const again = A.createStore({ file, encrypt: enc, decrypt: dec, available: () => true });
check('…and read back, a run that was going marked stopped (Lumen closed)', again.profiles()[0].fields.email === 'sam@x.edu' && again.automation(a.id)?.name === 'S' && again.runs()[0].state === 'stopped' && again.runs()[0].items[0].status === 'stopped');
check('deleting a profile clears it from its automations', again.removeProfile(p.id) && again.automation(a.id).profileId === '');
fs.writeFileSync(file, '{ broken');
const broken = A.createStore({ file });
broken.load();
check('an unreadable file is never overwritten', broken.unreadable() && !broken.write() && fs.readFileSync(file, 'utf8') === '{ broken');
const plain = A.createStore({ file: path.join(dir, 'plain.json'), available: () => false });
plain.saveProfile({ name: 'P' });
check('without a keychain the store is plain JSON', JSON.parse(fs.readFileSync(path.join(dir, 'plain.json'), 'utf8')).profiles[0].name === 'P');
fs.rmSync(dir, { recursive: true, force: true });

// ---- the page scripts are self-contained sources
for (const [name, src] of Object.entries({ scan: page.scanSource(), fill: page.fillSource([{ ref: 'f1', kind: 'text', value: '"x"' }]), find: page.findSource({ name: 'Submit' }), click: page.clickSource('f1'), check: page.checkSource(), links: page.linksSource() })) {
  let ok = true;
  try { new Function(src); } catch { ok = false; }
  check(`the ${name} page script parses`, ok);
}
check('a file field ref can’t break out of its selector', page.fileSelector('f1"] , *[x="') === '[data-lumen-auto="f1x"]');

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
