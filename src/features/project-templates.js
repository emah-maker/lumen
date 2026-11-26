// [project templates] New project → a template: a project that starts set up for one kind of work. The pure part (no Electron),
// unit-tested in test/units/project-templates-units.js:
//   1. the templates: name, goal line, instructions, the folders made in the project's folder, and whether it gets an automation
//      profile (features/automations.js) and the applications tracker;
//   2. the fields a new project gets from one (what the user typed wins);
//   3. the applications tracker of a project: the automations log (features/automations.js) cut to the project, plus the applications
//      the AI logs from a chat (the `applications` tool, ai/agent.js), each with a stage the user or the AI moves on.
//   4. the project type: an existing project switched to a template's type (its instructions added, kept apart from the user's own so
//      switching back takes them out again) and back to a standard one (the tracker and profile stay, only hidden);
//   5. the dashboard's numbers: applied this week and month, response rate, interviews, offers, days to a response, follow-ups due, the
//      timeline, and which tailored résumé a row used.
// main.js ("chats:project-save") applies a template when a project is made or its type is changed; the project page shows the dashboard
// (chat-job-board.js, loaded when a job project is opened).
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
    tools: { apps: ['gmail', 'sheets', 'drive', 'docs', 'calendar'] },
    icon: 'briefcase',
    starters: ['Tailor my résumé for this posting', 'Find co-op postings that fit my profile', 'Draft a follow-up for an application with no answer'], // [project tools] what its chats get (features/project-tools.js): the tracker sheet, application emails, the résumé files, interviews
  },
  // [project tools] Templates that are mostly a set of tools: instructions, and the apps their chats get. Nothing else is made for them.
  {
    id: 'coursework',
    name: 'Coursework',
    description: 'Classes, assignments and deadlines',
    instructions: [
      'This project is for my classes.',
      '- Check Canvas for the assignment, its rubric and its due date before working on one, and name the course.',
      '- Put deadlines on my calendar or task list only when I ask, and say what you added.',
      '- Help me understand and plan; when I ask for a draft, keep my own voice and say what you changed.',
    ].join('\n'),
    folders: [],
    tools: { apps: ['canvas', 'calendar', 'gtasks', 'drive', 'docs'] },
    icon: 'book',
    starters: ['What is due this week?', 'Plan my study time for the next exam', 'Explain this assignment’s rubric to me'],
  },
  {
    id: 'coding',
    name: 'Code project',
    description: 'A repository, its issues and pull requests',
    instructions: [
      'This project is for a software repository.',
      '- Read the code and the issue before changing anything, and keep to the style already there.',
      '- Say which files you changed and how you checked the change.',
      '- Ask before pushing, opening a pull request or commenting on GitHub.',
    ].join('\n'),
    folders: [],
    tools: { apps: ['github'], plan: true },
    icon: 'code',
    starters: ['Summarize the open issues', 'Review my latest pull request', 'Explain how this repository is laid out'],
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Papers, notes and a draft',
    instructions: [
      'This project is for research on one topic.',
      '- Cite every claim with its source (my Zotero library, the project\'s files, or the page), and say when a source is weak.',
      '- Keep a running list of open questions and decisions in my notes when I ask.',
      '- Never invent a reference, a quote or a number.',
    ].join('\n'),
    folders: [],
    tools: { apps: ['zotero', 'drive', 'docs', 'notion'] },
    icon: 'flask',
    starters: ['Find recent papers on my topic', 'Summarize my sources and where they disagree', 'Outline a literature review from my notes'],
  },
];

const byId = (id) => TEMPLATES.find((t) => t.id === String(id ?? '')) || null;
// What the New project dialog lists.
const list = () => TEMPLATES.map(({ id, name, description, tools, icon, starters }) => ({ id, name, description, apps: tools?.apps || [], icon, starters: [...starters] })); // (apps: [project tools] what its chats get, shown on its button; icon and starters: [project presets] its mark and the first questions its page offers)

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

// ---------- the project type ----------

