// [secret box] Every secret Lumen keeps on disk (API keys, chats, passwords, memory, tokens, ...) is encrypted here. One random
// 256-bit key, made on the first start, is sealed with the OS keychain (Electron's safeStorage: DPAPI on Windows, the Keychain
// on macOS, the Secret Service or KWallet on Linux) in <profile>/secret-box.key; the values themselves are AES-256-GCM with that
// key. Only the asynchronous safeStorage calls are used (Electron 45 deprecates encryptString, decryptString and
// isEncryptionAvailable), and only for the key, once per start, so the stores keep reading and writing as they always did.
//
// Values written before this (one safeStorage.encryptString blob each) still read: start() decrypts the ones the stores read at
// once (warm(), with decryptStringAsync, which reads the old format) before any store opens, and decryptAsync() reads any other.
// Each store writes the new format the next time it saves. A value that can't be read is never treated as empty: decrypt() throws,
// and an old-format value nobody warmed throws a `transient` error while it is decrypted in the background, so a later read
// succeeds and nothing is replaced in between.
//
// deps: { safeStorage (isAsyncEncryptionAvailable, encryptStringAsync, decryptStringAsync, getSelectedStorageBackend?),
//         keyFile, fs?, platform?, log?(message) }
const crypto = require('crypto');
const nodeFs = require('fs');

const MAGIC = Buffer.from('LSB1', 'latin1'); // the new format: MAGIC | iv (12) | tag (16) | body
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// An old safeStorage blob starts with "v10" or "v11" (every platform): as base64, "djEw" or "djEx". warmFiles() collects those.
const LEGACY_B64 = /^djE[wx][A-Za-z0-9+/]+={0,2}$/;
const WARM_MAX_BYTES = 32 * 1024 * 1024; // a file bigger than this is not read whole at start (its values read with decryptAsync)

function lockedError(message) {
  const err = new Error(message);
  err.code = 'SECRET_LOCKED';
  err.transient = true; // "not now": the caller must keep what is on disk and try again later
  return err;
}

const toBuffer = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'base64'));
const isOwn = (buf) => buf.length >= MAGIC.length + IV_BYTES + TAG_BYTES && buf.subarray(0, MAGIC.length).equals(MAGIC);

// Every string in a parsed JSON value that looks like an old safeStorage blob (the stores keep them as `enc`, `secret`, `sealed`, keys.*).
function legacyStrings(value, out = [], depth = 0) {
  if (depth > 12 || value == null) return out;
  if (typeof value === 'string') { if (value.length >= 20 && LEGACY_B64.test(value)) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) legacyStrings(v, out, depth + 1); return out; }
  if (typeof value === 'object') for (const v of Object.values(value)) legacyStrings(v, out, depth + 1);
  return out;
}

