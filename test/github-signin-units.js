// "Sign in with GitHub" for the GitHub card and the GitHub connector (features/github-auth.js), without Electron and with no real
// network (run from test/units.js, or on its own: `node test/github-signin-units.js`).
//  - github-auth.js on its own, with injected requests and waits: the pure parts (stored secret, scopes, GitHub's answers), the polling
//    schedule (the interval, slow_down adds five seconds, an expired code stops it), the refusals.
//  - the real thing against a stand-in for github.com and api.github.com on 127.0.0.1 (a throwaway https certificate; openssl ships with
//    Git for Windows and macOS): sign in -> the card fills in; a pending / slow_down sequence; an expired and a denied code; the gh CLI
//    (a stub gh in a temp folder on PATH); sign out; the token shared with the connector (and never copied into its file); a revoked token
//    -> "Sign in again"; the token staying out of every answer the page and Settings get and out of the console.
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const GA = require('../src/features/github-auth');
const { createWidgets } = require('../src/features/widgets');

const DEVICE_TOKEN = `gho_${'D1e2V3i4C5'.repeat(4)}`;
const CLI_TOKEN = `gho_${'C1l2I3t4O5'.repeat(4)}`;
const PASTED = `ghp_${'P1a2S3t4E5'.repeat(4)}`;
const CLIENT = 'Iv1.stubclient0001';
const json = (obj, init = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(15); } return false; }

