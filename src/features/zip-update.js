// ---------- in-app updates by swapping the install (used by features/updates.js) ----------
// Download the release zip for this platform, check its sha512 against the entry latest.yml /
// latest-mac.yml lists for it, unpack it next to the install, and on restart swap the folders once
// Lumen has exited. The profile lives in userData, outside the install, so it is never touched; the
// NSIS uninstaller is carried over so an installed copy stays uninstallable. If the swap can't
// happen (something still has files open) the old version stays, starts again, and an error file
// is shown in Settings on that run.
//
//   Windows  a byte-identical copy of the signed Lumen.exe runs features/swap-helper.js in Node mode
//            (ELECTRON_RUN_AS_NODE), so no .cmd/.ps1 or other script host is involved and Windows
//            Smart App Control has nothing new to block. Whole folders are renamed; no file from the
//            release is modified.
//   macOS    a small /bin/sh script renames Lumen.app, clears quarantine flags and reopens it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const helper = require('./swap-helper');

// The Lumen.app that contains execPath, or ''.
function macBundle(execPath) {
  const m = /^(.*?\.app)(\/|$)/.exec(String(execPath));
  return m ? m[1] : '';
}

// { dir, staging, old, script } for an install (the folder on Windows, the .app on macOS): all
// siblings, so a rename never crosses volumes.
function swapPaths(execPath, platform = process.platform) {
  if (platform === 'darwin') {
    const dir = macBundle(execPath) || path.posix.dirname(execPath);
    const parent = path.posix.dirname(dir);
    const base = path.posix.basename(dir, '.app');
    return { dir, staging: path.posix.join(parent, `.${base}.update`), old: path.posix.join(parent, `${base}.app.old`), script: path.posix.join(parent, `.${base}.update.sh`) };
  }
  const dir = path.dirname(execPath);
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  return { dir, staging: path.join(parent, `${base}.update`), old: path.join(parent, `${base}.old`), script: null };
}

// Can this user replace the install? Swapping renames the install folder and creates siblings next
// to it, so both the folder and its parent must accept writes. Windows' access() ignores ACLs, so
// it is followed by creating and removing a real file. `probe(dir)` is injectable for tests.
function probeWrite(dir) {
  const f = path.join(dir, `.lumen-write-test-${process.pid}`);
  fs.writeFileSync(f, '');
  fs.rmSync(f, { force: true });
}
function canReplace(execPath, platform = process.platform, probe = probeWrite, access = (d) => fs.accessSync(d, fs.constants.W_OK)) {
  const { dir } = swapPaths(execPath, platform);
  const parent = platform === 'darwin' ? path.posix.dirname(dir) : path.dirname(dir);
  try {
    for (const d of [dir, parent]) {
      access(d);
      // On macOS the bundle itself isn't probed with a file (that would modify the app); its
      // parent decides whether it can be renamed.
      if (!(platform === 'darwin' && d === dir)) probe(d);
    }
    return true;
  } catch {
    return false;
  }
}

// The sha512 (base64) latest.yml lists for `name`, or ''.
function expectedHash(files = [], name) {
  const f = files.find((x) => { const u = String(x?.url || ''); return u === name || u.endsWith(`/${name}`); });
  return f?.sha512 || '';
}

const hashMatches = (actualBase64, expectedBase64) => Boolean(expectedBase64) && actualBase64 === expectedBase64;

// A zip may hold the files at its root or inside one folder: the folder holding the exe.
function findRoot(dir, exeName, ls = (d) => fs.readdirSync(d, { withFileTypes: true })) {
  const entries = ls(dir);
  if (entries.some((e) => e.name.toLowerCase() === exeName.toLowerCase() && !e.isDirectory())) return dir;
  const dirs = entries.filter((e) => e.isDirectory());
  return dirs.length === 1 ? findRoot(path.join(dir, dirs[0].name), exeName, ls) : null;
}

// The Lumen.app inside an unpacked mac zip (at its root or inside one folder), or null.
function findApp(dir, appName, ls = (d) => fs.readdirSync(d, { withFileTypes: true })) {
  const entries = ls(dir);
  const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === appName.toLowerCase());
  if (hit) return path.join(dir, hit.name);
  const dirs = entries.filter((e) => e.isDirectory());
  return dirs.length === 1 ? findApp(path.join(dir, dirs[0].name), appName, ls) : null;
}

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // POSIX single-quoting

