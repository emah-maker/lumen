// [project templates] New project → a template: a project that starts set up for one kind of work. The pure part (no Electron),
// unit-tested in test/units/project-templates-units.js:
//   1. the templates: name, goal line, instructions, the folders made in the project's folder, and whether it gets an automation
//      profile (features/automations.js) and the applications tracker;
//   2. the fields a new project gets from one (what the user typed wins);
//   3. the applications tracker of a project: the automations log (features/automations.js) cut to the project, plus the applications
//      the AI logs from a chat (the `applications` tool, ai/agent.js), each with a stage the user or the AI moves on.
// main.js ("chats:project-save") applies a template when a project is made; the project page shows the tracker (chat-project-page.js).
const crypto = require('crypto');
const auto = require('./automations');

const JOB_INSTRUCTIONS = [
  'This project is for applying to jobs and co-ops.',
  '',
  'Résumé and cover letter',
  '- The master résumé and the cover letter base are the project\'s key documents and files. Never edit, rename or overwrite them.',
  '- For each posting, make a tailored COPY of the master résumé with the word tool: save it as a new file in the project\'s "Tailored résumés" folder, named "<Company> - <Role>.docx", then change only the copy (reorder and reword bullets toward the posting; never invent experience, skills, dates or numbers).',
  '- Upload the tailored copy, not the master.',
  '',
  'Applying',
  '- Before starting on a posting, check the applications tracker (applications tool, action "check"). If it was already applied to, skip it and say so.',
  '- Fill forms from the profile and the saved answers. Stop at the final Submit button and let the user review and submit; never press Submit yourself unless the user says to for that posting.',
  '- After the user submits, log it (applications tool, action "add": company, role, url). When the user says they heard back, update its stage (interview, offer, rejected, withdrawn).',
  '',
  'Long answers',
  '- Draft long questions ("Why this company?", "Describe a project") from the posting and the user\'s own material, show the draft, and once the user approves it, save it to memory so it can be reused and adapted next time.',
  '- Leave questions about gender, race, veteran or disability status, salary, and anything legal to the user.',
].join('\n');

const TEMPLATES = [
  {
    id: 'job-applications',
    name: 'Job applications',
    description: 'Find, tailor and track job and co-op applications',
    instructions: JOB_INSTRUCTIONS,
    folders: ['Tailored résumés'],
    profile: true, // an automation profile of its own (résumé, cover letter, major, start date, location), named for the project
    tracker: true, // the applications tool and the tracker card
    keyDocs: ['Master résumé', 'Cover letter base'], // what its page asks for first
  },
];

const byId = (id) => TEMPLATES.find((t) => t.id === String(id ?? '')) || null;
// What the New project dialog lists.
const list = () => TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));

// The fields a new project gets from a template: its goal line and instructions unless the user wrote their own, its name when the
// name box was left empty, and `template` (kept on the project: its page and its chats read it). null for no template or an unknown one.
function fieldsFor(id, typed = {}) {
  const t = byId(id);
  if (!t) return null;
  const text = (v) => String(v ?? '').trim();
  return {
    name: text(typed.name) || t.name,
    description: text(typed.description) || t.description,
    instructions: text(typed.instructions) || t.instructions,
    template: t.id,
  };
}

// ---------- the applications tracker ----------

const STAGES = ['applied', 'interview', 'offer', 'rejected', 'withdrawn'];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const line = (v, max) => String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// An entry's stage: its own, else what an automation item's status means (a submitted one was applied to).
const stageOf = (e) => (STAGES.includes(e?.stage) ? e.stage : e?.status === 'done' && e?.submittedAt ? 'applied' : '');

// The project's applications, newest first: entries logged for the project, and those of its automations (automation.projectId).
// Only applications: an automation item that was skipped, failed or stopped is not one.
function projectEntries(log, automations, projectId) {
  const pid = String(projectId ?? '');
  if (!pid) return [];
  const mine = new Set((automations || []).filter((a) => a.projectId === pid).map((a) => a.id));
  return (log || []).filter((e) => (e.projectId === pid || mine.has(e.automationId)) && stageOf(e)).map((e) => ({ ...e, stage: stageOf(e) })).sort((a, b) => (b.submittedAt || b.at || 0) - (a.submittedAt || a.at || 0));
}

// Whether a posting is in the project's tracker already (its address, whatever its tracking parameters).
function appliedBefore(entries, url) {
  const key = auto.webUrl(url) ? auto.urlKey(url) : '';
  return key ? (entries || []).find((e) => e.url && auto.urlKey(e.url) === key) || null : null;
}

// A log entry for an application the AI logged from a chat (the user submitted it). -> { ok, entry } | { ok: false, error }
function manualEntry(input, { projectId, now = Date.now() } = {}) {
  const url = auto.webUrl(input?.url) || '';
  const company = line(input?.company, 120);
  const role = line(input?.role, 160);
  if (!company && !url) return { ok: false, error: 'Give the company or the posting\'s address.' };
  const stage = STAGES.includes(input?.stage) ? input.stage : 'applied';
  return {
    ok: true,
    entry: { at: now, automationId: '', automation: 'In chat', runId: '', url, company, role, status: 'done', need: '', submittedAt: now, note: line(input?.note, 300), filled: [], projectId: String(projectId ?? ''), stage, id: crypto.randomBytes(6).toString('hex') },
  };
}

// Moves an application of the project on (by its address, or company and role). Changes the entry in place. -> the entry, or null
function updateEntry(log, automations, projectId, input) {
  const stage = STAGES.includes(input?.stage) ? input.stage : '';
  const note = input?.note === undefined ? undefined : line(input.note, 300);
  if (!stage && note === undefined) return null;
  const pid = String(projectId ?? '');
  const mine = new Set((automations || []).filter((a) => a.projectId === pid).map((a) => a.id));
  const ours = (log || []).filter((e) => (e.projectId === pid || mine.has(e.automationId)) && stageOf(e));
  let hit = input?.url ? appliedBefore(ours, input.url) : null;
  if (!hit && input?.company) {
    const c = line(input.company, 120).toLowerCase();
    const r = line(input.role, 160).toLowerCase();
    const matches = ours.filter((e) => String(e.company).toLowerCase() === c && (!r || String(e.role).toLowerCase() === r));
    hit = matches[matches.length - 1] || null; // (the newest)
  }
  if (!hit) return null;
  if (stage) hit.stage = stage;
  if (note !== undefined) hit.note = note;
  hit.updatedAt = Date.now();
  return hit;
}

// What the AI gets back from the tool: one line per application, newest first.
function describe(entries, max = 40) {
  if (!entries.length) return 'No applications logged in this project yet.';
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  const rows = entries.slice(0, max).map((e) => `- ${[e.company || '(company?)', e.role].filter(Boolean).join(' — ')} · ${e.stage} · ${day(e.submittedAt || e.at)}${e.url ? ` · ${e.url}` : ''}${e.note ? ` · ${e.note}` : ''}`);
  return `${entries.length} application${entries.length === 1 ? '' : 's'}${entries.length > max ? ` (newest ${max})` : ''}:\n${rows.join('\n')}`;
}

// A count per stage, for the project page's card.
function stageCounts(entries) {
  const out = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const e of entries || []) if (out[e.stage] !== undefined) out[e.stage]++;
  return out;
}

module.exports = { TEMPLATES, STAGES, list, byId, fieldsFor, stageOf, projectEntries, appliedBefore, manualEntry, updateEntry, describe, stageCounts };
