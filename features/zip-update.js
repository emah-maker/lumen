// ---------- zip copies updating themselves (used by features/updates.js) ----------
// Download the release zip, check its sha512 against latest.yml's entry for it (the same check
// electron-updater makes for NSIS), unpack it next to the install, and on restart let a small
// batch script swap the folders once Lumen has exited. The profile lives in userData, outside the
// install folder, so it is never touched. If the folder can't be renamed (something still has
// files open), the script leaves the old version in place, starts it again, and writes an error
// file that the next run shows in Settings.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// { dir, staging, old, script } for an install folder: all siblings, so a rename never crosses drives.
function swapPaths(execPath) {
  const dir = path.dirname(execPath);
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  return { dir, staging: path.join(parent, `${base}.update`), old: path.join(parent, `${base}.old`), script: path.join(parent, `${base}.update.cmd`) };
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

const q = (s) => `"${String(s).replace(/"/g, '')}"`; // paths never hold quotes on Windows; strip to be safe

// The swap script. Waits for Lumen (pid) to exit, renames install -> .old and the staged folder
// -> install; if the first rename fails the old copy stays and errFile explains. Always relaunches.
function swapScript({ pid, dir, root, old, exe, errFile, staging, self }) {
  return [
    '@echo off',
    'setlocal',
    'set /a n=0',
    ':wait',
    `tasklist /FI "PID eq ${Number(pid)}" 2>nul | find "${Number(pid)}" >nul`,
    'if not errorlevel 1 (set /a n+=1 & if %n% GEQ 60 goto fail & timeout /t 1 /nobreak >nul & goto wait)',
    `if exist ${q(old)} rmdir /s /q ${q(old)}`,
    'set /a n=0',
    ':swap',
    `move ${q(dir)} ${q(old)} >nul 2>&1 && goto moved`,
    'set /a n+=1',
    'if %n% GEQ 10 goto fail',
    'timeout /t 1 /nobreak >nul',
    'goto swap',
    ':moved',
    `move ${q(root)} ${q(dir)} >nul 2>&1 && goto done`,
    `move ${q(old)} ${q(dir)} >nul 2>&1`, // couldn't place the new one: put the old one back
    'goto fail',
    ':done',
    `rmdir /s /q ${q(old)} >nul 2>&1`,
    `if exist ${q(staging)} rmdir /s /q ${q(staging)}`,
    'goto start',
    ':fail',
    `echo Lumen couldn't replace its files (is another program using the Lumen folder?). The old version was kept.> ${q(errFile)}`,
    ':start',
    `start "" ${q(exe)}`,
    `(goto) 2>nul & del ${q(self)}`,
    '',
  ].join('\r\n');
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

// Windows 10+ ships bsdtar, which reads zips.
const extract = (zip, dest) => new Promise((resolve, reject) => {
  fs.mkdirSync(dest, { recursive: true });
  execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest], { windowsHide: true }, (err) => (err ? reject(new Error(`couldn't unpack the update: ${err.message.split('\n')[0]}`)) : resolve()));
});

// Fetch, verify and unpack into paths.staging. Returns the folder to swap in.
async function stage({ net, asset, files, execPath, onProgress }) {
  const paths = swapPaths(execPath);
  const want = expectedHash(files, asset.name);
  if (!want) throw new Error('the release has no checksum for this file');
  fs.rmSync(paths.staging, { recursive: true, force: true });
  fs.mkdirSync(paths.staging, { recursive: true });
  const zip = path.join(paths.staging, asset.name);
  const got = await download({ net, url: asset.url, file: zip, onProgress });
  if (!hashMatches(got, want)) throw new Error('the download failed its checksum');
  const unpacked = path.join(paths.staging, 'files');
  await extract(zip, unpacked);
  fs.rmSync(zip, { force: true });
  const root = findRoot(unpacked, path.basename(execPath));
  if (!root) throw new Error(`the update doesn't contain ${path.basename(execPath)}`);
  return { ...paths, root };
}

// Write the script and start it detached; the caller quits Lumen right after.
function launchSwap({ staged, execPath, errFile }) {
  const script = swapScript({ pid: process.pid, dir: staged.dir, root: staged.root, old: staged.old, exe: execPath, errFile, staging: staged.staging, self: staged.script });
  fs.writeFileSync(staged.script, script);
  spawn('cmd.exe', ['/c', staged.script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

module.exports = { swapPaths, expectedHash, hashMatches, findRoot, swapScript, stage, launchSwap };
