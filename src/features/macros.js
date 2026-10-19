// Macros: named sequences of steps you run on demand (Settings > Macros). This file is the pure part,
// so most of it is tested in plain Node (test/macros-units.js):
//   1. the schema: steps, locators, validation and sanitising (a macro is data, never code);
//   2. variables: {{query}} asked at run time, and {{clipboard}} {{date}} {{selection}} {{url}} {{title}} {{time}};
//   3. keyboard shortcuts: parsing, matching and conflicts with Lumen's own and other macros;
//   4. safety: which steps count as "submit, buy or send", what the AI may run, secrets never stored;
//   5. turning a recording into steps, import / export, and the store (<userData>/macros.json).
// The runner is macro-runner.js; macros-runtime.js connects it to the AI's tools and to Lumen.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shortcutsHelp = require('./shortcuts-help');

const FORMAT = 'lumen-macros';
const MAX_MACROS = 100;
const MAX_STEPS = 100;
const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_TEXT = 4000;
const MAX_URL = 2000;
const STEP_TYPES = ['open_url', 'click', 'type', 'key', 'wait', 'scroll', 'select', 'tab', 'action', 'ask_ai', 'pause'];
// Lumen's own commands a macro can run (there is no command palette to reuse: these are the browser's menu commands).
const ACTIONS = ['reader', 'mute', 'pin', 'group_tab', 'open_sidebar', 'new_chat', 'bookmark', 'zoom_in', 'zoom_out', 'zoom_reset', 'reload', 'back', 'forward', 'new_tab'];
const WAIT_MODES = ['seconds', 'element', 'load', 'text'];
const TAB_ACTIONS = ['switch', 'close'];
const TAB_TARGETS = ['next', 'previous', 'first', 'last', 'match'];
const BUILTIN_VARS = ['clipboard', 'date', 'time', 'selection', 'url', 'title'];
const MODIFIERS = ['control', 'shift', 'alt', 'meta'];
const KEYS = /^(?:[A-Za-z0-9`~!@#$%^&*()_+=[\]{};:'",.<>/?\\|-]|Enter|Escape|Tab|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$/;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
const oneLine = (text, max) => clean(text).replace(/\s+/g, ' ').trim().slice(0, max);
const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

// ---------- variables ----------

const VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g;
// The strings of a step that may hold {{variables}}.
const stepTexts = (s) => [s.url, s.text, s.option, s.prompt, s.match, s.name].filter((x) => typeof x === 'string');
function variablesIn(text) {
  return [...String(text ?? '').matchAll(VAR_RE)].map((m) => m[1]);
}
// Variables the user is asked for, in first-use order (not the built-in ones).
function variablesOf(macro) {
  const seen = [];
  for (const step of macro?.steps || []) for (const t of stepTexts(step)) for (const v of variablesIn(t)) if (!BUILTIN_VARS.includes(v) && !seen.includes(v)) seen.push(v);
  return seen;
}
const builtinsUsed = (macro) => {
  const used = new Set();
  for (const step of macro?.steps || []) for (const t of stepTexts(step)) for (const v of variablesIn(t)) if (BUILTIN_VARS.includes(v)) used.add(v);
  return [...used];
};
const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeText = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// values: what the user filled in; builtins: { clipboard, selection, url, title } read when the run starts.
// encode: the text is part of a web address (values are percent-encoded). -> { text, missing }
function substitute(text, { values = {}, builtins = {}, now = new Date() } = {}, { encode = false } = {}) {
  const missing = [];
  const out = String(text ?? '').replace(VAR_RE, (whole, name) => {
    let value;
    if (name === 'date') value = dateText(now);
    else if (name === 'time') value = timeText(now);
    else if (BUILTIN_VARS.includes(name)) value = builtins[name] == null ? '' : String(builtins[name]);
    else if (Object.prototype.hasOwnProperty.call(values, name) && values[name] != null && values[name] !== '') value = String(values[name]);
    else { if (!missing.includes(name)) missing.push(name); return whole; }
    return encode ? encodeURIComponent(value) : value;
  });
  return { text: out, missing };
}

// ---------- secrets: never stored ----------

const SECRET_NAME = /pass(word|wd|code|phrase)|pwd|one.?time|\botp\b|2fa|card.?(number|num|no\b)|cc.?(num|number|csc|cvc|cvv|exp)|cvv|cvc|security.?code|iban|routing.?number|account.?number|\bssn\b|social.?security/i;
// Digits that pass the Luhn check and are 13 to 19 long (spaces and dashes allowed): a card number.
function looksLikeCardNumber(text) {
  const s = String(text ?? '');
  for (const m of s.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
// Does this locator describe a password, one-time code or payment field?
function sensitiveLocator(loc) {
  if (!isObject(loc)) return false;
  const ac = String(loc.autocomplete || '').toLowerCase();
  return loc.sensitive === true || String(loc.inputType || '').toLowerCase() === 'password'
    || /(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(ac) || /(^|\s)cc-/.test(ac)
    || SECRET_NAME.test(`${loc.name || ''} ${loc.id || ''} ${loc.testid || ''} ${loc.label || ''}`);
}
const SECRET_REFUSAL = 'This step types into a password, one-time-code or payment field. Macros never store those: use a Pause step instead and type it yourself when the macro reaches it.';

// ---------- locators and steps ----------

function normalizeLocator(raw) {
  if (!isObject(raw)) return null;
  const loc = {};
  for (const [key, max] of [['role', 30], ['name', 120], ['text', 120], ['testid', 100], ['id', 80], ['css', 300], ['tag', 20], ['inputType', 20], ['autocomplete', 40], ['label', 120]]) {
    const v = oneLine(raw[key], max);
    if (v) loc[key] = v;
  }
  if (raw.sensitive === true) loc.sensitive = true;
  if (!(loc.testid || loc.id || loc.name || loc.text || loc.css)) return null;
  return loc;
}
const describeLocator = (loc) => {
  if (!loc) return '';
  if (loc.name) return `${loc.role ? `${loc.role} ` : ''}“${loc.name}”`;
  if (loc.text) return `“${loc.text}”`;
  return loc.testid || (loc.id && `#${loc.id}`) || loc.css || '';
};

// The address a url step opens once variables are filled in; always http(s).
function checkedUrl(text) {
  let raw = String(text || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && /^[\w-]+(\.[\w-]+)+([/:?#]|$)/.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

// one step: { ok, step } or { ok: false, error }
function normalizeStep(raw) {
  if (!isObject(raw)) return { ok: false, error: 'Not a step.' };
  const type = String(raw.type || '');
  if (!STEP_TYPES.includes(type)) return { ok: false, error: `Unknown step type “${oneLine(type, 30)}”.` };
  const step = { type };
  const note = oneLine(raw.note, 120);
  if (note && type !== 'pause') step.note = note;
  const locator = () => {
    const loc = normalizeLocator(raw.locator);
    return loc;
  };
  switch (type) {
    case 'open_url': {
      const url = oneLine(raw.url, MAX_URL);
      if (!url) return { ok: false, error: 'Open a page: the address is empty.' };
      const hasVar = /\{\{/.test(url); // a variable can hold the address: checked again once it is filled in
      if (hasVar ? !/^(https?:\/\/|\{\{)/i.test(url) : !checkedUrl(url)) return { ok: false, error: 'Only http and https addresses can be opened.' };
      step.url = hasVar ? url : checkedUrl(url);
      step.target = raw.target === 'current' ? 'current' : 'new';
      break;
    }
    case 'click': {
      const loc = locator();
      if (!loc) return { ok: false, error: 'Click: say which element (a name, its text, a test id or a CSS selector).' };
      step.locator = loc;
      if (raw.submit === true) step.submit = true;
      break;
    }
    case 'type': {
      const loc = locator();
      if (!loc) return { ok: false, error: 'Type: say which field.' };
      if (sensitiveLocator(loc)) return { ok: false, error: SECRET_REFUSAL, secret: true };
      const text = clean(raw.text).slice(0, MAX_TEXT);
      if (looksLikeCardNumber(text)) return { ok: false, error: SECRET_REFUSAL, secret: true };
      step.locator = loc;
      step.text = text;
      if (raw.enter === true) step.enter = true;
      break;
    }
    case 'select': {
      const loc = locator();
      if (!loc) return { ok: false, error: 'Select: say which menu.' };
      if (sensitiveLocator(loc)) return { ok: false, error: SECRET_REFUSAL, secret: true };
      const option = oneLine(raw.option, 200);
      if (!option) return { ok: false, error: 'Select: say which option.' };
      step.locator = loc;
      step.option = option;
      break;
    }
    case 'key': {
      const key = String(raw.key ?? '');
      if (!KEYS.test(key)) return { ok: false, error: `Unknown key “${oneLine(key, 20)}”.` };
      step.key = key;
      const mods = (Array.isArray(raw.modifiers) ? raw.modifiers : []).filter((m) => MODIFIERS.includes(m));
      if (mods.length) step.modifiers = [...new Set(mods)];
      break;
    }
    case 'wait': {
      const mode = WAIT_MODES.includes(raw.mode) ? raw.mode : 'seconds';
      step.mode = mode;
      if (mode === 'seconds') {
        const s = Number(raw.seconds);
        if (!Number.isFinite(s) || s < 0.1 || s > 60) return { ok: false, error: 'Wait: between 0.1 and 60 seconds.' };
        step.seconds = Math.round(s * 10) / 10;
      } else {
        const t = Number(raw.timeout);
        step.timeout = Number.isFinite(t) ? Math.min(Math.max(Math.round(t), 1), 60) : 10;
        if (mode === 'element') {
          const loc = locator();
          if (!loc) return { ok: false, error: 'Wait for an element: say which one.' };
          step.locator = loc;
        } else if (mode === 'text') {
          const text = oneLine(raw.text, 200);
          if (!text) return { ok: false, error: 'Wait for text: say which text.' };
          step.text = text;
        }
      }
      break;
    }
    case 'scroll': {
      step.direction = raw.direction === 'up' ? 'up' : 'down';
      const n = Number(raw.screens);
      step.screens = Number.isFinite(n) ? Math.min(Math.max(n, 0.25), 10) : 1;
      break;
    }
    case 'tab': {
      step.action = TAB_ACTIONS.includes(raw.action) ? raw.action : 'switch';
      step.which = TAB_TARGETS.includes(raw.which) ? raw.which : 'next';
      if (step.which === 'match') {
        const match = oneLine(raw.match, 200);
        if (!match) return { ok: false, error: 'Tab: say part of its title or address.' };
        step.match = match;
      }
      break;
    }
    case 'action': {
      if (!ACTIONS.includes(raw.action)) return { ok: false, error: `Unknown Lumen action “${oneLine(raw.action, 30)}”.` };
      step.action = raw.action;
      if (raw.action === 'group_tab') step.name = oneLine(raw.name, 60) || 'Macro';
      if (raw.action === 'open_sidebar') step.text = clean(raw.text).slice(0, MAX_TEXT);
      break;
    }
    case 'ask_ai': {
      const prompt = clean(raw.prompt).trim().slice(0, MAX_TEXT);
      if (!prompt) return { ok: false, error: 'Ask AI: the prompt is empty.' };
      step.prompt = prompt;
      if (raw.newChat === true) step.newChat = true;
      break;
    }
    case 'pause': {
      step.note = oneLine(raw.note, 120) || 'Do the next part yourself, then press Continue';
      if (raw.masked === true) step.masked = true;
      break;
    }
    default: break;
  }
  return { ok: true, step };
}

// The one-line label a step has in lists, the editor, the progress toast and errors.
function describeStep(step) {
  const s = step || {};
  switch (s.type) {
    case 'open_url': return `Open ${s.url}${s.target === 'current' ? ' in this tab' : ' in a new tab'}`;
    case 'click': return `Click ${describeLocator(s.locator)}`;
    case 'type': return `Type ${s.text ? `“${String(s.text).slice(0, 40)}${String(s.text).length > 40 ? '…' : ''}”` : 'text'} into ${describeLocator(s.locator)}${s.enter ? ' and press Enter' : ''}`;
    case 'select': return `Choose “${s.option}” in ${describeLocator(s.locator)}`;
    case 'key': return `Press ${[...(s.modifiers || []), s.key].join('+')}`;
    case 'wait': return s.mode === 'seconds' ? `Wait ${s.seconds} s` : s.mode === 'load' ? 'Wait for the page to finish loading' : s.mode === 'text' ? `Wait for the text “${s.text}”` : `Wait for ${describeLocator(s.locator)}`;
    case 'scroll': return `Scroll ${s.direction} ${s.screens} screen${s.screens === 1 ? '' : 's'}`;
    case 'tab': return `${s.action === 'close' ? 'Close' : 'Switch to'} the ${s.which === 'match' ? `tab matching “${s.match}”` : `${s.which} tab`}`;
    case 'action': return `Lumen: ${s.action.replace(/_/g, ' ')}${s.name ? ` “${s.name}”` : ''}`;
    case 'ask_ai': return `Ask the AI: ${String(s.prompt || '').slice(0, 60)}`;
    case 'pause': return `Wait for you: ${s.note || ''}`;
    default: return String(s.type || 'step');
  }
}

// ---------- shortcuts ----------

const KEY_ALIASES = { esc: 'escape', del: 'delete', return: 'enter', ' ': 'space', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', plus: '=', '+': '=', ctrl: 'ctrl', control: 'ctrl', cmd: 'mod', command: 'mod', option: 'alt' };
const NAMED_KEYS = new Set(['enter', 'tab', 'space', 'escape', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);
const MOD_ORDER = ['mod', 'ctrl', 'alt', 'shift'];
// 'Ctrl+Shift+1' -> 'mod+shift+1' ('mod' is Cmd on macOS and Ctrl elsewhere, as in the Keyboard Shortcuts sheet). null: not a chord.
function normalizeChord(text, platform = process.platform) {
  const parts = String(text ?? '').trim().toLowerCase().split(/\s*\+\s*(?=.)/).map((p) => KEY_ALIASES[p] ?? p).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  if (!(key.length === 1 || NAMED_KEYS.has(key))) return null;
  const mods = new Set();
  for (const m of parts) {
    if (m === 'ctrl' && platform !== 'darwin') mods.add('mod'); // Control is the mod key outside macOS
    else if (MOD_ORDER.includes(m)) mods.add(m);
    else return null;
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}
// The chord of a key press (Electron's before-input-event input).
function chordOfInput(input, platform = process.platform) {
  if (!input) return null;
  let key = String(input.key || '').toLowerCase();
  const code = String(input.code || '');
  const letter = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code);
  if (letter) key = letter[1].toLowerCase();
  key = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', ' ': 'space', esc: 'escape' }[key] ?? key;
  if (!key || ['control', 'shift', 'alt', 'meta'].includes(key)) return null;
  const mac = platform === 'darwin';
  const mods = [];
  if (mac ? input.meta : input.control) mods.push('mod');
  if (mac && input.control) mods.push('ctrl');
  if (input.alt) mods.push('alt');
  if (input.shift) mods.push('shift');
  return [...mods, key].join('+');
}
const EDITING = ['mod+c', 'mod+v', 'mod+x', 'mod+a', 'mod+z', 'mod+y', 'mod+shift+z', 'mod+shift+v', 'mod+q', 'mod+m', 'mod+shift+i', 'mod+shift+c', 'alt+f4', 'mod+alt+i', 'mod+alt+j', 'mod+alt+c', 'alt+tab', 'mod+space', 'mod+=', 'mod+-', 'mod+0'];
// Every chord Lumen handles itself on `platform` (the Keyboard Shortcuts sheet, plus text-editing and system chords).
function reservedChords(platform = process.platform) {
  const out = new Map(EDITING.map((c) => [c, 'a text-editing or system shortcut']));
  for (const section of shortcutsHelp.SECTIONS) {
    for (const [label, keys] of section.entries) {
      for (const chord of shortcutsHelp.chordsFor(keys, platform)) {
        const range = /^(.*)\+(\d)–(\d)$/.exec(chord);
        if (range) for (let n = Number(range[2]); n <= Number(range[3]); n++) out.set(`${range[1]}+${n}`, label);
        else out.set(normalizeChord(chord, platform) || chord, label);
      }
    }
  }
  return out;
}
// null when `chord` can be a macro's shortcut, else why not. macros: the other saved macros.
function shortcutProblem(chord, { macros = [], exceptId = null, platform = process.platform } = {}) {
  const norm = normalizeChord(chord, platform);
  if (!norm) return 'That is not a keyboard shortcut. Use a key with Ctrl (Cmd on a Mac) or Alt, like Ctrl+Shift+1.';
  const parts = norm.split('+');
  const mods = parts.slice(0, -1);
  if (!mods.includes('mod') && !mods.includes('alt') && !mods.includes('ctrl')) return 'A shortcut needs Ctrl (Cmd on a Mac) or Alt as well, so it never gets in the way of typing.';
  const taken = reservedChords(platform).get(norm);
  if (taken) return `${shortcutsHelp.formatChord(norm, platform)} is already used by Lumen (${typeof taken === 'string' && taken.startsWith('shortcuts.') ? taken.replace(/^shortcuts\./, '').replace(/([A-Z])/g, ' $1').toLowerCase() : taken}).`;
  const other = macros.find((m) => m.id !== exceptId && m.shortcut && normalizeChord(m.shortcut, platform) === norm);
  if (other) return `${shortcutsHelp.formatChord(norm, platform)} already runs the macro “${other.name}”.`;
  return null;
}
// The macro a key press runs, if any.
const macroForInput = (macros, input, platform = process.platform) => {
  const chord = chordOfInput(input, platform);
  return chord ? macros.find((m) => m.shortcut && normalizeChord(m.shortcut, platform) === chord) || null : null;
};

// ---------- the macro ----------

const hostOfUrl = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const cleanSite = (text) => {
  const s = String(text ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
};
// "Only on example.com": the page's host is that site or one of its subdomains.
function siteMatches(site, url) {
  if (!site) return true;
  const host = hostOfUrl(url).replace(/^www\./, '');
  return Boolean(host) && (host === site || host.endsWith(`.${site}`));
}

// input: anything. strict: a bad step is an error (the editor, imports); otherwise bad steps are dropped (a model's draft).
// -> { ok, macro, dropped: [{ index, error }] } or { ok: false, error, stepIndex? }
function normalizeMacro(input, { strict = true, now = Date.now, platform = process.platform } = {}) {
  if (!isObject(input)) return { ok: false, error: 'Not a macro.' };
  const name = oneLine(input.name, 60);
  if (!name) return { ok: false, error: 'Give the macro a name.' };
  const raws = Array.isArray(input.steps) ? input.steps : [];
  if (raws.length > MAX_STEPS) return { ok: false, error: `A macro can have up to ${MAX_STEPS} steps.` };
  const steps = [];
  const dropped = [];
  for (const [index, raw] of raws.entries()) {
    const r = normalizeStep(raw);
    if (r.ok) steps.push(r.step);
    else if (strict) return { ok: false, error: `Step ${index + 1}: ${r.error}`, stepIndex: index, secret: r.secret === true };
    else dropped.push({ index, error: r.error });
  }
  if (!steps.length) return { ok: false, error: 'Add at least one step.' };
  let shortcut = '';
  if (input.shortcut) {
    shortcut = normalizeChord(input.shortcut, platform);
    if (!shortcut) return strict ? { ok: false, error: 'That is not a keyboard shortcut.' } : { ok: true, macro: null, dropped };
  }
  const site = input.site ? cleanSite(input.site) : '';
  if (input.site && !site) return { ok: false, error: 'The site should be a domain like example.com.' };
  const macro = {
    id: typeof input.id === 'string' && /^[\w:.-]{1,40}$/.test(input.id) ? input.id : crypto.randomBytes(6).toString('hex'),
    name,
    description: oneLine(input.description, 200),
    steps,
    shortcut,
    site,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now(),
    updatedAt: now(),
  };
  return { ok: true, macro, dropped };
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const nameTaken = (macros, name, exceptId) => macros.some((m) => sameName(m.name, name) && (exceptId === undefined || m.id !== exceptId));
function uniqueName(macros, name) {
  if (!nameTaken(macros, name)) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name.slice(0, 60 - String(n).length - 1)} ${n}`;
    if (!nameTaken(macros, candidate)) return candidate;
  }
  return name;
}
// "/macro name" and run_macro: an exact name, else the one macro whose name starts with / contains the text.
// -> { macro } | { ambiguous: [names] } | {}
function findMacro(macros, query) {
  const q = String(query ?? '').trim().toLowerCase().replace(/^\/?macro\s+/, '');
  if (!q) return {};
  const exact = macros.find((m) => m.name.toLowerCase() === q || m.id === query);
  if (exact) return { macro: exact };
  for (const test of [(m) => m.name.toLowerCase().startsWith(q), (m) => m.name.toLowerCase().includes(q)]) {
    const hits = macros.filter(test);
    if (hits.length === 1) return { macro: hits[0] };
    if (hits.length > 1) return { ambiguous: hits.map((m) => m.name) };
  }
  return {};
}

// ---------- safety ----------

const RISKY_WORDS = /\b(submit|buy|purchase|pay|payment|checkout|check out|place (?:your |my )?order|order now|confirm|send|post|publish|tweet|reply|comment|delete|remove|donate|subscribe|sign ?up|register|transfer|withdraw|book now|reserve|apply|upgrade|unsubscribe|save changes)\b/i;
// Does this step submit a form, buy, send or post? (Allowed because the user authored it; the AI running it asks first.)
// -> { risky, reason }
function classifyStep(step) {
  const s = step || {};
  if (s.type === 'click') {
    const l = s.locator || {};
    if (s.submit === true || String(l.inputType || '').toLowerCase() === 'submit') return { risky: true, reason: 'a submit button' };
    const hay = `${l.name || ''} ${l.text || ''} ${l.testid || ''} ${l.id || ''} ${l.label || ''}`;
    const m = RISKY_WORDS.exec(hay);
    if (m) return { risky: true, reason: `a “${m[1].toLowerCase()}” control` };
  }
  if (s.type === 'type' && s.enter === true) return { risky: true, reason: 'Enter after typing (it may submit the form)' };
  if (s.type === 'key' && s.key === 'Enter' && !(s.modifiers || []).length) return { risky: true, reason: 'Enter (it may submit the form)' };
  return { risky: false, reason: '' };
}
// What an AI may not run: a step that sends a prompt to the sidebar AI (a loop), and the clipboard (private data the AI
// would type into a site). -> [reasons]; empty: fine.
function aiProblems(macro) {
  const out = [];
  if ((macro.steps || []).some((s) => s.type === 'ask_ai')) out.push('it has an “Ask AI” step, which the AI cannot start for itself');
  if (builtinsUsed(macro).includes('clipboard')) out.push('it uses {{clipboard}}, which only you can run');
  return out;
}

// ---------- a recording into steps ----------

// events: from the page recorder ({type: click|type|select|key|pause, locator, ...}) and from the main process
// ({type: 'nav', url, typed}, {type: 'tab', match}). -> { steps, masked, dropped }
function stepsFromRecording(events, { startUrl = '' } = {}) {
  const raw = [];
  if (startUrl && /^https?:/i.test(startUrl)) raw.push({ type: 'open_url', url: startUrl, target: 'current' });
  let masked = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!isObject(e)) continue;
    const last = raw[raw.length - 1];
    if (e.type === 'pause') {
      masked++;
      if (!(last && last.type === 'pause' && last.note === e.note)) raw.push({ type: 'pause', note: e.note, masked: true });
    } else if (e.type === 'type') {
      // Defense in depth: a value from a secret field never becomes a step, whatever the page sent.
      if (sensitiveLocator(e.locator) || looksLikeCardNumber(e.text)) { masked++; if (!(last && last.type === 'pause')) raw.push({ type: 'pause', note: 'Fill in the secret field yourself', masked: true }); continue; }
      if (last && last.type === 'type' && JSON.stringify(last.locator) === JSON.stringify(e.locator)) last.text = e.text;
      else raw.push({ type: 'type', locator: e.locator, text: e.text });
    } else if (e.type === 'key') {
      if (e.key === 'Enter' && !(e.modifiers || []).length && last && last.type === 'type' && !last.enter) last.enter = true;
      else raw.push({ type: 'key', key: e.key, modifiers: e.modifiers });
    } else if (e.type === 'click') raw.push({ type: 'click', locator: e.locator, submit: e.submit === true });
    else if (e.type === 'select') raw.push({ type: 'select', locator: e.locator, option: e.option });
    else if (e.type === 'nav') raw.push({ type: 'open_url', url: e.url, target: 'current' });
    else if (e.type === 'tab') raw.push({ type: 'tab', action: 'switch', which: 'match', match: e.match });
  }
  const steps = [];
  const dropped = [];
  for (const [index, r] of raw.slice(0, MAX_STEPS).entries()) {
    const n = normalizeStep(r);
    if (n.ok) steps.push(n.step); else dropped.push({ index, error: n.error });
  }
  return { steps, masked, dropped };
}

// ---------- import / export ----------

const exportable = (m) => ({ name: m.name, description: m.description, site: m.site, shortcut: m.shortcut, steps: m.steps });
const exportText = (macros) => `${JSON.stringify({ format: FORMAT, version: 1, macros: macros.map(exportable) }, null, 2)}\n`;

// Untrusted text in, a review list out; nothing here saves or runs anything.
// -> { ok, error?, candidates: [{ macro, renamedFrom?, shortcutCleared? }], rejected: [{ index, name, reason }] }
function reviewImport(text, existing = [], { platform = process.platform } = {}) {
  const fail = (error) => ({ ok: false, error, candidates: [], rejected: [] });
  if (typeof text !== 'string') return fail('That is not a text file.');
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) return fail(`That file is larger than ${MAX_IMPORT_BYTES / 1024} KB, too big to be a macros file. Nothing was imported.`);
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return fail('That file is not valid JSON.'); }
  const list = Array.isArray(data) ? data : data && data.format === FORMAT && Array.isArray(data.macros) ? data.macros : null;
  if (!list) return fail('That file is not a Lumen macros file.');
  const candidates = [];
  const rejected = [];
  const taken = existing.map((m) => ({ ...m }));
  list.forEach((raw, index) => {
    const label = oneLine(raw?.name, 60);
    if (candidates.length + existing.length >= MAX_MACROS) { rejected.push({ index, name: label, reason: `There is room for ${MAX_MACROS} macros in all.` }); return; }
    const r = normalizeMacro({ ...(isObject(raw) ? raw : {}), id: undefined, createdAt: undefined }, { strict: true, platform });
    if (!r.ok) { rejected.push({ index, name: label, reason: r.error }); return; }
    const macro = r.macro;
    const note = {};
    if (macro.shortcut) {
      const problem = shortcutProblem(macro.shortcut, { macros: taken, exceptId: macro.id, platform });
      if (problem) { macro.shortcut = ''; note.shortcutCleared = problem; }
    }
    if (nameTaken(taken, macro.name)) { note.renamedFrom = macro.name; macro.name = uniqueName(taken, macro.name); }
    taken.push(macro);
    candidates.push({ macro, ...note });
  });
  return { ok: true, candidates, rejected };
}

// ---------- the store: <userData>/macros.json ----------

function createStore({ file, now = Date.now, platform = process.platform }) {
  let state = null;
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, macros: state.macros }, null, 2));
    fs.renameSync(tmp, file); // never a half-written file
  };
  function load() {
    if (state) return state;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet, or unreadable: start empty */ }
    const macros = [];
    for (const raw of Array.isArray(data.macros) ? data.macros : []) {
      if (macros.length >= MAX_MACROS) break;
      const r = normalizeMacro(raw, { strict: false, now, platform });
      if (!r.ok || !r.macro || nameTaken(macros, r.macro.name) || macros.some((m) => m.id === r.macro.id)) continue;
      if (r.macro.shortcut && shortcutProblem(r.macro.shortcut, { macros, platform })) r.macro.shortcut = '';
      macros.push(r.macro);
    }
    state = { macros };
    return state;
  }
  const list = () => load().macros.map((m) => ({ ...m, steps: m.steps.map((s) => ({ ...s })) }));
  const get = (id) => load().macros.find((m) => m.id === id) || null;
  const peek = () => load().macros; // the live list, not a copy (the shortcut check runs on every key press): never modify
  function save(input) {
    const s = load();
    const existing = input?.id ? s.macros.find((x) => x.id === input.id) : null;
    if (input?.id && !existing) return { ok: false, error: 'That macro no longer exists.' };
    const r = normalizeMacro({ ...input, id: existing?.id, createdAt: existing?.createdAt }, { strict: true, now, platform });
    if (!r.ok) return r;
    if (nameTaken(s.macros, r.macro.name, existing?.id)) return { ok: false, error: `There is already a macro named “${r.macro.name}”.` };
    if (r.macro.shortcut) {
      const problem = shortcutProblem(r.macro.shortcut, { macros: s.macros, exceptId: existing?.id, platform });
      if (problem) return { ok: false, error: problem, field: 'shortcut' };
    }
    if (!existing && s.macros.length >= MAX_MACROS) return { ok: false, error: `You can keep up to ${MAX_MACROS} macros.` };
    if (existing) s.macros[s.macros.indexOf(existing)] = r.macro; else s.macros.push(r.macro);
    write();
    return { ok: true, macro: r.macro };
  }
  function remove(id) {
    const s = load();
    const before = s.macros.length;
    s.macros = s.macros.filter((m) => m.id !== id);
    if (s.macros.length === before) return false;
    write();
    return true;
  }
  function addAll(macros) {
    const s = load();
    const added = [];
    for (const raw of macros) {
      if (s.macros.length >= MAX_MACROS) break;
      const r = normalizeMacro({ ...raw, id: undefined, createdAt: undefined }, { strict: true, now, platform });
      if (!r.ok) continue;
      r.macro.name = uniqueName(s.macros, r.macro.name);
      if (r.macro.shortcut && shortcutProblem(r.macro.shortcut, { macros: s.macros, platform })) r.macro.shortcut = '';
      s.macros.push(r.macro);
      added.push(r.macro);
    }
    if (added.length) write();
    return added;
  }
  return { list, peek, get, save, remove, addAll };
}

module.exports = {
  FORMAT, MAX_MACROS, MAX_STEPS, MAX_IMPORT_BYTES, STEP_TYPES, ACTIONS, WAIT_MODES, TAB_ACTIONS, TAB_TARGETS, BUILTIN_VARS, SECRET_REFUSAL,
  variablesIn, variablesOf, builtinsUsed, substitute, looksLikeCardNumber, sensitiveLocator, normalizeLocator, normalizeStep, normalizeMacro, describeStep, describeLocator, checkedUrl,
  normalizeChord, chordOfInput, reservedChords, shortcutProblem, macroForInput, siteMatches, cleanSite, nameTaken, uniqueName, findMacro,
  classifyStep, aiProblems, stepsFromRecording, exportText, reviewImport, createStore,
};
