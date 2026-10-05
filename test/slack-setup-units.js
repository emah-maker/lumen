// The guided Slack setup: the prefilled create-app link (scopes, redirect, URL-encoding), the setup
// window's navigation rule, the redirect interception (with fakes for the window and the clipboard), and
// the paste parser. Run from test/slack-units.js.
const { EventEmitter } = require('events');
const SL = require('../src/features/slack-view');
const Setup = require('../src/features/slack-setup');

class FakeContents extends EventEmitter {
  constructor() { super(); this.loaded = []; this.destroyed = false; this.session = { setPermissionRequestHandler: (fn) => { this.permission = fn; } }; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  loadURL(u) { this.loaded.push(u); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
}
function fakeWindowClass(made) {
  return class FakeWindow extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.webContents = new FakeContents(); this.gone = false; made.push(this); }
    loadURL(u) { return this.webContents.loadURL(u); }
    isDestroyed() { return this.gone; }
    destroy() { this.gone = true; this.webContents.destroyed = true; this.emit('closed'); }
  };
}
const nav = (win, kind, url) => { let prevented = false; win.webContents.emit(kind, { preventDefault: () => { prevented = true; } }, url); return prevented; };

module.exports = async function slackSetupUnits(check) {
  // ---- the create-app link ----
  const link = new URL(SL.manifestUrl({ name: 'Eric Mah' }));
  const m = JSON.parse(link.searchParams.get('manifest_json'));
  check('slack link: it is Slack’s create-app page with the manifest in the address', link.origin === 'https://api.slack.com' && link.pathname === '/apps' && link.searchParams.get('new_app') === '1', link.href);
  check('slack link: the app is named for the user and asks for exactly the read-only user scopes, no bot scopes', m.display_information.name === 'Lumen for Eric Mah' && JSON.stringify(m.oauth_config.scopes.user) === JSON.stringify(SL.USER_SCOPES) && !m.oauth_config.scopes.bot && !m.features?.bot_user, JSON.stringify(m.oauth_config));
  check('slack link: every scope in it is a read scope', m.oauth_config.scopes.user.every((s) => /^(channels|groups|im|mpim|users):(read|history)$/.test(s)), m.oauth_config.scopes.user.join());
  check('slack link: the redirect is the https default, and token rotation, sockets and org deploy are off', JSON.stringify(m.oauth_config.redirect_urls) === JSON.stringify([SL.DEFAULT_REDIRECT]) && m.settings.token_rotation_enabled === false && m.settings.socket_mode_enabled === false && m.settings.org_deploy_enabled === false, JSON.stringify(m.settings));
  const raw = SL.manifestUrl({ name: 'A&B "x" <y>\u0000 #1' });
  check('slack link: the manifest is URL-encoded (no raw braces, quotes, spaces, # or & inside the value) and survives a round trip', !/[{}" #<>]/.test(raw.split('manifest_json=')[1]) && new URL(raw).searchParams.get('manifest_json') === JSON.stringify(SL.manifest({ name: 'A&B "x" <y>\u0000 #1' })) && !/[<>"]/.test(JSON.parse(new URL(raw).searchParams.get('manifest_json')).display_information.name), raw.slice(0, 120));
  check('slack link: the name never passes 35 characters (Slack’s limit) and falls back to Lumen', SL.appName('x'.repeat(200)).length <= 35 && SL.appName('') === 'Lumen' && SL.appName(undefined) === 'Lumen', SL.appName('x'.repeat(200)));
  check('slack link: a custom https redirect is carried, an http one is replaced by the default', SL.manifest({ redirectUri: 'https://example.com/cb' }).oauth_config.redirect_urls[0] === 'https://example.com/cb' && SL.manifest({ redirectUri: 'http://127.0.0.1/cb' }).oauth_config.redirect_urls[0] === SL.DEFAULT_REDIRECT, '');

  // ---- what the setup window may load ----
  const g = (u, r) => SL.guardNavigation(u, r);
  check('slack window: slack.com and its subdomains over https are allowed', g('https://slack.com/oauth/v2/authorize?x=1') === 'allow' && g('https://api.slack.com/apps') === 'allow' && g('https://muse.slack.com/signin') === 'allow', '');
  check('slack window: anything else is blocked (http, other hosts, look-alikes, userinfo, junk schemes)', ['http://slack.com/', 'https://evil.test/', 'https://slack.com.evil.test/', 'https://notslack.com/', 'https://u:p@slack.com/', 'javascript:alert(1)', 'file:///c:/x', 'lumen://settings', 'nope'].every((u) => g(u) === 'block'), '');
  check('slack window: the redirect address is recognised (any query), only on its exact host and path', g('https://localhost/lumen-slack?code=a&state=b') === 'redirect' && g('https://localhost/other') === 'block' && g('https://localhost:8443/lumen-slack') === 'block' && g('https://example.com/cb?code=1', 'https://example.com/cb') === 'redirect', g('https://localhost/lumen-slack'));
  check('slack window: after Create, the app page leads on to its OAuth page; other pages do not', SL.oauthPageFor('https://api.slack.com/apps/A0123ABCDE/general') === 'https://api.slack.com/apps/A0123ABCDE/oauth' && SL.oauthPageFor('https://api.slack.com/apps/A0123ABCDE') === 'https://api.slack.com/apps/A0123ABCDE/oauth' && SL.oauthPageFor('https://api.slack.com/apps/A0123ABCDE/oauth') === '' && SL.oauthPageFor('https://api.slack.com/apps?new_app=1') === '' && SL.oauthPageFor('https://evil.test/apps/A0123ABCDE/general') === '', '');

  // ---- the window: redirect interception ----
  const made = [];
  const setup = Setup.create({ BrowserWindow: fakeWindowClass(made), clipboard: { readText: () => '' } });
  const got = [];
  let closed = 0;
  setup.open('https://slack.com/oauth/v2/authorize?client_id=1.2', { redirectUri: SL.DEFAULT_REDIRECT, onRedirect: (a) => got.push(a), onClosed: () => { closed++; } });
  const win = made[0];
  const wp = win.opts.webPreferences;
  check('slack window: it is sandboxed, isolated, has no node, no webview, no preload and a non-persistent session', wp.sandbox === true && wp.contextIsolation === true && wp.nodeIntegration === false && wp.webviewTag === false && !wp.preload && wp.partition && !wp.partition.startsWith('persist:'), JSON.stringify(wp));
  check('slack window: it loads the approval page it was given', win.webContents.loaded[0] === 'https://slack.com/oauth/v2/authorize?client_id=1.2', '');
  check('slack window: a slack.com navigation goes through, a foreign one is stopped', nav(win, 'will-navigate', 'https://slack.com/signin') === false && nav(win, 'will-navigate', 'https://evil.test/x') === true && got.length === 0, '');
  let permitted = null;
  win.webContents.permission(null, 'media', (v) => { permitted = v; });
  check('slack window: permission requests (camera, notifications, …) are refused', permitted === false, String(permitted));
  const popup = win.webContents.openHandler({ url: 'https://evil.test/' });
  const popup2 = win.webContents.openHandler({ url: 'https://slack.com/help' });
  check('slack window: new windows are never opened; a slack.com link loads in place, a foreign one nowhere', popup.action === 'deny' && popup2.action === 'deny', '');
  await new Promise((r) => setImmediate(r));
  check('slack window: (the slack.com popup was loaded in the same window, the foreign one was not)', win.webContents.loaded.includes('https://slack.com/help') && !win.webContents.loaded.includes('https://evil.test/'), JSON.stringify(win.webContents.loaded));
  const back = 'https://localhost/lumen-slack?code=CODE1&state=abc';
  const stopped = nav(win, 'will-redirect', back);
  check('slack window: when Slack sends the window to the redirect address the navigation is stopped (nothing reaches localhost), the address is handed over once and the window closes', stopped === true && got.length === 1 && got[0] === back && win.gone && closed === 1, JSON.stringify(got));
  nav(win, 'will-navigate', back);
  check('slack window: a second hit on the redirect address is ignored', got.length === 1, '');
  check('slack window: it refuses to open on a non-slack address', (() => { try { setup.open('https://evil.test/', {}); return false; } catch { return true; } })() && made.length === 1, '');

  // creating the app: the window follows the app page on to the token page, once
  const made2 = [];
  const setup2 = Setup.create({ BrowserWindow: fakeWindowClass(made2), clipboard: { readText: () => '' } });
  setup2.open(SL.manifestUrl({ name: 'x' }), { followToTokenPage: true });
  const w2 = made2[0];
  w2.webContents.emit('did-navigate', {}, 'https://api.slack.com/apps/A0123ABCDE/general');
  w2.webContents.emit('did-navigate', {}, 'https://api.slack.com/apps/A0123ABCDE/general');
  check('slack window: after Create it opens the OAuth & Permissions page of the new app, once', w2.webContents.loaded.filter((u) => u.endsWith('/A0123ABCDE/oauth')).length === 1, JSON.stringify(w2.webContents.loaded.map((u) => u.slice(0, 60))));
  setup2.close();

  // ---- the clipboard watch ----
  let clip = '';
  const tokens = [];
  const setup3 = Setup.create({ BrowserWindow: fakeWindowClass([]), clipboard: { readText: () => clip } });
  setup3.watchClipboard((t) => tokens.push(t), 5000, 10);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  clip = 'my shopping list';
  await wait(40);
  clip = 'xoxb-1234-5678-abcdefghij';
  await wait(40);
  clip = 'password xoxp-1111-2222-abcdefghij';
  await wait(40);
  check('slack clipboard: other text, a bot token and a token inside other text are all ignored', tokens.length === 0 && setup3.watching(), JSON.stringify(tokens));
  clip = 'xoxp-1111-2222-abcdefghij\n';
  await wait(60);
  check('slack clipboard: a copied user token is taken once and the watch ends', tokens.length === 1 && tokens[0] === 'xoxp-1111-2222-abcdefghij' && !setup3.watching(), JSON.stringify(tokens));
  const setup4 = Setup.create({ BrowserWindow: fakeWindowClass([]), clipboard: { readText: () => 'xoxp-1111-2222-abcdefghij' } });
  const late = [];
  setup4.watchClipboard((t) => late.push(t), 30, 10);
  await wait(80);
  check('slack clipboard: the watch gives up after its time limit', !setup4.watching(), '');
  setup4.stopWatch();

  // ---- the paste parser ----
  const P = SL.parseCredentials;
  const id = '1234567890.1234567890';
  const sec = '0123456789abcdef0123456789abcdef';
  const sign = 'fedcba9876543210fedcba9876543210';
  check('slack paste parser: a user token alone', P('xoxp-1111-2222-abcdefghij').token === 'xoxp-1111-2222-abcdefghij' && !P('xoxp-1111-2222-abcdefghij').clientId, '');
  check('slack paste parser: whatever surrounds the token is dropped', P('Token: "xoxp-1111-2222-abcdefghij"\n').token === 'xoxp-1111-2222-abcdefghij' && P('xoxe.xoxp-1-abcdefghijk').token === 'xoxe.xoxp-1-abcdefghijk', '');
  check('slack paste parser: a bot token is not a user token', P('xoxb-1111-2222-abcdefghij').token === '', '');
  const lab = P(`Client ID\n${id}\nClient Secret\n${sec}\nSigning Secret\n${sign}`);
  check('slack paste parser: Basic Information copied whole gives the Client ID and the Client Secret, not the Signing Secret', lab.clientId === id && lab.clientSecret === sec, JSON.stringify(lab));
  const rev = P(`Signing Secret: ${sign}\nClient Secret: ${sec}\nClient ID: ${id}`);
  check('slack paste parser: the order does not matter', rev.clientId === id && rev.clientSecret === sec, JSON.stringify(rev));
  const bare = P(`${id} ${sec}`);
  check('slack paste parser: the two values on one line, unlabelled, in either order', bare.clientId === id && bare.clientSecret === sec && P(`${sec},${id}`).clientSecret === sec, JSON.stringify(bare));
  const amb = P(`${id}\n${sec}\n${sign}`);
  check('slack paste parser: two unlabelled 32-character values are ambiguous, so no secret is guessed', amb.clientId === id && amb.clientSecret === '', JSON.stringify(amb));
  check('slack paste parser: a Client ID alone, a secret alone, junk and non-strings', P(id).clientId === id && !P(id).clientSecret && P(`Client Secret ${sec}`).clientSecret === sec && !P('hello').clientId && !P(null).token && !P(42).clientId, '');
  const huge = P(`${'a '.repeat(10000)}${id}`);
  check('slack paste parser: only the start of a huge paste is read', huge.clientId === '', '');
};
