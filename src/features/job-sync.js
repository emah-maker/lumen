// [project templates] A Job applications project's tracker kept with what the user already has (features/project-templates.js is the
// tracker itself). The pure part, unit-tested in test/units/job-sync-units.js; main.js does the requests ("chats:project-applications").
//   1. A Google Sheet the user tracks in: its header row read by name (Company, Role, Location or Area, Status, Apply URL, Date Applied,
//      Deadline, Notes), each Status turned into a stage ("Applied (user-reported)" is applied, "Not started" or "Backup" is saved, ...).
//      A sync reads the sheet, then: a row new to the tracker is added; a row whose Status the user changed in the sheet moves the
//      tracker's entry; an entry the user moved in Lumen gets its Status cell (and an empty Date Applied) written; an application logged
//      in Lumen that the sheet hasn't got becomes a new row. Rows are found again by their posting's address (else company and role) on
//      every sync, never by a row number kept from before, so a sheet sorted or edited in between is written at the right row.
//   2. Gmail: the subject, sender and preview of the messages a search finds (never their bodies) sorted here, on this computer, into
//      an application received, an interview, an offer or a rejection, with the company they are from. Each one that would change the
//      tracker is a suggestion the user applies or ignores on the dashboard; nothing is changed by an email on its own.
'use strict';
const T = require('./project-templates');
const auto = require('./automations');

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v, max = 300) => String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- the sheet ----------

// Header names -> the tracker's fields (first match wins, case and punctuation ignored).
const HEADERS = {
  company: ['company', 'employer', 'organization', 'company name'],
  role: ['role', 'position', 'title', 'job title', 'job'],
  location: ['location', 'area', 'city', 'where'],
  status: ['status', 'stage', 'state', 'application status'],
  url: ['apply url', 'url', 'link', 'posting', 'job link', 'application link', 'posting url', 'apply link'],
  applied: ['date applied', 'applied', 'applied on', 'application date', 'date submitted', 'submitted'],
  deadline: ['deadline', 'due', 'closes'],
  notes: ['notes', 'note', 'comments'],
};
// -> { company: 0, role: 2, ... } for the columns there are (0-based), from the first row.
function mapHeader(row) {
  const cells = (row || []).map((c) => String(c ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); // (not norm(): it drops "company")
  const out = {};
  for (const [field, names] of Object.entries(HEADERS)) {
    const i = cells.findIndex((c) => names.includes(c));
    if (i >= 0) out[field] = i;
  }
  return out;
}

// A Status cell -> a stage ('' when it says nothing the tracker knows: the entry keeps its own).
function stageFromStatus(text) {
  const s = clean(text, 120).toLowerCase();
  if (!s) return 'saved';
  if (/\boffer/.test(s)) return 'offer';
  if (/reject|not selected|declined by|turned down|no longer (being )?consider|unsuccessful/.test(s)) return 'rejected';
  if (/withdr|\bskip|not interested|\bclosed\b|pass(ed)? on|\bdrop/.test(s)) return 'withdrawn';
  if (/interview|phone screen|\bonsite|on-site|\bscreen(ing)?\b|assessment|\boa\b|coding challenge|final round/.test(s)) return 'interview';
  if (/appl(ied|ication (sent|submitted))|submitted|\bsent\b|waiting|pending|in review|under review/.test(s)) return 'applied';
  if (/not started|to apply|not applied|backup|blocked|saved|planned|todo|to do|wishlist|maybe|researching|draft/.test(s)) return 'saved';
  return '';
}
// What the tracker writes in a Status cell for a stage.
const STATUS_TEXT = { saved: 'Not started', applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn' };

// A date cell -> ms (0 when there is none). "Oct 20 2026", "10/20/2026", "2026-10-20", "Oct 20" (this year, or last year if that is in
// the future).
function parseDate(text, now = Date.now()) {
  const s = clean(text, 60).replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ');
  if (!s) return 0;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12).getTime();
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) return new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2], 12).getTime();
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?: (\d{4}))?$/.exec(s);
  if (m) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].slice(0, 3).toLowerCase());
    if (month < 0) return 0;
    const year = m[3] ? +m[3] : new Date(now).getFullYear();
    let t = new Date(year, month, +m[2], 12).getTime();
    if (!m[3] && t > now + 86400000) t = new Date(year - 1, month, +m[2], 12).getTime();
    return t;
  }
  return 0;
}

