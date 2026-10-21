// [phone wifi] Receive files from a phone on the same Wi-Fi, no app and no account: Lumen shows a QR code for
// http://<this computer's LAN address>:<port>/<one-time key>, the phone's camera opens it, and the page there sends the files
// it picks straight to this computer, into the phone inbox (features/phone-inbox.js, Downloads/From phone).
//
// It is the one listener Lumen opens beyond this computer, so it is kept small:
// - It runs only while the QR sheet is open (closed, or 10 idle minutes, or an hour in all: it stops), on the LAN address
//   only (never 0.0.0.0), on a random port. One session at a time.
// - The key is 32 random bytes, only its SHA-256 is kept, compared in constant time. A Host other than <ip>:<port> is refused
//   (DNS rebinding), an Origin other than the page's own too; an upload needs the X-Lumen-Upload header, which a page on
//   another origin can't send without a CORS preflight this server never answers.
// - The first device that opens the page claims the session: any other address is refused. 30 wrong keys end it.
// - Each file streams to a hidden .part file in the inbox and is renamed into place when complete (a cut-off upload leaves
//   nothing). At most 2 GB a file, 8 GB a session, 2 uploads at once; never into the last 1 GB of free disk.
// - The page has a strict CSP (no outside anything), no-referrer (the key is in the address) and no-store.
// Plain HTTP: anyone on the same network who can watch its traffic could see the files (Settings and the sheet say to use it
// on networks you trust). Pure apart from deps: test/units/wifi-upload-units.js runs it on 127.0.0.1 (allowLoopback).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IDLE_MS = 10 * 60000;
const MAX_SESSION_MS = 60 * 60000;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_SESSION_BYTES = 8 * 1024 ** 3;
const MAX_FILES = 500;
const MAX_PARALLEL = 2;
const MAX_BAD_KEYS = 30;
const MIN_FREE_BYTES = 1024 ** 3;
const CAPTION_MAX = 4000;

// Private IPv4 ranges a home or office Wi-Fi uses (RFC 1918). Link-local (169.254), CGNAT (100.64) and public addresses are not.
function isPrivateV4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// The address the phone can reach: a private IPv4 of a real network adapter. Wi-Fi and Ethernet first (en0, en1, wlan, eth,
// "Wi-Fi"), never a VPN tunnel, a VM or container bridge, AirDrop's awdl / llw. -> { ip, iface } or null.
const SKIP_IFACE = /^(utun|ipsec|ppp|tun|tap|gif|stf|awdl|llw|bridge|vmnet|vboxnet|docker|veth|br-|virbr|zt|tailscale|wg|anpi|ap\d)/i;
function lanAddress(interfaces) {
  const found = [];
  for (const [iface, addrs] of Object.entries(interfaces || {})) {
    if (SKIP_IFACE.test(iface)) continue;
    for (const a of addrs || []) {
      if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isPrivateV4(a.address)) continue;
      const rank = /^(en0|wlan|wl|wi-?fi)/i.test(iface) ? 0 : /^(en|eth|ethernet)/i.test(iface) ? 1 : 2;
      found.push({ ip: a.address, iface, rank });
    }
  }
  found.sort((x, y) => x.rank - y.rank);
  return found[0] ? { ip: found[0].ip, iface: found[0].iface } : null;
}

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest();
const keyMatches = (key, hash) => { const h = hashKey(key); return h.length === hash.length && crypto.timingSafeEqual(h, hash); };

