// [ai preferences] The `preferences` tool: the AI changes a short list of safe preferences itself when the user asks or says how they
// like things ("make it dark", "bigger text", "in this project, always cite in APA", "use Opus for new chats here"), and keeps a standing
// note in the project's instructions ("remember I'm a second-year ME student"). Pure (no Electron); unit-tested in
// test/units/ai-preferences-units.js. agent.js defines the tool's text (so this file stays out of startup) and gates it: once the chat holds
// content from elsewhere, a card shows the change first. main.js supplies the reads and writes.
//   - Only the keys in APP and PROJECT can change. Everything else (permissions, sites allowed, privacy, security, passwords, memory on or off,
//     downloads, accounts) is refused with where the user can change it: those stay the user's.
//   - Every change is said in the chat with Undo (the 'preference' event) and kept in a change log, newest first, that the project page lists
//     with Undo too (this run of Lumen; nothing secret is in it, only the setting and its two values).
const crypto = require('crypto');

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const clean = (v, max) => String(v ?? '').replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const bool = (v) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 'off' || v === 0 || v === '0' ? false : null);
const oneOf = (list) => (v) => { const s = String(v ?? '').trim().toLowerCase(); return list.includes(s) ? s : null; };

// The browser's own preferences the AI may change: how it looks and reads. `check` normalises a value (null: not allowed); main's settings
// backend checks again when it saves (settings-backend.js validate).
const APP = {
  theme: { label: 'Theme', check: oneOf(['system', 'light', 'dark']), show: (v) => ({ system: 'Match the system', light: 'Light', dark: 'Dark' })[v] || String(v) },
  accentColor: { label: 'Accent colour', check: (v, ctx) => { const s = String(v ?? '').trim().toLowerCase(); return (ctx?.accents || []).includes(s) || /^#[0-9a-f]{6}$/.test(s) ? s : null; } },
  fontSize: { label: 'Text size', check: (v, ctx) => { const n = Math.round(Number(v)); return (ctx?.fontSizes || [12, 14, 16, 18, 20, 22, 24]).includes(n) ? n : null; }, show: (v) => `${v} px` },
  reduceMotion: { label: 'Reduce motion', check: bool, show: (v) => (v ? 'On' : 'Off') },
  compactTabs: { label: 'Compact tabs', check: bool, show: (v) => (v ? 'On' : 'Off') },
  tabLayout: { label: 'Tab layout', check: oneOf(['top', 'side']), show: (v) => (v === 'side' ? 'Down the side' : 'Across the top') },
  aiPreferFractions: { label: 'Prefer fractions in math answers', check: bool, show: (v) => (v ? 'On' : 'Off') },
};
// The chat's project (only in a project's chat): its goal line, the defaults a new chat there starts with, and standing notes in its instructions.
const NOTE_MAX = 300;
const PROJECT = {
  description: { label: 'Project goal', check: (v) => clean(v, 200) },
  model: { label: 'Model for new chats', check: (v, ctx) => { const s = clean(v, 120); return !s || (ctx?.models || []).includes(s) ? s : null; }, show: (v, ctx) => (v ? ctx?.modelName?.(v) || v : 'My usual model') },
  planFirst: { label: 'Plan first for new chats', check: bool, show: (v) => (v ? 'On' : 'Off') },
  note: { label: 'Note in the project’s instructions', check: (v) => clean(v, NOTE_MAX) || null },
};
// What the refusal names, so the AI can tell the user where it is (the keys it is most likely to try).
const USERS_OWN = /permission|bypass|auto.?allow|allowed.?hosts?|always.?allow|security|privacy|cookie|password|passkey|https|safe.?browsing|tracking|fingerprint|webrtc|proxy|download|memory|api.?key|token|account|sign.?in|block|adblock|extension|sync|delete|history|camera|microphone|location|notification/i;

const keyOf = (input) => String(input?.key ?? '').trim().replace(/^project\./, '');
const scopeOf = (input) => (String(input?.key ?? '').startsWith('project.') || (!APP[keyOf(input)] && PROJECT[keyOf(input)]) ? 'project' : 'app');
const shown = (spec, v, ctx) => (spec.show ? spec.show(v, ctx) : v === undefined || v === null || v === '' ? '(none)' : String(v));

// The note lines are kept apart from the rest of the instructions under one heading, so a note can be taken out again without touching
// what the user wrote.
const NOTES_HEAD = 'Noted for this project:';
function notesOf(instructions) {
  const text = String(instructions ?? '');
  const at = text.lastIndexOf(NOTES_HEAD);
  if (at < 0) return [];
  return text.slice(at + NOTES_HEAD.length).split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
}
function withNote(instructions, note) {
  const text = String(instructions ?? '').replace(/\s+$/, '');
  if (notesOf(text).some((n) => n.toLowerCase() === note.toLowerCase())) return text;
  if (text.includes(NOTES_HEAD)) return `${text}\n- ${note}`;
  return `${text ? `${text}\n\n` : ''}${NOTES_HEAD}\n- ${note}`;
}
function withoutNote(instructions, note) {
  const text = String(instructions ?? '');
  const at = text.lastIndexOf(NOTES_HEAD);
  if (at < 0) return text;
  const head = text.slice(0, at).replace(/\s+$/, '');
  const rest = notesOf(text).filter((n) => n !== note);
  if (!rest.length) return head;
  return `${head ? `${head}\n\n` : ''}${NOTES_HEAD}\n${rest.map((n) => `- ${n}`).join('\n')}`;
}

// The change log: the newest `max` changes, each undone at most once. -> { record, undoEntry, take, list }
function createChangeLog({ max = 40, now = () => Date.now(), newId = () => crypto.randomBytes(5).toString('hex') } = {}) {
  let entries = [];
  return {
    record(change) { const entry = { ...change, token: newId(), at: now(), undone: false }; entries = [entry, ...entries].slice(0, max); return entry; },
    // The change a token names, still to be undone (null: unknown, too old, or undone already).
    take(token) { const e = entries.find((x) => x.token === String(token ?? '')); return e && !e.undone ? e : null; },
    markUndone(token) { const e = entries.find((x) => x.token === String(token ?? '')); if (e) e.undone = true; return Boolean(e); },
    // A project's changes (and, with app: true, the browser's too), newest first; values as text, nothing else.
    list({ projectId = '', app = false } = {}) { return entries.filter((e) => (e.scope === 'project' && e.projectId === projectId && projectId) || (app && e.scope === 'app')).map((e) => ({ token: e.token, at: e.at, scope: e.scope, key: e.key, label: e.label, from: e.fromText, to: e.toText, undone: e.undone })); },
  };
}

// What the AI is told it can change: one line per key with the value now. ctx: { app: { read(key) }, project: { get() } | null }
function describe(ctx) {
  const lines = ['Browser:'];
  for (const [k, spec] of Object.entries(APP)) lines.push(`- ${k}: ${shown(spec, ctx.app.read(k), ctx)}`);
  const p = ctx.project?.get?.();
  if (p) {
    lines.push(`This chat's project (“${p.name}”; key project.<name>):`);
    lines.push(`- project.description: ${shown(PROJECT.description, p.description, ctx)}`);
    lines.push(`- project.model: ${shown(PROJECT.model, p.defaults?.model, ctx)}`);
    lines.push(`- project.planFirst: ${shown(PROJECT.planFirst, p.defaults?.plan === true, ctx)}`);
    const notes = notesOf(p.instructions);
    lines.push(`- project.note: ${notes.length ? notes.map((n) => `“${n}”`).join(', ') : '(none)'} (set adds one; remove: true takes one out)`);
  } else lines.push('(Not in a project: project.* keys need a project chat.)');
  lines.push('Anything else (permissions, sites, privacy, security, memory, accounts, downloads) is the user’s to change in Settings.');
  return lines.join('\n');
}

// One change. -> { ok: true, change: { scope, key, label, from, to, fromText, toText, projectId, apply } } | { ok: false, error }
// ctx: { app: { read(key) }, project: { get() } | null, accents, fontSizes, models, modelName(id) }
function plan(input, ctx) {
  const key = keyOf(input);
  const scope = scopeOf(input);
  const spec = scope === 'project' ? PROJECT[key] : APP[key];
  if (!spec) {
    const theirs = USERS_OWN.test(key);
    return { ok: false, error: theirs ? `“${key}” is the user’s to change, not yours (security, privacy, permissions and accounts always are). Tell them where: Settings (lumen://settings).` : `“${key}” can’t be changed this way. These can: ${Object.keys(APP).join(', ')}, and in a project chat project.${Object.keys(PROJECT).join(', project.')}.` };
  }
  if (scope === 'project') {
    const p = ctx.project?.get?.();
    if (!p) return { ok: false, error: 'This chat is not in a project, so project settings can’t change here.' };
    if (key === 'note') {
      const note = spec.check(input.value);
      if (!note) return { ok: false, error: 'note needs the text to keep (one short line).' };
      const before = String(p.instructions ?? '');
      const removing = input.remove === true;
      if (removing && !notesOf(before).includes(note)) return { ok: false, error: `No note “${note}” in this project. The notes: ${notesOf(before).join(' | ') || '(none)'}.` };
      const after = removing ? withoutNote(before, note) : withNote(before, note);
      if (after === before) return { ok: false, error: 'That note is there already.' };
      if (ctx.maxInstructions && after.length > ctx.maxInstructions) return { ok: false, error: 'The project’s instructions are full: ask the user to make room in Settings → Instructions.' };
      return { ok: true, change: { scope, key, label: spec.label, projectId: p.id, from: before, to: after, fromText: removing ? note : '(none)', toText: removing ? '(removed)' : note, field: 'instructions' } };
    }
    const value = spec.check(input.value, ctx);
    if (value === null || value === undefined) return { ok: false, error: `That isn’t a value ${key} takes.` };
    const before = key === 'description' ? p.description || '' : key === 'model' ? p.defaults?.model || '' : p.defaults?.plan === true;
    if (before === value) return { ok: false, error: `${spec.label} is ${shown(spec, value, ctx)} already.` };
    return { ok: true, change: { scope, key, label: spec.label, projectId: p.id, from: before, to: value, fromText: shown(spec, before, ctx), toText: shown(spec, value, ctx), field: key === 'description' ? 'description' : key === 'model' ? 'defaults.model' : 'defaults.plan' } };
  }
  const value = spec.check(input.value, ctx);
  if (value === null || value === undefined) return { ok: false, error: `That isn’t a value ${key} takes.` };
  const before = ctx.app.read(key);
  if (before === value) return { ok: false, error: `${spec.label} is ${shown(spec, value, ctx)} already.` };
  return { ok: true, change: { scope, key, label: spec.label, projectId: '', from: before, to: value, fromText: shown(spec, before, ctx), toText: shown(spec, value, ctx), field: key } };
}

// The tool. deps: ctx (above) plus write(change, value) -> bool (saves one change's value: change.to, or change.from to undo it), log
// (createChangeLog), changed(event) (the chat's row). -> the text the AI gets back
async function runTool(input = {}, deps) {
  const action = String(input.action || '');
  if (action === 'list') return describe(deps);
  if (action !== 'set') throw new Error('action is list or set.');
  const r = plan(input, deps);
  if (!r.ok) throw new Error(r.error);
  const ok = await deps.write(r.change, r.change.to);
  if (!ok) throw new Error('Could not save that change.');
  const entry = deps.log.record(r.change);
  try { deps.changed?.({ token: entry.token, scope: entry.scope, key: entry.key, label: entry.label, from: entry.fromText, to: entry.toText }); } catch { /* a closed view: the change stands */ }
  return `Changed ${entry.label}: ${entry.fromText} → ${entry.toText}. The user sees this in the chat with Undo${entry.scope === 'project' ? ' and on the project page (Settings)' : ''}.`;
}

// Undo a change by its token: its old value back, only while the setting still has the value the AI gave it (changed since: left alone).
// read(change) -> the value it has now. -> 'undone' | 'changed' | 'gone'
async function undo(token, { log, read, write }) {
  const e = log.take(token);
  if (!e) return 'gone';
  const now = await read(e);
  let back = e.from;
  if (e.field === 'instructions') { // (a note: just that line in or out again, whatever else of the instructions was edited since)
    back = e.toText === '(removed)' ? withNote(now, e.fromText) : withoutNote(now, e.toText);
    if (back === String(now ?? '')) return 'changed';
  } else if (JSON.stringify(now) !== JSON.stringify(e.to)) return 'changed';
  if (!(await write(e, back))) return 'changed';
  log.markUndone(token);
  return 'undone';
}

function stepLabel(input = {}) {
  if (input.action === 'list') return 'Reading the settings it can change';
  const key = keyOf(input);
  const spec = APP[key] || PROJECT[key];
  if (key === 'note') return input.remove === true ? 'Taking a note out of the project' : `Noting for this project: ${clean(input.value, 80)}`;
  return spec ? `Changing ${spec.label.toLowerCase()}` : 'Changing a setting';
}

module.exports = { APP, PROJECT, NOTES_HEAD, NOTE_MAX, notesOf, withNote, withoutNote, createChangeLog, describe, plan, runTool, undo, stepLabel, keyOf };