// The sheet's values (rows of cells, the header first) -> { header, rows: [{ row (1-based, as the sheet numbers it), company, role, location,
// url, status, stage, applied, notes }] }. A row with neither a company nor an address is skipped.
function readSheet(values, now = Date.now()) {
  const all = Array.isArray(values) ? values : [];
  const header = mapHeader(all[0]);
  if (header.company === undefined && header.url === undefined) return { header, rows: [], error: 'No Company or Apply URL column in the first row.' };
  const cell = (r, f) => (header[f] === undefined ? '' : clean(r[header[f]], f === 'notes' ? 300 : f === 'url' ? 2000 : 160));
  const rows = [];
  all.slice(1).forEach((r, i) => {
    if (!Array.isArray(r)) return;
    const company = cell(r, 'company');
    const url = auto.webUrl(cell(r, 'url')) || '';
    if (!company && !url) return;
    const status = cell(r, 'status');
    rows.push({ row: i + 2, company, role: cell(r, 'role'), location: cell(r, 'location'), url, status, stage: stageFromStatus(status), applied: parseDate(cell(r, 'applied'), now), notes: cell(r, 'notes') });
  });
  return { header, rows };
}

// The same application? Its posting's address (whatever its tracking parameters), else the same company and role (or the same company
// when one side has no role).
function same(a, b) {
  if (a.url && b.url && auto.webUrl(a.url) && auto.webUrl(b.url)) return auto.urlKey(a.url) === auto.urlKey(b.url);
  const ca = norm(a.company);
  if (!ca || ca !== norm(b.company)) return false;
  const ra = norm(a.role);
  const rb = norm(b.role);
  return !ra || !rb || ra === rb;
}

const col = (i) => { let s = ''; let n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const day = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };

// One sync of the tracker's entries (the project's: projectEntries) with the sheet as just read. -> {
//   add:    entries to add to the tracker (rows it hasn't got),
//   moves:  [{ key, stage, sheetStatus }] the tracker's entries the sheet moved on (its Status changed since the last sync),
//   seen:   [{ key, sheetStatus, row }] what each matched entry's sheet row says now (kept on the entry for the next sync),
//   cells:  [{ range: 'F5', value }] Status (and empty Date Applied) cells to write: entries moved in Lumen since the last sync,
//   append: [[...cells]] rows for applications logged in Lumen that the sheet hasn't got (only when `write`) }
// An entry remembers the sheet's Status it last saw (entry.sheet.status): the sheet's changed since -> the sheet wins; the sheet's the same
// but the tracker's stage isn't what it says -> the tracker's is written. A Status the tracker can't read ("Ask Sam") moves nothing and is
// never overwritten unless the stage changed in Lumen.
function plan(entries, sheet, { tab = '', write = true, now = Date.now() } = {}) {
  const out = { add: [], moves: [], seen: [], cells: [], append: [] };
  const { header, rows } = sheet;
  const prefix = tab ? `'${String(tab).replace(/'/g, "''")}'!` : '';
  const used = new Set();
  for (const r of rows) {
    const e = (entries || []).find((x) => !used.has(x) && same(x, r));
    if (!e) {
      if (!r.stage) continue; // (a Status the tracker can't read: the row isn't an application it knows how to count)
      const made = T.manualEntry({ company: r.company, role: r.role, url: r.url, stage: r.stage, note: r.notes, from: 'sheet' }, { now });
      if (!made.ok) continue;
      const entry = made.entry;
      entry.automation = 'Google Sheet';
      if (r.stage !== 'saved') { entry.submittedAt = r.applied || now; entry.history = [{ stage: 'applied', at: entry.submittedAt }, ...(r.stage !== 'applied' ? [{ stage: r.stage, at: now }] : [])]; if (['interview', 'offer', 'rejected'].includes(r.stage)) entry.respondedAt = now; }
      entry.sheet = { status: r.status, row: r.row };
      out.add.push(entry);
      continue;
    }
    used.add(e);
    const key = T.entryKey(e);
    const last = e.sheet?.status;
    if (last === undefined || last !== r.status) { // first seen, or changed in the sheet: the sheet's word
      if (r.stage && r.stage !== e.stage) out.moves.push({ key, stage: r.stage, sheetStatus: r.status, applied: r.applied });
      out.seen.push({ key, sheetStatus: r.status, row: r.row });
    } else if (write && header.status !== undefined && STATUS_TEXT[e.stage] && r.stage !== e.stage) { // moved in Lumen: written to the sheet
      out.cells.push({ range: `${prefix}${col(header.status)}${r.row}`, value: STATUS_TEXT[e.stage] });
      if (header.applied !== undefined && !r.applied && e.submittedAt) out.cells.push({ range: `${prefix}${col(header.applied)}${r.row}`, value: day(e.submittedAt) });
      out.seen.push({ key, sheetStatus: STATUS_TEXT[e.stage], row: r.row });
    } else out.seen.push({ key, sheetStatus: r.status, row: r.row });
  }
  if (write) {
    const width = Math.max(...Object.values(header), 0) + 1;
    for (const e of entries || []) {
      if (used.has(e) || e.sheet) continue; // (an entry the sheet once had and the user took out of it: not added back)
      const cells = Array.from({ length: width }, () => '');
      const put = (f, v) => { if (header[f] !== undefined) cells[header[f]] = v; };
      put('company', e.company || '');
      put('role', e.role || '');
      put('status', STATUS_TEXT[e.stage] || '');
      put('url', e.url || '');
      put('applied', e.submittedAt ? day(e.submittedAt) : '');
      put('notes', e.note || '');
      out.append.push({ key: T.entryKey(e), cells, status: STATUS_TEXT[e.stage] || '' });
    }
  }
  return out;
}

