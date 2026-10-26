// Portable projects: a project with a folder can keep what it is made of as plain files there, so nothing about it depends on Lumen or on one AI.
//
//   <folder>/INSTRUCTIONS.md   the project's instructions (the source of truth)
//   <folder>/AGENTS.md         a copy of them, the name coding agents look for (Claude Code, Codex, Gemini CLI and others read it from their working directory)
//   <folder>/CLAUDE.md         "@AGENTS.md", written only when there is no CLAUDE.md
//   <folder>/sources.md        the project's web pages and websites, one per line: - [Title](https://address) (and "- [Title](https://site/path/) — whole site")
//   <folder>/Sources/          the files added to the project, as the real files
//   <folder>/project.json      the goal line and the defaults (model, plan first, connectors, MCP tools)
//   <folder>/Chats/            the chats as Markdown (features/project-folders.js; its own switch)
//
// Changes made outside Lumen (edit INSTRUCTIONS.md in an editor, drop a PDF in Sources/) are picked up by sync(); changes made in Lumen are written
// out by the same call. Electron-free, async, no timers: main.js decides when to call it (a project page opening, the window getting focus, a change
// made in Lumen). It never loops: what it writes it records, so the next call finds nothing to do. It never deletes text it cannot replace: when both
// sides changed since the last sync the newer one wins and the other is kept next to it as "<name>.conflict-<date>.<ext>".
//
//   sha(text), canon(text)        a digest, and the text as compared (line ends and trailing space ignored)
//   reconcile({ store, file, last, storeTime, fileTime })   -> { do: 'none' | 'writeFile' | 'adoptFile', conflict?, loser? }: who is right about one text
//   renderSources(links), parseSources(text), mergeLinks(parsed, existing)
//   sync(ctx)                      one pass over the folder (see below); -> { changed, wrote, adopted, files, conflicts, missing }
//   writeUpload(ctx, name, bytes), renameFile(ctx, from, to), removeFile(ctx, name)   what Lumen's own changes to Sources/ do in the folder
//   readFolder(folder)             what a folder holds, for "Open folder as project" (a folder made by hand works too)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INSTRUCTIONS = 'INSTRUCTIONS.md';
const AGENTS = 'AGENTS.md';
const CLAUDE = 'CLAUDE.md';
const SOURCES_MD = 'sources.md';
const SOURCES_DIR = 'Sources';
const SETTINGS = 'project.json';
const MAX_FILES = 40;
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const FORMAT = 1;

const sha = (t) => crypto.createHash('sha1').update(String(t ?? '')).digest('base64');
const canon = (t) => String(t ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };

// ---- who is right about one text
// store: the text in Lumen; file: the text in the folder (null: no such file); last: the digest both agreed on at the last sync ('' = never synced).
function reconcile({ store, file, last = '', storeTime = 0, fileTime = 0 }) {
  const s = sha(canon(store));
  if (file == null) return canon(store) ? { do: 'writeFile' } : { do: 'none' }; // a deleted file comes back from Lumen's copy; nothing to write when both are empty
  const f = sha(canon(file));
  if (f === s) return { do: 'none' };
  if (last && f === last) return { do: 'writeFile' }; // only Lumen's copy changed
  if (last && s === last) return { do: 'adoptFile' }; // only the file changed
  if (!canon(store)) return { do: 'adoptFile' }; // nothing in Lumen to lose
  if (!canon(file)) return { do: 'writeFile' };
  const fileWins = !last ? true : fileTime >= storeTime; // never synced: what is on disk is what the user sees
  return { do: fileWins ? 'adoptFile' : 'writeFile', conflict: true, loser: fileWins ? 'store' : 'file' };
}

