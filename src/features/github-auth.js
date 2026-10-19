// "Sign in with GitHub" for the GitHub card and the GitHub connector: one sign-in, one stored token, used by both.
//
// Three ways in, easiest first:
//  1. Device flow (RFC 8628, GitHub's OAuth "device" grant). Lumen asks github.com for a one-time code, shows it, opens
//     github.com/login/device in a Lumen tab, and polls until the person approves. It needs only a PUBLIC client id (below):
//     no client secret exists in this flow, so nothing secret ships with Lumen.
//  2. The GitHub CLI: when `gh` is installed and already signed in, `gh auth token` hands over a token with no new login.
//  3. A pasted token (advanced), as before.
//
// The token is kept as ONE encrypted string, the widget secret `github` (main.js widgetSecret, safeStorage): either a bare
// token (what pasting stored before) or a small JSON blob { v, token, via, scopes, login }. The connector reads the same
// secret (features/connectors/service.js `shared`), so signing in once sets up both. The token goes only to api.github.com
// and github.com, from the main process; the new-tab page and Settings get a status (who, how, which permissions), never it.
// Nothing here logs: not tokens, not codes, not responses.
//
// ---- One-time maintainer step ----
// Register an OAuth App (github.com → Settings → Developer settings → OAuth Apps → New OAuth App, tick "Enable Device Flow"),
// then paste its Client ID into CLIENT_ID below. docs/github-signin.md has the step-by-step. Until CLIENT_ID is set, the
// device sign-in button is hidden and the GitHub CLI and pasted-token ways still work. (LUMEN_GITHUB_CLIENT_ID overrides it,
// for trying a different app without editing the file.)
'use strict';

const CLIENT_ID = ''; // e.g. 'Ov23li...' (a public identifier, safe to commit)

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// The card needs: who you are (read:user), and the unread count (notifications). Review requests and assigned items on PUBLIC
// repositories need no scope at all. Private repositories need `repo`, which is broader than this card (GitHub has no read-only
// version of it for OAuth apps), so it is asked only when the person turns "Include private repositories" on.
const BASE_SCOPES = ['read:user', 'notifications'];
const PRIVATE_SCOPE = 'repo';
const TOKEN_PATTERN = /^(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,60}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
const USER_CODE = /^[A-Z0-9-]{4,20}$/;
const MAX_FLOW_MS = 15 * 60e3; // whatever GitHub says, never poll longer than this

