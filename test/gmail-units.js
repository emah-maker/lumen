// The Gmail widget and the OAuth helper it is built on (run from test/units.js): PKCE, the consent URL,
// the token form and answers, the loopback redirect listener (a real listener on 127.0.0.1, no window,
// no browser), the refresh session (401 / revoked grant / rate limit), the stored credentials, the
// message-list view (headers, encoded words, snippets), and the connector end to end against a fake
// Google (no network). Nothing here opens a window or signs in to anything.
const crypto = require('crypto');
const http = require('http');
const OA = require('../features/oauth');
const GV = require('../features/gmail-view');
const GC = require('../features/google-client');
const { createWidgets } = require('../features/widgets');

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
});

module.exports = async function gmailUnits(check) {
  // ---- PKCE, the consent URL, the token form ----
  const p = OA.pkce();
  check('oauth: the PKCE challenge is the SHA-256 of the verifier, base64url', p.challenge === crypto.createHash('sha256').update(p.verifier).digest('base64url') && p.verifier.length >= 43 && p.verifier.length <= 128 && !/[+/=]/.test(p.challenge), p.challenge);
  check('oauth: state is random per call', /^[0-9a-f]{32}$/.test(p.state) && OA.pkce().state !== p.state, p.state);
  const url = new URL(OA.authorizeUrl('https://accounts.google.com/o/oauth2/v2/auth', { clientId: 'cid', redirectUri: 'http://127.0.0.1:5555/callback', scope: GV.SCOPE, challenge: 'ch', state: 'st', extra: GV.AUTH_EXTRA }));
  check('oauth: the consent URL asks for a code with S256 PKCE, the loopback redirect, offline access and only the read-only Gmail scope',
    url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256' && url.searchParams.get('redirect_uri') === 'http://127.0.0.1:5555/callback'
    && url.searchParams.get('access_type') === 'offline' && url.searchParams.get('scope') === 'https://www.googleapis.com/auth/gmail.readonly' && url.searchParams.get('state') === 'st', url.href);
  const code = new URLSearchParams(OA.tokenForm('code', { clientId: 'cid', clientSecret: 'sec', code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' }));
  check('oauth: the code exchange sends the verifier and the client secret', code.get('grant_type') === 'authorization_code' && code.get('code_verifier') === 'v' && code.get('client_secret') === 'sec' && code.get('client_id') === 'cid', code.toString());
  const refr = new URLSearchParams(OA.tokenForm('refresh', { clientId: 'cid', refresh: 'rt' }));
  check('oauth: a refresh sends the refresh token, and no secret when there is none', refr.get('grant_type') === 'refresh_token' && refr.get('refresh_token') === 'rt' && !refr.has('client_secret'), refr.toString());

  // ---- token answers ----
  const t = OA.parseToken(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3599 }), 1000);
  check('oauth: a token answer gives the access and refresh tokens and an expiry a little early', t.access === 'at' && t.refresh === 'rt' && t.exp === 1000 + (3599 - 30) * 1000, JSON.stringify(t));
  check('oauth: a refresh answer without a new refresh token keeps the old one', OA.parseToken(JSON.stringify({ access_token: 'a2', expires_in: 100 }), 0, 'old').refresh === 'old', '');
  let threw = 0;
  for (const bad of ['', 'nope', '{}', JSON.stringify({ access_token: 'x' }), JSON.stringify({ access_token: 'a'.repeat(5000), refresh_token: 'r' })]) try { OA.parseToken(bad, 0); } catch { threw++; }
  check('oauth: garbage, a missing refresh token and oversized tokens are refused', threw === 5, String(threw));
  check('oauth: invalid_grant is a revoked grant, invalid_client a bad client, 429 a rate limit with its wait, 500 a server problem',
    OA.classifyTokenFailure(400, '{"error":"invalid_grant"}').kind === 'revoked' && OA.classifyTokenFailure(401, '{"error":"invalid_client"}').kind === 'client'
    && OA.classifyTokenFailure(429, '', '7').retryAfter === 7000 && OA.classifyTokenFailure(429, '', undefined).retryAfter === 60e3 && OA.classifyTokenFailure(503, '').kind === 'server'
    && OA.classifyTokenFailure(429, '', '99999').retryAfter === 120e3, '');
  const blob = OA.encodeCreds({ clientId: 'a', clientSecret: 'b', refresh: 'c', extra: 'nope' });
  check('oauth: stored credentials round-trip, unknown fields are dropped, garbage is null', JSON.stringify(OA.decodeCreds(blob)) === '{"clientId":"a","clientSecret":"b","refresh":"c"}' && OA.decodeCreds('x') === null && OA.decodeCreds('') === null && OA.decodeCreds('[1]').refresh === '' && OA.encodeCreds({ clientId: 'a', refresh: '' }) === '{"clientId":"a"}', blob);

  // ---- the loopback listener: a real one on 127.0.0.1 ----
  let lb = await OA.startLoopback({ state: 'good-state' });
  check('oauth loopback: listens on 127.0.0.1 at a port the OS picked', /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(lb.redirectUri) && lb.port > 0, lb.redirectUri);
  let r = await get(`${lb.redirectUri}?code=evil&state=wrong`);
  const other = await get(`http://127.0.0.1:${lb.port}/other?state=good-state&code=x`);
  const rebind = await get(`${lb.redirectUri}?code=x&state=good-state`, { Host: 'evil.example' });
  check('oauth loopback: a wrong state, another path or another Host header is refused and does not end the wait', r.status === 400 && other.status === 404 && rebind.status === 400, `${r.status} ${other.status} ${rebind.status}`);
  r = await get(`${lb.redirectUri}?code=the-code&state=good-state`);
  const got = await lb.wait;
  check('oauth loopback: the right state delivers the code and shows a page to close', got.code === 'the-code' && r.status === 200 && /close this tab/i.test(r.body), r.body);
  const closed = await get(`${lb.redirectUri}?code=again&state=good-state`).then(() => 'open', () => 'closed');
  check('oauth loopback: it stops listening after the redirect', closed === 'closed', closed);
  lb = await OA.startLoopback({ state: 's2' });
  await get(`${lb.redirectUri}?error=access_denied&state=s2`);
  check('oauth loopback: the user saying no rejects with a cancelled sign-in', await lb.wait.then(() => false, (e) => e.kind === 'cancelled' && /cancelled/.test(e.message)), '');
  lb = await OA.startLoopback({ state: 's3', timeoutMs: 40 });
  check('oauth loopback: it gives up after the time limit', await lb.wait.then(() => false, (e) => e.kind === 'timeout'), '');
  lb = await OA.startLoopback({ state: 's4' });
  lb.close();
  check('oauth loopback: cancelling rejects and frees the port', await lb.wait.then(() => false, (e) => e.kind === 'cancelled') && await get(lb.redirectUri).then(() => false, () => true), '');
  check('oauth loopback: pages escape what they show', !OA.resultPage('<b>x</b>', '"><script>').includes('<script>'), '');

  // ---- the whole browser round trip, with a fake browser and a fake Google ----
  const posts = [];
  const post = async (u, body) => {
    posts.push({ u, form: new URLSearchParams(body) });
    return { ok: true, status: 200, body: JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }), retryAfter: null };
  };
  let consent = '';
  const flow = await OA.beginSignIn({
    authorizeBase: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'cid', clientSecret: 'sec', scope: GV.SCOPE, extra: GV.AUTH_EXTRA, post,
    openExternal: async (u) => { // the user's browser: approves, and Google redirects to the loopback address
      consent = u;
      const q = new URL(u).searchParams;
      setTimeout(() => { get(`${q.get('redirect_uri')}?code=auth-code&state=${q.get('state')}`).catch(() => {}); }, 5);
    },
  });
  const tokens = await flow.done;
  const sent = posts[0].form;
  check('oauth sign-in: the code is traded with a verifier that matches the challenge in the consent URL',
    tokens.refresh === 'refresh-1' && sent.get('code') === 'auth-code' && crypto.createHash('sha256').update(sent.get('code_verifier')).digest('base64url') === new URL(consent).searchParams.get('code_challenge')
    && sent.get('redirect_uri') === new URL(consent).searchParams.get('redirect_uri') && sent.get('client_secret') === 'sec', JSON.stringify([...sent]));
  const denied = await OA.beginSignIn({
    authorizeBase: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'x', clientId: 'cid', scope: 's', post,
    openExternal: async (u) => { const q = new URL(u).searchParams; setTimeout(() => get(`${q.get('redirect_uri')}?error=access_denied&state=${q.get('state')}`).catch(() => {}), 5); },
  });
  check('oauth sign-in: denying consent ends it without a token request', await denied.done.then(() => false, (e) => /cancelled/.test(e.message)) && posts.length === 1, '');
  const bad = await OA.beginSignIn({
    authorizeBase: 'https://a/', tokenUrl: 'x', clientId: 'cid', scope: 's', post: async () => ({ ok: false, status: 401, body: '{"error":"invalid_client"}' }),
    openExternal: async (u) => { const q = new URL(u).searchParams; setTimeout(() => get(`${q.get('redirect_uri')}?code=c&state=${q.get('state')}`).catch(() => {}), 5); },
  });
  check('oauth sign-in: a client Google does not accept says so', await bad.done.then(() => false, (e) => e.kind === 'client' && /Client ID/.test(e.message)), '');

  // ---- the refresh session ----
  let clock = 1e6;
  let creds = { clientId: 'cid', clientSecret: 'sec', refresh: 'rt-0' };
  let saved = null;
  let calls = 0;
  let answer = () => ({ ok: true, status: 200, body: JSON.stringify({ access_token: `at-${calls}`, expires_in: 3600 }) });
  const sess = OA.createSession({ tokenUrl: () => 'https://oauth2.googleapis.com/token', now: () => clock, load: () => creds, save: (c) => { saved = c; creds = c; }, post: async () => { calls++; await new Promise((res) => setTimeout(res, 5)); return answer(); } });
  const [a1, a2] = await Promise.all([sess.access(), sess.access()]);
  check('oauth session: simultaneous callers share one refresh, and the token is reused until it expires', a1 === a2 && calls === 1 && await sess.access() === a1 && calls === 1, `${calls}`);
  clock += 3600e3;
  check('oauth session: an expired token is refreshed', await sess.access() !== a1 && calls === 2, `${calls}`);
  sess.invalidate();
  check('oauth session: invalidate() (after a 401) forces a new token', await sess.access() && calls === 3, `${calls}`);
  answer = () => ({ ok: true, status: 200, body: JSON.stringify({ access_token: 'x', refresh_token: 'rt-1', expires_in: 60 }) });
  await sess.access({ force: true });
  check('oauth session: a rotated refresh token is stored', saved?.refresh === 'rt-1' && creds.clientId === 'cid', JSON.stringify(saved));
  answer = () => ({ ok: false, status: 400, body: '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}' });
  const revoked = await sess.access({ force: true }).catch((e) => e);
  check('oauth session: a revoked grant clears the refresh token (keeping the client) and asks to reconnect, then stops asking Google',
    revoked.reconnect === true && creds.refresh === '' && creds.clientId === 'cid' && !sess.connected() && await sess.access({ force: true }).then(() => false, (e) => e.reconnect) && calls === 5, `${creds.refresh} ${calls}`);
  creds = { clientId: 'cid', clientSecret: 'sec', refresh: 'rt-2' };
  answer = () => ({ ok: false, status: 429, body: '', retryAfter: '30' });
  const rate = await sess.access({ force: true }).catch((e) => e);
  check('oauth session: a rate limit is not a revoked grant and says how long to wait', rate.kind === 'rate' && rate.retryAfter === 30e3 && !rate.reconnect && creds.refresh === 'rt-2', `${rate.kind} ${rate.retryAfter}`);
  answer = () => ({ ok: false, status: 503, body: '' });
  check('oauth session: a server error keeps the grant', (await sess.access({ force: true }).catch((e) => e)).kind === 'server' && creds.refresh === 'rt-2', '');

  // ---- gmail-view: settings ----
  check('gmail: a Client ID must look like Google\'s', GV.cleanClientId(' 123456-abc_def.apps.googleusercontent.com ') === '123456-abc_def.apps.googleusercontent.com' && !GV.cleanClientId('abc') && !GV.cleanClientId('123.apps.googleusercontent.com.evil.com') && !GV.cleanClientId(5), '');
  check('gmail: a client secret is a plain token', GV.cleanClientSecret('GOCSPX-abc_DEF-123456') === 'GOCSPX-abc_DEF-123456' && !GV.cleanClientSecret('has space here') && !GV.cleanClientSecret('short') && !GV.cleanClientSecret(null), '');
  check('gmail: config refuses a Client ID that is not one (none means the built-in client), clamps the count and defaults the rest', GV.cleanConfig({ clientId: 'nope' }) === null && GV.cleanConfig({}).clientId === '' && GV.cleanConfig({ clientId: '1-a.apps.googleusercontent.com', count: 99 }).count === 5 && GV.cleanConfig({ clientId: '1-a.apps.googleusercontent.com', count: 7 }).count === 7 && GV.cleanConfig({ clientId: '1-a.apps.googleusercontent.com', snippets: false }).snippets === false, '');
  check('gmail: the config never carries a secret or token', !JSON.stringify(GV.cleanConfig({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-zzzzzzzz', refresh: 'rt', token: 't' })).match(/GOCSPX|rt|"t"/), '');

  // ---- gmail-view: header text ----
  check('gmail: RFC 2047 words decode (base64 and quoted-printable, several words, other charsets)', GV.decodeWords('=?UTF-8?B?SGVsbG8g4pyTIHdvcmxk?=') === 'Hello ✓ world' && GV.decodeWords('=?utf-8?Q?Caf=C3=A9_menu?=') === 'Café menu'
    && GV.decodeWords('=?UTF-8?B?SGVs?= =?UTF-8?B?bG8=?=') === 'Hello' && GV.decodeWords('=?iso-8859-1?Q?Andr=E9?=') === 'André' && GV.decodeWords('plain =?bogus?X?zz?= text') === 'plain =?bogus?X?zz?= text', GV.decodeWords('=?utf-8?Q?Caf=C3=A9_menu?='));
  check('gmail: snippet entities decode, unknown ones stay', GV.decodeEntities('Tom &amp; Jerry &#39;s &quot;x&quot; &lt;b&gt; &#x1F600; &bogus; &#0;') === 'Tom & Jerry \'s "x" <b> 😀 &bogus; &#0;', GV.decodeEntities('Tom &amp; &#x1F600; &#0;'));
  const senders = [['Ada Lovelace <ada@example.com>', 'Ada Lovelace', 'ada@example.com'], ['"Lovelace, Ada" <ada@x.org>', 'Lovelace, Ada', 'ada@x.org'], ['ada@x.org', 'ada@x.org', 'ada@x.org'], ['<ada@x.org>', 'ada@x.org', 'ada@x.org'], ['=?UTF-8?B?w4lsb2lzZQ==?= <e@x.fr>', 'Éloise', 'e@x.fr'], ['', '', ''], ['no address here', '', '']];
  check('gmail: senders split into a name and an address', senders.every(([raw, name, address]) => { const s = GV.parseSender(raw); return s.name === name && s.address === address; }), JSON.stringify(senders.map(([raw]) => GV.parseSender(raw))));

  // ---- gmail-view: messages ----
  const msg = (id, extra = {}) => ({ id, snippet: 'Lunch &amp; a call &#39;tomorrow&#39;', internalDate: '1700000000000', labelIds: ['INBOX', 'UNREAD'], payload: { headers: [{ name: 'From', value: 'Ada <ada@x.org>' }, { name: 'SUBJECT', value: '=?UTF-8?B?SGVsbG8=?= there' }] }, ...extra });
  const n = GV.normalizeMessage(msg('18c0ffee00112233'));
  check('gmail: a message becomes sender, subject, snippet, time and unread', n.from === 'Ada' && n.address === 'ada@x.org' && n.subject === 'Hello there' && n.snippet === 'Lunch & a call \'tomorrow\'' && n.at === 1700000000000 && n.unread === true, JSON.stringify(n));
  check('gmail: snippets can be left out, a read message is not unread, blanks get placeholders',
    GV.normalizeMessage(msg('abcdef01'), { snippets: false }).snippet === '' && GV.normalizeMessage(msg('abcdef01', { labelIds: ['INBOX'] })).unread === false
    && GV.normalizeMessage({ id: 'abcdef01', payload: { headers: [] } }).subject === '(no subject)' && GV.normalizeMessage({ id: 'abcdef01', payload: { headers: [] } }).from === 'Unknown sender', '');
  check('gmail: a message with a bad id, or no object, is dropped', GV.normalizeMessage({ id: '../../x' }) === null && GV.normalizeMessage(null) === null && GV.normalizeMessage({ id: 'ab' }) === null, '');
  check('gmail: markup in a subject stays text and control characters go', GV.normalizeMessage(msg('abcdef01', { payload: { headers: [{ name: 'Subject', value: '<img src=x onerror=alert(1)>\u0000\n\tHi' }] } })).subject === '<img src=x onerror=alert(1)> Hi', '');
  const longMessage = GV.normalizeMessage(msg('abcdef01', { snippet: 'x'.repeat(5000), payload: { headers: [{ name: 'Subject', value: 'y'.repeat(5000) }] } }));
  check('gmail: long subjects and snippets are cut', longMessage.subject.length <= 200 && longMessage.snippet.length <= 160, '');
  const cfg = GV.cleanConfig({ clientId: '1-a.apps.googleusercontent.com', count: 3 });
  const shaped = GV.shape({ messagesUnread: 12, messagesTotal: 400 }, [msg('aaaaaa01'), null, msg('aaaaaa02'), { id: 'zz' }, msg('aaaaaa03'), msg('aaaaaa04')], cfg);
  check('gmail: the card data has the unread count and at most N valid messages', shaped.unread === 12 && shaped.total === 400 && shaped.messages.length === 3 && shaped.state === 'ok' && /^https:\/\/mail\.google\.com\//.test(shaped.open), JSON.stringify(shaped).slice(0, 200));
  check('gmail: a garbage label answer counts as zero', GV.shape({ messagesUnread: 'lots' }, [], cfg).unread === 0 && GV.shape(null, [], cfg).messages.length === 0, '');
  check('gmail: list answers give only valid ids, at most N', JSON.stringify(GV.messageIds({ messages: [{ id: 'abcdef01' }, { id: '../x' }, {}, null, { id: 'abcdef02' }, { id: 'abcdef03' }] }, 2)) === '["abcdef01","abcdef02"]' && GV.messageIds(null, 3).length === 0, '');
  check('gmail: requests are read-only GETs for the inbox label with a field mask', GV.labelPath().startsWith('/users/me/labels/INBOX?') && GV.listPath(5).includes('labelIds=INBOX') && GV.listPath(5).includes('maxResults=5') && GV.messagePath('abcdef01').includes('format=metadata') && GV.messagePath('a/b').includes('a%2Fb'), GV.messagePath('abcdef01'));
  check('gmail: API errors are explained without echoing the body',
    GV.apiError(401, '').reconnect === true && GV.apiError(429, '').rate === true && GV.apiError(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}').rate === true
    && /not turned on/.test(GV.apiError(403, '{"error":{"errors":[{"reason":"accessNotConfigured"}]}}').message) && GV.apiError(403, '{}').reconnect === true && GV.apiError(500, 'secret-body-text').message.includes('secret-body-text') === false, '');

  // ---- the connector, end to end against a fake Google ----
  await connectorRuns(check);
  // ---- Lumen's built-in Google client: one-click sign-in ----
  await builtinRuns(check);
};

// The built-in client (features/google-client.js): where it comes from, that a user's own client wins,
// what Settings and the card are told, and the one-click sign-in end to end against a fake Google.
async function builtinRuns(check) {
  const BUILT = { clientId: '777-lumenbuiltin.apps.googleusercontent.com', clientSecret: 'GOCSPX-builtin-secret' };
  const OWN = '4242-ownclient.apps.googleusercontent.com';
  const env = (id, secret) => ({ LUMEN_GOOGLE_CLIENT_ID: id, LUMEN_GOOGLE_CLIENT_SECRET: secret });
  check('google client: the environment\'s pair beats the build file\'s, and a half pair or garbage is no client',
    JSON.stringify(GC.builtinClient({ env: env(BUILT.clientId, BUILT.clientSecret), file: { clientId: OWN, clientSecret: 'GOCSPX-file-secret' } })) === JSON.stringify(BUILT)
    && GC.builtinClient({ env: {}, file: BUILT }).clientId === BUILT.clientId
    && GC.builtinClient({ env: env(BUILT.clientId, ''), file: {} }) === null
    && GC.builtinClient({ env: env('nope', BUILT.clientSecret), file: {} }) === null
    && GC.builtinClient({ env: {}, file: {} }) === null, '');
  check('google client: an id from the environment is never paired with the file\'s secret',
    GC.builtinClient({ env: env(OWN, ''), file: BUILT }).clientId === BUILT.clientId && GC.builtinClient({ env: env(OWN, ''), file: BUILT }).clientSecret === BUILT.clientSecret, '');
  const noOwn = GC.resolveClient({ clientId: '', clientSecret: '', stored: null, builtin: BUILT });
  check('google client: with no own client the built-in one signs in', noOwn.source === 'builtin' && noOwn.clientId === BUILT.clientId && noOwn.clientSecret === BUILT.clientSecret, JSON.stringify(noOwn));
  const typedOwn = GC.resolveClient({ clientId: OWN, clientSecret: 'GOCSPX-own-secret', builtin: BUILT });
  const storedOwn = GC.resolveClient({ clientId: OWN, stored: { clientId: OWN, clientSecret: 'GOCSPX-own-stored' }, builtin: BUILT });
  check('google client: an own client (typed, or its saved id with the stored secret) is preferred over the built-in one',
    typedOwn.source === 'own' && typedOwn.clientId === OWN && typedOwn.clientSecret === 'GOCSPX-own-secret' && storedOwn.source === 'own' && storedOwn.clientSecret === 'GOCSPX-own-stored', JSON.stringify([typedOwn, storedOwn]));
  check('google client: an own id without its secret, or a bad id, is an error and never falls back to the built-in client',
    GC.resolveClient({ clientId: OWN, builtin: BUILT }).error === 'noSecret' && GC.resolveClient({ clientId: 'junk', builtin: BUILT }).error === 'badId'
    && GC.resolveClient({ clientId: OWN, clientSecret: 'x y', builtin: BUILT }).error === 'badSecret' && GC.resolveClient({ builtin: null }).error === 'noClient', '');
  check('google client: the UI says one-click only when a client is ready (built-in, or own with its secret stored)',
    GC.uiState({ builtin: BUILT }).oneClick === true && GC.uiState({ builtin: BUILT }).builtin === true && GC.uiState({ builtin: null }).oneClick === false && GC.uiState({ builtin: null }).builtin === false
    && GC.uiState({ clientId: OWN, stored: { clientId: OWN, clientSecret: 'GOCSPX-own-stored' }, builtin: null }).oneClick === true && GC.uiState({ clientId: OWN, stored: null, builtin: BUILT }).oneClick === false, '');

  // End to end: a Gmail widget with no Client ID of its own, and no sign-in yet.
  const hits = [];
  const fetchFake = async (url, opts = {}) => {
    const u = new URL(url);
    hits.push(`${opts.method || 'GET'} ${u.host}${u.pathname}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const form = new URLSearchParams(String(opts.body || ''));
      hits.push(`client=${form.get('client_id')} secret=${form.get('client_secret')}`);
      return json(200, { access_token: 'ACCESS-B', expires_in: 3600, ...(form.get('grant_type') === 'authorization_code' ? { refresh_token: 'REFRESH-B' } : {}) });
    }
    if (u.host === 'oauth2.googleapis.com') return json(200, {});
    if (u.pathname.endsWith('/labels/INBOX')) return json(200, { messagesUnread: 1, messagesTotal: 1 });
    if (u.pathname.endsWith('/messages')) return json(200, { messages: [] });
    return json(404, {});
  };
  let settings = { homeWidgets: [{ id: 'wgmailb1', type: 'gmail', count: 3 }] };
  const secrets = {};
  let opened = [];
  let configured;
  const make = (builtin) => createWidgets({
    readSettings: () => settings, writeSettings: (s) => { settings = s; }, fetch: fetchFake,
    getSecret: (n) => secrets[n] || null, setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; },
    onUpdate: () => {}, onConfigure: (id) => { configured = id; }, rateMax: () => 1000, signInMs: 2000, googleClient: () => builtin,
    openExternal: async (u) => { opened.push(u); const q = new URL(u).searchParams; setTimeout(() => http.get(`${q.get('redirect_uri')}?code=CODE&state=${q.get('state')}`).on('error', () => {}), 5); },
  });
  const shown = async (w) => { w.flush(); await w.refresh(w.list()[0], { force: true }); return w.forPage()[0]; };

  const without = make(null);
  let page = await shown(without);
  check('gmail built-in: without a built-in client the card offers Settings, not one-click, and Settings shows the paste flow',
    page.data?.state === 'reconnect' && page.data.oneClick === false && without.state().gmailClient.builtin === false, JSON.stringify(page.data));
  check('gmail built-in: without a built-in client, Sign in still asks for a Client ID', await without.gmailConnect({ clientId: '' }).then(() => false, (e) => /Client ID/.test(e.message)), '');
  configured = null;
  await without.act(without.actionFrom('file:///lumen/newtab.html?widget=wgmailb1&do=signin'));
  check('gmail built-in: the card\'s sign-in without a ready client opens Settings at the widget instead', configured === 'wgmailb1' && opened.length === 0, String(configured));

  const w = make(BUILT);
  page = await shown(w);
  check('gmail built-in: with a built-in client the card offers one-click sign-in and Settings leads with Sign in with Google',
    page.data?.state === 'reconnect' && page.data.oneClick === true && w.state().gmailClient.builtin === true && !JSON.stringify(w.state()).includes(BUILT.clientSecret), JSON.stringify(page.data));
  const action = w.actionFrom('file:///lumen/newtab.html?widget=wgmailb1&do=signin');
  check('gmail built-in: do=signin is a page action like the others', action && !action.invalid && action.do === 'signin', JSON.stringify(action));
  opened = [];
  await w.act(action);
  const waiting = w.forPage()[0].data?.message || '';
  for (let i = 0; i < 100 && !opened.length; i++) await new Promise((res) => setTimeout(res, 10)); // the listener starts before the browser opens
  check('gmail built-in: the card\'s click shows a waiting line and opens Google\'s consent page with the built-in client',
    /waiting/i.test(waiting) && opened.length === 1 && new URL(opened[0]).searchParams.get('client_id') === BUILT.clientId && new URL(opened[0]).searchParams.get('scope') === GV.SCOPE, opened[0]);
  for (let i = 0; i < 100 && !OA.decodeCreds(secrets.gmail || '')?.refresh; i++) await new Promise((res) => setTimeout(res, 20));
  const stored = OA.decodeCreds(secrets.gmail || '');
  check('gmail built-in: after consent the sign-in is stored encrypted with the built-in client, and the code was traded with its secret',
    stored?.refresh === 'REFRESH-B' && stored.clientId === BUILT.clientId && hits.includes(`client=${BUILT.clientId} secret=${BUILT.clientSecret}`), JSON.stringify(stored));
  page = await shown(w);
  check('gmail built-in: the card then shows the inbox, and neither settings.json nor the page carries the built-in secret or a token',
    page.data?.state === 'ok' && !/GOCSPX|REFRESH-B|ACCESS-B/.test(JSON.stringify(settings) + JSON.stringify(w.forPage())), JSON.stringify(page.data).slice(0, 120));
  const saved = await w.save({ type: 'gmail', clientId: '', count: 4 });
  check('gmail built-in: Save with no Client ID keeps the built-in sign-in and writes no Client ID', saved.widget.clientId === '' && OA.decodeCreds(secrets.gmail).refresh === 'REFRESH-B', JSON.stringify(saved.widget));
  opened = [];
  await w.act(action);
  check('gmail built-in: once connected, the card\'s sign-in does nothing', opened.length === 0, '');

  opened = [];
  const own = await w.gmailConnect({ clientId: OWN, clientSecret: 'GOCSPX-own-secret' }).catch((e) => e);
  check('gmail built-in: a pasted own client is used instead of the built-in one', own.message === 'Gmail is connected.' && new URL(opened[0]).searchParams.get('client_id') === OWN && OA.decodeCreds(secrets.gmail).clientId === OWN, String(own.message || own));
}

// A fake Google: token endpoint + Gmail API. `state` says what each part answers.
async function connectorRuns(check) {
  const CLIENT = '4242-abcdef.apps.googleusercontent.com';
  const secrets = { gmail: OA.encodeCreds({ clientId: CLIENT, clientSecret: 'GOCSPX-secret-value', refresh: 'REFRESH-TOKEN-1' }) };
  const written = []; // every settings.json write, to look for tokens in it
  let settings = { homeWidgets: [{ id: 'wgmail1', type: 'gmail', clientId: CLIENT, count: 3 }] };
  const server = { tokenStatus: 200, tokenError: '', gmail401Once: false, gmailStatus: 200, gmailBody: '', hits: [], tokens: 0 };
  const inbox = [['aaaaaa01', 'Ada <ada@x.org>', 'First', true], ['aaaaaa02', 'Bo <bo@x.org>', '=?UTF-8?B?U2Vjb25k?=', false], ['aaaaaa03', 'Cy <cy@x.org>', 'Third', true], ['aaaaaa04', 'Di <di@x.org>', 'Fourth', false]];
  const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetchFake = async (url, opts = {}) => {
    const u = new URL(url);
    server.hits.push(`${opts.method || 'GET'} ${u.host}${u.pathname}`);
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      server.tokens++;
      if (server.tokenStatus !== 200) return json(server.tokenStatus, server.tokenError || '{"error":"invalid_grant"}', server.tokenStatus === 429 ? { 'Retry-After': '30' } : {});
      const fromCode = new URLSearchParams(String(opts.body || '')).get('grant_type') === 'authorization_code';
      return json(200, { access_token: `ACCESS-TOKEN-${server.tokens}`, expires_in: 3600, ...(fromCode ? { refresh_token: 'REFRESH-FROM-CODE' } : {}) });
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') return json(200, '{}');
    if (u.host !== 'gmail.googleapis.com') return json(404, '{}');
    if (server.gmail401Once) { server.gmail401Once = false; return json(401, '{"error":{"status":"UNAUTHENTICATED"}}'); }
    if (server.gmailStatus !== 200) return json(server.gmailStatus, server.gmailBody || '{}', server.gmailStatus === 429 ? { 'Retry-After': '20' } : {});
    if (!/^Bearer ACCESS-TOKEN-\d+$/.test(opts.headers?.Authorization || '')) return json(401, '{}');
    if (u.pathname.endsWith('/labels/INBOX')) return json(200, { messagesUnread: 2, messagesTotal: 4 });
    if (u.pathname.endsWith('/messages')) return json(200, { messages: inbox.slice(0, Number(u.searchParams.get('maxResults'))).map(([id]) => ({ id })) });
    const found = inbox.find(([id]) => u.pathname.endsWith(`/messages/${id}`));
    if (!found) return json(404, '{}');
    return json(200, { id: found[0], snippet: `Preview of ${found[2]}`, internalDate: '1700000000000', labelIds: found[3] ? ['INBOX', 'UNREAD'] : ['INBOX'], payload: { headers: [{ name: 'From', value: found[1] }, { name: 'Subject', value: found[2] }] } });
  };
  let clockNow = Date.now();
  const w = createWidgets({
    readSettings: () => settings,
    writeSettings: (s) => { settings = s; written.push(JSON.stringify(s)); },
    fetch: fetchFake,
    getSecret: (name) => secrets[name] || null,
    setSecret: (name, value) => { if (value) secrets[name] = value; else delete secrets[name]; },
    onUpdate: () => {}, now: () => clockNow, rateMax: () => 1000, googleClient: () => null, // no built-in client here: the paste flow
  });
  const fresh = () => w.list()[0];
  const shown = async (force = true) => { w.flush(); await w.refresh(fresh(), { force }); return w.forPage()[0]; };

  let page = await shown();
  check('gmail card: unread count and the latest messages reach the page as plain data', page.data.state === 'ok' && page.data.unread === 2 && page.data.messages.length === 3 && page.data.messages[1].subject === 'Second' && page.data.messages[0].from === 'Ada' && page.title === 'Gmail', JSON.stringify(page.data).slice(0, 240));
  const everything = JSON.stringify(w.forPage()) + JSON.stringify(w.state()) + written.join('');
  check('gmail card: no token, refresh token or client secret is in the page data, Settings state or settings.json', !/ACCESS-TOKEN|REFRESH-TOKEN|GOCSPX|secret-value/.test(everything) && w.state().connections.gmail === true, everything.slice(0, 200));
  check('gmail card: it only reads (GET), with one token refresh for the whole fetch', server.hits.filter((h) => h.startsWith('POST gmail')).length === 0 && server.tokens === 1, server.hits.join(' | '));

  server.gmail401Once = true;
  server.tokens = 0;
  clockNow += 1000;
  w.flush();
  const before = server.tokens;
  page = await shown();
  check('gmail card: a 401 gets a fresh token and one more try', page.data?.state === 'ok' && page.data.messages.length === 3 && server.tokens - before >= 1, `${server.tokens - before}`);

  server.tokenStatus = 400;
  clockNow += 4000e3; // the cached access token has expired
  page = await shown();
  const creds = OA.decodeCreds(secrets.gmail);
  check('gmail card: a revoked grant becomes a reconnect state on the card (not an error), and the dead refresh token is gone', page.data?.state === 'reconnect' && /Connect|signed/i.test(page.data.message) && creds.refresh === '' && creds.clientId === CLIENT && w.state().connections.gmail === false, JSON.stringify(page.data));
  const hitsBefore = server.tokens;
  await shown();
  check('gmail card: while disconnected it stops asking Google', server.tokens === hitsBefore, '');

  // A user reconnects (the secret is stored again); the card recovers.
  server.tokenStatus = 200;
  secrets.gmail = OA.encodeCreds({ clientId: CLIENT, clientSecret: 'GOCSPX-secret-value', refresh: 'REFRESH-TOKEN-2' });
  w.state(); // (Settings reads)
  page = await shown();
  check('gmail card: after connecting again it shows the inbox', page.data?.state === 'ok', JSON.stringify(page.data));

  // 429: the widgets' shared backoff, no hammering.
  server.gmailStatus = 429;
  clockNow += 4000e3;
  page = await shown();
  const during = server.hits.length;
  await shown();
  check('gmail card: a 429 shows a friendly error and backs off instead of retrying at once', /slow down|busy/i.test(page.error || page.warning || '') && server.hits.length === during, `${page.error} ${page.warning} ${server.hits.length - during}`);
  server.gmailStatus = 200;
  clockNow += 200e3; // past the backoff

  // Settings' Check (resolve) and Save, against the same fake.
  const input = { type: 'gmail', clientId: CLIENT, count: 3 };
  const checked = await w.test(input);
  check('gmail settings: Check connects with the stored sign-in and counts unread messages', checked.ok === true && /2 unread/.test(checked.message), JSON.stringify(checked));
  check('gmail settings: Check needs a valid Client ID', (await w.test({ type: 'gmail', clientId: 'nope' })).ok === false && /Client ID/.test((await w.test({ type: 'gmail', clientId: 'nope' })).message), '');
  check('gmail settings: a different Client ID needs its own sign-in (the old refresh token is not reused)', /Connect your Google account first|client secret/i.test((await w.test({ type: 'gmail', clientId: '999-other.apps.googleusercontent.com', clientSecret: 'GOCSPX-other-secret' })).message), '');
  check('gmail settings: a client secret that is not one is refused', /client secret/i.test((await w.test({ type: 'gmail', clientId: CLIENT, clientSecret: 'x y' })).message), '');
  const added = await w.save({ type: 'gmail', clientId: CLIENT, count: 5, snippets: false });
  const listed = w.list().find((x) => x.id === added.widget.id);
  check('gmail settings: Save keeps the count and snippets choice and the sign-in, with the default size (4 wide, capped to the 3-column side area)', listed.count === 5 && listed.snippets === false && listed.w === 3 && listed.h === 4 && OA.decodeCreds(secrets.gmail).refresh === 'REFRESH-TOKEN-2', `${listed.w}x${listed.h}`);
  check('gmail settings: the widget in settings.json holds the Client ID only', !/GOCSPX|REFRESH-TOKEN|ACCESS-TOKEN|clientSecret/.test(JSON.stringify(settings)), JSON.stringify(settings).slice(0, 200));

  // Disconnect and removal.
  server.hits.length = 0;
  await w.gmailDisconnect();
  check('gmail settings: Disconnect asks Google to revoke, forgets the refresh token and keeps the client for a quick reconnect', server.hits.some((h) => h.endsWith('/revoke')) && OA.decodeCreds(secrets.gmail).refresh === '' && OA.decodeCreds(secrets.gmail).clientId === CLIENT && w.state().connections.gmail === false, server.hits.join(','));
  for (const x of w.list()) w.remove(x.id);
  check('gmail settings: removing the last Gmail widget deletes the stored client and sign-in', !('gmail' in secrets), Object.keys(secrets).join(','));

  // Connecting refuses what it cannot do, and never opens a page it was not asked to.
  check('gmail connect: it needs a Client ID and a client secret first', await w.gmailConnect({ clientId: '' }).then(() => false, (e) => /Client ID/.test(e.message)) && await w.gmailConnect({ clientId: CLIENT }).then(() => false, (e) => /client secret/i.test(e.message)), '');
  let opened = '';
  const w2 = createWidgets({ readSettings: () => settings, writeSettings: () => {}, fetch: fetchFake, getSecret: (n) => secrets[n] || null, setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; }, onUpdate: () => {}, signInMs: 2000, googleClient: () => null,
    openExternal: async (u) => { opened = u; const q = new URL(u).searchParams; setTimeout(() => http.get(`${q.get('redirect_uri')}?code=CODE&state=${q.get('state')}`).on('error', () => {}), 5); } });
  const connected = await w2.gmailConnect({ clientId: CLIENT, clientSecret: 'GOCSPX-fresh-secret' }).catch((e) => e);
  const consentUrl = opened ? new URL(opened) : null;
  check('gmail connect: it opens Google\'s consent page in the browser (not a Lumen tab) and stores the encrypted-secret blob once the code is traded',
    consentUrl?.host === 'accounts.google.com' && consentUrl.searchParams.get('scope') === GV.SCOPE && consentUrl.searchParams.get('client_id') === CLIENT && consentUrl.searchParams.get('code_challenge_method') === 'S256'
    && connected.message === 'Gmail is connected.' && OA.decodeCreds(secrets.gmail).refresh === 'REFRESH-FROM-CODE' && OA.decodeCreds(secrets.gmail).clientSecret === 'GOCSPX-fresh-secret', String(connected.message || connected));
}
