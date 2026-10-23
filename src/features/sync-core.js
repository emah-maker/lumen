'use strict';
// Sync through a folder: the engine (Settings → General → Sync; docs/sync.md). No server and no account: the person picks a folder
// that their own cloud drive (OneDrive, Dropbox, Google Drive, iCloud Drive) already syncs, and each Lumen keeps its data in step
// through the files in it. This file is the part that knows nothing about Electron: the encrypted file format, the folder layout, the
// merge and the engine that runs one sync pass. features/sync-folder.js wires it to Lumen's stores and to Settings.
//
// Layout, inside <chosen folder>/Lumen Sync/:
//   sync.json                    plain: the format, the scrypt salt and parameters, and a check value to tell a wrong passphrase
//   data/<shard>.<device>.lsync  one file per shard per device. A device only ever writes its OWN files, so a cloud drive never has two
//                                writers of one file (no "conflicted copy"). A shard is a collection ("bookmarks") or, for chats, one chat.
//   devices/<device>.lsync       who has been here: name, system, last time seen
// Every file is gzip then AES-256-GCM, with a key from scrypt over the sync passphrase. The cloud drive only sees ciphertext.
//
// A file holds the records its device AUTHORED: { key: { t: time, v: value } } or a tombstone { t, x: 1 } for a deletion. The state of the
// world is the union of every device's files, and the winner for a key is the newest record (time, then device id as the tie-break):
// last writer wins, per record. Records a newer one has replaced are dropped from the device's file; a tombstone stays 180 days.
// Each device remembers, per key, which version it has applied (sync-state.json in the profile), so it can tell its own edits from
// changes that arrived, and never writes back what it just read.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const FORMAT = 1;
const MAGIC = Buffer.from('LSY1');
const DIR_NAME = 'Lumen Sync';
const EXT = '.lsync';
const KDF = { N: 32768, r: 8, p: 1 }; // scrypt: ~32 MB, about 100 ms
const KEY_LEN = 32;
const CHECK_TEXT = 'lumen-sync-check';
const MIN_PASSPHRASE = 8;
const TOMBSTONE_MS = 180 * 24 * 3600e3;
const MAX_FILE_BYTES = 64 * 1024 * 1024; // a file bigger than this is not read (a hostile or broken folder)
const MAX_PLAIN_BYTES = 256 * 1024 * 1024;
const MASS_DELETE_MIN = 20; // see guard below

class SyncError extends Error {
  constructor(code, message) { super(message || code); this.name = 'SyncError'; this.code = code; }
}

// ---------- crypto and file format ----------

const normalize = (passphrase) => String(passphrase ?? '').normalize('NFKC');

async function deriveKey(passphrase, salt, kdf = KDF) {
  return scrypt(normalize(passphrase), salt, KEY_LEN, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r + 16 * 1024 * 1024 });
}

const aadOf = (name) => Buffer.from(`lumen-sync/${FORMAT}/${name}`);

// value -> Buffer: MAGIC, 12-byte nonce, 16-byte tag, ciphertext of gzip(JSON). `name` is bound in as authenticated data, so a file
// copied under another name (another shard or device) does not open.
async function seal(key, value, name) {
  const plain = await gzip(Buffer.from(JSON.stringify(value), 'utf8'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadOf(name));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

// Buffer -> value. Throws SyncError('unreadable') when the bytes are not a sync file, were cut short, were changed, or were made with
// another key (GCM cannot tell those apart, and does not need to), and SyncError('newer') for a format this Lumen does not know.
async function open(key, buf, name) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 12 + 16 + 1) throw new SyncError('unreadable', 'file is too short');
  if (!buf.subarray(0, 3).equals(MAGIC.subarray(0, 3))) throw new SyncError('unreadable', 'not a Lumen sync file');
  if (buf[3] !== MAGIC[3]) throw new SyncError('newer', 'written by a newer Lumen');
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
    decipher.setAAD(aadOf(name));
    decipher.setAuthTag(buf.subarray(16, 32));
    plain = Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
  } catch { throw new SyncError('unreadable', 'wrong key or damaged file'); }
  try {
    return JSON.parse((await gunzip(plain, { maxOutputLength: MAX_PLAIN_BYTES })).toString('utf8'));
  } catch { throw new SyncError('unreadable', 'damaged file'); }
}