module.exports = async function githubSigninUnits(check) {
  // ================= 1. the module on its own =================
  const secret = GA.pack({ token: DEVICE_TOKEN, via: 'device', scopes: ['read:user', 'notifications'], login: 'octocat' });
  const back = GA.unpack(secret);
  check('github sign-in: the stored secret round-trips (token, how, scopes, login)', back?.token === DEVICE_TOKEN && back.via === 'device' && back.scopes.join() === 'read:user,notifications' && back.login === 'octocat', JSON.stringify(back));
  check('github sign-in: a bare token (an older paste) is still read; junk and look-alikes are not', GA.unpack(PASTED)?.token === PASTED && GA.unpack(PASTED).via === 'paste' && GA.unpack('hunter2') === null && GA.unpack('') === null && GA.unpack(null) === null && GA.unpack('{"token":"x"}') === null && GA.unpack('{not json') === null && GA.unpack(JSON.stringify({ token: `${DEVICE_TOKEN}\n` })) === null, '');
  check('github sign-in: a login that is not a login is dropped, not trusted', GA.unpack(GA.pack({ token: DEVICE_TOKEN, login: '<b>x</b>' })).login === '', '');
  check('github scopes: parsed from the header; no header means unknown (a fine-grained token), not "none"', GA.parseScopes('read:user, notifications') .join() === 'read:user,notifications' && GA.parseScopes(null) === null && GA.parseScopes('').length === 0, '');
  const a1 = GA.assess(['read:user', 'notifications']);
  const a2 = GA.assess(['repo', 'read:org', 'gist']);
  check('github scopes: read:user + notifications is enough and covers no private repositories', a1.ok && a1.notifications && a1.privateRepos === false, JSON.stringify(a1));
  check('github scopes: the gh CLI default (repo, read:org, gist) is enough, and repo covers notifications and private repositories', a2.ok && a2.notifications && a2.privateRepos, JSON.stringify(a2));
  check('github scopes: a token with only gist cannot show anything and is refused; unknown scopes are not judged', GA.assess(['gist']).ok === false && GA.assess(null).ok && GA.assess(null).notifications === null && GA.assess(['read:user']).notifications === false, '');
  check('github scopes: the minimal request is read:user and notifications; repo only when private repositories are asked for', GA.scopeParam(false) === 'read:user notifications' && GA.scopeParam(true) === 'read:user notifications repo', GA.scopeParam(true));
  const copy = GA.COPY;
  check('github device code: a good answer is read; the interval and lifetime are bounded', (() => { const r = GA.readDevice({ ok: true, status: 200, body: JSON.stringify({ device_code: 'dc', user_code: 'ABCD-1234', interval: 5, expires_in: 900 }) }, copy); return r.code === 'ABCD-1234' && r.interval === 5 && r.expiresIn === 900e3; })(), '');
  check('github device code: device flow switched off, a wrong client id and a busy GitHub each get their own sentence', (() => {
    const msg = (res) => { try { GA.readDevice(res, copy); return ''; } catch (e) { return e.message; } };
    return msg({ ok: false, status: 400, body: '{"error":"device_flow_disabled"}' }) === copy.disabled && msg({ ok: false, status: 404, body: '{}' }) === copy.disabled && msg({ ok: false, status: 401, body: '{"error":"incorrect_client_credentials"}' }) === copy.badClient && msg({ ok: false, status: 429, body: '' }) === copy.busy && msg({ ok: true, status: 200, body: '{"device_code":"d","user_code":"<b>x</b>"}' }) === copy.unexpected;
  })(), '');
  const poll = (body, status = 200) => GA.readPoll({ ok: status < 400, status, body: JSON.stringify(body) });
  check('github device poll: pending, slow_down, expired, denied and a token are told apart', poll({ error: 'authorization_pending' }).kind === 'pending' && poll({ error: 'slow_down', interval: 10 }).kind === 'slow_down' && poll({ error: 'expired_token' }).kind === 'expired' && poll({ error: 'access_denied' }).kind === 'denied' && poll({ access_token: DEVICE_TOKEN, scope: 'read:user,notifications' }).scopes.join() === 'read:user,notifications' && poll({}, 502).kind === 'pending' && poll({ error: 'weird' }).kind === 'error', '');

  // The schedule, with injected requests and waits (nothing real is waited for).
  const sleeps = [];
  const posts = [];
  let step = 0;
  const script = [{ error: 'authorization_pending' }, { error: 'authorization_pending' }, { error: 'slow_down' }, { error: 'authorization_pending' }, { error: 'slow_down', interval: 30 }, { access_token: DEVICE_TOKEN, scope: 'read:user,notifications' }];
  let stored = null;
  let changes = 0;
  const auth = GA.create({
    post: async (url, body) => {
      posts.push({ url, body });
      if (/device\/code$/.test(url)) return { ok: true, status: 200, body: JSON.stringify({ device_code: 'dc', user_code: 'WDJB-MJHT', interval: 5, expires_in: 900 }) };
      return { ok: true, status: 200, body: JSON.stringify(script[step++]) };
    },
    get: async () => ({ ok: true, status: 200, headers: new Headers({ 'x-oauth-scopes': 'read:user, notifications' }), body: '{"login":"octocat"}' }),
    getSecret: () => stored, setSecret: (v) => { stored = v; }, loginBase: () => 'https://github.example', apiBase: () => 'https://api.github.example',
    clientId: () => CLIENT, openUrl: (u) => posts.push({ opened: u }), onChange: () => { changes++; },
    sleep: async (ms) => { sleeps.push(ms); }, findGh: () => null,
  });
  const shown = await auth.start({ privateRepos: false });
  check('github device flow: the code comes back at once, the sign-in page is opened, only the public client id and the minimal scopes are sent', shown.code === 'WDJB-MJHT' && posts.some((p) => p.opened === 'https://github.example/login/device') && posts[0].body.includes(`client_id=${encodeURIComponent(CLIENT)}`) && /scope=read%3Auser\+notifications$/.test(posts[0].body) && !/secret/.test(posts[0].body), JSON.stringify(posts[0]));
  await until(() => stored !== null);
  check('github device flow: it waits the interval, adds five seconds on slow_down (never less than asked), and ends in a stored, checked token', sleeps.join() === '5000,5000,5000,10000,10000,30000' && GA.unpack(stored)?.token === DEVICE_TOKEN && GA.unpack(stored).login === 'octocat', sleeps.join());
  check('github device flow: the token request names the device-code grant and nothing secret', posts.filter((p) => /access_token$/.test(p.url || '')).every((p) => p.body.includes(`grant_type=${encodeURIComponent(GA.GRANT)}`) && !/client_secret/.test(p.body)), '');
  check('github device flow: the status carries who and how, never the token', (() => { const s = auth.status(); return s.signedIn && s.login === 'octocat' && s.via === 'device' && !JSON.stringify(s).includes(DEVICE_TOKEN); })(), JSON.stringify(auth.status()));

  // An expired code stops by itself (a clock that has run past it), and a start without a client id says what to do.
  let clock = 1e9;
  let expiredStored = null;
  const sleepsB = [];
  const authB = GA.create({
    post: async (url) => (/device\/code$/.test(url) ? { ok: true, status: 200, body: JSON.stringify({ device_code: 'dc', user_code: 'ABCD-1234', interval: 5, expires_in: 60 }) } : { ok: true, status: 200, body: '{"error":"authorization_pending"}' }),
    get: async () => { throw new Error('not asked'); }, getSecret: () => expiredStored, setSecret: (v) => { expiredStored = v; }, loginBase: () => 'https://x', apiBase: () => 'https://y', clientId: () => CLIENT, openUrl() {}, onChange() {}, now: () => clock,
    sleep: async (ms) => { sleepsB.push(ms); clock += ms * 8; }, findGh: () => null,
  });
  await authB.start({});
  await until(() => authB.status().last);
  check('github device flow: a code that is never entered expires on its own, with a plain sentence and no token', /ran out/.test(authB.status().last.message) && !authB.status().pending && expiredStored === null, JSON.stringify(authB.status()));
  const authC = GA.create({ post: async () => { throw new Error('no request without a client id'); }, get: async () => null, getSecret: () => null, setSecret() {}, loginBase: () => 'x', apiBase: () => 'x', clientId: () => '', openUrl() {}, onChange() {}, findGh: () => null });
  const noClient = await authC.start({}).then(() => '', (e) => e.message);
  check('github device flow: without a client id (this build was never given one) it says so and the device button is off; the other ways still work', /isn’t set up/.test(noClient) && authC.status().device === false, noClient);

  // ================= 2. against a stand-in for github.com and api.github.com =================
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-signin-units-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the stand-in checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    return;
  }
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const prevPath = process.env.PATH;
  const prevPathWin = process.env.Path;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the stand-in's certificate is self-signed (this process only; put back below)
  const consoleSeen = [];
  const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const srvLog = []; // every request the stand-in saw
  const polls = []; // times of access_token requests
  let pollScript = []; // queued answers for POST /login/oauth/access_token
  let valid = new Set(); // tokens the API accepts
  let scopesOf = {}; // token -> x-oauth-scopes header (undefined: none sent)
  let deviceStatus = 200;
  let loginOf = { [DEVICE_TOKEN]: 'octocat', [CLI_TOKEN]: 'cli-user', [PASTED]: 'pasted-user' };
  const pr = (n) => ({ number: n, title: `Fix thing ${n}`, html_url: `https://github.com/acme/app/pull/${n}`, user: { login: 'octo-cat' }, updated_at: '2026-09-28T10:00:00Z', pull_request: {}, comments: 1 });
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      srvLog.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth, cookie: req.headers.cookie || '' });
      const out = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/login/device/code' && req.method === 'POST') {
        if (deviceStatus !== 200) return out(deviceStatus, { error: 'device_flow_disabled' });
        return out(200, { device_code: 'dc-stub', user_code: 'WDJB-MJHT', verification_uri: 'https://127.0.0.1/login/device', expires_in: 900, interval: 1 });
      }
      if (u.pathname === '/login/oauth/access_token' && req.method === 'POST') { polls.push(Date.now()); return out(200, pollScript.shift() || { error: 'authorization_pending' }); }
      if (u.pathname.startsWith('/api/')) {
        const token = auth.replace(/^Bearer /, '');
        if (!valid.has(token)) return out(401, { message: 'Bad credentials' });
        const headers = scopesOf[token] === undefined ? {} : { 'x-oauth-scopes': scopesOf[token] };
        if (u.pathname === '/api/user') return out(200, { login: loginOf[token] || 'someone' }, headers);
        if (u.pathname === '/api/search/issues') return out(200, { total_count: 42, items: Array.from({ length: 12 }, (_, i) => pr(i + 1)) }, headers);
        if (u.pathname === '/api/notifications') return out(200, [{ id: '1' }], { ...headers, link: '<https://api.github.com/notifications?per_page=1&page=7>; rel="last"' });
        return out(404, {});
      }
      return out(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;

  // The stub gh: a script (a .cmd on Windows) in its own folder, first on PATH; LUMEN_STUB_GH_SIGNED_OUT=1 in the environment makes it "signed out".
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(bin, 'calls.log');
  const ghCalls = () => { try { return fs.readFileSync(ghLog, 'utf8'); } catch { return ''; } };
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'gh.cmd'), `@echo off\r\necho %* >> "%~dp0calls.log"\r\nif defined LUMEN_STUB_GH_SIGNED_OUT exit /b 1\r\nif "%~1"=="auth" if "%~2"=="status" exit /b 0\r\nif "%~1"=="auth" if "%~2"=="token" (\r\n  echo ${CLI_TOKEN}\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "$(dirname "$0")/calls.log"\n[ -n "$LUMEN_STUB_GH_SIGNED_OUT" ] && exit 1\nif [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi\nif [ "$1" = auth ] && [ "$2" = token ]; then echo ${CLI_TOKEN}; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  }

  // The widgets service and the connectors service, wired as main.js wires them.
  let nowMs = Date.UTC(2026, 8, 30, 12, 0, 0);
  const settings = {};
  const secrets = {};
  const opened = [];
  const userData = path.join(scratch, 'userData');
  fs.mkdirSync(userData);
  const vault = { available: () => true, encrypt: (t) => `enc:${Buffer.from(String(t)).toString('base64').split('').reverse().join('')}`, decrypt: (e) => Buffer.from(e.slice(4).split('').reverse().join(''), 'base64').toString('utf8') };
  let widgets = null;
  let clientIdNow = CLIENT;
  const connectors = require('../src/features/connectors/service').create({
    userData, secrets: vault, fetch: (url, o) => fetch(url, o), endpoints: () => ({ github: `${base}/api` }), testLoopback: true,
    shared: { github: { info: () => { const a = GA.unpack(secrets.github); return a ? { token: a.token, account: a.login } : null; }, signOut: () => widgets.githubSignOut() } },
  });
  widgets = createWidgets({
    readSettings: () => settings, writeSettings: (s) => { Object.assign(settings, s); },
    fetch: (url, o) => fetch(url, o),
    getSecret: (n) => secrets[n] || null, setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; },
    canKeepSecrets: () => true,
    onUpdate() {}, now: () => nowMs, rateMax: () => 5000,
    endpoints: () => ({ github: `${base}/api`, githubLogin: base }),
    githubClientId: () => clientIdNow, githubPollScale: () => 0.01, // a one-second interval waits 10 ms
    openGithubSignIn: (url) => { opened.push(url); },
    onGithubChange: () => connectors.syncShared('github'),
    githubInUse: () => connectors.usesShared('github'),
  });
  const card = () => widgets.forPage().find((w) => w.type === 'github');
  const settle = async () => { nowMs += 6 * 60e3; await widgets.refreshAll({ force: true }); return card(); };
  const ghStatus = () => widgets.state().github;
  const conn = () => connectors.list().connectors.find((c) => c.id === 'github');
  const everyTokenGone = (extra = '') => [DEVICE_TOKEN, CLI_TOKEN, PASTED].every((t) => !JSON.stringify([widgets.forPage(), widgets.state(), connectors.list(), extra]).includes(t));
  for (const k of Object.keys(realConsole)) console[k] = (...args) => { consoleSeen.push(args.map(String).join(' ')); realConsole[k](...args); };
  const restore = () => { delete process.env.LUMEN_STUB_GH_SIGNED_OUT; Object.assign(console, realConsole); if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls; process.env.PATH = prevPath; if (prevPathWin !== undefined) process.env.Path = prevPathWin; };
  try {
    valid = new Set([DEVICE_TOKEN]);
    scopesOf = { [DEVICE_TOKEN]: 'read:user, notifications', [CLI_TOKEN]: 'gist, read:org, repo', [PASTED]: 'notifications' };
    // PATH is this process's own, and holds ONLY the stub's folder and the system folders: if the stub ever went missing the real gh (and its real
    // token) must not be found in its place.
    process.env.PATH = [bin, process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin', process.platform === 'win32' ? '' : '/bin'].filter(Boolean).join(path.delimiter);
    check('github CLI: the only gh this test can find is its own stub', GA.findGh()?.shown?.startsWith(bin), JSON.stringify(GA.findGh()));
    { // a gh.cmd in a Windows short-name folder (RUNNER~1, PROGRA~1) is found; one whose path cmd.exe would read as an operator is not
      const w = require('path').win32; const at = (want) => ({ statSync: (p) => ({ isFile: () => p === want }) });
      const short = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\gh-stub\gh.cmd`;
      const found = GA.findGh({ env: { PATH: w.dirname(short), ComSpec: 'cmd.exe' }, platform: 'win32', fs: at(short), path: w });
      const amp = String.raw`C:\Tools & Co\gh.cmd`;
      check('github CLI: a gh.cmd under a short-name folder (~) is found, one under a path with & is not', found?.shown === short && found.pre.includes(short) && GA.findGh({ env: { PATH: w.dirname(amp) }, platform: 'win32', fs: at(amp), path: w }) === null, JSON.stringify(found));
    }
    if (prevPathWin !== undefined) process.env.Path = process.env.PATH;

    // ---- a card on a signed-out profile asks for the sign-in (it needs a stored widget first) ----
    await widgets.save({ type: 'github' }).then(() => check('github card: saving a card with no sign-in and no token is refused with a way forward', false, 'saved'), (e) => check('github card: saving a card with no sign-in and no token is refused with a way forward', /sign in with GitHub first/i.test(e.message), e.message));
    // A first sign-in with no card yet, then the card is added.
    const first = await widgets.githubStart({});
    check('github sign-in: Settings gets the code at once, never a token', first.code === 'WDJB-MJHT' && /\/login\/device$/.test(first.url) && ghStatus().pending?.code === 'WDJB-MJHT' && everyTokenGone(), JSON.stringify(first.code));
    check('github sign-in: the sign-in page opened in a Lumen tab (the address is GitHub’s own device page)', opened.length === 1 && opened[0] === `${base}/login/device`, JSON.stringify(opened));
    const startReq = srvLog.find((l) => l.path === '/login/device/code');
    check('github sign-in: GitHub is sent the public client id and only read:user + notifications; no secret, no cookies', startReq.body.includes(`client_id=${encodeURIComponent(CLIENT)}`) && /scope=read%3Auser\+notifications$/.test(startReq.body) && !/secret/.test(startReq.body) && !startReq.cookie && !startReq.auth, startReq.body);
    // ---- pending, slow_down, then approved ----
    polls.length = 0;
    pollScript = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { error: 'authorization_pending' }, { access_token: DEVICE_TOKEN, scope: 'read:user,notifications', token_type: 'bearer' }];
    check('github sign-in: signed in once approved', await until(() => ghStatus().signedIn), JSON.stringify(ghStatus()));
    check('github sign-in: polled four times, and after slow_down it waited longer (six intervals of 10 ms, not one)', polls.length === 4 && polls[2] - polls[1] >= 45 && polls[1] - polls[0] < polls[2] - polls[1], JSON.stringify(polls.map((t, i) => (i ? t - polls[i - 1] : 0))));
    check('github sign-in: Settings shows who, how and the permissions, and nothing is pending', ghStatus().login === 'octocat' && ghStatus().via === 'device' && ghStatus().notifications === true && ghStatus().privateRepos === false && !ghStatus().pending && everyTokenGone(), JSON.stringify(ghStatus()));
    check('github sign-in: the token is stored once, in the encrypted slot, and not in settings', GA.unpack(secrets.github)?.token === DEVICE_TOKEN && !JSON.stringify(settings).includes(DEVICE_TOKEN), '');
    // ---- the widget populates ----
    const saved = await widgets.save({ type: 'github', gh: { max: 5 } });
    let c = await settle();
    check('github card: with the sign-in made first, adding the card needs no token and it fills in (5 of 42 review requests, unread count)', saved.widget.type === 'github' && c.data.reviews.items.length === 5 && c.data.reviews.total === 42 && c.data.notifications.count === 7 && !c.data.reconnect, JSON.stringify(c.data).slice(0, 200));
    check('github card: the page gets lists and links, never the token', everyTokenGone(), '');
    check('github card: the API calls carry the token as a Bearer header from the main process, with no cookies', srvLog.filter((l) => l.path.startsWith('/api/search') || l.path === '/api/notifications').every((l) => l.auth === `Bearer ${DEVICE_TOKEN}` && !l.cookie) && srvLog.some((l) => l.path === '/api/search/issues'), '');
    // ---- one sign-in, both consumers ----
    await until(() => conn().status === 'connected');
    const cc = conn();
    check('connector: the same sign-in set the GitHub connector up (connected as the same account), no second login', cc.status === 'connected' && /octocat/.test(cc.statusText) && connectors.usesShared('github'), JSON.stringify(cc.statusText));
    await until(() => fs.existsSync(path.join(userData, 'connectors.json')));
    const diskFile = fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8');
    check('connector: its file holds no token and no secret of its own (the token is read from the card’s encrypted secret)', !diskFile.includes(DEVICE_TOKEN) && !/"secret"/.test(diskFile) && /"shared": true/.test(diskFile), diskFile);
    srvLog.length = 0;
    const prs = await connectors.call({ app: 'github', action: 'prs', args: { role: 'review' } });
    check('connector: the AI’s GitHub tool works with the card’s token (the stand-in saw the same Bearer)', /Fix thing 1/.test(prs) && srvLog.some((l) => l.path === '/api/search/issues' && l.auth === `Bearer ${DEVICE_TOKEN}`), prs.slice(0, 120));
    // ---- a card's page actions ----
    check('github card: "Sign in with GitHub" and "Use GitHub CLI sign-in" are page actions on a GitHub card, and only those words', widgets.actionFrom(`lumen://newtab/?widget=${saved.widget.id}&do=ghcli`)?.do === 'ghcli' && widgets.actionFrom(`lumen://newtab/?widget=${saved.widget.id}&do=ghcli;rm`)?.invalid === true, '');
    // ---- sign out ----
    widgets.githubSignOut();
    check('sign out: the token is gone from the card’s slot, Settings says signed out, the connector is disconnected too', !secrets.github && !ghStatus().signedIn && conn().status === 'off' && !fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8').includes('"github"'), JSON.stringify([ghStatus(), conn().status]));
    c = await settle();
    check('sign out: the card turns into a sign-in card (no raw error), offering the device sign-in and the gh CLI', c.data?.reconnect === true && c.data.reason === 'signedout' && c.data.device === true && c.data.cli === true && !c.error && /Sign in with GitHub/.test(c.data.copy.signin) && !c.data.reviews, JSON.stringify(c.data));
    check('sign out: the code is what the card shows while a sign-in waits, and the card’s button starts it', await (async () => {
      pollScript = []; // stays pending
      await widgets.act({ id: saved.widget.id, do: 'signin' });
      const shownCard = card();
      return shownCard.data.pending?.code === 'WDJB-MJHT' && shownCard.data.reconnect === true && shownCard.data.copy.waiting.includes('login/device');
    })(), JSON.stringify(card().data));
    // ---- cancel: polling stops ----
    widgets.githubCancel();
    polls.length = 0;
    await wait(120);
    check('github sign-in: Cancel stops the polling and clears the code', polls.length <= 1 && !ghStatus().pending, String(polls.length));

    // ---- an expired code, and a denied one ----
    await widgets.githubStart({});
    pollScript = [{ error: 'authorization_pending' }, { error: 'expired_token' }];
    check('github sign-in: a code that expired ends the wait with a plain sentence (the card shows it) and stores nothing', await until(() => ghStatus().last), JSON.stringify(ghStatus()));
    check('…', /ran out/.test(ghStatus().last.message) && !secrets.github && !ghStatus().pending && /ran out/.test((await settle()).data.last.message), JSON.stringify(ghStatus().last));
    await widgets.githubStart({});
    pollScript = [{ error: 'access_denied' }];
    await until(() => /cancelled/.test(ghStatus().last?.message || ''));
    check('github sign-in: a denied code says it was cancelled and stores nothing', /cancelled/.test(ghStatus().last?.message || '') && !secrets.github, JSON.stringify(ghStatus().last));
    deviceStatus = 400;
    const off = await widgets.githubStart({}).then(() => '', (e) => e.message);
    deviceStatus = 200;
    check('github sign-in: GitHub saying Device Flow is off for the app is explained, not shown raw', /isn’t set up/.test(off) && !/device_flow_disabled/.test(off), off);

    // ---- a token without the access the card needs is refused ----
    scopesOf[DEVICE_TOKEN] = 'gist';
    valid = new Set([DEVICE_TOKEN]);
    await widgets.githubStart({});
    pollScript = [{ access_token: DEVICE_TOKEN, scope: 'gist' }];
    await until(() => ghStatus().last);
    check('github sign-in: a token whose permissions cannot show anything is not stored; the sentence says what to do', !secrets.github && /without the access it needs/.test(ghStatus().last.message), JSON.stringify(ghStatus().last));
    scopesOf[DEVICE_TOKEN] = 'read:user, notifications';

    // ---- private repositories are asked only when turned on ----
    await widgets.githubStart({ privateRepos: true });
    const withRepo = srvLog.filter((l) => l.path === '/login/device/code').pop();
    check('github sign-in: "Include private repositories" adds the repo scope (and is remembered for the card’s own button)', /scope=read%3Auser\+notifications\+repo$/.test(withRepo.body) && settings.githubPrivateRepos === true && ghStatus().wantPrivate === true, withRepo.body);
    widgets.githubCancel();
    await widgets.githubStart({ privateRepos: false });
    widgets.githubCancel();

    // ---- the gh CLI path: one click, no new login ----
    await until(() => ghStatus().cli);
    check('github CLI: Settings sees the CLI is signed in', ghStatus().cli === true && !ghCalls().includes('auth token'), ghCalls());
    valid = new Set([CLI_TOKEN]);
    await widgets.githubCli();
    check('github CLI: its token is taken, checked against GitHub (as cli-user) and stored; repo covers notifications and private repositories', GA.unpack(secrets.github)?.token === CLI_TOKEN && ghStatus().via === 'cli' && ghStatus().login === 'cli-user' && ghStatus().notifications === true && ghStatus().privateRepos === true && conn().status === 'connected' && /cli-user/.test(conn().statusText), JSON.stringify(ghStatus()));
    check('github CLI: it was run with fixed arguments for github.com only', ghCalls().split(/\r?\n/).filter(Boolean).every((l) => /^auth (status|token) --hostname github\.com\s*$/.test(l)), ghCalls());
    c = await settle();
    check('github CLI: the card fills in with the CLI’s sign-in', c.data.reviews?.total === 42 && !c.data.reconnect, JSON.stringify(c.data).slice(0, 120));
    check('github CLI: the token never reaches the page, Settings, the connector list or the console', everyTokenGone(), '');
    widgets.githubSignOut();
    process.env.LUMEN_STUB_GH_SIGNED_OUT = '1';
    const signedOutCli = await widgets.githubCli().then(() => '', (e) => e.message);
    check('github CLI: a gh that is not signed in says how to fix it (gh auth login)', /gh auth login/.test(signedOutCli) && !secrets.github, signedOutCli);
    c = await settle(); // (the card asks again once the minute's cache has run out)
    check('github CLI: once gh is signed out the card stops offering it (and still offers the device sign-in)', c.data?.reconnect === true && c.data.cli === false && c.data.device === true, JSON.stringify(c.data));
    clientIdNow = '';
    c = await settle();
    check('github card: with no client id and no signed-in gh there is nothing to sign in with, so it is the old “Add your GitHub token in Settings” setup card', /^Add your GitHub token in Settings/.test(c.error || c.warning || ''), JSON.stringify([c.data && Object.keys(c.data), c.error, c.warning]));
    clientIdNow = CLIENT;
    delete process.env.LUMEN_STUB_GH_SIGNED_OUT;

    // ---- a revoked token: "Sign in again", never a raw error ----
    valid = new Set([DEVICE_TOKEN]);
    await widgets.githubStart({});
    pollScript = [{ access_token: DEVICE_TOKEN, scope: 'read:user,notifications' }];
    await until(() => ghStatus().signedIn);
    c = await settle();
    check('revoked token: before the revoke the card shows its lists', c.data.reviews?.total === 42, JSON.stringify(c.data).slice(0, 80));
    valid = new Set(); // GitHub no longer accepts it
    c = await settle();
    check('revoked token: the card says it was signed out and offers "Sign in again" (device and CLI), with no raw GitHub error', c.data?.reconnect === true && c.data.reason === 'expired' && /signed Lumen out/.test(c.data.copy.expired) && c.data.copy.again === 'Sign in again' && c.data.device === true && !/Bad credentials|rejected/i.test(JSON.stringify(c)) && !c.error, JSON.stringify(c.data));
    check('revoked token: Settings says so too (expired) and still names the account', ghStatus().signedIn === true && ghStatus().expired === true && ghStatus().login === 'octocat', JSON.stringify(ghStatus()));
    const refused = await connectors.call({ app: 'github', action: 'prs' }).then(() => '', (e) => e.message);
    check('revoked token: the connector fails in the same way, telling the AI to ask the user to sign in again (not to make a token)', /sign in to GitHub again/i.test(refused) && conn().status === 'bad-token', `${refused} / ${conn().status}`);
    // sign in again with a fresh token: both recover
    valid = new Set([DEVICE_TOKEN]);
    await widgets.githubStart({});
    pollScript = [{ access_token: DEVICE_TOKEN, scope: 'read:user,notifications' }];
    await until(() => !ghStatus().expired && ghStatus().signedIn && !ghStatus().pending);
    c = await settle();
    check('revoked token: signing in again brings the card and the connector back', c.data.reviews?.total === 42 && ghStatus().expired === false && conn().status === 'connected' && /Fix thing/.test(await connectors.call({ app: 'github', action: 'prs' })), JSON.stringify(ghStatus()));

    // ---- removing the card keeps a sign-in the connector uses; a pasted token (advanced) still works and is shared too ----
    widgets.remove(saved.widget.id);
    check('removing the GitHub card keeps the sign-in while the connector uses it', Boolean(secrets.github) && ghStatus().signedIn && conn().status === 'connected', '');
    widgets.githubSignOut();
    valid = new Set([PASTED]);
    const pastedCard = await widgets.save({ type: 'github', token: PASTED });
    check('paste a token (advanced): still works, replaces the sign-in, and the connector is set up with it', pastedCard.widget.type === 'github' && GA.unpack(secrets.github)?.token === PASTED && ghStatus().via === 'paste' && conn().status === 'connected', JSON.stringify(ghStatus()));
    check('paste a token (advanced): the connector learns the account name from GitHub afterwards', await until(() => /pasted-user/.test(conn().statusText)), conn().statusText);
    srvLog.length = 0;
    check('paste a token (advanced): the same token serves the AI tool', /Fix thing/.test(await connectors.call({ app: 'github', action: 'prs' })) && srvLog.some((l) => l.auth === `Bearer ${PASTED}`), '');
    // disconnecting the connector signs the shared card out as well (one sign-in)
    await connectors.disconnect('github');
    check('disconnect from the connector: the card’s sign-in goes too (one sign-in, one place)', !secrets.github && !ghStatus().signedIn && conn().status === 'off', JSON.stringify(ghStatus()));
    widgets.remove(pastedCard.widget.id);

    check('no token was ever written to the console', consoleSeen.every((l) => ![DEVICE_TOKEN, CLI_TOKEN, PASTED].some((t) => l.includes(t))), '');
    check('the stand-in saw no cookies and no request to anywhere but itself (everything is on 127.0.0.1)', srvLog.every((l) => !l.cookie), '');
  } finally {
    restore();
    await new Promise((r) => srv.close(r));
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
};

if (require.main === module) {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  module.exports(check).then(() => { console.log(failures ? `${failures} failed` : 'all passed'); process.exit(failures ? 1 : 0); }, (err) => { console.error(err); process.exit(1); });
}
