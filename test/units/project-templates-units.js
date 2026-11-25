// [project templates] features/project-templates.js: the templates (New project → Job applications), the fields a new project gets from one,
// the applications tracker cut to a project (the automations log: entries logged from a chat and the project's automations' submits), checks
// for a posting already applied to, stages moved on; the automations runtime's tracker calls against a real store in a temp folder; the chat
// store keeping a project's template and profile; and the applications tool's definition (offered only when asked for, never to MCP clients).
// Plain Node; every folder is a temp folder.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../../src/features/project-templates');
const A = require('../../src/features/automations');
const runtime = require('../../src/features/automations-runtime');
const { createChatStore } = require('../../src/features/chat-store');
const { requestFor, validateInput, EXTERNAL_TOOLS, APPLICATIONS_TOOL_DEF } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const NOW = 1_800_000_000_000;

(async () => {
  // ---- the templates
  {
    const list = T.list();
    check('Job applications is a template, listed with its name and goal line only', list.some((t) => t.id === 'job-applications' && t.name === 'Job applications' && t.description) && list.every((t) => Object.keys(t).sort().join() === 'description,id,name'), J(list));
    const tpl = T.byId('job-applications');
    check('its instructions fit a project (4,000 characters at most)', tpl.instructions.length > 200 && tpl.instructions.length <= 4000, tpl.instructions.length);
    check('its instructions keep the master résumé untouched and tailor a copy', /Never edit, rename or overwrite/.test(tpl.instructions) && /tailored COPY/.test(tpl.instructions) && /Tailored résumés/.test(tpl.instructions));
    check('its instructions stop at Submit, skip postings applied to, and log after the user submits', /Stop at the final Submit/.test(tpl.instructions) && /action "check"/.test(tpl.instructions) && /action "add"/.test(tpl.instructions));
    check('its instructions save approved long answers for reuse', /save it to memory/.test(tpl.instructions));
    check('it makes a "Tailored résumés" folder, an automation profile and a tracker', J(tpl.folders) === J(['Tailored résumés']) && tpl.profile === true && tpl.tracker === true);
    check('an unknown template is none', T.byId('nope') === null && T.fieldsFor('nope') === null && T.byId(undefined) === null);
  }

  // ---- the fields a new project gets
  {
    const empty = T.fieldsFor('job-applications', { name: '  ', instructions: '', description: '' });
    check('nothing typed: the template\'s name, goal line and instructions, and the template kept', empty.name === 'Job applications' && empty.description === T.byId('job-applications').description && empty.instructions === T.byId('job-applications').instructions && empty.template === 'job-applications', J(empty));
    const typed = T.fieldsFor('job-applications', { name: 'Summer co-op 2027', instructions: 'Only Boston.', description: 'ME co-ops' });
    check('what the user typed wins', typed.name === 'Summer co-op 2027' && typed.instructions === 'Only Boston.' && typed.description === 'ME co-ops' && typed.template === 'job-applications', J(typed));
  }

  // ---- the tracker, pure
  {
    const autos = [{ id: 'a1', projectId: 'p1' }, { id: 'a2', projectId: 'p2' }, { id: 'a3', projectId: '' }];
    const log = [
      { at: NOW - 5000, automationId: 'a1', url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x', company: 'Acme', role: 'ME co-op', status: 'done', submittedAt: NOW - 5000 },
      { at: NOW - 4000, automationId: 'a1', url: 'https://acme.com/2', company: 'Acme', role: 'Test co-op', status: 'skipped', submittedAt: 0 },
      { at: NOW - 3000, automationId: 'a2', url: 'https://other.com/1', company: 'Other', status: 'done', submittedAt: NOW - 3000 },
      { at: NOW - 2000, automationId: 'a3', url: 'https://loose.com/1', company: 'Loose', status: 'done', submittedAt: NOW - 2000 },
      { at: NOW - 1000, automationId: '', url: 'https://beta.com/9', company: 'Beta', role: 'Design co-op', status: 'done', submittedAt: NOW - 1000, projectId: 'p1', stage: 'interview' },
    ];
    const mine = T.projectEntries(log, autos, 'p1');
    check('a project\'s tracker: entries logged for it and its automations\' submits, newest first', J(mine.map((e) => e.company)) === J(['Beta', 'Acme']), J(mine.map((e) => e.company)));
    check('an automation item that was skipped, failed or stopped is not an application', !mine.some((e) => e.role === 'Test co-op'));
    check('another project\'s and a project-less automation\'s entries are left out', !mine.some((e) => ['Other', 'Loose'].includes(e.company)));
    check('stages: an automation\'s submit counts as applied; a logged entry keeps its own', mine.find((e) => e.company === 'Acme').stage === 'applied' && mine.find((e) => e.company === 'Beta').stage === 'interview');
    check('no project id: nothing', T.projectEntries(log, autos, '').length === 0 && T.projectEntries(log, autos, null).length === 0);
    check('already applied: the same posting whatever its tracking parameters', T.appliedBefore(mine, 'https://boards.greenhouse.io/acme/jobs/1?utm_source=li#apply')?.company === 'Acme');
    check('already applied: another posting, or no address, is not', T.appliedBefore(mine, 'https://boards.greenhouse.io/acme/jobs/2') === null && T.appliedBefore(mine, '') === null && T.appliedBefore(mine, 'not a url') === null);
    check('counts per stage', J(T.stageCounts(mine)) === J({ applied: 1, interview: 1, offer: 0, rejected: 0, withdrawn: 0 }));
    const text = T.describe(mine);
    check('what the AI reads: one line per application, with its stage, date and address', /^2 applications:/.test(text) && /Beta — Design co-op · interview · \d{4}-\d{2}-\d{2} · https:\/\/beta\.com\/9/.test(text), text);
    check('an empty tracker says so', /No applications/.test(T.describe([])));

    const made = T.manualEntry({ company: '  Gamma\u0007 Corp ', role: 'Co-op', url: 'https://gamma.com/jobs/4', note: 'referral' }, { projectId: 'p1', now: NOW });
    check('logged from a chat: an applied entry for the project, text cleaned', made.ok && made.entry.company === 'Gamma Corp' && made.entry.stage === 'applied' && made.entry.status === 'done' && made.entry.submittedAt === NOW && made.entry.projectId === 'p1' && made.entry.automation === 'In chat', J(made));
    check('logged from a chat: an address that is not a web page is dropped', T.manualEntry({ company: 'X', url: 'javascript:alert(1)' }, { projectId: 'p1' }).entry.url === '');
    check('logged from a chat: neither company nor address is refused', !T.manualEntry({ role: 'Co-op' }, { projectId: 'p1' }).ok);
    check('logged from a chat: an unknown stage is "applied"', T.manualEntry({ company: 'X', stage: 'hired' }, { projectId: 'p1' }).entry.stage === 'applied');

    const log2 = log.map((e) => ({ ...e }));
    const byUrl = T.updateEntry(log2, autos, 'p1', { url: 'https://boards.greenhouse.io/acme/jobs/1', stage: 'offer' });
    check('a stage moved on by the posting\'s address', byUrl?.company === 'Acme' && log2[0].stage === 'offer', J(byUrl));
    const byName = T.updateEntry(log2, autos, 'p1', { company: 'beta', stage: 'rejected', note: 'no reply' });
    check('or by company (any case), with a note', byName?.company === 'Beta' && log2[4].stage === 'rejected' && log2[4].note === 'no reply');
    check('nothing matching, another project\'s entry, or nothing to change: null', T.updateEntry(log2, autos, 'p1', { company: 'Nobody', stage: 'offer' }) === null && T.updateEntry(log2, autos, 'p1', { company: 'Other', stage: 'offer' }) === null && T.updateEntry(log2, autos, 'p1', { company: 'Acme' }) === null);
    check('an unknown stage changes nothing', T.updateEntry(log2, autos, 'p1', { company: 'Acme', stage: 'hired' }) === null && log2[0].stage === 'offer');
  }

  // ---- an automation in a project logs its submits for that project
  {
    const entry = A.logEntry({ automationId: 'a1', id: 'r1', name: 'Run' }, { url: 'https://x.com/1', status: 'done', submittedAt: NOW }, { name: 'Apply', projectId: 'p1' }, { now: NOW });
    const loose = A.logEntry({ automationId: 'a3', id: 'r2', name: 'Run' }, { url: 'https://x.com/2', status: 'done' }, { name: 'Apply', projectId: '' }, { now: NOW });
    check('an automation\'s log entry carries its project; one in no project carries none', entry.projectId === 'p1' && !('projectId' in loose), J([entry.projectId, loose]));
  }

  // ---- the runtime's tracker calls, against a real store
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-templates-units-'));
    const enc = (s) => Buffer.from(s).toString('base64');
    const dec = (s) => Buffer.from(s, 'base64').toString();
    let csv = '';
    const rt = runtime.create({ file: path.join(dir, 'automations.json'), encrypt: enc, decrypt: dec, available: () => true, now: () => NOW, saveCsv: async (text) => { csv = text; return { ok: true }; }, changed: () => {} });
    const added = rt.logApplication('p1', { company: 'Acme', role: 'ME co-op', url: 'https://acme.com/jobs/1' });
    check('runtime: an application logged for the project', added.ok && rt.applications('p1').length === 1 && rt.applications('p2').length === 0, J(added));
    const again = rt.logApplication('p1', { company: 'Acme', url: 'https://acme.com/jobs/1?utm_source=x' });
    check('runtime: the same posting twice is refused, naming the one in the tracker', !again.ok && again.already?.company === 'Acme' && rt.applications('p1').length === 1, J(again));
    const moved = rt.updateApplication('p1', { url: 'https://acme.com/jobs/1', stage: 'interview' });
    check('runtime: its stage moved on', moved.ok && rt.applications('p1')[0].stage === 'interview');
    check('runtime: a stage for nothing matching is refused', !rt.updateApplication('p1', { company: 'Nobody', stage: 'offer' }).ok);
    const reread = runtime.create({ file: path.join(dir, 'automations.json'), encrypt: enc, decrypt: dec, available: () => true, now: () => NOW, saveCsv: async () => ({ ok: true }) });
    check('runtime: kept on disk (encrypted store), stage included', reread.applications('p1')[0]?.stage === 'interview' && !fs.readFileSync(path.join(dir, 'automations.json'), 'utf8').includes('Acme'));
    await rt.exportProjectCsv('p1');
    check('runtime: Export CSV is the project\'s rows, the Status column saying where each stands', /"Acme","ME co-op","interview"/.test(csv) && csv.split('\r\n').filter(Boolean).length === 2, csv);
    const prof = rt.saveProfile({ name: 'Summer co-op 2027' });
    check('runtime: a template\'s profile is an ordinary automation profile, read back by id', prof.ok && rt.profile(prof.profile.id)?.name === 'Summer co-op 2027' && rt.profile('nope') === null);
  }

  // ---- the chat store keeps a project's template and profile
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-templates-store-'));
    const enc = (s) => Buffer.from(s).toString('base64');
    const dec = (s) => Buffer.from(s, 'base64').toString();
    const store = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => NOW });
    const p = store.saveProject({ name: 'Jobs', template: 'job-applications' });
    const withProfile = store.saveProject({ id: p.id, name: 'Jobs', profileId: 'abcdef123456' });
    check('chat store: the template and the profile are kept', p.template === 'job-applications' && withProfile.profileId === 'abcdef123456' && withProfile.template === 'job-applications', J(withProfile));
    const bad = store.saveProject({ id: p.id, name: 'Jobs', template: '../x', profileId: 'zz' });
    check('chat store: a template or profile id of the wrong shape is dropped', !('template' in bad) && !('profileId' in bad), J(bad));
    const other = store.saveProject({ name: 'Plain' });
    check('chat store: a project made without a template has none', !('template' in other) && !('profileId' in other));
  }

  // ---- the applications tool
  {
    const settings = { model: 'claude-sonnet-5-5' };
    const chat = Object.assign([{ role: 'user', content: 'hi' }], { settings });
    const off = requestFor(settings, chat);
    const on = requestFor(settings, chat, undefined, { applications: true });
    check('tool: offered only when asked for (a project made from the template)', !off.tools.some((t) => t.name === 'applications') && on.tools.some((t) => t.name === 'applications'));
    check('tool: short, and its input checked like any other', J(on.tools.find((t) => t.name === 'applications')).length < 900 && validateInput('applications', { action: 'check', url: 'https://x.com' }) === null && validateInput('applications', { action: 'delete' }) !== null && validateInput('applications', { action: 'update', stage: 'hired' }) !== null);
    check('tool: not listed to outside MCP clients', !EXTERNAL_TOOLS.some((t) => t.name === 'applications'));
    check('tool: a slim copy for the CLI engines\' own MCP session', APPLICATIONS_TOOL_DEF?.name === 'applications' && Boolean(APPLICATIONS_TOOL_DEF.input_schema));
  }

  console.log(failures ? `\n${failures} failed` : '\nAll project template checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
