// Saved AI chats: the sidebar's history list. Each chat is one file in <userData>/chats/, plus an
// index (titles, dates, usage totals, which chat is open). Everything on disk is encrypted the same
// way the single chat.json was (the OS keychain, through `encrypt`/`decrypt`); with no keychain,
// nothing is kept at all. What goes into a chat file is decided by the caller (main.js strips tool
// results and attached page text first).
//
// Nothing falls off the end of the list: past `limit` active chats the oldest unpinned ones are ARCHIVED (still saved, listed
// under Archived, searchable), never deleted. Chats can be pinned and archived; an entry's flags are plain optional fields
// (pinned, archived, autoArchived, trashed, msgs) that older index files simply don't have, so they load as they were.
// Deleting is two steps so it can be undone: trash() hides the chat (its file stays), remove() erases it.
// An empty chat (no messages yet) is never written, so New chat doesn't fill the list with blank entries.
//
// Chat files are only ever deleted one at a time, for a reason (the user deleted the chat and the undo time passed),
// after the index on disk has been read again, and never for a chat another writer's index lists (a second Lumen, or a
// test run, on the same profile). Nothing here removes the whole folder: a "clear everything" once ran from a second
// process that quit before the keychain was ready, and took every chat with it.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { plainScripts } = require('../renderer/markdown.js'); // <sub>/<sup> as clean text in exports

const ID_RE = /^[a-f0-9]{16}$/;

// The history list's title for a chat until the user renames it: features/chat-title.js (no model call).
const { autoTitle, cleanSaved } = require('./chat-title');

const cleanTitle = (title) => String(title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextTick = () => new Promise((r) => setImmediate(r));

// JSON.stringify(value) built in slices: the work is cut up so that no single task of the main thread runs longer than SLICE_MS (a 400-message
// chat stringified, hashed and measured in one go is several ms; a long one with versions is more). The text is the same as JSON.stringify's,
// character for character (the digest of a chat that was loaded must match the one of the same chat saved again), and the hash and the size
// of the messages' content (the list entry's `sig`) come out of the same pass. Arrays and objects are walked down to MAX_DEPTH
// (snapshot -> messages -> a message -> its fields); below that a value is stringified whole.
const SLICE_MS = 4;
const MAX_DEPTH = 3;
async function serializeInSlices(snapshot) {
  const hash = crypto.createHash('sha1');
  const parts = [];
  let size = 0;
  let started = performance.now();
  const emit = (s) => { parts.push(s); hash.update(s); };
  const breathe = async () => { if (performance.now() - started > SLICE_MS) { await nextTick(); started = performance.now(); } };
  // Returns false when the value has no JSON form (undefined, a function): the caller leaves the key out.
  async function walk(value, depth, trail) {
    if (depth >= MAX_DEPTH || value === null || typeof value !== 'object' || typeof value.toJSON === 'function') {
      const s = JSON.stringify(value);
      if (s === undefined) return false;
      if (trail === 'messages.*.content') size += s.length;
      emit(s);
      await breathe();
      return true;
    }
    if (Array.isArray(value)) {
      emit('[');
      for (let i = 0; i < value.length; i++) {
        if (i) emit(',');
        if (!(await walk(value[i], depth + 1, trail === 'messages' ? 'messages.*' : ''))) emit('null');
      }
      emit(']');
      return true;
    }
    emit('{');
    let first = true;
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      emit(`${first ? '' : ','}${JSON.stringify(key)}:`);
      first = false;
      await walk(v, depth + 1, depth === 0 ? key : trail === 'messages.*' ? `${trail}.${key}` : '');
    }
    emit('}');
    return true;
  }
  await walk(snapshot, 0, '');
  return { text: parts.join(''), digest: hash.digest('base64'), size };
}

