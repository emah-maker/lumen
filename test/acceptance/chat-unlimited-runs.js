// ACCEPTANCE (feature: unlimited-setting). Run alone: node scripts/test-acceptance.js chat-unlimited-runs
//
// Settings > AI > "Chats working at once" (maxChatRuns): 0 means no limit, and it is the default. Any other value
// still caps the chats working at once, with the rest waiting their turn. Plain Node, no fakes needed.
// Expected to FAIL on main: the default is 3 and 0 is clamped up to 1.
const fs = require('fs');
const path = require('path');
const TC = require('../../src/features/tab-chats');
const { DEFAULTS, validate } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = (v) => JSON.stringify(v);

check('setting: the default is 0 (no limit)', DEFAULTS.maxChatRuns === 0, DEFAULTS.maxChatRuns);
check('setting: 0 is a valid value (kept, not rejected or raised)', validate('maxChatRuns', 0) === 0, J(validate('maxChatRuns', 0)));
check('setting: the existing caps are still valid', [1, 2, 3, 4, 6, 8].every((n) => validate('maxChatRuns', n) === n), J([1, 2, 3, 4, 6, 8].map((n) => validate('maxChatRuns', n))));
check('setting: junk is still rejected', validate('maxChatRuns', -1) === null && validate('maxChatRuns', 'lots') === null, J([validate('maxChatRuns', -1), validate('maxChatRuns', 'lots')]));

const fill = (slots, n, kind = 'api', prefix = 'c') => Array.from({ length: n }, (_, i) => slots.request(`${prefix}${i}`, { kind, start() {} }));
{
  const s = TC.createRunSlots({ max: 0 });
  const got = fill(s, 20);
  check('slots: with 0, twenty chats all start at once and none waits', got.every((r) => r === 'started') && s.size() === 20 && s.waitingIds().length === 0, J({ queued: got.filter((r) => r !== 'started').length }));
  const cli = fill(s, 4, 'cli', 'k');
  check('slots: with 0, CLI chats start at once too', cli.every((r) => r === 'started'), J(cli));
}
{
  const s = TC.createRunSlots({ max: DEFAULTS.maxChatRuns });
  check('slots: built from the default setting, a dozen chats all start', fill(s, 12).every((r) => r === 'started'), J(s.waitingIds()));
}
{
  const s = TC.createRunSlots({ max: 1 });
  fill(s, 5);
  check('slots: a cap of 1 still makes the others wait (baseline)', s.size() === 1 && s.waitingIds().length === 4, J(s.waitingIds()));
  s.setMax(0);
  check('slots: switching the setting to 0 starts every waiting chat right away', s.size() === 5 && s.waitingIds().length === 0, J({ running: s.size(), waiting: s.waitingIds() }));
  s.setMax(2);
  check('slots: switching back to a cap lets no new chat start past it', s.request('late', { start() {} }) === 'queued', s.state('late'));
}

// The Settings page offers it (static: the select's options, as maxSteps does for its own "Unlimited").
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'settings.js'), 'utf8');
  const at = src.indexOf("select('maxChatRuns'");
  const seg = at >= 0 ? src.slice(at, src.indexOf('{ number: true }', at)) : '';
  check('settings page: "Chats working at once" offers a no-limit choice (value 0)', /\[\s*0\s*,/.test(seg) && /unlimited|no limit/i.test(seg), seg.slice(0, 300));
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
