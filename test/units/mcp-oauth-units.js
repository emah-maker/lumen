// Signing in to an MCP server with OAuth (features/mcp-oauth.js + the HTTP transport in features/mcp-client.js), in plain Node against a
// stand-in server on 127.0.0.1 that plays all of it: the 401 with its discovery pointer, the two metadata documents, dynamic client
// registration, the sign-in page (the test acts as the browser), the token endpoint (PKCE checked, refresh tokens rotated) and an MCP
// endpoint that only answers a valid bearer token. Covers discovery, registration, PKCE, the token exchange, refresh (one at a time,
// rotation kept), a revoked grant, a lost session, restart, sealed storage, and what Lumen refuses (a sign-in page over plain http).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const mcpClient = require('../../src/features/mcp-client');
const mcpOauth = require('../../src/features/mcp-oauth');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() };
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

// One server for everything. `opts` switch behavior between steps.
function stand(opts = {}) {
  const st = { registrations: [], authorizations: [], tokens: [], refreshes: 0, mcp: [], expired: new Set(), revoked: false, dropSession: false, noRegistration: Boolean(opts.noRegistration), plainAuthorize: Boolean(opts.plainAuthorize), noMetadata: Boolean(opts.noMetadata), codes: new Map(), live: new Set(), refreshTokens: new Set(), seq: 0, sessions: new Set() };
  let base = '';
  const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, base);
      if (req.method === 'GET' && u.pathname === '/.well-known/oauth-protected-resource/mcp') return st.noMetadata ? json(res, 404, {}) : json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read', 'write'] });
      if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server') {
        if (st.noMetadata) return json(res, 404, {});
        return json(res, 200, { issuer: base, authorization_endpoint: st.plainAuthorize ? 'http://evil.example/authorize' : `${base}/authorize`, token_endpoint: `${base}/token`, ...(st.noRegistration ? {} : { registration_endpoint: `${base}/register` }), code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'] });
      }
      if (req.method === 'POST' && u.pathname === '/register') {
        const body = JSON.parse(raw);
        st.registrations.push(body);
        return json(res, 201, { client_id: `cid-${st.registrations.length}`, redirect_uris: body.redirect_uris });
      }
      if (req.method === 'POST' && u.pathname === '/token') {
        const p = new URLSearchParams(raw);
        st.tokens.push(Object.fromEntries(p));
        if (p.get('grant_type') === 'authorization_code') {
          const c = st.codes.get(p.get('code'));
          if (!c || sha256(p.get('code_verifier') || '') !== c.challenge || p.get('redirect_uri') !== c.redirect) return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
          const rt = `rt-${++st.seq}`;
          const at = `at-${++st.seq}`;
          st.live.add(at);
          st.refreshTokens.add(rt);
          return json(res, 200, { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'Bearer' });
        }
        if (p.get('grant_type') === 'refresh_token') {
          st.refreshes++;
          if (st.revoked || !st.refreshTokens.has(p.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
          st.refreshTokens.delete(p.get('refresh_token')); // rotation: the old one is dead
          const rt = `rt-${++st.seq}`;
          const at = `at-${++st.seq}`;
          st.live.add(at);
          st.refreshTokens.add(rt);
          return setTimeout(() => json(res, 200, { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'Bearer' }), 30);
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (u.pathname === '/mcp') {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer /, '');
        if (!st.live.has(token) || st.expired.has(token)) return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"` });
        st.mcp.push({ method: req.method, auth, session: req.headers['mcp-session-id'] || null });
        if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        const msg = JSON.parse(raw);
        if (msg.id === undefined) { res.writeHead(202); return res.end(); }
        if (msg.method === 'initialize') {
          const sid = `sess-${st.sessions.size + 1}`;
          st.sessions.add(sid);
          return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'o', version: '1' } } }, { 'mcp-session-id': sid });
        }
        if (st.dropSession && req.headers['mcp-session-id']) { st.dropSession = false; st.sessions.delete(req.headers['mcp-session-id']); res.writeHead(404); return res.end(); }
        if (msg.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'shout', description: 'Upper-cases text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
        if (msg.method === 'tools/call') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(msg.params.arguments.text || '').toUpperCase() }] } });
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve({ st, base, url: `${base}/mcp`, stop: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) }); }));
}

