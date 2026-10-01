// On-device translation: which language models exist, which are on disk, and downloading them.
//
// The models are Mozilla's, the same ones Firefox Translations uses. Mozilla publishes them in the
// Remote Settings collection `translations-models` (each file with its SHA-256 and size) and serves the
// files from its attachments CDN. This file reads that registry, picks the newest complete model set per
// language pair, plans routes (direct, or through English the way Firefox does), and keeps the files under
// <userData>/translation-models/<from>-<to>/ with a manifest. Every file is checked against the registry's
// hash before it is kept; a download that fails or is cancelled leaves nothing behind.
//
// The only network traffic here is the registry read and the model files, both from Mozilla. No page
// text ever touches this file. It is plain Node (no Electron): fetch and the folder are injected, so the
// unit tests run it against a fake registry.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REGISTRY_URL = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records';
const ATTACHMENT_BASE = 'https://firefox-settings-attachments.cdn.mozilla.net/';
// The model major versions the bundled engine (Bergamot 0.6.0, wasm 3.0) can run. Models 1.x are the
// small "tiny" ones, 2.x the larger "base" ones. 3.x need the newer wasm and are skipped.
const MODEL_MAJOR_MIN = 1;
const MODEL_MAJOR_MAX = 2;
const REGISTRY_TTL_MS = 7 * 24 * 3600e3;
const FILE_TYPES = ['model', 'lex', 'vocab', 'srcvocab', 'trgvocab'];
const PIVOT = 'en';

// ---- language codes ----
// Lumen's codes (translate.js LANGUAGES) -> the registry's.
const TO_MODEL = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };
const FROM_MODEL = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };
const modelCode = (code) => TO_MODEL[code] || String(code || '');
const lumenCode = (code) => FROM_MODEL[code] || String(code || '');
// A page's language (the base from detection, plus its declared tag when there is one) -> a registry code.
function sourceModelCode(base, tag = '') {
  const b = String(base || '').toLowerCase();
  const t = String(tag || '').toLowerCase().replace(/_/g, '-');
  if (b === 'zh') return /^zh-(tw|hk|mo|hant)/.test(t) ? 'zh-Hant' : 'zh-Hans';
  if (b === 'no' || b === 'nb') return 'nb';
  if (b === 'iw') return 'he';
  return b;
}

// ---- registry -> index ----
const versionParts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
const compareVersions = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  return (x[0] - y[0]) || (x[1] - y[1]);
};
const stableVersion = (v) => /^\d+\.\d+$/.test(String(v));
const safeName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(name || ''));
const safeLocation = (loc) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(String(loc || '')) && !String(loc).includes('..') && !String(loc).includes('//');
const isHash = (h) => /^[0-9a-f]{64}$/.test(String(h || ''));

// Records of one pair -> its best complete file set { version, files }, or null. Complete means a model,
// a shortlist (lex) and a vocabulary (one shared, or one per side); the newest version in the engine's
// supported range wins.
function bestSet(records) {
  const byVersion = new Map();
  for (const r of records) {
    if (!stableVersion(r.version)) continue;
    const major = versionParts(r.version)[0];
    if (major < MODEL_MAJOR_MIN || major > MODEL_MAJOR_MAX) continue;
    if (!FILE_TYPES.includes(r.fileType)) continue;
    const a = r.attachment || {};
    if (!safeName(a.filename) || !safeLocation(a.location) || !isHash(a.hash) || !(a.size > 0)) continue;
    if (!byVersion.has(r.version)) byVersion.set(r.version, new Map());
    const files = byVersion.get(r.version);
    const prev = files.get(r.fileType);
    if (!prev || (r.last_modified || 0) > (prev.last_modified || 0)) files.set(r.fileType, r);
  }
  for (const version of [...byVersion.keys()].sort((a, b) => compareVersions(b, a))) {
    const f = byVersion.get(version);
    if (!f.has('model') || !f.has('lex') || !(f.has('vocab') || (f.has('srcvocab') && f.has('trgvocab')))) continue;
    return {
      version,
      files: FILE_TYPES.filter((t) => f.has(t)).map((t) => {
        const a = f.get(t).attachment;
        return { type: t, name: a.filename, hash: a.hash, size: a.size, location: a.location };
      }),
    };
  }
  return null;
}