// The macOS swap script (run with /bin/sh). Waits for Lumen (pid) to exit, clears quarantine flags
// on the new bundle, moves Lumen.app aside as .old and the new one in, relaunches with `open`. If a
// move fails the old bundle is put back and errFile explains.
function macSwapScript({ pid, dir, root, old, errFile, staging, self, relaunch = true }) {
  const open = relaunch ? 'open "$APP"' : ':'; // quit-apply: the user quit, so nothing reopens
  return [
    '#!/bin/sh',
    `PID=${Number(pid)}`,
    `APP=${sq(dir)}`,
    `NEW=${sq(root)}`,
    `OLD=${sq(old)}`,
    `ERR=${sq(errFile)}`,
    `STAGING=${sq(staging)}`,
    `SELF=${sq(self)}`,
    'fail() {',
    '  echo "Lumen couldn\'t replace its files (is the Applications folder writable for you?). The old version was kept." > "$ERR"',
    `  ${open}`,
    '  rm -f "$SELF"',
    '  exit 1',
    '}',
    'n=0',
    'while kill -0 "$PID" 2>/dev/null; do',
    '  n=$((n + 1))',
    '  [ "$n" -ge 60 ] && fail',
    '  sleep 1',
    'done',
    // quit-apply: the staged bundle is gone (already swapped or cleaned up), so there is nothing to do
    ...(relaunch ? [] : ['[ -d "$NEW" ] || { rm -f "$SELF"; exit 0; }']),
    'rm -rf "$OLD"',
    'xattr -cr "$NEW" 2>/dev/null',
    'if mv "$APP" "$OLD"; then',
    '  if mv "$NEW" "$APP"; then',
    '    xattr -cr "$APP" 2>/dev/null',
    '    rm -rf "$OLD" "$STAGING"',
    `    ${open}`,
    '    rm -f "$SELF"',
    '    exit 0',
    '  fi',
    '  mv "$OLD" "$APP"',
    'fi',
    'fail',
    '',
  ].join('\n');
}

// Remembered next to the unpacked update, written last, so a staging folder without it is an
// unfinished one.
const MARKER = 'staged.json';
function readMarker(execPath, platform = process.platform) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(swapPaths(execPath, platform).staging, MARKER), 'utf8'));
    return m && typeof m.version === 'string' && typeof m.root === 'string' ? m : null;
  } catch {
    return null;
  }
}
// A complete staged update left by an earlier run, as { version, sha512, staged }, or null: the
// marker's folder must still be inside the staging folder and the exe must still look real. Whether
// the version is newer than the running one is the caller's call.
function readStaged(execPath, platform = process.platform, checkExe = helper.checkExe) {
  const m = readMarker(execPath, platform);
  if (!m || m.root.includes('..') || path.isAbsolute(m.root)) return null;
  const paths = swapPaths(execPath, platform);
  const join = platform === 'darwin' ? path.posix.join : path.join;
  const root = join(paths.staging, m.root);
  try {
    if (!fs.statSync(root).isDirectory()) return null;
    if (platform === 'darwin') {
      if (!fs.statSync(join(root, 'Contents', 'MacOS')).isDirectory()) return null;
    } else if (checkExe(join(root, path.basename(execPath)))) {
      return null;
    }
  } catch {
    return null;
  }
  return { version: m.version, sha512: m.sha512 || '', staged: { ...paths, root } };
}

// Download `url` to `file`, hashing as it goes. net is electron's `net` (or anything with fetch).
async function download({ net, url, file, onProgress }) {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total) onProgress?.(Math.round((got / total) * 100));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return hash.digest('base64');
}

// Windows 10+ ships bsdtar (a Microsoft-signed system binary), which reads zips. macOS: `ditto`
// keeps the app bundle intact (symlinks, modes), which tar/unzip don't reliably.
const extract = (zip, dest, platform = process.platform) => new Promise((resolve, reject) => {
  fs.mkdirSync(dest, { recursive: true });
  const [bin, args] = platform === 'darwin'
    ? ['/usr/bin/ditto', ['-x', '-k', zip, dest]]
    : [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]];
  execFile(bin, args, { windowsHide: true }, (err) => (err ? reject(new Error(`couldn't unpack the update: ${err.message.split('\n')[0]}`)) : resolve()));
});

