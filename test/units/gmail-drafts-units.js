// Gmail drafts through the connector, in plain Node (nothing leaves the computer): the message Lumen builds (RFC 2047 subjects, reply
// headers, a header with a line break refused, base64url), the "Allow drafts" sign-in (gmail.compose and include_granted_scopes only
// when asked for, the scopes Google says the token has kept and checked before any draft), the one request a draft makes (POST
// /users/me/drafts, never a send: the code is searched for it too), what a missing permission or an ended sign-in says, the card
// (To, Cc, Subject and Text editable, "Nothing is sent" fixed), and the agent's gate (a card even with Bypass on, background refused).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const OA = require('../../src/features/oauth');
const GV = require('../../src/features/gmail-view');
const GD = require('../../src/features/gmail-drafts');
const { createWidgets } = require('../../src/features/widgets');
const registry = require('../../src/features/connectors/registry');
const service = require('../../src/features/connectors/service');
const agentLib = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const fails = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message || String(e); } };
const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() };
const unRaw = (raw) => Buffer.from(raw, 'base64url').toString('utf8');
const bodyOf = (msg) => Buffer.from(msg.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';

async function mime() {
  console.log('--- the message');
  const msg = GD.buildMessage({ to: 'Zoë Ng <zoe@example.org>, bo@example.com', cc: '"Prof. Lee" <lee@school.edu>', subject: 'Résumé für Prüfung 📎 — a long subject that needs more than one encoded word to fit', body: 'Hi Zoë,\nsee you.\n\n— Ada' });
  const head = msg.split('\r\n\r\n')[0];
  check('headers end in CRLF, then a blank line, then the base64 text', /\r\n\r\n/.test(msg) && !/[^\r]\n/.test(msg), JSON.stringify(msg.slice(0, 300)));
  const subj = /^Subject: ([\s\S]*?)\r\n(?=[A-Z])/m.exec(head)?.[1] || '';
  const words = subj.split('\r\n ');
  check('a non-ASCII subject is RFC 2047 encoded words, each at most 75 characters, folded, and decodes back exactly', words.length > 1 && words.every((x) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(x) && x.length <= 75) && GV.decodeWords(subj.replace(/\r\n /g, ' ')) === 'Résumé für Prüfung 📎 — a long subject that needs more than one encoded word to fit', subj);
  check('a plain ASCII subject goes as it is', /\r\nSubject: Hello there\r\n/.test(GD.buildMessage({ to: 'a@x.org', subject: 'Hello there', body: 'x' })), '');
  check('To and Cc: an ASCII name is quoted, a non-ASCII one encoded; plain addresses stay plain', /^To: =\?UTF-8\?B\?[^?]+\?= <zoe@example\.org>,\r\n bo@example\.com$/m.test(head) && /^Cc: "Prof\. Lee" <lee@school\.edu>$/m.test(head), head);
  check('the text is UTF-8 plain text in base64, with CRLF line ends', /Content-Type: text\/plain; charset="UTF-8"/.test(head) && /Content-Transfer-Encoding: base64/.test(head) && /MIME-Version: 1\.0/.test(head) && bodyOf(msg) === 'Hi Zoë,\r\nsee you.\r\n\r\n— Ada', JSON.stringify(bodyOf(msg)));
  check('no From, Bcc or Date of its own: Gmail fills in the sender', !/^(From|Bcc|Date):/mi.test(head), head);
  const reply = GD.buildMessage({ to: 'a@x.org', subject: 'Re: Grades', body: 'Thanks', inReplyTo: '<m2@mail.x.org>', references: '<m0@x.org>\r\n <m1@x.org>' });
  check('a reply carries In-Reply-To (the Message-ID) and References (the earlier ones, then it)', /\r\nIn-Reply-To: <m2@mail\.x\.org>\r\n/.test(reply) && /\r\nReferences: <m0@x\.org>\r\n <m1@x\.org>\r\n <m2@mail\.x\.org>\r\n/.test(reply), reply.split('\r\n\r\n')[0]);
  const long = Array.from({ length: 30 }, (_, i) => `<${i}.${'x'.repeat(60)}@mail.example.org>`).join(' ');
  const folded = GD.buildMessage({ to: 'a@x.org', subject: 'Re: x', body: 'x', inReplyTo: '<last@example.org>', references: long });
  const refLines = /\r\nReferences: ([\s\S]*?)\r\n(?=[A-Z])/.exec(folded)[1].split('\r\n ');
  check('a long References keeps 10 ids (the thread’s first, its last eight, the message replied to), folded one per line, every line under 998', refLines.length === 10 && refLines[0].startsWith('<0.') && refLines[8].startsWith('<29.') && refLines[9] === '<last@example.org>' && folded.split('\r\n').every((l) => l.length < 998), JSON.stringify(refLines.map((l) => l.slice(0, 6))));
  check('a Message-ID with characters outside printable ASCII gives no reply headers, and such References entries are dropped', GD.replyHeaders('<ä@x.org>', '') === null && GD.replyHeaders('<a@x.org>', '<ü@x.org> <ok@x.org>').references === '<ok@x.org>\r\n <a@x.org>', JSON.stringify(GD.replyHeaders('<a@x.org>', '<ü@x.org> <ok@x.org>')));
  check('a Message-ID that isn’t <…> gives no reply headers', GD.replyHeaders('m2@x.org', '') === null && GD.replyHeaders('<a b>', '') === null && GD.replyHeaders('<a\u0000b>', '') === null, '');
  const inject = {
    subject: await fails(() => GD.buildMessage({ to: 'a@x.org', subject: 'Hi\r\nBcc: evil@x.org', body: 'x' })),
    subjectLf: await fails(() => GD.buildMessage({ to: 'a@x.org', subject: 'Hi\nBcc: evil@x.org', body: 'x' })),
    to: await fails(() => GD.buildMessage({ to: 'a@x.org\r\nBcc: evil@x.org', subject: 'Hi', body: 'x' })),
    cc: await fails(() => GD.buildMessage({ to: 'a@x.org', cc: 'Ada <a@x.org>\nBcc: e@x.org', subject: 'Hi', body: 'x' })),
    nul: await fails(() => GD.buildMessage({ to: 'a@x.org', subject: 'Hi\u0000there', body: 'x' })),
  };
  check('a line break (CR, LF or both) or a control character in any header field is refused', /line break/.test(inject.subject) && /line break/.test(inject.subjectLf) && /line break/.test(inject.to) && /line break/.test(inject.cc) && /character/.test(inject.nul), JSON.stringify(inject));
  check('a line break in the text is fine (it is base64)', !/Bcc/.test(GD.buildMessage({ to: 'a@x.org', subject: 'x', body: 'one\r\nBcc: evil@x.org' }).split('\r\n\r\n')[0]), '');
  const bad = { addr: await fails(() => GD.buildMessage({ to: 'not-an-address', subject: 'x', body: 'x' })), empty: await fails(() => GD.buildMessage({ to: ' , ', subject: 'x', body: 'x' })), name: await fails(() => GD.buildMessage({ to: 'A"B <a@x.org>', subject: 'x', body: 'x' })), many: await fails(() => GD.buildMessage({ to: Array.from({ length: 51 }, (_, i) => `u${i}@x.org`).join(','), subject: 'x', body: 'x' })), big: await fails(() => GD.buildMessage({ to: 'a@x.org', subject: 'x', body: 'é'.repeat(150000) })) };
  check('addresses are checked (not one, none, a name with a quote, more than 50), and the text has a size cap', /isn’t an email address/.test(bad.addr) && /at least one/.test(bad.empty) && /can’t be used/.test(bad.name) && /at most 50/.test(bad.many) && /too long/.test(bad.big), JSON.stringify(bad));
  check('the Drafts link names the account with authuser (URL-encoded), and falls back to the first account without one', GD.draftsLink('ada+lab@example.com', '18c0ffee0b') === 'https://mail.google.com/mail/?authuser=ada%2Blab%40example.com#drafts?compose=18c0ffee0b' && GD.draftsLink('ada@example.com') === 'https://mail.google.com/mail/?authuser=ada%40example.com#drafts' && GD.draftsLink('', 'abcdef12') === 'https://mail.google.com/mail/u/0/#drafts?compose=abcdef12' && GD.draftsLink('x#y', 'nope') === 'https://mail.google.com/mail/u/0/#drafts', GD.draftsLink('ada+lab@example.com', '18c0ffee0b'));
  const raw = GD.toRaw(msg);
  check('raw is base64url (no + / =) and decodes back to the message', !/[+/=]/.test(raw) && unRaw(raw) === msg, raw.slice(0, 80));
}

function sendGuards() {
  console.log('--- never send');
  const refused = ['/users/me/drafts/send', '/users/me/messages/send', '/users/me/drafts/abc/send', '/users/me/%73end', '/users/me/drafts/send?x=1', '/users/me/drafts:send', '/users/me/messages', '/users/me/drafts?uploadType=media', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts'];
  const why = refused.map((p) => { try { GD.composePath(p); return 'allowed'; } catch (e) { return e.message; } });
  check('the compose path check refuses every send path and any path but /users/me/drafts', why.every((m) => m !== 'allowed') && why.slice(0, 6).every((m) => /never sends/.test(m)) && GD.composePath('/users/me/drafts') === '/users/me/drafts', JSON.stringify(why));
  const root = path.join(__dirname, '..', '..', 'src', 'features');
  const files = ['connectors/providers/gmail.js', 'gmail-drafts.js'];
  const found = files.filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes('/send'));
  check('the Gmail provider and the drafts module have no "/send" anywhere', found.length === 0, found.join());
  const widgetsSrc = fs.readFileSync(path.join(root, 'widgets.js'), 'utf8');
  const fn = widgetsSrc.slice(widgetsSrc.indexOf('async function gmailCompose('), widgetsSrc.indexOf('return { retryNow,'));
  check('the widgets’ draft request goes through composePath, and has no "/send" or send call', /GD\.composePath\(GD\.DRAFTS_PATH\)/.test(fn) && !/\/send|\.send\(|drafts\.send|messages\.send/.test(fn), fn.slice(0, 200));
}

async function signIn() {
  console.log('--- Allow drafts: the incremental sign-in');
  const plain = GV.signInParams();
  const more = GV.signInParams({ compose: true, email: 'ada@example.com' });
  const url = (p) => new URL(OA.authorizeUrl('https://accounts.google.com/o/oauth2/v2/auth', { clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', scope: p.scope, challenge: 'c', state: 's', extra: p.extra }));
  const u1 = url(plain);
  const u2 = url(more);
  check('the first sign-in asks for gmail.readonly only, with no include_granted_scopes', u1.searchParams.get('scope') === GV.SCOPE && !u1.searchParams.has('include_granted_scopes') && !u1.href.includes('gmail.compose'), u1.href);
  check('Allow drafts asks for gmail.compose with include_granted_scopes=true, offline access and the account’s address as login_hint', u2.searchParams.get('scope').split(' ').includes(COMPOSE) && u2.searchParams.get('scope').split(' ').includes(GV.SCOPE) && u2.searchParams.get('include_granted_scopes') === 'true' && u2.searchParams.get('access_type') === 'offline' && u2.searchParams.get('login_hint') === 'ada@example.com', u2.href);
  check('scope checks: a list holding compose, one without, none', GV.hasScope(`${GV.SCOPE} ${COMPOSE}`, COMPOSE) && !GV.hasScope(GV.SCOPE, COMPOSE) && !GV.hasScope(undefined, COMPOSE) && !GV.hasScope(`${COMPOSE}x`, COMPOSE), '');
  check('a token answer’s scope is kept, and stored with the sign-in', OA.parseToken(JSON.stringify({ access_token: 'a', refresh_token: 'r', scope: `${GV.SCOPE} ${COMPOSE}` }), 0).scope === `${GV.SCOPE} ${COMPOSE}` && OA.decodeCreds(OA.encodeCreds({ clientId: 'c', refresh: 'r', scope: COMPOSE })).scope === COMPOSE, '');

  // The widgets with a fake Google: what the consent page asked for decides the token's scope (unless the user unticks drafts).
  const CLIENT = '4242-abcdef.apps.googleusercontent.com';
  const secrets = {};
  const opened = [];
  const posts = [];
  const google = { untick: false, draftStatus: 200, draftBody: '', refreshScope: '', postFails: null, profile: 'ada@example.com', codes: 0, revoked: [] };
  let clock = Date.now();
  const freshCalls = [];
  let asked = '';
  const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchFake = async (url2, opts = {}) => {
    const u = new URL(url2);
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const form = new URLSearchParams(String(opts.body || ''));
      if (form.get('grant_type') === 'refresh_token') return json(200, { access_token: 'ACCESS-R', expires_in: 3600, ...(google.refreshScope ? { scope: google.refreshScope } : {}) });
      const scope = asked.split(' ').filter((s) => !(google.untick && s === COMPOSE)).join(' ');
      google.codes++;
      return json(200, { access_token: `ACCESS-${google.codes}`, refresh_token: `REFRESH-${google.codes}`, expires_in: 3600, scope });
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') { google.revoked.push(new URLSearchParams(String(opts.body || '')).get('token')); return json(200, '{}'); }
    if (u.host === 'oauth2.googleapis.com') return json(200, '{}');
    if (u.host === 'gmail.googleapis.com' && u.pathname === '/gmail/v1/users/me/profile') return json(200, { emailAddress: google.profile });
    if (u.host === 'gmail.googleapis.com' && (opts.method || 'GET') === 'POST') {
      posts.push({ path: u.pathname, auth: opts.headers?.Authorization, body: JSON.parse(opts.body) });
      if (google.postFails) throw google.postFails;
      if (google.draftStatus !== 200) return json(google.draftStatus, google.draftBody);
      if (google.draftUnreadable) return new Response('<html>ok</html>', { status: 200 });
      return json(200, { id: 'r-123', message: { id: '18c0ffee0a', threadId: '18c0ffee00' } });
    }
    return json(404, '{}');
  };
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [] }), writeSettings: () => {}, fetch: fetchFake,
    getSecret: (n) => secrets[n] || null, setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; },
    freshFetch: async (u, init) => { freshCalls.push(`${init?.method || 'GET'} ${u}`); return fetchFake(u, init); }, // (the widgets' second try through a fresh session)
    onUpdate: () => {}, rateMax: () => 1000, signInMs: 3000, now: () => clock, googleClient: () => ({ clientId: CLIENT, clientSecret: 'GOCSPX-built-in', verified: false }),
    openExternal: async (u) => { opened.push(u); const q = new URL(u).searchParams; asked = q.get('scope'); setTimeout(() => http.get(`${q.get('redirect_uri')}?code=CODE&state=${q.get('state')}`).on('error', () => {}), 5); },
  });
  check('Allow drafts before any sign-in says to sign in first, and opens nothing', /Sign in to Gmail/.test(await fails(() => w.gmailAllowDrafts())) && opened.length === 0, '');
  await w.gmailConnect({});
  const first = new URL(opened[0]);
  check('the widget’s sign-in asks for gmail.readonly only; the token is stored with that scope and can’t make drafts', first.searchParams.get('scope') === GV.SCOPE && !first.searchParams.has('include_granted_scopes') && OA.decodeCreds(secrets.gmail).scope === GV.SCOPE && w.gmailAuthState().compose === false, first.href);
  const noScope = await w.gmailCompose({ message: { raw: 'x' } }).then(() => null, (e) => e);
  check('without compose, a draft is refused before any request ("Allow drafts first")', noScope?.kind === 'scope' && /Allow drafts first/.test(noScope.message) && posts.length === 0, String(noScope));
  google.untick = true;
  const unticked = await fails(() => w.gmailAllowDrafts());
  check('Allow drafts where the user unticks the drafts box: the sign-in stays, drafts stay off, and the message says why', /didn’t give Lumen permission to make drafts/.test(unticked) && w.gmailAuthState().oauth && !w.gmailAuthState().compose, unticked);
  google.untick = false;
  const kept = secrets.gmail;
  google.profile = 'bo@example.com';
  google.revoked.length = 0;
  const switched = await fails(() => w.gmailAllowDrafts());
  check('Allow drafts where the user picks another account: refused with “Choose <address>”, the sign-in Lumen had is kept as it was, and only the new grant is given back', switched === 'Choose ada@example.com to allow drafts for it.' && secrets.gmail === kept && google.revoked.length === 1 && google.revoked[0] === `REFRESH-${google.codes}` && !google.revoked.includes(OA.decodeCreds(kept).refresh), JSON.stringify({ switched, revoked: google.revoked, kept: OA.decodeCreds(kept).refresh }));
  google.profile = 'ada@example.com';
  opened.length = 0;
  await w.gmailAllowDrafts();
  const second = new URL(opened[0]);
  check('Allow drafts opens Google’s consent with the same client, gmail.compose, include_granted_scopes and the account’s address', second.searchParams.get('client_id') === CLIENT && second.searchParams.get('scope').split(' ').includes(COMPOSE) && second.searchParams.get('include_granted_scopes') === 'true' && second.searchParams.get('login_hint') === 'ada@example.com', second.href);
  check('…and the stored sign-in now has compose (from the token answer’s scope)', w.gmailAuthState().compose === true && GV.hasScope(OA.decodeCreds(secrets.gmail).scope, COMPOSE), OA.decodeCreds(secrets.gmail).scope);
  const made = await w.gmailCompose({ message: { raw: 'UmF3', threadId: '18c0ffee00' } });
  check('a draft is one POST to /gmail/v1/users/me/drafts with the token and the message', posts.length === 1 && posts[0].path === '/gmail/v1/users/me/drafts' && /^Bearer ACCESS-/.test(posts[0].auth) && posts[0].body.message.raw === 'UmF3' && made.message.id === '18c0ffee0a', JSON.stringify(posts));
  console.log('--- a draft is never sent twice');
  const failWith = async (err) => { google.postFails = err; const n = posts.length; const e = await w.gmailCompose({ message: { raw: 'x' } }).then(() => null, (x) => x); google.postFails = null; return { e, tries: posts.length - n }; };
  const reset = await failWith(new TypeError('net::ERR_CONNECTION_RESET'));
  check('a connection dropped after sending: one try only (no second try through a fresh session), and “the draft may have been made”', reset.tries === 1 && freshCalls.length === 0 && reset.e?.kind === 'maybe' && /may have been made; check Drafts before trying again/.test(reset.e.message), JSON.stringify({ tries: reset.tries, freshCalls, e: String(reset.e) }));
  const slow = await failWith(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  check('a timeout is ambiguous too: one try, “may have been made”', slow.tries === 1 && slow.e?.kind === 'maybe', String(slow.e));
  const dns = await failWith(new TypeError('net::ERR_NAME_NOT_RESOLVED'));
  const refused = await failWith(new TypeError('net::ERR_CONNECTION_REFUSED'));
  check('a failure before anything reached Google (no such host, connection refused) says no draft was made, still with one try', dns.tries === 1 && dns.e?.kind === 'unreached' && /no draft was made/.test(dns.e.message) && refused.e?.kind === 'unreached' && freshCalls.length === 0, JSON.stringify([String(dns.e), String(refused.e)]));
  const status = async (code, opts = {}) => { google.draftStatus = code; google.draftBody = opts.body || { error: { code } }; google.draftUnreadable = Boolean(opts.unreadable); const e = await w.gmailCompose({ message: { raw: 'x' } }).then(() => null, (x) => x); google.draftStatus = 200; google.draftUnreadable = false; return e; };
  const ambiguous = { s500: await status(500), s503: await status(503), s408: await status(408), s404: await status(404), unreadable: await status(200, { unreadable: true }) };
  check('a 5xx, a 408, an unexpected status and a 2xx whose answer can’t be read are “may have been made” (not “nothing was made”)', Object.values(ambiguous).every((e) => e?.kind === 'maybe' && !e.nothingMade), JSON.stringify(Object.fromEntries(Object.entries(ambiguous).map(([k, e]) => [k, [e?.kind, e?.nothingMade, e?.message]]))));
  const bad400 = await status(400, { body: { error: { code: 400, errors: [{ reason: 'invalidArgument' }] } } });
  check('a 400 certainly made nothing (nothingMade)', bad400?.nothingMade === true && /didn’t accept the draft/.test(bad400.message), String(bad400));
  const n401 = posts.length;
  google.draftStatus = 401;
  const twice401 = await w.gmailCompose({ message: { raw: 'x' } }).then(() => null, (x) => x);
  check('a 401 (Google refused the token, nothing made) is tried once more with a new token, and no more; then it is certain and asks to sign in again', posts.length - n401 === 2 && twice401?.nothingMade === true && twice401.reconnect === true, String(posts.length - n401));
  google.draftStatus = 200;
  const rate = await status(429);
  check('a 429 certainly made nothing', rate?.nothingMade === true && rate.kind === 'rate', String(rate));
  clock += 10 * 60e3; // (past the 429's pause)
  google.draftStatus = 403;
  google.draftBody = { error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } };
  const taken = await w.gmailCompose({ message: { raw: 'x' } }).then(() => null, (e) => e);
  check('403 insufficientPermissions (taken back at Google) is "Allow drafts first", and Settings offers the button again', taken?.kind === 'scope' && w.gmailAuthState().compose === false && w.gmailAuthState().oauth, String(taken));
  google.draftStatus = 200;
  await w.gmailDisconnect();
  check('disconnecting the sign-in forgets its scope too', !OA.decodeCreds(secrets.gmail)?.scope && !w.gmailAuthState().compose, secrets.gmail);

  // The refresh: Google's answer says what the grant covers now.
  let held = { clientId: CLIENT, refresh: 'R', scope: `${GV.SCOPE} ${COMPOSE}` };
  const sess = OA.createSession({ tokenUrl: 'https://oauth2.googleapis.com/token', post: async () => ({ ok: true, status: 200, body: JSON.stringify({ access_token: 'A', expires_in: 3600, scope: GV.SCOPE }) }), load: () => held, save: (c) => { held = c; } });
  await sess.access();
  check('a refresh whose scope list changed updates what is stored (compose taken back)', held.scope === GV.SCOPE && held.refresh === 'R', JSON.stringify(held));

  console.log('--- a refresh that overlaps a new sign-in or a disconnect');
  const race = (answers, during) => {
    const box = { held: { clientId: CLIENT, refresh: 'OLD', scope: GV.SCOPE }, sent: [] };
    const s2 = OA.createSession({ tokenUrl: 'https://oauth2.googleapis.com/token', load: () => box.held, save: (c) => { box.held = c; },
      post: async (_u, form) => { const r = new URLSearchParams(form).get('refresh_token'); box.sent.push(r); if (box.sent.length === 1) during(box); const a = answers[r]; return { ok: a.ok !== false, status: a.status || 200, body: JSON.stringify(a.body) }; } });
    return { box, s2 };
  };
  const ok = (access, scope) => ({ body: { access_token: access, expires_in: 3600, scope } });
  const allow = race({ OLD: ok('A-OLD', GV.SCOPE), NEW: ok('A-NEW', `${GV.SCOPE} ${COMPOSE}`) }, (box) => { box.held = { clientId: CLIENT, refresh: 'NEW', scope: `${GV.SCOPE} ${COMPOSE}`, email: 'ada@example.com' }; });
  const got = await allow.s2.access();
  check('Allow drafts while a refresh was out: the old answer doesn’t overwrite the new sign-in (its token and compose stay), and the token used is the new grant’s', allow.box.held.refresh === 'NEW' && GV.hasScope(allow.box.held.scope, COMPOSE) && got === 'A-NEW' && allow.box.sent.join() === 'OLD,NEW', JSON.stringify({ held: allow.box.held, got, sent: allow.box.sent }));
  const gone = race({ OLD: ok('A-OLD', GV.SCOPE) }, (box) => { box.held = { clientId: CLIENT, refresh: '', email: '' }; });
  const goneErr = await gone.s2.access().then(() => null, (e) => e);
  check('Disconnect while a refresh was out: no token comes back to the store, and the call says to sign in again', !gone.box.held.refresh && goneErr?.reconnect === true, JSON.stringify({ held: gone.box.held, e: String(goneErr) }));
  const dead = race({ OLD: { ok: false, status: 400, body: { error: 'invalid_grant' } }, NEW: ok('A-NEW', `${GV.SCOPE} ${COMPOSE}`) }, (box) => { box.held = { clientId: CLIENT, refresh: 'NEW', scope: `${GV.SCOPE} ${COMPOSE}` }; });
  const afterDead = await dead.s2.access();
  check('the old grant refused while a new sign-in was saved: the new sign-in isn’t wiped', dead.box.held.refresh === 'NEW' && afterDead === 'A-NEW', JSON.stringify(dead.box.held));
}

