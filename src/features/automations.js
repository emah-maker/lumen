// Automations: a repeating browser job run on a list of pages, one tab per page ("apply to these co-op postings").
// This file is the pure part (no Electron), unit-tested in test/units/automations-units.js:
//   1. the automation: what it runs on (a list of addresses, or a search page and the words a link must have), the steps that
//      reach the form (a recording or a draft, as macro steps), the Submit button, the profile, the schedule, a project;
//   2. the profile: the user's own answers (name, email, résumé file, cover-letter template, common questions), kept locally;
//   3. filling a form: which saved answer goes in which field, and which questions have no answer (handed to the user, never
//      guessed). Logins and CAPTCHAs are found here too;
//   4. a run: its queue of items, each one queued, running, waiting for review, needing the user, done, failed, skipped or
//      stopped; pause and stop;
//   5. the tracker: what was filled and submitted, exported as CSV;
//   6. the store (<userData>/automations.json, encrypted with the OS keychain when it can be).
// The runner (features/automations-runtime.js) opens the tabs and runs the page scripts (ai/automation-page.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const macros = require('./macros');
const routines = require('./routines');
const { readStoreFile } = require('../settings/settings-file'); // (a file that can't be read is kept aside, never overwritten)

const FORMAT = 'lumen-automations';
const LIMITS = { automations: 50, profiles: 10, urls: 200, items: 200, answers: 150, runs: 20, log: 2000, text: 4000, template: 20000, field: 300, value: 2000, waiting: 10, searchLimit: 50 };
const ITEM_STATES = ['queued', 'running', 'review', 'needs-you', 'done', 'failed', 'skipped', 'stopped'];
const FINAL = new Set(['done', 'failed', 'skipped', 'stopped']);
const WAITING = new Set(['review', 'needs-you']);
// Which item state may follow which. A waiting item goes on (running) when the user approves or says Continue.
const MOVES = {
  queued: ['running', 'skipped', 'stopped'],
  running: ['review', 'needs-you', 'done', 'failed', 'skipped', 'stopped'],
  review: ['running', 'needs-you', 'skipped', 'stopped', 'done'],
  'needs-you': ['running', 'skipped', 'stopped', 'failed'],
  done: [],
  failed: ['queued'],
  skipped: ['queued'],
  stopped: ['queued'],
};
// Why an item needs the user: a sign-in, a CAPTCHA, questions with no saved answer, a file to choose, no form or no Submit
// button found, the site refusing what was sent, a step of the recording that failed, or a result Lumen couldn't read.
const NEEDS = ['login', 'captcha', 'questions', 'file', 'noform', 'nosubmit', 'rejected', 'step', 'check'];

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
const oneLine = (text, max) => clean(text).replace(/\s+/g, ' ').trim().slice(0, max);
const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const newId = () => crypto.randomBytes(6).toString('hex');
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function webUrl(text) {
  try {
    const u = new URL(String(text ?? '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href.slice(0, 2000) : null;
  } catch { return null; }
}
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
// The same posting whatever its tracking parameters and fragment: what "already done" compares.
function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|refid$|trk|src$|source$|gh_src$|lever-source)/i.test(k)) u.searchParams.delete(k);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch { return String(url || ''); }
}
// Addresses in free text (one per line, or anywhere in a sentence), cleaned, in order, without repeats.
function urlsIn(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const url = webUrl(m[0].replace(/[.,;:!?]+$/, ''));
    if (url && !seen.has(urlKey(url))) { seen.add(urlKey(url)); out.push(url); }
  }
  return out;
}

// ---------- 1. the automation ----------

// What a run works on: a list of addresses, or a search page whose links are followed (the ones whose text or address has the
// words in `match`, up to `limit` new ones a run).
function normalizeInputs(raw) {
  const r = isObject(raw) ? raw : {};
  const kind = r.kind === 'search' ? 'search' : 'urls';
  const urls = (Array.isArray(r.urls) ? r.urls : urlsIn(r.urls)).map(webUrl).filter(Boolean);
  const unique = [...new Map(urls.map((u) => [urlKey(u), u])).values()].slice(0, LIMITS.urls);
  return {
    kind,
    urls: unique,
    searchUrl: webUrl(r.searchUrl) || '',
    match: oneLine(r.match, 200),
    limit: Math.max(1, Math.min(LIMITS.searchLimit, Math.round(num(r.limit, 10)) || 10)),
    skipDone: r.skipDone !== false, // a posting already done (the tracker has it) is not done again
  };
}