// The "browser": opened with the sign-in address, it approves (or refuses) by calling the loopback redirect the way a browser would.
const browser = (st, { deny = false, wrongState = false } = {}) => async (url) => {
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams);
  st.authorizations.push(q);
  const code = `code-${st.authorizations.length}`;
  st.codes.set(code, { challenge: q.code_challenge, redirect: q.redirect_uri });
  const back = new URL(q.redirect_uri);
  if (deny) back.searchParams.set('error', 'access_denied'); else back.searchParams.set('code', code);
  back.searchParams.set('state', wrongState ? 'not-the-state' : q.state);
  setTimeout(() => fetch(back).catch(() => {}), 20);
};

async function main() {
  const s = await stand();
  const st = s.st;
  console.log('--- discovery');
  const meta = await mcpOauth.discover({ fetch, serverUrl: s.url, challenge: mcpOauth.parseChallenge(`Bearer resource_metadata="${s.base}/.well-known/oauth-protected-resource/mcp", scope="read"`) });
  check('discovery follows the pointer in the 401 to the authorization server and its sign-in, token and registration addresses', meta.authEndpoint === `${s.base}/authorize` && meta.tokenEndpoint === `${s.base}/token` && meta.registrationEndpoint === `${s.base}/register` && meta.resource === s.url && meta.scope === 'read', JSON.stringify(meta));
  const probed = await mcpOauth.discover({ fetch, serverUrl: s.url });
  check('without the pointer, the well-known address of the server is tried (and its scopes used)', probed.tokenEndpoint === `${s.base}/token` && probed.scope === 'read write', JSON.stringify(probed));
  check('a challenge is read: Bearer with quoted values; anything else is nothing', mcpOauth.parseChallenge('Bearer resource_metadata="https://a/b", error=invalid_token').resource_metadata === 'https://a/b' && mcpOauth.parseChallenge('Bearer error=invalid_token').error === 'invalid_token' && !Object.keys(mcpOauth.parseChallenge('Basic realm="x"')).length, '');
  const plain = await stand({ plainAuthorize: true });
  const plainErr = await mcpOauth.discover({ fetch, serverUrl: plain.url }).then(() => '', (e) => e.message);
  check('a sign-in page over plain http (not this computer) is refused: no token goes anywhere unencrypted', /https/.test(plainErr), plainErr);
  await plain.stop();

  console.log('--- the client: sign in');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcp-oauth-'));
  const make = (extra = {}) => mcpClient.create({ userData, version: '1.0.0', secrets: fakeSecrets, openExternal: browser(st), signInMs: 4000, ...extra });
  let client = make();
  const id = client.save({ name: 'oa', type: 'http', url: s.url, auth: 'oauth', preset: 'oa' }).find((x) => x.name === 'oa').id;
  let row = client.list()[0];
  check('a new OAuth server shows as needing a sign-in, with no token and no header', row.auth === 'oauth' && row.needsAuth && !row.signedIn && row.header === '' && row.preset === 'oa', JSON.stringify(row));
  await client.refresh(id);
  row = client.list()[0];
  check('starting it before signing in says to sign in (state error, needsAuth), and the AI gets no tools from it', row.state === 'error' && row.needsAuth && /Sign in/.test(row.error) && (await client.tools()).defs.length === 0, JSON.stringify(row));
  check('…without sending anything to the sign-in service', st.registrations.length === 0 && st.tokens.length === 0, '');
  await client.signIn(id);
  row = client.list()[0];
  check('signing in: the server starts and its tool is listed', row.state === 'ready' && row.signedIn && !row.needsAuth && row.tools.length === 1, JSON.stringify(row));
  const reg = st.registrations[0];
  check('Lumen registered itself once, as a native app with a loopback redirect and no client secret', st.registrations.length === 1 && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(reg.redirect_uris[0]) && reg.token_endpoint_auth_method === 'none' && reg.grant_types.includes('refresh_token') && reg.client_name === 'Lumen', JSON.stringify(reg));
  const az = st.authorizations[0];
  check('the sign-in page got the PKCE challenge (S256), the state, the redirect, the resource and the scope', az.response_type === 'code' && az.client_id === 'cid-1' && az.code_challenge_method === 'S256' && az.code_challenge.length >= 43 && az.state.length >= 16 && az.redirect_uri === reg.redirect_uris[0] && az.resource === s.url && az.scope === 'read', JSON.stringify(az));
  const t0 = st.tokens[0];
  check('the token request proved the PKCE verifier (the server checked it against the challenge) and named the resource, with no client secret', t0.grant_type === 'authorization_code' && t0.client_id === 'cid-1' && t0.resource === s.url && !('client_secret' in t0) && st.live.size === 1, JSON.stringify(t0));
  const out = await client.call('oa__shout', { text: 'hello' });
  check('a call carries the bearer token and returns the tool’s answer, marked untrusted', /HELLO/.test(out) && /untrusted_page_content/.test(out) && st.mcp.filter((m) => m.method === 'POST').every((m) => /^Bearer at-/.test(m.auth)), out);
  const disk = fs.readFileSync(path.join(userData, 'mcp-servers.json'), 'utf8');
  const sealed = JSON.parse(disk).servers[0].oauth;
  check('the tokens are kept sealed in the server’s entry: no plain token, client id or refresh token in the file', typeof sealed === 'string' && !/rt-|at-|cid-1/.test(disk) && JSON.parse(fakeSecrets.decrypt(sealed)).refresh === 'rt-1', disk);
  check('the page’s list never holds a token', !/rt-|at-/.test(JSON.stringify(client.list())), '');

  console.log('--- refresh');
  st.expired.add('at-2'); // the access token ran out
  const again = await client.call('oa__shout', { text: 'again' });
  check('an access token the server refuses is refreshed once and the call goes through', /AGAIN/.test(again) && st.refreshes === 1, `${again} refreshes=${st.refreshes}`);
  check('the rotated refresh token is saved at once (the old one is dead at the server)', JSON.parse(fakeSecrets.decrypt(JSON.parse(fs.readFileSync(path.join(userData, 'mcp-servers.json'), 'utf8')).servers[0].oauth)).refresh === 'rt-3' && st.tokens.at(-1).refresh_token === 'rt-1' && st.tokens.at(-1).grant_type === 'refresh_token' && st.tokens.at(-1).resource === s.url, JSON.stringify(st.tokens.at(-1)));
  for (const t of st.live) st.expired.add(t);
  const [a, b, c] = await Promise.all([client.call('oa__shout', { text: 'a' }), client.call('oa__shout', { text: 'b' }), client.call('oa__shout', { text: 'c' })]);
  check('three calls at once after expiry share one refresh (a rotated token used twice would end the grant)', /A/.test(a) && /B/.test(b) && /C/.test(c) && st.refreshes === 2, `refreshes=${st.refreshes}`);

  console.log('--- a lost session, restart');
  st.dropSession = true;
  const lost = await client.call('oa__shout', { text: 'x' }).then(() => '', (e) => e.message);
  const after = await client.call('oa__shout', { text: 'next' });
  check('a server that forgot our session (404): that call says so, the next one starts a new session and works', /ended the session/.test(lost) && /NEXT/.test(after), `${lost} | ${after}`);
  client.stopAll();
  client = make();
  const restarted = await client.refresh(id);
  check('after a restart the saved sign-in is used: the server starts without asking again, and no second client was registered', restarted[0].state === 'ready' && restarted[0].signedIn && st.registrations.length === 1 && st.authorizations.length === 1, JSON.stringify(restarted[0]));

  console.log('--- revoked, canceled, not possible');
  st.revoked = true;
  for (const t of st.live) st.expired.add(t);
  const revoked = await client.call('oa__shout', { text: 'z' }).then(() => '', (e) => e.message);
  row = client.list()[0];
  check('a refresh the server refuses (the grant is gone): the call says to sign in again, and the server card turns to Needs sign-in', /Sign in/.test(revoked) && row.needsAuth && !row.signedIn, `${revoked} ${JSON.stringify(row)}`);
  check('…the saved client stays so signing in again is one click', JSON.parse(fakeSecrets.decrypt(JSON.parse(fs.readFileSync(path.join(userData, 'mcp-servers.json'), 'utf8')).servers[0].oauth)).clientId === 'cid-1', '');
  st.revoked = false;
  const denyClient = make({ openExternal: browser(st, { deny: true }) });
  const denied = await denyClient.signIn(id).then(() => '', (e) => e.message);
  check('the user saying no in the browser: a plain message, nothing saved, the server is still there', /canceled/i.test(denied) && denyClient.list()[0].needsAuth && denyClient.list().length === 1, denied);
  denyClient.stopAll();
  const forged = await make({ openExternal: browser(st, { wrongState: true }) }).signIn(id).then(() => 'signed in', (e) => e.message);
  check('a redirect with the wrong state is ignored (the sign-in waits, then times out); it never signs in', /timed out/i.test(forged), forged);
  const regsBefore = st.registrations.length;
  client = make();
  await client.signIn(id);
  row = client.list()[0];
  check('signing in again after a revoked grant works, with the same client (no new registration while its port is free)', row.state === 'ready' && row.signedIn && st.registrations.length === regsBefore && /AGAIN/.test(await client.call('oa__shout', { text: 'again' })), `${JSON.stringify(row)} regs=${st.registrations.length}`);

  const none = await stand({ noRegistration: true });
  const c2 = mcpClient.create({ userData: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcp-oauth2-')), version: '1', secrets: fakeSecrets, openExternal: browser(none.st), signInMs: 3000 });
  const id2 = c2.save({ name: 'noreg', type: 'http', url: none.url, auth: 'oauth' }).find((x) => x.name === 'noreg').id;
  const noRegErr = await c2.signIn(id2).then(() => '', (e) => e.message);
  check('a server with no automatic sign-in setup says so and suggests a header instead, and nothing was opened in the browser', /registered|header/i.test(noRegErr) && none.st.authorizations.length === 0, noRegErr);
  c2.stopAll();
  await none.stop();
  const fallback = await stand({ noMetadata: true });
  const meta3 = await mcpOauth.discover({ fetch, serverUrl: fallback.url });
  check('a server that publishes no metadata gets the default /authorize, /token and /register on its own host', meta3.authEndpoint === `${fallback.base}/authorize` && meta3.tokenEndpoint === `${fallback.base}/token` && meta3.registrationEndpoint === `${fallback.base}/register`, JSON.stringify(meta3));
  await fallback.stop();

  console.log('--- editing and removing');
  const edited = client.save({ id, name: 'oa', type: 'http', url: s.url, auth: 'oauth' });
  check('saving the server again with the same address keeps the sign-in', edited[0].signedIn, JSON.stringify(edited[0]));
  const moved = client.save({ id, name: 'oa', type: 'http', url: `${s.url}/` });
  check('a different address drops it (a token is for one server)', !moved[0].signedIn && moved[0].needsAuth, JSON.stringify(moved[0]));
  let headerErr = '';
  try { client.save({ id, name: 'oa', type: 'http', url: s.url, auth: 'oauth', header: { name: 'Authorization', value: 'x' } }); } catch (e) { headerErr = e.message; }
  check('OAuth and a header together are refused', /header/.test(headerErr), headerErr);
  await client.signIn(id).catch(() => {});
  client.remove(id);
  check('removing the server removes its sign-in with it', !/oauth/.test(fs.readFileSync(path.join(userData, 'mcp-servers.json'), 'utf8')) && client.list().length === 0, fs.readFileSync(path.join(userData, 'mcp-servers.json'), 'utf8'));

  client.stopAll();
  await s.stop();
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(), 300);
}).catch((err) => { console.log(`FAIL  no exceptions  -> ${err.stack}`); process.exit(1); });
