// [desktop apps] press_keys: "ctrl+s", "Enter", "ctrl+a ctrl+c" -> the string SendKeys wants ("^s", "{ENTER}", "^a^c"), and the shortcuts the AI is
// never allowed to send (they leave the app it was let into, close it without asking, or reach Windows itself). Typed text is escaped the
// same way, so "50% (done)" is typed as written. Pure: test/units/desktop-units.js.
'use strict';

const NAMED = {
  enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', space: ' ', backspace: '{BS}', delete: '{DEL}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  insert: '{INS}', capslock: '{CAPSLOCK}', numlock: '{NUMLOCK}', scrolllock: '{SCROLLLOCK}', printscreen: '{PRTSC}',
};
const MODS = { ctrl: '^', shift: '+', alt: '%' }; // by normalized name (splitChord)
const MAX_KEYS = 40;

class KeysError extends Error {}

// One normalizer for both platforms, run BEFORE any denylist check, so no spelling can slip past an entry: names are lower-cased, the aliases
// collapse to one name (esc/escape, del/delete, return/enter, ...; ctrl/control, alt/option/opt, win/windows/meta/super/cmd/command), "+" or "-"
// may separate modifiers (spaces around "+" are ignored), and a literal "+" or "-" key stays reachable ("ctrl++", "ctrl+-", "plus", "minus").
const KEY_ALIASES = { escape: 'esc', del: 'delete', return: 'enter', spacebar: 'space', bs: 'backspace', pgup: 'pageup', pgdn: 'pagedown', ins: 'insert', plus: '+', minus: '-' };
const MOD_ALIASES = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt',
  win: 'win', windows: 'win', super: 'win', meta: 'cmd', cmd: 'cmd', command: 'cmd', fn: 'fn', globe: 'fn', // 'win' means nothing on a Mac; 'cmd' is refused on Windows
};

// "ctrl + shift + esc" -> "ctrl+shift+esc": spaces around a "+" that follows a word don't split the chord (a "+" key itself is written "ctrl++").
const joinPlus = (text) => text.replace(/([a-z0-9])\s*\+\s*(?=\S)/gi, '$1+');

// "Ctrl + Shift + Esc" / "control-shift-escape" / "ctrl++" -> { mods: ['ctrl', 'shift'], key: 'esc' } (mods in first-seen order, no repeats).
function splitChord(text) {
  let rest = joinPlus(String(text).trim().toLowerCase());
  if (!rest) throw new KeysError(`Not a key: "${text}"`);
  const mods = [];
  for (;;) {
    const m = /^([a-z]+)[+-](?=.)/.exec(rest);
    if (!m) break;
    const mod = MOD_ALIASES[m[1]];
    if (!mod) throw new KeysError(`Not a modifier: "${m[1]}" (use ctrl, shift or alt)`);
    if (!mods.includes(mod)) mods.push(mod);
    rest = rest.slice(m[0].length);
  }
  return { mods, key: KEY_ALIASES[rest] || rest };
}

const escapeText = (text) => String(text ?? '').replace(/[+^%~(){}[\]]/g, '{$&}').replace(/\r\n|\r|\n/g, '{ENTER}');

function chord(text) {
  const { mods, key } = splitChord(text);
  let prefix = '';
  for (const m of mods) {
    if (m === 'win' || m === 'cmd') throw new KeysError('The Windows key is not sent: it reaches Windows itself, not the app.');
    if (!MODS[m]) throw new KeysError(`Not a modifier: "${m}" (use ctrl, shift or alt)`);
    prefix += MODS[m];
  }
  let sent;
  if (NAMED[key]) sent = NAMED[key];
  else if (/^f([1-9]|1[0-2])$/.test(key)) sent = `{${key.toUpperCase()}}`;
  else if (key.length === 1) sent = escapeText(key);
  else throw new KeysError(`Not a key: "${key}"`);
  const ctrl = mods.includes('ctrl');
  const alt = mods.includes('alt');
  if (alt && key === 'f4') throw new KeysError('Alt+F4 closes the app without asking, so it is not sent. Use the app\'s own Close or Save first.');
  if (ctrl && alt && key === 'delete') throw new KeysError('Ctrl+Alt+Delete is not sent.');
  if (ctrl && mods.includes('shift') && key === 'esc') throw new KeysError('Ctrl+Shift+Esc opens the Task Manager, so it is not sent.');
  if (alt && key === 'tab') throw new KeysError('Alt+Tab switches to another app, so it is not sent. Use focus_app.');
  if (ctrl && key === 'esc') throw new KeysError('Ctrl+Esc opens the Start menu, so it is not sent.');
  const withMods = prefix && sent.length > 1 && !sent.startsWith('{') ? `${prefix}(${sent})` : `${prefix}${sent}`;
  return withMods;
}