// ---- sources.md
const SOURCES_HEAD = '# Sources\n\nWeb pages and websites the AI may read in this project. One per line: `- [Title](address)`; add ` — whole site` after a website (an address or a path prefix).\nLumen reads this file again when it changes, so you can edit it here.\n';
const tidy = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
function renderSources(links) {
  const lines = (links || []).map((l) => `- [${tidy(l.title) || hostOf(l.url)}](${l.url})${l.site ? ' — whole site' : ''}`);
  return `${SOURCES_HEAD}\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}
function hostOf(url) { try { return new URL(url).host.replace(/^www\./, ''); } catch { return String(url); } }
const LINE = /^\s*[-*+]\s+(?:\[([^\]]*)\]\(\s*(\S+?)\s*\)|<?(https?:\/\/[^\s>]+)>?)\s*(?:[—–-]+\s*whole\s*sites?|\(whole\s*sites?\))?\s*$/i;
const SITE_MARK = /(?:[—–-]+\s*whole\s*sites?|\(whole\s*sites?\))\s*$/i;
// -> [{ url, title, site }] for the lines that are sources (http and https only); other lines are the user's own notes
function parseSources(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    let url = String(m[2] || m[3] || '').trim();
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) continue; u.hash = ''; url = u.href; } catch { continue; }
    const site = SITE_MARK.test(raw);
    const key = `${site ? 's' : 'p'}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = tidy(m[1]);
    out.push({ url, title: title === hostOf(url) ? '' : title, site });
  }
  return out;
}
// Lines the user wrote that are not sources (so a rewrite of the file can be told from losing a note): anything but the header, blanks and source lines.
const hasNotes = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').some((l) => l.trim() && !LINE.test(l) && !SOURCES_HEAD.split('\n').includes(l) && !/^#\s*sources\s*$/i.test(l.trim()));
// The parsed lines on top of what the project already has: the same address keeps its time; a title typed in the file that differs is the user's own (named).
function mergeLinks(parsed, existing) {
  return parsed.map((p) => {
    const old = (existing || []).find((l) => l.url === p.url && Boolean(l.site) === p.site);
    const title = p.title;
    return {
      url: p.url, title: title || '', added: old?.added || Date.now(),
      ...(title && (!old || title !== old.title) ? { named: true } : old?.named && title ? { named: true } : {}),
      ...(p.site ? { site: true } : {}),
    };
  });
}

// ---- project.json: the goal line and the defaults (the name is the folder's)
const settingsText = (s, { withName = false } = {}) => `${JSON.stringify({ format: FORMAT, ...(withName && s.name ? { name: String(s.name) } : {}), description: s.description || '', defaults: s.defaults || {} }, null, 2)}\n`;
function parseSettings(text) {
  try {
    const j = JSON.parse(String(text));
    const d = j?.defaults && typeof j.defaults === 'object' ? j.defaults : {};
    return { name: typeof j?.name === 'string' ? j.name.slice(0, 60) : '', description: typeof j?.description === 'string' ? j.description.slice(0, 200) : '', defaults: { ...(typeof d.model === 'string' && d.model ? { model: d.model.slice(0, 120) } : {}), ...(d.plan === true ? { plan: true } : {}), ...(d.connectors === false ? { connectors: false } : {}), ...(d.mcp === false ? { mcp: false } : {}) } };
  } catch { return null; }
}

// ---- helpers over the folder
const exists = async (fsp, p) => { try { await fsp.lstat(p); return true; } catch { return false; } };
const readText = async (fsp, p) => { try { return await fsp.readFile(p, 'utf8'); } catch (err) { if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null; throw err; } };
async function writeText(fsp, file, text) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { await fsp.writeFile(tmp, text, 'utf8'); await fsp.rename(tmp, file); } catch (err) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw err; }
}
const mtimeOf = async (fsp, p) => { try { return (await fsp.stat(p)).mtimeMs; } catch { return 0; } };
const conflictName = (name, ms) => { const ext = path.extname(name); return `${name.slice(0, name.length - ext.length)}.conflict-${stamp(ms)}${ext}`; };
async function keepAside(fsp, folder, name, text, ms) { // the text that lost, next to the one that won
  let target = path.join(folder, conflictName(name, ms));
  for (let n = 2; await exists(fsp, target); n++) target = path.join(folder, conflictName(name, ms).replace(/(\.[^.]+)$/, `-${n}$1`));
  await writeText(fsp, target, text);
  return path.basename(target);
}

