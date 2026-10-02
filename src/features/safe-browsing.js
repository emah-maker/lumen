// ---------- Safe Browsing: warnings for suspected phishing and malware (Google Safe Browsing v5) ----------
//
// Off by default; needs the user's own Google API key (the API is free for non-commercial use).
// This is "Local List Mode" (developers.google.com/safe-browsing/reference/Local.List.Mode): Lumen
// downloads Google's lists of 4-byte SHA-256 prefixes of unsafe URL expressions and checks every
// page against them on this computer. Only when a prefix matches does Lumen ask Google for the full
// hashes behind that prefix, sending the 4-byte prefixes alone, never the address. Pages only
// (main frames and their redirects): Google asks clients not to check sub-resources.
//
// If Google can't be reached, pages load (the protocol's own rule: an error means SAFE).
//
// Going past a warning is the user's choice alone, as with certificate errors (site-security.js):
// the warning page's "Visit this site" link only loads the address again; this module then asks in
// Lumen's own dialog, which page scripts, the AI's tools and CDP can't reach. Any other load of a
// flagged address (typed, a link, a redirect, the agent's navigate) is cancelled, and the tab
// shows the warning page.
//
// deps: { readSettings, apiKey() -> string|null, dir() -> folder for the lists, fetch(url) -> Response,
//         isTab(wc), dialogs, win(), warnUrl, baseUrl?, onChange?() }
const crypto = require('crypto');
const fsp = require('fs').promises;
const os = require('os');
const net = require('net');
const path = require('path');
const { getDomain } = require('tldts-experimental');

const API = 'https://safebrowsing.googleapis.com';
// Desktop lists. (uwsa-4b and pha-4b are Android's; gc-32b is for Real-Time Mode.)
const LISTS = ['se-4b', 'mw-4b', 'uws-4b'];
const THREATS = new Set(['SOCIAL_ENGINEERING', 'MALWARE', 'UNWANTED_SOFTWARE']);
const MINUTE = 60e3;
const DAY = 24 * 60 * MINUTE;

// ---------- URLs → expressions → hash prefixes (reference/URLs.and.Hashing) ----------

// Chromium hands over valid, ASCII (punycode) URLs; the published test vectors also use raw bytes.
// Work on a "byte string": one char per byte.
const toBytes = (s) => (/^[\x00-\xff]*$/.test(s) ? s : Buffer.from(s, 'utf8').toString('latin1'));

function unescapeAll(s) {
  for (let i = 0; i < 1024; i++) { // the published vectors need a handful of passes; bound it anyway
    const next = s.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === s) return s;
    s = next;
  }
  return s;
}

const escapeBytes = (s) => s.replace(/[\x00-\x20\x7f-\xff#%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

// inet_aton: 1 to 4 parts, each decimal, 0x-hex or 0-octal; the last part fills the remaining bytes.
function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length > 2 ? parseInt(p.slice(2), 16) : 0;
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let value = last;
  nums.forEach((n, i) => { value += n * 256 ** (3 - i); });
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function canonicalIPv6(inner) {
  if (!net.isIPv6(inner)) return null;
  const mapped = inner.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  // Expand, then write it the short way (RFC 5952): no leading zeros, longest zero run as ::.
  let [head, tail = ''] = inner.includes('::') ? inner.split('::') : [inner, null];
  const toGroups = (s) => (s ? s.split(':') : []);
  let groups;
  if (tail === null) groups = toGroups(head);
  else { const h = toGroups(head); const t = toGroups(tail); groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]; }
  if (groups.length === 7 && groups[6].includes('.')) { // an embedded IPv4 tail
    const [a, b, c, d] = groups.pop().split('.').map(Number);
    groups.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const words = groups.map((g) => parseInt(g, 16));
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'); // NAT64
  }
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'); // IPv4-mapped
  }
  let best = -1; let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (best < 0) return `[${hex.join(':')}]`;
  return `[${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}]`;
}

