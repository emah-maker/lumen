// A cross-origin iframe with a form behind a captcha must work with the default privacy settings, as in Chrome (the Garmin profile
// form: an embedded sso page, protected by hCaptcha, whose "Submit Profile" POST died with net::ERR_FAILED).
// Everything is local: 127.0.0.1 with several host names mapped to it (--host-resolver-rules, every other name unresolvable), and the ad
// blocker's lists come from a stand-in server on this machine (LUMEN_TEST_ADBLOCK_CDN) that carries the rules a real list could have
// for these names, so a list entry that catches a captcha or sign-in provider shows here. No real network.
//   Scenario A, host names as on the real sites (sso.garmin.com, newassets.hcaptcha.com, challenges.cloudflare.com, ...): a frame on
//   the "garmin" site holds a nested captcha frame; the captcha script and its POSTs (form-urlencoded and JSON), the form POSTs
//   (urlencoded, and multipart with a file) and a CORS JSON POST to a sibling host all succeed; a real tracker in the lists is blocked.
//   Scenario B, *.localhost names (a Secure, SameSite=None cookie can be set on those over http): the captcha frame's third-party
//   cookie and storage work, and the cookie comes back on the frame's own POSTs, as in Chrome.
//   Then: a link or window.open from the frame opens a tab for exactly that address.
// Hidden window, throwaway profile. Run it under the lock:
//   node scripts/test/e2e-lock.js run --owner me -- timeout 600 node test/iframe-post.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const J = (v) => JSON.stringify(v);

const FILE_BYTES = Buffer.concat([Buffer.from('AVATAR-HEAD-'), crypto.randomBytes(180000), Buffer.from('-AVATAR-TAIL')]);
const FILE_SHA = crypto.createHash('sha256').update(FILE_BYTES).digest('hex');

// The host names of a scenario: the top page's site, the form frame's site (and a sibling), the captcha provider, a tracker.
const SCENARIOS = {
  real: { top: 'portal.lumen-test.org', frame: 'sso.garmin.com', sibling: 'connect.garmin.com', captcha: 'newassets.hcaptcha.com', tracker: 'ads.tracker-test.org', secureCookies: false },
  local: { top: 'portal2.lumen-test.org', frame: 'sso.garmin.localhost', sibling: 'connect.garmin.localhost', captcha: 'newassets.hcaptcha.localhost', tracker: 'ads.tracker-test.org', secureCookies: true },
};
const ALL_HOSTS = [...new Set(Object.values(SCENARIOS).flatMap((s) => [s.top, s.frame, s.sibling, s.captcha, s.tracker]))];
// The captcha and sign-in providers other sites embed; each one is served here too (a frame, a script and a POST).
const PROVIDERS = [
  ['hcaptcha', 'newassets.hcaptcha.com', '/1/hsw.js'],
  ['hcaptcha-api', 'js.hcaptcha.com', '/1/api.js'],
  ['recaptcha', 'www.google.com', '/recaptcha/api.js'],
  ['recaptcha-net', 'www.recaptcha.net', '/recaptcha/api.js'],
  ['turnstile', 'challenges.cloudflare.com', '/turnstile/v0/api.js'],
  ['arkose', 'client-api.arkoselabs.com', '/v2/api.js'],
  ['gstatic', 'www.gstatic.com', '/recaptcha/releases/x/recaptcha__en.js'],
];

