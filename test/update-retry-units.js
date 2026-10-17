// The update download's resilience (features/zip-update.js download + stage, features/update-net.js), pure node, no
// network: which failures are retried and which are final, the backoff, resuming with an HTTP Range request, that the
// sha512 is still enforced for a download put together from several pieces, and that every retry starts from the
// ORIGINAL release address (GitHub's redirect target is a signed URL that expires).
require('./_tmp-cleanup');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Z = require('../src/features/zip-update');
const N = require('../src/features/update-net');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const sha = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-update-retry-'));
const DATA = crypto.randomBytes(100000);
const URL0 = 'https://github.com/emah-maker/lumen/releases/download/v9.9.9/Lumen-9.9.9-win-x64.zip';

// ---- a fake release server: fetch(url, { headers, signal }) answers from a script, one entry per call
const headers = (h) => ({ get: (k) => h[String(k).toLowerCase()] ?? null });
async function* chunks(buf, { size = 8192, failAfter = -1, stall = false, signal } = {}) {
  for (let i = 0; i < buf.length; i += size) {
    if (failAfter >= 0 && i >= failAfter) throw new Error('net::ERR_FAILED');
    yield buf.subarray(i, Math.min(buf.length, i + size));
  }
  if (stall) await new Promise((_r, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))));
}
// A response that sends `buf` whole (200).
const whole = (buf, opts = {}) => ({ status: 200, ok: true, headers: headers({ 'content-length': String(buf.length), etag: '"v1"' }), body: chunks(buf, opts) });
// The rest of `buf` from `from` (206), or a 200 with everything when ranges aren't honored.
const ranged = (buf, from, opts = {}) => ({ status: 206, ok: true, headers: headers({ 'content-length': String(buf.length - from), 'content-range': `bytes ${from}-${buf.length - 1}/${buf.length}`, etag: '"v1"' }), body: chunks(buf.subarray(from), opts) });
const plain = (status) => ({ status, ok: status < 400, headers: headers({}), body: status < 400 ? chunks(Buffer.alloc(0)) : null });
// net.fetch stand-in running `script[i](url, init, i)`; records every call.
function fakeNet(script, extra = {}) {
  const calls = [];
  return { calls, ...extra, fetch: async (url, init) => { const i = calls.length; calls.push({ url, range: init?.headers?.Range || '', ifRange: init?.headers?.['If-Range'] || '' }); const step = script[Math.min(i, script.length - 1)]; const r = await step(url, init, i); if (r instanceof Error) throw r; return r; } };
}
const fail = (msg) => async () => new Error(msg);
const file = () => path.join(tmp, `dl-${crypto.randomBytes(3).toString('hex')}.zip`);
const quick = (extra = {}) => { const sleeps = []; return { sleeps, sleep: async (ms) => { sleeps.push(ms); }, ...extra }; };