// → { url, host, path, query, ip } or null when there's no usable host.
function canonicalize(input) {
  let s = toBytes(String(input)).replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  let scheme = 'http';
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  s = unescapeAll(s);
  // After unescaping, '#' and '@' may appear anywhere; the host ends at the first '/' or '?'.
  const end = s.search(/[/?]/);
  let authority = end < 0 ? s : s.slice(0, end);
  let rest = end < 0 ? '/' : s.slice(end);
  if (rest.startsWith('?')) rest = `/${rest}`;
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  let host;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    host = canonicalIPv6(authority.slice(1, close < 0 ? undefined : close)) ?? authority.slice(0, close + 1).toLowerCase();
  } else {
    host = authority.replace(/:\d*$/, '');
    host = host.replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.').toLowerCase();
    host = parseIPv4(host) ?? host;
  }
  if (!host) return null;
  const q = rest.indexOf('?');
  const rawPath = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? '' : rest.slice(q);
  const out = [];
  let trailing = false;
  for (const seg of rawPath.split('/').slice(1)) {
    trailing = seg === '' || seg === '.' || seg === '..';
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  const pathOut = out.length ? `/${out.join('/')}${trailing ? '/' : ''}` : '/';
  const ip = Boolean(parseIPv4(host)) || host.startsWith('[');
  const h = escapeBytes(host);
  const p = escapeBytes(pathOut);
  const qs = escapeBytes(query);
  return { url: `${scheme}://${h}${p}${qs}`, host: h, path: p, query: qs, ip };
}

// Host suffixes: the exact host, then (not for IPs) up to four more, from the registrable domain
// (eTLD+1, by the Public Suffix List) adding one leading component at a time.
function hostVariants(c) {
  const hosts = [c.host];
  if (c.ip) return hosts;
  const domain = getDomain(c.host, { allowPrivateDomains: false });
  if (!domain || domain === c.host) return hosts;
  const labels = c.host.split('.');
  const start = labels.length - domain.split('.').length;
  const extra = [];
  for (let i = start; i >= 1 && extra.length < 4; i--) extra.push(labels.slice(i).join('.'));
  return [...hosts, ...extra];
}

// Path prefixes: the exact path with and without the query, then "/" and up to three more
// directory prefixes (four in all), each with its trailing slash.
function pathVariants(c) {
  const paths = [];
  if (c.query) paths.push(c.path + c.query);
  paths.push(c.path);
  const dirs = c.path.split('/').slice(1, -1); // directories only: the last part is a file (or empty)
  let prefix = '/';
  for (let i = 0; i <= dirs.length && i < 4; i++) {
    if (!paths.includes(prefix)) paths.push(prefix);
    if (i < dirs.length) prefix += `${dirs[i]}/`;
  }
  return paths;
}

function expressions(url) {
  const c = typeof url === 'string' ? canonicalize(url) : url;
  if (!c) return [];
  const out = [];
  for (const h of hostVariants(c)) for (const p of pathVariants(c)) out.push(h + p);
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'latin1')).digest();

// ---------- Rice-delta decoding (reference/Local.Database) ----------
// Bits are read from the least significant bit of each byte, bytes in order. Each entry is a
// quotient in unary (q ones, then a zero), then a k-bit remainder, least significant bit first.
function riceDecode(enc) {
  if (!enc) return [];
  const first = Number(enc.firstValue || 0);
  const k = Number(enc.riceParameter || 0);
  const count = Number(enc.entriesCount || 0);
  const data = Buffer.from(enc.encodedData || '', 'base64');
  const out = [first];
  let bit = 0;
  const total = data.length * 8;
  const next = () => {
    if (bit >= total) throw new Error('Rice data ran out');
    const b = (data[bit >> 3] >> (bit & 7)) & 1;
    bit++;
    return b;
  };
  let value = first;
  for (let i = 0; i < count; i++) {
    let q = 0;
    while (next() === 1) q++;
    let r = 0;
    for (let j = 0; j < k; j++) r += next() * 2 ** j;
    value += q * 2 ** k + r;
    if (value > 0xffffffff) throw new Error('Rice value out of range');
    out.push(value);
  }
  return out;
}

// ---------- one list: a sorted Uint32Array of big-endian 4-byte prefixes ----------

const LITTLE = os.endianness() === 'LE';

// The on-disk (and checksummed) form: each prefix as 4 big-endian bytes. Copy the typed array's bytes,
// then swap them all at once, natively, when this machine is little-endian.
function prefixesToBytes(prefixes) {
  const buf = Buffer.from(prefixes.buffer.slice(prefixes.byteOffset, prefixes.byteOffset + prefixes.byteLength));
  return LITTLE ? buf.swap32() : buf;
}

// The reverse: an aligned Uint32Array, or null when the length isn't a whole number of prefixes.
function prefixesFromBytes(bytes) {
  if (bytes.length % 4 !== 0) return null;
  const buf = Buffer.from(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)); // own, aligned copy
  if (LITTLE) buf.swap32();
  return new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

function checksum(prefixes) {
  return crypto.createHash('sha256').update(prefixesToBytes(prefixes)).digest('base64');
}