// What a project's Type setting offers: Standard (no template) and each template.
const types = () => [{ id: '', name: 'Standard', description: 'A project of your own' }, ...list()];
const SEP = '\n\n';
// The template's instructions added to what the project has: in place of empty ones, else after them. Already there: unchanged.
function withInstructions(existing, t) {
  const have = String(existing ?? '').replace(/\s+$/, '');
  if (!t?.instructions) return have;
  if (!have.trim()) return t.instructions;
  return have.includes(t.instructions) ? have : `${have}${SEP}${t.instructions}`;
}
// And taken out again (switching back): only when they are there as they were added. Edited by the user since, they stay.
function withoutInstructions(existing, t) {
  const have = String(existing ?? '');
  if (!t?.instructions) return have;
  if (have.trim() === t.instructions) return '';
  if (have.endsWith(`${SEP}${t.instructions}`)) return have.slice(0, -(SEP.length + t.instructions.length));
  return have;
}
// The fields a project's type change saves: { template, instructions, added }, or null when it is the type it has already (or an unknown
// type). Nothing else of the project is touched: its files, memory, chats, folder, profile and tracker stay as they are. `added`: the
// template's instructions are in them now (false when they would not fit after the project's own: the store keeps `max` characters).
function typeChange(project, type, { max = 4000 } = {}) {
  const to = type ? byId(type) : null;
  if (type && !to) return null;
  const from = project?.template ? byId(project.template) : null;
  if ((to?.id || '') === (project?.template || '')) return null;
  let instructions = String(project?.instructions ?? '');
  if (from) instructions = withoutInstructions(instructions, from);
  let added = false;
  if (to) {
    const next = withInstructions(instructions, to);
    if (next.length <= max) instructions = next;
    added = instructions.includes(to.instructions);
  }
  return { template: to ? to.id : '', instructions, added };
}

// ---------- the applications tracker ----------

// saved: a posting kept for later, not applied to yet. The board's columns are Saved, Applied, Interview, Offer and Closed (rejected and withdrawn).
const STAGES = ['saved', 'applied', 'interview', 'offer', 'rejected', 'withdrawn'];
const RESPONSES = new Set(['interview', 'offer', 'rejected']); // what counts as hearing back
const DAY = 86400000;
// An entry's own key, for the dashboard's moves (a logged one has an id; an automation's is its run, time and address).
const entryKey = (e) => String(e?.id || `${e?.runId || ''}:${e?.at || 0}:${e?.url || ''}`);
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
  const resume = resumeName(input?.resume);
  return {
    ok: true,
    entry: { at: now, automationId: '', automation: ({ page: 'Added by you', sheet: 'Google Sheet', email: 'Gmail', search: 'Job search' })[input?.from] || 'In chat', runId: '', url, company, role, status: 'done', need: '', submittedAt: stage === 'saved' ? 0 : now, note: line(input?.note, 300), filled: [], projectId: String(projectId ?? ''), stage, id: crypto.randomBytes(6).toString('hex'), history: [{ stage, at: now }], ...(RESPONSES.has(stage) ? { respondedAt: now } : {}), ...(resume ? { resume } : {}) },
  };
}
// A tailored résumé's file name (no folder: the copies are in the project's "Tailored résumés" folder), or ''.
function resumeName(v) {
  const name = String(v ?? '').split(/[\\/]/).pop().replace(CONTROL, '').trim().slice(0, 200);
  return /\.(docx|pdf|doc|odt|rtf|txt|md)$/i.test(name) && !name.startsWith('.') ? name : '';
}

// Moves an entry to a stage (in place) and keeps what the numbers need: when it was applied to (a saved one moved on), when the
// company first answered, and the history the timeline shows. -> the entry
function setStage(entry, stage, now = Date.now()) {
  if (!entry || !STAGES.includes(stage) || stage === entry.stage) return entry;
  if (!Array.isArray(entry.history)) entry.history = entry.stage && (entry.submittedAt || entry.at) ? [{ stage: entry.stage, at: entry.submittedAt || entry.at }] : [];
  if (stage !== 'saved' && !entry.submittedAt) entry.submittedAt = now;
  if (stage === 'saved') entry.submittedAt = 0;
  if (RESPONSES.has(stage) && !entry.respondedAt && entry.submittedAt) entry.respondedAt = now;
  entry.stage = stage;
  entry.history.push({ stage, at: now });
  entry.history = entry.history.slice(-30);
  entry.updatedAt = now;
  return entry;
}