// Steps that reach the form, as macro steps (macros.js checks them: a macro is data, never code). The fill and the Submit are
// the runner's own, so a recording's typing and its last Submit click are taken out (fromRecording).
function normalizeSteps(raw) {
  const steps = Array.isArray(raw) ? raw : [];
  if (!steps.length) return { ok: true, steps: [] };
  const r = macros.normalizeMacro({ name: 'automation', steps }, { strict: false });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, steps: r.macro.steps.filter((s) => s.type !== 'ask_ai' && s.type !== 'tab' && s.type !== 'action') };
}

function normalizeSchedule(raw, now = Date.now()) {
  if (!isObject(raw) || !raw.repeat) return null;
  if (routines.EVENT_REPEATS.includes(raw.repeat) || raw.repeat === 'once' || raw.repeat === 'cron') throw Object.assign(new Error('Pick every day, every weekday, some days of the week, or every few hours.'), { key: 'automations.error.repeat' });
  return routines.normalizeRoutineSchedule(raw, now);
}

// -> { ok, automation } | { ok: false, error }
function normalizeAutomation(input, { now = Date.now() } = {}) {
  if (!isObject(input)) return { ok: false, error: 'Not an automation.' };
  const name = oneLine(input.name, 80);
  if (!name) return { ok: false, error: 'Give the automation a name.' };
  const steps = normalizeSteps(input.steps);
  if (!steps.ok) return { ok: false, error: steps.error };
  const inputs = normalizeInputs(input.inputs);
  let schedule;
  try { schedule = normalizeSchedule(input.schedule, now); } catch (err) { return { ok: false, error: err.message }; }
  const submit = input.submit && isObject(input.submit) ? macros.normalizeLocator(input.submit) : null;
  return {
    ok: true,
    automation: {
      id: typeof input.id === 'string' && /^[a-f0-9]{6,32}$/.test(input.id) ? input.id : newId(),
      name,
      description: clean(input.description).trim().slice(0, LIMITS.text),
      inputs,
      steps: steps.steps,
      submit: submit && Object.keys(submit).length ? submit : null, // the recorded Submit button, else the form's own is looked for
      profileId: typeof input.profileId === 'string' ? input.profileId.slice(0, 32) : '',
      projectId: typeof input.projectId === 'string' ? input.projectId.slice(0, 100) : '', // [projects] the project it belongs to, or ''
      // 'review' (the default): every item stops at Submit with what was filled, for the user to approve. 'auto': submits without
      // asking, but only while Lumen is in Bypass permissions (submitsAlone); otherwise it still stops.
      submitMode: input.submitMode === 'auto' ? 'auto' : 'review',
      schedule,
      scheduleOn: Boolean(schedule) && input.scheduleOn === true,
      lastDue: num(input.lastDue) || 0, // a scheduled run's time it was last due (the schedule's times before it are not run)
      createdAt: num(input.createdAt) || now,
      updatedAt: now,
    },
  };
}

// Submit without asking: only an automation set to, only in Bypass permissions mode (features/permission-mode.js).
const submitsAlone = (automation, mode) => automation?.submitMode === 'auto' && mode === 'bypass';

// A recording (macros.stepsFromRecording) turned into an automation's parts: the steps that lead to the form (clicks, waits,
// keys: what the user did to get there), the Submit button it ended on, and the answers the user typed, offered for the
// profile (their labels and values; a password, one-time code or card field was never recorded: macros.js masks them).
function fromRecording(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const lead = [];
  const learned = [];
  let submit = null;
  let startUrl = '';
  for (const s of list) {
    if (s.type === 'open_url') { if (!startUrl) startUrl = s.url; continue; } // each item opens its own page
    if (s.type === 'type' || s.type === 'select') {
      const label = macros.describeLocator(s.locator).replace(/^the |^“|”$/g, '');
      const value = s.type === 'type' ? s.text : s.option;
      if (label && value && !macros.variablesIn(value).length) learned.push({ question: oneLine(label, LIMITS.field), answer: oneLine(value, LIMITS.value) });
      continue;
    }
    lead.push(s);
  }
  // The last risky click (submit, apply, send) is the Submit button: the runner stops before it.
  for (let i = lead.length - 1; i >= 0; i--) {
    if (lead[i].type === 'click' && macros.classifyStep(lead[i]).risky) { submit = lead[i].locator; lead.splice(i, 1); break; }
  }
  // Steps after the fields were typed are the typing's own (a blur, a scroll): only what came before the form is kept.
  return { steps: lead, submit, learned: dedupeAnswers(learned), startUrl };
}

// ---------- 2. the profile ----------