function createSecretBox({ safeStorage, keyFile, fs = nodeFs, platform = process.platform, log = (m) => console.warn(m) }) {
  let key = null; // the data key (Buffer), once start() has read or made it
  let started = null; // start()'s promise
  let done = false; // start() has finished (with or without a key)
  let backend = null; // Linux: the keychain safeStorage chose ('basic_text' only obfuscates)
  const legacy = new Map(); // base64 of an old-format blob -> its text
  const pending = new Map(); // base64 -> the decryptStringAsync in flight
  let staleCount = 0; // old-format values read (each is rewritten in the new format when its store next saves)

  function seal(text) {
    if (!key) throw lockedError(done ? 'This computer’s secure storage isn’t available.' : 'Lumen’s secure storage is still starting.');
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(MAGIC);
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
  }
  function open(buf) {
    if (!key) throw lockedError('Lumen’s secure storage is still starting.');
    const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = buf.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  // An old-format blob, through the OS (once per value: the text is remembered).
  function decryptLegacy(buf) {
    const id = buf.toString('base64');
    if (legacy.has(id)) return Promise.resolve(legacy.get(id));
    if (!pending.has(id)) {
      const p = Promise.resolve()
        .then(() => safeStorage.decryptStringAsync(buf))
        .then(({ result }) => { legacy.set(id, result); staleCount++; return result; })
        .finally(() => pending.delete(id));
      pending.set(id, p);
    }
    return pending.get(id);
  }

  // Writes the sealed key: `exclusive` (a new key) never replaces one another Lumen made meanwhile (false: it lost the race).
  async function writeKey(sealed, { exclusive }) {
    const tmp = `${keyFile}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`; // (never shared: two starts at once each write their own)
    await fs.promises.writeFile(tmp, sealed, { mode: 0o600 });
    try {
      if (!exclusive) { await fs.promises.rename(tmp, keyFile); return true; }
      try { await fs.promises.link(tmp, keyFile); return true; } catch (err) { if (err?.code === 'EEXIST') return false; throw err; }
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
  async function readKey() {
    let sealed = null;
    try { sealed = await fs.promises.readFile(keyFile); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    if (sealed) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(sealed);
      const k = Buffer.from(String(result), 'base64');
      if (k.length !== KEY_BYTES) throw new Error('the saved key is damaged');
      if (shouldReEncrypt) { // the OS rotated its key: seal ours again with the new one (the old file stays until the new one is written)
        try { await writeKey(await safeStorage.encryptStringAsync(result), { exclusive: false }); } catch (err) { log(`secret box: could not seal the key again: ${err.message}`); }
      }
      return k;
    }
    return null;
  }
  async function makeKey() {
    const k = crypto.randomBytes(KEY_BYTES);
    const text = k.toString('base64');
    const sealed = await safeStorage.encryptStringAsync(text);
    const back = await safeStorage.decryptStringAsync(sealed); // never keep a key the OS can't give back
    if (back?.result !== text) throw new Error('the keychain did not return the key it sealed');
    return (await writeKey(sealed, { exclusive: true })) ? k : null;
  }

  // Reads (or, on the first start, makes) the key, then warms the old-format values in `warmList` (see warmFiles). Resolves when the
  // stores may open; never rejects. No keychain, or a key file it can't open: available() stays false and nothing is written over.
  function start({ warmList = [] } = {}) {
    return (started ||= (async () => {
      try {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) { log('secret box: OS encryption is not available'); return; }
        if (platform === 'linux') { try { backend = safeStorage.getSelectedStorageBackend?.() || null; } catch { backend = null; } }
        key = (await readKey()) || (await makeKey()) || (await readKey()); // (lost a race with another Lumen: read the key it made)
        if (!key) throw new Error('no key');
      } catch (err) {
        key = null;
        log(`secret box: secure storage could not be opened (${err?.message || err}); nothing is saved encrypted this run`);
      }
      try { await warmFiles(warmList); } catch { /* best effort: decrypt() starts a read for anything missed */ }
    })().finally(() => { done = true; }));
  }

  // Decrypts the old-format values found in these files, so the stores' first (synchronous) reads find them.
  // list: [{ file, kind: 'json' | 'raw' }]: 'json' collects every old-format string in it, 'raw' is one blob (passwords.bin).
  async function warmFiles(list) {
    const blobs = [];
    await Promise.all(list.map(async ({ file, kind = 'json' }) => {
      try {
        const st = await fs.promises.stat(file);
        if (!st.isFile() || st.size > WARM_MAX_BYTES) return;
        const buf = await fs.promises.readFile(file);
        if (kind === 'raw') { if (buf.length && !isOwn(buf)) blobs.push(buf); return; }
        for (const s of legacyStrings(JSON.parse(buf.toString('utf8')))) blobs.push(Buffer.from(s, 'base64'));
      } catch { /* missing or not JSON: nothing to warm */ }
    }));
    return warm(blobs);
  }
  // Old-format values (base64 strings or Buffers) decrypted ahead of their first read; one that fails is left out.
  function warm(values) {
    return Promise.all(values.map((v) => decryptLegacy(toBuffer(v)).catch(() => null))).then(() => undefined);
  }

  return {
    start,
    ready: () => started || Promise.resolve(),
    isReady: () => done,
    available: () => Boolean(key),
    backend: () => backend,
    // text -> base64 (encrypt) or a Buffer (encryptBuffer). Throws when there is no key.
    encrypt: (text) => seal(text).toString('base64'),
    encryptBuffer: (text) => seal(text),
    // base64 or Buffer -> text. Throws on a damaged value or another computer's; an old-format value not warmed yet throws a
    // `transient` error (err.transient) and is decrypted in the background, so the next read has it.
    decrypt(value) {
      const buf = toBuffer(value);
      if (isOwn(buf)) return open(buf);
      const id = buf.toString('base64');
      if (legacy.has(id)) return legacy.get(id);
      if (!done) throw lockedError('Lumen’s secure storage is still starting.');
      decryptLegacy(buf).catch(() => {});
      throw lockedError('This value is still being read from the keychain.');
    },
    // The same, waiting for an old-format value instead of throwing.
    async decryptAsync(value) {
      const buf = toBuffer(value);
      if (!done) await started;
      if (isOwn(buf)) return open(buf);
      return decryptLegacy(buf);
    },
    warm,
    warmFiles,
    isLegacy: (value) => !isOwn(toBuffer(value)),
    staleCount: () => staleCount,
  };
}

module.exports = { createSecretBox, legacyStrings, LEGACY_B64, MAGIC };