// "ctrl+s", "ctrl+a ctrl+c", "Enter" -> { seq, shown }. Throws KeysError with a sentence for the AI.
function parseKeys(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new KeysError('No keys given. Examples: "ctrl+s", "Enter", "ctrl+a ctrl+c".');
  const chords = joinPlus(text).split(/\s+/);
  if (chords.length > MAX_KEYS) throw new KeysError(`At most ${MAX_KEYS} keys at once.`);
  const parts = chords.map(chord); // one entry per chord: the helper sends them one at a time, checking the focus before each
  return { seq: parts.join(''), chords: parts, shown: chords.join(' ') };
}

// ---- macOS: the same "ctrl+s" style, sent through System Events (mac-helper.jxa) as key codes or characters plus modifiers. Cmd is the Mac's
// shortcut key, so it is allowed here; what is refused is what leaves the app or reaches macOS itself.
const MAC_CODES = {
  enter: 36, tab: 48, esc: 53, space: 49, backspace: 51, delete: 117, forwarddelete: 117,
  up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

function macChord(text) {
  const { mods: named, key } = splitChord(text);
  const mods = new Set();
  for (const m of named) {
    if (m === 'win') throw new KeysError('There is no Windows key on a Mac: use cmd.');
    if (m === 'fn') throw new KeysError('The fn (globe) key is not sent: it reaches macOS itself, not the app.');
    mods.add(m === 'cmd' ? 'command' : m === 'ctrl' ? 'control' : m === 'alt' ? 'option' : 'shift');
  }
  const has = (m) => mods.has(m);
  if (/^f([1-9]|1[0-2])$/.test(key)) { // function keys: on their own only; with Cmd, Ctrl or Option (or Shift) they reach macOS's own shortcuts
    if (mods.size) throw new KeysError('A function key is sent only on its own, without Cmd, Ctrl, Option or Shift (those combinations reach macOS itself).');
    if (key === 'f3' || key === 'f11') throw new KeysError(`${key.toUpperCase()} opens Mission Control or shows the desktop, so it is not sent.`);
  }
  const out = { mods: [...mods].sort() };
  if (MAC_CODES[key] !== undefined) out.code = MAC_CODES[key];
  else if (key.length === 1) out.key = key;
  else throw new KeysError(`Not a key: "${key}"`);
  if (has('command') && has('control') && key === 'q') throw new KeysError('Ctrl+Cmd+Q locks the screen, so it is not sent.');
  if (has('command') && has('shift') && key === 'q') throw new KeysError('Shift+Cmd+Q logs out, so it is not sent.');
  if (has('command') && key === 'q') throw new KeysError('Cmd+Q quits the app, so it is not sent. Use the app\'s own Save or Close first.');
  if (has('command') && has('option') && key === 'esc') throw new KeysError('Option+Cmd+Esc opens Force Quit, so it is not sent.');
  if (has('command') && (key === 'tab' || key === '`')) throw new KeysError('Cmd+Tab switches to another app, so it is not sent. Use focus_app.');
  if ((has('command') || has('control')) && key === 'space') throw new KeysError('Cmd+Space and Ctrl+Space open Spotlight or switch the input source, so they are not sent. Use open_app.');
  if (has('control') && !has('command') && ['up', 'down', 'left', 'right'].includes(key)) throw new KeysError('Ctrl+arrow switches Spaces or opens Mission Control, so it is not sent.');
  if (has('command') && has('option') && (key === 'd' || key === 'power')) throw new KeysError('That shortcut changes macOS itself, so it is not sent.');
  return out;
}

// "cmd+s", "cmd+a cmd+c", "Enter" -> { chords: [{ key | code, mods }], shown }. Throws KeysError with a sentence for the AI.
function parseKeysMac(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new KeysError('No keys given. Examples: "cmd+s", "Enter", "cmd+a cmd+c".');
  const chords = joinPlus(text).split(/\s+/);
  if (chords.length > MAX_KEYS) throw new KeysError(`At most ${MAX_KEYS} keys at once.`);
  return { chords: chords.map(macChord), shown: chords.join(' ') };
}

module.exports = { splitChord, parseKeys, parseKeysMac, escapeText, KeysError, MAX_KEYS, MAC_CODES };
