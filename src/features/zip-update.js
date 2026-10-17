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
const { spawn, execFile } = require('../ai/cli-utils');
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

// Can this user create things in `dir` (Applications, ~/Applications)? Creating and removing a real
// file is the only test that follows ACLs; `probe` is injectable for tests.
function canWriteDir(dir, probe = probeWrite) {
  try { probe(dir); return true; } catch { return false; }
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

// The macOS swap script (run with /bin/sh). It only renames whole bundles and clears extended
// attributes (`xattr -cr` removes com.apple.quarantine and friends from files, never anything inside
// the code signature), so a Developer ID signature and a stapled notarization ticket arrive intact;
// it never runs codesign, so it can't strip or replace one. With no signature to keep (ad-hoc builds)
// clearing quarantine is what stops Gatekeeper from blocking the swapped-in copy. Waits for Lumen (pid) to exit, clears quarantine flags
// on the new bundle, moves Lumen.app aside as .old and the new one in, relaunches with `open`. If a
// move fails the old bundle is put back and errFile explains. `orig` is the bundle this run came
// from: a relocated install (from the dmg) that fails has no $APP to reopen, so the original is.
function macSwapScript({ pid, dir, root, old, errFile, staging, self, relaunch = true, orig = '' }) {
  const open = relaunch ? 'open "$APP"' : ':'; // quit-apply: the user quit, so nothing reopens
  const reopen = relaunch ? 'if [ -d "$APP" ]; then open "$APP"; elif [ -n "$ORIG" ] && [ -d "$ORIG" ]; then open "$ORIG"; fi' : ':';
  return [
    '#!/bin/sh',
    `PID=${Number(pid)}`,
    `APP=${sq(dir)}`,
    `NEW=${sq(root)}`,
    `OLD=${sq(old)}`,
    `ERR=${sq(errFile)}`,
    `STAGING=${sq(staging)}`,
    `SELF=${sq(self)}`,
    `ORIG=${sq(orig)}`,
    // errFile holds only a short cause; Settings and the pill put it in their own sentence
    'fail() {',
    '  echo "${1:-the update couldn’t be installed}" > "$ERR"',
    `  ${reopen}`,
    '  rm -f "$SELF"',
    '  exit 1',
    '}',
    'n=0',
    'while kill -0 "$PID" 2>/dev/null; do',
    '  n=$((n + 1))',
    '  [ "$n" -ge 60 ] && fail "Lumen didn’t quit in time"',
    '  sleep 1',
    'done',
    // quit-apply: the staged bundle is gone (already swapped or cleaned up), so there is nothing to do
    ...(relaunch ? ['if [ ! -d "$NEW" ]; then fail "the update files were missing"; fi'] : ['[ -d "$NEW" ] || { rm -f "$SELF"; exit 0; }']),
    'rm -rf "$OLD"',
    'xattr -cr "$NEW" 2>/dev/null',
    // a fresh install into Applications (a misplaced copy's update) has no $APP to move aside
    'if [ ! -d "$APP" ] || mv "$APP" "$OLD"; then',
    '  if mv "$NEW" "$APP"; then',
    '    xattr -cr "$APP" 2>/dev/null',
    '    rm -rf "$OLD" "$STAGING"',
    `    ${open}`,
    '    rm -f "$SELF"',
    '    exit 0',
    '  fi',
    '  [ -d "$OLD" ] && mv "$OLD" "$APP"',
    '  fail "the update couldn’t be moved into place"',
    'fi',
    'fail "the Applications folder isn’t writable"',
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

// ---------- the download: retried, resumed, and its checksum checked at the end ----------
// A release zip is ~250 MB, so a dropped connection part-way is likely on a poor link. A transient failure
// (see classifyError) is retried after a growing pause; an interrupted download continues from the bytes
// already on disk with an HTTP Range request when the server allows it (else it starts over). Every attempt
// asks for the ORIGINAL url again, never the address it redirected to last time: GitHub redirects release
// downloads to a signed release-assets URL that expires. The sha512 is taken over exactly the bytes in the
// file, whatever the number of attempts, and stage() compares it with latest.yml before anything is unpacked.
const RETRY_DELAYS = [3000, 10000, 30000, 60000]; // 5 tries in all, ~100 s of waiting between them
const STALL_MS = 30000; // no response, or no data, for this long counts as a dropped connection
const OFFLINE_POLL_MS = 2000;
const OFFLINE_MAX_MS = 5 * 60000; // how long to wait for the network to come back before giving up
const TRANSIENT_NET = /ERR_(FAILED|NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_(RESET|TIMED_OUT|CLOSED|ABORTED|REFUSED)|TIMED_OUT|NAME_NOT_RESOLVED|NETWORK_IO_SUSPENDED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|ADDRESS_UNREACHABLE|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|HTTP2_[A-Z_]+|QUIC_[A-Z_]+)\b/;

// { retry, key } for a failed attempt. `key` names the plain-words reason (locales: updates.reason.<key>).
// Fatal: a checksum mismatch, a 4xx (the file is gone or refused), a request something on this computer cancelled,
// a certificate problem, a full disk. Everything else that looks like the network is transient.
function classifyError(err) {
  if (err?.fatal) return { retry: false, key: err.reasonKey || 'failed' };
  const status = Number(err?.status) || 0;
  if (status) return status >= 500 || status === 408 || status === 429 ? { retry: true, key: 'server' } : { retry: false, key: 'refused' };
  const msg = String(err?.message || err);
  if (err?.timedOut || /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/.test(msg)) return { retry: true, key: 'timeout' };
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED/.test(msg)) return { retry: true, key: 'offline' };
  if (/ERR_BLOCKED_BY_/.test(msg)) return { retry: false, key: 'blocked' };
  if (/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/.test(msg)) return { retry: false, key: 'secure' };
  if (TRANSIENT_NET.test(msg)) return { retry: true, key: 'dropped' };
  if (err?.name === 'AbortError' || /^(terminated|fetch failed|aborted)$/i.test(msg) || /\b(ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE)\b/.test(`${err?.code} ${msg}`)) return { retry: true, key: 'dropped' };
  if (/^net::/.test(msg)) return { retry: false, key: 'failed' }; // some other network error: not worth hammering
  return { retry: false, key: '' }; // a disk error, a bug: its own message says it
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Download `url` to `file`; resolves { hash (sha512, base64), resumed, attempts }. `net` is anything with
// fetch(url, { headers, signal }) (electron's session.fetch, or a test's stand-in) and optionally `online`.
// onRetry({ key, attempt, waitMs, offline }) is called before each pause; onProgress(percent) as data arrives.
async function download({ net, url, file, onProgress, onRetry, sleep = defaultSleep, delays = RETRY_DELAYS, stallMs = STALL_MS, offlineMaxMs = OFFLINE_MAX_MS, offlinePollMs = OFFLINE_POLL_MS }) {
  let hash = crypto.createHash('sha512');
  let got = 0;
  let total = 0;
  let etag = '';
  let resumed = false;
  const start = () => { hash = crypto.createHash('sha512'); got = 0; total = 0; fs.writeFileSync(file, ''); };
  start();

  async function attempt() {
    for (let again = 0; ; again++) {
      const controller = new AbortController();
      let timedOut = false;
      let timer = null;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, stallMs); };
      let fh = null;
      try {
        arm();
        const headers = got ? { Range: `bytes=${got}-`, ...(etag ? { 'If-Range': etag } : {}) } : {};
        // no-store: a 250 MB zip is never worth the HTTP cache, and a cached piece of an earlier try must not answer this one
        const res = await net.fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
        if (res.status === 416 && got && !again) { start(); continue; } // what we hold doesn't fit the file: begin again
        if (!res.ok || !res.body) throw Object.assign(new Error(`download failed (${res.status})`), { status: res.status });
        const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(res.headers.get('content-range') || '');
        if (got && res.status === 206 && range && Number(range[1]) === got) {
          resumed = true;
          total = range[2] !== '*' ? Number(range[2]) : 0;
        } else if (res.status === 206) {
          start(); // a piece that isn't the one asked for: drop what we hold and ask for the whole file
          throw new Error('net::ERR_FAILED');
        } else {
          if (got) start(); // the server sent the whole file again: use it from the top
          total = Number(res.headers.get('content-length')) || 0;
        }
        const tag = res.headers.get('etag') || '';
        etag = tag && !tag.startsWith('W/') ? tag : '';
        fh = await fs.promises.open(file, 'a');
        for await (const chunk of res.body) {
          arm();
          await fh.write(chunk);
          hash.update(chunk);
          got += chunk.length;
          if (total) onProgress?.(Math.min(100, Math.round((got / total) * 100)));
        }
        if (total && got !== total) throw new Error('net::ERR_CONTENT_LENGTH_MISMATCH');
        return;
      } catch (err) {
        if (timedOut) throw Object.assign(new Error('net::ERR_TIMED_OUT'), { timedOut: true });
        throw err;
      } finally {
        clearTimeout(timer);
        await fh?.close().catch(() => {});
      }
    }
  }

  const online = () => (typeof net.online === 'function' ? net.online() : typeof net.online === 'boolean' ? net.online : true);
  for (let tries = 1; ; tries++) {
    if (!online()) {
      // No network at all: wait for it to come back (this doesn't use up a try), up to a limit.
      onRetry?.({ key: 'offline', attempt: tries, waitMs: offlinePollMs, offline: true });
      for (let waited = 0; !online(); waited += offlinePollMs) {
        if (waited >= offlineMaxMs) throw Object.assign(new Error('offline'), { fatal: true, reasonKey: 'offline' });
        await sleep(offlinePollMs);
      }
    }
    try {
      await attempt();
      return { hash: hash.digest('base64'), resumed, attempts: tries };
    } catch (err) {
      const c = classifyError(err);
      if (!c.retry || tries > delays.length) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { reasonKey: c.key, retried: tries > 1 });
      onRetry?.({ key: c.key, attempt: tries, waitMs: delays[tries - 1], offline: false });
      await sleep(delays[tries - 1]);
    }
  }
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
// byte-identical; nothing is edited or re-signed. Each attempt gets its own folder: an earlier one
// can't always be removed (a Lumen relaunched by an older helper ran with it as its working
// directory, which Windows keeps locked), and that must not fail the next update. Earlier folders
// are removed when they can be.
const HELPER_PREFIX = 'lumen-update-helper';
function prepareHelper(execPath, tmp = null, base = os.tmpdir()) {
  if (!tmp) {
    try {
      for (const f of fs.readdirSync(base)) {
        if (f.startsWith(HELPER_PREFIX)) try { fs.rmSync(path.join(base, f), { recursive: true, force: true }); } catch {}
      }
    } catch {}
    tmp = path.join(base, `${HELPER_PREFIX}-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  } else {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

// The same, off the main thread: 250 MB of exe copy (and the antivirus scan it triggers) must not stall Lumen's UI, and it is
// done well before the user clicks Restart, so the click never waits for it. Earlier helper folders are cleared after.
async function prepareHelperAsync(execPath, base = os.tmpdir()) {
  const fsp = fs.promises;
  const tmp = path.join(base, `${HELPER_PREFIX}-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fsp.mkdir(tmp, { recursive: true });
  const exe = path.join(tmp, path.basename(execPath));
  await fsp.copyFile(execPath, exe);
  for (const f of HELPER_FILES) await fsp.copyFile(path.join(path.dirname(execPath), f), path.join(tmp, f)).catch(() => {});
  const script = path.join(tmp, 'swap-helper.js');
  await fsp.copyFile(path.join(__dirname, 'swap-helper.js'), script);
  fsp.readdir(base).then((names) => Promise.all(names.filter((n) => n.startsWith(HELPER_PREFIX) && path.join(base, n) !== tmp).map((n) => fsp.rm(path.join(base, n), { recursive: true, force: true }).catch(() => {})))).catch(() => {});
  return { exe, script, dir: tmp };
}

// What an update that swapped entry by entry (some program had files of the install open) could not delete while that
// program still ran: the old install folder and its numbered siblings. Cleared at the next start, off the main thread.
// (The swap itself is features/swap-helper.js.) Windows only; the old folder is never the running one.
async function clearOld(execPath, platform = process.platform) {
  if (platform === 'darwin') return;
  const { old } = swapPaths(execPath, platform);
  const dir = path.dirname(old);
  const names = (await fs.promises.readdir(dir).catch(() => [])).filter((n) => n === path.basename(old) || n.startsWith(`${path.basename(old)}-`) || n.startsWith(`${path.basename(old)}.stale-`));
  await Promise.all(names.map((n) => fs.promises.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {})));
}

// A prepared helper whose files are still there (a temp cleaner may have removed them since).
const helperReady = (h) => Boolean(h) && fs.existsSync(h.exe) && fs.existsSync(h.script);

// Fetch, verify and unpack into paths.staging. Returns what launchSwap needs. `platform` is
// injectable for tests.
async function stage({ net, asset, version, files, execPath, onProgress, onRetry, platform = process.platform, retry = {} }) {
  const paths = swapPaths(execPath, platform);
  const mac = platform === 'darwin';
  const want = expectedHash(files, asset.name);
  if (!want) throw new Error('the release has no checksum for this file');
  fs.rmSync(paths.staging, { recursive: true, force: true });
  fs.mkdirSync(paths.staging, { recursive: true });
  const zip = path.join(paths.staging, asset.name);
  let done = await download({ net, url: asset.url, file: zip, onProgress, onRetry, ...retry });
  // A download put together from several pieces that doesn't match gets one clean try from the top.
  if (!hashMatches(done.hash, want) && done.resumed) done = await download({ net, url: asset.url, file: zip, onProgress, onRetry, ...retry });
  if (!hashMatches(done.hash, want)) throw Object.assign(new Error('the download failed its checksum'), { fatal: true, reasonKey: 'checksum' });
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
  const staged = mac ? { ...paths, root } : { ...paths, root, helper: await prepareHelperAsync(execPath) };
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
    const script = macSwapScript({ pid, dir: staged.dir, root: staged.root, old: staged.old, errFile, staging: staged.staging, self: staged.script, relaunch, orig: macBundle(execPath) });
    fs.writeFileSync(staged.script, script, { mode: 0o755 });
    spawnFn('/bin/sh', [staged.script], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const c = helperCommand({ staged: { ...staged, helper: staged.helper || prepareHelper(execPath) }, execPath, errFile, pid, relaunch });
  spawnFn(c.command, c.args, c.options).unref();
}

module.exports = { swapPaths, macBundle, canReplace, canWriteDir, expectedHash, hashMatches, findRoot, findApp, macSwapScript, carryOver, prepareHelper, prepareHelperAsync, helperReady, clearOld, helperCommand, readMarker, readStaged, HELPER_FILES, stage, launchSwap, download, classifyError, RETRY_DELAYS };