// A header value the page sent with encodeURIComponent; '' when it isn't valid.
function decodeHeader(v, max) {
  if (typeof v !== 'string' || v.length > max * 12) return '';
  try { return decodeURIComponent(v).slice(0, max); } catch { return ''; }
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// The phone's page: pick files, an optional note, a progress row per file. Everything inline (the CSP allows nothing else).
function pageHtml({ nonce, words, maxFile }) {
  const w = (k) => escapeHtml(words[k] || k);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${w('title')}</title>
<style nonce="${nonce}">
:root{--bg:#f6f6f4;--card:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:#e3e3e0;--accent:#2f6fec;--ok:#1f8a4c;--bad:#c4372f;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141415;--card:#1f1f21;--ink:#f2f2f2;--muted:#a1a1a6;--line:#333336;--accent:#5b8ff9;--ok:#4cc27a;--bad:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:28px 16px 40px}h1{font-size:22px;margin:0 0 4px}p{margin:0 0 18px;color:var(--muted)}
.pick{display:block;width:100%;padding:18px;border:0;border-radius:14px;background:var(--accent);color:#fff;font-size:18px;font-weight:600}
textarea{width:100%;margin:14px 0 0;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);font:inherit;min-height:64px}
ul{list-style:none;margin:18px 0 0;padding:0}li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 8px}
.name{display:flex;justify-content:space-between;gap:8px}.name span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{color:var(--muted);flex:none}.ok .state{color:var(--ok)}.bad .state{color:var(--bad)}
.bar{height:4px;border-radius:2px;background:var(--line);margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--accent)}
.ok .bar,.bad .bar{display:none}#gone{display:none;color:var(--bad)}.over #gone{display:block}.over .pick,.over textarea{display:none}
</style></head><body><main>
<h1>${w('title')}</h1><p>${w('intro')}</p>
<button class="pick" id="pick" type="button">${w('pick')}</button>
<input id="files" type="file" multiple hidden>
<textarea id="note" placeholder="${w('note')}" maxlength="${CAPTION_MAX}"></textarea>
<p id="gone">${w('ended')}</p>
<ul id="list"></ul></main>
<script nonce="${nonce}">
(() => {
  const W = ${jsonForScript(words)};
  const MAX = ${Number(maxFile)};
  const $ = (id) => document.getElementById(id);
  const queue = [];
  let running = 0;
  let noteSent = false;
  const row = (file) => {
    const li = document.createElement('li');
    const name = document.createElement('div'); name.className = 'name';
    const n = document.createElement('span'); n.textContent = file.name;
    const s = document.createElement('span'); s.className = 'state'; s.textContent = W.waiting;
    name.append(n, s);
    const bar = document.createElement('div'); bar.className = 'bar'; const fill = document.createElement('i'); bar.append(fill);
    li.append(name, bar); $('list').prepend(li);
    return { li, s, fill };
  };
  const next = () => {
    while (running < 2 && queue.length) {
      const { file, ui } = queue.shift();
      running++;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', location.pathname.replace(/\\/$/, '') + '/upload');
      xhr.setRequestHeader('X-Lumen-Upload', '1');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      const note = $('note').value.trim();
      if (note && !noteSent) { xhr.setRequestHeader('X-Caption', encodeURIComponent(note)); noteSent = true; }
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round((e.loaded / e.total) * 100); ui.fill.style.width = p + '%'; ui.s.textContent = p + '%'; } };
      xhr.onload = () => {
        running--;
        if (xhr.status === 200) { ui.li.className = 'ok'; ui.s.textContent = W.sent; }
        else { ui.li.className = 'bad'; let msg = W.failed; try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {} ui.s.textContent = msg; if (xhr.status === 410 || xhr.status === 403) document.body.classList.add('over'); }
        next();
      };
      xhr.onerror = () => { running--; ui.li.className = 'bad'; ui.s.textContent = W.failed; next(); };
      xhr.send(file);
    }
  };
  $('pick').addEventListener('click', () => $('files').click());
  $('files').addEventListener('change', () => {
    for (const file of $('files').files) {
      const ui = row(file);
      if (file.size > MAX) { ui.li.className = 'bad'; ui.s.textContent = W.tooBig; continue; }
      queue.push({ file, ui });
    }
    $('files').value = '';
    next();
  });
})();
</script></body></html>`;
}

// deps: { inbox: { dir, saveFile(tmpPath, name, mime) -> saved }, onFile?(saved, caption), onEvent?(event), words: {...},
//         http (node:http), interfaces() -> os.networkInterfaces(), now?(), freeBytes?(dir), allowLoopback?, deviceOf?(req) (tests) }
// Events: { type: 'claimed', device } | { type: 'file', saved } | { type: 'stopped', reason }.
function createWifiUpload(deps) {
  const now = deps.now || (() => Date.now());
  let s = null; // the running session

  function freeBytes(dir) {
    if (deps.freeBytes) return deps.freeBytes(dir);
    try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch { return Infinity; }
  }

  function send(res, status, body, headers = {}) {
    const json = typeof body !== 'string';
    res.writeHead(status, {
      'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...headers,
    });
    res.end(json ? JSON.stringify(body) : body);
  }
  const fail = (res, status, error) => send(res, status, { error });

  function touch() {
    if (!s) return;
    s.last = now();
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => stop('idle'), IDLE_MS);
    s.idleTimer.unref?.();
  }

  // -> { url, ip, port, expires }. A second start while one runs ends the old one (one session at a time).
  async function start() {
    if (s) stop('replaced');
    const lan = deps.allowLoopback ? { ip: '127.0.0.1', iface: 'lo' } : lanAddress(deps.interfaces());
    if (!lan) throw Object.assign(new Error(deps.words.noNetwork || 'No Wi-Fi network.'), { code: 'no-network' });
    const key = crypto.randomBytes(32).toString('base64url');
    const session = { hash: hashKey(key), ip: lan.ip, port: 0, server: null, started: now(), last: now(), claimedBy: null, badKeys: 0, files: 0, bytes: 0, active: 0, sockets: new Set(), idleTimer: null, endTimer: null, parts: new Set() };
    const server = deps.http.createServer((req, res) => handle(session, req, res));
    server.headersTimeout = 15000;
    server.requestTimeout = 0; // (a big file on slow Wi-Fi takes long: the socket's idle timeout below covers a stalled one)
    server.on('connection', (sock) => { session.sockets.add(sock); sock.setTimeout(120000, () => sock.destroy()); sock.on('close', () => session.sockets.delete(sock)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, lan.ip, () => { server.off('error', reject); resolve(); }); });
    session.server = server;
    session.port = server.address().port;
    s = session;
    touch();
    session.endTimer = setTimeout(() => stop('expired'), MAX_SESSION_MS);
    session.endTimer.unref?.();
    return { url: `http://${lan.ip}:${session.port}/${key}`, ip: lan.ip, port: session.port, iface: lan.iface, expires: session.started + MAX_SESSION_MS };
  }

  function stop(reason = 'closed') {
    const session = s;
    if (!session) return false;
    s = null;
    clearTimeout(session.idleTimer);
    clearTimeout(session.endTimer);
    try { session.server.close(); } catch { /* already closed */ }
    for (const sock of session.sockets) sock.destroy(); // (an upload in flight is cut: its .part file is removed below)
    for (const part of session.parts) fs.promises.unlink(part).catch(() => {});
    deps.onEvent?.({ type: 'stopped', reason, files: session.files });
    return true;
  }

  function handle(session, req, res) {
    if (s !== session) return fail(res, 410, deps.words.ended);
    const host = String(req.headers.host || '');
    if (host !== `${session.ip}:${session.port}`) return fail(res, 421, 'Wrong host.'); // DNS rebinding: a name that points here
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${session.ip}:${session.port}`) return fail(res, 403, 'Wrong origin.');
    const where = String(req.url || '').split('?')[0];
    if (/^\/(favicon\.ico|apple-touch-icon[\w-]*\.png)$/.test(where)) return fail(res, 404, 'Not found.'); // (the phone's browser asks for these by itself: not a wrong key)
    const m = /^\/([A-Za-z0-9_-]{43})(\/upload)?\/?$/.exec(where);
    if (!m || !keyMatches(m[1], session.hash)) {
      if (++session.badKeys >= MAX_BAD_KEYS) { fail(res, 404, 'Not found.'); stop('bad-keys'); return null; }
      return fail(res, 404, 'Not found.');
    }
    const device = (deps.deviceOf ? deps.deviceOf(req) : req.socket.remoteAddress) || ''; // (tests stand in for a second phone)
    if (session.claimedBy && session.claimedBy !== device) return fail(res, 403, deps.words.taken);
    if (!session.claimedBy) {
      session.claimedBy = device;
      deps.onEvent?.({ type: 'claimed', device, agent: String(req.headers['user-agent'] || '').slice(0, 200) });
    }
    touch();
    if (!m[2]) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.');
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(res, 200, pageHtml({ nonce, words: deps.words, maxFile: MAX_FILE_BYTES }), {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      });
    }
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');
    if (req.headers['x-lumen-upload'] !== '1') return fail(res, 403, 'Missing header.');
    return upload(session, req, res);
  }

  async function upload(session, req, res) {
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 411, deps.words.failed);
    if (size > MAX_FILE_BYTES) return fail(res, 413, deps.words.tooBig);
    if (session.bytes + size > MAX_SESSION_BYTES || session.files >= MAX_FILES) return fail(res, 413, deps.words.sessionFull);
    if (session.active >= MAX_PARALLEL) return fail(res, 429, deps.words.failed);
    fs.mkdirSync(deps.inbox.dir, { recursive: true });
    if (freeBytes(deps.inbox.dir) - size < MIN_FREE_BYTES) return fail(res, 507, deps.words.diskFull);
    const name = decodeHeader(req.headers['x-file-name'], 255) || 'file';
    const caption = decodeHeader(req.headers['x-caption'], CAPTION_MAX).trim();
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().slice(0, 100);
    const part = path.join(deps.inbox.dir, `.incoming-${crypto.randomBytes(8).toString('hex')}.part`);
    session.active++;
    session.parts.add(part);
    session.bytes += size;
    let got = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part, { flags: 'wx' });
        req.on('data', (chunk) => {
          got += chunk.length;
          if (got > size) { req.destroy(); out.destroy(); reject(new Error('More bytes than it said.')); return; }
          if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
          if (s === session) touch();
        });
        req.on('end', () => out.end());
        req.on('aborted', () => { out.destroy(); reject(new Error('The upload was cut off.')); });
        req.on('error', (err) => { out.destroy(); reject(err); });
        out.on('finish', resolve);
        out.on('error', reject);
      });
      if (got !== size) throw new Error('The upload was cut off.');
      if (s !== session) throw new Error(deps.words.ended);
      const saved = deps.inbox.saveFile(part, name, mime);
      session.parts.delete(part);
      session.files++;
      deps.onEvent?.({ type: 'file', saved });
      try { deps.onFile?.(saved, caption); } catch (err) { console.error('[lumen] wifi upload: could not show a file:', err?.message || err); }
      return send(res, 200, { ok: true, name: saved.name });
    } catch (err) {
      session.bytes -= size;
      session.parts.delete(part);
      fs.promises.unlink(part).catch(() => {});
      if (!res.headersSent && !res.destroyed) return fail(res, s === session ? 400 : 410, String(err?.message || deps.words.failed).slice(0, 200));
      return null;
    } finally {
      session.active--;
    }
  }

  const status = () => (s ? { running: true, ip: s.ip, port: s.port, claimed: Boolean(s.claimedBy), files: s.files, bytes: s.bytes } : { running: false });

  return { start, stop, status };
}

module.exports = { createWifiUpload, lanAddress, isPrivateV4, pageHtml, hashKey, keyMatches, IDLE_MS, MAX_SESSION_MS, MAX_FILE_BYTES, MAX_BAD_KEYS };
