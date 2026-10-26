// One Microsoft sign-in for the Outlook, OneDrive and Microsoft Calendar connectors (kind 'microsoft', see registry.js). The same shape as
// google-auth.js, for the Microsoft identity platform: Authorization Code with PKCE and a loopback redirect (features/oauth.js), in the
// user's own browser, a PUBLIC client (no secret: Lumen's own app registration, features/microsoft-client.js, or a client ID the user typed).
//
// The refresh token is kept as ONE small encrypted blob (the service seals it into connectors.json), with the scopes Microsoft says it has.
// Each connector asks for its own scopes and the sign-in is incremental: the next one asks for the union (Microsoft only puts the scopes a
// request names into its access token, so the union is asked for every time) and nothing at all when the grant already covers it.
//
//   create({ getBlob, setBlob, fetch, openExternal, builtin, endpoints, now, focusApp, signInMs, canKeepSecrets })
//     signIn(scopes, { clientId })  -> { email, scope }   opens the consent page and waits (one at a time); keeps the grant
//     access(opts)                  -> an access token (refreshed when old); throws an OAuthError with reconnect: true when the sign-in ended
//     invalidate(), has(scopes), status() -> { connected, email, scope, clientId }, cancel()
//     revoke()                      forgets the grant here (Microsoft has no revoke call for a public client: the user takes it back at
//                                   account.microsoft.com/privacy/app-access, or myapps.microsoft.com for a school account)
// Pure apart from the network calls it is handed; no Electron.
'use strict';
const OA = require('../oauth');
const MC = require('../microsoft-client');

const ENDPOINTS = {
  msAuth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  msToken: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  msMe: 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
};
const IDENTITY = ['openid', 'email', 'profile', 'offline_access', 'User.Read']; // offline_access is what gives the refresh token
const TIMEOUT_MS = 20e3;
const JOIN_MS = 15e3; // (signIn: a repeat this soon joins the sign-in already open)
// What the network said, for the error a person reads ("net::ERR_PROXY_CONNECTION_FAILED"): a bare "couldn't reach" left nothing to go on.
const why = (err) => { const m = String(err?.cause?.message || err?.message || '').replace(/\s+/g,' ').trim().slice(0, 120); return m && m !== 'fetch failed' ? ` (${m})` : ''; };
const PROVIDER = 'Microsoft';

