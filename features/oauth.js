// Generic OAuth 2.0 pieces for widget connectors that sign in (Slack today; Spotify and Gmail can reuse
// or extend it). Pure functions: no network, no Electron, no storage, so the tests exercise all of it.
// features/widgets.js does the requests (its rate limit and 429 back-off apply) and main.js encrypts
// what is stored (safeStorage, settings.keys["widget:<name>"]); tokens never reach the page.
//
//   randomState(), pkce()          CSRF state (RFC 6749 §10.12) and a PKCE verifier/challenge pair (RFC 7636)
//   authorizeUrl(base, params)     the address the user approves at
//   form(obj)                      an application/x-www-form-urlencoded body
//   parseRedirect(text, state)     the code out of the address the provider redirected to (pasted, or read
//                                  from a loopback listener); checks state and the provider's error.
//                                  A bare code is refused: it carries no state to check
//   loopbackRedirect(port, path)   http://127.0.0.1:<port><path>, for providers that allow it (RFC 8252 §7.3)
//   expiresAt / isFresh            token expiry with a safety margin
//   normalizeToken(body, now, prev) a standard token response -> { access, refresh, exp }
//   packTokens / unpackTokens      the encrypted secret is one JSON string; this validates it on the way back
//   retryAfterMs(headers)          a 429's Retry-After, clamped
'use strict';

const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomState = () => b64url(crypto.randomBytes(24));
const challengeFor = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());
function pkce() {
  const verifier = b64url(crypto.randomBytes(48)); // 64 characters of the RFC's unreserved set
  return { verifier, challenge: challengeFor(verifier), state: randomState() };
}

function authorizeUrl(base, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return `${base}?${q}`;
}
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

module.exports = { randomState, pkce, challengeFor, authorizeUrl, form, loopbackRedirect, parseRedirect, expiresAt, isFresh, normalizeToken, packTokens, unpackTokens, retryAfterMs, SKEW };
