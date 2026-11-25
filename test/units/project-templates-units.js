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
    check('counts per stage', J(T.stageCounts(mine)) === J({ saved: 0, applied: 1, interview: 1, offer: 0, rejected: 0, withdrawn: 0 }));
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

  // ---- the project type: an existing project switched to Job applications and back
  {
    const tpl = T.byId('job-applications');
    check('type: Standard and Job applications are offered', J(T.types().map((t) => t.id)) === J(['', 'job-applications']));
    const empty = T.typeChange({ instructions: '' }, 'job-applications');
    check('type: a project with no instructions gets the template\'s', empty.template === 'job-applications' && empty.instructions === tpl.instructions && empty.added === true, J(empty));
    const own = T.typeChange({ instructions: 'Answer briefly.' }, 'job-applications');
    check('type: its own instructions stay first, the template\'s go after them', own.instructions === `Answer briefly.\n\n${tpl.instructions}` && own.added, J(own).slice(0, 200));
    const back = T.typeChange({ template: 'job-applications', instructions: own.instructions }, '');
    check('type: back to Standard takes them out again, leaving the project\'s own', back.template === '' && back.instructions === 'Answer briefly.', J(back).slice(0, 200));
    check('type: back from one made from the template empties them (they were all the template\'s)', T.typeChange({ template: 'job-applications', instructions: tpl.instructions }, '').instructions === '');
    const edited = `${own.instructions} Also: Boston only.`;
    check('type: instructions the user edited since stay as they are', T.typeChange({ template: 'job-applications', instructions: edited }, '').instructions === edited);
    check('type: the same type, or an unknown one, is no change', T.typeChange({ template: 'job-applications' }, 'job-applications') === null && T.typeChange({}, '') === null && T.typeChange({}, 'nope') === null);
    const long = 'x'.repeat(3500);
    const tooLong = T.typeChange({ instructions: long }, 'job-applications');
    check('type: when they would not fit (4,000 characters), the project\'s stay untouched and it says so', tooLong.template === 'job-applications' && tooLong.instructions === long && tooLong.added === false);
    check('type: switching twice adds them once', T.withInstructions(own.instructions, tpl) === own.instructions);
    // in the chat store: the type set and cleared, nothing else touched
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-templates-type-'));
    const enc = (s) => Buffer.from(s).toString('base64');
    const dec = (s) => Buffer.from(s, 'base64').toString();
    const store = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => NOW });
    const p = store.saveProject({ name: 'Co-op search', description: 'Fall 2027', instructions: 'Answer briefly.', links: [{ url: 'https://example.com/a', title: 'A' }] });
    const c1 = T.typeChange(p, 'job-applications');
    const on = store.saveProject({ id: p.id, name: p.name, ...c1, profileId: 'abcdef123456' });
    check('type in the store: switched on, the goal line and pages kept', on.template === 'job-applications' && on.description === 'Fall 2027' && J(on.links) === J(p.links) && on.instructions.startsWith('Answer briefly.'), J(on).slice(0, 300));
    const off = store.saveProject({ id: p.id, name: p.name, ...T.typeChange(on, '') });
    check('type in the store: switched back, the template gone and the profile kept for next time', !('template' in off) && off.profileId === 'abcdef123456' && off.instructions === 'Answer briefly.', J(off).slice(0, 300));
  }

  // ---- the dashboard's numbers
  {
    const D = T.DAY;
    const at = (days) => NOW - days * D;
    const entries = [
      { id: 'a', company: 'Acme', role: 'ME co-op', stage: 'applied', submittedAt: at(2) },
      { id: 'b', company: 'Beta', role: 'Design', stage: 'interview', submittedAt: at(20), respondedAt: at(14), history: [{ stage: 'applied', at: at(20) }, { stage: 'interview', at: at(14) }] },
      { id: 'c', company: 'Cora', role: 'Test', stage: 'offer', submittedAt: at(40), respondedAt: at(30), history: [{ stage: 'applied', at: at(40) }, { stage: 'interview', at: at(30) }, { stage: 'offer', at: at(25) }] },
      { id: 'd', company: 'Dyno', role: 'Ops', stage: 'rejected', submittedAt: at(10), respondedAt: at(5) },
      { id: 'e', company: 'Echo', role: 'R&D', stage: 'applied', submittedAt: at(16) },
      { id: 'f', company: 'Flux', role: 'Later', stage: 'saved', submittedAt: 0, at: at(1) },
      { id: 'g', company: 'Gale', role: 'Old', stage: 'withdrawn', submittedAt: at(50), history: [{ stage: 'applied', at: at(50) }, { stage: 'interview', at: at(45) }, { stage: 'withdrawn', at: at(44) }], respondedAt: at(45) },
    ];
    const st = T.stats(entries, NOW);
    check('stats: applied this week and this month (a saved posting is not an application)', st.week === 1 && st.month === 4, J(st));
    check('stats: the total and the saved ones apart', st.total === 6 && st.saved === 1, J(st));
    check('stats: response rate = heard back / applied (4 of 6: an interview, an offer, a rejection, an interview withdrawn from)', st.responseRate === 67, J(st));
    check('stats: interviews count every one that reached an interview or an offer, offers and rejections by stage', st.interviews === 3 && st.offers === 1 && st.rejections === 1, J(st));
    check('stats: average days to a first answer (6, 10, 5 and 5)', st.avgDays === 6.5, J(st));
    check('stats: the last 8 weeks, oldest first, this week last', st.weeks.length === 8 && st.weeks[7] === 1 && st.weeks.reduce((a, b) => a + b, 0) === 6, J(st.weeks));
    const none = T.stats([], NOW);
    check('stats: nothing to work from is no number, not 0% or NaN', none.total === 0 && none.responseRate === null && none.avgDays === null && none.weeks.every((n) => n === 0), J(none));
    const due = T.followUps(entries, NOW);
    check('follow-ups: applied 14+ days ago with no answer, the longest waiting first', J(due.map((e) => e.id)) === J(['e']) && due[0].waited === 16, J(due));
    check('follow-ups: the wait is a setting', J(T.followUps(entries, NOW, 1).map((e) => e.id)) === J(['e', 'a']));
    const tl = T.timeline(entries);
    check('timeline: every move, newest first', tl[0].company === 'Flux' && tl[0].stage === 'saved' && tl.filter((x) => x.company === 'Cora').length === 3 && tl.every((x, i) => !i || tl[i - 1].at >= x.at), J(tl.slice(0, 3)));
    check('timeline: an entry with no history counts its applying and where it is now', J(tl.filter((x) => x.company === 'Dyno').map((x) => x.stage).sort()) === J(['applied', 'rejected']));
  }

  // ---- stages, saved postings, and the tailored résumé a row used
  {
    const e = T.manualEntry({ company: 'Acme', role: 'ME co-op', url: 'https://acme.com/1', stage: 'saved' }, { projectId: 'p1', now: NOW }).entry;
    check('saved: a posting kept for later has no applied date', e.stage === 'saved' && e.submittedAt === 0 && e.history.length === 1);
    T.setStage(e, 'applied', NOW + 1000);
    check('saved → applied: applied now', e.stage === 'applied' && e.submittedAt === NOW + 1000 && !e.respondedAt);
    T.setStage(e, 'interview', NOW + 5 * T.DAY);
    T.setStage(e, 'rejected', NOW + 9 * T.DAY);
    check('the first answer is kept (an interview), not the later rejection', e.respondedAt === NOW + 5 * T.DAY && J(e.history.map((h) => h.stage)) === J(['saved', 'applied', 'interview', 'rejected']));
    check('an unknown stage changes nothing', T.setStage(e, 'hired', NOW).stage === 'rejected');
    const files = ['Acme - ME co-op.docx', 'Acme - Test engineer.docx', 'Acmeco - ME co-op.docx', 'Beta - Design.pdf'];
    check('résumé: the copy named "<Company> - <Role>" is found', T.resumeFor({ company: 'Acme', role: 'Test engineer' }, files) === 'Acme - Test engineer.docx');
    check('résumé: by the company alone when the role is not in a name; never a company that only starts the same', T.resumeFor({ company: 'Acme', role: 'Intern' }, files) === 'Acme - ME co-op.docx' && T.resumeFor({ company: 'Acm' }, files) === '');
    check('résumé: the one a row names wins when it is there', T.resumeFor({ company: 'Acme', resume: 'Beta - Design.pdf' }, files) === 'Beta - Design.pdf' && T.resumeFor({ company: 'Zed' }, files) === '');
    check('résumé: a name only, never a path, and only documents', T.resumeName('C:\\x\\..\\Acme - A.docx') === 'Acme - A.docx' && T.resumeName('evil.exe') === '' && T.resumeName('../.docx') === '');
  }

  // ---- the dashboard's moves, against a real store
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-templates-moves-'));
    const enc = (s) => Buffer.from(s).toString('base64');
    const dec = (s) => Buffer.from(s, 'base64').toString();
    let clock = NOW;
    const rt = runtime.create({ file: path.join(dir, 'automations.json'), encrypt: enc, decrypt: dec, available: () => true, now: () => clock, saveCsv: async () => ({ ok: true }), changed: () => {} });
    const saved = rt.logApplication('p1', { company: 'Acme', role: 'ME co-op', url: 'https://acme.com/jobs/9', stage: 'saved', from: 'page' });
    check('moves: a posting saved from the page', saved.ok && rt.applications('p1')[0].stage === 'saved' && saved.entry.automation === 'Added by you');
    clock += 1000;
    const applied = rt.logApplication('p1', { company: 'Acme', url: 'https://acme.com/jobs/9', resume: 'Acme - ME co-op.docx' });
    check('moves: logging it after submitting moves the saved one on, not a second row', applied.ok && rt.applications('p1').length === 1 && rt.applications('p1')[0].stage === 'applied' && rt.applications('p1')[0].resume === 'Acme - ME co-op.docx', J(rt.applications('p1')));
    const key = T.entryKey(rt.applications('p1')[0]);
    clock += 3 * T.DAY;
    check('moves: dragged to Interview', rt.moveApplication('p1', key, 'interview').ok && rt.applications('p1')[0].stage === 'interview' && rt.applications('p1')[0].respondedAt === clock);
    check('moves: not another project\'s, not an unknown stage', !rt.moveApplication('p2', key, 'offer').ok && !rt.moveApplication('p1', key, 'hired').ok && !rt.moveApplication('p1', 'nope', 'offer').ok);
    const reread = runtime.create({ file: path.join(dir, 'automations.json'), encrypt: enc, decrypt: dec, available: () => true, now: () => clock, saveCsv: async () => ({ ok: true }) });
    check('moves: kept on disk, with the history the timeline shows', J(reread.applications('p1')[0].history.map((h) => h.stage)) === J(['saved', 'applied', 'interview']));
  }

  // ---- the wiring: the dashboard loads on demand, the type is a project setting, the job look
  {
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    const page = src('src/renderer/chat-project-page.js');
    check('wiring: the dashboard is loaded only when shown, marked data-later', /chat-job-board\.js/.test(page) && /dataset\.later = ''/.test(page) && !/chat-job-board/.test(src('src/renderer/chat-page.html')));
    check('wiring: a job project opens on its Applications view, and Settings has the Type', /\['jobs', tr\('projecttpl\.view\.jobs'/.test(page) && /typeLine\(p, line\)/.test(page));
    const main = src('src/main.js');
    check('wiring: main saves a type change through chats:project-save, the dashboard\'s moves through its own channel', /project\?\.type !== undefined/.test(main) && /action === 'stage'/.test(main) && /action === 'resume'/.test(main));
    check('wiring: the rail and All projects mark a job project', /p\.template === 'job-applications'/.test(src('src/renderer/chat-projects.js')) && /p\.template === 'job-applications'/.test(src('src/renderer/chat-projects-all.js')));
    const en = require('../../src/locales/en.json');
    const board = src('src/renderer/chat-job-board.js');
    const keys = [...board.matchAll(/\btr\('((?:jobs|projecttpl)\.[^']+)'/g)].map((m) => m[1]);
    check('wiring: every string of the dashboard is in en.json', keys.length > 30 && keys.every((k) => k in en), keys.filter((k) => !(k in en)).join(', '));
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