// The answers a profile has a box for. `match`: a field's label (lower case) that asks for it; `ac`: its autocomplete token.
// Checked in this order, so "LinkedIn profile URL" is LinkedIn and not a website, "School name" a school and not a name.
const PROFILE_FIELDS = [
  { key: 'email', match: /\be ?mail/, ac: ['email'] },
  { key: 'phone', match: /phone|mobile|\bcell\b|telephone/, ac: ['tel', 'tel-national'] },
  { key: 'linkedin', match: /linked ?in/ },
  { key: 'github', match: /github/ },
  { key: 'website', match: /website|portfolio|personal (site|url|page)|^url$/, ac: ['url'] },
  { key: 'school', match: /school|university|college|institution/ },
  { key: 'firstName', match: /^(legal |preferred )?first name|given name|^first$|forename/, ac: ['given-name'] },
  { key: 'lastName', match: /^(legal )?last name|family name|surname|^last$/, ac: ['family-name'] },
  { key: 'fullName', match: /^(your |full |legal )?name\b|^full name/, ac: ['name'] },
  { key: 'address', match: /street|address line 1|^(home |mailing )?address$/, ac: ['street-address', 'address-line1'] },
  { key: 'city', match: /^city|town\b/, ac: ['address-level2'] },
  { key: 'zip', match: /zip|postal/, ac: ['postal-code'] },
  { key: 'country', match: /^country|country of residence/, ac: ['country', 'country-name'] },
  { key: 'state', match: /^state\b|province|^region/, ac: ['address-level1'] },
  { key: 'degree', match: /degree/ },
  { key: 'major', match: /major|field of study|discipline|concentration/ },
  { key: 'gradDate', match: /graduat/ },
  { key: 'gpa', match: /\bgpa\b|grade point/ },
  { key: 'workAuth', match: /authori[sz]ed to work|work authori[sz]ation|legally (authori[sz]ed|eligible)|eligible to work/ },
  { key: 'sponsorship', match: /sponsor/ },
  { key: 'startDate', match: /start date|available to start|availability|when can you start/ },
];
const PROFILE_KEYS = PROFILE_FIELDS.map((f) => f.key);
// Questions only ever answered from an answer the user saved for that question: never from the boxes above, never guessed.
const SENSITIVE = /gender|\bsex\b|\brace\b|ethnic|hispanic|latin[oax]|veteran|disab|sexual orientation|transgender|pronoun|date of birth|birth ?date|\bage\b|social security|\bssn\b|salary|compensation|pay expectation|criminal|convict/;
const SECRET = /pass(word|wd|code|phrase)|one.?time|\botp\b|verification code|card.?(number|num)|cvv|cvc|security code|iban|routing|account number/;
const RESUME = /r[eé]sum[eé]|\bcv\b|curriculum/;
const COVER = /cover ?letter|motivation letter/;

function dedupeAnswers(list) {
  const out = [];
  for (const a of list) {
    const q = normLabel(a.question);
    if (!q || !String(a.answer ?? '').trim()) continue;
    const i = out.findIndex((x) => normLabel(x.question) === q);
    if (i >= 0) out[i] = a; else out.push(a);
  }
  return out.slice(0, LIMITS.answers);
}

function normalizeProfile(input, { now = Date.now() } = {}) {
  const r = isObject(input) ? input : {};
  const fields = {};
  const given = isObject(r.fields) ? r.fields : {};
  for (const key of PROFILE_KEYS) fields[key] = oneLine(given[key], LIMITS.value);
  const filePath = (p) => { const s = String(p ?? '').trim(); return s && path.isAbsolute(s) ? s.slice(0, 1000) : ''; };
  return {
    id: typeof r.id === 'string' && /^[a-f0-9]{6,32}$/.test(r.id) ? r.id : newId(),
    name: oneLine(r.name, 60) || 'My profile',
    fields,
    resumePath: filePath(r.resumePath), // a file on this computer, only ever put into a page's file field: never copied or changed
    coverLetterPath: filePath(r.coverLetterPath),
    coverLetterTemplate: clean(r.coverLetterTemplate).slice(0, LIMITS.template),
    answers: dedupeAnswers((Array.isArray(r.answers) ? r.answers : []).filter(isObject).map((a) => ({ question: oneLine(a.question, LIMITS.field), answer: clean(a.answer).trim().slice(0, LIMITS.value) }))),
    updatedAt: now,
  };
}