(async () => {
  // ---- which failures are transient
  const cls = (e) => Z.classifyError(e);
  for (const code of ['ERR_FAILED', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_TIMED_OUT', 'ERR_CONNECTION_CLOSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT', 'ERR_EMPTY_RESPONSE', 'ERR_HTTP2_PROTOCOL_ERROR']) {
    check(`classify: net::${code} is transient`, cls(new Error(`net::${code}`)).retry === true, JSON.stringify(cls(new Error(`net::${code}`))));
  }
  check('classify: a 5xx, 408 and 429 are transient', [500, 502, 503, 504, 408, 429].every((s) => cls(Object.assign(new Error('x'), { status: s })).retry), '');
  check('classify: 404 / 403 / 410 are final', [404, 403, 410].every((s) => !cls(Object.assign(new Error('x'), { status: s })).retry), '');
  check('classify: a request something on this computer cancelled is final and says so', (() => { const c = cls(new Error('net::ERR_BLOCKED_BY_CLIENT')); return !c.retry && c.key === 'blocked'; })(), '');
  check('classify: a certificate problem is final', !cls(new Error('net::ERR_CERT_AUTHORITY_INVALID')).retry, '');
  check('classify: a full disk and other file errors are final, in their own words', (() => { const c = cls(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); return !c.retry && c.key === ''; })(), '');
  check('classify: a stalled connection and an abort count as dropped, an unknown net error does not', cls(Object.assign(new Error('net::ERR_TIMED_OUT'), { timedOut: true })).key === 'timeout' && cls(Object.assign(new Error('x'), { name: 'AbortError' })).retry && !cls(new Error('net::ERR_SOMETHING_NEW')).retry, '');
  check('classify: a checksum failure is final', !cls(Object.assign(new Error('the download failed its checksum'), { fatal: true, reasonKey: 'checksum' })).retry, '');
  check('classify: reasons are plain keys (dropped / offline / timeout / server)', cls(new Error('net::ERR_FAILED')).key === 'dropped' && cls(new Error('net::ERR_INTERNET_DISCONNECTED')).key === 'offline' && cls(Object.assign(new Error('x'), { status: 503 })).key === 'server', '');
  check('backoff: 5 tries over about two minutes, growing', Z.RETRY_DELAYS.length === 4 && Z.RETRY_DELAYS.every((d, i) => i === 0 || d > Z.RETRY_DELAYS[i - 1]) && Z.RETRY_DELAYS.reduce((a, b) => a + b, 0) >= 90000 && Z.RETRY_DELAYS.reduce((a, b) => a + b, 0) <= 150000, JSON.stringify(Z.RETRY_DELAYS));

  // ---- retry with backoff
  {
    const net = fakeNet([fail('net::ERR_FAILED'), fail('net::ERR_CONNECTION_RESET'), () => whole(DATA)]);
    const q = quick(); const retries = []; const f = file();
    const r = await Z.download({ net, url: URL0, file: f, sleep: q.sleep, onRetry: (x) => retries.push(x) });
    check('retry: transient failures are retried until it works, file and hash are the whole download', r.hash === sha(DATA) && Buffer.compare(fs.readFileSync(f), DATA) === 0 && r.attempts === 3, JSON.stringify(r));
    check('retry: the pauses are the backoff steps, each announced before it', JSON.stringify(q.sleeps) === JSON.stringify(Z.RETRY_DELAYS.slice(0, 2)) && retries.length === 2 && retries.every((x) => x.key === 'dropped'), JSON.stringify([q.sleeps, retries]));
  }
  {
    const net = fakeNet([fail('net::ERR_FAILED')]);
    const q = quick();
    const err = await Z.download({ net, url: URL0, file: file(), sleep: q.sleep }).then(() => null, (e) => e);
    check('retry: it gives up after the last try, with the reason', err && err.reasonKey === 'dropped' && net.calls.length === Z.RETRY_DELAYS.length + 1 && JSON.stringify(q.sleeps) === JSON.stringify(Z.RETRY_DELAYS), JSON.stringify([err?.message, net.calls.length, q.sleeps]));
  }
  {
    const net = fakeNet([() => plain(404)]);
    const q = quick();
    const err = await Z.download({ net, url: URL0, file: file(), sleep: q.sleep }).then(() => null, (e) => e);
    check('retry: a 404 is final at once, nothing is retried', err && err.status === 404 && net.calls.length === 1 && q.sleeps.length === 0 && err.reasonKey === 'refused', JSON.stringify([err?.message, net.calls.length]));
  }
  {
    const net = fakeNet([() => plain(503), () => plain(502), () => whole(DATA)]);
    const r = await Z.download({ net, url: URL0, file: file(), sleep: quick().sleep });
    check('retry: a 5xx response is retried', r.hash === sha(DATA) && net.calls.length === 3, '');
  }
  {
    const net = fakeNet([fail('net::ERR_BLOCKED_BY_CLIENT')]);
    const err = await Z.download({ net, url: URL0, file: file(), sleep: quick().sleep }).then(() => null, (e) => e);
    check('retry: a blocked request is final (and named), not retried', err && err.reasonKey === 'blocked' && net.calls.length === 1, '');
  }
  {
    const net = fakeNet([(_u, init) => ({ status: 200, ok: true, headers: headers({ 'content-length': '10' }), body: chunks(Buffer.alloc(10), { stall: true, signal: init.signal }) }), () => whole(DATA)]);
    const r = await Z.download({ net, url: URL0, file: file(), sleep: quick().sleep, stallMs: 40 });
    check('retry: a connection that goes silent times out and is retried', r.hash === sha(DATA) && net.calls.length === 2, '');
  }
  {
    const short = (buf) => ({ status: 200, ok: true, headers: headers({ 'content-length': String(DATA.length) }), body: chunks(buf) });
    const n2 = fakeNet([() => short(DATA.subarray(0, 50000)), () => whole(DATA)]);
    const r = await Z.download({ net: n2, url: URL0, file: file(), sleep: quick().sleep });
    check('retry: a stream that ends before its Content-Length is a dropped connection', r.hash === sha(DATA) && n2.calls.length === 2, '');
  }

  // ---- fresh redirect each try
  {
    const net = fakeNet([fail('net::ERR_FAILED'), fail('net::ERR_CONNECTION_RESET'), () => whole(DATA)]);
    await Z.download({ net, url: URL0, file: file(), sleep: quick().sleep });
    check('redirect: every try asks for the original release URL again (the signed redirect target is never reused)', net.calls.length === 3 && net.calls.every((c) => c.url === URL0), JSON.stringify(net.calls.map((c) => c.url)));
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'zip-update.js'), 'utf8');
    check('redirect: download() never keeps a response url (res.url) for later tries', !/res\.url|\.redirected/.test(src.slice(src.indexOf('async function download'), src.indexOf('const extract'))), '');
  }

  // ---- resume with a Range request
  {
    const cut = 40960;
    const net = fakeNet([() => whole(DATA, { failAfter: cut }), (_u, init) => ranged(DATA, Number(/bytes=(\d+)-/.exec(init.headers.Range)[1]))]);
    const f = file(); const progress = [];
    const r = await Z.download({ net, url: URL0, file: f, sleep: quick().sleep, onProgress: (p) => progress.push(p) });
    check('resume: the second try asks for the rest with Range (and If-Range with the ETag)', net.calls[0].range === '' && net.calls[1].range === `bytes=${cut}-` && net.calls[1].ifRange === '"v1"', JSON.stringify(net.calls));
    check('resume: file and sha512 are the whole download, joined without a gap or overlap', r.resumed && r.hash === sha(DATA) && Buffer.compare(fs.readFileSync(f), DATA) === 0, '');
    check('resume: progress keeps rising to 100 across the two tries', progress.every((p, i) => i === 0 || p >= progress[i - 1]) && progress.at(-1) === 100, JSON.stringify(progress.slice(-4)));
  }
  {
    const net = fakeNet([() => whole(DATA, { failAfter: 40960 }), () => whole(DATA)]); // the server ignores Range: sends 200
    const f = file();
    const r = await Z.download({ net, url: URL0, file: f, sleep: quick().sleep });
    check('resume: a server that ignores Range gets a clean start (no doubled bytes)', !r.resumed && r.hash === sha(DATA) && Buffer.compare(fs.readFileSync(f), DATA) === 0, '');
  }
  {
    const net = fakeNet([() => whole(DATA, { failAfter: 40960 }), () => plain(416), () => whole(DATA)]);
    const f = file();
    const r = await Z.download({ net, url: URL0, file: f, sleep: quick().sleep });
    check('resume: a 416 starts over from the top', r.hash === sha(DATA) && Buffer.compare(fs.readFileSync(f), DATA) === 0 && net.calls[2].range === '', JSON.stringify(net.calls));
  }
  {
    const wrongStart = { status: 206, ok: true, headers: headers({ 'content-length': '100', 'content-range': 'bytes 0-99/100000' }), body: chunks(DATA.subarray(0, 100)) };
    const net = fakeNet([() => whole(DATA, { failAfter: 40960 }), () => wrongStart, () => whole(DATA)]);
    const f = file();
    const r = await Z.download({ net, url: URL0, file: f, sleep: quick().sleep });
    check('resume: a 206 for a different range is not appended (the file is restarted)', r.hash === sha(DATA) && Buffer.compare(fs.readFileSync(f), DATA) === 0, '');
  }

  // ---- offline: wait for the network, without using up a try
  {
    let polls = 0;
    const net = fakeNet([() => whole(DATA)], { online: false });
    const q = quick({ sleep: async (ms) => { q.sleeps.push(ms); if (++polls === 3) net.online = true; } });
    const notes = [];
    const r = await Z.download({ net, url: URL0, file: file(), sleep: q.sleep, offlinePollMs: 2000, onRetry: (x) => notes.push(x) });
    check('offline: it waits for the network to come back, then downloads', r.hash === sha(DATA) && q.sleeps.length === 3 && r.attempts === 1 && notes[0]?.offline && notes[0].key === 'offline', JSON.stringify([q.sleeps, notes]));
  }
  {
    const net = fakeNet([() => whole(DATA)], { online: false });
    const q = quick();
    const err = await Z.download({ net, url: URL0, file: file(), sleep: q.sleep, offlinePollMs: 2000, offlineMaxMs: 10000 }).then(() => null, (e) => e);
    check('offline: still offline after the wait is a final "no internet connection"', err && err.reasonKey === 'offline' && net.calls.length === 0, JSON.stringify([err?.message, q.sleeps.length]));
  }
  {
    const net = fakeNet([() => whole(DATA)], { online: () => true });
    const r = await Z.download({ net, url: URL0, file: file(), sleep: quick().sleep });
    check('offline: net.online may be a function, a boolean, or absent', r.hash === sha(DATA), '');
  }

  // ---- stage(): the checksum against latest.yml is enforced after a resume too
  const inst = path.join(tmp, 'install', 'Lumen');
  fs.mkdirSync(inst, { recursive: true });
  const execPath = path.join(inst, 'Lumen.exe');
  fs.writeFileSync(execPath, 'x');
  const asset = { name: 'Lumen-9.9.9-win-x64.zip', url: URL0 };
  const stageWith = (script, hash, extra = {}) => {
    const net = fakeNet(script);
    return Z.stage({ net, asset, version: '9.9.9', files: [{ url: asset.name, sha512: hash }], execPath, platform: 'win32', retry: { sleep: async () => {} }, ...extra }).then(() => ({ net }), (error) => ({ net, error }));
  };
  const resumeScript = (goodTail = true) => [() => whole(DATA, { failAfter: 40960 }), (_u, init) => ranged(goodTail ? DATA : Buffer.concat([DATA.subarray(0, 40960), Buffer.alloc(DATA.length - 40960, 7)]), 40960)];
  {
    // right bytes after a resume: past the checksum (the bytes aren't a zip, so it stops at unpacking, not at the checksum)
    const { error } = await stageWith(resumeScript(true), sha(DATA));
    check('stage: a resumed download with the right checksum goes on to unpack', error && /unpack|damaged|doesn.t contain/.test(error.message), error?.message);
  }
  {
    // the joined bytes are wrong and the second, clean download is wrong too: the checksum stops it
    const wrong = [() => whole(DATA, { failAfter: 40960 }), () => ranged(Buffer.concat([DATA.subarray(0, 40960), Buffer.alloc(DATA.length - 40960, 7)]), 40960), () => whole(Buffer.alloc(DATA.length, 9))];
    const { error, net } = await stageWith(wrong, sha(DATA));
    check('stage: a download that fails its sha512 is refused, even when it was resumed', error && /checksum/.test(error.message) && !/unpack/.test(error.message), error?.message);
    check('stage: a bad resumed download is fetched once more from the top before giving up', net.calls.length === 3 && net.calls[2].range === '', JSON.stringify(net.calls));
  }
  {
    const wrong = [() => whole(DATA, { failAfter: 40960 }), () => ranged(Buffer.concat([DATA.subarray(0, 40960), Buffer.alloc(DATA.length - 40960, 7)]), 40960), () => whole(DATA)];
    const { error, net } = await stageWith(wrong, sha(DATA));
    check('stage: ...and that clean second download is accepted when it matches', net.calls.length === 3 && error && /unpack|damaged|doesn.t contain/.test(error.message), error?.message);
  }
  {
    const { error, net } = await stageWith([() => whole(Buffer.alloc(1000, 1))], sha(DATA));
    check('stage: a wrong sha512 with no resume is refused at once (no second download)', error && /checksum/.test(error.message) && net.calls.length === 1, error?.message);
  }
  {
    const { error } = await stageWith([() => whole(DATA)], '');
    check('stage: no checksum in latest.yml means no download at all', error && /no checksum/.test(error.message), error?.message);
  }
  {
    const retries = [];
    const { error } = await stageWith([fail('net::ERR_FAILED'), () => whole(DATA)], sha(DATA), { onRetry: (r) => retries.push(r.key) });
    check('stage: retries are reported to the caller (onRetry)', retries[0] === 'dropped' && error && /unpack|damaged|doesn.t contain/.test(error.message), JSON.stringify(retries));
  }

  // ---- update-net: its own session, following only the profile's proxy
  check('update-net: proxy config mirrors the Proxy setting', JSON.stringify(N.proxyConfig({ mode: 'fixed_servers', rules: 'http=p:80', bypass: 'a' })) === JSON.stringify({ mode: 'fixed_servers', proxyRules: 'http=p:80', proxyBypassRules: 'a' }) && N.proxyConfig({ mode: 'pac_script', pacUrl: 'http://x/pac' }).pacScript === 'http://x/pac' && N.proxyConfig().mode === 'system', '');
  {
    const made = []; const proxies = [];
    const electron = { session: { fromPartition: (p) => { const s = { p, fetch: async (u) => `fetched ${u}`, setProxy: async (c) => { proxies.push(c); } }; made.push(s); return s; } }, net: { online: true } };
    const un = N.createUpdateNet({ electron, proxy: () => ({ mode: 'fixed_servers', rules: 'r', bypass: '' }) });
    const n = await un.get();
    check('update-net: one in-memory partition of its own, never the default session', made.length === 1 && made[0].p === 'lumen-updater' && !made[0].p.startsWith('persist:') && N.PARTITION === 'lumen-updater', JSON.stringify(made.map((m) => m.p)));
    check('update-net: fetch goes through that session, online follows net.online, the proxy is applied', (await n.fetch('http://x')) === 'fetched http://x' && n.online === true && proxies[0]?.mode === 'fixed_servers', JSON.stringify(proxies));
    electron.net.online = false;
    check('update-net: online is read live', n.online === false, '');
    await un.get();
    check('update-net: the session is created once', made.length === 1, '');
  }

  // ---- no content blocking can reach the download (the live check is test/updater-session.js)
  {
    const root = path.join(__dirname, '..', 'src');
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    const stageCode = read('features/updates.js');
    check('source: updates.js downloads through update-net, not the default session\'s net.fetch', /updateNet\(\)\.get\(\)/.test(stageCode) && !/require\('electron'\)\.net\b/.test(stageCode), '');
    const hooks = ['main.js', 'features/adblock.js', 'features/safe-browsing.js', 'settings/settings-backend.js', 'features/private-window.js', 'ai/page-debug.js', 'ai/read-speed.js'];
    check('source: nothing that installs request handlers names the updater partition or session', hooks.every((rel) => !/lumen-updater|update-net|updateNet/.test(read(rel))), hooks.filter((rel) => /lumen-updater|update-net|updateNet/.test(read(rel))).join());
    check('source: update-net registers no webRequest listener of its own', !/webRequest/.test(read('features/update-net.js').replace(/\/\/.*$/gm, '')), '');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall update-retry-units passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