// What a real list could carry for these names. The rules for the captcha providers are the worst case (a list that does catch
// them): they must still load. The tracker's are what the lists are for: it must stay blocked.
const RULES = [
  '||ads.tracker-test.org^$third-party',
  '/ad.js$script,third-party',
  '||hcaptcha.com^$third-party',
  '||hcaptcha.com^*/1/hsw.js',
  '||newassets.hcaptcha.com^',
  '||challenges.cloudflare.com^$third-party',
  '||arkoselabs.com^$third-party',
  '||recaptcha.net^$third-party',
  '||google.com/recaptcha/^$third-party',
  '||gstatic.com/recaptcha/^$third-party',
  '||garmin.com^*/sso/log$xhr',
  '||garmin.com^*/sso/metrics$xhr,third-party',
  '||login.microsoftonline.com^$third-party',
  '||okta.com^$third-party',
  '||auth0.com^$third-party',
  '||appleid.apple.com^',
  '||login.live.com^',
  '||sso.garmin.com^$third-party',
  '||accounts.example.org^',
  '||auth.tracker.example^',
  '||sso.garmin-like.test^',
].join('\n');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
  const hits = []; // every request the local server saw: { host, method, path, type, cookie, len }
  let port = 0;
  const body = (req) => new Promise((resolve) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Access-Control-Allow-Headers', 'content-type, x-csrf'); }
  };
  const hostName = (req) => String(req.headers.host || '').replace(/:\d+$/, '');

  const server = http.createServer(async (req, res) => {
    const host = hostName(req);
    const u = new URL(req.url, 'http://x');
    const scenario = Object.values(SCENARIOS).find((s) => [s.top, s.frame, s.sibling, s.captcha, s.tracker].includes(host)) || SCENARIOS.real;
    const buf = req.method === 'POST' ? await body(req) : Buffer.alloc(0);
    hits.push({ host, method: req.method, path: u.pathname, type: req.headers['content-type'] || '', cookie: req.headers.cookie || '', len: buf.length, origin: req.headers.origin || '' });
    cors(req, res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader('Access-Control-Allow-Methods', 'POST, GET'); return res.end(); }
    const secure = scenario.secureCookies ? '; SameSite=None; Secure' : '';
    const send = (type, text) => { res.setHeader('Content-Type', type); res.end(text); };
    const origin = (h) => `http://${h}:${port}`;

    // ---- the top page ----
    if (host === scenario.top && u.pathname === '/') {
      return send('text/html', `<!doctype html><title>Portal</title><h1>Portal</h1>
<script src="${origin(scenario.tracker)}/ad.js"></script>
<iframe id="f" src="${origin(scenario.frame)}/profile?top=${scenario.top}" style="width:700px;height:600px"></iframe>`);
    }
    // ---- the form frame's site ("sso.garmin.com") ----
    if (host === scenario.frame && u.pathname === '/profile') {
      res.setHeader('Set-Cookie', `garmin_sess=sess123; Path=/${secure}`);
      return send('text/html', `<!doctype html><title>Profile</title>
<form id="pf" method="post" action="/submit-form" target="result"><input name="displayName" value="Ada Lovelace"><input name="note" value="a&amp;b=c d"><input type="hidden" name="h-captcha-response" id="hresp"></form>
<form id="mf" method="post" action="/upload" enctype="multipart/form-data" target="result"><input name="caption" value="me"><input type="file" name="photo" id="photo"><input type="hidden" name="h-captcha-response" id="hresp2"></form>
<iframe name="result" id="result" style="width:300px;height:60px"></iframe>
<iframe id="captcha" src="${origin(scenario.captcha)}/captcha?site=${scenario.frame}" style="width:300px;height:80px"></iframe>
<a id="newtab" target="_blank" href="${origin(scenario.frame)}/standalone">Open in its own tab</a>
<button id="submit" disabled>Submit Profile</button>
<script>
window.__r = { token: null, errors: [] };
addEventListener('message', (e) => { if (e.data && e.data.hcaptchaToken) { window.__r.token = e.data.hcaptchaToken; window.__r.captchaOrigin = e.origin; window.__r.captchaInfo = e.data; document.getElementById('hresp').value = e.data.hcaptchaToken; document.getElementById('hresp2').value = e.data.hcaptchaToken; document.getElementById('submit').disabled = false; } });
const post = async (key, url, init) => { try { const r = await fetch(url, init); window.__r[key] = { ok: r.ok, status: r.status, json: await r.json() }; } catch (err) { window.__r[key] = { error: String(err) }; } };
window.__submit = async () => {
  const token = window.__r.token;
  await post('urlencoded', '/api/profile', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'displayName=Ada+Lovelace&note=a%26b%3Dc+d&h-captcha-response=' + encodeURIComponent(token) });
  await post('json', '${origin(scenario.sibling)}/api/save', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Csrf': 'k' }, body: JSON.stringify({ displayName: 'Ada', token }) });
  await post('logJson', '${origin(scenario.sibling)}/sso/log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'submit' }) });
  await post('logForm', '${origin(scenario.sibling)}/sso/log', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'event=submit' });
  window.__r.beacon = navigator.sendBeacon('${origin(scenario.sibling)}/api/beacon', new Blob([JSON.stringify({ a: 1 })], { type: 'text/plain' }));
  await post('keepalive', '${origin(scenario.sibling)}/api/beacon', { method: 'POST', keepalive: true, credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  await new Promise((r) => setTimeout(r, 300));
  await post('metrics', '/sso/metrics', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'submit' }) });
  const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob('${FILE_BYTES.toString('base64')}'), (c) => c.charCodeAt(0))], 'avatar.bin', { type: 'application/octet-stream' }));
  document.getElementById('photo').files = dt.files;
  const loaded = (id) => new Promise((resolve) => { const f = document.getElementById('result'); f.onload = () => resolve(f.contentWindow ? 'loaded' : 'gone'); });
  let wait = loaded(); document.getElementById('pf').submit(); window.__r.formUrlencoded = await Promise.race([wait, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  wait = loaded(); document.getElementById('mf').submit(); window.__r.formMultipart = await Promise.race([wait, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  window.__r.done = true;
};
document.getElementById('submit').onclick = () => window.__submit();
</script>`);
    }
    if (host === scenario.frame && u.pathname === '/standalone') return send('text/html', '<!doctype html><title>Standalone</title><h1 id="own">The frame, on its own</h1>');
    if (host === scenario.frame && u.pathname === '/api/profile') {
      const f = new URLSearchParams(buf.toString());
      return send('application/json', J({ ok: f.get('displayName') === 'Ada Lovelace' && f.get('note') === 'a&b=c d' && Boolean(f.get('h-captcha-response')), type: req.headers['content-type'], cookie: scenario.secureCookies ? /garmin_sess=sess123/.test(req.headers.cookie || '') : null }));
    }
    if ((host === scenario.frame || host === scenario.sibling) && (u.pathname === '/sso/metrics' || u.pathname === '/sso/log')) return send('application/json', J({ metrics: 'recorded' }));
    if (host === scenario.frame && u.pathname === '/submit-form') {
      const f = new URLSearchParams(buf.toString());
      return send('text/html', `<!doctype html><body>urlencoded-ok ${f.get('displayName') === 'Ada Lovelace' && f.get('note') === 'a&b=c d' && Boolean(f.get('h-captcha-response'))}`);
    }
    if (host === scenario.frame && u.pathname === '/upload') {
      const text = buf.toString('latin1');
      const at = buf.indexOf(Buffer.from('AVATAR-HEAD-'));
      const end = buf.indexOf(Buffer.from('-AVATAR-TAIL'));
      const slice = at >= 0 && end > at ? buf.subarray(at, end + '-AVATAR-TAIL'.length) : Buffer.alloc(0);
      const sha = crypto.createHash('sha256').update(slice).digest('hex');
      return send('text/html', `<!doctype html><body>multipart-ok ${/^multipart\/form-data; boundary=/.test(req.headers['content-type'] || '') && /filename="avatar\.bin"/.test(text) && sha === FILE_SHA && /name="caption"[\s\S]*me/.test(text)}`);
    }
    // ---- the sibling host (a CORS JSON POST that needs a preflight) ----
    if (host === scenario.sibling && u.pathname === '/api/beacon') return send('application/json', J({ beacon: buf.length }));
    if (host === scenario.sibling && u.pathname === '/api/save') {
      const j = JSON.parse(buf.toString() || '{}');
      return send('application/json', J({ ok: j.displayName === 'Ada' && Boolean(j.token), csrf: req.headers['x-csrf'] }));
    }
    // ---- the captcha provider ("newassets.hcaptcha.com") ----
    if (host === scenario.captcha && u.pathname === '/captcha') {
      res.setHeader('Set-Cookie', `hc_session=hc456; Path=/${secure}`);
      return send('text/html', `<!doctype html><title>captcha</title><div id="box">I am human</div>
<script src="/1/hsw.js"></script>
<script>
(async () => {
  try {
    try { localStorage.setItem('hc_ls', 'stored'); } catch (e) { window.__lsError = String(e); }
    const a = await fetch('/checksiteconfig', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'v=1&host=${scenario.frame}&sitekey=abc' }).then((r) => r.json());
    window.__hswFetch = await fetch('/1/hsw.js').then((r) => r.text()).then((t) => t.includes('hsw-ran'), (e) => 'fetch failed: ' + e);
    window.__hswWorker = await new Promise((res) => { try { const w = new Worker('/1/hsw.js'); w.onerror = () => res('error'); w.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 4000); } catch (e) { res(String(e)); } });
    const b = await fetch('/getcaptcha', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify({ n: window.__hsw || 'none', c: a.c }) }).then((r) => r.json());
    parent.postMessage({ hcaptchaToken: b.token, ls: localStorage.getItem('hc_ls'), cookie: document.cookie, script: window.__hsw, hswFetch: window.__hswFetch, hswWorker: window.__hswWorker }, '*');
  } catch (err) { parent.postMessage({ hcaptchaError: String(err) }, '*'); }
})();
</script>`);
    }
    if (host === scenario.captcha && u.pathname === '/1/hsw.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end("if (typeof window === 'undefined') postMessage('worker-ran'); else window.__hsw = 'hsw-ran';"); }
    if (host === scenario.captcha && u.pathname === '/checksiteconfig') return send('application/json', J({ c: 'cfg', cookie: scenario.secureCookies ? /hc_session=hc456/.test(req.headers.cookie || '') : null }));
    if (host === scenario.captcha && u.pathname === '/getcaptcha') {
      const j = JSON.parse(buf.toString() || '{}');
      return send('application/json', J({ token: j.n === 'hsw-ran' ? 'P0_token' : 'P0_notoken' }));
    }
    // ---- the tracker ----
    if (host === scenario.tracker) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.__trackerRan = true;'); }
    // ---- the other providers ----
    const provider = PROVIDERS.find(([, h]) => h === host);
    if (provider) {
      if (u.pathname === provider[2]) { res.setHeader('Content-Type', 'text/javascript'); return res.end(`window.__provider_${provider[0].replace(/\W/g, '_')} = 'ran';`); }
      if (u.pathname === '/frame') return send('text/html', `<!doctype html><title>${provider[0]}</title><p id="p">${provider[0]} frame</p>`);
      if (u.pathname === '/verify') return send('application/json', J({ ok: true, provider: provider[0], len: buf.length }));
    }
    res.statusCode = 404; res.end('nope');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;

  // The stand-in lists server (adblock-lists.js): every list has a revision; the first holds the rules above.
  const lists = http.createServer((req, res) => {
    const m = req.url.match(/^\/([^/]+)\/(metadata\.json|[^/]+\/list\.txt)$/);
    if (!m || /^ublock-filters-20(2[5-9]|30)$/.test(m[1])) { res.statusCode = 404; res.end(); return; }
    if (m[2] === 'metadata.json') { res.end(J({ revisions: ['r1'] })); return; }
    if (m[1] === 'ublock-resources-json') { res.end(J({ redirects: [], scriptlets: [] })); return; }
    res.end(m[1] === 'easyprivacy' ? (process.env.IFP_RULES ? process.env.IFP_RULES.split(';').join(String.fromCharCode(10)) : RULES) : '! empty list');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => lists.once('listening', r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ifp-'));
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(__dirname, '..', 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const names = [...ALL_HOSTS, ...PROVIDERS.map((p) => p[1])];
  const rules = `${[...new Set(names)].map((h) => `MAP ${h} 127.0.0.1`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`;
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--host-resolver-rules=${rules}`],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_ADBLOCK_CDN: `http://127.0.0.1:${lists.address().port}` },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    check('the stand-in lists are loaded into the ad blocker', await waitFor(() => app.evaluate(() => global.__adblock.ready()), 60000) === true, 'not ready');
    // Every network error the session reports (net::ERR_FAILED is the one this suite is about).
    await app.evaluate(({ session }) => { global.__netErr = []; session.defaultSession.webRequest.onErrorOccurred((d) => { global.__netErr.push({ url: d.url, error: d.error, type: d.resourceType, method: d.method }); }); });
    const netErrors = () => app.evaluate(() => global.__netErr.splice(0));
    // A real tracker in the lists is blocked: this is the engine under test, with its rules.
    const engineBlocks = (url, page, type) => app.evaluate((_e, a) => {
      const { Request } = process.mainModule.require(a[3]);
      return Boolean(global.__adblockEngine.match(Request.fromRawDetails({ url: a[0], sourceUrl: a[1], type: a[2] })).match);
    }, [url, page, type, path.join(__dirname, '..', 'node_modules', '@ghostery', 'adblocker')]);

    const tabId = () => app.evaluate(() => global.__windows.list()[0].tabs.find((t) => t.active)?.contentsId ?? global.__windows.list()[0].tabs[0].contentsId);
    const loadTop = async (url) => {
      const id = await tabId();
      await app.evaluate(({ webContents }, [i, u]) => new Promise((resolve) => { const wc = webContents.fromId(i); wc.once('did-stop-loading', () => resolve()); wc.loadURL(u); }), [id, url]);
    };
    const inFrame = async (hostPart, code) => app.evaluate(async ({ webContents }, [i, h, c]) => {
      const wc = webContents.fromId(i);
      const frame = wc.mainFrame.framesInSubtree.find((f) => { try { return new URL(f.url).hostname === h; } catch { return false; } });
      if (!frame) return { __noframe: wc.mainFrame.framesInSubtree.map((f) => f.url) };
      return frame.executeJavaScript(c, true);
    }, [await tabId(), hostPart, code]);

    for (const [name, s] of Object.entries(SCENARIOS)) {
      hits.length = 0;
      await netErrors();
      await loadTop(`http://${s.top}:${port}/`);
      const got = await waitFor(async () => { const r = await inFrame(s.frame, 'window.__r'); return r && r.token ? r : null; }, 20000);
      check(`[${name}] the nested captcha frame loads its script, calls its API and hands a token to the form frame`, Boolean(got) && got.token === 'P0_token', J(got) + J(hits.slice(-10)));
      check(`[${name}] the token came from the captcha site's origin`, got?.captchaOrigin === `http://${s.captcha}:${port}`, J(got));
      const ctx = await inFrame(s.captcha, '({ ls: localStorage.getItem("hc_ls"), lsErr: window.__lsError || null, hsw: window.__hsw || null, cookie: document.cookie })');
      check(`[${name}] the captcha script ran and its frame keeps storage`, ctx.hsw === 'hsw-ran' && ctx.ls === 'stored', J(ctx));
      if (s.secureCookies) {
        const check1 = hits.find((h) => h.host === s.captcha && h.path === '/checksiteconfig');
        check(`[${name}] the captcha frame's third-party cookie is sent back to its own site`, Boolean(check1) && /hc_session=hc456/.test(check1.cookie), J(check1));
        check(`[${name}] the captcha frame reads its own cookie`, /hc_session=hc456/.test(ctx.cookie), J(ctx));
      }
      await inFrame(s.frame, 'window.__submit(); 0');
      const r = await waitFor(async () => { const x = await inFrame(s.frame, 'window.__r'); return x && x.done ? x : null; }, 30000);
      console.log(`      [${name}] captcha info:`, J(got?.captchaInfo), 'logJson:', J(r?.logJson), 'logForm:', J(r?.logForm), 'beacon:', J(r?.beacon), 'keepalive:', J(r?.keepalive), 'hits:', J(hits.filter((h) => /beacon/.test(h.path)).length));
      check(`[${name}] "Submit Profile": the form-urlencoded POST from the frame succeeds`, r?.urlencoded?.ok && r.urlencoded.json.ok, J(r));
      if (s.secureCookies) check(`[${name}] the frame's third-party cookie comes back on its own POST`, r?.urlencoded?.json?.cookie === true, J(r));
      check(`[${name}] "Submit Profile": the CORS JSON POST (preflight) to a sibling host succeeds`, r?.json?.ok && r.json.json.ok && r.json.json.csrf === 'k', J(r));
      check(`[${name}] a POST the lists name for a different purpose than a form (metrics) is let through quietly`, !r?.metrics?.error, J(r));
      check(`[${name}] the form-urlencoded form POST (navigation in a frame) succeeds`, r?.formUrlencoded === 'loaded', J(r));
      check(`[${name}] the multipart form POST with a file succeeds`, r?.formMultipart === 'loaded', J(r));
      const resultText = await inFrame(s.frame, 'document.getElementById("result").contentDocument ? document.getElementById("result").contentDocument.body.textContent : "(cross-origin)"');
      const form = hits.filter((h) => h.host === s.frame && h.method === 'POST');
      const multipart = form.find((h) => h.path === '/upload');
      const urlenc = form.find((h) => h.path === '/submit-form');
      check(`[${name}] the server saw both form POSTs, intact`, Boolean(urlenc) && /x-www-form-urlencoded/.test(urlenc.type) && Boolean(multipart) && /^multipart\/form-data/.test(multipart.type) && multipart.len > FILE_BYTES.length, J({ urlenc, multipart, resultText }));
      check(`[${name}] the result page shows the server accepted the multipart body byte for byte`, /multipart-ok true/.test(String(resultText)) || resultText === '(cross-origin)', J(resultText));
      const errs = (await netErrors()).filter((e) => !/favicon.ico/.test(e.url));
      console.log(`      [${name}] network errors:`, J(errs));
      check(`[${name}] no request failed with net::ERR_FAILED`, !errs.some((e) => e.error === 'net::ERR_FAILED'), J(errs));
      const tracker = hits.filter((h) => h.host === s.tracker);
      const trackerRan = await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.__trackerRan === true'), await tabId());
      check(`[${name}] a real tracker in the lists is still blocked (never reached, its script not run)`, tracker.length === 0 && trackerRan === false, J({ tracker, trackerRan }));
    }

    // ---- the request hook's decisions (adblock.probe): the captcha and sign-in providers pass on any site, a real tracker does not ----
    const probe = (url, type, { method = 'GET', page = 'https://some-site.example/form' } = {}) => app.evaluate((_e, a) => global.__adblock.probe({ id: 1, url: a[0], method: a[2], resourceType: a[1], referrer: a[3], webContents: { id: undefined, getURL: () => a[3] } }), [url, type, method, page]);
    const passes = (r) => r && !r.cancel && !r.redirectURL;
    const SIGN_IN_HOSTS = ['login.microsoftonline.com', 'appleid.apple.com', 'login.live.com', 'dev-123.okta.com', 'tenant.auth0.com'];
    check('named sign-in providers (Microsoft, Apple, Okta, Auth0) pass on any site', (await Promise.all(SIGN_IN_HOSTS.map((h) => probe('https://' + h + '/log', 'xhr', { method: 'POST' })))).every(passes), 'a sign-in host was filtered');
    // A generic sso. / login. / auth. / accounts. host: a page (frame or form POST) always, a subresource only for its own site.
    const garmin = 'https://connect.garmin-like.test/profile';
    check('sso.garmin-like.test as a subframe, and as a form POST target, on a garmin-like page is allowed', passes(await probe('https://sso.garmin-like.test/embed', 'subFrame', { page: garmin })) && passes(await probe('https://sso.garmin-like.test/submit', 'subFrame', { method: 'POST', page: garmin })) && passes(await probe('https://sso.garmin-like.test/submit', 'mainFrame', { method: 'POST', page: garmin })), 'filtered');
    check('...and its script, fetch and POST from the same site (connect.garmin-like.test) are allowed', passes(await probe('https://sso.garmin-like.test/sso.js', 'script', { page: garmin })) && passes(await probe('https://sso.garmin-like.test/api', 'xhr', { method: 'POST', page: garmin })), 'filtered');
    check('auth.tracker.example loading a script on an unrelated site is still blocked by a stand-in rule', !passes(await probe('https://auth.tracker.example/t.js', 'script')), 'let through');
    check('...and so are its image, fetch, POST and ping, and the same host named sso. on an unrelated site', !passes(await probe('https://auth.tracker.example/p.gif', 'image')) && !passes(await probe('https://auth.tracker.example/c', 'xhr', { method: 'POST' })) && !passes(await probe('https://auth.tracker.example/c', 'ping', { method: 'POST' })) && !passes(await probe('https://sso.garmin-like.test/sso.js', 'script', { page: 'https://news.example/' })) && !passes(await probe('https://accounts.example.org/x', 'xhr', { method: 'POST' })), 'let through');
    check('Cloudflare\'s check on the site\'s own address passes', passes(await probe('https://shop.example/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js', 'script')), 'filtered');
    check('a real tracker is still blocked (a script, and a POST report)', !passes(await probe('https://ads.tracker-test.org/ad.js', 'script')) && !passes(await probe('https://ads.tracker-test.org/collect', 'xhr', { method: 'POST' })), 'tracker let through');
    check('a tracker named like a provider is not let through (hcaptcha.com.evil.example, evil.example/hcaptcha.com/)', !passes(await probe('https://ads.tracker-test.org/hcaptcha.com/ad.js', 'script')), 'let through');
    check('a form POSTed into a frame is never swallowed by a list entry', passes(await probe('https://ads.tracker-test.org/ad.js', 'subFrame', { method: 'POST' })), 'swallowed');
    check('the stand-in list does catch a real tracker (the engine under test has its rules)', await engineBlocks('https://ads.tracker-test.org/ad.js', 'https://some-site.example/', 'script') === true, 'tracker not matched');

    // ---- a link or window.open from the frame opens a tab for exactly that address ----
    const s = SCENARIOS.real;
    await loadTop(`http://${s.top}:${port}/`);
    await waitFor(async () => (await inFrame(s.frame, 'document.readyState')) === 'complete', 15000);
    const tabsBefore = await app.evaluate(() => global.__windows.list()[0].tabs.length);
    await inFrame(s.frame, 'document.getElementById("newtab").click(); 0');
    const opened = await waitFor(() => app.evaluate(({ webContents }) => {
      const tabs = global.__windows.list()[0].tabs;
      return tabs.length > 0 ? tabs.map((t) => ({ url: webContents.fromId(t.contentsId)?.getURL() })) : null;
    }), 10000);
    const standalone = await waitFor(() => app.evaluate(({ webContents }, u) => {
      const tab = global.__windows.list()[0].tabs.map((t) => webContents.fromId(t.contentsId)).find((w) => w && w.getURL() === u);
      return tab ? tab.executeJavaScript('({ own: Boolean(document.getElementById("own")), frames: window.frames.length, top: window === window.top, title: document.title })') : null;
    }, `http://${s.frame}:${port}/standalone`), 12000);
    check('a target=_blank link in the frame opens a tab for that address, as the page itself (not wrapped in the parent page)', Boolean(standalone) && standalone.own && standalone.frames === 0 && standalone.top, J({ standalone, opened, tabsBefore }));
    await inFrame(s.frame, 'window.open("http://' + s.frame + ':' + port + '/standalone?w=1", "_blank"); 0');
    const viaOpen = await waitFor(() => app.evaluate(({ webContents }, u) => {
      const tab = global.__windows.list()[0].tabs.map((t) => webContents.fromId(t.contentsId)).find((w) => w && w.getURL() === u);
      return tab ? tab.executeJavaScript('({ own: Boolean(document.getElementById("own")), frames: window.frames.length })') : null;
    }, `http://${s.frame}:${port}/standalone?w=1`), 12000);
    check('window.open from the frame opens a tab for that address, as the page itself', Boolean(viaOpen) && viaOpen.own && viaOpen.frames === 0, J(viaOpen));
  } finally {
    await app.close().catch(() => {});
    server.close(); lists.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
