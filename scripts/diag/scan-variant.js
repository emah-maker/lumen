// TEMP diagnostic: one variant of the Electron-binary scan, then exit. Variant from argv[2].
const fs = require('fs');
const path = require('path');
const variant = process.argv[2];
const bin = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const words = ['disable-features', 'enable-features', 'disable-direct-composition', 'no-sandbox', 'WebContentsForceDark'];
const scan = (chunkMb, openFlag) => {
  const CHUNK = chunkMb * 1024 * 1024; const buf = Buffer.alloc(CHUNK + 64);
  const fd = fs.openSync(bin, openFlag || 'r'); let hits = 0;
  try { for (let pos = 0, keep = 0; ;) { const n = fs.readSync(fd, buf, keep, CHUNK, pos); if (n <= 0) break; const v = buf.subarray(0, keep + n); for (const w of words) if (v.indexOf(w) >= 0) hits++; pos += n; keep = Math.min(64, v.length); v.copy(buf, 0, v.length - keep); } } finally { fs.closeSync(fd); }
  return hits;
};
let hits = 0; // eslint-disable-line
if (variant === 'noscan') hits = 0;
else if (variant === 'chunk32') hits = scan(32);
else if (variant === 'chunk1') hits = scan(1);
else if (variant === 'readfile') { const b = fs.readFileSync(bin); for (const w of words) if (b.indexOf(w) >= 0) hits++; }
else if (variant === 'chunk32-natural') { hits = scan(32); console.log('DONE ' + hits); return; }
else if (variant === 'chunk32-exitcode') { hits = scan(32); console.log('DONE ' + hits); process.exitCode = 0; return; }
console.log('DONE ' + hits);
if (variant !== 'chunk32-natural') process.exit(0);
