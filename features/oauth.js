// Generic OAuth 2.0 for "installed app" sign-ins from the main process: Authorization Code + PKCE
// (RFC 7636) with a loopback redirect (RFC 8252), the token exchange and refresh, and an in-memory
// access token in front of an encrypted refresh token. Built for the Gmail widget; nothing in here is
// specific to Google, so other widgets (Slack, ...) can share it by passing their own endpoints.
//
// No Electron and no global fetch in this file: the caller hands in `post(url, formBody)` (which
// resolves { ok, status, body }), `openExternal(url)` (the user's default browser: the consent page is
// never shown in an embedded page) and `load()` / `save()` for the stored credentials, which
// features/widgets.js keeps encrypted through main.js (safeStorage). Tokens never leave this process.
//
//   pkce()                               -> { verifier, challenge, state }
//   authorizeUrl(base, opts)             -> the consent URL
//   tokenForm(kind, creds)               -> the form body for the token endpoint ('code' | 'refresh')
//   parseToken(text, now, prevRefresh)   -> { access, refresh, exp }
//   classifyTokenFailure(status, text)   -> { kind: 'revoked' | 'client' | 'rate' | 'server' | 'other', ... }
//   startLoopback({ state })             -> { redirectUri, wait, close }: a one-shot 127.0.0.1 listener
//   beginSignIn(opts)                    -> { url, done, cancel }: the whole browser round trip
//   createSession(opts)                  -> { access(), invalidate(), connected() }: refresh + 401 handling
//   encodeCreds / decodeCreds            -> the stored blob (client id, client secret, refresh token)
'use strict';

const crypto = require('crypto');
const http = require('http');

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// An error the user can read. `reconnect` means the grant is gone (revoked, expired, or the client
// changed) and only signing in again helps; `retryAfter` (ms) is set on a rate limit.
class OAuthError extends Error {
  constructor(message, { reconnect = false, kind = 'other', retryAfter = 0 } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.reconnect = reconnect;
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

// ---- PKCE ----
function pkce() {
  const verifier = crypto.randomBytes(64).toString('base64url'); // 86 characters (43 to 128 allowed)
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    state: crypto.randomBytes(16).toString('hex'),
  };
}
// base: the provider's authorization endpoint. extra: provider parameters (access_type, prompt, ...).
function authorizeUrl(base, { clientId, redirectUri, scope, challenge, state, extra = {} }) {
  return `${base}?${new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope,
    code_challenge_method: 'S256', code_challenge: challenge, state, ...extra,
  })}`;
}
// The token endpoint takes a form body. kind 'code': first sign-in; 'refresh': a new access token.
// clientSecret is sent only when there is one (Google's Desktop clients need it; PKCE-only ones don't).
function tokenForm(kind, { clientId, clientSecret, code, verifier, redirectUri, refresh }) {
  const p = kind === 'refresh'
    ? { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }
    : { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier };
  if (clientSecret) p.client_secret = clientSecret;
  return new URLSearchParams(p).toString();
}
// A token answer -> { access, refresh, exp } (exp: when to stop using the access token, a little
// early). A refresh answer usually has no new refresh token; then the old one stays valid.
function parseToken(text, now, previousRefresh = '') {
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body || typeof body.access_token !== 'string' || !body.access_token || body.access_token.length > 4096) throw new OAuthError('The sign-in service sent something unexpected.');
  const refresh = typeof body.refresh_token === 'string' && body.refresh_token.length <= 4096 ? body.refresh_token : previousRefresh;
  if (!refresh) throw new OAuthError('The sign-in service sent no refresh token. Connect again.', { reconnect: true });
  const seconds = Number.isFinite(body.expires_in) ? Math.min(3600, Math.max(60, body.expires_in)) : 3600;
  return { access: body.access_token, refresh, exp: now + (seconds - 30) * 1000 };
}
// A failed token request -> what happened. invalid_grant is a revoked, expired (Google's testing mode
// expires refresh tokens after 7 days) or replaced grant; invalid_client / unauthorized_client is a
// Client ID (or secret) the provider doesn't accept. Both need the user to connect again.
function classifyTokenFailure(status, text, retryAfterHeader) {
  let error = '';
  let description = '';
  try {
    const b = JSON.parse(text);
    error = typeof b?.error === 'string' ? b.error : '';
    description = flat(b?.error_description, 160);
  } catch { /* not JSON */ }
  if (status === 429) {
    const secs = Number(retryAfterHeader);
    return { kind: 'rate', error, description, retryAfter: Number.isFinite(secs) && secs > 0 ? Math.min(120e3, secs * 1000) : 60e3 };
  }
  if (error === 'invalid_grant') return { kind: 'revoked', error, description };
  if (error === 'invalid_client' || error === 'unauthorized_client' || error === 'access_denied') return { kind: 'client', error, description };
  if (status >= 500) return { kind: 'server', error, description };
  if (status === 400 || status === 401) return { kind: 'revoked', error, description };
  return { kind: 'other', error, description };
}

