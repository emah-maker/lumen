// Generic OAuth 2.0 for widget connectors that sign in, shared by the Gmail widget (the first half:
// a full loopback round trip, token refresh and an in-memory access token in front of an encrypted
// refresh token) and the Slack widget (the second half: pure helpers for a pasted-redirect sign-in and
// a packed token blob). Nothing in here is specific to one provider.
//
// Part 1: Authorization Code + PKCE (RFC 7636) with a loopback redirect (RFC 8252), the token
// exchange and refresh, and an in-memory access token in front of an encrypted refresh token.
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
//
// Part 2 (Slack): pure functions, no network and no storage; features/widgets.js does the requests
// (its rate limit and 429 back-off apply) and main.js encrypts what is stored.
//   randomState(), challengeFor(v)       CSRF state (RFC 6749 section 10.12); the S256 challenge of a verifier
//   authorizeUrl(base, rawParams)        (also accepts Part 1's options: see below) the address the user approves at
//   form(obj)                            an application/x-www-form-urlencoded body
//   parseRedirect(text, state)           the code out of the address the provider redirected to (pasted, or read
//                                        from a loopback listener); checks state and the provider's error.
//                                        A bare code is refused: it carries no state to check
//   loopbackRedirect(port, path)         http://127.0.0.1:<port><path>, for providers that allow it (RFC 8252 section 7.3)
//   expiresAt / isFresh                  token expiry with a safety margin
//   normalizeToken(body, now, prev)      a standard token response -> { access, refresh, exp }
//   packTokens / unpackTokens            the encrypted secret is one JSON string; this validates it on the way back
//   retryAfterMs(headers)                a 429's Retry-After, clamped
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
// base: the provider's authorization endpoint. Two call shapes, told apart by `clientId`:
//   { clientId, redirectUri, scope, challenge, state, extra }  -> the standard PKCE parameters (extra: access_type, prompt, ...)
//   { client_id, scope, ... }                                   -> the parameters exactly as given; empty values are dropped
function authorizeUrl(base, params) {
  if (params && Object.hasOwn(params, 'clientId')) {
    const { clientId, redirectUri, scope, challenge, state, extra = {} } = params;
    return `${base}?${new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope,
      code_challenge_method: 'S256', code_challenge: challenge, state, ...extra,
    })}`;
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return `${base}?${q}`;
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
  // messages may be a function, read each time (the built-in client and an own one need different advice).
  const base = { reconnect: 'Google signed Lumen out. Connect again in Settings.', client: 'Google doesn’t accept that Client ID or secret. Check them in Settings, then connect again.', rate: 'Google asked Lumen to slow down. It will try again shortly.' };
  const msgNow = () => ({ ...base, ...(typeof messages === 'function' ? messages() : messages) });
  const msg = new Proxy({}, { get: (_t, k) => msgNow()[k] });
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

// ---- Part 2: pure helpers for a pasted-redirect sign-in and a packed token blob (Slack) ----
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomState = () => b64url(crypto.randomBytes(24));
const challengeFor = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)).toString();

const loopbackRedirect = (port, path = '/callback') => `http://127.0.0.1:${port}${path}`;

// What the user pasted (the whole address they landed on, or just the code) -> { code }. Throws an
// Error with a message for the user: the provider said no, the state doesn't match (a stale or foreign
// address), or there is no code.
function parseRedirect(input, expectedState) {
  const text = typeof input === 'string' ? input.trim().slice(0, 4000) : '';
  if (!text) throw new Error('Paste the address you were sent to after approving.');
  let params;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try { params = new URL(text).searchParams; } catch { throw new Error('That isn’t a web address.'); }
  } else if (/^[?&]?(code|error|state)=/.test(text)) {
    params = new URLSearchParams(text.replace(/^[?&]/, ''));
  } else {
    throw new Error('That doesn’t look like the address after approving.');
  }
  const error = params.get('error');
  if (error) throw new Error(error === 'access_denied' ? 'Access was declined, so nothing was connected.' : `The provider refused: ${error.replace(/[^\w.-]/g, '').slice(0, 60)}.`);
  const state = params.get('state');
  if (!expectedState || !state || state.length !== expectedState.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
    throw new Error('That address belongs to a different sign-in. Start again with “Open Slack”.');
  }
  const code = params.get('code');
  if (!code || !/^[\w.~-]{1,2000}$/.test(code)) throw new Error('The address has no code in it.');
  return { code };
}

const SKEW = 5 * 60e3; // refresh this long before a token expires
const expiresAt = (now, expiresIn) => (Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0 ? now + Number(expiresIn) * 1000 : 0);
// A token with no expiry (0) never expires; otherwise it is fresh until SKEW before it does.
const isFresh = (tok, now) => Boolean(tok?.access) && (!tok.exp || tok.exp - SKEW > now);

// Standard token response { access_token, refresh_token?, expires_in? } -> { access, refresh, exp }.
// A refresh that doesn't return a new refresh token keeps the previous one.
function normalizeToken(body, now, previous) {
  const b = body && typeof body === 'object' ? body : {};
  const access = typeof b.access_token === 'string' && b.access_token.length <= 4096 ? b.access_token : '';
  if (!access) return null;
  const refresh = typeof b.refresh_token === 'string' && b.refresh_token.length <= 4096 ? b.refresh_token : previous?.refresh || '';
  return { access, refresh, exp: expiresAt(now, b.expires_in) };
}

// The stored secret: one JSON string of short strings and a number. Anything else reads as nothing.
const FIELDS = { access: 4096, refresh: 4096, clientId: 64, clientSecret: 128, userId: 40, teamId: 40, teamName: 120, teamUrl: 200 };
function packTokens(obj) {
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) if (typeof obj?.[k] === 'string' && obj[k] && obj[k].length <= max) out[k] = obj[k];
  if (Number.isFinite(obj?.exp) && obj.exp > 0) out.exp = Math.round(obj.exp);
  return JSON.stringify(out);
}
function unpackTokens(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out = {};
    for (const [k, max] of Object.entries(FIELDS)) out[k] = typeof o[k] === 'string' && o[k].length <= max ? o[k] : '';
    out.exp = Number.isFinite(o.exp) && o.exp > 0 ? o.exp : 0;
    return out;
  } catch { return null; }
}

// Retry-After in ms: seconds (or an HTTP date), at least 1 s, at most 2 minutes; 60 s when absent.
function retryAfterMs(value, now = Date.now()) {
  const n = Number(value);
  let ms = 60e3;
  if (value !== null && value !== undefined && value !== '') {
    if (Number.isFinite(n)) ms = n * 1000;
    else { const at = Date.parse(value); if (Number.isFinite(at)) ms = at - now; }
  }
  return Math.min(120e3, Math.max(1e3, ms));
}

module.exports = {
  // part 1
  OAuthError, pkce, authorizeUrl, tokenForm, parseToken, classifyTokenFailure, encodeCreds, decodeCreds, startLoopback, beginSignIn, createSession, resultPage,
  // part 2
  randomState, challengeFor, form, loopbackRedirect, parseRedirect, expiresAt, isFresh, normalizeToken, packTokens, unpackTokens, retryAfterMs, SKEW,
};