// Registry records -> { 'fr>en': { from, to, version, files, bytes } }, in registry language codes.
function buildIndex(records) {
  const pairs = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !/^[A-Za-z-]{2,8}$/.test(r.fromLang || '') || !/^[A-Za-z-]{2,8}$/.test(r.toLang || '')) continue;
    const key = `${r.fromLang}>${r.toLang}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(r);
  }
  const index = {};
  for (const [key, list] of pairs) {
    const set = bestSet(list);
    if (!set) continue;
    const [from, to] = key.split('>');
    index[key] = { from, to, version: set.version, files: set.files, bytes: set.files.reduce((n, f) => n + f.size, 0) };
  }
  return index;
}

// ---- routes ----
// The steps to get from `from` to `to` (registry codes): [] when they match, one pair when a model exists,
// two through English when both halves exist, else null.
function planRoute(from, to, index) {
  if (!from || !to) return null;
  if (from === to) return [];
  if (index?.[`${from}>${to}`]) return [[from, to]];
  if (from !== PIVOT && to !== PIVOT && index?.[`${from}>${PIVOT}`] && index?.[`${PIVOT}>${to}`]) return [[from, PIVOT], [PIVOT, to]];
  return null;
}
const pairKey = (from, to) => `${from}>${to}`;
// Bytes still to download for `route`; `installed` is a Set of pair keys already on disk.
function missingBytes(route, index, installed) {
  return (route || []).reduce((n, [a, b]) => n + (installed.has(pairKey(a, b)) ? 0 : index[pairKey(a, b)]?.bytes || 0), 0);
}
// Every language (registry code) that can be reached from or to English with a model, for the settings page.
function languagesIn(index) {
  const langs = new Set();
  for (const e of Object.values(index || {})) { langs.add(e.from); langs.add(e.to); }
  langs.delete(PIVOT);
  return [...langs].sort();
}
const formatBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// ---- the on-disk store ----
class DownloadCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'DownloadCancelled'; this.code = 'cancelled'; }
}

// deps: { dir, fetch, now?, timeoutMs? }
function createModelStore({ dir, fetch: doFetch = (...a) => fetch(...a), now = () => Date.now(), timeoutMs = 20000 }) {
  let index = null; // parsed registry, in memory
  let indexAt = 0;
  let loading = null;
  const jobs = new Map(); // pair key -> { promise, controller, listeners }

  const pairDir = (from, to) => path.join(dir, `${from}-${to}`);
  const manifestPath = (from, to) => path.join(pairDir(from, to), 'manifest.json');
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const cachePath = path.join(dir, 'registry.json');

  // The index: memory, else the cached registry on disk, else Mozilla. `refresh` forces a fetch (the
  // cached copy is still the fallback when offline).
  async function loadIndex({ refresh = false } = {}) {
    if (index && !refresh && now() - indexAt < REGISTRY_TTL_MS) return index;
    if (loading) return loading;
    loading = (async () => {
      const cached = readJson(cachePath);
      const fresh = Boolean(cached?.index) && now() - (cached.fetchedAt || 0) < REGISTRY_TTL_MS;
      if (!refresh && fresh) { index = cached.index; indexAt = cached.fetchedAt; return index; }
      try {
        const records = await fetchAllRecords();
        const next = buildIndex(records);
        if (!Object.keys(next).length) throw new Error('the model registry is empty');
        index = next;
        indexAt = now();
        try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: indexAt, index })); } catch { /* the registry is re-read next time */ }
        return index;
      } catch (err) {
        if (cached?.index) { index = cached.index; indexAt = cached.fetchedAt || 0; return index; } // offline: the stale registry still works
        throw err;
      }
    })().finally(() => { loading = null; });
    return loading;
  }
  async function fetchAllRecords() {
    const out = [];
    let url = `${REGISTRY_URL}?_limit=1000`;
    for (let page = 0; url && page < 20; page++) {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`the model registry answered ${res.status}`);
      const body = await res.json();
      out.push(...(Array.isArray(body?.data) ? body.data : []));
      const next = res.headers?.get?.('next-page') || '';
      url = /^https:\/\/firefox\.settings\.services\.mozilla\.com\//.test(next) ? next : '';
    }
    return out;
  }

  // What is on disk. A pair counts only when its manifest is there and every file has its recorded size.
  function manifestOf(from, to) {
    const m = readJson(manifestPath(from, to));
    if (!m || m.from !== from || m.to !== to || !Array.isArray(m.files) || !m.files.length) return null;
    for (const f of m.files) {
      if (!safeName(f.name)) return null;
      try { if (fs.statSync(path.join(pairDir(from, to), f.name)).size !== f.size) return null; } catch { return null; }
    }
    return m;
  }
  const isInstalled = (from, to) => Boolean(manifestOf(from, to));
  function installed() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const m = /^([A-Za-z-]{2,8})-([A-Za-z-]{2,8})$/.exec(name);
      if (!m) continue;
      const man = manifestOf(m[1], m[2]);
      if (man) out.push({ from: m[1], to: m[2], version: man.version, bytes: man.files.reduce((n, f) => n + f.size, 0), installedAt: man.installedAt || 0 });
    }
    return out.sort((a, b) => pairKey(a.from, a.to).localeCompare(pairKey(b.from, b.to)));
  }
  const installedSet = () => new Set(installed().map((p) => pairKey(p.from, p.to)));
  // Absolute paths of a pair's files, { model, lex, vocab | srcvocab + trgvocab }, or null.
  function filesOf(from, to) {
    const m = manifestOf(from, to);
    if (!m) return null;
    const out = { version: m.version };
    for (const f of m.files) out[f.type] = path.join(pairDir(from, to), f.name);
    return out;
  }
  // Re-hash a pair's files against its manifest (an integrity check; loading only compares sizes).
  async function verify(from, to) {
    const m = manifestOf(from, to);
    if (!m) return false;
    for (const f of m.files) {
      if (await hashFile(path.join(pairDir(from, to), f.name)) !== f.hash) return false;
    }
    return true;
  }
  const hashFile = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

  function remove(from, to) {
    if (jobs.has(pairKey(from, to))) cancel(from, to);
    fs.rmSync(pairDir(from, to), { recursive: true, force: true });
  }
  function removeAll() {
    for (const p of installed()) remove(p.from, p.to);
  }
  const usedBytes = () => installed().reduce((n, p) => n + p.bytes, 0);

  // Download one pair. `onProgress({ received, total })`; resolves to the manifest. A second call for the
  // same pair joins the running download. Cancelled (cancel(), or `signal`) rejects with DownloadCancelled.
  function download(from, to, { onProgress, signal } = {}) {
    const key = pairKey(from, to);
    const running = jobs.get(key);
    if (running) {
      if (onProgress) running.listeners.add(onProgress);
      return running.promise;
    }
    const controller = new AbortController();
    const listeners = new Set(onProgress ? [onProgress] : []);
    const job = { controller, listeners, promise: null };
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    job.promise = (async () => {
      const idx = await loadIndex();
      const entry = idx[key];
      if (!entry) throw new Error(`no model for ${from} to ${to}`);
      if (controller.signal.aborted) throw new DownloadCancelled();
      const final = pairDir(from, to);
      const tmp = `${final}.part-${process.pid}-${now()}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const total = entry.bytes;
      const got = new Map();
      const report = () => { const received = [...got.values()].reduce((n, v) => n + v, 0); for (const fn of listeners) { try { fn({ received, total }); } catch { /* a bad listener */ } } };
      try {
        report();
        await Promise.all(entry.files.map((f) => fetchFile(f, path.join(tmp, f.name), controller.signal, (n) => { got.set(f.name, n); report(); })));
        if (controller.signal.aborted) throw new DownloadCancelled();
        const manifest = { from, to, version: entry.version, installedAt: now(), files: entry.files.map(({ type, name, hash, size }) => ({ type, name, hash, size })) };
        fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
        fs.rmSync(final, { recursive: true, force: true });
        fs.renameSync(tmp, final);
        return manifest;
      } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw controller.signal.aborted ? new DownloadCancelled() : err;
      }
    })().finally(() => { jobs.delete(key); signal?.removeEventListener?.('abort', onAbort); });
    jobs.set(key, job);
    return job.promise;
  }
  async function fetchFile(f, dest, signal, onBytes) {
    const res = await doFetch(ATTACHMENT_BASE + f.location, { signal });
    if (!res.ok || !res.body) throw new Error(`${f.name}: the download answered ${res.status}`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest);
    let size = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > f.size) throw new Error(`${f.name}: larger than the registry says`);
        hash.update(value);
        if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
        onBytes(size);
      }
      await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
    } catch (err) {
      out.destroy();
      throw err;
    }
    if (size !== f.size) throw new Error(`${f.name}: ${size} bytes, expected ${f.size}`);
    if (hash.digest('hex') !== f.hash) throw new Error(`${f.name}: the download does not match Mozilla's checksum`);
  }
  function cancel(from, to) { jobs.get(pairKey(from, to))?.controller.abort(); }
  const downloading = () => [...jobs.keys()];

  return { loadIndex, indexNow: () => index, installed, installedSet, isInstalled, filesOf, verify, remove, removeAll, usedBytes, download, cancel, downloading, dir };
}

module.exports = {
  REGISTRY_URL, ATTACHMENT_BASE, MODEL_MAJOR_MIN, MODEL_MAJOR_MAX, PIVOT, FILE_TYPES, DownloadCancelled,
  modelCode, lumenCode, sourceModelCode, bestSet, buildIndex, planRoute, pairKey, missingBytes, languagesIn, formatBytes,
  compareVersions, createModelStore,
};