// Applies one HashList update to `current` (sorted). Throws on a malformed update.
function applyUpdate(current, list) {
  let base = list.partialUpdate ? current : new Uint32Array(0);
  if (list.partialUpdate && list.compressedRemovals) {
    const drop = new Set(riceDecode(list.compressedRemovals));
    for (const i of drop) if (i >= base.length) throw new Error('Removal index out of range');
    base = base.filter((_v, i) => !drop.has(i));
  }
  if (list.additionsEightBytes || list.additionsSixteenBytes || list.additionsThirtyTwoBytes) throw new Error('Unexpected hash length');
  const added = list.additionsFourBytes ? riceDecode(list.additionsFourBytes) : [];
  const merged = new Uint32Array(base.length + added.length);
  merged.set(base);
  merged.set(added, base.length);
  merged.sort();
  return merged;
}

function has(sorted, value) {
  let lo = 0; let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] === value) return true;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

// "12.5s" → ms (protobuf Duration in JSON).
const durationMs = (d) => { const n = parseFloat(String(d || '0').replace(/s$/, '')); return Number.isFinite(n) && n > 0 ? n * 1000 : 0; };

// After N consecutive errors: MIN(2^(N-1) * 15 minutes * (RAND + 1), 24 hours) (the Update API's rule).
const backoffMs = (n, rand = Math.random()) => Math.min(2 ** (n - 1) * 15 * MINUTE * (rand + 1), DAY);

// Addresses that never go to Google: this computer and private networks.
function isLocal(host) {
  return host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') || host.startsWith('[')
    || /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host);
}

// ---------- the service ----------