// ---- the pass
// ctx: {
//   folder, fsp?, now?, state            the project's folder; state is { last: { instructions, sources, settings }, files: { <name>: { size, mtimeMs, id, failed? } } }, mutated here
//   get()                                -> { instructions, links, description, defaults } as Lumen has them now (and `updated`: when it last changed)
//   apply(patch)                         sets what the folder won: { instructions?, links?, description?, defaults? }
//   files: { list(), add({ name, bytes }) -> { ok, file, error }, remove(id), kindOf(name) -> '' | kind }
// }
async function sync(ctx) {
  const fsp = ctx.fsp || fs.promises;
  const now = ctx.now || (() => Date.now());
  const { folder, state } = ctx;
  const out = { changed: false, wrote: [], adopted: [], files: { added: [], updated: [], removed: [], failed: [] }, conflicts: [], missing: false };
  state.last ||= {};
  state.files ||= {};
  let st;
  try { st = await fsp.stat(folder); } catch { out.missing = true; return out; }
  if (!st.isDirectory()) { out.missing = true; return out; }
  const have = ctx.get();
  const storeTime = Number(have.updated) || 0;
  const patch = {};

  // instructions: INSTRUCTIONS.md and its copy AGENTS.md
  {
    const a = path.join(folder, INSTRUCTIONS);
    const b = path.join(folder, AGENTS);
    const ta = await readText(fsp, a);
    const tb = await readText(fsp, b);
    const last = state.last.instructions || '';
    // the file that changed since the last sync is the one that counts; both changed and differing: INSTRUCTIONS.md, the other is kept aside
    const changed = (t) => t != null && last && sha(canon(t)) !== last;
    let file = ta;
    let loserCopy = null;
    if (ta == null && tb != null) file = tb;
    else if (ta != null && tb != null && sha(canon(ta)) !== sha(canon(tb))) {
      if (changed(tb) && !changed(ta)) file = tb;
      else if (changed(tb) && changed(ta)) loserCopy = { name: AGENTS, text: tb };
      else if (!last && !canon(ta)) file = tb;
    }
    const mt = await mtimeOf(fsp, file === tb && tb != null && ta == null ? b : a);
    const r = reconcile({ store: have.instructions, file, last, storeTime, fileTime: mt });
    let text = canon(have.instructions);
    if (r.do === 'adoptFile') {
      if (r.conflict && canon(have.instructions)) out.conflicts.push(await keepAside(fsp, folder, INSTRUCTIONS, `${canon(have.instructions)}\n`, now()));
      text = canon(file);
      patch.instructions = text;
      out.adopted.push('instructions');
    } else if (r.do === 'writeFile' && r.conflict && file != null) out.conflicts.push(await keepAside(fsp, folder, INSTRUCTIONS, file, now()));
    if (loserCopy) out.conflicts.push(await keepAside(fsp, folder, AGENTS, loserCopy.text, now()));
    if (text || ta != null || tb != null) {
      const body = text ? `${text}\n` : '';
      if (ta == null || sha(canon(ta)) !== sha(text)) { if (text || ta != null) { await writeText(fsp, a, body); out.wrote.push(INSTRUCTIONS); } }
      if (text && (tb == null || sha(canon(tb)) !== sha(text))) { await writeText(fsp, b, body); out.wrote.push(AGENTS); }
      if (text && !(await exists(fsp, path.join(folder, CLAUDE)))) { await writeText(fsp, path.join(folder, CLAUDE), '@AGENTS.md\n'); out.wrote.push(CLAUDE); }
    }
    state.last.instructions = sha(text);
  }

  // sources.md: the web pages and websites
  {
    const f = path.join(folder, SOURCES_MD);
    const raw = await readText(fsp, f);
    const storeText = canon(renderSources(have.links));
    const fileCanon = raw == null ? null : canon(renderSources(mergeLinks(parseSources(raw), have.links)));
    const last = state.last.sources || '';
    const empty = !(have.links || []).length;
    const r = reconcile({ store: empty ? '' : storeText, file: raw == null ? null : (parseSources(raw).length ? fileCanon : ''), last, storeTime, fileTime: await mtimeOf(fsp, f) });
    if (r.do === 'adoptFile') {
      if (r.conflict) out.conflicts.push(await keepAside(fsp, folder, SOURCES_MD, renderSources(have.links), now()));
      patch.links = mergeLinks(parseSources(raw), have.links);
      out.adopted.push('sources');
      state.last.sources = sha(canon(renderSources(patch.links)));
    } else if (r.do === 'writeFile') {
      if (raw != null && (r.conflict || hasNotes(raw))) out.conflicts.push(await keepAside(fsp, folder, SOURCES_MD, raw, now()));
      await writeText(fsp, f, renderSources(have.links));
      out.wrote.push(SOURCES_MD);
      state.last.sources = sha(storeText);
    } else state.last.sources = sha(empty ? '' : storeText);
    if (raw == null && empty) { await writeText(fsp, f, renderSources([])); out.wrote.push(SOURCES_MD); state.last.sources = sha(''); }
  }

  // project.json: the goal line and the defaults
  {
    const f = path.join(folder, SETTINGS);
    const raw = await readText(fsp, f);
    const parsed = raw == null ? null : parseSettings(raw);
    const storeText = canon(settingsText(have));
    const last = state.last.settings || '';
    const r = reconcile({ store: storeText, file: raw == null ? null : parsed ? canon(settingsText(parsed)) : '', last, storeTime, fileTime: await mtimeOf(fsp, f) });
    if (r.do === 'adoptFile' && parsed) {
      if (r.conflict) out.conflicts.push(await keepAside(fsp, folder, SETTINGS, settingsText(have), now()));
      patch.description = parsed.description;
      patch.defaults = parsed.defaults;
      out.adopted.push('settings');
      state.last.settings = sha(canon(settingsText(parsed)));
    } else if (r.do === 'writeFile' || raw == null) {
      if (raw != null && parsed == null) out.conflicts.push(await keepAside(fsp, folder, SETTINGS, raw, now())); // not valid JSON: kept, not lost
      await writeText(fsp, f, settingsText(have));
      out.wrote.push(SETTINGS);
      state.last.settings = sha(storeText);
    } else state.last.settings = sha(storeText);
  }

  // Sources/: the real files
  {
    const dir = path.join(folder, SOURCES_DIR);
    const names = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (names) {
      const seen = new Set();
      for (const ent of names) {
        if (!ent.isFile() || ent.name.startsWith('.') || ent.name.startsWith('~$') || /\.tmp$/i.test(ent.name) || !ctx.files.kindOf(ent.name)) continue;
        seen.add(ent.name);
        const full = path.join(dir, ent.name);
        let stat;
        try { stat = await fsp.stat(full); } catch { continue; }
        const rec = state.files[ent.name];
        if (rec && rec.size === stat.size && Math.abs(rec.mtimeMs - stat.mtimeMs) < 1) continue; // unchanged (or written by Lumen itself)
        if (stat.size > MAX_FILE_BYTES) { state.files[ent.name] = { size: stat.size, mtimeMs: stat.mtimeMs, failed: true }; out.files.failed.push(`${ent.name}: too large`); continue; }
        if (!rec && ctx.files.list().length >= MAX_FILES) { out.files.failed.push(`${ent.name}: a project holds up to ${MAX_FILES} files`); continue; }
        let bytes;
        try { bytes = await fsp.readFile(full); } catch { continue; }
        const r = await ctx.files.add({ name: ent.name, bytes });
        if (r.ok) { state.files[ent.name] = { size: stat.size, mtimeMs: stat.mtimeMs, id: r.file.id }; (rec?.id ? out.files.updated : out.files.added).push(ent.name); out.changed = true; }
        else { state.files[ent.name] = { size: stat.size, mtimeMs: stat.mtimeMs, failed: true, ...(rec?.id ? { id: rec.id } : {}) }; out.files.failed.push(`${ent.name}: ${r.error}`); }
      }
      for (const [name, rec] of Object.entries(state.files)) {
        if (seen.has(name)) continue;
        if (await exists(fsp, path.join(dir, name))) continue; // (present but not listed: a name this pass skips)
        if (rec.id && ctx.files.list().some((x) => x.id === rec.id)) { await ctx.files.remove(rec.id); out.files.removed.push(name); out.changed = true; }
        delete state.files[name];
      }
    }
  }

  if (Object.keys(patch).length) { ctx.apply(patch); out.changed = true; }
  return out;
}