// ---------- the folder ----------

const dirsOf = (root) => {
  const base = path.join(root, DIR_NAME);
  return { root, base, data: path.join(base, 'data'), devices: path.join(base, 'devices'), meta: path.join(base, 'sync.json') };
};

const saneKdf = (k) => k && Number.isInteger(k.N) && k.N >= 1024 && k.N <= 1 << 20 && (k.N & (k.N - 1)) === 0
  && Number.isInteger(k.r) && k.r >= 1 && k.r <= 16 && Number.isInteger(k.p) && k.p >= 1 && k.p <= 4;

// Opens the sync set in `root` with the passphrase: creates it when the folder has none yet (needs a passphrase of 8+ characters),
// otherwise checks the passphrase against the folder's check value. Returns { key, dirs, created }.
// `create: false` (reopening a set this computer already joined): a folder whose sync set is gone (its Lumen Sync folder moved,
// deleted, or not downloaded yet by the cloud drive) is 'no-folder', never a new set made in its place with a new key.
async function openFolder(root, passphrase, { create = true } = {}) {
  const dirs = dirsOf(root);
  let st;
  try { st = await fsp.stat(root); } catch { throw new SyncError('no-folder', 'The folder is not there'); }
  if (!st.isDirectory()) throw new SyncError('no-folder', 'That is not a folder');
  if (!create) { try { await fsp.stat(dirs.meta); } catch { throw new SyncError('no-folder', 'The Lumen Sync folder is not there'); } }
  try {
    await fsp.mkdir(dirs.data, { recursive: true });
    await fsp.mkdir(dirs.devices, { recursive: true });
  } catch (err) { throw new SyncError('not-writable', err?.message || 'Lumen cannot write in that folder'); }
  const readMeta = async () => {
    let text;
    try { text = await fsp.readFile(dirs.meta, 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return null; throw new SyncError('unreadable', err?.message); }
    try {
      const meta = JSON.parse(text);
      if (meta?.app !== 'lumen-sync' || typeof meta.salt !== 'string' || typeof meta.check !== 'string' || !saneKdf(meta.kdf)) throw new Error('shape');
      return meta;
    } catch { throw new SyncError('bad-meta', 'sync.json is damaged'); }
  };
  let meta = await readMeta();
  let created = false;
  if (!meta) {
    if (normalize(passphrase).length < MIN_PASSPHRASE) throw new SyncError('short-passphrase', `Use at least ${MIN_PASSPHRASE} characters`);
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(passphrase, salt);
    const fresh = { app: 'lumen-sync', format: FORMAT, created: Date.now(), kdf: { name: 'scrypt', ...KDF }, salt: salt.toString('base64'), check: (await seal(key, CHECK_TEXT, 'sync.json')).toString('base64') };
    try {
      await fsp.writeFile(dirs.meta, JSON.stringify(fresh, null, 2), { flag: 'wx' });
      return { key, dirs, created: true };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw new SyncError('not-writable', err?.message);
      meta = await readMeta(); // another computer set the folder up a moment ago: join it
      created = false;
    }
  }
  if (meta.format > FORMAT) throw new SyncError('newer', 'This folder was set up by a newer Lumen');
  const key = await deriveKey(passphrase, Buffer.from(meta.salt, 'base64'), meta.kdf);
  let checked;
  try { checked = await open(key, Buffer.from(meta.check, 'base64'), 'sync.json'); } catch { throw new SyncError('wrong-passphrase', 'That is not the passphrase this folder was set up with'); }
  if (checked !== CHECK_TEXT) throw new SyncError('wrong-passphrase', 'That is not the passphrase this folder was set up with');
  return { key, dirs, created };
}

// A file under data/ or devices/ is written whole under a temp name, then renamed over the old one (a half-written file is never seen).
// A cloud drive's client may hold the file for a moment (EBUSY, EPERM on Windows): a few tries.
async function writeAtomic(file, buf) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, buf);
    for (let attempt = 1; ; attempt++) {
      try { await fsp.rename(tmp, file); return; } catch (err) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(err?.code) || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 40 * attempt));
      }
    }
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const FILE_RE = /^([A-Za-z0-9_-]{1,80})\.([0-9a-f]{12})\.lsync$/;
const DEVICE_RE = /^([0-9a-f]{12})\.lsync$/;