const scopeList = (s) => String(s || '').split(/\s+/).filter(Boolean);
const norm = (s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
const covers = (granted, wanted) => { const have = new Set(scopeList(granted).map(norm)); return wanted.every((w) => have.has(norm(w))); };

function create({ getBlob, setBlob, fetch, openExternal, builtin = () => null, endpoints = () => ({}), now = Date.now, focusApp = () => {}, signInMs, canKeepSecrets = () => true }) {
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
      throw new OA.OAuthError(controller.signal.aborted ? 'Microsoft took too long to answer.' : `Couldn’t reach Microsoft. Check the connection.${why(err)}`, { kind: 'other' });
    } finally { clearTimeout(timer); }
  }

  // The client that signs in: a client ID typed now wins; else the one the current grant was made with; else Lumen's own.
  function client(typed) {
    const own = MC.cleanClientId(typed);
    if (String(typed || '').trim() && !own) throw new Error('That isn’t an Application (client) ID. It looks like 00000000-0000-0000-0000-000000000000, on your app’s Overview page in the Microsoft Entra admin center.');
    if (own) return { source: 'own', clientId: own };
    const c = creds();
    if (c?.refresh && c.clientId) return { source: 'kept', clientId: c.clientId };
    const b = builtin();
    if (b?.clientId) return { source: 'builtin', clientId: b.clientId };
    throw new Error('This copy of Lumen has no Microsoft sign-in built in. Register your own app in the Microsoft Entra admin center (a “Mobile and desktop” platform with the redirect address http://localhost, and Mail, Calendar and Files permissions) and paste its Application (client) ID in the field on this card.');
  }

  const session = OA.createSession({
    tokenUrl: () => ep('msToken'), post: formPost, now, provider: PROVIDER,
    load: creds, save,
    messages: () => ({ reconnect: 'Microsoft ended the sign-in. Connect again in Settings → Apps and connections.', client: 'Microsoft stopped accepting this sign-in app. Connect again in Settings; if that fails, paste your own app’s client ID on the card.' }),
  });

  let flow = null;
  // A second Sign in for the same permissions and app within a few seconds (a second press, or two parts of Lumen asking at once) joins
  // the one already open instead of opening another browser tab and cancelling the first: finishing in the first tab then went nowhere.
  // A press after that starts afresh (the user may have closed the tab without finishing).
  let joining = null; // { key, at, promise }
  async function signIn(scopes, opts = {}) {
    const key = `${opts.clientId || ''}|${[...new Set(scopes)].sort().join(' ')}`;
    if (joining && joining.key === key && now() - joining.at < JOIN_MS) return joining.promise;
    const promise = signInOnce(scopes, opts);
    joining = { key, at: now(), promise };
    try { return await promise; } finally { if (joining?.promise === promise) joining = null; }
  }
  async function signInOnce(scopes, { clientId: typed } = {}) {
    if (!openExternal) throw new Error('Lumen can’t open your browser here.');
    if (!canKeepSecrets()) throw new Error('This computer has no secure place for Lumen to keep the sign-in (the system keyring is off), so Microsoft can’t be connected.');
    const c = client(typed);
    const before = creds();
    const sameClient = before?.refresh && before.clientId === c.clientId;
    const granted = sameClient ? scopeList(before.scope) : [];
    const want = [...new Set([...IDENTITY, ...granted.filter((s) => !IDENTITY.includes(s)), ...scopes])];
    const authBase = ep('msAuth');
    if (flow) { flow.userCancelled = true; flow.cancel(); }
    const mine = await OA.beginSignIn({
      authorizeBase: authBase, tokenUrl: ep('msToken'), clientId: c.clientId, clientSecret: '', scope: want.join(' '),
      extra: { prompt: 'select_account', response_mode: 'query', ...(sameClient && before.email ? { login_hint: before.email } : {}) },
      post: formPost, now, timeoutMs: signInMs, provider: PROVIDER, redirectHost: 'localhost', redirectPath: '/',
      openExternal: (url) => { if (!url.startsWith(`${authBase}?`)) throw new Error('Refusing to open that address.'); return openExternal(url); },
      messages: { title: 'Lumen', done: 'You can close this tab and go back to Lumen, which finishes connecting Microsoft.', denied: 'Microsoft was not connected. You can close this tab.' },
    });
    flow = mine;
    try {
      let t;
      try { t = await mine.done; } catch (err) {
        if (err?.kind === 'timeout') { mine.userCancelled = true; throw new Error('Sign-in timed out. Try again.'); }
        if (err?.kind === 'client') throw new Error('Microsoft doesn’t accept this sign-in app. Update Lumen, or paste your own app’s Application (client) ID on the card.');
        throw err;
      }
      let email = '';
      try {
        const res = await fetch(ep('msMe'), { headers: { Authorization: `Bearer ${t.access}`, Accept: 'application/json' }, redirect: 'manual' });
        if (res.status === 200) { const b = await res.json(); email = String(b?.mail || b?.userPrincipalName || '').slice(0, 320); }
      } catch { /* shown without a name */ }
      const old = before;
      const scope = t.scope || want.join(' ');
      // (Microsoft's answer names only some of what was asked in its scope field when it was asked for the union; a missing one of THIS connector's own is a refusal.)
      if (!covers(scope, scopes)) throw new Error('Microsoft didn’t give Lumen every permission it asked for. Press Connect again and accept everything it asks (a school account may need its administrator to allow it).');
      save({ clientId: c.clientId, refresh: t.refresh, email, scope: scope || old?.scope });
      session.invalidate();
      return { email, scope };
    } finally {
      if (flow === mine) flow = null;
      if (!mine.userCancelled) { try { focusApp(); } catch { /* the window stays where it is */ } }
    }
  }

  return {
    signIn,
    access: (opts) => session.access(opts),
    invalidate: () => session.invalidate(),
    has: (scopes) => { const c = creds(); return Boolean(c?.refresh) && covers(c.scope, scopes); },
    status: () => { const c = creds(); return { connected: Boolean(c?.refresh), email: c?.email || '', scope: c?.scope || '', clientId: c?.clientId || '' }; },
    async revoke() { flow?.cancel(); save(null); session.invalidate(); return true; },
    cancel: () => { if (flow) { flow.userCancelled = true; flow.cancel(); } },
  };
}

module.exports = { create, ENDPOINTS, IDENTITY, covers };