function createSafeBrowsing(deps) {
  const base = () => deps.baseUrl || API;
  const lists = new Map(); // name -> { prefixes: Uint32Array, version, checksum }
  const due = new Map(); // name -> time the list may be fetched again
  const cache = new Map(); // prefix (base64) -> { expires, full: Map(fullHash base64 -> [threat types]) }
  const flagged = new Map(); // webContents id -> { url, threat, at }: cancelled here, warning page next
  const proceeding = new Map(); // webContents id -> the address its warning page's link asked for
  const allowed = new Set(); // canonical URLs the user chose to visit anyway, until Lumen quits
  let errors = 0; // consecutive list-update errors
  let searchBlockedUntil = 0; // hashes.search backoff
  let searchErrors = 0;
  let timer = null;
  let syncing = null;
  let lastUpdate = 0;
  let lastError = '';

  const enabled = () => deps.readSettings().safeBrowsing === true;
  const active = () => enabled() && Boolean(deps.apiKey());
  const file = (name) => path.join(deps.dir(), `${name}.bin`);
  const stateFile = () => path.join(deps.dir(), 'state.json');

  // Loads the stored lists once, off the main thread's critical path (fs.promises). Never rejects:
  // a missing, partial or damaged file is ignored and that list is fetched again in full.
  let loading = null;
  function load() {
    if (!loading) {
      loading = loadFromDisk().catch(() => {}).then(() => { deps.onChange?.(); });
    }
    return loading;
  }
  async function loadFromDisk() {
    let state = {};
    try { state = JSON.parse(await fsp.readFile(stateFile(), 'utf8')); } catch {}
    if (!state || typeof state !== 'object') state = {};
    lastUpdate = Number(state.lastUpdate) || 0;
    for (const name of LISTS) {
      const meta = state.lists?.[name];
      if (!meta) continue;
      try {
        const prefixes = prefixesFromBytes(await fsp.readFile(file(name)));
        if (!prefixes || checksum(prefixes) !== meta.checksum) continue; // damaged on disk: fetched again in full
        if (lists.has(name)) continue; // an update already landed while this was reading
        lists.set(name, { prefixes, version: meta.version, checksum: meta.checksum });
        if (meta.due && !due.has(name)) due.set(name, meta.due);
      } catch {}
    }
  }

  // Atomic per file: write a .tmp beside it, then rename over. A failure leaves the old files and the
  // in-memory lists as they were (the next update writes again).
  async function save() {
    try {
      await fsp.mkdir(deps.dir(), { recursive: true });
      const state = { lastUpdate, lists: {} };
      for (const [name, l] of [...lists]) {
        await fsp.writeFile(`${file(name)}.tmp`, prefixesToBytes(l.prefixes));
        await fsp.rename(`${file(name)}.tmp`, file(name));
        state.lists[name] = { version: l.version, checksum: l.checksum, due: due.get(name) || 0 };
      }
      await fsp.writeFile(`${stateFile()}.tmp`, JSON.stringify(state));
      await fsp.rename(`${stateFile()}.tmp`, stateFile());
    } catch {}
  }

  async function getJson(pathAndQuery) {
    const url = `${base()}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}alt=json&key=${encodeURIComponent(deps.apiKey() || '')}`;
    const res = await deps.fetch(url);
    if (!res.ok) {
      const err = new Error(res.status === 400 || res.status === 403 ? `Google refused the API key (${res.status})` : `Google Safe Browsing answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // One round of list updates: every list whose wait is over, in one hashLists:batchGet.
  async function updateLists() {
    await load();
    const now = Date.now();
    const names = LISTS.filter((n) => (due.get(n) || 0) <= now);
    if (!names.length) return;
    const params = new URLSearchParams();
    for (const n of names) params.append('names', n);
    for (const n of names) { const v = lists.get(n)?.version; if (v) params.append('version', v); }
    const body = await getJson(`/v5/hashLists:batchGet?${params}`);
    const got = body.hashLists || [];
    names.forEach((name, i) => {
      const list = got.find((l) => l.name === name) || got[i];
      if (!list) return;
      const current = lists.get(name);
      let prefixes;
      try {
        prefixes = applyUpdate(current?.prefixes || new Uint32Array(0), list);
      } catch {
        lists.delete(name); // malformed: start over with a full update
        due.set(name, 0);
        return;
      }
      const sum = checksum(prefixes);
      if (list.sha256Checksum && list.sha256Checksum !== sum) {
        lists.delete(name); // doesn't match what Google has: throw it away, fetch it whole
        due.set(name, 0);
        return;
      }
      lists.set(name, { prefixes, version: list.version || current?.version || '', checksum: sum });
      due.set(name, Date.now() + durationMs(list.minimumWaitDuration));
    });
    lastUpdate = Date.now();
    await save();
  }

  // Keeps the lists fresh while the setting is on: at each list's minimum wait, backing off on errors.
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => { sync().catch(() => {}); }, Math.max(1000, ms));
    timer.unref?.();
  }
  function sync() {
    if (syncing) return syncing;
    if (!active()) { clearTimeout(timer); timer = null; return Promise.resolve(); }
    syncing = (async () => {
      let rounds = 0;
      try {
        // A zero wait means Google has more to send: fetch again right away (bounded).
        do { await updateLists(); rounds++; } while (rounds < 20 && LISTS.some((n) => (due.get(n) || 0) <= Date.now()));
        errors = 0;
        lastError = '';
        const next = Math.min(...LISTS.map((n) => due.get(n) || 0));
        schedule(next - Date.now());
      } catch (err) {
        errors++;
        lastError = err.message;
        schedule(backoffMs(errors));
      } finally {
        syncing = null;
        deps.onChange?.();
      }
    })();
    return syncing;
  }

  // Local List Mode's check. → null (safe) or { threat }.
  async function check(url) {
    if (!active()) return null;
    const c = canonicalize(url);
    if (!c || !/^https?:\/\//.test(c.url) || isLocal(c.host)) return null;
    await load();
    if (!lists.size) return null; // not downloaded yet
    const exprs = expressions(c);
    const full = exprs.map((e) => sha256(e));
    const fullB64 = new Set(full.map((f) => f.toString('base64')));
    const wanted = new Set();
    const now = Date.now();
    for (const f of full) {
      const prefix = f.subarray(0, 4);
      const key = prefix.toString('base64');
      const hit = cache.get(key);
      if (hit && hit.expires > now) {
        for (const [h, threats] of hit.full) if (fullB64.has(h)) return { threat: threats[0] };
        continue;
      }
      if (hit) cache.delete(key);
      const n = prefix.readUInt32BE(0);
      for (const l of lists.values()) if (has(l.prefixes, n)) { wanted.add(key); break; }
    }
    if (!wanted.size || now < searchBlockedUntil) return null;
    let body;
    try {
      const params = new URLSearchParams();
      for (const p of wanted) params.append('hashPrefixes', p);
      body = await getJson(`/v5/hashes:search?${params}`);
      searchErrors = 0;
    } catch {
      searchErrors++;
      searchBlockedUntil = Date.now() + backoffMs(searchErrors);
      return null; // unreachable: the page loads
    }
    const expires = Date.now() + Math.min(durationMs(body.cacheDuration) || 5 * MINUTE, DAY);
    const found = new Map();
    for (const fh of body.fullHashes || []) {
      const threats = (fh.fullHashDetails || [])
        .filter((d) => THREATS.has(d.threatType) && !(d.attributes || []).some((a) => a === 'CANARY' || a === 'FRAME_ONLY'))
        .map((d) => d.threatType);
      if (threats.length) found.set(fh.fullHash, threats);
    }
    for (const key of wanted) {
      const entry = new Map([...found].filter(([h]) => Buffer.from(h, 'base64').subarray(0, 4).toString('base64') === key));
      cache.set(key, { expires, full: entry });
    }
    for (const [h, threats] of found) if (fullB64.has(h)) return { threat: threats[0] };
    return null;
  }

  // ---------- the warning page and the way past it ----------
  const canon = (url) => canonicalize(url)?.url || url;
  function onWarningFor(wc, url) {
    const current = wc.getURL();
    if (!current.startsWith(deps.warnUrl)) return false;
    try { return new URL(current).searchParams.get('url') === url; } catch { return false; }
  }

  // session.webRequest.onBeforeRequest, for main frames only (main.js / adblock.js route them here).
  function gate(details, callback) {
    if (details.resourceType !== 'mainFrame' || !active() || !/^https?:/i.test(details.url)) return callback({});
    const wc = details.webContents;
    const url = details.url;
    check(url).then((verdict) => {
      if (!verdict || allowed.has(canon(url))) return callback({});
      if (!wc || wc.isDestroyed() || !deps.isTab(wc)) return callback({ cancel: true }); // the AI's hidden reader tabs, popups
      const asked = proceeding.get(wc.id) === url && onWarningFor(wc, url);
      proceeding.delete(wc.id);
      if (!asked) {
        flagged.set(wc.id, { url, threat: verdict.threat, at: Date.now() });
        return callback({ cancel: true });
      }
      let host = url;
      try { host = new URL(url).host; } catch {}
      deps.dialogs.showMessageBox(deps.win(), {
        type: 'warning',
        buttons: ['Cancel', 'Visit this site'],
        defaultId: 0,
        cancelId: 0,
        message: `Visit ${host}?`,
        detail: `Google Safe Browsing lists this page as ${describe(verdict.threat)}. It may try to steal your information or harm your computer. Lumen will allow this page until you quit.`,
        owner: wc,
      }).then(({ response, cancelled }) => {
        const ok = response === 1 && !cancelled && !wc.isDestroyed();
        if (ok) allowed.add(canon(url));
        else flagged.set(wc.id, { url, threat: verdict.threat, at: Date.now() });
        callback(ok ? {} : { cancel: true });
      }, () => { flagged.set(wc.id, { url, threat: verdict.threat, at: Date.now() }); callback({ cancel: true }); });
    }, () => callback({}));
  }

  // did-fail-load of a tab: the warning page's address when this module cancelled the load.
  function warningUrl(wc, failedUrl, code) {
    const f = flagged.get(wc.id);
    if (!f || code !== -20 /* ERR_BLOCKED_BY_CLIENT */ || Date.now() - f.at > 60e3) return null;
    flagged.delete(wc.id);
    return `${deps.warnUrl}?${new URLSearchParams({ url: f.url, threat: f.threat })}`;
  }

  function attachTab(wc) {
    const id = wc.id;
    wc.on('will-navigate', (event) => {
      if (onWarningFor(wc, event.url)) proceeding.set(id, event.url);
      else proceeding.delete(id);
    });
    wc.once('destroyed', () => { flagged.delete(id); proceeding.delete(id); });
  }

  function status() {
    load(); // starts reading in the background; onChange fires when the stored lists are in
    const entries = [...lists.values()].reduce((n, l) => n + l.prefixes.length, 0);
    return { enabled: enabled(), hasKey: Boolean(deps.apiKey()), active: active(), entries, lastUpdate, error: lastError, syncing: Boolean(syncing) };
  }

  // The setting or the key changed.
  function refresh() {
    if (active()) { errors = 0; searchBlockedUntil = 0; due.clear(); return sync(); }
    clearTimeout(timer);
    timer = null;
    return Promise.resolve();
  }

  return { gate, check, warningUrl, attachTab, status, refresh, sync, ready: load, stop: () => clearTimeout(timer) };
}

function describe(threat) {
  return { SOCIAL_ENGINEERING: 'suspected phishing (deceptive)', MALWARE: 'possibly harmful (malware)', UNWANTED_SOFTWARE: 'possibly hosting unwanted software' }[threat] || 'possibly unsafe';
}

module.exports = {
  createSafeBrowsing, canonicalize, expressions, riceDecode, applyUpdate, checksum, backoffMs, durationMs, prefixesToBytes, prefixesFromBytes, sha256, isLocal, LISTS,
};