// ---------- merge ----------

// Which of two versions { t, d } wins: the later time; on a tie the larger device id (the same answer on every computer).
const compare = (a, b) => (a.t !== b.t ? (a.t > b.t ? 1 : -1) : a.d === b.d ? 0 : a.d > b.d ? 1 : -1);

// Every version of one key, from every device's file: the winner, last writer first.
function winner(versions) {
  let best = null;
  for (const v of versions) if (!best || compare(v, best) > 0) best = v;
  return best;
}

// Stable text for a value (keys sorted), so equal values make equal signatures.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const validRecord = (r) => r && typeof r === 'object' && Number.isFinite(r.t) && r.t >= 0 && (r.x === 1 || (r.v !== undefined && r.v !== null));

// ---------- the engine ----------
//
// A provider is one kind of data:
//   name               'bookmarks' ...
//   shardOf?(key)      the shard (file name part) a key lives in; default: the provider's name. A chat is its own shard.
//   tombstones?        false: a key that is missing locally is not a deletion (a setting that is at its default)
//   guard?             true: many keys vanishing at once is not trusted by an automatic pass (see MASS_DELETE_MIN)
//   scan()             Map key -> { value | read(), sig?, ts? }  what is here now. Throws when the data cannot be read right now.
//   has?(key)          true if the key still exists although scan did not list it
//   apply(changes)     [{ key, value, deleted }] -> the keys it could not apply now (they are tried again next pass)
//   combine?(winnerValue, versions)  a value made from the winner and the others (history keeps the larger visit count)

