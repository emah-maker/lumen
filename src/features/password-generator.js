// ---------- saved passwords: the strong-password generator ----------
// One function, used in two places: features/password-page.js stringifies it into the page script
// that offers "Use a strong password" on a sign-up form (there it draws its randomness from
// crypto.getRandomValues), and features/passwords.js calls it for Settings → Saved passwords →
// Generate a password (crypto.randomBytes). Never the Math library's random numbers.
//
// It is self-contained (stringified into a page, so it uses nothing from outside itself), and the
// password it makes is only returned: never logged, never sent anywhere.

// options: { length = 20, symbols = true, minLength, maxLength, pattern }. minLength, maxLength and
// pattern are a field's own constraints (the HTML attributes; -1, 0, '' or missing: none).
// randomBytes(n) -> n random bytes (a Uint8Array or a Buffer).
// -> a password, or null when no password from these characters fits the field's pattern.
//
// The characters leave out look-alikes (0 O o, 1 l I, quotes and the like). With room for it, every
// password has at least one lowercase letter, capital, digit and (when on) symbol. A pattern is
// honored by trying the full mix first, then smaller character sets and the lengths its quantifiers
// name; an invalid pattern is ignored, as browsers ignore one.
function generatePassword(options, randomBytes) {
  const o = options || {};
  const LOWER = 'abcdefghijkmnpqrstuvwxyz';
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const DIGITS = '23456789';
  const SYMBOLS = '-_.!@#$%*+=?';
  const HARD_MAX = 128;
  const int = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  let max = Math.min(int(o.maxLength) || HARD_MAX, HARD_MAX);
  let min = int(o.minLength);
  if (min > max) min = 0; // a page with minlength above maxlength: maxlength wins
  let length = Math.min(Math.max(int(o.length) || 20, 4), HARD_MAX);
  length = Math.max(Math.min(length, max), min);
  if (length < 1) return null;

  // An unbiased pick from 0..n-1: bytes at or above the largest multiple of n are drawn again.
  let pool = [];
  const nextByte = () => {
    if (!pool.length) pool = Array.from(randomBytes(64));
    return pool.pop();
  };
  const pick = (n) => {
    const limit = 256 - (256 % n);
    for (;;) { const b = nextByte(); if (b < limit) return b % n; }
  };
  const build = (classes, len) => {
    const all = classes.join('');
    const chars = [];
    if (len >= classes.length) for (const c of classes) chars.push(c[pick(c.length)]);
    while (chars.length < len) chars.push(all[pick(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) { const j = pick(i + 1); const t = chars[i]; chars[i] = chars[j]; chars[j] = t; }
    return chars.join('');
  };

  const mix = o.symbols === false ? [LOWER, UPPER, DIGITS] : [LOWER, UPPER, DIGITS, SYMBOLS];
  let re = null;
  if (typeof o.pattern === 'string' && o.pattern) {
    for (const flags of ['v', 'u']) {
      try { re = new RegExp(`^(?:${o.pattern})$`, flags); break; } catch { re = null; }
    }
  }
  if (!re) return build(mix, length);

  // Lengths to try: the chosen one, then the ones the pattern's {n} / {n,m} quantifiers allow.
  const lengths = [length];
  const quant = /\{(\d+)(?:,(\d*))?\}/g;
  let m;
  while ((m = quant.exec(o.pattern))) {
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : m[2] === '' ? HARD_MAX : Number(m[2]);
    const fit = Math.max(Math.min(length, hi), lo);
    if (fit >= Math.max(min, 1) && fit <= max && !lengths.includes(fit)) lengths.push(fit);
  }
  const sets = [mix, [LOWER, UPPER, DIGITS], [LOWER, UPPER], [LOWER, DIGITS], [UPPER, DIGITS], [DIGITS], [LOWER], [UPPER]];
  for (const len of lengths) {
    for (const set of sets) {
      for (let i = 0; i < 40; i++) {
        const p = build(set, len);
        if (re.test(p)) return p;
      }
    }
  }
  return null;
}

const DEFAULT_LENGTH = 20;
const MIN_LENGTH = 8; // Settings' slider
const MAX_LENGTH = 64;

module.exports = { generatePassword, DEFAULT_LENGTH, MIN_LENGTH, MAX_LENGTH };
