// ---------- downloads the AI is told about ----------
// A file Lumen downloads is in Lumen's own list (features/downloads.js, downloads.json): name, full path, size, state. The AI is told about
// it where it already looks, so it never searches the disk (a Bash `find` for *.docx took minutes):
//   - the result of the action that started the download (a click, a key, a script) waits for the file and ends with
//     "Downloaded: <name> (<size>) at <path>", or says why it did not finish;
//   - wait_for {download:true} waits for the download in progress or the newest one and says the same;
//   - any other tool result, and the next message's <browser_state>, carry a download that finished since the AI last heard of one,
//     the user's own included (once each, within the last few minutes);
//   - list_files {folder:"downloads"} lists that same list first, and {read:<path or name>} reads a text, Word (.docx) or Markdown file in it.
// A download that started during the AI's own action in a chat is that chat's own file (no card to read it, like a file it wrote:
// features/ai-files.js); any other is asked about once, like a local file the user shares (#424). Outside agents (MCP) never download:
// features/downloads.js refuses a download from their window (#352).
const fs = require('fs');
const path = require('path');
const { docxText, isDocxName } = require('./docx-text');
const { PptxError } = require('./pptx');
class Say extends Error {} // a message meant for the model, as it is

const NOTE_WINDOW_MS = 5 * 60 * 1000; // a finished download is mentioned this long
const WAIT_MS = 20000; // how long an action waits for the file it started
const MAX_NOTES = 3;
const READ_CHARS = 30000;
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml', 'ics', 'srt', 'vtt']);

const sizeText = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 102.4)) / 10} MB`;
};

// A list entry's size: the file's own when it is there, else what was received.
function sizeOf(entry) {
  try { if (entry.path) return fs.statSync(entry.path).size; } catch { /* moved or deleted */ }
  return Number(entry.received) || 0;
}

// One line for one entry, whatever its state.
function lineOf(entry) {
  const name = entry.name || path.basename(entry.path || '') || 'a file';
  if (entry.state === 'completed' && entry.path) return `Downloaded: ${name} (${sizeText(sizeOf(entry))}) at ${entry.path}`;
  if (entry.awaitingOk) return `Download not finished: ${name} is a program or script, so Lumen is asking the user before it saves it.`;
  if (entry.state === 'cancelled') return `Download cancelled: ${name}.`;
  if (entry.state === 'interrupted') return `Download failed: ${name}.`;
  return `Downloading: ${name} (${sizeText(entry.received)}${entry.total > 0 ? ` of ${sizeText(entry.total)}` : ''} so far), not finished yet.`;
}

// ---- which downloads each chat has been told about (a WeakMap keyed by the chat's messages array, or the run's scope)
const told = new WeakMap();
const toldOf = (key) => { let set = told.get(key); if (!set) told.set(key, (set = new Set())); return set; };
const owned = new WeakMap();
const ownOf = (key) => { let set = owned.get(key); if (!set) owned.set(key, (set = new Set())); return set; };

// Downloads the user or a page started that finished lately and this chat has not heard of: lines, marked as told.
function news(list, key, { now = Date.now(), limit = MAX_NOTES, mark = true } = {}) {
  if (!Array.isArray(list) || !key || typeof key !== 'object') return [];
  const seen = toldOf(key);
  const fresh = list.filter((d) => d && d.state === 'completed' && d.path && !seen.has(d.id) && d.endedAt && now - d.endedAt <= NOTE_WINDOW_MS).slice(0, limit);
  if (mark) for (const d of fresh) seen.add(d.id);
  return fresh.map(lineOf);
}

// Downloads that started since `t0` (an action of the AI's began then).
const startedSince = (list, t0) => (Array.isArray(list) ? list.filter((d) => d && d.started >= t0 - 300) : []);

// Waits until none of `entries` is still running (a download waiting for the user's OK counts as settled: it may never finish).
async function settle(entries, { timeoutMs = WAIT_MS, signal = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = Date.now() + timeoutMs;
  const running = () => entries.some((d) => d.state === 'progressing' && !d.awaitingOk);
  while (running() && Date.now() < end && !(signal && signal.aborted)) await sleep(120);
}

// The lines for what an action started: waits for it, marks it the chat's own and told.
async function afterAction(list, key, t0, opts = {}) {
  // A download starts when the response headers arrive, a moment after the click: look a little longer before saying nothing started.
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let waited = 0; !startedSince(list, t0).length && waited < (opts.graceMs ?? 0); waited += 50) await sleep(50);
  const started = startedSince(list, t0);
  if (!started.length) return [];
  for (const d of started) { ownOf(key).add(d.id); toldOf(key).add(d.id); }
  await settle(started, opts);
  return started.slice(0, MAX_NOTES).map(lineOf);
}

const isOwn = (key, entry) => Boolean(key && typeof key === 'object' && ownOf(key).has(entry.id));
const markOwn = (key, entry) => { if (key && typeof key === 'object') { ownOf(key).add(entry.id); toldOf(key).add(entry.id); } };

// list_files folder:"downloads": Lumen's list, newest first.
function listText(list, { limit = 15, match = '' } = {}) {
  const re = match ? new RegExp(`^${String(match).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
  const rows = (Array.isArray(list) ? list : []).filter((d) => d && (!re || re.test(d.name || ''))).slice(0, Math.min(Math.max(limit, 1), 50));
  if (!rows.length) return '';
  return `Lumen's download list (newest first, full paths; no disk search needed):\n${rows.map((d) => `- ${lineOf(d).replace(/^Downloaded: /, '')}${d.state === 'completed' ? '' : ` [${d.state}]`}`).join('\n')}`;
}

