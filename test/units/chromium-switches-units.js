// The Chromium switches Lumen sets at launch (app.commandLine.appendSwitch in src/), pure Node (no window):
//   - every switch name, and every feature named in a *-features switch, is a string in the Electron we ship
//     (node_modules/electron/dist), so none is a switch Chromium dropped. An unknown switch is ignored without a word:
//     --disable-direct-composition-video-overlays (0.5.87, the gray box over Muse's avatar video) did nothing at all.
//   - on Windows, video overlays are off through --disable-direct-composition, the switch Chromium still reads
//   - --disable-features and --enable-features are each set in one place (Chromium keeps only the last value of a switch)
// Without the Electron binary (npm ci --ignore-scripts and no run that downloaded it), the binary check is skipped and says so.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const ROOT = path.join(__dirname, '..', '..');

const files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
walk(path.join(ROOT, 'src'));
const calls = []; // { file, name, value }
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/commandLine\.appendSwitch\(\s*'([^']+)'(?:\s*,\s*'([^']*)')?/g)) calls.push({ file: path.relative(ROOT, f).split(path.sep).join('/'), name: m[1], value: m[2] });
}
check('the launch switches are found in src/', calls.length >= 8, calls.length);

// ---- Windows: video overlays off with a switch that exists
const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
check('main.js turns DirectComposition (and with it the video overlay planes) off on Windows', /if \(process\.platform === 'win32'\) app\.commandLine\.appendSwitch\('disable-direct-composition'\);/.test(main), '');
check('...and no longer sets the dropped --disable-direct-composition-video-overlays', !calls.some((c) => c.name === 'disable-direct-composition-video-overlays'), '');

// ---- one place per *-features switch
for (const name of ['disable-features', 'enable-features']) {
  const at = calls.filter((c) => c.name === name);
  check(`--${name} is set in one place only (Chromium reads the last one)`, at.length <= 1, at.map((c) => `${c.file}: ${c.value}`).join('; '));
}

// Which of `words` are strings in the file at `bin` (read in chunks; a word may straddle two).
function inBinary(bin, words) {
  const want = words.map((w) => ({ w, b: Buffer.from(w, 'latin1'), found: false }));
  const longest = Math.max(...want.map((x) => x.b.length));
  const CHUNK = 32 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK + longest);
  const fd = fs.openSync(bin, 'r');
  try {
    for (let pos = 0, keep = 0; ;) {
      const n = fs.readSync(fd, buf, keep, CHUNK, pos);
      if (n <= 0) break;
      const view = buf.subarray(0, keep + n);
      for (const x of want) if (!x.found && view.indexOf(x.b) >= 0) x.found = true;
      if (want.every((x) => x.found)) break;
      pos += n;
      keep = Math.min(longest, view.length);
      view.copy(buf, 0, view.length - keep);
    }
  } finally { fs.closeSync(fd); }
  return new Set(want.filter((x) => x.found).map((x) => x.w));
}

// ---- every switch and feature is known to the shipped Electron
const exe = { win32: 'electron.exe', darwin: 'Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework', linux: 'electron' }[process.platform];
const bin = path.join(ROOT, 'node_modules', 'electron', 'dist', exe || '');
if (!exe || !fs.existsSync(bin)) console.log(`SKIP  switch names against the Electron binary: ${bin} is not there`);
else {
  const words = new Set();
  for (const c of calls) {
    words.add(c.name);
    if (/-features$/.test(c.name) && c.value) for (const w of c.value.split(',')) if (w) words.add(w);
  }
  // Names set today that this Electron (44.1) no longer knows, found by this suite (2026-11-05) and not part of the video-overlay fix.
  // Each is to be fixed on its own; take it out of here then (the check below fails once it is known again, or gone from src/).
  const KNOWN_DEAD = {
    'remote-debugging-address': 'features/ai-agents.js: Chromium binds the DevTools port to 127.0.0.1 anyway',
    WebContentsForceDark: 'settings-backend.js: "Dark mode for all websites" sets a feature Chromium no longer has',
  };
  const DEAD = 'disable-direct-composition-video-overlays';
  const found = inBinary(bin, [...words, DEAD]);
  const missing = [...words].filter((w) => !found.has(w));
  const fresh = missing.filter((w) => !(w in KNOWN_DEAD));
  check(`every launch switch and feature name is in the shipped Electron (${words.size} names, ${missing.length} known dead)`, fresh.length === 0, fresh.join(', '));
  const stale = Object.keys(KNOWN_DEAD).filter((w) => !missing.includes(w));
  check('...and each known dead name is still set and still unknown (else take it off KNOWN_DEAD)', stale.length === 0, stale.join(', '));
  check(`...and the check tells a dropped switch: --${DEAD} is not in it`, !found.has(DEAD), 'it is in this Electron: the check proves nothing');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
