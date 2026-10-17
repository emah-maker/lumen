// EMF, EMF+ and WMF pictures for the slide viewer, drawn by Windows itself (GDI+), in one short-lived PowerShell per deck.
// Why: the slides page draws metafiles with EMFJS/WMFJS (renderer/slides-vector.js), which only know classic GDI records. PowerPoint saves
// most of its EMFs as EMF+ (GDI+ records), which EMFJS leaves blank. GDI+ is the one thing that draws all of them.
//
// Safety: the files are untrusted, so GDI+ never runs in the main process. Each file is checked by its header and record chain here (size caps,
// no record that runs off the end), then a hidden PowerShell (ai/cli-utils.js spawn: no window, no shell) with no network code in its script
// opens the files from a private temp folder, draws each onto a transparent bitmap and writes a PNG. The batch has a time limit and is killed
// when it is exceeded. Any failure (not Windows, no PowerShell, a bad file, a timeout) gives no PNG for that picture and the viewer falls back to EMFJS.
// Results are cached by content hash and size in the profile (cacheDir), so reopening a deck does not start PowerShell at all.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_PICTURES = 64;
const MAX_SIDE = 2048;
const MIN_SIDE = 64;
const TIME_LIMIT_MS = 15000;
const MAX_RECORDS = 500000;
const CACHE_MAX_FILES = 300;
const CACHE_VERSION = 'v1';

// One entry per picture: in = file, out = PNG, w x h = pixels. A failed picture is skipped, the rest go on.
const SCRIPT = [
  'param([string]$Manifest)',
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Drawing',
  '$items = [System.IO.File]::ReadAllText($Manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json',
  'foreach ($it in $items) {',
  '  $mf = $null; $bmp = $null; $g = $null',
  '  try {',
  '    $mf = [System.Drawing.Imaging.Metafile]::new([string]$it.in)',
  '    $bmp = [System.Drawing.Bitmap]::new([int]$it.w, [int]$it.h, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)',
  '    $g = [System.Drawing.Graphics]::FromImage($bmp)',
  '    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
  '    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
  '    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality',
  '    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias',
  '    $g.Clear([System.Drawing.Color]::Transparent)',
  '    $g.DrawImage($mf, 0, 0, [int]$it.w, [int]$it.h)',
  '    $g.Dispose(); $g = $null',
  '    $bmp.Save([string]$it.out, [System.Drawing.Imaging.ImageFormat]::Png)',
  '  } catch { } finally { if ($g) { $g.Dispose() }; if ($bmp) { $bmp.Dispose() }; if ($mf) { $mf.Dispose() } }',
  '}',
  '',
].join('\r\n');

// 'emf' | 'wmf' | null, after a structure check the library never sees: sizes in range and the record chain stays inside the file.
// (EMF: type 1, " EMF" at 40, header >= 88 bytes, a usable frame or bounds. WMF: the placeable key; GDI+ cannot open a header-less one.)
function checkMetafile(b) {
  if (!Buffer.isBuffer(b) || b.length < 44 || b.length > MAX_INPUT_BYTES) return null;
  if (b.readUInt32LE(0) === 1 && b.readUInt32LE(40) === 0x464d4520) {
    if (b.length < 88) return null;
    const headSize = b.readUInt32LE(4);
    if (headSize < 88 || headSize > b.length || headSize % 4) return null;
    let off = 0; let count = 0; let ended = false;
    while (off + 8 <= b.length) {
      const type = b.readUInt32LE(off); const size = b.readUInt32LE(off + 4);
      if (size < 8 || size % 4 || off + size > b.length || ++count > MAX_RECORDS) return null;
      off += size;
      if (type === 14) { ended = true; break; }
    }
    if (!ended) return null;
    const fw = b.readInt32LE(32) - b.readInt32LE(24); const fh = b.readInt32LE(36) - b.readInt32LE(28);
    const bw = b.readInt32LE(16) - b.readInt32LE(8); const bh = b.readInt32LE(20) - b.readInt32LE(12);
    if (!((fw > 0 && fh > 0) || (bw > 0 && bh > 0))) return null;
    return 'emf';
  }
  if (b.length >= 22 && b.readUInt32LE(0) === 0x9ac6cdd7) {
    const w = b.readInt16LE(10) - b.readInt16LE(6); const h = b.readInt16LE(12) - b.readInt16LE(8);
    if (!(w !== 0 && h !== 0 && b.readUInt16LE(14) > 0)) return null;
    return 'wmf';
  }
  return null;
}

