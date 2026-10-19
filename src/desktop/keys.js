// [desktop apps] press_keys: "ctrl+s", "Enter", "ctrl+a ctrl+c" -> the string SendKeys wants ("^s", "{ENTER}", "^a^c"), and the shortcuts the AI is
// never allowed to send (they leave the app it was let into, close it without asking, or reach Windows itself). Typed text is escaped the
// same way, so "50% (done)" is typed as written. Pure: test/desktop-units.js.
'use strict';

const NAMED = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ', backspace: '{BS}', bs: '{BS}', delete: '{DEL}', del: '{DEL}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pgup: '{PGUP}', pagedown: '{PGDN}', pgdn: '{PGDN}',
  insert: '{INS}', ins: '{INS}', capslock: '{CAPSLOCK}', numlock: '{NUMLOCK}', scrolllock: '{SCROLLLOCK}', printscreen: '{PRTSC}',
};
const MODS = { ctrl: '^', control: '^', shift: '+', alt: '%', option: '%' };
const MAX_KEYS = 40;

class KeysError extends Error {}

const escapeText = (text) => String(text ?? '').replace(/[+^%~(){}[\]]/g, '{$&}').replace(/\r\n|\r|\n/g, '{ENTER}');

function chord(text) {
  const parts = String(text).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new KeysError(`Not a key: "${text}"`);
  const key = parts.pop();
  let prefix = '';
  const mods = new Set();
  for (const m of parts) {
    if (m === 'win' || m === 'windows' || m === 'meta' || m === 'cmd' || m === 'super') throw new KeysError('The Windows key is not sent: it reaches Windows itself, not the app.');
    if (!MODS[m]) throw new KeysError(`Not a modifier: "${m}" (use ctrl, shift or alt)`);
    mods.add(m);
    prefix += MODS[m];
  }
  let sent;
  if (NAMED[key]) sent = NAMED[key];
  else if (/^f([1-9]|1[0-2])$/.test(key)) sent = `{${key.toUpperCase()}}`;
  else if (key.length === 1) sent = escapeText(key);
  else throw new KeysError(`Not a key: "${key}"`);
  const ctrl = mods.has('ctrl') || mods.has('control');
  const alt = mods.has('alt') || mods.has('option');
  if (alt && key === 'f4') throw new KeysError('Alt+F4 closes the app without asking, so it is not sent. Use the app\'s own Close or Save first.');
  if (ctrl && alt && (key === 'delete' || key === 'del')) throw new KeysError('Ctrl+Alt+Delete is not sent.');
  if (ctrl && mods.has('shift') && key === 'esc') throw new KeysError('Ctrl+Shift+Esc opens the Task Manager, so it is not sent.');
  if (alt && key === 'tab') throw new KeysError('Alt+Tab switches to another app, so it is not sent. Use focus_app.');
  if (ctrl && key === 'esc') throw new KeysError('Ctrl+Esc opens the Start menu, so it is not sent.');
  const withMods = prefix && sent.length > 1 && !sent.startsWith('{') ? `${prefix}(${sent})` : `${prefix}${sent}`;
  return withMods;
}

// "ctrl+s", "ctrl+a ctrl+c", "Enter" -> { seq, shown }. Throws KeysError with a sentence for the AI.
function parseKeys(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new KeysError('No keys given. Examples: "ctrl+s", "Enter", "ctrl+a ctrl+c".');
  const chords = text.split(/\s+/);
  if (chords.length > MAX_KEYS) throw new KeysError(`At most ${MAX_KEYS} keys at once.`);
  const parts = chords.map(chord); // one entry per chord: the helper sends them one at a time, checking the focus before each
  return { seq: parts.join(''), chords: parts, shown: chords.join(' ') };
}

// ---- macOS: the same "ctrl+s" style, sent through System Events (mac-helper.jxa) as key codes or characters plus modifiers. Cmd is the Mac's
// shortcut key, so it is allowed here; what is refused is what leaves the app or reaches macOS itself.
const MAC_CODES = {
  enter: 36, return: 36, tab: 48, esc: 53, escape: 53, space: 49, backspace: 51, bs: 51, delete: 117, del: 117, forwarddelete: 117,
  up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pgup: 116, pagedown: 121, pgdn: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MAC_MODS = { cmd: 'command', command: 'command', meta: 'command', ctrl: 'control', control: 'control', shift: 'shift', alt: 'option', option: 'option', opt: 'option' };

function macChord(text) {
  const parts = String(text).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new KeysError(`Not a key: "${text}"`);
  const key = parts.pop();
  const mods = new Set();
  for (const m of parts) {
    if (m === 'win' || m === 'windows' || m === 'super') throw new KeysError('There is no Windows key on a Mac: use cmd.');
    if (m === 'fn' || m === 'globe') throw new KeysError('The fn (globe) key is not sent: it reaches macOS itself, not the app.');
    if (!MAC_MODS[m]) throw new KeysError(`Not a modifier: "${m}" (use cmd, ctrl, shift or option)`);
    mods.add(MAC_MODS[m]);
  }
  const has = (m) => mods.has(m);
  const out = { mods: [...mods].sort() };
  if (MAC_CODES[key] !== undefined) out.code = MAC_CODES[key];
  else if (key.length === 1) out.key = key;
  else throw new KeysError(`Not a key: "${key}"`);
  if (has('command') && has('control') && key === 'q') throw new KeysError('Ctrl+Cmd+Q locks the screen, so it is not sent.');
  if (has('command') && has('shift') && key === 'q') throw new KeysError('Shift+Cmd+Q logs out, so it is not sent.');
  if (has('command') && key === 'q') throw new KeysError('Cmd+Q quits the app, so it is not sent. Use the app\'s own Save or Close first.');
  if (has('command') && has('option') && (key === 'esc' || key === 'escape')) throw new KeysError('Option+Cmd+Esc opens Force Quit, so it is not sent.');
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
  const chords = text.split(/\s+/);
  if (chords.length > MAX_KEYS) throw new KeysError(`At most ${MAX_KEYS} keys at once.`);
  return { chords: chords.map(macChord), shown: chords.join(' ') };
}

module.exports = { parseKeys, parseKeysMac, escapeText, KeysError, MAX_KEYS, MAC_CODES };
