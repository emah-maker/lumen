// [about you] What a project's chats know about the user without asking again: the project's automation profile (features/automations.js:
// name, contact, school, work authorization, availability, places, links, the base résumé and cover letter, résumé highlights and saved
// answers). One store: the profile a Job applications project already has (project.profileId), the same one Automations fill forms from,
// so "Edit profile", the project page's About you card and the AI all change the same thing. Pure (no Electron, no disk), unit-tested in
// test/units/project-about-units.js; main.js puts `block` in the project's context and runs `remember` for the applications tool.
'use strict';

const path = require('path');

// The page's groups, in order, and each field's label (the same keys as automations.js PROFILE_FIELDS).
const GROUPS = [
  { id: 'you', label: 'You', fields: [['fullName', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone']] },
  { id: 'school', label: 'School', fields: [['school', 'School'], ['degree', 'Degree'], ['major', 'Major'], ['gradDate', 'Graduation date'], ['gpa', 'GPA']] },
  { id: 'work', label: 'Work', fields: [['workAuth', 'Authorized to work here?'], ['sponsorship', 'Need visa sponsorship?'], ['startDate', 'Available from (co-op or summer dates)'], ['locations', 'Preferred locations']] },
  { id: 'links', label: 'Links', fields: [['linkedin', 'LinkedIn'], ['github', 'GitHub'], ['website', 'Website or portfolio']] },
  { id: 'address', label: 'Address', fields: [['address', 'Street address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP code'], ['country', 'Country']] },
];
const LABELS = Object.fromEntries(GROUPS.flatMap((g) => g.fields));
const KEYS = Object.keys(LABELS);
// Never saved, whoever says them: secrets and identity numbers (the user types them on the page themselves).
const SECRET = /social security|\bssn\b|pass(word|wd|code|phrase)|one.?time|\botp\b|verification code|card.?(number|num)|cvv|cvc|security code|iban|routing|account number/i;
// Questions answered only from an answer the user gave (automations.js answers them only from a saved answer): the AI saves one only as
// the user's own words, never a guess. Demographic (EEO) questions follow the profile's demographics choice.
const SENSITIVE = /gender|\bsex\b|\brace\b|ethnic|hispanic|latin[oax]|veteran|disab|sexual orientation|transgender|pronoun|date of birth|birth ?date|\bage\b|salary|compensation|pay expectation|criminal|convict/i;
const DEMOGRAPHIC = /gender|\bsex\b|\brace\b|ethnic|hispanic|latin[oax]|veteran|disab|sexual orientation|transgender|pronoun/i;
// For demographic questions: 'saved' (the user's saved answers; ask once for the rest), 'decline' (pick "Decline to self-identify" or the
// form's own "prefer not to say"), 'ask' (ask the user each time). automations.js follows the same choice.
const DEMOGRAPHICS = ['saved', 'decline', 'ask'];
const demographicsOf = (profile) => (DEMOGRAPHICS.includes(profile?.demographics) ? profile.demographics : 'saved');
const DEMOGRAPHICS_LABEL = { saved: 'use my saved answers', decline: 'choose “Decline to self-identify”', ask: 'ask me' };
const DEMOGRAPHICS_RULE = {
  saved: 'Demographic questions (gender, race or ethnicity, veteran, disability): use the saved answer for each; one with no saved answer goes in your one question. Never pick one yourself.',
  decline: 'Demographic questions (gender, race or ethnicity, veteran, disability): the user chose to decline them. Pick the form’s "Decline to self-identify" / "I don’t wish to answer" / "Prefer not to say" option without asking; a required one with no such option goes in your one question.',
  ask: 'Demographic questions (gender, race or ethnicity, veteran, disability): the user answers these themselves each time. Leave them and list them in your one question; never pick one yourself or save the answer.',
};
// The work boxes a job application asks nearly every time: named when empty, so the AI asks for them together.
const ASK_FIRST = ['workAuth', 'sponsorship', 'startDate'];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const line = (v, max) => String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v, max) => String(v ?? '').replace(CONTROL, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// The block in every chat of the project (inside the context block, so the fixed system prompt keeps its size), about `max` characters.
// tailored: the "Tailored résumés" folder (where copies go), or ''. A profile with nothing in it yet gets the short head (so new facts get saved).
function block(profile, { tailored = '', max = 3000 } = {}) {
  if (!profile) return '';
  const f = profile.fields || {};
  const facts = KEYS.filter((k) => f[k]).map((k) => `- ${LABELS[k]}: ${cut(line(f[k], 300), 200)}`);
  const files = [];
  if (profile.resumePath) files.push(`- Base résumé (never edit, rename or overwrite it): ${profile.resumePath}`);
  if (profile.resumeDrive?.id) files.push(`- Résumé in Google Drive (read it with connector drive read id ${profile.resumeDrive.id}; never change it): ${line(profile.resumeDrive.name, 120)}`);
  if (profile.coverLetterPath) files.push(`- Cover letter base (never edit it): ${profile.coverLetterPath}`);
  if (tailored && (profile.resumePath || profile.resumeDrive?.id)) files.push(`- Tailored copies go in: ${tailored} (a new file per posting; only copies are changed)`);
  const highlights = text(profile.highlights, 4000);
  const answers = (profile.answers || []).filter((a) => a?.question && a?.answer);

  const head = '<about_user>\nWhat the user told Lumen about themselves for this project. Use it instead of asking again; ask only for what is missing. When they tell you a new lasting fact about themselves (a date, a link, an answer they approved), save it with the applications tool, action remember, note "<key>: <value>" for one of the details below (keys: ' + KEYS.join(', ') + ') or "<question>? <answer>" for an answer they approved.';
  // How a job application gets filled (the fixed prompt's "stop and ask for personal info" is about what is not here).
  const rules = [
    'Filling a job application: the user saved these details to have them entered for them, so fill every question they answer (work authorization, sponsorship, start date, a saved answer to a screening question) without asking. Match a select or radio option to the saved answer ("Yes" → "Yes, I am authorized…").',
    DEMOGRAPHICS_RULE[demographicsOf(profile)],
    'Anything still missing: fill all you can first, then call ask_user once, one question per remaining item (up to 4 per card; a second card only for the rest), each with likely options from the profile and the form. With no ask_user, ask ONE short question listing every remaining item at once. Never one per turn. When the user answers, save each with remember (a question with no box: "<question>? <answer>", in their words) and fill them. Never guess or make up an answer.',
    'Never submit or send the application until the user says to.',
  ].join('\n');
  const missing = ASK_FIRST.filter((k) => !f[k]).map((k) => LABELS[k]);
  if (!facts.length && !files.length && !highlights && !answers.length) return `${head}
${rules}
Nothing is saved yet: the user can fill it in on the project page (About you).
</about_user>`; // (still said, so the AI saves what it is told)
  const parts = [head, rules];
  if (missing.length) parts.push(`Not saved yet (ask for these together when a form needs them): ${missing.join('; ')}.`);
  if (facts.length) parts.push(facts.join('\n'));
  if (files.length) parts.push(files.join('\n'));
  let used = parts.join('\n\n').length;
  if (highlights) { const h = `Résumé highlights (the user's words; never add to them):\n${cut(highlights, Math.max(200, Math.min(1500, max - used - 400)))}`; parts.push(h); used += h.length; }
  if (answers.length) {
    const rows = [];
    for (const a of answers) {
      const row = `- Q: ${cut(line(a.question, 200), 140)}\n  A: ${cut(line(a.answer, 2000), 240)}`;
      if (used + row.length > max - 40) { rows.push(`- (${answers.length - rows.length} more saved answers)`); break; }
      rows.push(row);
      used += row.length + 1;
    }
    parts.push(`Saved answers:\n${rows.join('\n')}`);
  }
  return `${parts.join('\n\n')}\n</about_user>`;
}

// [about you] Codex and Antigravity read Lumen's system prompt only on a thread's first message (codex.js / antigravity.js promptFor), so
// a profile filled in or changed since then rides on the next message instead. instructions: the chat's settings.projectInstructions;
// seen: what the thread was last given (a short hash, kept in the chat's settings); resume: a follow-up on an existing thread.
// -> { text: the block to put first ('' when the thread has it), seen }
function refreshFor(instructions, seen, resume) {
  const m = /<about_user>[\s\S]*?<\/about_user>/.exec(String(instructions || ''));
  const now = m ? require('crypto').createHash('sha256').update(m[0]).digest('hex').slice(0, 16) : '';
  return { text: resume && m && seen !== now ? `${m[0]}\n\n` : '', seen: now };
}

// The AI's save (applications tool, action remember): { field, value } for one of the profile's boxes, or { question, answer } for a saved
// answer (replacing one with the same question). -> { ok, patch, said } (patch: what to merge into the profile) | { ok: false, error }
// The tool sends one line, note: "gradDate: May 2028" (a box by its key) or "Why this company? Because…" (a question and its answer).
function parseNote(note) {
  const s = String(note ?? '').trim();
  const key = /^([A-Za-z]{2,20})\s*[:=]\s*([\s\S]+)$/.exec(s);
  if (key && KEYS.includes(key[1])) return { field: key[1], value: key[2] };
  if (key && key[1] === 'demographics') return { demographics: key[2].trim() };
  const q = /^([^?]{3,300}\?)\s*:?\s*([\s\S]+)$/.exec(s);
  if (q) return { question: q[1], answer: q[2] };
  const colon = /^([^:]{3,300}):\s+([\s\S]+)$/.exec(s);
  return colon ? { question: colon[1], answer: colon[2] } : {};
}
// Whether the user's own recent words hold the answer: a word of it (3+ letters, not a filler word), or for a bare yes or no, a yes or no.
const FILLER = new Set(['yes', 'not', 'the', 'and', 'have', 'don', 'does', 'are', 'you', 'your', 'with', 'for', 'any', 'that', 'this', 'was', 'will', 'would', 'which', 'one', 'other', 'option', 'identify', 'self']);
const wordsOf = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
function userSaid(answer, userText) {
  const said = new Set(wordsOf(userText));
  if (!said.size) return false;
  const own = wordsOf(answer).filter((w) => w.length >= 3 && !FILLER.has(w));
  if (own.length) return own.some((w) => said.has(w) || (w.length >= 4 && [...said].some((u) => u.length >= 4 && (u.startsWith(w) || w.startsWith(u))))); // ("veterans" / "veteran")
  const yes = /^(yes|y|yeah|yep)$/;
  return wordsOf(answer).some((w) => yes.test(w)) ? [...said].some((u) => yes.test(u)) : [...said].some((u) => /^(no|nope|not|never|don|didn|doesn|dont)$/.test(u));
}
// (The tool sends { field, value }: a field that is not one of the boxes is an application question, its value the answer.)
// userText: what the user wrote in the chat lately (agent.js): a sensitive question's answer is kept only when it is in the user's own words.
function remember(profile, input, { userText = input?.userText } = {}) {
  if (input?.note !== undefined && input.field === undefined && input.question === undefined && input.demographics === undefined) return remember(profile, parseNote(input.note), { userText });
  if (input?.demographics !== undefined) { // the user's choice for demographic questions ("decline those from now on")
    const d = String(input.demographics).toLowerCase().trim();
    if (!DEMOGRAPHICS.includes(d)) return { ok: false, error: `demographics is one of: ${DEMOGRAPHICS.join(', ')}.` };
    return { ok: true, patch: { demographics: d }, said: `Demographic questions: ${DEMOGRAPHICS_LABEL[d]}` };
  }
  const raw = String(input?.field ?? '').trim();
  if (raw && !KEYS.includes(raw) && input?.question === undefined && raw.length > 3 && /\s/.test(raw)) return remember(profile, { question: raw, answer: input.value }, { userText });
  const field = raw;
  if (field) {
    if (!KEYS.includes(field)) return { ok: false, error: `field is one of: ${KEYS.join(', ')}, or the application question itself (its value the answer).` };
    const value = line(input.value, 2000);
    if (!value) return { ok: false, error: 'remember needs a value for the field.' };
    const before = profile?.fields?.[field] || '';
    return { ok: true, patch: { fields: { ...(profile?.fields || {}), [field]: value } }, said: before && before !== value ? `${LABELS[field]}: ${before} → ${value}` : `${LABELS[field]}: ${value}` };
  }
  const question = line(input?.question, 300);
  const answer = text(input?.answer, 2000);
  if (!question || !answer) return { ok: false, error: 'remember takes field and value, or question and answer.' };
  if (SECRET.test(question) || SECRET.test(answer)) return { ok: false, error: 'That is a secret or an ID number: the user types it on the page themselves. Nothing was saved.' };
  if (DEMOGRAPHIC.test(question) && demographicsOf(profile) === 'ask') return { ok: false, error: 'The user answers demographic questions themselves each time (About you). Nothing was saved.' };
  if (SENSITIVE.test(question) && !userSaid(answer, userText)) return { ok: false, error: 'A sensitive answer (demographics, date of birth, salary) is saved only as the user’s own words: ask them, then save their answer as they wrote it. Nothing was saved.' }; // (never a guess; the notice shows the user what was kept)
  const norm = (q) => String(q).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const others = (profile?.answers || []).filter((a) => norm(a.question) !== norm(question));
  return { ok: true, patch: { answers: [...others, { question, answer }] }, said: `Saved answer: ${cut(question, 80)}` };
}

// A change from the project page's About you card. { fields: { key: value } } (an empty value clears it), { highlights }, { answer: { question,
// answer, was } } (was: the question it replaces), { removeAnswer: question }, { resumeDrive: { id, name } | null }. -> the patch, or null.
const DRIVE_FILE = /(?:\/d\/|[?&]id=)([A-Za-z0-9_-]{10,100})/;
const driveIdOf = (v) => (DRIVE_FILE.exec(String(v ?? '')) || /^\s*([A-Za-z0-9_-]{20,100})\s*$/.exec(String(v ?? '')) || [])[1] || '';
function pageChange(profile, change) {
  const c = change && typeof change === 'object' ? change : {};
  const out = {};
  if (c.fields && typeof c.fields === 'object') {
    const fields = { ...(profile?.fields || {}) };
    for (const [k, v] of Object.entries(c.fields)) if (KEYS.includes(k)) fields[k] = line(v, 2000);
    out.fields = fields;
  }
  if (c.highlights !== undefined) out.highlights = text(c.highlights, 4000);
  if (c.demographics !== undefined) { if (!DEMOGRAPHICS.includes(c.demographics)) return null; out.demographics = c.demographics; }
  const norm = (q) => String(q).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (c.answer && typeof c.answer === 'object') {
    const q = line(c.answer.question, 300);
    const a = text(c.answer.answer, 2000);
    if (!q || !a) return null;
    const drop = new Set([norm(q), ...(c.answer.was ? [norm(c.answer.was)] : [])]);
    const list = (profile?.answers || []).filter((x) => !drop.has(norm(x.question)));
    const at = (profile?.answers || []).findIndex((x) => drop.has(norm(x.question)));
    list.splice(at < 0 ? list.length : Math.min(at, list.length), 0, { question: q, answer: a });
    out.answers = list;
  }
  if (c.removeAnswer !== undefined) out.answers = (out.answers || profile?.answers || []).filter((x) => norm(x.question) !== norm(c.removeAnswer));
  if (c.resumeDrive !== undefined) {
    if (c.resumeDrive === null) out.resumeDrive = null;
    else { const id = driveIdOf(c.resumeDrive.id || c.resumeDrive.url); if (!id) return null; out.resumeDrive = { id, name: line(c.resumeDrive.name, 120) || 'Résumé in Drive' }; }
  }
  return Object.keys(out).length ? out : null;
}

// What the page shows: the groups with their values, the files (names only, and the full paths for the title), highlights and answers.
function view(profile) {
  const f = profile?.fields || {};
  const base = (p) => (p ? path.basename(p) : '');
  return {
    id: profile?.id || '', name: profile?.name || '',
    groups: GROUPS.map((g) => ({ id: g.id, label: g.label, fields: g.fields.map(([key, label]) => ({ key, label, value: f[key] || '' })) })),
    filled: KEYS.filter((k) => f[k]).length, total: KEYS.length,
    resume: profile?.resumePath ? { name: base(profile.resumePath), path: profile.resumePath } : null,
    cover: profile?.coverLetterPath ? { name: base(profile.coverLetterPath), path: profile.coverLetterPath } : null,
    resumeDrive: profile?.resumeDrive || null,
    highlights: profile?.highlights || '',
    demographics: demographicsOf(profile),
    answers: (profile?.answers || []).map((a) => ({ question: a.question, answer: a.answer })),
  };
}

// Whether a file the AI is about to write is one of the user's base files (the Word tool refuses those in a project with a profile).
function isBaseFile(profile, file) {
  if (!file || !profile) return false;
  const norm = (p) => path.resolve(String(p)).toLowerCase();
  return [profile.resumePath, profile.coverLetterPath].filter(Boolean).some((p) => norm(p) === norm(file));
}

// A Word tool call that would change one of the base files (by its path, or the open document's name): every action but the reading ones,
// and save_as only when it would write over a base file (saving the base as a new file is how a tailored copy starts).
const WORD_READS = new Set(['list', 'open', 'new', 'read', 'show', 'inspect', 'help']);
function touchesBase(input, base) {
  const action = String(input?.action || '');
  if (!base?.length || WORD_READS.has(action)) return false;
  const name = (p) => path.basename(String(p ?? '')).toLowerCase();
  const names = new Set(base.map(name));
  if (action === 'save_as') return Boolean(input?.path) && (isBaseFile({ resumePath: base[0], coverLetterPath: base[1] }, input.path) || names.has(name(input.path)));
  return [input?.path, input?.doc].filter(Boolean).some((p) => names.has(name(p)) || base.some((b) => isBaseFile({ resumePath: b }, p)));
}

module.exports = { GROUPS, LABELS, KEYS, DEMOGRAPHICS, SENSITIVE, DEMOGRAPHIC, SECRET, demographicsOf, userSaid, refreshFor, block, parseNote, remember, pageChange, view, isBaseFile, touchesBase, driveIdOf };
