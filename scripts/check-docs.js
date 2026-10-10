#!/usr/bin/env node
// The docs check: did a change to Lumen bring its documentation along? Run it by hand (`node scripts/check-docs.js`),
// or let Claude Code run it as a Stop hook (.claude/settings.json): when Claude finishes a turn with changes under src/
// that the docs don't cover yet, the hook sends it back once with the list of what to update (see CLAUDE.md, "Docs").
//
// What counts, comparing the working tree (committed or not) with where the branch left origin/main:
//  - anything under src/ changed, but CHANGELOG.md didn't;
//  - a setting added to DEFAULTS (src/settings/settings-backend.js) with no row in docs/settings.md;
//  - a new docs/*.md that the docs site (site/docs.js) doesn't list;
//  - src/ changed but neither README.md nor anything in docs/ did (only a reminder: not every change is user-visible).
// As a hook it blocks once for a given set of findings (remembered in .git/lumen-docs-check), so an answer like "this
// change is internal, no docs needed" ends the turn the second time. Plain Node, no dependencies.
//
// Options: --repo <dir> (default: this checkout), --hook (read the hook's JSON on stdin and answer in its format),
// --only-if-mentioned (hook: stay quiet unless the session's transcript mentions the repo; for a user-level hook).
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const repo = path.resolve(opt('--repo') || path.join(__dirname, '..'));
const hook = args.includes('--hook');
const onlyIfMentioned = args.includes('--only-if-mentioned');

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const quiet = () => process.exit(0);

function readHookInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// The keys of DEFAULTS in a copy of settings-backend.js.
function settingKeys(source) {
  const start = source.indexOf('const DEFAULTS = {');
  if (start === -1) return [];
  const block = source.slice(start, source.indexOf('\n};', start));
  return [...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
}

function findings() {
  let base;
  try { base = git('merge-base', 'HEAD', 'origin/main'); } catch { return null; } // not a clone of Lumen, or no origin/main
  const changed = new Set([
    ...git('diff', '--name-only', base).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean));
  const src = [...changed].filter((f) => f.startsWith('src/'));
  if (!src.length) return { list: [], changed };
  const list = [];
  if (!changed.has('CHANGELOG.md')) list.push('CHANGELOG.md: add a bullet under "## Unreleased" saying what changed for the user (bold lead sentence, then the details).');

  const settingsFile = 'src/settings/settings-backend.js';
  if (changed.has(settingsFile)) {
    let before = [];
    try { before = settingKeys(git('show', `${base}:${settingsFile}`)); } catch { /* new file */ }
    const now = settingKeys(fs.readFileSync(path.join(repo, settingsFile), 'utf8'));
    const doc = fs.readFileSync(path.join(repo, 'docs', 'settings.md'), 'utf8');
    const missing = now.filter((k) => !before.includes(k) && !doc.includes(`\`${k}\``));
    if (missing.length) list.push(`docs/settings.md: add a row (Setting | Key | Default | What it does) for each new setting: ${missing.join(', ')}.`);
  }

  const added = new Set([...git('diff', '--name-only', '--diff-filter=A', base).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')]);
  const newDocs = [...added].filter((f) => /^docs\/[^/]+\.md$/.test(f)); // (pages added on this branch, not edits to old ones)
  if (newDocs.length) {
    const site = fs.readFileSync(path.join(repo, 'site', 'docs.js'), 'utf8');
    const unlisted = newDocs.filter((f) => fs.existsSync(path.join(repo, f)) && !site.includes(`'${f}'`));
    if (unlisted.length) list.push(`site/docs.js: list ${unlisted.join(', ')} in PAGES (and add a card under Documentation in site/index.html, and a line in the README's Documentation list).`);
  }

  if (!changed.has('README.md') && ![...changed].some((f) => f.startsWith('docs/'))) {
    list.push('README.md / docs/: if this change is something a user can see or set, describe it there (the README section for that area, docs/settings.md, or a docs/<topic>.md page). If it is internal only, say so and stop.');
  }
  return { list, changed };
}

const input = hook ? readHookInput() : {};
if (hook && input.stop_hook_active) quiet(); // already sent back once this turn
if (hook && onlyIfMentioned) {
  // A user-level hook runs in every session: only those that touched this repo are checked.
  let transcript = '';
  try { transcript = fs.readFileSync(input.transcript_path, 'utf8'); } catch { quiet(); }
  if (!transcript.includes(repo) && !transcript.includes(repo.replace(process.env.HOME || '\0', '~'))) quiet();
  // Started inside the repo on a branch that has its own project hook: that one answers.
  try {
    const cwd = fs.realpathSync(input.cwd || '');
    const own = fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8');
    if ((cwd === repo || cwd.startsWith(repo + path.sep)) && own.includes('check-docs.js')) quiet();
  } catch { /* no project hook */ }
}

const result = findings();
if (!result || !result.list.length) {
  if (!hook) console.log(result ? 'Docs check: nothing to update.' : 'Docs check: no origin/main to compare with.');
  quiet();
}

const message = `Lumen docs check. This branch changes src/ (${[...result.changed].filter((f) => f.startsWith('src/')).length} files) and the docs may not cover it yet:\n- ${result.list.join('\n- ')}\nRules: CLAUDE.md, "Docs". Update them now, or say why a point doesn't apply.`;
if (!hook) { console.log(message); process.exit(1); }

// Once per set of findings: the same list a second time means it was already answered.
let gitDir;
try { gitDir = path.resolve(repo, git('rev-parse', '--git-dir')); } catch { quiet(); }
const stamp = path.join(gitDir, 'lumen-docs-check');
const key = crypto.createHash('sha1').update(result.list.join('\n')).update([...result.changed].sort().join('\n')).digest('hex');
try { if (fs.readFileSync(stamp, 'utf8').trim() === key) quiet(); } catch { /* first time */ }
try { fs.writeFileSync(stamp, key); } catch { /* read-only: it may ask again, which is fine */ }
process.stdout.write(JSON.stringify({ decision: 'block', reason: message }));