// GDI+ opens a WMF only when it has the placeable header. Old WMFs (PowerPoint writes them without) get one here: the drawing's window
// (META_SETWINDOWORG, META_SETWINDOWEXT) becomes the bounds. Returns the bytes to hand to GDI+ (the same Buffer when nothing is needed), or null.
function placeable(b) {
  if (b.length < 18 || b.length > MAX_INPUT_BYTES) return null;
  if (b.readUInt32LE(0) === 0x9ac6cdd7) return b;
  const type = b.readUInt16LE(0);
  if (!((type === 1 || type === 2) && b.readUInt16LE(2) === 9 && (b.readUInt16LE(4) === 0x100 || b.readUInt16LE(4) === 0x300))) return null;
  let off = b.readUInt16LE(2) * 2; let count = 0; let ended = false; let ox = 0; let oy = 0; let ex = 0; let ey = 0;
  while (off + 6 <= b.length) {
    const size = b.readUInt32LE(off) * 2; const fn = b.readUInt16LE(off + 4);
    if (size < 6 || off + size > b.length || ++count > MAX_RECORDS) return null;
    if (fn === 0x020b && size >= 10) { oy = b.readInt16LE(off + 6); ox = b.readInt16LE(off + 8); }
    else if (fn === 0x020c && size >= 10) { ey = b.readInt16LE(off + 6); ex = b.readInt16LE(off + 8); }
    off += size;
    if (fn === 0) { ended = true; break; }
  }
  if (!ended || !ex || !ey) return null;
  const head = Buffer.alloc(22);
  head.writeUInt32LE(0x9ac6cdd7, 0);
  head.writeInt16LE(ox, 6); head.writeInt16LE(oy, 8);
  head.writeInt16LE(Math.max(-32768, Math.min(32767, ox + ex)), 10); head.writeInt16LE(Math.max(-32768, Math.min(32767, oy + ey)), 12);
  head.writeUInt16LE(96, 14);
  let sum = 0; for (let i = 0; i < 20; i += 2) sum ^= head.readUInt16LE(i);
  head.writeUInt16LE(sum, 20);
  return Buffer.concat([head, b]);
}

// The aspect ratio of a checked metafile (frame for EMF, bounding box for placeable WMF), or 1.
function aspectOf(b, kind) {
  let w; let h;
  if (kind === 'emf') {
    w = b.readInt32LE(32) - b.readInt32LE(24); h = b.readInt32LE(36) - b.readInt32LE(28);
    if (!(w > 0 && h > 0)) { w = b.readInt32LE(16) - b.readInt32LE(8); h = b.readInt32LE(20) - b.readInt32LE(12); }
  } else { w = Math.abs(b.readInt16LE(10) - b.readInt16LE(6)); h = Math.abs(b.readInt16LE(12) - b.readInt16LE(8)); }
  return w > 0 && h > 0 ? w / h : 1;
}

// Pixels on the long side for a picture shown `points` long: twice its size at 96 dpi, in steps of 64, within [MIN_SIDE, MAX_SIDE].
const pixelSide = (points) => Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(((Number(points) > 0 ? Number(points) : 384) * (96 / 72) * 2) / 64) * 64));
function pixelsFor(aspect, side) {
  const a = Math.min(64, Math.max(1 / 64, aspect));
  return a >= 1 ? { w: side, h: Math.max(1, Math.round(side / a)) } : { w: Math.max(1, Math.round(side * a)), h: side };
}

const keyOf = (bytes, side) => `${CACHE_VERSION}-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40)}-${side}.png`;
const isPng = (b) => Buffer.isBuffer(b) && b.length > 67 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;