// ---- Lumen's own changes to Sources/ (when the project keeps plain files)
async function writeUpload(ctx, name, bytes, id) {
  const fsp = ctx.fsp || fs.promises;
  const dir = path.join(ctx.folder, SOURCES_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { await fsp.writeFile(tmp, bytes); await fsp.rename(tmp, file); } catch (err) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw err; }
  const stat = await fsp.stat(file);
  (ctx.state.files ||= {})[name] = { size: stat.size, mtimeMs: stat.mtimeMs, id };
}
async function renameFile(ctx, from, to) {
  const fsp = ctx.fsp || fs.promises;
  const dir = path.join(ctx.folder, SOURCES_DIR);
  const rec = ctx.state.files?.[from];
  if (!rec || !(await exists(fsp, path.join(dir, from))) || await exists(fsp, path.join(dir, to))) return false;
  await fsp.rename(path.join(dir, from), path.join(dir, to));
  ctx.state.files[to] = rec;
  delete ctx.state.files[from];
  return true;
}
// A file removed in Lumen leaves Sources/ for Sources/Removed/ (never deleted): the scan does not look in sub-folders.
async function removeFile(ctx, name) {
  const fsp = ctx.fsp || fs.promises;
  const dir = path.join(ctx.folder, SOURCES_DIR);
  const from = path.join(dir, name);
  delete ctx.state.files?.[name];
  if (!(await exists(fsp, from))) return false;
  const shelf = path.join(dir, 'Removed');
  await fsp.mkdir(shelf, { recursive: true });
  let target = path.join(shelf, name);
  for (let n = 2; await exists(fsp, target); n++) target = path.join(shelf, name.replace(/(\.[^.]*)?$/, ` (${n})$1`));
  await fsp.rename(from, target);
  return true;
}

