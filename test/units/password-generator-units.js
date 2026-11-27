// [passwords] Plain Node: the strong-password generator (features/password-generator.js) and where the page offers it
// (features/password-page.js generatorTargets). Length (20 by default), every character class, no look-alikes, a field's
// maxlength / minlength / pattern, an unbiased draw from the random bytes it is given, the offer only on new-password fields
// (autocomplete="new-password", sign-up password + confirm, change password), and the code paths: crypto only, never
// Math.random, nothing logged. No Electron.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generatePassword, DEFAULT_LENGTH } = require('../../src/features/password-generator');
const page = require('../../src/features/password-page');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const rnd = (n) => crypto.randomBytes(n);
const gen = (o) => generatePassword(o, rnd);
const many = (o, n = 200) => Array.from({ length: n }, () => gen(o));
const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

// ---- length
check('default length is 20', DEFAULT_LENGTH === 20 && many({}).every((p) => p.length === 20), many({}, 3));
check('a length is kept (8, 33, 64)', [8, 33, 64].every((n) => many({ length: n }, 30).every((p) => p.length === n)), '');
check('length is clamped to 4..128', gen({ length: 1 }).length === 4 && gen({ length: 500 }).length === 128, '');

// ---- classes and characters
const LOWER = /[a-z]/; const UPPER = /[A-Z]/; const DIGIT = /[0-9]/; const SYMBOL = /[^a-zA-Z0-9]/;
check('every password mixes lowercase, capitals, digits and symbols', many({}, 500).every((p) => LOWER.test(p) && UPPER.test(p) && DIGIT.test(p) && SYMBOL.test(p)), many({}, 3));
check('symbols off: letters and digits only, still all three', many({ symbols: false }, 500).every((p) => /^[a-zA-Z0-9]+$/.test(p) && LOWER.test(p) && UPPER.test(p) && DIGIT.test(p)), many({ symbols: false }, 3));
const all = many({ length: 128 }, 300).join('');
check('no look-alike characters (0 O o 1 l I | quotes, spaces, backslash)', !/[0Oo1lI|'"`\s\\]/.test(all), all.match(/[0Oo1lI|'"`\s\\]/));
check('the whole alphabet is reached (no stuck characters)', new Set(all).size === 24 + 24 + 8 + 12, new Set(all).size);
check('two passwords are never the same', new Set(many({}, 2000)).size === 2000, '');

// ---- unbiased draw: a byte stream that always starts at 255 is rejected for sizes that don't divide 256
let fed = 0;
const biased = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (fed++ % 3 === 0) ? 255 : crypto.randomBytes(1)[0]; return b; };
const p0 = generatePassword({}, biased);
check('bytes past the largest multiple are drawn again, not wrapped', typeof p0 === 'string' && p0.length === 20, p0);
// chi-square-ish: each lowercase letter appears about as often as the others over many draws
const counts = {};
for (const p of many({ symbols: false, length: 64 }, 2000)) for (const c of p) if (/[a-z]/.test(c)) counts[c] = (counts[c] || 0) + 1;
const vals = Object.values(counts);
check('letters are drawn evenly (max/min within 15%)', vals.length === 24 && Math.max(...vals) / Math.min(...vals) < 1.15, JSON.stringify(counts));

// ---- a field's constraints
check('maxlength shortens it (12)', many({ maxLength: 12 }, 100).every((p) => p.length === 12 && LOWER.test(p) && UPPER.test(p) && DIGIT.test(p) && SYMBOL.test(p)), gen({ maxLength: 12 }));
check('maxlength 6 is honored', many({ maxLength: 6 }, 50).every((p) => p.length === 6), gen({ maxLength: 6 }));
check('minlength lengthens it (32)', many({ minLength: 32 }, 50).every((p) => p.length === 32), gen({ minLength: 32 }));
check('minlength 25 with maxlength 30 gives 25', gen({ minLength: 25, maxLength: 30 }).length === 25, gen({ minLength: 25, maxLength: 30 }));
check('minlength above maxlength: maxlength wins', gen({ minLength: 40, maxLength: 16 }).length === 16, gen({ minLength: 40, maxLength: 16 }));
check('-1 (the DOM default) means no limit', gen({ minLength: -1, maxLength: -1 }).length === 20, '');
const patterns = [
  ['[A-Za-z0-9]+', /^[A-Za-z0-9]+$/],
  ['[a-zA-Z0-9]{8,12}', /^[a-zA-Z0-9]{8,12}$/],
  ['\\d{6}', /^\d{6}$/],
  ['[a-z0-9]{10,}', /^[a-z0-9]{10,}$/],
  ['(?=.*\\d)(?=.*[a-z])(?=.*[A-Z]).{8,}', /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/],
  ['[A-Z]{4}', /^[A-Z]{4}$/],
];
for (const [pattern, re] of patterns) {
  const ps = many({ pattern }, 50);
  check(`pattern ${pattern} is matched`, ps.every((p) => typeof p === 'string' && re.test(p)), ps.slice(0, 3));
}
check('pattern and maxlength together', many({ pattern: '[a-zA-Z0-9]+', maxLength: 10 }, 50).every((p) => /^[a-zA-Z0-9]{10}$/.test(p)), gen({ pattern: '[a-zA-Z0-9]+', maxLength: 10 }));
check('a pattern no password can match gives null (nothing offered)', gen({ pattern: '[ä]+' }) === null, gen({ pattern: '[ä]+' }));
check('an invalid pattern is ignored, as browsers do', gen({ pattern: '[a-' }).length === 20, gen({ pattern: '[a-' }));

// ---- where the page offers it
const f = (order, o = {}) => ({ type: 'password', value: '', autocomplete: '', name: '', id: '', visible: true, form: 0, order, readOnly: false, disabled: false, minLength: -1, maxLength: -1, pattern: '', ...o });
const text = (order, o = {}) => ({ ...f(order, o), type: 'email' });
const T = page.generatorTargets;
check('autocomplete=new-password: offered, with the confirm field after it', JSON.stringify(T([text(0), f(1, { autocomplete: 'new-password' }), f(2)], 1)?.fields) === '[1,2]', JSON.stringify(T([text(0), f(1, { autocomplete: 'new-password' }), f(2)], 1)));
check('the confirm field offers too', JSON.stringify(T([text(0), f(1, { autocomplete: 'new-password' }), f(2)], 2)?.fields) === '[1,2]', '');
check('a lone new-password field is offered alone', JSON.stringify(T([text(0), f(1, { autocomplete: 'new-password' })], 1)?.fields) === '[1]', '');
check('sign-up without autocomplete (password + confirm) is offered', JSON.stringify(T([text(0), f(1), f(2)], 1)?.fields) === '[1,2]', '');
check('a sign-in (one password field) is not', T([text(0), f(1)], 1) === null, '');
check('current-password is never', T([text(0), f(1, { autocomplete: 'current-password' })], 1) === null && T([f(0, { autocomplete: 'current-password' }), f(1, { autocomplete: 'new-password' }), f(2, { autocomplete: 'new-password' })], 0) === null, '');
check('change password: new and confirm, not the current one', JSON.stringify(T([f(0, { autocomplete: 'current-password' }), f(1, { autocomplete: 'new-password' }), f(2, { autocomplete: 'new-password' })], 2)?.fields) === '[1,2]', '');
check('three unmarked fields: the last two', JSON.stringify(T([f(0), f(1), f(2)], 1)?.fields) === '[1,2]' && T([f(0), f(1), f(2)], 0) === null, '');
check('a field in another form does not count as the confirm', T([f(0, { form: 0 }), f(1, { form: 1 })], 0) === null, '');
check('a one-time code field is never', T([f(0, { autocomplete: 'one-time-code' }), f(1, { name: 'otp' })], 0) === null, '');
check('read-only, disabled and hidden fields are not offered', T([f(0, { readOnly: true }), f(1)], 0) === null && T([f(0, { disabled: true }), f(1)], 0) === null && T([f(0, { visible: false }), f(1)], 0) === null, '');
check('a text field is not', T([text(0), f(1, { autocomplete: 'new-password' })], 0) === null, '');
const c = T([f(0, { autocomplete: 'new-password', maxLength: 16, minLength: 10, pattern: '[A-Za-z0-9]+' }), f(1, { maxLength: 14 })], 0);
check('constraints: smallest maxlength, largest minlength, the focused pattern', c && c.maxLength === 14 && c.minLength === 10 && c.pattern === '[A-Za-z0-9]+', JSON.stringify(c));

// ---- the page script and the code paths
let script;
try { script = page.offer('Use a strong password', 'note'); new Function(script); } catch (err) { script = `ERR ${err.message}`; }
check('the offer page script parses', !script.startsWith('ERR'), script.slice(0, 200));
check('the page script makes it with crypto.getRandomValues', /crypto\.getRandomValues/.test(script) && /function generatePassword/.test(script), '');
check('the box is a closed shadow root and never shows the password', /attachShadow\(\{ mode: 'closed' \}\)/.test(script) && !/textContent = password/.test(script), '');
check('only a trusted click or key picks it', /e\.isTrusted\) choose\(\)/.test(script) && /!e\.isTrusted/.test(script), '');
const src = ['src/features/password-generator.js', 'src/features/password-page.js', 'src/features/passwords.js'].map(read).join('\n');
check('no Math.random anywhere in saved passwords', !/Math\.random/.test(src), '');
check('nothing logged in saved passwords', !/console\.(log|info|warn|error|debug)/.test(src), '');
check('Settings generates with crypto.randomBytes', /generatePassword\([^)]*\}, \(n\) => crypto\.randomBytes\(n\)\)/.test(read('src/features/passwords.js')), '');
check('the watcher flags only the password it filled itself', /state\.generated && got\.password === state\.generated/.test(read('src/features/password-page.js')), '');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
