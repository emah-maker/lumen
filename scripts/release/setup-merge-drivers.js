#!/usr/bin/env node
// Registers the merge drivers that .gitattributes names, in this repository's local git config (git never reads drivers from
// the repo itself). Run once per clone: `node scripts/release/setup-merge-drivers.js` (`--check` shows the state, `--remove` undoes it).
//   lumen-changelog  CHANGELOG.md: both sides adding bullets under "## Unreleased" merges cleanly; anything else both sides changed conflicts.
//   lumen-list       scripts/test/test-all.js: the SUITES list is merged by name.
//   lumen-bundle     the generated bundles: keep ours; scripts/release/land.js rebuilds them from the merged sources (after a manual merge, run
//                    node scripts/build/bundle-renderer.js and node scripts/build/bundle-preload.js yourself).
// Everything still works without the drivers: scripts/release/land.js resolves the same files itself after a conflicting merge.
const { spawnSync } = require('child_process');
const path = require('path');

const GUARD = (kind) => `[ -f scripts/release/merge-driver.js ] || exec git merge-file -L ours -L base -L theirs %A %O %B; exec node scripts/release/merge-driver.js ${kind} %O %A %B`;
const DRIVERS = {
  'lumen-changelog': { name: 'Lumen CHANGELOG: union of the Unreleased bullets', driver: (script) => (script ? `node "${script}" changelog %O %A %B` : GUARD('changelog')) },
  'lumen-list': { name: 'Lumen test-all.js: union of the suite list', driver: (script) => (script ? `node "${script}" list %O %A %B` : GUARD('list')) },
  'lumen-bundle': { name: 'Lumen generated bundles: keep ours, land.js rebuilds', driver: () => 'true' },
};

const git = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// opts.script: absolute path of merge-driver.js to put in the command (tests); by default the command runs scripts/release/merge-driver.js
// from the work tree being merged into and falls back to git's plain merge when that file does not exist (an older branch).
function register(repo, opts = {}) {
  for (const [id, d] of Object.entries(DRIVERS)) {
    for (const [key, value] of [['name', d.name], ['driver', d.driver(opts.script)]]) {
      const r = git(repo, 'config', '--local', `merge.${id}.${key}`, value);
      if (r.status !== 0) throw new Error(`git config merge.${id}.${key} failed: ${r.stderr.trim()}`);
    }
  }
}

function unregister(repo) {
  for (const id of Object.keys(DRIVERS)) git(repo, 'config', '--local', '--remove-section', `merge.${id}`);
}

function installed(repo) {
  return Object.keys(DRIVERS).filter((id) => git(repo, 'config', '--local', '--get', `merge.${id}.driver`).status === 0);
}

module.exports = { register, unregister, installed, DRIVERS };

if (require.main === module) {
  const repo = path.join(__dirname, '..', '..');
  const arg = process.argv[2];
  if (arg === '--remove') { unregister(repo); console.log('merge drivers removed'); }
  else if (arg === '--check') {
    const have = installed(repo);
    for (const id of Object.keys(DRIVERS)) console.log(`${have.includes(id) ? 'installed ' : 'missing   '} ${id}`);
    process.exit(have.length === Object.keys(DRIVERS).length ? 0 : 1);
  } else if (arg) { console.error('usage: setup-merge-drivers.js [--check | --remove]'); process.exit(2); }
  else { register(repo); console.log(`registered ${Object.keys(DRIVERS).join(', ')} in ${path.join(repo, '.git')} (local config)`); }
}
