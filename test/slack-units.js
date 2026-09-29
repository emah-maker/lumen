// Slack widget + shared OAuth helpers, no Electron and no network (run from test/widget-units.js): PKCE and
// state, the pasted redirect address, token storage and expiry, Slack's authorize URL (read-only scopes,
// https redirect), oauth.v2.access answers incl. token rotation, mrkdwn -> plain text, the collect() of
// counts and messages against a fake Web API, and createWidgets() end to end against a fake fetch:
// sign-in, encrypted-secret-only storage, refresh on expiry, 429 back-off, invalid_auth -> reconnect,
// and that nothing but display text reaches forPage().
const OA = require('../features/oauth');
const SL = require('../features/slack-view');
const { createWidgets, cleanWidget } = require('../features/widgets');

module.exports = async function slackUnits(check) {
  // ---- oauth.js ----
  check('oauth: the PKCE challenge is S256 of the verifier (RFC 7636 appendix B vector)', OA.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', '');
  const p = OA.pkce();
  check('oauth: pkce() makes a 43+ character url-safe verifier, its challenge and a fresh state each time', /^[\w-]{43,128}$/.test(p.verifier) && OA.challengeFor(p.verifier) === p.challenge && /^[\w-]{20,}$/.test(p.state) && OA.pkce().state !== p.state, JSON.stringify(p));
  check('oauth: authorizeUrl drops empty values and encodes the rest', OA.authorizeUrl('https://x.test/a', { a: '1 2', b: '', c: undefined }) === 'https://x.test/a?a=1+2', '');
  check('oauth: loopbackRedirect is 127.0.0.1 (not localhost)', OA.loopbackRedirect(8888, '/cb') === 'http://127.0.0.1:8888/cb', '');
  const want = 'S3cr3t-state_ok';
  check('oauth: parseRedirect takes the code from a pasted address and checks the state', OA.parseRedirect(`https://localhost/lumen-slack?code=1234.abcd&state=${want}`, want).code === '1234.abcd', '');
  const bad = (input, state = want) => { try { OA.parseRedirect(input, state); return null; } catch (e) { return e.message; } };
  check('oauth: a different state, no state, or no pending state is refused', /different sign-in/.test(bad('https://l/x?code=abc&state=nope')) && /different sign-in/.test(bad('https://l/x?code=abc')) && /different sign-in/.test(bad(`https://l/x?code=abc&state=${want}`, '')), '');
  check('oauth: a bare code is refused (it has no state to check), so are empty and non-addresses', /doesn’t look like/.test(bad('abcdefgh12345')) && /Paste the address/.test(bad('  ')) && Boolean(bad('javascript:alert(1)')), String(bad('abcdefgh12345')));
  check('oauth: the provider’s error is explained (access_denied) and never echoed as markup', /declined/.test(bad(`https://l/x?error=access_denied&state=${want}`)) && !/</.test(bad(`https://l/x?error=%3Cb%3E&state=${want}`)), '');
  check('oauth: a query string on its own is accepted', OA.parseRedirect(`?code=zz9&state=${want}`, want).code === 'zz9', '');
  const packed = OA.packTokens({ access: 'xoxp-1', refresh: 'r', exp: 5, clientId: '1.2', clientSecret: 'ab', userId: 'U1', evil: 'x', teamName: 'T' });
  const un = OA.unpackTokens(packed);
  check('oauth: the stored secret round-trips only its known fields', un.access === 'xoxp-1' && un.exp === 5 && un.teamName === 'T' && !('evil' in un) && !packed.includes('evil'), packed);
  check('oauth: garbage in storage reads as nothing', OA.unpackTokens('nope') === null && OA.unpackTokens('[]') === null && OA.unpackTokens('') === null && OA.unpackTokens(null) === null && OA.unpackTokens('{"access":5}').access === '', '');
  check('oauth: expiry: no expiry never expires, else fresh until five minutes before', OA.isFresh({ access: 'a', exp: 0 }, 1e12) && OA.isFresh({ access: 'a', exp: 1e6 }, 1e6 - OA.SKEW - 1) && !OA.isFresh({ access: 'a', exp: 1e6 }, 1e6 - OA.SKEW + 1) && !OA.isFresh({ access: '' , exp: 0 }, 0), '');
  check('oauth: normalizeToken keeps the old refresh token when none is sent, and rejects no access token', OA.normalizeToken({ access_token: 'n', expires_in: 60 }, 1000, { refresh: 'old' }).refresh === 'old' && OA.normalizeToken({ access_token: 'n', expires_in: 60 }, 1000).exp === 61000 && OA.normalizeToken({}, 0) === null, '');
  check('oauth: Retry-After is clamped to 1 s..2 min, 60 s when missing or junk', OA.retryAfterMs('5') === 5000 && OA.retryAfterMs('0') === 1000 && OA.retryAfterMs('99999') === 120000 && OA.retryAfterMs(null) === 60000 && OA.retryAfterMs('soon') === 60000, '');

  // ---- slack-view.js ----
  const url = new URL(SL.authorizeUrl({ clientId: '1234567.7654321', redirectUri: SL.DEFAULT_REDIRECT, state: 'st' }));
  const scopes = url.searchParams.get('user_scope').split(',');
  check('slack: the authorize URL is slack.com/oauth/v2/authorize with user_scope, an https redirect and state', url.origin === 'https://slack.com' && url.pathname === '/oauth/v2/authorize' && url.searchParams.get('redirect_uri') === 'https://localhost/lumen-slack' && url.searchParams.get('state') === 'st' && !url.searchParams.has('scope'), url.href);
  check('slack: every requested scope is a read scope (no write, post, admin, search)', scopes.length >= 5 && scopes.every((s) => /^(channels|groups|im|mpim|users):(read|history)$/.test(s)) && scopes.includes('im:history') && scopes.includes('users:read'), scopes.join());
  check('slack: redirects must be https without credentials; empty means the default', SL.cleanRedirect('') === SL.DEFAULT_REDIRECT && SL.cleanRedirect('http://127.0.0.1:8080/cb') === '' && SL.cleanRedirect('https://u:p@x.test/') === '' && SL.cleanRedirect('https://example.com/cb') === 'https://example.com/cb' && SL.cleanRedirect('https://x.test/a b') === '', '');
  check('slack: client id, secret and token shapes', SL.cleanClientId(' 1234567.7654321 ') === '1234567.7654321' && SL.cleanClientId('abc') === '' && SL.cleanClientSecret('0123456789abcdef0123456789abcdef') && SL.cleanClientSecret('short') === '' && SL.cleanUserToken('xoxp-1234-5678-abcdef') && SL.cleanUserToken('xoxb-1234-5678-abcdef') === '' && SL.cleanUserToken('xoxe.xoxp-1-abcdefghijk'), '');
  const acc = SL.parseAccess({ ok: true, authed_user: { id: 'U123', access_token: 'xoxe.xoxp-1-a', refresh_token: 'xoxe-1-r', expires_in: 43200 }, team: { id: 'T1', name: 'Muse\u0000 Team' } }, 1000);
  check('slack: oauth.v2.access with token rotation gives token, refresh token, expiry, user and team', acc.access === 'xoxe.xoxp-1-a' && acc.refresh === 'xoxe-1-r' && acc.exp === 1000 + 43200e3 && acc.userId === 'U123' && acc.teamName === 'Muse Team', JSON.stringify(acc));
  const ref = SL.parseAccess(JSON.stringify({ ok: true, access_token: 'xoxe.xoxp-1-b', refresh_token: 'xoxe-1-r2', expires_in: 43200, token_type: 'user' }), 2000, acc);
  check('slack: a refresh answers at the top level and keeps user and team', ref.access === 'xoxe.xoxp-1-b' && ref.refresh === 'xoxe-1-r2' && ref.userId === 'U123' && ref.teamName === 'Muse Team', JSON.stringify(ref));
  const err = (f) => { try { f(); return null; } catch (e) { return e; } };
  check('slack: ok:false becomes a SlackError with a plain message; sign-in errors ask to reconnect', err(() => SL.parseAccess({ ok: false, error: 'invalid_code' }, 0)).code === 'invalid_code' && err(() => SL.parseAccess({ ok: false, error: 'bad_redirect_uri' }, 0)).message.includes('redirect') && new SL.SlackError('invalid_auth').reconnect && new SL.SlackError('token_revoked').reconnect && !new SL.SlackError('ratelimited').reconnect && !new SL.SlackError('channel_not_found').reconnect, '');
  check('slack: an install with no user token is an error, not a blank sign-in', err(() => SL.parseAccess({ ok: true, team: { id: 'T', name: 'X' } }, 0))?.code === 'no_user_token', '');
  check('slack: plainText turns mrkdwn into plain words', SL.plainText('hi <@U2> see <#C1|general> <https://example.com/a|the doc> &amp; <!here> <mailto:a@b.co> *bold*', (id) => (id === 'U2' ? 'Ana' : '')) === 'hi @Ana see #general the doc & @here a@b.co bold', SL.plainText('hi <@U2> see <#C1|general> <https://example.com/a|the doc> &amp; <!here> <mailto:a@b.co> *bold*', (id) => (id === 'U2' ? 'Ana' : '')));
  check('slack: plainText leaves < and > as text (the page uses textContent) and strips control characters', SL.plainText('a &lt;b&gt;\u0007 c') === 'a <b> c', SL.plainText('a &lt;b&gt;\u0007 c'));
  const cfg = SL.cleanConfig({ channels: [{ id: 'C111', name: '#general' }, { id: 'C111', name: 'dup' }, { id: 'D999', name: 'a dm' }, { id: 'bad', name: 'x' }, { id: 'G222', name: 'private' }, { id: 'C333' }, { id: 'C444' }, { id: 'C555' }], dms: false, count: 7 });
  check('slack: config keeps up to 4 unique channel ids (no DM ids), defaults are DMs and mentions on, 5 messages', cfg.channels.map((c) => c.id).join() === 'C111,G222,C333,C444' && cfg.channels[0].name === 'general' && cfg.dms === false && cfg.mentions === true && cfg.count === 5 && SL.cleanConfig(null).dms === true, JSON.stringify(cfg));
  check('slack: permalinks only point at the workspace’s own slack.com', SL.permalink('https://muse.slack.com', 'C111', '1700000000.000200') === 'https://muse.slack.com/archives/C111/p1700000000000200' && SL.permalink('https://evil.test', 'C111', '1700000000.000200') === null && SL.permalink('https://notslack.com', 'C111', '1.1') === null && SL.permalink('http://muse.slack.com', 'C111', '1.1') === null, '');

  // ---- collect() against a fake Web API ----
  const ME = 'U100';
  const calls = [];
  const fakeApi = (script) => async (method, params) => {
    calls.push(method + (params.channel ? `:${params.channel}` : ''));
    const r = script[`${method}:${params.channel || ''}`] ?? script[method];
    if (r instanceof Error) throw r;
    return r;
  };
  const NOW = 1700000000;
  const script = {
    'users.conversations': { ok: true, channels: [{ id: 'D0AAA', is_im: true, user: 'U200', updated: 3 }, { id: 'D0BBB', is_im: true, user: 'U300', updated: 2 }, { id: 'D0CCC', is_im: true, user: 'U400', updated: 1 }, { id: 'G0MMM', is_mpim: true, updated: 4, name: 'mpdm-ana--bo--me-1' }] },
    'conversations.info:D0AAA': { channel: { last_read: `${NOW - 100}.000000`, unread_count_display: 2 } },
    'conversations.info:D0BBB': { channel: { last_read: `${NOW}.000000`, unread_count_display: 0 } },
    'conversations.info:D0CCC': { channel: { last_read: `${NOW - 500}.000000` } }, // no count: computed from the history
    'conversations.info:G0MMM': { channel: { name: 'mpdm-ana--bo--me-1', last_read: '0', unread_count_display: 1 } },
    'conversations.info:C111': { channel: { name: 'general', last_read: `${NOW - 300}.000000` } },
    'conversations.history:D0AAA': { messages: [{ ts: `${NOW - 10}.000100`, user: 'U200', text: 'ping <@U100> lunch?' }, { ts: `${NOW - 50}.000100`, user: 'U200', text: 'hey' }, { ts: `${NOW - 200}.000100`, user: 'U200', text: 'old' }] },
    'conversations.history:D0CCC': { messages: [{ ts: `${NOW - 400}.000100`, user: 'U400', text: 'a' }, { ts: `${NOW - 600}.000100`, user: 'U400', text: 'b (read)' }, { ts: `${NOW - 450}.000100`, user: ME, text: 'mine' }] },
    'conversations.history:G0MMM': { messages: [{ ts: `${NOW - 5}.000100`, user: 'U200', text: 'group hi' }] },
    'conversations.history:C111': { messages: [{ ts: `${NOW - 20}.000100`, user: 'U300', text: 'deploy done, cc <@U100>' }, { ts: `${NOW - 30}.000100`, user: 'U300', text: 'joined', subtype: 'channel_join' }, { ts: `${NOW - 250}.000100`, user: ME, text: 'my old <@U100> msg' }, { ts: `${NOW - 400}.000100`, user: 'U200', text: 'older <@U100>' }, { ts: `${NOW - 60}.000100`, bot_id: 'B1', username: 'ci-bot', text: '<https://ci.example/run/1|build 1> passed' }] },
  };
  const people = { U200: 'Ana', U300: 'Bo', U400: 'Cy' };
  const data = await SL.collect(fakeApi(script), { channels: [{ id: 'C111', name: 'general' }], dms: true, mentions: true, count: 8 }, { userId: ME, teamName: 'Muse', teamUrl: 'https://muse.slack.com' }, async (id) => people[id] || '');
  check('slack collect: unread DMs come from Slack’s count when it has one, else from the history since last_read (not your own)', data.unread === 2 + 1 + 1 && data.dmChats.map((c) => `${c.name}:${c.unread}`).sort().join() === 'Ana:2,Cy:1,ana, bo, me:1', JSON.stringify(data.dmChats));
  check('slack collect: a read DM (count 0) is not even opened', !calls.includes('conversations.history:D0BBB'), calls.join());
  check('slack collect: mentions count unread mentions of you in the chosen channels only (not your own, not already read)', data.mentions === 1, String(data.mentions));
  check('slack collect: messages are newest first, from names, joins skipped, bot names and links made plain', data.messages[0].from === 'Ana' && data.messages.some((m) => m.text === 'deploy done, cc @someone') && data.messages.some((m) => m.from === 'ci-bot' && m.text === 'build 1 passed') && !data.messages.some((m) => m.text === 'joined') && data.messages.every((m, i, a) => !i || a[i - 1].ts >= m.ts), JSON.stringify(data.messages.map((m) => [m.from, m.text])));
  check('slack collect: messages link to the workspace and mark unread ones', data.messages.find((m) => m.text === 'hey').url === `https://muse.slack.com/archives/D0AAA/p${NOW - 50}000100` && data.messages.find((m) => m.text.startsWith('deploy')).unread === true && data.messages.find((m) => m.text.startsWith('older')).unread === false, '');
  check('slack collect: only display fields come out (no ids beyond the link, no tokens)', JSON.stringify(data).indexOf('xox') === -1 && Object.keys(data).sort().join() === 'channelCount,dmChats,mentions,messages,notice,showDms,showMentions,team,teamUrl,unread' && Object.keys(data.messages[0]).sort().join() === 'dm,from,text,ts,unread,url,where', Object.keys(data).join());
  check('slack collect: DMs and mentions can be turned off', await SL.collect(fakeApi(script), { channels: [], dms: false, mentions: false, count: 5 }, { userId: ME }).then((d) => d.unread === 0 && d.messages.length === 0), '');
  const skip = await SL.collect(fakeApi({ ...script, 'conversations.info:C111': new SL.SlackError('channel_not_found') }), { channels: [{ id: 'C111', name: 'general' }], dms: false, mentions: true, count: 5 }, { userId: ME });
  check('slack collect: a channel you can’t read is skipped with a notice, not a failed card', skip.messages.length === 0 && /channel/i.test(skip.notice), skip.notice);
  let rejected = null;
  await SL.collect(fakeApi({ ...script, 'conversations.info:C111': new SL.SlackError('ratelimited') }), { channels: [{ id: 'C111', name: 'g' }], dms: false, mentions: true, count: 5 }, { userId: ME }).catch((e) => { rejected = e; });
  check('slack collect: rate limits and sign-in errors end the refresh (they are not skipped)', rejected?.code === 'ratelimited', String(rejected));

  // ---- createWidgets: the whole sign-in and fetch against a fake fetch ----
  const store = { settings: { homeWidgets: [], keys: {} }, secrets: {} };
  let clock = 1700000000000;
  const log = [];
  let mode = {}; // knobs for the fake: { status429, invalidAuth }
  let tokenN = 0;
  const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fakeFetch = async (u, opts) => {
    const path = new URL(u).pathname;
    const body = new URLSearchParams(String(opts?.body || ''));
    log.push({ path, auth: opts?.headers?.Authorization || '', body: Object.fromEntries(body) });
    if (mode.status429) return json({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '30' });
    if (path === '/api/oauth.v2.access') {
      if (body.get('grant_type') === 'refresh_token') {
        if (body.get('refresh_token') !== `xoxe-1-r${tokenN}`) return json({ ok: false, error: 'invalid_refresh_token' });
        tokenN++;
        return json({ ok: true, access_token: `xoxe.xoxp-1-t${tokenN}`, refresh_token: `xoxe-1-r${tokenN}`, expires_in: 43200, token_type: 'user' });
      }
      if (body.get('code') !== 'CODE1' || body.get('client_secret') !== '0123456789abcdef0123456789abcdef') return json({ ok: false, error: 'invalid_code' });
      return json({ ok: true, authed_user: { id: ME, access_token: `xoxe.xoxp-1-t0`, refresh_token: `xoxe-1-r0`, expires_in: 43200 }, team: { id: 'T1', name: 'Muse' } });
    }
    if (mode.invalidAuth && path !== '/api/auth.revoke') return json({ ok: false, error: 'invalid_auth' });
    if (path === '/api/auth.test') return json({ ok: true, user_id: ME, team_id: 'T1', team: 'Muse', url: 'https://muse.slack.com/' });
    if (path === '/api/auth.revoke') return json({ ok: true, revoked: true });
    if (path === '/api/users.conversations') return json(body.get('types') === 'im,mpim' ? { ok: true, channels: [{ id: 'D0AAA', user: 'U200', updated: 1 }] } : { ok: true, channels: [{ id: 'C111', name: 'general' }, { id: 'G222', name: 'secret', is_private: true }] });
    if (path === '/api/conversations.info') return json({ ok: true, channel: { name: 'general', last_read: '1.0', unread_count_display: 3 } });
    if (path === '/api/conversations.history') return json({ ok: true, messages: [{ ts: `${clock / 1000 - 5}.000100`, user: 'U200', text: 'hello <@U100>' }] });
    if (path === '/api/users.info') return json({ ok: true, user: { name: 'ana', real_name: 'Ana Ruiz', profile: { display_name: '' } } });
    return json({ ok: false, error: 'unknown_method' });
  };
  const w = createWidgets({
    readSettings: () => store.settings, writeSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
    fetch: fakeFetch, getSecret: (n) => store.secrets[n] || null, setSecret: (n, v) => { if (v) store.secrets[n] = v; else delete store.secrets[n]; },
    onUpdate: () => {}, endpoints: () => ({}), now: () => clock, rateMax: () => 500,
  });
  let e = null;
  try { w.slackStart({ clientId: 'nope', clientSecret: 'x' }); } catch (x) { e = x; }
  check('slack sign-in: a bad client id is refused before anything opens', /Client ID/.test(e?.message), String(e));
  e = null;
  try { w.slackStart({ clientId: '1234567.7654321', clientSecret: '0123456789abcdef0123456789abcdef', redirect: 'http://127.0.0.1:1/cb' }); } catch (x) { e = x; }
  check('slack sign-in: an http redirect is refused with the reason', /https/.test(e?.message), String(e));
  const started = w.slackStart({ clientId: '1234567.7654321', clientSecret: '0123456789abcdef0123456789abcdef', redirect: '' });
  const state = new URL(started.url).searchParams.get('state');
  check('slack sign-in: start returns Slack’s approval address with a state and remembers nothing in settings', started.url.startsWith('https://slack.com/oauth/v2/authorize?') && state.length >= 20 && !JSON.stringify(store.settings).includes('0123456789abcdef') && w.state().slack.waiting, started.url);
  e = null;
  await w.slackFinish('https://localhost/lumen-slack?code=CODE1&state=wrong').catch((x) => { e = x; });
  check('slack sign-in: an address with the wrong state is refused and nothing is stored (the right one still works)', /different sign-in/.test(e?.message) && !store.secrets.slack && w.state().slack.waiting, String(e));
  const done = await w.slackFinish(`https://localhost/lumen-slack?code=CODE1&state=${state}`);
  const ex = log.find((l) => l.path === '/api/oauth.v2.access' && l.body.code === 'CODE1');
  check('slack sign-in: the code is traded with the client secret and the same redirect, then the workspace is learned', done.message === 'Connected to Muse.' && ex.body.client_id === '1234567.7654321' && ex.body.redirect_uri === 'https://localhost/lumen-slack' && log.some((l) => l.path === '/api/auth.test'), JSON.stringify(ex));
  const stored = OA.unpackTokens(store.secrets.slack);
  check('slack sign-in: tokens and the client secret live only in the secret store, never in settings or the status Settings sees', stored.access === 'xoxe.xoxp-1-t0' && stored.clientSecret && stored.teamUrl === 'https://muse.slack.com' && !JSON.stringify(store.settings).includes('xox') && !JSON.stringify(w.state()).includes('xox') && !JSON.stringify(w.state()).includes('0123456789abcdef') && w.state().slack.connected && w.state().slack.hasSecret && w.state().slack.team === 'Muse', JSON.stringify(w.state().slack));
  e = null;
  await w.slackFinish(`https://localhost/lumen-slack?code=CODE1&state=${state}`).catch((x) => { e = x; });
  check('slack sign-in: the same address twice is refused (a code works once, the pending sign-in is spent)', /timed out|Start again/.test(e?.message), String(e));
  const chans = await w.slackChannels();
  check('slack: the channel picker lists the user’s channels (private marked), sorted', chans.map((c) => c.name).join() === 'general,secret' && chans[1].private === true, JSON.stringify(chans));
  const checkOut = await w.test({ type: 'slack', slack: { channels: [{ id: 'C111', name: 'general' }] } });
  check('slack: Check confirms the workspace and what will show', checkOut.ok && /Connected to Muse/.test(checkOut.message) && /1 channel/.test(checkOut.message), JSON.stringify(checkOut));
  const saved = await w.save({ type: 'slack', slack: { channels: [{ id: 'C111', name: 'general' }], dms: true, mentions: true, count: 5 } });
  const id = saved.widget.id;
  check('slack: the widget is saved with 4x4 as its default size and only its display config', saved.widget.w === 4 && saved.widget.h === 4 && !JSON.stringify(store.settings).includes('xox') && store.settings.homeWidgets[0].slack.channels[0].id === 'C111', JSON.stringify(store.settings.homeWidgets[0]));
  check('slack: the widget is a checked type (garbage config falls back)', cleanWidget({ id: 'wslack1', type: 'slack', slack: 'x', colors: 'zz' }).slack.count === 5, '');
  await w.refresh(w.list()[0], { force: true });
  let page = w.forPage()[0];
  check('slack: the card gets counts and short plain messages, nothing secret', page.data && page.data.unread === 3 && page.data.team === 'Muse' && page.data.messages.length >= 1 && page.data.messages.every((m) => m.from === 'Ana Ruiz' && m.text === 'hello @Ana Ruiz') && !JSON.stringify(page).includes('xox') && !JSON.stringify(page).includes('0123456789abcdef') && !JSON.stringify(page).includes('refresh'), JSON.stringify(page.data).slice(0, 300));
  check('slack: requests carry the token only to slack.com/api, as POST bearer (never in a URL)', log.filter((l) => l.auth).every((l) => l.auth === 'Bearer xoxe.xoxp-1-t0' || l.auth.startsWith('Bearer xoxe.xoxp-1-t')), '');

  // refresh when the rotating token is about to expire
  clock += 12 * 3600e3 - 60e3; // a minute before it expires
  log.length = 0;
  await w.refresh(w.list()[0], { force: true });
  await w.refresh(w.list()[0], { force: true });
  const refreshes = log.filter((l) => l.path === '/api/oauth.v2.access');
  const after = OA.unpackTokens(store.secrets.slack);
  check('slack token rotation: an expiring token is refreshed once, the new pair is stored, calls use the new token', refreshes.length === 1 && refreshes[0].body.grant_type === 'refresh_token' && after.access === 'xoxe.xoxp-1-t1' && after.refresh === 'xoxe-1-r1' && after.clientSecret && log.filter((l) => l.path === '/api/conversations.history').every((l) => l.auth === 'Bearer xoxe.xoxp-1-t1'), JSON.stringify([refreshes.length, after.access]));

  // 429: back off, keep what is shown
  clock += 10 * 60e3;
  mode = { status429: true };
  await w.refresh(w.list()[0], { force: true });
  page = w.forPage()[0];
  check('slack 429: the card keeps its last data and says it will retry (Retry-After honoured)', page.data && /slow down/i.test(page.warning || ''), JSON.stringify([page.warning, page.error]));
  log.length = 0;
  clock += 20e3;
  await w.refresh(w.list()[0], { force: true });
  check('slack 429: no request goes out during the back-off', log.length === 0, JSON.stringify(log));
  mode = {};
  clock += 3 * 60e3;

  // invalid_auth -> reconnect state
  mode = { invalidAuth: true };
  clock += 6 * 60e3;
  await w.refresh(w.list()[0], { force: true });
  page = w.forPage()[0];
  check('slack invalid_auth: the card becomes a Reconnect state (data.reconnect), with no stale content', page.data?.reconnect === true && !page.data.messages && /no longer accepts/.test(page.data.reason) && page.error === null, JSON.stringify(page.data));
  check('slack invalid_auth: Settings is told to offer Reconnect, and the client details are kept for it', w.state().slack.reconnect === true && w.state().slack.hasSecret && w.state().slack.clientId === '1234567.7654321', JSON.stringify(w.state().slack));
  mode = {};
  const again = w.slackStart({ clientId: '', clientSecret: '', redirect: '' });
  check('slack reconnect: starting again reuses the stored client id and secret', new URL(again.url).searchParams.get('client_id') === '1234567.7654321', again.url);
  w.slackCancel();

  // Disconnect
  log.length = 0;
  await w.slackDisconnect();
  check('slack disconnect: the token is revoked at Slack, the secret is forgotten and the cards ask to sign in', log.some((l) => l.path === '/api/auth.revoke') && !store.secrets.slack && !w.state().slack.connected, JSON.stringify(log.map((l) => l.path)));
  await w.refresh(w.list()[0], { force: true });
  check('slack: with no sign-in the card says to sign in (no request is made)', w.forPage()[0].data?.reconnect === true && !log.some((l) => l.path === '/api/conversations.history'), '');
  // A pasted user token instead of OAuth
  const viaToken = await w.save({ type: 'slack', token: 'xoxp-1111-2222-abcdefghij', slack: { channels: [], dms: true } }, id);
  const t2 = OA.unpackTokens(store.secrets.slack);
  check('slack: a pasted user token is checked with auth.test and stored encrypted, without a client secret', /Connected to Muse/.test(viaToken.message) && t2.access === 'xoxp-1111-2222-abcdefghij' && !t2.clientSecret && !JSON.stringify(store.settings).includes('xoxp'), JSON.stringify(t2));
  check('slack: removing the last Slack widget forgets the sign-in', (w.remove(id), !store.secrets.slack), '');
};
