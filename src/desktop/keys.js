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

module.exports = { parseKeys, escapeText, KeysError, MAX_KEYS };