// ---- stored credentials: one small JSON blob per account, encrypted by the caller ----
function encodeCreds(c) {
  const out = {};
  for (const k of ['clientId', 'clientSecret', 'refresh']) if (typeof c?.[k] === 'string' && c[k]) out[k] = c[k].slice(0, 4096);
  return JSON.stringify(out);
}
function decodeCreds(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const c = JSON.parse(text);
    if (!c || typeof c !== 'object') return null;
    const out = {};
    for (const k of ['clientId', 'clientSecret', 'refresh']) out[k] = typeof c[k] === 'string' ? c[k].slice(0, 4096) : '';
    return out;
  } catch { return null; }
}

// ---- the loopback redirect ----
const PAGE_CSS = 'body{font:16px system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1em;color:#222}h1{font-size:1.3em}';
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function resultPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;
}
const sameText = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Listens on 127.0.0.1 at a port the OS picks, for one redirect to /callback. Resolves once it is
// listening: { port, redirectUri, wait, close }. `wait` resolves { code } for a redirect with the right
// state, and rejects (OAuthError) when the user denied it, the time ran out, or close() was called.
// A request with the wrong state, a different path or a different Host header (DNS rebinding) is
// answered and ignored: it can neither finish nor break the sign-in.
function startLoopback({ state, timeoutMs = 5 * 60e3, path = '/callback', messages = {} } = {}) {
  const msg = { title: 'Lumen', done: 'You can close this tab and go back to Lumen.', denied: 'Sign-in was cancelled. You can close this tab.', ...messages };
  return new Promise((resolve, reject) => {
    let finish;
    let fail;
    const wait = new Promise((res, rej) => { finish = res; fail = rej; });
    wait.catch(() => {}); // a rejection nobody awaited yet is not an unhandled one
    const server = http.createServer();
    let timer = null;
    const close = () => {
      clearTimeout(timer);
      try { server.close(); server.closeAllConnections?.(); } catch { /* already closed */ }
    };
    server.on('request', (req, res) => {
      const send = (code, title, text) => res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(resultPage(title, text));
      const port = server.address()?.port;
      if (req.method !== 'GET' || (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)) { send(400, msg.title, 'Bad request.'); return; }
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { send(400, msg.title, 'Bad request.'); return; }
      if (url.pathname !== path) { send(404, msg.title, 'Not found.'); return; }
      if (!sameText(url.searchParams.get('state') || '', state)) { send(400, msg.title, 'This sign-in link did not come from Lumen.'); return; }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error) { send(200, msg.title, msg.denied); fail(new OAuthError(error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in was refused (${flat(error, 60)}).`, { kind: 'cancelled' })); close(); return; }
      if (!code || code.length > 4096) { send(400, msg.title, 'No sign-in code arrived.'); return; }
      send(200, msg.title, msg.done);
      finish({ code });
      close();
    });
    server.on('error', (err) => { close(); reject(new OAuthError(`Lumen couldn’t listen for the sign-in: ${err.message}`)); });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      timer = setTimeout(() => { fail(new OAuthError('Sign-in timed out. Try again.', { kind: 'timeout' })); close(); }, timeoutMs);
      timer.unref?.();
      resolve({ port, redirectUri: `http://127.0.0.1:${port}${path}`, wait, close: () => { fail(new OAuthError('Sign-in was cancelled.', { kind: 'cancelled' })); close(); } });
    });
  });
}

// The whole round trip: listen, open the consent page in the user's browser, wait for the redirect,
// trade the code for tokens. -> { url, done, cancel }; `done` resolves { access, refresh, exp }.
async function beginSignIn({ authorizeBase, tokenUrl, clientId, clientSecret, scope, extra, post, openExternal, now = Date.now, timeoutMs, messages }) {
  const p = pkce();
  const lb = await startLoopback({ state: p.state, timeoutMs, messages });
  const url = authorizeUrl(authorizeBase, { clientId, redirectUri: lb.redirectUri, scope, challenge: p.challenge, state: p.state, extra });
  const done = (async () => {
    try {
      await openExternal(url);
      const { code } = await lb.wait;
      const res = await post(tokenUrl, tokenForm('code', { clientId, clientSecret, code, verifier: p.verifier, redirectUri: lb.redirectUri }));
      if (!res.ok) {
        const f = classifyTokenFailure(res.status, res.body, res.retryAfter);
        throw new OAuthError(f.kind === 'client' ? 'Google doesn’t accept that Client ID or secret. Check them in Settings.' : f.kind === 'rate' ? 'The sign-in service asked Lumen to slow down. Try again in a minute.' : `The sign-in service refused the code${f.description ? ` (${f.description})` : ''}.`, { kind: f.kind });
      }
      return parseToken(res.body, now());
    } finally {
      lb.close();
    }
  })();
  done.catch(() => {});
  return { url, done, cancel: lb.close };
}

// ---- a signed-in account: keeps the access token in memory, refreshes it, clears a dead grant ----
// load() -> { clientId, clientSecret, refresh } | null; save(creds | null) persists (encrypted).
// access() returns a usable access token, refreshing when it is missing or old. Calls made while a
// refresh is running share it. A revoked grant clears the stored refresh token and throws an
// OAuthError with reconnect: true, so callers show "Reconnect" instead of failing every time.
function createSession({ tokenUrl, post, load, save, now = Date.now, messages = {} }) {
  const msg = { reconnect: 'Google signed Lumen out. Connect again in Settings.', client: 'Google doesn’t accept that Client ID or secret. Check them in Settings, then connect again.', rate: 'Google asked Lumen to slow down. It will try again shortly.', ...messages };
  let token = null; // { access, exp }: never stored, never sent to a page
  let pending = null;
  const connected = () => Boolean(load()?.refresh);
  const invalidate = () => { token = null; };
  async function refreshNow() {
    const creds = load();
    if (!creds?.clientId || !creds.refresh) throw new OAuthError(msg.reconnect, { reconnect: true, kind: 'revoked' });
    const res = await post(typeof tokenUrl === 'function' ? tokenUrl() : tokenUrl, tokenForm('refresh', { clientId: creds.clientId, clientSecret: creds.clientSecret, refresh: creds.refresh }));
    if (res.ok) {
      const t = parseToken(res.body, now(), creds.refresh);
      token = { access: t.access, exp: t.exp };
      if (t.refresh !== creds.refresh) save({ ...creds, refresh: t.refresh });
      return token.access;
    }
    const f = classifyTokenFailure(res.status, res.body, res.retryAfter);
    if (f.kind === 'revoked' || f.kind === 'client') {
      token = null;
      save({ ...creds, refresh: '' }); // keep the client id and secret: connecting again is one click
      throw new OAuthError(f.kind === 'client' ? msg.client : msg.reconnect, { reconnect: true, kind: f.kind });
    }
    if (f.kind === 'rate') throw new OAuthError(msg.rate, { kind: 'rate', retryAfter: f.retryAfter });
    throw new OAuthError(f.kind === 'server' ? 'Google is having trouble. Lumen will try again shortly.' : `Google answered ${res.status}.`, { kind: f.kind });
  }
  async function access({ force = false } = {}) {
    if (!force && token && now() < token.exp) return token.access;
    if (!pending) pending = refreshNow().finally(() => { pending = null; });
    return pending;
  }
  return { access, invalidate, connected };
}

module.exports = { OAuthError, pkce, authorizeUrl, tokenForm, parseToken, classifyTokenFailure, encodeCreds, decodeCreds, startLoopback, beginSignIn, createSession, resultPage };