// A downloaded file named by its path (or just its name): the newest completed entry that fits.
function find(list, ref) {
  const want = String(ref || '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!want) return null;
  const done = (Array.isArray(list) ? list : []).filter((d) => d && d.state === 'completed' && d.path);
  const norm = (p) => path.resolve(String(p)).toLowerCase();
  const byPath = done.find((d) => norm(d.path) === norm(want));
  if (byPath) return byPath;
  const base = path.basename(want).toLowerCase();
  return done.find((d) => (d.name || '').toLowerCase() === base) || null;
}

// The text of a downloaded file: { text, from, to, total }, or throws a plain message for the model.
async function readText(entry, { offset = 0, maxChars = READ_CHARS } = {}) {
  const ext = path.extname(entry.path || '').slice(1).toLowerCase();
  let full;
  try {
    if (!fs.existsSync(entry.path)) throw new Say(`${entry.name} is no longer at ${entry.path}.`);
    if (isDocxName(entry.path)) full = await docxText(await fs.promises.readFile(entry.path));
    else if (TEXT_EXTS.has(ext)) {
      const stat = await fs.promises.stat(entry.path);
      if (stat.size > 20 * 1024 * 1024) throw new Say(`${entry.name} is too large to read here (${sizeText(stat.size)}).`);
      full = (await fs.promises.readFile(entry.path, 'utf8')).replace(/^\uFEFF/, '');
    } else if (ext === 'pdf') throw new Say(`${entry.name} is a PDF: open_tab with its path, then read_pdf.`);
    else if (ext === 'pptx') throw new Say(`${entry.name} is a PowerPoint deck: open_tab with its path shows it, then read_pdf reads its slide text.`);
    else throw new Say(`Lumen cannot read the text of a .${ext || 'unknown'} file. Tell the user where it is: ${entry.path}`);
  } catch (err) {
    if (err instanceof Say || err instanceof PptxError) throw new Error(err.message);
    throw new Error(`${entry.name} could not be read.`);
  }
  const from = Math.min(Math.max(0, Math.floor(Number(offset)) || 0), full.length);
  const text = full.slice(from, from + maxChars);
  return { text, from, to: from + text.length, total: full.length };
}

module.exports = { NOTE_WINDOW_MS, WAIT_MS, MAX_NOTES, sizeText, sizeOf, lineOf, news, startedSince, settle, afterAction, isOwn, markOwn, listText, find, readText };
