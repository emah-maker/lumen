// Sign-in for MCP servers that use OAuth, the way the MCP authorization spec describes it (2025-06-18, built on OAuth 2.1):
//  - discovery: the server's 401 names its "protected resource metadata" (RFC 9728), which names the authorization server, whose
//    own metadata (RFC 8414) has the sign-in and token addresses; a server that publishes neither gets the default /authorize,
//    /token and /register paths on its own host (the older MCP spec);
//  - dynamic client registration (RFC 7591), once per server: Lumen is a native app with a 127.0.0.1 redirect, no secret;
//  - Authorization Code + PKCE (S256) in the user's own browser, the redirect caught by a one-shot loopback listener
//    (features/oauth.js), the `resource` parameter (RFC 8707) on both requests;
//  - tokens: the access token lives in memory only; the refresh token (or, for a server that gives none, the access token) is
//    kept as ONE small blob, which mcp-client.js seals with the OS's own encryption before it is written. Refreshing is one
//    request at a time (a rotated refresh token used twice can revoke the grant), and a refusal of the refresh asks for a new sign-in.
// No Electron here: the caller hands in fetch, openExternal and where the blob is kept. Loaded only when an OAuth server is used.
'use strict';
const OA = require('./oauth');

const TIMEOUT_MS = 20e3;
const MAX_BODY = 1e6;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

// An error the page can show. `authRequired`: only signing in again helps.
class McpAuthError extends Error {
  constructor(message, { authRequired = true } = {}) { super(message); this.name = 'McpAuthError'; this.authRequired = authRequired; }
}

// Every address in the flow must be https (http only for a server on this computer): a sign-in over plain http would hand out tokens.
function secureUrl(raw, what) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new McpAuthError(`The server’s ${what} isn’t a valid address.`, { authRequired: false }); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) throw new McpAuthError(`The server’s ${what} isn’t an https address, so Lumen won’t sign in there.`, { authRequired: false });
  if (u.username || u.password) throw new McpAuthError(`The server’s ${what} has a password in it.`, { authRequired: false });
  return u;
}

// WWW-Authenticate: Bearer resource_metadata="…", scope="…", error="…" -> { resource_metadata, scope, error }
function parseChallenge(header) {
  const out = {};
  const text = String(header || '');
  if (!/^\s*bearer\b/i.test(text)) return out;
  for (const m of text.matchAll(/([a-z_]+)=(?:"([^"]*)"|([^\s,]+))/gi)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

async function request(fetch, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'manual', ...init, headers: { Accept: 'application/json', ...init.headers }, signal: controller.signal });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8').slice(0, MAX_BODY);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, text, json, headers: res.headers, retryAfter: res.headers?.get?.('retry-after') };
  } catch (err) {
    throw new McpAuthError(controller.signal.aborted ? 'The server took too long to answer.' : 'Couldn’t reach the server to sign in. Check the connection.', { authRequired: false });
  } finally { clearTimeout(timer); }
}

// The server's sign-in details. `challenge`: what its 401 said (an empty object when unknown).
async function discover({ fetch, serverUrl, challenge = {} }) {
  const server = secureUrl(serverUrl, 'address');
  const path = server.pathname === '/' ? '' : server.pathname.replace(/\/+$/, '');
  let metaUrls = [];
  if (challenge.resource_metadata) metaUrls.push(secureUrl(challenge.resource_metadata, 'sign-in information address').href);
  metaUrls.push(`${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`);
  metaUrls = [...new Set(metaUrls)];
  let issuer = server.origin;
  let scopes = challenge.scope || '';
  for (const u of metaUrls) {
    const r = await request(fetch, u);
    if (r.ok && r.json && typeof r.json === 'object') {
      const first = Array.isArray(r.json.authorization_servers) ? r.json.authorization_servers.find((x) => typeof x === 'string') : '';
      if (first) { issuer = secureUrl(first, 'sign-in service').href.replace(/\/+$/, ''); }
      if (!scopes && Array.isArray(r.json.scopes_supported)) scopes = r.json.scopes_supported.filter((s) => typeof s === 'string').join(' ');
      break;
    }
  }
  const iss = new URL(issuer);
  const ipath = iss.pathname === '/' ? '' : iss.pathname.replace(/\/+$/, '');
  const candidates = [
    `${iss.origin}/.well-known/oauth-authorization-server${ipath}`,
    `${iss.origin}/.well-known/openid-configuration${ipath}`,
    ...(ipath ? [`${iss.origin}${ipath}/.well-known/openid-configuration`] : []),
  ];
  let meta = null;
  for (const u of candidates) {
    const r = await request(fetch, u);
    if (r.ok && r.json && typeof r.json === 'object' && r.json.authorization_endpoint && r.json.token_endpoint) { meta = r.json; break; }
  }
  if (!meta) { // the older spec's fixed paths, only when the host publishes nothing
    meta = { authorization_endpoint: `${iss.origin}/authorize`, token_endpoint: `${iss.origin}/token`, registration_endpoint: `${iss.origin}/register`, fallback: true };
  }
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : null;
  if (methods && !methods.includes('S256')) throw new McpAuthError('This server’s sign-in doesn’t support PKCE (S256), which Lumen requires.', { authRequired: false });
  return {
    issuer: iss.href.replace(/\/+$/, ''),
    authEndpoint: secureUrl(meta.authorization_endpoint, 'sign-in page').href,
    tokenEndpoint: secureUrl(meta.token_endpoint, 'token address').href,
    registrationEndpoint: meta.registration_endpoint ? secureUrl(meta.registration_endpoint, 'registration address').href : '',
    scope: scopes,
    resource: server.href.split('#')[0],
  };
}