// ---- "Open folder as project": what a folder holds. Works for a folder Lumen wrote, one made by hand, or a plain folder of files.
// -> { instructions, links, description, defaults, files: [{ name, bytes }], loose: boolean }
async function readFolder(folder, { kindOf = () => 'text', fsp = fs.promises } = {}) {
  const first = async (...names) => { for (const n of names) { const t = await readText(fsp, path.join(folder, n)); if (t != null && canon(t)) return { name: n, text: t }; } return null; };
  const ins = await first(INSTRUCTIONS, AGENTS);
  let instructions = ins ? canon(ins.text) : '';
  if (!instructions) { const c = await first(CLAUDE); if (c && !/^@\S+\s*$/.test(canon(c.text))) instructions = canon(c.text); }
  const src = await readText(fsp, path.join(folder, SOURCES_MD));
  const links = src ? mergeLinks(parseSources(src), []) : [];
  const set = parseSettings(await readText(fsp, path.join(folder, SETTINGS)) || '') || { name: '', description: '', defaults: {} };
  const files = [];
  const take = async (dir) => {
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!ents) return;
    for (const e of ents.sort((x, y) => x.name.localeCompare(y.name))) {
      if (files.length >= MAX_FILES) break;
      if (!e.isFile() || e.name.startsWith('.') || !kindOf(e.name)) continue;
      if ([INSTRUCTIONS, AGENTS, CLAUDE, SOURCES_MD, SETTINGS].includes(e.name) || /\.conflict-\d{8}-\d{6}/.test(e.name)) continue;
      try { const stat = await fsp.stat(path.join(dir, e.name)); if (stat.size > MAX_FILE_BYTES) continue; files.push({ name: e.name, bytes: await fsp.readFile(path.join(dir, e.name)), inSources: dir !== folder }); } catch { /* skipped */ }
    }
  };
  await take(path.join(folder, SOURCES_DIR));
  const loose = !files.length && !instructions && !links.length; // a plain folder of files: its own files are the sources
  if (loose) await take(folder);
  return { instructions, links, name: set.name || '', description: set.description, defaults: set.defaults, files, loose };
}

module.exports = { INSTRUCTIONS, AGENTS, CLAUDE, SOURCES_MD, SOURCES_DIR, SETTINGS, FORMAT, sha, canon, reconcile, renderSources, parseSources, mergeLinks, hasNotes, settingsText, parseSettings, sync, writeUpload, renameFile, removeFile, readFolder, conflictName };