// Moves an application of the project on (by its address, or company and role). Changes the entry in place. -> the entry, or null
function updateEntry(log, automations, projectId, input, now = Date.now()) {
  const stage = STAGES.includes(input?.stage) ? input.stage : '';
  const note = input?.note === undefined ? undefined : line(input.note, 300);
  const resume = resumeName(input?.resume);
  if (!stage && note === undefined && !resume) return null;
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
  if (!STAGES.includes(hit.stage)) hit.stage = stageOf(hit); // (an automation's entry gets a stage of its own the first time it moves)
  if (stage) setStage(hit, stage, now);
  if (note !== undefined) { hit.note = note; hit.updatedAt = now; }
  if (resume) hit.resume = resume;
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

// ---------- the dashboard's numbers ----------

const round1 = (n) => Math.round(n * 10) / 10;
// The stat tiles: applied this week (7 days) and month (30), the total, the response rate (heard back / applied, in %), interviews (an
// interview or an offer reached), offers, rejections, the average days to a first answer, and the last 8 weeks' applications (oldest
// first) for the small bar chart. A saved posting is not an application. null where there is nothing to work it out from.
function stats(entries, now = Date.now()) {
  const all = entries || [];
  const applied = all.filter((e) => e.stage !== 'saved' && e.submittedAt);
  const reached = (e, ...st) => st.includes(e.stage) || (Array.isArray(e.history) && e.history.some((h) => st.includes(h.stage)));
  const heard = applied.filter((e) => e.respondedAt || RESPONSES.has(e.stage));
  const waits = applied.filter((e) => e.respondedAt && e.respondedAt >= e.submittedAt).map((e) => (e.respondedAt - e.submittedAt) / DAY);
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const end = now - (7 - i) * 7 * DAY;
    return applied.filter((e) => e.submittedAt > end - 7 * DAY && e.submittedAt <= end).length;
  });
  return {
    week: applied.filter((e) => e.submittedAt > now - 7 * DAY).length,
    month: applied.filter((e) => e.submittedAt > now - 30 * DAY).length,
    total: applied.length,
    saved: all.filter((e) => e.stage === 'saved').length,
    responseRate: applied.length ? Math.round((heard.length / applied.length) * 100) : null,
    interviews: applied.filter((e) => reached(e, 'interview', 'offer')).length,
    offers: applied.filter((e) => reached(e, 'offer')).length,
    rejections: applied.filter((e) => e.stage === 'rejected').length,
    avgDays: waits.length ? round1(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    weeks,
  };
}

// Follow-ups due: applied (no answer yet) at least `days` days ago, the longest waiting first, with how many days it has been.
function followUps(entries, now = Date.now(), days = 14) {
  return (entries || []).filter((e) => e.stage === 'applied' && e.submittedAt && !e.respondedAt && now - e.submittedAt >= days * DAY)
    .map((e) => ({ ...e, waited: Math.floor((now - e.submittedAt) / DAY) })).sort((a, b) => a.submittedAt - b.submittedAt);
}

// The activity timeline: every move of every application (an entry from before the history was kept counts its applying and where it
// is now), newest first.
function timeline(entries, max = 80) {
  const out = [];
  for (const e of entries || []) {
    const hist = Array.isArray(e.history) && e.history.length ? e.history : [...(e.submittedAt ? [{ stage: 'applied', at: e.submittedAt }] : []), ...(e.stage !== 'applied' ? [{ stage: e.stage, at: e.updatedAt || e.respondedAt || e.at }] : [])];
    for (const h of hist) if (h?.at && STAGES.includes(h.stage)) out.push({ at: h.at, stage: h.stage, company: e.company, role: e.role, url: e.url, key: entryKey(e) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

// Which tailored résumé a row used: the one it names when that file is there, else the copy named the way the instructions say
// ("<Company> - <Role>.docx"), the one with the role in its name first. `names`: the files in the "Tailored résumés" folder. -> a name or ''
function resumeFor(entry, names) {
  const files = (names || []).map(String);
  if (entry?.resume && files.includes(entry.resume)) return entry.resume;
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const company = norm(entry?.company);
  if (!company) return '';
  const role = norm(entry?.role);
  const mine = files.filter((n) => `${norm(n.replace(/\.[^.]+$/, ''))} `.startsWith(`${company} `));
  return (role && mine.find((n) => norm(n).includes(role))) || mine[0] || '';
}

module.exports = { TEMPLATES, STAGES, DAY, list, byId, fieldsFor, types, typeChange, withInstructions, withoutInstructions, entryKey, stageOf, setStage, projectEntries, appliedBefore, manualEntry, resumeName, updateEntry, describe, stageCounts, stats, followUps, timeline, resumeFor };
