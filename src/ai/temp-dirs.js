// Per-process temp folders under os.tmpdir() (Claude Code's lumen-cc-*, which holds an mcp.json with a bearer token for
// Lumen's local MCP server). removeDir ends one; sweepStale removes the ones a crash or a hard quit left behind.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Exactly what fs.mkdtemp makes: the prefix plus six random characters. Nothing else in the temp folder matches.
const NAME = /^(?:lumen-cc-|lumen-cc1-|lumen-usage-)[A-Za-z0-9]{6}$/;
const STALE_MS = 24 * 60 * 60 * 1000;

// Async, errors ignored. Retries: on Windows a folder is busy while a process (or a child of its tree) still has it as its cwd.
function removeDir(dir, cb = () => {}) {
  try { fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }, () => cb()); } catch { cb(); }
}
function removeDirSync(dir) {
  // maxRetries: an async removeDir may be mid-way through the same folder (quit right after a dispose), and a scanner can hold a
  // just-written file for a moment; both clear within a few tries. Still best effort: a stubborn one is the next start's sweep.
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* busy: the next start's sweep */ }
}

// Deletes lumen-cc-* (and the sibling prefixes above) folders older than maxAgeMs in `tmp`, skipping `live` (a Set of absolute
// paths in use by this app). Real directories only (no symlinks, no files). Returns the removed paths.
async function sweepStale({ tmp = os.tmpdir(), maxAgeMs = STALE_MS, now = Date.now(), live = new Set() } = {}) {
  const removed = [];
  let names;
  try { names = await fs.promises.readdir(tmp); } catch { return removed; }
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const full = path.join(tmp, name);
    if (live.has(full)) continue;
    try {
      const st = await fs.promises.lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink() || now - st.mtimeMs < maxAgeMs) continue;
      await fs.promises.rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(full);
    } catch { /* in use or gone: next start */ }
  }
  return removed;
}

module.exports = { removeDir, removeDirSync, sweepStale, NAME, STALE_MS };