async function register({ fetch, meta, redirectUri }) {
  if (!meta.registrationEndpoint) throw new McpAuthError('This server needs an app registered with it first (it can’t set one up automatically), so Lumen can’t sign in. If it gives you a token, add that as a header instead.', { authRequired: false });
  const r = await request(fetch, meta.registrationEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Lumen', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' }),
  });
  if (!r.ok || typeof r.json?.client_id !== 'string' || !r.json.client_id) throw new McpAuthError(`The server wouldn’t register Lumen for sign-in (${r.status}).`, { authRequired: false });
  return { clientId: r.json.client_id.slice(0, 1000), clientSecret: typeof r.json.client_secret === 'string' ? r.json.client_secret.slice(0, 1000) : '' };
}

// A token answer -> { access, refresh, exp }. No refresh token is allowed (the access token is then kept until it ends).
function parseTokens(text, now, previousRefresh = '') {
  let b;
  try { b = JSON.parse(text); } catch { b = null; }
  if (!b || typeof b.access_token !== 'string' || !b.access_token || b.access_token.length > 8192) throw new McpAuthError('The server’s sign-in sent something unexpected.', { authRequired: false });
  const refresh = typeof b.refresh_token === 'string' && b.refresh_token.length <= 8192 ? b.refresh_token : previousRefresh;
  const secs = Number.isFinite(b.expires_in) && b.expires_in > 0 ? Math.min(86400, b.expires_in) : 3600;
  return { access: b.access_token, refresh, exp: now + Math.max(5, secs - 30) * 1000 };
}

const decode = (text) => { try { const o = JSON.parse(text); return o && typeof o === 'object' ? o : null; } catch { return null; } };