function createChatStore({ dir, encrypt, decrypt, available = () => true, limit = 500, legacyFile = null, now = () => Date.now(), onError = (err) => console.error('Could not save chat:', err?.message) }) {
  const indexFile = path.join(dir, 'index.json');
  const chatFile = (id) => path.join(dir, `${id}.json`);

  const writeAtomic = (file, data, text) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ enc: encrypt(text ?? JSON.stringify(data)) }));
    fs.renameSync(tmp, file); // never a half-written file
  };
  // The same, without a pause of the main thread: a temp file under its own name, then one rename. Writes to one file go one after the
  // other (queued), never interleaved. `stillWanted()` is asked just before the rename: false drops the temp file (a newer write got there first).
  const fileQueues = new Map();
  const queued = (file, task) => {
    const run = (fileQueues.get(file) || Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    fileQueues.set(file, tail);
    tail.then(() => { if (fileQueues.get(file) === tail) fileQueues.delete(file); });
    return run;
  };
  let tmpSeq = 0;
  const TRANSIENT_WRITE = new Set(['EBUSY', 'EPERM', 'EACCES']); // a scanner or indexer holds the target for a moment (Windows)
  const writeAtomicAsync = (file, enc, stillWanted = () => true) => queued(file, async () => {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}-${++tmpSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ enc }));
      for (let attempt = 1; ; attempt++) {
        if (!stillWanted()) { await fsp.rm(tmp, { force: true }); return false; }
        try { await fsp.rename(tmp, file); return true; } catch (err) { // never a half-written file
          if (!TRANSIENT_WRITE.has(err?.code) || attempt >= 4) throw err;
          await sleep(20 * attempt);
        }
      }
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  });
  const fileThere = (file) => fsp.access(file).then(() => true, () => false);
  const readEnc = (file, seen) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.enc) return data;
    const text = decrypt(data.enc);
    if (seen) seen.text = text; // (load() remembers what the file holds: see savedDigest)
    return JSON.parse(text);
  };

  let index = null; // { current, chats: [{ id, title, renamed, created, updated, model, usage }] }
  const known = new Set(); // chat ids in the index as this store last read or wrote it
  const foreign = new Set(); // ids another writer added to the index on disk meanwhile: never pruned or deleted here
  const TRASH_KEEP_MS = 24 * 3600 * 1000; // a trashed chat nobody undid (the app quit inside the undo time) is erased after this
  // The index can be lost to a half-written file, a locked keychain or another machine's keys. Only a
  // missing file means "no chats yet"; anything else must never become an empty index that the next
  // write would save over the real one (that orphaned every chat file).
  const CHAT_FILE_RE = /^[a-f0-9]{16}\.json$/;
  function rebuildIndex() {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => CHAT_FILE_RE.test(n)); } catch { /* no folder: nothing to rebuild */ }
    const chats = [];
    let unreadable = 0;
    for (const name of names) {
      const id = name.slice(0, -5);
      try {
        const snapshot = readEnc(chatFile(id));
        if (!snapshot?.messages?.length) { unreadable++; continue; }
        const mtime = fs.statSync(chatFile(id)).mtimeMs;
        chats.push({ id, title: autoTitle(snapshot), renamed: false, created: mtime, updated: mtime, model: snapshot.settings?.model || null, usage: snapshot.settings?.usage || null });
      } catch { unreadable++; }
    }
    return { chats, unreadable };
  }
  function readIndex() {
    if (index) return index;
    let data = null;
    let raw = null;
    try {
      raw = fs.readFileSync(indexFile, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') return { current: null, chats: [], degraded: true }; // locked/unreadable right now: retry next call, never write
    }
    if (raw !== null) {
      try {
        const outer = JSON.parse(raw);
        data = outer.enc ? JSON.parse(decrypt(outer.enc)) : outer;
      } catch {
        // Unparseable or undecryptable: keep the file for inspection and rebuild from the chat files.
        try { fs.renameSync(indexFile, `${indexFile}.corrupt-${Date.now()}`); } catch { return { current: null, chats: [], degraded: true }; }
      }
    }
    if (data) {
      index = { current: ID_RE.test(data.current) ? data.current : null, chats: Array.isArray(data.chats) ? data.chats.filter((c) => ID_RE.test(c?.id)) : [] };
      if (Array.isArray(data.projects)) index.projects = data.projects.filter((p) => ID_RE.test(p?.id) && typeof p.name === 'string'); // (optional: older indexes have none)
      remember(index);
      return index;
    }
    // No index (never written, or just set aside as corrupt): rebuild it from the chat files.
    const { chats, unreadable } = rebuildIndex();
    if (!chats.length && unreadable) return { current: null, chats: [], degraded: true }; // chats exist but can't be read now: retry next call
    index = { current: null, chats };
    remember(index);
    if (chats.length && available()) { try { writeAtomic(indexFile, index); } catch { /* retried on the next write */ } }
    return index;
  }
  // The index as it is on disk right now (null: it can't be read: locked, undecryptable, half-written). A missing file is an empty list.
  function readDiskChats() {
    let raw;
    try { raw = fs.readFileSync(indexFile, 'utf8'); } catch (err) { return err?.code === 'ENOENT' ? [] : null; }
    try {
      const outer = JSON.parse(raw);
      const data = outer.enc ? JSON.parse(decrypt(outer.enc)) : outer;
      return Array.isArray(data.chats) ? data.chats.filter((c) => ID_RE.test(c?.id)) : [];
    } catch { return null; }
  }
  // Another writer on this profile may have added chats to the index since we read it. They join ours (and are never
  // pruned by us) so that our next write doesn't drop them and our prune doesn't delete their files.
  // Returns false when the disk index can't be read: then nothing may be deleted.
  function mergeDisk(idx, disk) {
    for (const c of disk) {
      if (known.has(c.id) || idx.chats.some((x) => x.id === c.id)) continue;
      idx.chats.push(c);
      known.add(c.id);
      foreign.add(c.id);
    }
  }
  function syncFromDisk(idx) {
    const disk = readDiskChats();
    if (!disk) return false;
    mergeDisk(idx, disk);
    return true;
  }
  // readDiskChats() without the pause (same answers: null when it can't be read, [] for no file).
  async function readDiskChatsAsync() {
    let raw;
    try { raw = await fsp.readFile(indexFile, 'utf8'); } catch (err) { return err?.code === 'ENOENT' ? [] : null; }
    try {
      const outer = JSON.parse(raw);
      const data = outer.enc ? JSON.parse(decrypt(outer.enc)) : outer;
      return Array.isArray(data.chats) ? data.chats.filter((c) => ID_RE.test(c?.id)) : [];
    } catch { return null; }
  }
  const remember = (idx) => { known.clear(); for (const c of idx.chats) known.add(c.id); };
  // A change that only moves the "open chat" pointer (switchChat, on every tab switch) is written a moment later, once: the index is read back
  // from disk, merged, encrypted and replaced each time it is written, which is work a tab switch must not wait for. Any other write carries
  // the pointer along, and flush() (quitting) writes what is pending.
  let indexTimer = null;
  const INDEX_DEFER_MS = 4000; // (after the last change: switching tabs one after another writes once, when it stops)
  let indexEpoch = 0; // counts the index writes made at once (writeIndex): an asynchronous write that started before one must not land over it
  let indexDigest = null; // the text last written (or found on disk): an index that did not change is not encrypted and written again
  let indexDirty = false; // changed in memory, not yet on disk
  const writeIndex = () => {
    clearTimeout(indexTimer);
    indexTimer = null;
    const idx = readIndex();
    if (idx.degraded || !available()) return;
    indexEpoch++;
    syncFromDisk(idx);
    writeAtomic(indexFile, idx);
    indexDigest = digestOf(JSON.stringify(idx));
    indexDirty = false;
    remember(idx);
  };
  // The same write without blocking: the disk's index is read, the text made, encrypted and written in the background, only when it
  // differs from what was last written, and one write at a time (a change that arrives meanwhile is picked up by a second round).
  let indexRun = null;
  let indexAgain = false;
  async function writeIndexAsyncOnce() {
    const idx = readIndex();
    if (idx.degraded || !available()) return;
    const disk = await readDiskChatsAsync();
    if (!disk) return; // (not readable now: nothing is written over it; the next change tries again)
    const live = readIndex();
    if (live !== idx || live.degraded) { indexAgain = true; return; } // (cleared meanwhile)
    mergeDisk(idx, disk);
    const epoch = indexEpoch;
    const text = JSON.stringify(idx);
    const digest = digestOf(text);
    indexDirty = false;
    remember(idx);
    if (digest === indexDigest && await fileThere(indexFile)) return; // unchanged: nothing to write
    const ok = await writeAtomicAsync(indexFile, encrypt(text), () => indexEpoch === epoch);
    if (!ok || indexEpoch !== epoch) { indexAgain = true; return; } // a write at once got in: its state is newer, written again from memory if this one landed over it
    indexDigest = digest;
  }
  function writeIndexAsync() {
    clearTimeout(indexTimer);
    indexTimer = null;
    indexDirty = true;
    if (indexRun) { indexAgain = true; return indexRun; }
    indexRun = (async () => {
      try {
        let rounds = 0;
        do { indexAgain = false; await writeIndexAsyncOnce(); } while (indexAgain && ++rounds < 5);
      } catch (err) { indexDirty = true; onError(err); } finally { indexRun = null; }
    })();
    return indexRun;
  }
  // `ms`: how long to wait for more changes first (the timer only ever moves sooner).
  let indexDueAt = 0;
  const writeIndexSoon = (ms = INDEX_DEFER_MS) => {
    indexDirty = true;
    const due = Date.now() + ms;
    if (indexTimer && indexDueAt <= due) return;
    clearTimeout(indexTimer);
    indexDueAt = due;
    indexTimer = setTimeout(() => { indexTimer = null; writeIndexAsync(); }, ms);
    indexTimer.unref?.();
  };
  // Quitting: what is pending is written now, at once (the app is closing; nothing is waiting on this thread).
  const flush = () => {
    for (const id of [...jobs.keys()]) flushJob(id);
    if (indexTimer || indexDirty) writeIndex();
  };
  // The last text written for each chat (a digest): saving a chat that has not changed since (leaving it on a tab switch) writes nothing.
  const savedDigest = new Map();
  const digestOf = (text) => crypto.createHash('sha1').update(text).digest('base64');

  const newId = () => crypto.randomBytes(8).toString('hex');

  // An entry whose chat file is gone (deleted by something else, a synced folder that lost it) is marked `missing`: the
  // History list must not show a row that opens empty (main.js leaves it out). Checked at most every few seconds per chat; the
  // entry stays in the index, so a file that comes back (a restored backup) or is only held by a scanner shows again.
  // Never a pause here: list() runs this for every entry, on the main thread, each time the sidebar, a tab switch or a window focus asks
  // for the list. It used to wait 25 ms and look again for each missing file (and load() below waited 120 ms more for each one's title):
  // an index with a couple of hundred entries whose files had been moved away froze the whole app for about 30 s at every look.
  // (Lumen's own writes replace a file with one rename, which never shows it missing; a file missing at one look is looked at again in 3 s.)
  const FILE_CHECK_MS = 3000;
  const fileChecks = new Map(); // id -> { at, ok }
  function fileExists(id) {
    const t = Date.now();
    const seen = fileChecks.get(id);
    if (jobs.has(id)) return true; // (being written: its file is about to be there)
    if (seen && t - seen.at < FILE_CHECK_MS) return seen.ok;
    const ok = fs.existsSync(chatFile(id));
    fileChecks.set(id, { at: t, ok });
    return ok;
  }

  // Newest first.
  function list() {
    const chats = readIndex().chats.filter((c) => !c.trashed);
    // A title saved with a screen capture's markup in it (older chats) is made again from the chat's first real text, once,
    // for display; the saved chat is untouched, and a rename always wins.
    for (const c of chats) {
      if (c.renamed || cleanSaved(c.title) === c.title) continue;
      let fresh = '';
      try { fresh = fileExists(c.id) ? autoTitle(load(c.id, { retry: false })) : ''; } catch { /* unreadable: the cleaned saved title below */ }
      c.title = fresh && fresh !== 'New chat' ? fresh : cleanSaved(c.title) || 'Screen capture';
    }
    return chats.map((c) => (fileExists(c.id) ? c : { ...c, missing: true })).sort((a, b) => b.updated - a.updated);
  }

  // A listed chat is read from disk, and on Windows a file that was just written or replaced can be unreadable for a
  // moment (a virus scanner or indexer holds it: EBUSY/EPERM/EACCES, or ENOENT while a rename replaces it). One failed
  // read must not become "Could not open this chat", so those are tried again briefly. A file that stays unreadable
  // shows the error but keeps its History entry (see load()).
  const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
  const READ_TRIES = 4;
  const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: retry at once */ } };
  // `retry: false` (a list or a search going over every chat): one read, no waiting on the main thread for a file held for a moment.
  // A file that is not there at all is never waited for: only a file that exists and is held (a scanner, a sync client) is tried again.
  function load(id, { retry = true } = {}) {
    if (!has(id)) return null;
    if (jobs.has(id)) flushJob(id); // (a save still waiting: written now, so that what is read is what was saved)
    for (let attempt = 1; ; attempt++) {
      try {
        const seen = {};
        const snapshot = readEnc(chatFile(id), seen);
        if (seen.text !== undefined) savedDigest.set(id, digestOf(seen.text)); // (saving it back unchanged, as a tab switch does on leaving the chat, writes nothing)
        return snapshot;
      } catch (err) {
        if (!TRANSIENT.has(err?.code)) return null; // damaged or undecryptable: retrying will not help
        if (err.code === 'ENOENT' && !fs.existsSync(chatFile(id))) return null; // gone, not held: nothing to wait for
        if (retry && attempt < READ_TRIES) { pause(20 * attempt); continue; }
        // Still unreadable: say so, but keep the entry. Something outside Lumen (a scanner, a sync client) may hand the
        // file back later, and dropping the entry from the index would orphan a chat that still exists.
        return null;
      }
    }
  }

  // load() for a caller that can wait (an IPC handler): the file is read, decrypted and parsed without holding the main thread for
  // the disk, and a save of this chat still waiting is finished first. Same answers as load().
  async function loadAsync(id, { retry = true } = {}) {
    if (!has(id)) return null;
    if (jobs.has(id)) await settle(id);
    for (let attempt = 1; ; attempt++) {
      try {
        const data = JSON.parse(await fsp.readFile(chatFile(id), 'utf8'));
        if (!data.enc) return data;
        await nextTick(); // (decrypting and parsing a long chat are separate tasks)
        const text = decrypt(data.enc);
        await nextTick();
        const snapshot = JSON.parse(text);
        savedDigest.set(id, digestOf(text));
        return snapshot;
      } catch (err) {
        if (!TRANSIENT.has(err?.code)) return null;
        if (err.code === 'ENOENT' && !(await fileThere(chatFile(id)))) return null;
        if (retry && attempt < READ_TRIES) { await sleep(20 * attempt); continue; }
        return null;
      }
    }
  }

  // Is the chat in the history list (whether or not its file can be read right now)?
  function has(id) { return ID_RE.test(String(id)) && readIndex().chats.some((c) => c.id === id && !c.trashed); }

  // Writes the chat and its index entry. Returns false when nothing could be kept (no keychain).
  // `indexLater`: the list entry is written in the background (a save finishing a waiting one, on a chat switch, must not also write the index).
  function save(id, snapshot, { indexLater = false } = {}) {
    if (!ID_RE.test(String(id))) throw new Error('bad chat id');
    if (!available()) return false;
    if (!snapshot?.messages?.length) return true; // an empty chat is not worth a list entry
    const idx = readIndex();
    if (idx.degraded) return false; // the index can't be read right now: leave everything on disk as it is
    const waiting = jobs.get(id);
    cancelJob(id); // (what is saved now is newer than any save still waiting)
    if (waiting) waiting.synced = snapshot;
    const text = JSON.stringify(snapshot);
    const digest = digestOf(text);
    let entry = idx.chats.find((c) => c.id === id);
    // Nothing changed since the last write (and its file and list entry are still there): nothing to encrypt, write or index.
    if (entry && !entry.trashed && savedDigest.get(id) === digest && fs.existsSync(chatFile(id))) return true;
    writeAtomic(chatFile(id), snapshot, text);
    savedDigest.set(id, digest);
    fileChecks.delete(id);
    let size = 0; // (the messages' content, not their wrappers: a chat that went through restore() and snapshot() again must match)
    for (const m of snapshot.messages) size += JSON.stringify(m.content).length;
    applySaved(idx, id, snapshot, size, !entry);
    if (indexLater) writeIndexSoon(0); else writeIndex();
    purgeExpiredTrash(idx);
    return true;
  }
  // The chat's list entry after its file was written (shared by save() and the background write).
  function applySaved(idx, id, snapshot, size, isNew) {
    let entry = idx.chats.find((c) => c.id === id);
    if (!entry) {
      entry = { id, title: '', renamed: false, created: now() };
      idx.chats.push(entry);
    }
    if (!entry.renamed) entry.title = autoTitle(snapshot);
    // `updated` is the chat's last activity and the list's order. A save that changed nothing (leaving the chat, a research
    // pin, a setting) leaves it alone; new or changed messages move the chat to the top.
    const count = snapshot.messages.length;
    const sig = `${count}:${size}`;
    // (an entry saved before `sig` existed is compared by message count only)
    if (isNew || (entry.sig === undefined ? entry.msgs !== count : entry.sig !== sig)) entry.updated = now();
    entry.sig = sig;
    entry.model = snapshot.settings?.model || null;
    entry.usage = snapshot.settings?.usage || null;
    // A chat that is used again (more messages than when it was archived) comes back to the main list.
    if (entry.archived && (entry.autoArchived || (entry.msgs !== undefined && count > entry.msgs))) { entry.archived = false; delete entry.autoArchived; }
    entry.msgs = count;
    delete entry.trashed; // (saved again: it was not deleted after all)
    archiveOverflow(idx, id);
  }

  // ---- saving without stopping the main thread (what the app uses; save() above is for quitting and for callers that need the file at once).
  // saveAsync() takes the chat's snapshot and returns at once. Saves of one chat are coalesced (only the newest snapshot is written: a reply
  // streaming in saves again and again), made one at a time per chat, and cut into slices (serializeInSlices) so that no task holds the
  // thread for long; the file is written with fs.promises (a temp file, then one rename), and the index afterwards, once, only if it changed.
  // jobs: id -> { snapshot (waiting), inflight (being written), timer, epoch (bumped by a save made at once: older writes stand down),
  //               synced (the last snapshot save() wrote at once), isNew, done (promise of the running loop) }
  const jobs = new Map();
  const SAVE_COALESCE_MS = 40;
  const INDEX_AFTER_SAVE_MS = 300; // a changed chat's list entry (order, counts) follows a moment later; a new chat's entry at once
  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    job.timer = null;
    job.epoch++;
    job.snapshot = null;
  }
  function saveAsync(id, snapshot) {
    if (!ID_RE.test(String(id))) throw new Error('bad chat id');
    if (!available()) return false;
    if (!snapshot?.messages?.length) return true;
    const idx = readIndex();
    if (idx.degraded) return false;
    let job = jobs.get(id);
    if (!job) { job = { snapshot: null, inflight: null, timer: null, epoch: 0, synced: null, isNew: false, done: null }; jobs.set(id, job); }
    // The chat is listed from now on (a new one gets its entry here, so has() and setProject() see it before its file is written).
    if (!idx.chats.some((c) => c.id === id)) {
      idx.chats.push({ id, title: autoTitle(snapshot), renamed: false, created: now(), updated: now() });
      job.isNew = true;
    }
    job.snapshot = snapshot;
    if (!job.timer && !job.done) {
      job.timer = setTimeout(() => { job.timer = null; start(id); }, SAVE_COALESCE_MS);
      job.timer.unref?.();
    }
    return true;
  }
  function start(id) {
    const job = jobs.get(id);
    if (!job) return null;
    clearTimeout(job.timer);
    job.timer = null;
    if (!job.done) job.done = writeJob(id, job).finally(() => { job.done = null; if (job.snapshot) start(id); else if (!job.timer) jobs.delete(id); });
    return job.done;
  }
  async function writeJob(id, job) {
    try {
      while (job.snapshot) {
        const snapshot = job.snapshot;
        const epoch = job.epoch;
        job.snapshot = null;
        job.inflight = snapshot;
        if (!available() || readIndex().degraded) continue; // (nothing is kept without the keychain; the next save tries again)
        const { text, digest, size } = await serializeInSlices(snapshot);
        if (job.epoch !== epoch) continue; // (a save made at once, or a newer one, took over)
        const entry = readIndex().chats.find((c) => c.id === id);
        // Nothing changed since the last write (and its file and list entry are still there): nothing to encrypt, write or index.
        if (entry && !entry.trashed && !job.isNew && savedDigest.get(id) === digest && await fileThere(chatFile(id))) continue;
        await nextTick();
        const enc = encrypt(text);
        const wrote = await writeAtomicAsync(chatFile(id), enc, () => job.epoch === epoch);
        if (job.epoch !== epoch) { // (save() wrote a newer one meanwhile: if this older file landed over it, write the newer one again)
          if (wrote && job.synced) job.snapshot = job.snapshot || job.synced;
          continue;
        }
        savedDigest.set(id, digest);
        fileChecks.delete(id);
        const idx = readIndex();
        if (idx.degraded) continue;
        applySaved(idx, id, snapshot, size, job.isNew);
        purgeExpiredTrash(idx);
        const wasNew = job.isNew;
        job.isNew = false;
        writeIndexSoon(wasNew ? 0 : INDEX_AFTER_SAVE_MS);
      }
    } catch (err) {
      onError(err);
    } finally {
      job.inflight = null;
    }
  }
  // Writes a chat's waiting (or running) save at once, on this thread: for load() of that chat, and for quitting.
  function flushJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    const latest = job.snapshot || job.inflight;
    cancelJob(id);
    if (latest) { try { save(id, latest, { indexLater: true }); job.synced = latest; } catch (err) { onError(err); } }
    if (!job.done) jobs.delete(id);
  }
  // Waits until a chat's saves are on disk.
  async function settle(id) {
    const job = jobs.get(id);
    if (job) await start(id);
  }
  // Resolves when every save made so far is written, the index too (for tests and for callers that must not read stale files).
  async function drain() {
    for (let round = 0; round < 10; round++) {
      await Promise.all([...jobs.keys()].map(settle));
      if (indexTimer) writeIndexAsync();
      if (indexRun) await indexRun;
      if (!jobs.size && !indexRun && !indexTimer) return;
    }
  }

  // Past `limit` active chats the oldest unpinned ones are archived (never deleted), except the open one, the one just saved
  // and chats another writer added. Only the index changes, so nothing on disk is at risk.
  function archiveOverflow(idx, savedId) {
    const active = idx.chats.filter((c) => !c.archived && !c.trashed);
    if (active.length <= limit) return;
    const candidates = active.filter((c) => !c.pinned && c.id !== idx.current && c.id !== savedId && !foreign.has(c.id)).sort((a, b) => a.updated - b.updated);
    for (const c of candidates.slice(0, active.length - limit)) { c.archived = true; c.autoArchived = true; }
  }
  // A chat trashed long ago (the app quit before its undo time ended) is erased for good, one file at a time, only with the
  // keychain up, and remove() re-reads the index on disk first.
  function purgeExpiredTrash(idx) {
    if (!available()) return;
    const old = idx.chats.filter((c) => c.trashed && now() - c.trashed > TRASH_KEEP_MS && !foreign.has(c.id)).map((c) => c.id);
    for (const id of old) remove(id);
  }

  function rename(id, title) {
    const entry = readIndex().chats.find((c) => c.id === id);
    const clean = cleanTitle(title);
    if (!entry || !clean) return false;
    entry.title = clean;
    entry.renamed = true;
    writeIndex();
    return true;
  }

  const entryOf = (id) => (ID_RE.test(String(id)) ? readIndex().chats.find((c) => c.id === id) : null);
  // Archive and pin change only the index. False for an unknown or trashed chat.
  function setFlag(id, key, on) {
    const entry = entryOf(id);
    if (!entry || entry.trashed || readIndex().degraded) return false;
    if (on) entry[key] = true; else delete entry[key];
    delete entry.autoArchived; // (once the user chooses, it is theirs, no longer an automatic archive)
    writeIndex();
    return true;
  }
  // The chat is in use (a message was sent, a reply started): it moves to the top of the list now, before anything is saved.
  // Index only, and only for a chat that is already listed (a new chat is listed by its first save). True when it moved.
  function touch(id, at = now()) {
    const entry = entryOf(id);
    if (!entry || entry.trashed || readIndex().degraded) return false;
    if (entry.updated >= at) return false;
    entry.updated = at;
    writeIndexSoon(250);
    return true;
  }
  const setPinned = (id, on) => setFlag(id, 'pinned', Boolean(on));
  const setArchived = (id, on) => setFlag(id, 'archived', Boolean(on));

  // ---- projects: named groups of chats with instructions that go to the AI in each of their chats.
  // Only the index holds them: `projects` ([{ id, name, instructions, created }]) next to `chats`, and an optional `project` id on a
  // chat's entry. Older indexes have neither and load as they were. Removing a project only clears that field on its chats: no chat
  // or chat file is ever touched.
  const MAX_PROJECTS = 60;
  const MAX_NAME = 60;
  const MAX_INSTRUCTIONS = 4000;
  const cleanText = (text, max) => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  const projectList = () => readIndex().projects || [];
  const projects = () => projectList().map((p) => ({ ...p }));
  const projectById = (id) => projectList().find((p) => p.id === id) || null;
  // New project (no id) or an edit; null for an empty name, a full list, a degraded index or an unknown id.
  // Folder fields (features/project-folders.js; all optional, '' clears): `folder` (the project's real folder, an absolute path),
  // `folderCreated` (Lumen made it: it may offer to rename it with the project), `mirror` (false: chats are not written as Markdown there;
  // unset means on) and `workFolder` (where the AI works, instead of `folder`).
  const cleanPath = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1000);
  function saveProject({ id, name, instructions, folder, folderCreated, mirror, workFolder } = {}) {
    const idx = readIndex();
    const clean = cleanText(name, MAX_NAME).replace(/\s+/g, ' ');
    if (idx.degraded || !clean) return null;
    let project = id ? projectById(id) : null;
    if (id && !project) return null;
    if (!project) {
      if (projectList().length >= MAX_PROJECTS) return null;
      project = { id: newId(), name: clean, instructions: '', created: now() };
      (idx.projects ||= []).push(project);
    }
    project.name = clean;
    if (instructions !== undefined) project.instructions = cleanText(instructions, MAX_INSTRUCTIONS);
    if (folder !== undefined) { const f = cleanPath(folder); if (f) project.folder = f; else { delete project.folder; delete project.folderCreated; delete project.workFolder; } }
    if (folderCreated !== undefined) { if (folderCreated && project.folder) project.folderCreated = true; else delete project.folderCreated; }
    if (mirror !== undefined) { if (mirror === false) project.mirror = false; else delete project.mirror; }
    if (workFolder !== undefined) { const w = cleanPath(workFolder); if (w) project.workFolder = w; else delete project.workFolder; }
    writeIndex();
    return { ...project };
  }
  function removeProject(id) {
    const idx = readIndex();
    if (idx.degraded || !projectById(id)) return false;
    idx.projects = idx.projects.filter((p) => p.id !== id);
    if (!idx.projects.length) delete idx.projects;
    for (const c of idx.chats) if (c.project === id) delete c.project;
    writeIndex();
    return true;
  }
  // Put a chat in a project (null: out of any). False for an unknown chat or project.
  function setProject(chatId, projectId) {
    const entry = entryOf(chatId);
    if (!entry || entry.trashed || readIndex().degraded) return false;
    if (projectId) { if (!projectById(projectId)) return false; entry.project = projectId; } else delete entry.project;
    writeIndex();
    return true;
  }
  // Several chats at once, in one write (drag and drop, "Move to project"). Moving is not activity: only the `project` field changes, never
  // `updated`, so the list's order (the chats' recency) stays as it was. Chats already in that project, unknown or trashed ones are left out.
  // Returns [{ id, from }] for the chats that moved (from: the project they were in, or null), which restoreProjects() puts back; null when
  // nothing can be written (a degraded index, an unknown project).
  const effectiveProject = (entry) => (entry?.project && projectById(entry.project) ? entry.project : null);
  function moveToProject(ids, projectId = null) {
    const idx = readIndex();
    if (idx.degraded || (projectId && !projectById(projectId))) return null;
    const to = projectId || null;
    const moves = [];
    for (const id of new Set(Array.isArray(ids) ? ids : [])) {
      const entry = entryOf(id);
      if (!entry || entry.trashed) continue;
      const from = effectiveProject(entry);
      if (from === to) continue;
      moves.push({ id, from });
      if (to) entry.project = to; else delete entry.project;
    }
    if (moves.length) writeIndex();
    return moves;
  }
  // Undo of moveToProject(): each chat goes back to the project it was in (none, when that project has been removed since).
  function restoreProjects(moves) {
    const idx = readIndex();
    if (idx.degraded || !Array.isArray(moves)) return 0;
    let n = 0;
    for (const m of moves) {
      const entry = entryOf(m?.id);
      if (!entry || entry.trashed) continue;
      if (m.from && projectById(m.from)) entry.project = m.from; else delete entry.project;
      n++;
    }
    if (n) writeIndex();
    return n;
  }
  // The project a chat is in, or null (a chat whose project was removed, or an index that lost its projects, has none).
  const projectOf = (chatId) => { const entry = entryOf(chatId); return (entry?.project && projectById(entry.project)) || null; };

  // Delete with undo, step 1: the chat leaves the list (and Archived) but its file stays. restore() brings it back; remove()
  // (after the undo time) erases it.
  function trash(id) {
    const entry = entryOf(id);
    const idx = readIndex();
    if (!entry || idx.degraded || !available()) return false;
    if (jobs.has(id)) flushJob(id); // (a save still waiting is written first: landing after the delete it would bring the chat back)
    entry.trashed = now();
    if (idx.current === id) idx.current = null;
    writeIndex();
    return true;
  }
  function restore(id) {
    const entry = entryOf(id);
    if (!entry?.trashed || readIndex().degraded) return false;
    delete entry.trashed;
    writeIndex();
    return true;
  }
  // Chats waiting out their undo time (also after a restart).
  const trashed = () => readIndex().chats.filter((c) => c.trashed).map((c) => ({ id: c.id, at: c.trashed }));

  // Every message of yours is saved with the context Lumen added around it (<browser_state>, a file list...): whole tagged blocks
  // come out first, so search sees what you typed (cleanSaved alone would cut the message at the first tag).
  const WRAPPED = /<([a-z]+_[a-z_]+)\b[^>]*>[\s\S]*?<\/\1>\s*/g;
  // What was said in a chat, for search (never tool results or attached page text), cut at a sane size.
  const SEARCH_CHARS = 200000;
  function textOf(snapshot) {
    const parts = [];
    let n = 0;
    for (const m of snapshot?.messages || []) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b?.type !== 'text' || typeof b.text !== 'string') continue;
        const t = (m.role === 'user' ? cleanSaved(b.text.replace(WRAPPED, '')) : b.text).replace(/\s+/g, ' ').trim();
        if (!t) continue;
        parts.push(t);
        if ((n += t.length) > SEARCH_CHARS) return parts.join('\n').slice(0, SEARCH_CHARS);
      }
    }
    return parts.join('\n');
  }
  const textCache = new Map(); // id -> { updated, text }: a chat is read again only after it changed
  // Chats whose title or messages contain every word of the query: [{ id, snippet }] newest first (snippet: '' when the title matched).
  function search(query, { max = 100 } = {}) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return [];
    const out = [];
    for (const c of list()) {
      if (c.missing) continue;
      const title = String(c.title || '').toLowerCase();
      let body;
      const seen = textCache.get(c.id);
      if (seen && seen.updated === c.updated) body = seen.text;
      else {
        try { body = fileExists(c.id) ? textOf(load(c.id, { retry: false })).toLowerCase() : ''; } catch { body = ''; }
        textCache.set(c.id, { updated: c.updated, text: body });
      }
      if (!words.every((w) => title.includes(w) || body.includes(w))) continue;
      let snippet = '';
      if (!words.every((w) => title.includes(w))) {
        const word = words.find((w) => !title.includes(w));
        const at = Math.max(0, body.indexOf(word));
        snippet = (at > 30 ? '…' : '') + body.slice(Math.max(0, at - 30), at + 90).replace(/\n/g, ' ').trim() + (body.length > at + 90 ? '…' : '');
      }
      out.push({ id: c.id, snippet });
      if (out.length >= max) break;
    }
    return out;
  }

  // Erases a chat for good (one file: the chat the user deleted). The index on disk is read again first; if it can't be, nothing is erased.
  function remove(id) {
    const idx = readIndex();
    if (idx.degraded || !syncFromDisk(idx) || !idx.chats.some((c) => c.id === id)) return false;
    textCache.delete(id);
    savedDigest.delete(id);
    cancelJob(id);
    if (!jobs.get(id)?.done) jobs.delete(id);
    idx.chats =idx.chats.filter((c) => c.id !== id);
    if (idx.current === id) idx.current = null;
    fs.rmSync(chatFile(id), { force: true }); // (one file: the chat the user deleted)
    fileChecks.delete(id);
    writeIndex();
    return true;
  }

  function current() { return readIndex().current; }
  // `defer`: the pointer changes at once, and the file a moment later (see writeIndexSoon).
  function setCurrent(id, { defer = false } = {}) {
    const idx = readIndex();
    const next = ID_RE.test(String(id)) ? id : null;
    if (defer && !idx.degraded && idx.current === next) return;
    idx.current = next;
    if (defer && !idx.degraded) writeIndexSoon(); else writeIndex();
  }

  // The one chat Lumen kept before there was a history list (chat.json) becomes its first entry.
  function migrate() {
    if (!legacyFile || !fs.existsSync(legacyFile)) return null;
    let snapshot = null;
    try { snapshot = readEnc(legacyFile); } catch { /* can't be decrypted here: drop it, as before */ }
    let id = null;
    if (available() && snapshot?.messages?.length) {
      id = newId();
      save(id, snapshot);
      setCurrent(id);
    }
    fs.rmSync(legacyFile, { force: true });
    return id;
  }

  // The keychain is not available: stop keeping chats, but never delete what is on disk. (This used to remove the whole
  // folder. "Not available" is also what Electron answers before the app is ready, and a second copy of Lumen, or a
  // development run, on the same profile quits in that state: it wiped every chat of the running one.) The chats already
  // on disk stay, unreadable until the keychain is back; save() refuses while it is not.
  function clearAll() {
    index = null; // forgotten in memory only; read again from disk when needed
    known.clear(); foreign.clear(); fileChecks.clear(); savedDigest.clear();
    clearTimeout(indexTimer); indexTimer = null; indexDirty = false; indexDigest = null;
    for (const id of [...jobs.keys()]) { cancelJob(id); if (!jobs.get(id).done) jobs.delete(id); }
  }

  return { list, has, load, loadAsync, save, saveAsync, drain, projects, saveProject, removeProject, setProject, moveToProject, restoreProjects, projectOf, rename, remove, trash, restore, trashed, touch, setPinned, setArchived, search, current, setCurrent, flush, migrate, newId, clearAll };
}

