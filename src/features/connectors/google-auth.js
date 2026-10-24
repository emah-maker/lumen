// One Google sign-in for the Google Drive and Google Sheets connectors (kind 'google', see registry.js).
//
// Lumen's built-in Google client (features/google-client.js, or the user's own Google Cloud client typed for the Gmail widget) signs the
// user in through their own browser: PKCE and a one-shot 127.0.0.1 redirect (features/oauth.js). The refresh token is kept as ONE small
// encrypted blob (the service seals it into connectors.json), with the scopes Google says it has. Each connector asks for its own scopes
// and the sign-in is incremental: connecting Sheets after Drive asks Google for the union, and does not ask at all when the grant already
// covers it. Nothing here knows Drive or Sheets; the service gives every request the access token.
//
//   createAuth({ getBlob, setBlob, fetch, openExternal, builtin, own, endpoints, now, focusApp, signInMs })
//     signIn(scopes)    -> { email, scope }   opens the consent page and waits (one at a time); keeps the grant
//     access(opts)      -> an access token (refreshed when old); throws an OAuthError with reconnect: true when Google ended the sign-in
//     invalidate()      forget the in-memory access token (a 401 came back)
//     has(scopes)       whether the grant covers every scope
//     status()          -> { connected, email, scope }
//     revoke()          gives the grant back to Google and forgets it
//     cancel()          stop a sign-in that is waiting
// Pure apart from the network calls it is handed; no Electron.
'use strict';
const OA = require('../oauth');
const GC = require('../google-client');

const ENDPOINTS = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  googleRevoke: 'https://oauth2.googleapis.com/revoke',
  googleUserinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
};
const IDENTITY = ['openid', 'email']; // who signed in (for the card): non-sensitive scopes
const TIMEOUT_MS = 20e3;

const scopeList = (s) => String(s || '').split(/\s+/).filter(Boolean);
const covers = (granted, wanted) => { const have = new Set(scopeList(granted)); return wanted.every((w) => have.has(w)); };

