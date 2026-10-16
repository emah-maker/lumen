// The Files indexer's worker thread (started by files-index.js). Everything that walks a folder runs here, so a pinned folder of
// thousands of files never costs the main thread a millisecond: it only posts a job and gets a short answer.
//
// It keeps the names of the files inside pinned folders (depth 4, at most 20,000 per pin: never their contents) and answers
//   index  { root, depth, cap }          walk a folder and replace what it knew of it         -> { count, truncated }
//   drop   { root }                       forget a folder                                      -> true
//   search { query, limit, loose }        fuzzy over everything indexed (files-fuzzy.js)       -> [{ path, name, root, size, mtime }]
//   find   { dir, name, size }            a moved file: same name, or same size and a similar name, near its old folder -> candidates
//   scan   { roots, query, depth, cap, timeMs }  a fresh walk of other folders, for the AI's slow path (nothing is kept) -> hits
// Walks use fs.promises and yield between folders, so a search is answered while an index is still running. Dot folders,
// node_modules, links (no cycles) and credential files (.env, keys) are never walked or listed.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { rank, matchText, words } = require('./files-fuzzy');

const SECRET_FILE = /^(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keychain-db))$/i;
const SKIP_DIR = /^(node_modules|\$recycle\.bin|system volume information|__pycache__|\.git|\.svn|\.hg)$/i;

const index = new Map(); // root -> [{ name, path }]
const yieldNow = () => new Promise((r) => setImmediate(r));

// Breadth first, so a cap keeps the shallow files. `visit(entry)` returns false to stop.
async function walk(root, { depth, cap, deadline = Infinity, visit }) {
  let count = 0;
  let truncated = false;
  let level = [root];
  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (const dir of level) {
      if (Date.now() > deadline) return { count, truncated: true };
      let list;
      try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of list) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (d < depth && !SKIP_DIR.test(e.name)) next.push(path.join(dir, e.name)); continue; }
        if (!e.isFile() || SECRET_FILE.test(e.name)) continue;
        if (count >= cap) return { count, truncated: true };
        count++;
        if (visit({ name: e.name, path: path.join(dir, e.name), dir }) === false) return { count, truncated };
      }
      await yieldNow();
    }
    level = next;
  }
  return { count, truncated };
}

// The top results, with a size and a time (looked up now, only for these), and without any that vanished since the walk.
async function withStats(rows, root) {
  const out = await Promise.all(rows.map(async (r) => {
    try { const st = await fs.promises.stat(r.path); return st.isFile() ? { path: r.path, name: r.name, root: root ?? r.root, size: st.size, mtime: Math.round(st.mtimeMs) } : null; } catch { return null; }
  }));
  return out.filter(Boolean);
}

const jobs = {
  async index({ root, depth = 4, cap = 20000 }) {
    const rows = [];
    const res = await walk(root, { depth, cap, visit: (e) => { rows.push({ name: e.name, path: e.path }); } });
    index.set(root, rows);
    return res;
  },
  drop({ root }) { return index.delete(root); },
  async search({ query, limit = 30, loose = false }) {
    const hits = [];
    for (const [root, rows] of index) for (const r of rows) hits.push({ name: r.name, path: r.path, root });
    const ranked = rank(query, hits, { limit, loose, where: (x) => x.path.slice(x.root.length) });
    return withStats(ranked.map((x) => x.item));
  },
  async find({ dir, name, size = 0 }) {
    // The nearest folder that still exists, and its parent: the file was moved a little way, not across the disk.
    let near = dir;
    for (let i = 0; i < 6; i++) { try { if ((await fs.promises.stat(near)).isDirectory()) break; } catch { /* look one up */ } const up = path.dirname(near); if (up === near) break; near = up; }
    const roots = [...new Set([near, path.dirname(near)])];
    const lower = String(name).toLowerCase();
    const ext = path.extname(lower);
    const ws = words(path.basename(lower, ext));
    const exact = [];
    const similar = [];
    const seen = new Set();
    for (const root of roots) {
      await walk(root, {
        depth: 2, cap: 6000, deadline: Date.now() + 4000,
        visit: (e) => {
          if (seen.has(e.path)) return true;
          seen.add(e.path);
          const n = e.name.toLowerCase();
          if (n === lower) exact.push(e);
          else if (size > 0 && path.extname(n) === ext && matchText(ws, path.basename(n, ext), { loose: true })) similar.push(e);
          return true;
        },
      });
    }
    const checked = await withStats(similar.slice(0, 60), '');
    const sameSize = size > 0 ? checked.filter((c) => c.size === size) : [];
    const exactRows = await withStats(exact.slice(0, 8), '');
    const all = [...exactRows, ...sameSize].filter((c, i, a) => a.findIndex((o) => o.path === c.path) === i);
    all.sort((a, b) => (b.name.toLowerCase() === lower) - (a.name.toLowerCase() === lower) || b.mtime - a.mtime);
    return all.slice(0, 8).map(({ path: p, name: n, size: s, mtime }) => ({ path: p, name: n, size: s, mtime }));
  },
  async scan({ roots, query, depth = 4, cap = 30000, timeMs = 8000, limit = 8, loose = true }) {
    const rows = [];
    const deadline = Date.now() + timeMs;
    let left = cap;
    for (const root of roots) {
      const res = await walk(root, { depth, cap: left, deadline, visit: (e) => { rows.push({ name: e.name, path: e.path, root }); } });
      left -= res.count;
      if (left <= 0 || Date.now() > deadline) break;
    }
    const ranked = rank(query, rows, { limit, loose, where: (x) => x.path.slice(x.root.length) });
    return withStats(ranked.map((x) => x.item));
  },
};

parentPort.on('message', async (msg) => {
  const { id, type } = msg || {};
  try { parentPort.postMessage({ id, ok: true, result: await jobs[type](msg) }); } catch (err) { parentPort.postMessage({ id, ok: false, error: String(err?.message || err) }); }
});
