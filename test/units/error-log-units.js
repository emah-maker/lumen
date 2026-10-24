// error-log: the size-capped main-process error log (diagnostics/main-errors.log). Plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, format, clean } = require('../../src/features/error-log');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-errlog-'));
const home = path.join(root, 'home', 'someone');
const NL = String.fromCharCode(10);

// one line: ISO time, kind, message, stack; no address, no home folder
{
  const err = new Error(`failed to load https://example.com/a?token=abc and ${home}${path.sep}file`);
  err.stack = `Error: x${NL}    at f (${home}${path.sep}app.js:1:1)${NL}    at g (node:internal:2:2)`;
  const line = format('uncaughtException', err, { now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), home });
  const f = line.split('\t');
  check('four tab-separated fields, one line', f.length === 4 && !line.includes(NL), line);
  check('ISO time and kind first', f[0] === '2026-01-02T03:04:05.000Z' && f[1] === 'uncaughtException', f.slice(0, 2).join('|'));
  check('web addresses are removed', !line.includes('example.com') && f[2].includes('<url>'), f[2]);
  check('the home folder is removed', !line.includes(home) && f[2].includes('~') && f[3].includes('~'), line);
  check('the stack keeps its frames, joined on one line', f[3].includes('at f (') && f[3].includes('at g ('), f[3]);
}
check('a string, a number, undefined and null are all fine', ['x', 5, undefined, null, { a: 1 }].every((v) => format('k', v, { home }).split('\t').length === 4), '');
check('a circular object does not throw', (() => { const o = {}; o.o = o; return format('k', o, { home }).split('\t').length === 4; })(), '');
check('an object whose getters throw does not throw', (() => { const o = { get message() { throw new Error('boom'); } }; return typeof format('k', o, { home }) === 'string'; })(), '');
check('a long message and stack are trimmed', (() => { const l = format('k', { message: 'm'.repeat(5000), stack: `${NL}    at ${'s'.repeat(9000)}` }, { home }); return l.length < 3300; })(), '');
check('clean leaves other text alone', clean('plain words', home) === 'plain words', '');

// append, rotate at the cap, tail
{
  const dir = path.join(root, 'diag');
  const log = create({ dir: () => dir, maxBytes: 600, home });
  check('log returns true and creates the folder', log.log('unhandledRejection', new Error('one')) === true && fs.existsSync(path.join(dir, 'main-errors.log')), '');
  for (let i = 0; i < 12; i++) log.log('test', `entry number ${i} ${'x'.repeat(40)}`);
  const size = fs.statSync(path.join(dir, 'main-errors.log')).size;
  check('the file is rotated to .1 past the cap and stays small', fs.existsSync(path.join(dir, 'main-errors.log.1')) && size <= 600 + 200, `size ${size}`);
  check('only one rotated file is kept', fs.readdirSync(dir).sort().join() === 'main-errors.log,main-errors.log.1', fs.readdirSync(dir).join());
  const tail = log.tail(3);
  check('tail gives the newest lines last', tail.length <= 3 && tail[tail.length - 1].includes('entry number 11'), tail.join(NL));
}

// never throws, never recurses
{
  const blocker = path.join(root, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const bad = create({ dir: () => path.join(blocker, 'sub'), home });
  let r; let threw = false;
  try { r = bad.log('k', new Error('x')); } catch { threw = true; }
  check('an unwritable folder returns false without throwing', !threw && r === false, '');
  check('tail of a missing file is empty', bad.tail().length === 0, '');
  const thrower = create({ dir: () => { throw new Error('no profile yet'); }, home });
  let t2 = false;
  try { thrower.log('k', 'x'); thrower.tail(); } catch { t2 = true; }
  check('a failing folder lookup does not throw', !t2, '');
}

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