async function pruneCache(dir) {
  try {
    const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.png'));
    if (names.length <= CACHE_MAX_FILES) return;
    const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(dir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
    stats.sort((a, b) => a.t - b.t);
    for (const s of stats.slice(0, names.length - CACHE_MAX_FILES)) await fs.promises.unlink(path.join(dir, s.n)).catch(() => {});
  } catch { /* the cache is a convenience */ }
}

// pictures: [{ id, bytes: Buffer, points }] (points: the largest side, in points, the picture is shown at; optional).
// Returns Map id -> PNG Buffer, for the pictures that could be drawn. Never throws.
// opts: { cacheDir, platform, timeoutMs, spawn, powershell, tmpRoot (tests), stats: an object filled in with { cached, converted, spawned, ms } }
async function convertMetafiles(pictures, opts = {}) {
  const result = new Map();
  const stats = opts.stats || {};
  Object.assign(stats, { cached: 0, converted: 0, spawned: 0, ms: 0 });
  if ((opts.platform || process.platform) !== 'win32' || !Array.isArray(pictures)) return result;
  const t0 = Date.now();
  let work = null;
  try {
    const todo = [];
    for (const p of pictures.slice(0, MAX_PICTURES)) {
      if (!p || !Buffer.isBuffer(p.bytes)) continue;
      const bytes = p.bytes.length >= 18 && p.bytes.readUInt32LE(0) !== 1 ? placeable(p.bytes) : p.bytes;
      const kind = bytes && checkMetafile(bytes);
      if (!kind) continue;
      const side = pixelSide(p.points);
      const key = keyOf(p.bytes, side);
      if (opts.cacheDir) {
        const hit = await fs.promises.readFile(path.join(opts.cacheDir, key)).catch(() => null);
        if (isPng(hit)) { result.set(p.id, hit); stats.cached++; continue; }
      }
      todo.push({ id: p.id, bytes, kind, side, key });
    }
    if (!todo.length) return result;

    work = await fs.promises.mkdtemp(path.join(opts.tmpRoot || os.tmpdir(), 'lumen-emf-'));
    const manifest = [];
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i];
      t.outFile = path.join(work, `${i}.png`);
      const inFile = path.join(work, `${i}.${t.kind}`);
      const { w, h } = pixelsFor(aspectOf(t.bytes, t.kind), t.side);
      await fs.promises.writeFile(inFile, t.bytes);
      manifest.push({ in: inFile, out: t.outFile, w, h });
    }
    const script = path.join(work, 'draw.ps1'); const manifestFile = path.join(work, 'manifest.json');
    await fs.promises.writeFile(script, `\ufeff${SCRIPT}`, 'utf8');
    await fs.promises.writeFile(manifestFile, JSON.stringify(manifest), 'utf8');

    const utils = require('../ai/cli-utils');
    const spawn = opts.spawn || utils.spawn;
    const exe = opts.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    stats.spawned++;
    await new Promise((resolve) => {
      let child = null;
      let timer = null;
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      timer = setTimeout(() => { try { if (child) utils.killTree(child); } catch { /* gone */ } finish(); }, opts.timeoutMs || TIME_LIMIT_MS);
      try {
        child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, manifestFile], { cwd: work, stdio: ['ignore', 'ignore', 'ignore'] });
        child.on('error', finish);
        child.on('close', finish);
      } catch { finish(); }
    });

    for (const t of todo) {
      const png = await fs.promises.readFile(t.outFile).catch(() => null);
      if (!isPng(png)) continue;
      result.set(t.id, png); stats.converted++;
      if (opts.cacheDir) {
        try {
          await fs.promises.mkdir(opts.cacheDir, { recursive: true });
          const tmp = path.join(opts.cacheDir, `${t.key}.${process.pid}.tmp`);
          await fs.promises.writeFile(tmp, png);
          await fs.promises.rename(tmp, path.join(opts.cacheDir, t.key));
        } catch { /* not cached */ }
      }
    }
    if (opts.cacheDir && stats.converted) pruneCache(opts.cacheDir);
  } catch { /* every failure is "fall back" */ } finally {
    if (work) await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    stats.ms = Date.now() - t0;
  }
  return result;
}

module.exports = { convertMetafiles, checkMetafile, placeable, aspectOf, pixelSide, pixelsFor, isPng, SCRIPT, MAX_PICTURES, MAX_INPUT_BYTES, MAX_SIDE, TIME_LIMIT_MS };
