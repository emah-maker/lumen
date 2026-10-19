// Routine web links: a small HTTP listener on 127.0.0.1 that lets something else on this computer start a routine
// (Shortcuts, cron, a script, or a tunnel the user set up for Zapier or IFTTT). Off unless the user turns on
// routineWebhooks (Settings → AI and agents → Routines). The runner (features/background-runner.js) starts and stops it.
//
// One request does one thing: POST /routines/<routine id>/run with `Authorization: Bearer <key>`. The key is 32 random
// bytes made for that routine, shown to the user once; only its SHA-256 is kept (with the routine, in the encrypted
// task store), and it is compared in constant time. An optional JSON body { "text": "..." } (at most 4 KB) is handed
// to the run as untrusted input. Everything else is refused: a Host header other than 127.0.0.1:<port> or
// localhost:<port> (DNS rebinding; a tunnel must rewrite it), other paths and methods (so a web page's CORS preflight
// fails and the browser never sends the request), a missing or wrong key, more than one started run a minute per
// routine (only a run that starts counts), and a routine that is off, busy or gone. The run itself is an ordinary routine run: same approvals, same "never two at once".
'use strict';
const crypto = require('crypto');
const http = require('http');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 47821;
const MAX_BODY = 4096;
const RATE_MS = 60000; // one run a minute per routine
const BODY_TIMEOUT_MS = 10000;
const PATH_RE = /^\/routines\/([A-Za-z0-9_-]{1,64})\/run\/?$/;

const newKey = () => crypto.randomBytes(32).toString('base64url');
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

// Does `key` match the stored hash? Both sides are hashed to 32 bytes first, so the compare takes the same time
// whatever was sent (and however long it is).
function keyMatches(hash, key) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || typeof key !== 'string' || !key) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.createHash('sha256').update(key).digest());
}

// "Bearer <key>" -> the key, or ''.
function bearer(header) {
  const m = /^Bearer\s+(\S{1,200})\s*$/i.exec(String(header || ''));
  return m ? m[1] : '';
}

// Which routine a request is for: { id } for POST /routines/<id>/run, else { status } (404 another path, 405 another method).
function route(method, url) {
  const path = String(url || '').split('?')[0];
  const m = PATH_RE.exec(path);
  if (!m) return { status: 404 };
  if (method !== 'POST') return { status: 405 };
  return { id: m[1] };
}

// The request body: empty, or JSON { text } with text a string. { text } or { status: 400 | 413 }.
function parseBody(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  if (b.length > MAX_BODY) return { status: 413 };
  const raw = b.toString('utf8').trim();
  if (!raw) return { text: '' };
  let data;
  try { data = JSON.parse(raw); } catch { return { status: 400 }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 400 };
  if (data.text === undefined || data.text === null) return { text: '' };
  if (typeof data.text !== 'string') return { status: 400 };
  return { text: data.text.slice(0, MAX_BODY) };
}

// At most one started run per routine every `ms`. wait(id, now) -> 0 when a run may start, else the ms to wait;
// took(id, now) counts a run that did start (a refused request costs nothing).
function createLimiter(ms = RATE_MS) {
  const last = new Map();
  const wait = (id, now) => { const prev = last.get(id); return prev !== undefined && now - prev < ms ? ms - (now - prev) : 0; };
  return {
    wait,
    took(id, now) {
      last.delete(id);
      last.set(id, now);
      if (last.size > 500) last.delete(last.keys().next().value);
    },
  };
}

// Is the Host header this listener's own address? (127.0.0.1:<port> or localhost:<port>, any case.)
const hostAllowed = (host, port) => [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(host || '').trim().toLowerCase());

const cleanPort = (v) => { const n = Math.round(Number(v)); return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null; };
const runUrl = (port, id) => `http://${HOST}:${port}/routines/${id}/run`;
// The command shown in the editor (with the key it just made): copied, it starts the routine from a terminal.
const curlCommand = (port, id, key) => `curl -X POST -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"text":""}' ${runUrl(port, id)}`;

// How the runner's answer to fire() becomes an HTTP status.
const STATUS_OF = { ok: 202, busy: 409, off: 409, disabled: 503, missing: 401 };

// The listener. deps: { port, hashOf(id) -> stored hash or '', fire(id, text) -> { ok, code }, now? }.
// start() resolves to { listening, port, error } (error 'in-use' when another program has the port).
function createServer({ port = DEFAULT_PORT, hashOf, fire, now = Date.now, limiter = createLimiter() }) {
  let server = null;
  const send = (res, status, body, extra = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close', ...extra });
    res.end(JSON.stringify(body));
  };

  function handle(req, res) {
    if (!hostAllowed(req.headers.host, server?.address()?.port ?? port)) { req.resume(); send(res, 403, { ok: false, error: 'Wrong Host.' }); return; }
    const r = route(req.method, req.url);
    if (r.status) { req.resume(); send(res, r.status, { ok: false, error: r.status === 405 ? 'Use POST.' : 'Not found.' }, r.status === 405 ? { Allow: 'POST' } : {}); return; }
    if (!keyMatches(hashOf(r.id), bearer(req.headers.authorization))) { req.resume(); send(res, 401, { ok: false, error: 'Wrong or missing key.' }); return; } // (an unknown routine looks the same)
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); send(res, 413, { ok: false, error: 'The body is over 4 KB.' }); return; }
    const tooSoon = (wait) => send(res, 429, { ok: false, error: 'At most one run a minute.' }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
    const wait = limiter.wait(r.id, now());
    if (wait) { req.resume(); tooSoon(wait); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; send(res, 408, { ok: false, error: 'Timed out.' }); req.destroy(); } }, BODY_TIMEOUT_MS);
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { done = true; clearTimeout(timer); send(res, 413, { ok: false, error: 'The body is over 4 KB.' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { done = true; clearTimeout(timer); });
    req.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const body = parseBody(Buffer.concat(chunks));
      if (body.status) { send(res, body.status, { ok: false, error: body.status === 413 ? 'The body is over 4 KB.' : 'The body must be JSON like {"text": "..."}.' }); return; }
      const late = limiter.wait(r.id, now()); // another request started a run while this body came in
      if (late) { tooSoon(late); return; }
      let out;
      try { out = fire(r.id, body.text) || { ok: false, code: 'missing' }; } catch (err) { console.error('[lumen] routine web link:', err?.message || err); out = { ok: false, code: 'error' }; }
      if (out.ok) limiter.took(r.id, now()); // only a run that started uses up the minute
      const status = out.ok ? 202 : (STATUS_OF[out.code] || 500);
      send(res, status, out.ok ? { ok: true, started: true } : { ok: false, error: out.error || out.code || 'Could not start the routine.' });
    });
  }

  function start() {
    return new Promise((resolve) => {
      const s = http.createServer(handle);
      s.requestTimeout = BODY_TIMEOUT_MS + 5000;
      s.headersTimeout = BODY_TIMEOUT_MS;
      s.maxHeadersCount = 30;
      s.once('error', (err) => { resolve({ listening: false, port, error: err?.code === 'EADDRINUSE' ? 'in-use' : String(err?.code || err?.message || err) }); });
      s.listen(port, HOST, () => { server = s; s.unref?.(); resolve({ listening: true, port: s.address().port, error: '' }); });
    });
  }
  function stop() {
    const s = server;
    server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
  }
  return { start, stop, handle, port: () => server?.address()?.port ?? null };
}

module.exports = { HOST, DEFAULT_PORT, MAX_BODY, RATE_MS, newKey, hashKey, keyMatches, bearer, route, parseBody, createLimiter, hostAllowed, cleanPort, runUrl, curlCommand, createServer };
