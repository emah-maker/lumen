#!/usr/bin/env node
// What release.yml runs to publish the artifacts of an earlier build instead of building again (the pure rules are in release-lib.js).
//   node scripts/release-reuse.js manifest --win <dir> --mac <dir> --out <file>   write the manifest of a build (every file's SHA-256, the commit's tree)
//   node scripts/release-reuse.js find                                            tag runs: print reuse_run=<id> (or empty) for GITHUB_OUTPUT
//   node scripts/release-reuse.js fetch --run <id> --dir <dist>                   download that run's artifacts, check them against its manifest, flatten into <dist>
// A build is reused only when its manifest's tree equals the tagged commit's tree and the version matches (the same files, bit for bit: a squash
// merge has a new commit SHA but the same tree when main did not move), and every downloaded file matches its recorded checksum.
// `find` and `fetch` need gh with GH_TOKEN (actions: read). Never publishes anything.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./ship-common');
const lib = require('./release-lib');

const MANIFEST_ARTIFACT = 'lumen-manifest';
const MANIFEST_FILE = 'release-manifest.json';
const PLATFORM_ARTIFACTS = { win: 'lumen-win', mac: 'lumen-mac' };

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const filesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
const treeOf = (cwd) => { const r = run('git', ['rev-parse', 'HEAD^{tree}'], { cwd }); if (r.status !== 0) throw new Error(`git rev-parse HEAD^{tree} failed: ${r.stderr}`); return r.stdout; };
const versionOf = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version;
const arg = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// The manifest of a finished build: { win: dir, mac: dir } hold what each platform job uploaded.
function writeManifest({ dirs, cwd, sha, out }) {
  const files = [];
  for (const [platform, dir] of Object.entries(dirs)) for (const name of filesIn(dir)) files.push({ name, platform, sha256: sha256File(path.join(dir, name)), size: fs.statSync(path.join(dir, name)).size });
  const manifest = lib.buildManifest({ version: versionOf(cwd), sha, tree: treeOf(cwd), files });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// gh run download of one artifact into a fresh directory; null when it is gone or was never made.
function download(runId, name, dir, tries = 3) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= tries; i++) {
    if (run('gh', ['run', 'download', String(runId), '-n', name, '-D', dir]).status === 0) return true;
    if (i < tries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000 * i); // a transient network error: wait, then try again
  }
  return false;
}

// The newest successful dispatch run whose manifest says it built exactly this tree and version, or null.
function findReusableRun({ cwd, list = () => null, fetchManifest = null }) {
  const tree = treeOf(cwd);
  const version = versionOf(cwd);
  const runs = list() || [];
  for (const r of runs.slice(0, 15)) {
    const manifest = fetchManifest(r.databaseId);
    if (!manifest) { console.error(`run ${r.databaseId}: no manifest (expired or not a preflight)`); continue; }
    const v = lib.artifactsReusable({ manifest, tree, version });
    console.error(`run ${r.databaseId}: ${v.ok ? 'MATCHES' : 'no'} (${v.reason})`);
    if (v.ok) return r.databaseId;
  }
  return null;
}

function ghList() {
  const r = run('gh', ['run', 'list', '--workflow', 'release.yml', '--event', 'workflow_dispatch', '--status', 'success', '--limit', '40', '--json', 'databaseId,headSha,createdAt']);
  if (r.status !== 0) { console.error(`gh run list failed: ${r.stderr}`); return []; }
  return JSON.parse(r.stdout || '[]').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function ghManifest(runId, tries = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-manifest-'));
  try {
    if (!download(runId, MANIFEST_ARTIFACT, dir, tries)) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Download the run's two platform artifacts, verify them against its manifest and the tag's tree, and flatten into `dist`.
function fetchArtifacts({ runId, dist, cwd }) {
  const manifest = ghManifest(runId, 3);
  const v = lib.artifactsReusable({ manifest, tree: treeOf(cwd), version: versionOf(cwd) });
  if (!v.ok) throw new Error(`run ${runId} cannot be reused: ${v.reason}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reuse-'));
  try {
    const actual = {};
    fs.mkdirSync(dist, { recursive: true });
    for (const [platform, artifact] of Object.entries(PLATFORM_ARTIFACTS)) {
      const dir = path.join(tmp, platform);
      if (!download(runId, artifact, dir)) throw new Error(`run ${runId}: artifact ${artifact} could not be downloaded`);
      for (const name of filesIn(dir)) {
        if (name in actual) throw new Error(`${name} appears in both platform artifacts`);
        actual[name] = sha256File(path.join(dir, name));
        fs.copyFileSync(path.join(dir, name), path.join(dist, name));
      }
    }
    const c = lib.verifyChecksums(manifest, actual);
    if (!c.ok) { for (const f of Object.keys(actual)) fs.rmSync(path.join(dist, f), { force: true }); throw new Error(`checksum check failed: ${c.problems.join('; ')}`); }
    console.error(`run ${runId}: ${manifest.files.length} files match the manifest (version ${manifest.version}, tree ${manifest.tree.slice(0, 12)}, built from ${String(manifest.sha).slice(0, 12)})`);
    return manifest;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function cli() {
  const [cmd, ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  try {
    if (cmd === 'manifest') {
      const m = writeManifest({ dirs: { win: arg(args, '--win'), mac: arg(args, '--mac') }, cwd, sha: process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD'], { cwd }).stdout, out: arg(args, '--out') || MANIFEST_FILE });
      console.error(`manifest: ${m.files.length} files, version ${m.version}, tree ${m.tree.slice(0, 12)}`);
    } else if (cmd === 'find') {
      const id = findReusableRun({ cwd, list: ghList, fetchManifest: ghManifest });
      console.log(`reuse_run=${id || ''}`);
      console.error(id ? `publishing the artifacts of run ${id}` : 'no matching preflight: this run builds');
    } else if (cmd === 'fetch') {
      fetchArtifacts({ runId: arg(args, '--run'), dist: arg(args, '--dir') || 'dist', cwd });
    } else { console.error('usage: release-reuse.js manifest|find|fetch'); process.exit(2); }
  } catch (err) { console.error(`release-reuse ${cmd}: ${err.message}`); process.exit(1); }
}

if (require.main === module) cli();
module.exports = { writeManifest, findReusableRun, sha256File, treeOf, MANIFEST_ARTIFACT, MANIFEST_FILE, PLATFORM_ARTIFACTS };