// Words of a label, for comparing questions: lower case, no punctuation, no asterisk for "required".
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'you', 'your', 'are', 'is', 'do', 'please', 'in', 'for', 'and', 'or', 'on', 'with', 'what', 'this', 'we', 'us', 'our', 'be', 'if', 'any']);
function normLabel(text) {
  return String(text ?? '').toLowerCase().replace(/\(required\)|\(optional\)|\*/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
const words = (text) => normLabel(text).split(' ').filter((w) => w && !STOP.has(w));
// How alike two questions are: 1 the same words, else the share of words in common (Jaccard), a little more when one contains the other.
function similarity(a, b) {
  const na = normLabel(a);
  const nb = normLabel(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const jaccard = common / (wa.size + wb.size - common);
  const contained = common === Math.min(wa.size, wb.size) && Math.min(wa.size, wb.size) >= 2;
  return contained ? Math.max(jaccard, 0.8) : jaccard;
}
const ANSWER_MATCH = 0.6;

// The saved answer for a question, or null. -> { value, source: 'profile:<key>' | 'answer' }
function answerFor(field, profile) {
  const label = normLabel(field.label || field.placeholder || field.name);
  if (!label) return null;
  if (SECRET.test(label)) return null;
  let best = null;
  for (const a of profile?.answers || []) {
    const score = similarity(a.question, label);
    if (score >= ANSWER_MATCH && (!best || score > best.score)) best = { score, value: a.answer };
  }
  if (best) return { value: best.value, source: 'answer' };
  if (SENSITIVE.test(label)) return null;
  const f = profile?.fields || {};
  const ac = String(field.autocomplete || '').toLowerCase().split(/\s+/).pop();
  for (const p of PROFILE_FIELDS) {
    const hit = (ac && p.ac?.includes(ac)) || p.match.test(label);
    if (!hit) continue;
    if (f[p.key]) return { value: f[p.key], source: `profile:${p.key}` };
    // A whole name from its parts, and the other way round.
    if (p.key === 'fullName' && f.firstName && f.lastName) return { value: `${f.firstName} ${f.lastName}`, source: 'profile:fullName' };
    if (p.key === 'firstName' && f.fullName) return { value: f.fullName.split(' ')[0], source: 'profile:firstName' };
    if (p.key === 'lastName' && f.fullName && f.fullName.includes(' ')) return { value: f.fullName.split(' ').slice(1).join(' '), source: 'profile:lastName' };
    return null; // it asks for that box, which is empty: not some other answer
  }
  return null;
}

// The option of a list or radio group that says the answer, or null: the same text, then one starting with it ("Yes, I am…"),
// then one containing it as a word. Yes / no answers match "Yes…" / "No…" options.
function matchOption(options, value) {
  const want = normLabel(value);
  if (!want || !Array.isArray(options)) return null;
  const opts = options.filter((o) => o && !o.placeholder).map((o) => ({ o, text: normLabel(o.text), value: normLabel(o.value) }));
  const yes = /^(yes|y|true)$/.test(want);
  const no = /^(no|n|false)$/.test(want);
  return (opts.find((x) => x.text === want || x.value === want)
    || (yes && opts.find((x) => /^yes\b/.test(x.text)))
    || (no && opts.find((x) => /^no\b/.test(x.text)))
    || opts.find((x) => x.text.startsWith(`${want} `))
    || (want.length >= 3 && opts.find((x) => new RegExp(`\\b${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(x.text)))
    || null)?.o || null;
}

// A cover letter from the profile's template: {{company}} {{role}} {{date}} {{name}} {{firstName}} filled in.
function coverLetter(template, { company = '', role = '', name = '', firstName = '', now = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const values = { company, role, name, firstName, date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
  return String(template ?? '').replace(/\{\{\s*(company|role|date|name|firstName)\s*\}\}/g, (_w, k) => values[k] || '');
}

// The plan for a form (the fields the page script found, ai/automation-page.js scanSource):
//   fills    [{ ref, label, kind, value, option?, source }]   what goes where
//   unknown  [{ ref, label, required }]                       a required question with no saved answer: the item needs the user
//   left     [{ ref, label, reason }]                         left as it is (optional with no answer, already filled, a secret)
// field: { ref, label, name, placeholder, type, tag, required, value, checked, options: [{ value, text, placeholder }], autocomplete }
function planFill(fields, profile, ctx = {}) {
  const fills = [];
  const unknown = [];
  const left = [];
  const ask = (f) => (f.required ? unknown.push({ ref: f.ref, label: oneLine(f.label || f.name || f.placeholder, LIMITS.field), required: true }) : left.push({ ref: f.ref, label: oneLine(f.label || f.name, LIMITS.field), reason: 'no-answer' }));
  const fullName = profile?.fields?.fullName || [profile?.fields?.firstName, profile?.fields?.lastName].filter(Boolean).join(' ');
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || f.ref == null) continue;
    const label = oneLine(f.label || f.placeholder || f.name, LIMITS.field);
    const kind = f.tag === 'select' ? 'select' : f.type === 'radio' ? 'radio' : f.type === 'checkbox' ? 'checkbox' : f.type === 'file' ? 'file' : f.tag === 'textarea' ? 'textarea' : 'text';
    const lower = normLabel(label);
    if (f.type === 'password' || SECRET.test(lower)) { left.push({ ref: f.ref, label, reason: 'secret' }); continue; }
    if (kind === 'file' && !f.value) {
      const file = COVER.test(lower) ? profile?.coverLetterPath : (RESUME.test(lower) || (!COVER.test(lower) && ctx.fileFields === 1)) ? profile?.resumePath : '';
      if (file) fills.push({ ref: f.ref, label, kind, value: file, source: COVER.test(lower) ? 'profile:coverLetterPath' : 'profile:resumePath' });
      else if (f.required) unknown.push({ ref: f.ref, label, required: true, file: true });
      else left.push({ ref: f.ref, label, reason: 'no-answer' });
      continue;
    }
    if (String(f.value ?? '').trim() || (kind === 'checkbox' && f.checked)) { left.push({ ref: f.ref, label, reason: 'filled' }); continue; } // the page's, or the user's on a second look
    if (kind === 'textarea' && COVER.test(lower) && profile?.coverLetterTemplate) {
      fills.push({ ref: f.ref, label, kind, value: coverLetter(profile.coverLetterTemplate, { ...ctx, name: fullName, firstName: profile?.fields?.firstName || fullName.split(' ')[0] || '' }), source: 'profile:coverLetterTemplate' });
      continue;
    }
    const answer = answerFor(f, profile);
    if (!answer) { ask(f); continue; }
    if (kind === 'select' || kind === 'radio') {
      const option = matchOption(f.options, answer.value);
      if (!option) { ask(f); continue; } // a saved answer that is none of the choices: the user picks
      fills.push({ ref: f.ref, label, kind, value: option.text || option.value, option: option.value, source: answer.source });
      continue;
    }
    if (kind === 'checkbox') {
      const v = normLabel(answer.value);
      const on = /^(yes|y|true|checked|agree|i agree|1)$/.test(v);
      const off = /^(no|n|false|unchecked|0)$/.test(v);
      if (!on && !off) { ask(f); continue; }
      fills.push({ ref: f.ref, label, kind, value: on ? 'yes' : 'no', checked: on, source: answer.source });
      continue;
    }
    fills.push({ ref: f.ref, label, kind, value: answer.value.slice(0, f.maxLength > 0 ? f.maxLength : LIMITS.value), source: answer.source });
  }
  return { fills, unknown, left };
}

// Why an item can't go on by itself, from what the page shows (scan: { fields, password, captcha, signIn, forms }), or null.
// A login or CAPTCHA is the user's; a form with questions nobody saved an answer for is too.
function blockerOf(scan, plan) {
  if (!scan) return 'noform';
  if (scan.captcha) return 'captcha';
  if (scan.password) return 'login';
  if (!(scan.fields || []).length) return scan.signIn ? 'login' : 'noform';
  if (plan && plan.unknown.length) return plan.unknown.some((u) => u.file) && plan.unknown.every((u) => u.file) ? 'file' : 'questions';
  return null;
}

// After Submit: 'done' when the page went somewhere else or thanks the user, 'rejected' when it marks fields wrong or shows an
// error, 'check' when it can't be told (the user looks). before / after: the page script's check().
const THANKS = /thank you|thanks for applying|application (?:has been |was )?(?:received|submitted|sent|complete)|we(?:'ve| have) received|successfully (?:submitted|applied)|you(?:'ve| have) applied/i;
function outcome(before, after) {
  if (!after) return 'check';
  if ((after.invalid || []).length || (after.alerts || []).some((a) => /required|invalid|error|missing|please (?:enter|fill|select)/i.test(a))) return 'rejected';
  if (THANKS.test(after.text || '') && !THANKS.test(before?.text || '')) return 'done';
  if (before && after.url && urlKey(after.url) !== urlKey(before.url)) return 'done';
  return 'check';
}

// What the review card shows: each field and what went into it (a file by its name), then what was left and why.
function preview(plan) {
  const rows = [];
  for (const f of plan?.fills || []) rows.push({ label: f.label || '(no label)', value: f.kind === 'file' ? path.basename(String(f.value)) : f.kind === 'textarea' && f.value.length > 300 ? `${f.value.slice(0, 299)}…` : f.value, source: f.source, kind: f.kind });
  for (const u of plan?.unknown || []) rows.push({ label: u.label || '(no label)', value: '', source: 'missing', kind: 'missing' });
  return rows;
}

// The role and company from the page's title, its main heading and its site name: "Mechanical Co-op - Acme | Careers" or
// "Acme: Mechanical Co-op". Best effort: the user can edit both in the tracker's CSV.
function jobOf({ title = '', h1 = '', siteName = '', url = '' } = {}) {
  const t = oneLine(title, 300);
  const parts = t.split(/\s+[|·•–—-]\s+|\s+at\s+|:\s+/).map((s) => s.trim()).filter(Boolean).filter((s) => !/^(careers?|jobs?|job board|apply|application|home)$/i.test(s));
  const role = oneLine(h1, 200) || parts[0] || '';
  const domain = hostOf(url).replace(/^(www|jobs|careers|boards|apply)\./, '').split('.')[0] || '';
  const company = oneLine(siteName, 120) || parts.find((p) => p !== role && !/careers?|jobs?/i.test(p)) || (domain ? domain[0].toUpperCase() + domain.slice(1) : '');
  return { role: role.slice(0, 200), company: company.slice(0, 120) };
}

// ---------- 4. a run ----------

// The items of a run: the automation's addresses, or the links a search page showed (pickLinks), without the ones done
// already (`done`: urlKeys the tracker has as submitted) when the automation skips them.
function itemsFor(automation, { links = null, done = new Set() } = {}) {
  const inputs = automation.inputs || normalizeInputs({});
  const urls = inputs.kind === 'search' ? (links || []) : inputs.urls;
  const out = [];
  const seen = new Set();
  for (const url of urls) {
    const key = urlKey(url);
    if (seen.has(key) || (inputs.skipDone && done.has(key))) continue;
    seen.add(key);
    out.push({ id: newId(), url, status: 'queued', title: '', company: '', role: '', note: '', need: '', questions: [], filled: [], startedAt: 0, endedAt: 0, submittedAt: 0 });
    if (out.length >= (inputs.kind === 'search' ? inputs.limit : LIMITS.items)) break;
  }
  return out;
}

// A search page's links that are postings to open: on the page's own site (or one the automation's address list names), with
// all the words of `match` in their text or address, not the page itself, not done already. links: [{ href, text }]
function pickLinks(links, { base = '', match = '', limit = 10, done = new Set() } = {}) {
  const baseHost = hostOf(base).replace(/^www\./, '');
  const want = words(match);
  const out = [];
  const seen = new Set([urlKey(base)]);
  for (const l of Array.isArray(links) ? links : []) {
    const url = webUrl(l?.href);
    if (!url) continue;
    const host = hostOf(url).replace(/^www\./, '');
    if (baseHost && host !== baseHost && !host.endsWith(`.${baseHost}`) && !baseHost.endsWith(`.${host}`)) continue;
    const key = urlKey(url);
    if (seen.has(key) || done.has(key)) continue;
    const hay = normLabel(`${l.text || ''} ${decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, ' ')}`);
    if (want.length && !want.every((w) => hay.includes(w))) continue;
    if (!want.length && normLabel(l.text).split(' ').length < 2) continue; // with no words to match, only links with a real title
    seen.add(key);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function newRun(automation, items, { now = Date.now(), trigger = 'manual' } = {}) {
  return { id: newId(), automationId: automation.id, name: automation.name, trigger, state: 'running', startedAt: now, endedAt: 0, items, error: '' };
}

const canMove = (from, to) => (MOVES[from] || []).includes(to);
// Moves an item on; false when that move isn't one (the item stays as it was).
function moveItem(run, itemId, to, patch = {}, now = Date.now()) {
  const item = run?.items.find((i) => i.id === itemId);
  if (!item || !ITEM_STATES.includes(to) || (item.status !== to && !canMove(item.status, to))) return false;
  Object.assign(item, patch);
  if (to === 'running' && item.status === 'queued') item.startedAt = now;
  if (FINAL.has(to)) item.endedAt = now;
  if (to === 'queued') { item.endedAt = 0; item.need = ''; item.questions = []; item.note = ''; }
  item.status = to;
  return true;
}

function counts(run) {
  const c = { total: 0, queued: 0, running: 0, review: 0, 'needs-you': 0, done: 0, failed: 0, skipped: 0, stopped: 0 };
  for (const i of run?.items || []) { c.total++; c[i.status]++; }
  return c;
}

// The next item to start, or null: none while paused or stopped, none while too many wait for the user (their tabs stay open).
function nextItem(run) {
  if (!run || run.state !== 'running') return null;
  const c = counts(run);
  if (c.running) return null; // one at a time
  if (c.review + c['needs-you'] >= LIMITS.waiting) return null;
  return run.items.find((i) => i.status === 'queued') || null;
}

// A run is over when every item is: done, failed, skipped or stopped.
function settle(run, now = Date.now()) {
  if (!run || run.state === 'stopped' || run.state === 'finished') return false;
  if (run.items.every((i) => FINAL.has(i.status))) { run.state = 'finished'; run.endedAt = now; return true; }
  return false;
}

function pauseRun(run) { if (run?.state === 'running') { run.state = 'paused'; return true; } return false; }
function resumeRun(run) { if (run?.state === 'paused') { run.state = 'running'; return true; } return false; }
// Stop: nothing new starts and every item not over yet is stopped (the runner aborts the one running).
function stopRun(run, now = Date.now()) {
  if (!run || run.state === 'stopped' || run.state === 'finished') return false;
  for (const i of run.items) if (!FINAL.has(i.status)) { i.status = 'stopped'; i.endedAt = now; }
  run.state = 'stopped';
  run.endedAt = now;
  return true;
}

// ---------- 5. the tracker ----------

function logEntry(run, item, automation, { now = Date.now() } = {}) {
  return {
    at: now, automationId: run.automationId, automation: oneLine(automation?.name || run.name, 80), runId: run.id, url: item.url, company: item.company, role: item.role,
    status: item.status, need: item.need || '', submittedAt: item.submittedAt || 0, note: oneLine(item.note, 300),
    filled: (item.filled || []).map((f) => ({ label: oneLine(f.label, LIMITS.field), value: oneLine(f.value, 300), source: f.source })).slice(0, 80),
  };
}

// CSV with every value quoted, and a value a spreadsheet would run as a formula (= + - @ at the start) made plain text.
const CSV_COLUMNS = ['Date', 'Automation', 'Company', 'Role', 'Status', 'Submitted', 'Address', 'Filled', 'Note'];
function csvCell(v) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n');
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
function toCsv(entries) {
  const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '');
  const rows = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const e of Array.isArray(entries) ? entries : []) {
    rows.push([iso(e.at), e.automation, e.company, e.role, e.status, iso(e.submittedAt), e.url, (e.filled || []).map((f) => `${f.label}: ${f.value}`).join('; '), e.note].map(csvCell).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}
// The postings the tracker has as submitted (what skipDone leaves out).
const doneKeys = (log) => new Set((log || []).filter((e) => e.status === 'done' && e.submittedAt).map((e) => urlKey(e.url)));

// ---------- a draft from a sentence ----------

// "Apply to new ME co-op postings on https://jobs.example.com/search?q=co-op every weekday at 9am" -> an automation draft,
// without a model: its addresses (one is a search when the words say so), the words a posting must have, and a schedule.
// The runtime asks the model first when there is one (features/automations-runtime.js describe) and falls back to this.
function draftFromText(text) {
  const src = oneLine(text, LIMITS.text);
  const urls = urlsIn(src);
  const searchy = /\b(new|search|postings|listings|results|matching|that match|find)\b/i.test(src) && urls.length === 1;
  let schedule = null;
  const when = /\b(every\s+(?:\d{1,2}\s+hours?|hour|weekday|work\s*day|day|morning|evening|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)|daily|hourly|weekdays)(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i.exec(src);
  if (when) {
    const parsed = routines.parseScheduleText(when[0]);
    if (parsed) { try { schedule = normalizeSchedule(parsed.schedule || parsed, Date.now()); } catch { schedule = null; } }
  }
  const quoted = /[“"]([^”"]{2,80})[”"]/.exec(src)?.[1];
  const after = /\b(?:match(?:es|ing)?|for|with|titled|about)\s+([^,.;]{2,60}?)(?=\s+(?:on|at|from|in|every|daily|weekdays|https?:)|[,.;]|$)/i.exec(src.replace(/https?:\/\/\S+/g, ''))?.[1];
  const name = oneLine(src.replace(/https?:\/\/\S+/g, '').replace(/\s+(?:on|at|from|every|daily|weekdays|matching|that match|titled|with)\b.*$/i, '').replace(/[“”"]/g, ''), 60) || 'New automation';
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    description: src,
    inputs: normalizeInputs(searchy ? { kind: 'search', searchUrl: urls[0], match: quoted || after || '' } : { kind: 'urls', urls }),
    steps: [],
    schedule,
    scheduleOn: Boolean(schedule),
    submitMode: 'review',
  };
}

// ---------- 6. the store ----------

// { automations, profiles, runs (the last LIMITS.runs, newest last), log (the tracker, newest last) }, written whole and
// atomically; encrypted with the OS keychain (encrypt / decrypt / available) when it can be: a profile holds personal details.
function createStore({ file, encrypt = null, decrypt = null, available = () => false, now = Date.now }) {
  let state = null;
  let unreadable = false; // a file that could not be read is kept, and not replaced by an empty one
  const empty = () => ({ automations: [], profiles: [], runs: [], log: [] });
  function load() {
    if (state) return state;
    const r = readStoreFile(file);
    let data = r.data;
    if (r.failed) unreadable = true;
    if (isObject(data) && typeof data.enc === 'string') {
      try { data = JSON.parse(decrypt(data.enc)); } catch { data = null; unreadable = true; }
    }
    const d = isObject(data) ? data : {};
    state = empty();
    for (const raw of Array.isArray(d.profiles) ? d.profiles.slice(0, LIMITS.profiles) : []) state.profiles.push(normalizeProfile(raw, { now: num(raw?.updatedAt) || now() }));
    for (const raw of Array.isArray(d.automations) ? d.automations.slice(0, LIMITS.automations) : []) {
      const a = normalizeAutomation(raw, { now: num(raw?.updatedAt) || now() });
      if (a.ok && !state.automations.some((x) => x.id === a.automation.id)) state.automations.push({ ...a.automation, lastRunAt: num(raw.lastRunAt) || 0 });
    }
    state.runs = (Array.isArray(d.runs) ? d.runs : []).filter((x) => isObject(x) && Array.isArray(x.items)).slice(-LIMITS.runs).map((x) => (x.state === 'running' || x.state === 'paused' ? interrupted(x) : x));
    state.log = (Array.isArray(d.log) ? d.log : []).filter(isObject).slice(-LIMITS.log);
    return state;
  }
  // A run that was going when Lumen closed: what was not over is stopped (its tabs are gone).
  function interrupted(run) {
    const t = num(run.endedAt) || now();
    for (const i of run.items) if (!FINAL.has(i.status)) { i.status = 'stopped'; i.endedAt = t; i.note = i.note || 'Lumen was closed.'; }
    return { ...run, state: 'stopped', endedAt: t };
  }
  function write() {
    if (unreadable) return false;
    const s = load();
    const body = JSON.stringify({ format: FORMAT, version: 1, ...s });
    const out = encrypt && available() ? JSON.stringify({ format: FORMAT, version: 1, enc: encrypt(body) }) : body;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file); // never a half-written file
    return true;
  }
  return {
    load,
    write,
    automations: () => load().automations,
    profiles: () => load().profiles,
    runs: () => load().runs,
    log: () => load().log,
    automation: (id) => load().automations.find((a) => a.id === id) || null,
    profile: (id) => load().profiles.find((p) => p.id === id) || null,
    saveAutomation(input) {
      const s = load();
      const existing = input?.id ? s.automations.find((a) => a.id === input.id) : null;
      if (input?.id && !existing) return { ok: false, error: 'That automation no longer exists.' };
      if (!existing && s.automations.length >= LIMITS.automations) return { ok: false, error: `You can keep up to ${LIMITS.automations} automations.` };
      const r = normalizeAutomation({ ...input, id: existing?.id, createdAt: existing?.createdAt, lastDue: input.scheduleOn && !existing?.scheduleOn ? now() : existing?.lastDue }, { now: now() });
      if (!r.ok) return r;
      const a = { ...r.automation, lastRunAt: existing?.lastRunAt || 0 };
      if (existing) s.automations[s.automations.indexOf(existing)] = a; else s.automations.push(a);
      write();
      return { ok: true, automation: a };
    },
    removeAutomation(id) {
      const s = load();
      const before = s.automations.length;
      s.automations = s.automations.filter((a) => a.id !== id);
      if (s.automations.length === before) return false;
      write();
      return true;
    },
    saveProfile(input) {
      const s = load();
      const existing = input?.id ? s.profiles.find((p) => p.id === input.id) : null;
      if (!existing && s.profiles.length >= LIMITS.profiles) return { ok: false, error: `You can keep up to ${LIMITS.profiles} profiles.` };
      const p = normalizeProfile({ ...input, id: existing?.id || input?.id }, { now: now() });
      if (existing) s.profiles[s.profiles.indexOf(existing)] = p; else s.profiles.push(p);
      write();
      return { ok: true, profile: p };
    },
    removeProfile(id) {
      const s = load();
      const before = s.profiles.length;
      s.profiles = s.profiles.filter((p) => p.id !== id);
      if (s.profiles.length === before) return false;
      for (const a of s.automations) if (a.profileId === id) a.profileId = '';
      write();
      return true;
    },
    addRun(run) { const s = load(); s.runs.push(run); s.runs = s.runs.slice(-LIMITS.runs); write(); },
    addLog(entry) { const s = load(); s.log.push(entry); s.log = s.log.slice(-LIMITS.log); },
    clearLog() { load().log = []; write(); },
    unreadable: () => unreadable,
  };
}

module.exports = {
  FORMAT, LIMITS, ITEM_STATES, FINAL, WAITING, NEEDS, PROFILE_FIELDS, PROFILE_KEYS, CSV_COLUMNS,
  webUrl, urlKey, urlsIn, hostOf, normalizeInputs, normalizeSteps, normalizeSchedule, normalizeAutomation, submitsAlone, fromRecording,
  normalizeProfile, normLabel, similarity, answerFor, matchOption, coverLetter, planFill, blockerOf, outcome, preview, jobOf,
  itemsFor, pickLinks, newRun, canMove, moveItem, counts, nextItem, settle, pauseRun, resumeRun, stopRun,
  logEntry, csvCell, toCsv, doneKeys, draftFromText, createStore,
};
