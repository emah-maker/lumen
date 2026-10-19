// ---------- page zoom stops, as in Chrome ----------
//
// Ctrl+= / Ctrl+- (and Ctrl+wheel) used to move Electron's zoom level by 0.5, about 10% a press with
// odd in-between values (110%, 120%, 144%…). Chrome walks a fixed list instead, so the pill always
// shows a familiar number. nextLevel() takes the page's current Electron zoom level and returns the
// level of the next stop in the direction asked, from whatever level the page is on (a Settings
// default or an odd value just snaps to the stop beyond it).

const STOPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const LOG = Math.log(1.2); // Electron's zoom level is log base 1.2 of the factor

const levelOf = (percent) => Math.log(percent / 100) / LOG;
const percentOf = (level) => 100 * 1.2 ** level;

// dir > 0 zooms in, dir < 0 out. Stays put at the ends of the list.
function nextLevel(level, dir) {
  const here = Number.isFinite(level) ? level : 0;
  const now = percentOf(here);
  const EPS = 0.5; // a stop reached through level rounding (100.0004%) counts as being on it
  const stop = dir > 0 ? STOPS.find((p) => p > now + EPS) : [...STOPS].reverse().find((p) => p < now - EPS);
  return stop === undefined ? here : levelOf(stop);
}

// The zoom step a key press asks for: 0.5 in, -0.5 out, 0 reset, null when it is not a zoom key. The character wins
// ("-" "=" "+" "0", numpad keys report them too); the physical key (code) covers layouts and modifiers that report
// something else (Ctrl+Shift+= is "+", but a Ctrl-chorded numpad key or a non-Latin layout may not report any of them).
const KEY_STEPS = { '=': 0.5, '+': 0.5, '-': -0.5, '_': -0.5, '0': 0 };
const CODE_STEPS = { Equal: 0.5, NumpadAdd: 0.5, Minus: -0.5, NumpadSubtract: -0.5, Numpad0: 0 };
function zoomKeyStep(input) {
  const key = String(input && input.key || '');
  if (Object.hasOwn(KEY_STEPS, key)) return KEY_STEPS[key];
  const code = String(input && input.code || '');
  if (Object.hasOwn(CODE_STEPS, code) && !/^[a-z0-9]$/i.test(key)) return CODE_STEPS[code];
  return null;
}

module.exports = { STOPS, nextLevel, levelOf, percentOf, zoomKeyStep };