async function connector() {
  console.log('--- the connector: card, request, errors');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-gmail-drafts-'));
  const g = { compose: false, composeError: null, made: [], reads: [], allowCalls: 0 };
  const original = { id: '18c0ffee01', threadId: '18c0ffee00', payload: { headers: [{ name: 'From', value: 'Prof Lee <lee@school.edu>' }, { name: 'Subject', value: 'Grades' }, { name: 'Message-ID', value: '<abc@mail.school.edu>' }, { name: 'References', value: '<zero@mail.school.edu>' }] } };
  const google = {
    status: async () => ({ oauth: true, oneClick: false, session: false, email: 'ada@example.com' }),
    api: async (p) => { g.reads.push(p); if (p.startsWith('/users/me/messages/18c0ffee01')) return original; throw new Error('not found'); },
    feed: async () => ({ status: 200, body: '' }),
    connect: async () => {}, disconnect: async () => {},
    drafts: () => g.compose,
    allowDrafts: async () => { g.allowCalls++; g.compose = true; },
    compose: async (body) => { if (g.composeError) throw g.composeError; g.made.push(body); return { id: 'r1', message: { id: '18c0ffee0b', threadId: body.message.threadId || '18c0ffee0c' } }; },
  };
  const svc = service.create({ userData: dir, secrets: fakeSecrets, google, testLoopback: true });
  await svc.connect('gmail');
  const card = () => svc.list().connectors.find((c) => c.id === 'gmail');
  check('Settings: a Gmail with the full sign-in but no compose offers Allow drafts', card().drafts === 'off' && card().does.some((d) => /draft/i.test(d) && /never sends/.test(d)), JSON.stringify(card()));

  const draft = { app: 'gmail', action: 'create_draft', args: { to: 'lee@school.edu', subject: 'Re: Grades', body: 'Thank you!\nAda', reply_to_message_id: '18c0ffee01' } };
  check('create_draft input is valid; a bad address or a reply id that isn’t one is refused', registry.validate(draft) === null && /expected form/.test(registry.validate({ app: 'gmail', action: 'create_draft', args: { to: 'nobody', subject: 's', body: 'b' } }) || '') && /expected form/.test(registry.validate({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 's', body: 'b', reply_to_message_id: '../x' } }) || ''), registry.validate(draft));
  const before = await fails(() => svc.describeWrite(draft));
  check('without Allow drafts, no card: the AI is told to have the user press Allow drafts', /Allow drafts first/.test(before) && /Settings → AI and agents → Connectors/.test(before), before);
  check('…and the action itself refuses too, sending nothing', /Allow drafts first/.test(await fails(() => svc.call(draft))) && g.made.length === 0, '');
  check('the AI can’t start Allow drafts: it isn’t an action', !registry.get('gmail').actions.allow_drafts && g.allowCalls === 0, '');
  await svc.allowDrafts('gmail');
  check('Allow drafts (the Settings button) runs the Google step, and the card shows drafts on', g.allowCalls === 1 && card().drafts === 'on', JSON.stringify(card()));

  const c = await svc.describeWrite(draft);
  check('the card: To, Cc, Subject and Text editable, in that order, labelled plainly', c.fields.map((f) => `${f.key}:${f.label}`).join() === 'to:To,cc:Cc,subject:Subject,body:Text' && c.fields[3].multiline && !c.fields[0].multiline, JSON.stringify(c.fields));
  check('the card’s fixed part names the conversation (looked up with a read) and says “This only makes a draft. Nothing is sent.”', /A reply in your Gmail Drafts, in the conversation “Grades” from Prof Lee/.test(c.fixed) && c.fixed.includes('This only makes a draft. Nothing is sent.') && /To: lee@school\.edu/.test(c.detail) && /Thank you!\nAda/.test(c.detail) && g.made.length === 0, JSON.stringify(c));
  const edited = registry.applyEdits(draft, { to: 'lee@school.edu, Dean <dean@school.edu>', cc: 'me@example.com', body: 'Edited', reply_to_message_id: 'ffffff' });
  check('edits change To, Cc and the text, are checked again, and never the message replied to', edited.input.args.cc === 'me@example.com' && edited.input.args.body === 'Edited' && edited.input.args.reply_to_message_id === '18c0ffee01' && /expected form/.test(registry.applyEdits(draft, { to: 'x\r\nBcc: e@x.org' }).error || ''), JSON.stringify(edited));
  let step = null;
  const out = await svc.call(edited.input, { onWritten: (s) => { step = s; } });
  const sent = g.made[0];
  const msg = unRaw(sent.message.raw);
  check('the draft goes in the original’s thread, with In-Reply-To and References from its Message-ID', sent.message.threadId === '18c0ffee00' && /\r\nIn-Reply-To: <abc@mail\.school\.edu>\r\n/.test(msg) && /\r\nReferences: <zero@mail\.school\.edu>\r\n <abc@mail\.school\.edu>\r\n/.test(msg) && /^To: lee@school\.edu,\r\n "Dean" <dean@school\.edu>/m.test(msg) && /^Cc: me@example\.com/m.test(msg) && bodyOf(msg) === 'Edited', msg);
  check('the reply’s original was read with a read-only path', g.reads.every((p) => /^\/users\/me\/messages\/18c0ffee01\?format=metadata/.test(p)), JSON.stringify(g.reads));
  check('the result says nothing was sent and links the draft; the chat step has the link', /Draft made, not sent/.test(out) && out.includes('Link: https://mail.google.com/mail/?authuser=ada%40example.com#drafts?compose=18c0ffee0b') && step?.label === 'Gmail · Draft made: “Re: Grades”' && step.link === 'https://mail.google.com/mail/?authuser=ada%40example.com#drafts?compose=18c0ffee0b', JSON.stringify({ out, step }));
  const fresh = await svc.call({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 'Héllo', body: 'Hi' } });
  check('a new draft has no thread and no reply headers', !g.made[1].message.threadId && !/In-Reply-To|References/.test(unRaw(g.made[1].message.raw)) && /Draft made/.test(fresh), unRaw(g.made[1].message.raw));
  const tries = g.made.length;
  g.composeError = Object.assign(new Error('The draft may have been made; check Drafts before trying again.'), { kind: 'maybe' });
  let calls = 0;
  const realCompose = google.compose;
  google.compose = async (b) => { calls++; return realCompose(b); };
  const maybe = await fails(() => svc.call({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 's', body: 'b' } }));
  google.compose = realCompose;
  check('an ambiguous failure tells the AI the draft may have been made, with the Drafts link for the account, and makes no second try', /may have been made; check Drafts before trying again: https:\/\/mail\.google\.com\/mail\/\?authuser=ada%40example\.com#drafts /.test(maybe) && calls === 1 && g.made.length === tries, maybe);
  g.composeError = new Error('Gmail is having trouble.');
  const unknown = await fails(() => svc.call({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 's', body: 'b' } }));
  g.composeError = Object.assign(new Error('Gmail didn’t accept the draft (invalidArgument).'), { nothingMade: true });
  const certain = await fails(() => svc.call({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 's', body: 'b' } }));
  check('the AI hears “Nothing was made” only for a failure marked certain; any other says it may have been made', /may have been made/.test(unknown) && !/Nothing was made/.test(unknown) && /invalidArgument\)\. Nothing was made\./.test(certain), JSON.stringify({ unknown, certain }));
  g.composeError = Object.assign(new Error('Allow drafts first.'), { kind: 'scope' });
  check('a 403 for a missing permission says “Allow drafts first”', /Allow drafts first/.test(await fails(() => svc.call({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 's', body: 'b' } }))), '');
  g.composeError = Object.assign(new Error('Google signed Lumen out.'), { reconnect: true });
  check('an ended sign-in (401) says to sign in again, and the card turns to Needs sign-in', /isn’t signed in/.test(await fails(() => svc.call({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 's', body: 'b' } }))) && card().status === 'needs-signin', JSON.stringify(card()));
  g.composeError = null;

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-gmail-drafts-s-'));
  const svc2 = service.create({ userData: sessionDir, secrets: fakeSecrets, google: { ...google, status: async () => ({ oauth: false, oneClick: false, session: true, email: 'ada@example.com' }) } });
  await svc2.connect('gmail');
  check('Gmail through the Lumen session only: no Allow drafts button, and a draft says it needs the full sign-in', svc2.list().connectors.find((x) => x.id === 'gmail').drafts === null && /full Google sign-in/.test(await fails(() => svc2.describeWrite({ app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 's', body: 'b' } }))) && /full Google sign-in/.test(await fails(() => svc2.allowDrafts('gmail'))), '');

  console.log('--- the agent: a click every time, never in the background');
  registry.setConnected(['gmail']);
  const events = [];
  const browser = { connectors: { hasAny: () => true, isWrite: (i) => svc.isWrite(i), describeWrite: (i, o) => svc.describeWrite(i, o), defs: (o) => svc.defs(o), call: (i, o) => svc.call(i, o) }, bypassPermissions: () => true, autoApprove: () => true };
  const agent = new agentLib.Agent(browser, () => null, () => ({}));
  const gate = (extra = {}) => ({ emit: (e) => events.push(e), signal: new AbortController().signal, who: 'Claude', external: false, noAsk: false, run: {}, ...extra });
  const input = { app: 'gmail', action: 'create_draft', args: { to: 'a@x.org', subject: 'From the AI', body: 'x' } };
  const pending = agent.allowConnector(input, gate());
  await new Promise((r) => setTimeout(r, 20));
  const approval = events.find((e) => e.type === 'approval');
  check('with Bypass permissions and Auto-allow on, a draft still shows a card with no Always, its fields and the fixed note', approval && approval.note === 'connector' && approval.noAlways === true && !events.some((e) => e.name === 'auto_allowed') && approval.fields?.list.map((f) => f.key).join() === 'to,cc,subject,body' && /Nothing is sent/.test(approval.fields.fixed), JSON.stringify(approval));
  const n = g.made.length;
  agent.resolveApproval(approval.approvalId, { edits: { subject: 'What I wrote' } });
  await pending;
  await agent.runConnector(input);
  check('allowed with an edit: the draft has the edited subject', g.made.length === n + 1 && /\r\nSubject: What I wrote\r\n/.test(unRaw(g.made[n].message.raw)), unRaw(g.made[n].message.raw));
  check('the tool for a chat lists create_draft as a write', /create_draft\(to,cc\?,subject,body,reply_to_message_id\?\)!/.test(svc.defs()[0].description), svc.defs()[0].description);
  const bgAgent = new agentLib.Agent({ ...browser, background: true }, () => null, () => ({}));
  events.length = 0;
  const bgErr = await fails(() => bgAgent.allowConnector({ ...input, args: { ...input.args } }, gate()));
  check('a background task or routine is not offered create_draft, and one sent anyway is refused with no card', !/create_draft/.test(svc.defs({ readOnly: true })[0].description) && /can only read/.test(bgErr) && !events.some((e) => e.type === 'approval'), bgErr);
  const m = g.made.length;
  check('the service refuses a draft for a read-only caller before anything is sent', /can only read/.test(await fails(() => svc.call(input, { readOnly: true }))) && g.made.length === m, '');
  check('an outside MCP agent gets "Unknown tool"', /Unknown tool/.test(await fails(() => agent.allowConnector({ ...input }, gate({ external: true })))), '');
  check('"agents don\'t ask" (noAsk) refuses a draft without a card', /nobody is here to ask/.test(await fails(() => agent.allowConnector({ ...input }, gate({ noAsk: true })))), '');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
}

(async () => {
  await mime();
  sendGuards();
  await signIn();
  await connector();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