function create({ getBlob, setBlob, fetch, openExternal, builtin = () => null, own = () => null, endpoints = () => ({}), now = Date.now, focusApp = () => {}, signInMs, canKeepSecrets = () => true }) {
  const ep = (name) => endpoints()?.[name] || ENDPOINTS[name];
  const creds = () => OA.decodeCreds(getBlob());
  const save = (c) => setBlob(c ? OA.encodeCreds(c) : '');

  async function formPost(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, redirect: 'manual', signal: controller.signal });
      const text = Buffer.from(await res.arrayBuffer()).toString('utf8').slice(0, 65536);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, body: text, retryAfter: res.headers?.get?.('retry-after') };
    } catch (err) {
      throw new OA.OAuthError(controller.signal.aborted ? 'Google took too long to answer.' : 'Couldn’t reach Google. Check the connection.', { kind: 'other' });
    } finally { clearTimeout(timer); }
  }

  // Own client (the one typed for the Gmail widget) wins over the built-in one, as it does there.
  function client() {
    const mine = own();
    const b = builtin();
    const r = GC.resolveClient({ clientId: mine?.clientId && mine.clientId !== b?.clientId ? mine.clientId : '', stored: mine, builtin: b });
    if (r.error) throw new Error('Lumen has no Google sign-in set up in this build. Add your own Google Cloud client in Settings → Home → Widgets → Gmail → Advanced (Desktop app type, with the Drive and Sheets APIs turned on), then connect again.');
    return r;
  }

  const session = OA.createSession({
    tokenUrl: () => ep('googleToken'), post: formPost, now,
    load: creds, save,
    messages: () => ({ reconnect: 'Google ended the sign-in. Connect again in Settings → You and AI → Connectors.', client: 'Google stopped accepting Lumen’s sign-in. Connect again in Settings; if that fails, add your own Google Cloud client (Settings → Home → Widgets → Gmail → Advanced).' }),
  });

  let flow = null;
  async function signIn(scopes) {
    if (!openExternal) throw new Error('Lumen can’t open your browser here.');
    if (!canKeepSecrets()) throw new Error('This computer has no secure place for Lumen to keep the sign-in (the system keyring is off), so Google can’t be connected.');
    const c = client();
    const before = creds();
    const sameClient = before?.refresh && before.clientId === c.clientId;
    const granted = sameClient ? scopeList(before.scope) : [];
    const want = [...new Set([...IDENTITY, ...granted, ...scopes])];
    const authBase = ep('googleAuth');
    if (flow) { flow.userCancelled = true; flow.cancel(); }
    const mine = await OA.beginSignIn({
      authorizeBase: authBase, tokenUrl: ep('googleToken'), clientId: c.clientId, clientSecret: c.clientSecret, scope: want.join(' '),
      extra: { access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', ...(sameClient && before.email ? { login_hint: before.email } : {}) },
      post: formPost, now, timeoutMs: signInMs,
      openExternal: (url) => { if (!url.startsWith(`${authBase}?`)) throw new Error('Refusing to open that address.'); return openExternal(url); },
      messages: { title: 'Lumen', done: 'You can close this tab and go back to Lumen, which finishes connecting Google.', denied: 'Google was not connected. You can close this tab.' },
    });
    flow = mine;
    try {
      let t;
      try { t = await mine.done; } catch (err) {
        if (err?.kind === 'timeout') { mine.userCancelled = true; throw new Error('Sign-in timed out. Try again.'); }
        if (err?.kind === 'client') throw new Error('Google doesn’t accept Lumen’s sign-in client. Update Lumen, or use your own Google Cloud client (Settings → Home → Widgets → Gmail → Advanced).');
        throw err;
      }
      let email = '';
      try {
        const res = await fetch(ep('googleUserinfo'), { headers: { Authorization: `Bearer ${t.access}`, Accept: 'application/json' }, redirect: 'manual' });
        if (res.status === 200) email = String((await res.json())?.email || '').slice(0, 320);
      } catch { /* shown without a name */ }
      const old = before;
      // A different account than the one the grant was for: the old grant is given back, the new one replaces it (a grant is one account's).
      const other = old?.refresh && old.email && email && old.email.toLowerCase() !== email.toLowerCase();
      const scope = t.scope || want.join(' ');
      if (!covers(scope, scopes)) {
        // (nothing new is kept: an unticked permission leaves the sign-in as it was; a token that is not the stored one goes back to Google)
        if (t.refresh && t.refresh !== old?.refresh) await revokeToken(t.refresh);
        throw new Error('Google didn’t give Lumen every permission it asked for. Press Connect again and leave all the boxes ticked.');
      }
      save({ clientId: c.clientId, clientSecret: c.clientSecret, refresh: t.refresh, email, scope });
      session.invalidate();
      if (other || (old?.refresh && old.refresh !== t.refresh && old.clientId !== c.clientId)) await revokeToken(old.refresh);
      return { email, scope };
    } finally {
      if (flow === mine) flow = null;
      if (!mine.userCancelled) { try { focusApp(); } catch { /* the window stays where it is */ } }
    }
  }

  async function revokeToken(token) {
    if (!token) return false;
    try { return (await formPost(ep('googleRevoke'), new URLSearchParams({ token }).toString())).ok; } catch { return false; }
  }

  return {
    signIn,
    access: (opts) => session.access(opts),
    invalidate: () => session.invalidate(),
    has: (scopes) => { const c = creds(); return Boolean(c?.refresh) && covers(c.scope, scopes); },
    status: () => { const c = creds(); return { connected: Boolean(c?.refresh), email: c?.email || '', scope: c?.scope || '' }; },
    async revoke() { const c = creds(); flow?.cancel(); save(null); session.invalidate(); return revokeToken(c?.refresh); },
    cancel: () => { if (flow) { flow.userCancelled = true; flow.cancel(); } },
  };
}

module.exports = { create, ENDPOINTS, IDENTITY };