// ---- the stored secret ----
const looksLikeToken = (t) => typeof t === 'string' && TOKEN_PATTERN.test(t);
function pack({ token, via = 'device', scopes = null, login = '' }) {
  return JSON.stringify({ v: 1, token, via, scopes: Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string').slice(0, 40) : null, login: LOGIN.test(login) ? login : '' });
}
// The stored secret -> { token, via, scopes, login } or null. A bare token (an older paste) is a 'paste' with nothing known.
function unpack(secret) {
  if (typeof secret !== 'string' || !secret) return null;
  if (secret[0] !== '{') return looksLikeToken(secret) ? { token: secret, via: 'paste', scopes: null, login: '' } : null;
  try {
    const o = JSON.parse(secret);
    if (!o || typeof o !== 'object' || !looksLikeToken(o.token)) return null;
    return {
      token: o.token,
      via: ['device', 'cli', 'paste'].includes(o.via) ? o.via : 'paste',
      scopes: Array.isArray(o.scopes) ? o.scopes.filter((s) => typeof s === 'string').slice(0, 40) : null,
      login: typeof o.login === 'string' && LOGIN.test(o.login) ? o.login : '',
    };
  } catch { return null; }
}

// ---- scopes ----
// The x-oauth-scopes header (or the token response's `scope`): null when GitHub sent none (a fine-grained token has no scopes).
function parseScopes(value) {
  if (typeof value !== 'string') return null;
  return value.split(/[\s,]+/).filter((s) => /^[\w:.-]{1,60}$/.test(s)).slice(0, 40);
}
// What a token can do for the card. Unknown scopes (fine-grained tokens) are not claimed either way.
function assess(scopes) {
  if (!Array.isArray(scopes)) return { known: false, ok: true, notifications: null, privateRepos: null };
  const has = new Set(scopes);
  const repo = has.has('repo');
  const user = has.has('read:user') || has.has('user');
  const notifications = has.has('notifications') || repo; // `repo` covers the notifications API too
  return { known: true, ok: user || repo || notifications || has.has('public_repo'), notifications, privateRepos: repo };
}
const scopeParam = (privateRepos) => (privateRepos ? [...BASE_SCOPES, PRIVATE_SCOPE] : BASE_SCOPES).join(' ');

// ---- GitHub's answers ----
const form = (obj) => new URLSearchParams(obj).toString();
const json = (body) => { try { const v = JSON.parse(body); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

// POST /login/device/code -> { code, deviceCode, interval, expiresIn } or throws a sentence for the person.
function readDevice(res, copy) {
  const b = json(res.body);
  if (b.error === 'device_flow_disabled' || (res.status === 404 && !b.device_code)) throw new Error(copy.disabled);
  if (b.error === 'incorrect_client_credentials' || b.error === 'unauthorized_client') throw new Error(copy.badClient);
  if (!res.ok || typeof b.device_code !== 'string' || typeof b.user_code !== 'string' || !USER_CODE.test(b.user_code)) throw new Error(res.status === 429 || res.status === 403 ? copy.busy : copy.unexpected);
  const interval = Number.isFinite(b.interval) && b.interval >= 1 ? Math.min(60, b.interval) : 5;
  const expiresIn = Number.isFinite(b.expires_in) && b.expires_in > 0 ? Math.min(MAX_FLOW_MS, b.expires_in * 1000) : MAX_FLOW_MS;
  return { code: b.user_code, deviceCode: b.device_code, interval, expiresIn };
}
// POST /login/oauth/access_token while waiting -> { kind: 'token'|'pending'|'slow_down'|'expired'|'denied'|'error', ... }.
function readPoll(res) {
  const b = json(res.body);
  if (typeof b.access_token === 'string' && b.access_token) return { kind: 'token', token: b.access_token, scopes: parseScopes(b.scope) };
  switch (b.error) {
    case 'authorization_pending': return { kind: 'pending' };
    case 'slow_down': return { kind: 'slow_down', interval: Number.isFinite(b.interval) ? b.interval : 0 };
    case 'expired_token': case 'token_expired': return { kind: 'expired' };
    case 'access_denied': return { kind: 'denied' };
    case 'device_flow_disabled': return { kind: 'error', code: 'disabled' };
    case 'incorrect_client_credentials': case 'unauthorized_client': case 'incorrect_device_code': case 'unsupported_grant_type': case 'bad_verification_code': return { kind: 'error', code: 'client' };
    default: return res.status >= 500 || res.status === 429 || res.status === 403 ? { kind: 'pending', retry: true } : { kind: 'error', code: 'unexpected' };
  }
}

const COPY = {
  disabled: 'GitHub sign-in isn’t set up for this copy of Lumen yet. Use the GitHub CLI or paste a token for now.',
  badClient: 'GitHub didn’t recognise Lumen’s sign-in. Update Lumen, or use the GitHub CLI or paste a token.',
  busy: 'GitHub is limiting requests right now. Try again in a minute.',
  unexpected: 'GitHub sent something unexpected. Try again in a moment.',
  expired: 'That code ran out before it was used. Press Sign in with GitHub for a new one.',
  denied: 'GitHub sign-in was cancelled, so nothing was connected.',
  network: 'Couldn’t reach GitHub. Check the connection and try again.',
  noScopes: 'GitHub gave Lumen a token without the access it needs. Sign in again and approve the permissions it asks for.',
  noGh: 'The GitHub CLI (gh) isn’t installed.',
  ghOut: 'The GitHub CLI isn’t signed in. Run “gh auth login” in a terminal first, or use Sign in with GitHub.',
  ghBad: 'The GitHub CLI gave Lumen something that isn’t a GitHub token.',
  noVault: 'This computer has no secure place for Lumen to keep the sign-in (the system keyring is off), so GitHub can’t be connected.',
  rejected: 'GitHub didn’t accept that token. Check it, or sign in again.',
  noClient: 'GitHub sign-in isn’t set up for this copy of Lumen yet. Use the GitHub CLI or paste a token for now.',
};

// ---- the GitHub CLI ----
// Found on PATH by hand (no shell, no `where`). On Windows gh is gh.exe; a .cmd/.bat shim (some installers) runs through
// cmd.exe with fixed arguments and a path that is checked for anything cmd would treat as syntax.
function findGh({ env = process.env, platform = process.platform, fs = require('fs'), path = require('path') } = {}) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const names = platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh.bat'] : ['gh'];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      let ok = false;
      try { ok = fs.statSync(file).isFile(); } catch { /* not here */ }
      if (!ok) continue;
      if (/\.(cmd|bat)$/i.test(file)) {
        if (!/^[A-Za-z0-9 _.:\\/()-]+$/.test(file)) continue;
        return { file: env.ComSpec || 'cmd.exe', pre: ['/d', '/c', file], shown: file };
      }
      return { file, pre: [], shown: file };
    }
  }
  return null;
}
function runGh(found, args, { timeout = 8000 } = {}) {
  const cli = require('../ai/cli-utils');
  return new Promise((resolve) => {
    try {
      cli.execFile(found.file, [...found.pre, ...args], { timeout, windowsHide: true, env: process.env, maxBuffer: 1 << 16 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
    } catch { resolve({ ok: false, stdout: '' }); }
  });
}
function ghFound() {
  const found = findGh();
  if (!found) return null;
  try { if (require('../ai/cli-utils').testBlocksRealCli(found.pre[2] || found.file)) return null; } catch { /* the check is only a test-run guard */ }
  return found;
}

// ---- the sign-in itself ----
// deps: { post(url, body) -> {ok,status,body}, get(url, token) -> {ok,status,headers,body}, getSecret(), setSecret(v|null),
//         loginBase(), apiBase(), clientId?(), openUrl(url), onChange(), canKeepSecrets?(), getPrivate?(), setPrivate?(bool),
//         now?, sleep?(ms), scale? (tests shrink the waits), findGh?(), runGh?(found, args) }
function create(deps) {
  const d = { now: Date.now, scale: 1, findGh: ghFound, runGh, ...deps };
  const sleep = d.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  let pending = null; // { code, url, expiresAt, cancelled }
  let last = null; // how the last sign-in ended: { ok, message }
  let bad = false; // GitHub refused the stored token: the card says Sign in again
  let cli = { at: 0, value: null, checking: null };

  const clientId = () => {
    const id = String(d.clientId?.() || process.env.LUMEN_GITHUB_CLIENT_ID || CLIENT_ID || '');
    return CLIENT_ID_PATTERN.test(id) ? id : '';
  };
  const changed = (extra) => { try { d.onChange?.(extra); } catch { /* the page looks again next time */ } };
  const loginUrl = (p) => `${String(d.loginBase()).replace(/\/+$/, '')}${p}`;

  // Who a token belongs to, and what it may do: GET /user with it. Throws a sentence; err.kind 'auth' = GitHub refused it.
  async function identify(token) {
    let res;
    try { res = await d.get(`${String(d.apiBase()).replace(/\/+$/, '')}/user`, token); } catch { throw Object.assign(new Error(COPY.network), { kind: 'network' }); }
    if (res.status === 401) throw Object.assign(new Error(COPY.rejected), { kind: 'auth' });
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error(COPY.busy), { kind: 'rate' });
    if (!res.ok) throw Object.assign(new Error(COPY.unexpected), { kind: 'other' });
    const me = json(res.body);
    const login = typeof me.login === 'string' && LOGIN.test(me.login) ? me.login : '';
    if (!login) throw Object.assign(new Error(COPY.unexpected), { kind: 'other' });
    const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-oauth-scopes') : null;
    return { login, scopes: parseScopes(header) };
  }

  // A token in hand -> checked, then stored (only after it passed), both consumers told.
  async function adopt(token, via, grantedScopes) {
    if (!looksLikeToken(token)) throw new Error(via === 'cli' ? COPY.ghBad : COPY.unexpected);
    const who = await identify(token);
    const scopes = who.scopes ?? grantedScopes ?? null;
    if (!assess(scopes).ok) throw new Error(COPY.noScopes);
    if (d.canKeepSecrets && !d.canKeepSecrets()) throw new Error(COPY.noVault);
    d.setSecret(pack({ token, via, scopes, login: who.login }));
    bad = false;
    last = { ok: true, message: `Signed in to GitHub as ${who.login}.` };
    changed({ signedIn: true });
    return who;
  }

  function cancel() {
    if (pending) { pending.cancelled = true; pending = null; changed(); }
    return true;
  }

  async function poll(flow, info) {
    let interval = info.interval;
    let fails = 0;
    while (!flow.cancelled) {
      await sleep(interval * 1000 * d.scale);
      if (flow.cancelled) return null;
      if (d.now() >= flow.expiresAt) return { kind: 'expired' };
      let res;
      try {
        res = await d.post(loginUrl('/login/oauth/access_token'), form({ client_id: flow.clientId, device_code: info.deviceCode, grant_type: GRANT }));
      } catch {
        if (++fails >= 5) return { kind: 'network' };
        continue;
      }
      fails = 0;
      const step = readPoll(res);
      if (step.kind === 'pending') continue;
      if (step.kind === 'slow_down') { interval = Math.max(interval + 5, step.interval || 0); continue; } // never faster than asked
      return step;
    }
    return null;
  }

  // Begin the device flow. Resolves as soon as the code is known ({ code, url }); the waiting goes on in the background and
  // ends in the stored token (onChange) or in `last` (how it failed).
  async function start({ privateRepos } = {}) {
    const id = clientId();
    if (!id) throw new Error(COPY.noClient);
    if (d.canKeepSecrets && !d.canKeepSecrets()) throw new Error(COPY.noVault);
    const wantPrivate = privateRepos === undefined ? d.getPrivate?.() === true : privateRepos === true;
    d.setPrivate?.(wantPrivate);
    cancel();
    last = null;
    let res;
    try { res = await d.post(loginUrl('/login/device/code'), form({ client_id: id, scope: scopeParam(wantPrivate) })); } catch { throw new Error(COPY.network); }
    const info = readDevice(res, COPY);
    const flow = { code: info.code, url: loginUrl('/login/device'), expiresAt: d.now() + info.expiresIn, clientId: id, cancelled: false };
    pending = flow;
    try { d.openUrl?.(flow.url); } catch { /* the card shows the address to open by hand */ }
    changed();
    poll(flow, info).then(async (step) => {
      if (!step || flow.cancelled) return;
      try {
        if (step.kind === 'token') await adopt(step.token, 'device', step.scopes);
        else throw new Error(step.kind === 'expired' ? COPY.expired : step.kind === 'denied' ? COPY.denied : step.kind === 'network' ? COPY.network : step.code === 'disabled' ? COPY.disabled : step.code === 'client' ? COPY.badClient : COPY.unexpected);
      } catch (err) {
        last = { ok: false, message: String(err?.message || err) };
      }
      if (pending === flow) pending = null;
      changed();
    }).catch(() => { if (pending === flow) pending = null; last = { ok: false, message: COPY.unexpected }; changed(); });
    return { code: flow.code, url: flow.url };
  }

  // gh: is it installed and signed in (kept a minute; a status read never waits for it).
  async function checkCli(force = false) {
    if (!force && cli.value !== null && d.now() - cli.at < 60e3) return cli.value;
    if (cli.checking) return cli.checking;
    cli.checking = (async () => {
      let value = false;
      const found = d.findGh();
      if (found) value = (await d.runGh(found, ['auth', 'status', '--hostname', 'github.com'])).ok;
      const was = cli.value;
      cli = { at: d.now(), value, checking: null };
      if (was !== null && was !== value) changed();
      return value;
    })();
    return cli.checking;
  }
  async function useCli() {
    const found = d.findGh();
    if (!found) throw new Error(COPY.noGh);
    const out = await d.runGh(found, ['auth', 'token', '--hostname', 'github.com']);
    const token = out.stdout.split(/\r?\n/)[0].trim();
    if (!out.ok || !token) throw new Error(COPY.ghOut);
    cancel();
    try { return await adopt(token, 'cli', null); } catch (err) { last = { ok: false, message: String(err?.message || err) }; changed(); throw err; }
  }

  function signOut() {
    cancel();
    d.setSecret(null);
    bad = false;
    last = null;
    changed({ signedIn: false });
    return status();
  }

  // For Settings and the card: what is known, never the token.
  function status() {
    const a = unpack(d.getSecret());
    const caps = assess(a?.scopes ?? null);
    if (cli.value === null && !cli.checking) checkCli().catch(() => {});
    return {
      signedIn: Boolean(a), login: a?.login || '', via: a?.via || '',
      notifications: a ? caps.notifications : null, privateRepos: a ? caps.privateRepos : null,
      expired: Boolean(a) && bad,
      device: Boolean(clientId()), cli: cli.value === true,
      wantPrivate: d.getPrivate?.() === true,
      pending: pending ? { code: pending.code, url: pending.url } : null,
      last: last ? { ...last } : null,
    };
  }

  return {
    start, cancel, useCli, signOut, status, checkCli, identify, adopt,
    fail(message) { last = { ok: false, message: String(message).slice(0, 300) }; changed(); },
    markBad() { if (!bad) { bad = true; changed(); } }, markGood() { if (bad) { bad = false; changed(); } },
    pending: () => (pending ? { code: pending.code, url: pending.url } : null),
  };
}

module.exports = { create, pack, unpack, assess, parseScopes, scopeParam, looksLikeToken, readDevice, readPoll, findGh, COPY, CLIENT_ID, BASE_SCOPES, PRIVATE_SCOPE, GRANT };
