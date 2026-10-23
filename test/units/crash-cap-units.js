// crash-cap: the rolling "three crashes in a minute" cap shared by the chat page and the browser UI window. Plain Node.
const { crashBurst } = require('../../src/features/crash-cap');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

let times;
const rs = [];
for (const at of [0, 1000, 2000, 3000]) { const b = crashBurst(times, at); times = b.times; rs.push(b.reload); }
check('first three crashes reload, the fourth does not', rs.join() === 'true,true,true,false', rs.join());
check('crashes older than a minute no longer count', crashBurst(times, 60e3 + 2000).reload === true && crashBurst(times, 60e3 + 2000).times.length === 2, '');
check('undefined or junk history is a first crash', crashBurst(undefined, 5).reload && crashBurst('x', 5).times.length === 1, '');
check('custom max and window', !crashBurst([1, 2], 3, { max: 2 }).reload && crashBurst([1, 2], 100, { max: 2, windowMs: 10 }).reload, '');
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
