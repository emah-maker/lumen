#!/usr/bin/env node
// Git merge driver for CHANGELOG.md and scripts/test-all.js (registered by scripts/setup-merge-drivers.js, selected in .gitattributes).
// Usage (git fills in the placeholders): node scripts/merge-driver.js <changelog|list> <base> <ours> <theirs>
// A clean merge is written over <ours> and the driver exits 0. When the two sides really disagree it falls back to `git merge-file`,
// which leaves ordinary conflict markers in <ours> and exits non-zero, so nothing is ever resolved silently.
const fs = require('fs');
const { spawnSync } = require('child_process');
const { mergeChangelog, mergeSuiteList } = require('./release-lib');

const [kind, base, ours, theirs] = process.argv.slice(2);
if (!['changelog', 'list'].includes(kind) || !base || !ours || !theirs) {
  console.error('usage: merge-driver.js <changelog|list> <base> <ours> <theirs>');
  process.exit(2);
}
const read = (f) => fs.readFileSync(f, 'utf8');
let result = { ok: false };
try {
  result = (kind === 'changelog' ? mergeChangelog : mergeSuiteList)(read(base), read(ours), read(theirs));
} catch (err) {
  console.error(`merge-driver: ${err.message}`);
}
if (result.ok) {
  fs.writeFileSync(ours, result.text);
  process.exit(0);
}
const fallback = spawnSync('git', ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', ours, base, theirs], { stdio: 'inherit' });
process.exit(fallback.status === null ? 1 : fallback.status);