// ---------- email ----------

// Senders that are an applicant tracking system, not the company (its name comes from the subject or the sender's name then).
const ATS = /(^|\.)(myworkday(jobs)?|workday|greenhouse(-mail)?|lever|icims|smartrecruiters|ashbyhq|ashby|workablemail|workable|jobvite|taleo|successfactors|bamboohr|breezy|recruitee|jazzhr|applytojob|hire\.lever|paradox|oraclecloud|ultipro|ukg|eightfold|avature|phenom(people)?|brassring|myworkdaysite|gmail|outlook|hotmail|yahoo|icloud|linkedin|indeed|handshake|joinhandshake)\.(com|io|co|net|org)$/i;
const KINDS = ['applied', 'interview', 'offer', 'rejected'];
// One message (from, subject, snippet) -> { kind, company } or null when it isn't about an application.
function classifyEmail(msg) {
  const subject = clean(msg?.subject, 300);
  const text = `${subject} ${clean(msg?.snippet, 600)}`.toLowerCase();
  let kind = '';
  if (/unfortunately|not (to )?(be )?mov(e|ing) forward|other candidates|decided (not to|to pursue)|will not be (moving|proceeding|advancing)|regret to inform|position has been filled|not been selected|were not selected|no longer (being )?consider|not a (fit|match) at this time|move forward with (other|another)/.test(text)) kind = 'rejected';
  else if (/pleased to (offer|extend)|offer letter|extend (you )?an offer|(job|internship|co-?op) offer\b|offer of employment/.test(text)) kind = 'offer';
  else if (/\binterview|phone screen|schedule (a|an|your) (call|time|chat|conversation|meeting)|your availability|next (steps|round) (in|of|for) (the|your)|coding (challenge|assessment)|online assessment|hirevue|codesignal|hackerrank|take-?home|invite you to/.test(text)) kind = 'interview';
  else if (/thank(s| you) for (applying|your application|your interest in|submitting)|application (received|submitted|confirmation|has been (received|submitted))|(we('ve| have)|has been) received your application|successfully (applied|submitted)|your application (to|for|at) /.test(text)) kind = 'applied';
  if (!kind) return null;
  return { kind, company: companyOf(msg) };
}
// The company an email is from: named in the subject ("Thank you for applying to Acme"), else the sender's name without the
// recruiting words ("Acme Talent Acquisition"), else the sender's domain when it isn't a tracking system's or a mail provider's.
function companyOf(msg) {
  const subject = clean(msg?.subject, 300);
  const m = /(?:apply(?:ing)?|application|interest|candidacy|interview|offer)\s+(?:to|at|with|for)\s+(?:the\s+)?(.+?)(?:\s*[-–—|:!,(]|\s+(?:for|position|role|internship|co-?op)\b|$)/i.exec(subject);
  const fromSubject = m ? clean(m[1], 60) : '';
  if (fromSubject && !/^(the |our |your |a |an )?(position|role|job|internship|co-?op|opportunity)/i.test(fromSubject)) return fromSubject;
  const from = clean(msg?.from, 200);
  const name = clean(from.replace(/<[^>]*>/, '').replace(/"/g, ''), 80).replace(/\b(talent( acquisition)?|recruit(ing|ment|er|ers)?|careers?|hiring( team)?|hr|human resources|university( relations| programs)?|campus|team|no-?reply|notifications?|jobs?|people|staffing|via \w+|@.*)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (name && !/@/.test(name) && name.length > 1 && !ATS.test(`x.${name.toLowerCase().replace(/\s+/g, '')}.com`)) return name;
  const host = (/@([a-z0-9.-]+)>?\s*$/i.exec(from) || [])[1] || '';
  if (host && !ATS.test(host)) { const parts = host.toLowerCase().split('.'); const base = parts.length > 2 && /^(mail|email|careers|jobs|hr|talent|e|em|info|notify|notifications)$/.test(parts[0]) ? parts[1] : parts[parts.length - 2]; return base ? base.charAt(0).toUpperCase() + base.slice(1) : ''; }
  return '';
}

const RANK = { saved: 0, applied: 1, interview: 2, offer: 3, rejected: 4, withdrawn: 4 };
// The messages a search found -> what each would change in the tracker, newest first: { id, at, from, subject, kind, company, key (the
// entry it matched, or '' for a new application), stage (what it would move to) }. One that changes nothing (the entry is at that stage
// or past it), one already applied or ignored (`done`: message ids), and one with no company it can be filed under are left out.
function emailSuggestions(entries, messages, done = []) {
  const skip = new Set(done);
  const out = [];
  const taken = new Set();
  for (const m of [...(messages || [])].sort((a, b) => (b.at || 0) - (a.at || 0))) {
    if (!m?.id || skip.has(m.id)) continue;
    const c = classifyEmail(m);
    if (!c || !c.company) continue;
    const cn = norm(c.company);
    if (!cn) continue;
    const e = (entries || []).filter((x) => { const xn = norm(x.company); return xn && (xn === cn || xn.startsWith(`${cn} `) || cn.startsWith(`${xn} `)); }).sort((a, b) => RANK[a.stage] - RANK[b.stage])[0] || null;
    const stage = c.kind;
    if (e) {
      if (e.stage === 'rejected' || e.stage === 'withdrawn' || e.stage === 'offer') continue; // (closed, or an offer: an email doesn't reopen it)
      if (stage === 'applied' && e.stage !== 'saved') continue; // (a confirmation of one applied to already)
      if (stage !== 'rejected' && stage !== 'applied' && RANK[stage] <= RANK[e.stage]) continue; // (an interview email when it is at the interview already)
    }
    const k = `${e ? T.entryKey(e) : cn}:${stage}`;
    if (taken.has(k)) continue; // (the newest email about one change is enough)
    taken.add(k);
    out.push({ id: String(m.id), at: m.at || 0, from: clean(m.from, 120), subject: clean(m.subject, 200), kind: c.kind, company: e?.company || c.company, role: e?.role || '', key: e ? T.entryKey(e) : '', stage });
  }
  return out;
}
// The Gmail search: the last 120 days of mail that looks like an application's (the classifier decides).
const GMAIL_QUERY = 'newer_than:120d -in:chats (subject:(application OR applying OR applied OR interview OR offer OR candidacy OR "next steps" OR "your interest") OR "thank you for applying" OR "unfortunately")';

module.exports = { HEADERS, STATUS_TEXT, KINDS, GMAIL_QUERY, mapHeader, stageFromStatus, parseDate, readSheet, same, plan, classifyEmail, companyOf, emailSuggestions, colName: col };