// A chat as Markdown, for Export chat. `items` is transcriptFor()'s output.
// `pictureFile(picture)`: where an exported picture lies relative to the .md (null: only named).
function toMarkdown({ title, created, model, usageLine }, items, { pictureFile = null } = {}) {
  const lines = [`# ${cleanTitle(title) || 'Chat'}`, ''];
  const meta = [];
  if (created) meta.push(new Date(created).toISOString().slice(0, 16).replace('T', ' '));
  if (model) meta.push(`Model: ${model}`);
  if (usageLine) meta.push(`Usage: ${usageLine}`);
  if (meta.length) lines.push(`_${meta.join(' · ')}_`, '');
  for (const item of items) {
    lines.push(item.role === 'user' ? '## You' : '## Assistant', '');
    if (item.role === 'assistant' && item.steps) lines.push(`_Used ${item.steps} browser action${item.steps === 1 ? '' : 's'}_`, '');
    if (item.images?.length) lines.push(`_${item.images.length} image${item.images.length === 1 ? '' : 's'} attached (not included)_`, '');
    if (item.text) lines.push(item.role === 'assistant' ? plainScripts(item.text) : item.text, '');
    for (const picture of item.generated || []) {
      const file = pictureFile ? pictureFile(picture) : null;
      const alt = String(picture.alt || 'Generated picture').replace(/[[\]\n]/g, ' ').slice(0, 200);
      lines.push(file ? `![${alt}](${file})` : `_Picture: ${alt} (not included)_`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = { createChatStore, autoTitle, toMarkdown, cleanTitle };