// One server's sign-in. load() -> the saved blob ({ clientId, clientSecret, refresh, access, exp, port, tokenEndpoint, issuer, resource }) or null;
// save(blob | null) keeps it (sealed by the caller). header() is what every request asks for.
function createAuth({ serverUrl, fetch, openExternal, load, save, now = Date.now, signInMs }) {
  let token = null; // { access, exp } in memory
  let pending = null;
  let flow = null;
  let lastChallenge = {}; // what the server's latest 401 said (its sign-in pointer and scope)
  const stored = () => load() || null;

  async function exchange(meta, creds, params) {
    const body = new URLSearchParams({ client_id: creds.clientId, resource: meta.resource, ...params });
    if (creds.clientSecret) body.set('client_secret', creds.clientSecret);
    return request(fetch, meta.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  }

  async function signIn({ challenge = lastChallenge } = {}) {
    if (!openExternal) throw new McpAuthError('Lumen can’t open your browser here.', { authRequired: false });
    const meta = await discover({ fetch, serverUrl, challenge });
    const before = stored();
    const reuse = before?.clientId && before.issuer === meta.issuer && before.tokenEndpoint === meta.tokenEndpoint ? before : null;
    const p = OA.pkce();
    if (flow) flow.cancel();
    // The same port as last time keeps the registered redirect valid; when it is taken, the client is registered again for a new one.
    let lb = null;
    if (reuse?.port) { try { lb = await OA.startLoopback({ state: p.state, timeoutMs: signInMs, port: reuse.port, messages: { done: 'You can close this tab and go back to Lumen.', denied: 'The sign-in was canceled. You can close this tab.' } }); } catch { lb = null; } }
    let creds = lb ? reuse : null;
    if (!lb) lb = await OA.startLoopback({ state: p.state, timeoutMs: signInMs, messages: { done: 'You can close this tab and go back to Lumen.', denied: 'The sign-in was canceled. You can close this tab.' } });
    flow = lb;
    try {
      if (!creds) creds = await register({ fetch, meta, redirectUri: lb.redirectUri });
      const url = OA.authorizeUrl(meta.authEndpoint, { client_id: creds.clientId, response_type: 'code', redirect_uri: lb.redirectUri, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state, scope: meta.scope, resource: meta.resource });
      await openExternal(url);
      const { code } = await lb.wait;
      const res = await exchange(meta, creds, { grant_type: 'authorization_code', code, redirect_uri: lb.redirectUri, code_verifier: p.verifier });
      if (!res.ok) {
        const f = OA.classifyTokenFailure(res.status, res.text, res.retryAfter);
        throw new McpAuthError(f.kind === 'rate' ? 'The server asked Lumen to slow down. Try again in a minute.' : `The server refused the sign-in${f.description ? ` (${f.description})` : ''}.`, { authRequired: false });
      }
      const t = parseTokens(res.text, now());
      token = { access: t.access, exp: t.exp };
      save({ clientId: creds.clientId, clientSecret: creds.clientSecret, refresh: t.refresh, ...(t.refresh ? {} : { access: t.access, exp: t.exp }), port: lb.port, tokenEndpoint: meta.tokenEndpoint, issuer: meta.issuer, resource: meta.resource });
      return true;
    } finally {
      if (flow === lb) flow = null;
      lb.close();
    }
  }

  async function refreshNow() {
    const s = stored();
    if (!s?.refresh) throw new McpAuthError('Sign in to use this server.');
    const meta = { tokenEndpoint: s.tokenEndpoint, resource: s.resource || serverUrl };
    secureUrl(meta.tokenEndpoint, 'token address');
    const res = await exchange(meta, s, { grant_type: 'refresh_token', refresh_token: s.refresh });
    const current = stored();
    if (current?.refresh !== s.refresh) { token = null; return refreshNow(); } // (signed in again, or out, meanwhile)
    if (res.ok) {
      const t = parseTokens(res.text, now(), s.refresh);
      token = { access: t.access, exp: t.exp };
      if (t.refresh !== s.refresh) save({ ...current, refresh: t.refresh }); // (a rotated refresh token is kept at once)
      return token.access;
    }
    const f = OA.classifyTokenFailure(res.status, res.text, res.retryAfter);
    if (f.kind === 'revoked' || f.kind === 'client') {
      token = null;
      save({ ...current, refresh: '', access: undefined, exp: undefined }); // (the client stays: signing in again is one click)
      throw new McpAuthError('The server ended the sign-in. Sign in again.');
    }
    throw new McpAuthError(f.kind === 'rate' ? 'The server asked Lumen to slow down. It will try again shortly.' : `The server’s sign-in answered ${res.status}.`, { authRequired: false });
  }

  // "Bearer …" for the next request, or '' when there is no sign-in yet.
  async function header({ force = false } = {}) {
    if (!force && token && now() < token.exp) return `Bearer ${token.access}`;
    const s = stored();
    if (!s) return '';
    if (!force && !token && !s.refresh && s.access && s.exp && now() < s.exp) { token = { access: s.access, exp: s.exp }; return `Bearer ${token.access}`; }
    if (!s.refresh) return '';
    if (!pending) pending = refreshNow().finally(() => { pending = null; });
    return `Bearer ${await pending}`;
  }
  // A 401 came back: true when a fresh token is ready to try once more (a refresh worked); false when only signing in helps.
  async function afterUnauthorized(wwwAuthenticate = '') {
    token = null;
    lastChallenge = parseChallenge(wwwAuthenticate);
    if (!stored()?.refresh) return false;
    try { await header({ force: true }); return true; } catch (err) { if (err?.authRequired === false) throw err; return false; }
  }

  return {
    signIn, header, afterUnauthorized,
    signedIn: () => Boolean(stored()?.refresh || (stored()?.access && stored().exp > now())),
    forget: () => { token = null; save(null); },
    cancel: () => { if (flow) flow.cancel(); },
  };
}

module.exports = { createAuth, discover, register, parseChallenge, parseTokens, secureUrl, McpAuthError, decode };
