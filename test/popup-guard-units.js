// Pure unit test for features/popup-guard.js: the cap on windows and tabs one page may open in a burst.
const assert = require('assert');
const { createBurstLimit } = require('../src/features/popup-guard');

let clock = 1000;
const limit = createBurstLimit({ max: 3, windowMs: 1000, now: () => clock });
assert.deepStrictEqual([limit.allow(), limit.allow(), limit.allow()], [true, true, true], 'up to max go ahead');
assert.strictEqual(limit.allow(), false, 'the next one in the same burst is refused');
clock += 900;
assert.strictEqual(limit.allow(), false, 'a page that keeps going stays blocked (refused tries count)');
clock += 1100;
assert.strictEqual(limit.allow(), true, 'after a whole quiet window it may open again');

// A person opening tabs at a normal pace is never limited.
clock = 0;
const slow = createBurstLimit({ now: () => clock });
for (let i = 0; i < 50; i++) { clock += 700; assert.strictEqual(slow.allow(), true, `tab ${i}`); }

// Separate openers have separate limits.
const a = createBurstLimit({ max: 1, now: () => clock });
const b = createBurstLimit({ max: 1, now: () => clock });
assert.strictEqual(a.allow(), true);
assert.strictEqual(a.allow(), false);
assert.strictEqual(b.allow(), true);

// A loop of 1000 opens in a millisecond lets only `max` through.
const spam = createBurstLimit({ max: 8, now: () => clock });
let opened = 0;
for (let i = 0; i < 1000; i++) if (spam.allow()) opened++;
assert.strictEqual(opened, 8);

console.log('popup guard: all passed');

// Downloads: what is held for approval (features/downloads.js RISKY_TYPES, shared with private windows).
const { RISKY_TYPES } = require('../src/features/downloads');
const path = require('path');
for (const name of ['setup.exe', 'SETUP.EXE', 'a.msi', 'a.msp', 'run.bat', 'x.cmd', 'x.ps1', 'x.psm1', 'x.vbs', 'x.js', 'x.hta', 'x.jar', 'x.jnlp', 'a.lnk', 'a.url', 'a.scf', 'a.inf', 'a.cpl', 'a.pif', 'a.wsh', 'a.sct', 'a.appinstaller', 'a.msixbundle', 'a.application', 'a.diagcab', 'a.settingcontent-ms', 'a.reg']) assert.ok(RISKY_TYPES.test(path.extname(name)), `${name} is held`);
for (const name of ['report.pdf', 'photo.jpg', 'notes.txt', 'data.json', 'ubuntu.iso', 'archive.zip', 'page.html', 'song.mp3', 'exe', 'readme.exe.txt']) assert.ok(!RISKY_TYPES.test(path.extname(name)), `${name} is not held`);
console.log('downloads: risky types ok');