function createEngine({ dirs, key, deviceId, deviceName = '', platform = process.platform, appVersion = '', state, saveState = async () => {}, providers, now = () => Date.now() }) {
  const own = new Map(); // shard -> { records } what this device authored, as written (the authority for our own files)
  const dirty = new Set(); // shards whose own file needs writing
  const remote = new Map(); // file name -> { shard, dev, size, mtimeMs, records } read cache of other devices' files
  const badFiles = new Map(); // file name -> { code, size, mtimeMs }
  let loaded = false;
  let lastDevices = 0;
  state.providers ||= {};
  state.synced ||= {};
  state.salt ||= crypto.randomBytes(12).toString('hex');

  const sigOf = (value) => crypto.createHash('sha256').update(state.salt).update(canonical(value)).digest('hex').slice(0, 20);
  const shardFor = (p, k) => (p.shardOf ? p.shardOf(k) : p.name);
  const providerOfShard = (shard) => providers.find((p) => shard === p.name || (p.shardOf && shard.startsWith(`${p.name}-`)));
  const tracked = (p) => (state.providers[p.name] ||= {});
  const ownFile = (shard) => path.join(dirs.data, `${shard}.${deviceId}${EXT}`);

  async function load() {
    if (loaded) return;
    loaded = true;
    let names;
    try { names = await fsp.readdir(dirs.data); } catch { return; }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m || m[2] !== deviceId) continue;
      try {
        const doc = await open(key, await fsp.readFile(path.join(dirs.data, name)), name);
        if (doc?.dev === deviceId && doc.shard === m[1] && doc.records && typeof doc.records === 'object') {
          const records = {};
          for (const [k, r] of Object.entries(doc.records)) if (validRecord(r)) records[k] = r;
          own.set(m[1], { records });
        }
      } catch { /* our own file cannot be read (another key, damaged): it is written again from what we know when it changes */ }
    }
    // Stale temp files from a pass that was cut off (ours only).
    for (const name of names) if (/\.lsync\.tmp-\d+-[0-9a-f]+$/.test(name) && name.includes(`.${deviceId}.`)) fsp.rm(path.join(dirs.data, name), { force: true }).catch(() => {});
  }

  // Read what changed in other devices' files (a file is read again only when its size or time moved).
  async function readRemote() {
    let names;
    try { names = await fsp.readdir(dirs.data); } catch (err) { throw new SyncError('no-folder', err?.message || 'The folder is not there'); }
    const seen = new Set();
    const todo = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m || m[2] === deviceId) continue;
      seen.add(name);
      todo.push({ name, shard: m[1], dev: m[2] });
    }
    for (const name of [...remote.keys()]) if (!seen.has(name)) remote.delete(name);
    for (const name of [...badFiles.keys()]) if (!seen.has(name)) badFiles.delete(name);
    const chunk = 24;
    for (let i = 0; i < todo.length; i += chunk) {
      await Promise.all(todo.slice(i, i + chunk).map(async ({ name, shard, dev }) => {
        const file = path.join(dirs.data, name);
        let st;
        try { st = await fsp.stat(file); } catch { remote.delete(name); return; }
        const had = remote.get(name);
        if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return;
        const badHad = badFiles.get(name);
        if (badHad && badHad.size === st.size && badHad.mtimeMs === st.mtimeMs && badHad.code === 'newer') return;
        if (st.size > MAX_FILE_BYTES) { badFiles.set(name, { code: 'unreadable', size: st.size, mtimeMs: st.mtimeMs }); remote.delete(name); return; }
        try {
          const doc = await open(key, await fsp.readFile(file), name);
          if (doc?.dev !== dev || doc.shard !== shard || !doc.records || typeof doc.records !== 'object') throw new SyncError('unreadable', 'does not match its name');
          const records = {};
          for (const [k, r] of Object.entries(doc.records)) if (validRecord(r)) records[k] = r;
          remote.set(name, { shard, dev, size: st.size, mtimeMs: st.mtimeMs, records });
          badFiles.delete(name);
        } catch (err) {
          remote.delete(name);
          badFiles.set(name, { code: err?.code === 'newer' ? 'newer' : 'unreadable', size: st.size, mtimeMs: st.mtimeMs });
        }
      }));
    }
  }

  // Every version of every key of one provider, from our own records and the others' files.
  function versionsOf(p) {
    const byKey = new Map();
    const add = (k, rec, d) => { let list = byKey.get(k); if (!list) byKey.set(k, list = []); list.push({ t: rec.t, d, x: rec.x === 1, v: rec.v }); };
    for (const [shard, { records }] of own) if (providerOfShard(shard) === p) for (const [k, rec] of Object.entries(records)) add(k, rec, deviceId);
    for (const f of remote.values()) if (providerOfShard(f.shard) === p) for (const [k, rec] of Object.entries(f.records)) add(k, rec, f.dev);
    return byKey;
  }

  function setOwn(p, k, rec) {
    const shard = shardFor(p, k);
    let f = own.get(shard);
    if (!f) own.set(shard, f = { records: {} });
    f.records[k] = rec;
    dirty.add(shard);
  }

  // One provider's pass. `opts.force`: a person pressed Sync now (a mass deletion is then taken as meant).
  async function passFor(p, opts, out) {
    const st = tracked(p);
    let scanned;
    try { scanned = await p.scan(); } catch (err) { out.skipped.push({ provider: p.name, reason: err?.code || 'unavailable', message: err?.message }); return; }
    const versions = versionsOf(p);
    const hasRemote = [...versions.values()].some((list) => list.some((v) => v.d !== deviceId));
    const first = !state.synced[p.name];
    const stamp = (hint, prior) => {
      if (first && hasRemote) return Math.max(1, Number.isFinite(hint) ? hint : 1); // joining a folder that has data: ours yields to what is there
      let t = Number.isFinite(hint) ? hint : now();
      if (prior) t = Math.max(t, prior.t + 1);
      return t;
    };

    // 1. our own changes since the last pass
    const authored = [];
    for (const [k, item] of scanned) {
      const prior = st[k];
      const sig = item.sig ?? sigOf(item.value);
      if (prior && prior.s === sig && !prior.x) continue;
      let value;
      try { value = item.read ? await item.read() : item.value; } catch { continue; }
      if (value === undefined || value === null) continue;
      const t = stamp(item.ts, prior);
      const rec = { t, v: value };
      setOwn(p, k, rec);
      st[k] = { s: sig, t, d: deviceId };
      authored.push(k);
      versions.set(k, [...(versions.get(k) || []).filter((v) => v.d !== deviceId), { t, d: deviceId, x: false, v: value }]);
    }
    const gone = [];
    if (p.tombstones !== false) {
      for (const [k, prior] of Object.entries(st)) {
        if (prior.x || scanned.has(k) || p.has?.(k)) continue;
        gone.push(k);
      }
    }
    const liveCount = Object.values(st).filter((s) => !s.x).length;
    if (p.guard && !opts.force && gone.length >= MASS_DELETE_MIN && gone.length * 2 >= liveCount) {
      out.skipped.push({ provider: p.name, reason: 'mass-delete', message: `${gone.length} items are missing at once` });
    } else {
      for (const k of gone) {
        const prior = st[k];
        const t = Math.max(now(), prior.t + 1);
        setOwn(p, k, { t, x: 1 });
        st[k] = { s: '', t, d: deviceId, x: 1 };
        authored.push(k);
        versions.set(k, [...(versions.get(k) || []).filter((v) => v.d !== deviceId), { t, d: deviceId, x: true }]);
      }
    }
    out.authored += authored.length;

    // 2. what other devices wrote, newer than what we hold
    const changes = [];
    const wins = new Map();
    for (const [k, list] of versions) {
      const w = winner(list);
      if (!w) continue;
      wins.set(k, w);
      if (w.d === deviceId) continue;
      const prior = st[k];
      if (prior && compare(prior, w) >= 0) continue;
      if (w.x) {
        if (scanned.has(k) || p.has?.(k)) changes.push({ key: k, deleted: true, w });
        else st[k] = { s: '', t: w.t, d: w.d, x: 1 }; // nothing here to remove: just remember it
      } else {
        changes.push({ key: k, value: p.combine ? p.combine(w.v, list.filter((v) => !v.x).map((v) => v.v)) : w.v, w });
      }
    }
    if (changes.length) {
      let held;
      try { held = (await p.apply(changes.map(({ key: k, value, deleted }) => ({ key: k, value, deleted: Boolean(deleted) })))) || []; } catch (err) {
        out.errors.push({ provider: p.name, message: err?.message || String(err) });
        held = changes.map((c) => c.key);
      }
      const heldSet = new Set(held);
      let after;
      try { after = await p.scan(); } catch { after = null; }
      for (const c of changes) {
        if (heldSet.has(c.key)) continue;
        const item = after?.get(c.key);
        st[c.key] = { s: item ? (item.sig ?? sigOf(item.value)) : '', t: c.w.t, d: c.w.d, ...(c.w.x ? { x: 1 } : {}) };
        if (c.w.x) out.removed++; else out.applied++;
      }
      if (held.length) out.deferred += held.length;
      if (changes.length > held.length) out.kinds.push(p.name);
    }

    // 3. our file: drop what a newer record replaced, old tombstones, and re-publish what no file holds any more (a folder that was emptied,
    //    or a file of ours that could not be read)
    for (const [shard, f] of own) {
      if (providerOfShard(shard) !== p) continue;
      for (const [k, rec] of Object.entries(f.records)) {
        const w = wins.get(k) || winner(versions.get(k) || []);
        if (w && w.d !== deviceId) { delete f.records[k]; dirty.add(shard); continue; }
        if (rec.x === 1 && now() - rec.t > TOMBSTONE_MS) { delete f.records[k]; delete st[k]; dirty.add(shard); }
      }
    }
    for (const [k, s] of Object.entries(st)) {
      if (s.x || !scanned.has(k) || (versions.get(k) || []).length) continue;
      let value;
      try { const item = scanned.get(k); value = item.read ? await item.read() : item.value; } catch { continue; }
      if (value === undefined || value === null) continue;
      setOwn(p, k, { t: s.t, v: value });
      st[k] = { ...s, d: deviceId };
    }
    state.synced[p.name] = now();
  }

  async function flushOwn(out) {
    for (const shard of [...dirty]) {
      const f = own.get(shard);
      const file = ownFile(shard);
      try {
        if (!f || !Object.keys(f.records).length) {
          await fsp.rm(file, { force: true });
          own.delete(shard);
        } else {
          await writeAtomic(file, await seal(key, { v: FORMAT, shard, dev: deviceId, records: f.records }, path.basename(file)));
        }
        dirty.delete(shard);
        out.written++;
      } catch (err) {
        out.errors.push({ provider: shard, message: err?.message || String(err) });
      }
    }
  }

  // One full pass over the enabled providers. Never throws for a single bad file or provider: they are reported in the result.
  async function sync(opts = {}) {
    const out = { authored: 0, applied: 0, removed: 0, deferred: 0, written: 0, skipped: [], errors: [], bad: 0, newer: 0, kinds: [], at: now() };
    await load();
    await readRemote();
    for (const p of providers) {
      try { await passFor(p, opts, out); } catch (err) { out.errors.push({ provider: p.name, message: err?.message || String(err) }); }
    }
    await flushOwn(out);
    try { await saveState(state); } catch (err) { out.errors.push({ provider: 'state', message: err?.message || String(err) }); }
    for (const b of badFiles.values()) if (b.code === 'newer') out.newer++; else out.bad++;
    if (now() - lastDevices > 10 * 60 * 1000) {
      lastDevices = now();
      try { await writeAtomic(path.join(dirs.devices, `${deviceId}${EXT}`), await seal(key, { name: deviceName, platform, version: appVersion, seen: now() }, `${deviceId}${EXT}`)); } catch { /* the device list is a courtesy */ }
    }
    return out;
  }

  // The other computers that have used this folder: [{ id, name, platform, seen, self }], newest first.
  async function devices() {
    let names;
    try { names = await fsp.readdir(dirs.devices); } catch { return []; }
    const list = [];
    for (const name of names) {
      const m = DEVICE_RE.exec(name);
      if (!m) continue;
      try {
        const doc = await open(key, await fsp.readFile(path.join(dirs.devices, name)), name);
        list.push({ id: m[1], name: String(doc?.name || '').slice(0, 80), platform: String(doc?.platform || '').slice(0, 20), seen: Number(doc?.seen) || 0, self: m[1] === deviceId });
      } catch { /* damaged: left out */ }
    }
    if (!list.some((d) => d.self)) list.push({ id: deviceId, name: deviceName, platform, seen: now(), self: true });
    return list.sort((a, b) => b.seen - a.seen);
  }

  // A cheap look at what other computers' files are now (names, sizes, times), for a caller that polls instead of watching (Windows cannot
  // rename a folder that has a watched folder in it, so features/sync-folder.js polls there). Our own files do not count.
  async function fingerprint() {
    let names;
    try { names = await fsp.readdir(dirs.data); } catch { return 'gone'; }
    const parts = [];
    for (const name of names.sort()) {
      const m = FILE_RE.exec(name);
      if (!m || m[2] === deviceId) continue;
      try { const st = await fsp.stat(path.join(dirs.data, name)); parts.push(`${name}:${st.size}:${Math.floor(st.mtimeMs)}`); } catch { /* gone meanwhile */ }
    }
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  }

  return { sync, devices, load, sigOf, fingerprint, ownRecords: () => own, badFiles: () => [...badFiles.keys()] };
}

// A short random id for this computer's files (12 hex characters).
const newDeviceId = () => crypto.randomBytes(6).toString('hex');

module.exports = {
  FORMAT, DIR_NAME, EXT, KDF, MIN_PASSPHRASE, TOMBSTONE_MS, MASS_DELETE_MIN, SyncError,
  deriveKey, seal, open, dirsOf, openFolder, writeAtomic, compare, winner, canonical, createEngine, newDeviceId, FILE_RE,
};