// An NSIS install keeps its uninstaller (and nothing else) outside the zip: bring it along.
function carryOver(dir, root) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^Uninstall .*\.exe$/i.test(f) && !fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(dir, f), path.join(root, f));
    }
  } catch {}
}

// What Electron needs beside its exe to start at all, in Node mode (measured: without these it
// exits with an ICU / V8 snapshot error).
const HELPER_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'];

// Copy the running (signed) exe, its startup data and swap-helper.js into a temp folder, so the swap
// can run from outside the install it replaces. Returns { exe, script }. The exe copy is
// byte-identical; nothing is edited or re-signed.
function prepareHelper(execPath, tmp = path.join(os.tmpdir(), 'lumen-update-helper')) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const exe = path.join(tmp, path.basename(execPath));
  fs.copyFileSync(execPath, exe);
  for (const f of HELPER_FILES) {
    try { fs.copyFileSync(path.join(path.dirname(execPath), f), path.join(tmp, f)); } catch {}
  }
  const script = path.join(tmp, 'swap-helper.js');
  fs.copyFileSync(path.join(__dirname, 'swap-helper.js'), script);
  return { exe, script, dir: tmp };
}

// Fetch, verify and unpack into paths.staging. Returns what launchSwap needs. `platform` is
// injectable for tests.
async function stage({ net, asset, version, files, execPath, onProgress, platform = process.platform }) {
  const paths = swapPaths(execPath, platform);
  const mac = platform === 'darwin';
  const want = expectedHash(files, asset.name);
  if (!want) throw new Error('the release has no checksum for this file');
  fs.rmSync(paths.staging, { recursive: true, force: true });
  fs.mkdirSync(paths.staging, { recursive: true });
  const zip = path.join(paths.staging, asset.name);
  const got = await download({ net, url: asset.url, file: zip, onProgress });
  if (!hashMatches(got, want)) throw new Error('the download failed its checksum');
  const unpacked = path.join(paths.staging, 'files');
  await extract(zip, unpacked, platform);
  fs.rmSync(zip, { force: true });
  const name = mac ? path.posix.basename(paths.dir) : path.basename(execPath);
  const root = mac ? findApp(unpacked, name) : findRoot(unpacked, name);
  if (!root) throw new Error(`the update doesn't contain ${name}`);
  if (!mac) {
    const bad = helper.checkExe(path.join(root, name));
    if (bad) throw new Error(`the update looks damaged: ${bad}`);
    carryOver(paths.dir, root);
  }
  const staged = mac ? { ...paths, root } : { ...paths, root, helper: prepareHelper(execPath) };
  const rel = path.relative(paths.staging, root).split(path.sep).join('/');
  fs.writeFileSync(path.join(paths.staging, MARKER), JSON.stringify({ version: version || '', sha512: want, root: rel }));
  return staged;
}

// The Windows helper's command: the copied exe running swap-helper.js in Node mode.
function helperCommand({ staged, execPath, errFile, pid, relaunch = true }) {
  const h = staged.helper;
  const opts = { pid, dir: staged.dir, root: staged.root, old: staged.old, staging: staged.staging, exe: execPath, errFile, relaunch };
  return { command: h.exe, args: [h.script, JSON.stringify(opts)], options: { detached: true, stdio: 'ignore', windowsHide: true, cwd: h.dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } };
}

// Start the swap detached; the caller quits Lumen right after. `relaunch: false` (the user quit)
// swaps without starting Lumen again.
function launchSwap({ staged, execPath, errFile, relaunch = true, platform = process.platform, pid = process.pid, spawnFn = spawn }) {
  if (platform === 'darwin') {
    const script = macSwapScript({ pid, dir: staged.dir, root: staged.root, old: staged.old, errFile, staging: staged.staging, self: staged.script, relaunch });
    fs.writeFileSync(staged.script, script, { mode: 0o755 });
    spawnFn('/bin/sh', [staged.script], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const c = helperCommand({ staged: { ...staged, helper: staged.helper || prepareHelper(execPath) }, execPath, errFile, pid, relaunch });
  spawnFn(c.command, c.args, c.options).unref();
}

module.exports = { swapPaths, macBundle, canReplace, expectedHash, hashMatches, findRoot, findApp, macSwapScript, carryOver, prepareHelper, helperCommand, readMarker, readStaged, HELPER_FILES, stage, launchSwap };
