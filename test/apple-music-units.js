// The Apple Music new-tab widget, without Electron or the network: its address allow-list, the page probe,
// the shared web-player geometry it relies on (features/web-player.js), and the connector (no API call, what
// the card is told about the view, "Try again", the widget in lists and layout). Runs on its own
// (npm run test:units picks up test/*-units.js).
const WP = require('../src/features/web-player');
const AM = require('../src/features/apple-music-web');
const SW = require('../src/features/spotify-web');
const { createWidgets, cleanList } = require('../src/features/widgets');
const WL = require('../src/features/widget-layout');
const WS = require('../src/renderer/widget-summary');

module.exports = async function appleMusicUnits(check) {
  check('apple music: the card opens music.apple.com', AM.WEB_URL === 'https://music.apple.com/', AM.WEB_URL);

  const ok = ['https://music.apple.com/', 'https://music.apple.com/us/browse', 'https://music.apple.com/us/new?l=en', 'https://authorize.music.apple.com/woa?x=1', 'https://idmsa.apple.com/appleauth/auth/signin', 'https://appleid.apple.com/auth/authorize', 'https://account.apple.com/sign-in'];
  const no = ['http://music.apple.com/', 'https://music.apple.com.evil.example/', 'https://evil.example/music.apple.com', 'https://user:pw@music.apple.com/', 'https://music.apple.com:8443/', 'https://www.apple.com/', 'https://apple.com/', 'https://itunes.apple.com/', 'https://support.apple.com/', 'https://accounts.google.com/', 'https://open.spotify.com/', 'https://fakemusic.apple.com.evil.example/', 'javascript:alert(1)', 'file:///c:/x', 'data:text/html,hi', 'not a url', ''];
  check('apple music: the allow-list accepts the player and Apple\'s sign-in hosts', ok.every((u) => AM.isAllowedUrl(u)), ok.filter((u) => !AM.isAllowedUrl(u)).join(' '));
  check('apple music: the allow-list refuses look-alikes, other schemes, ports, credentials and every other host', no.every((u) => !AM.isAllowedUrl(u)), no.filter((u) => AM.isAllowedUrl(u)).join(' '));
  check('apple music: Spotify\'s hosts and Apple\'s stay separate lists', !SW.isAllowedUrl('https://music.apple.com/') && SW.isAllowedUrl('https://open.spotify.com/') && !AM.isAllowedUrl('https://accounts.spotify.com/'), '');
  check('apple music: a stand-in origin (tests only) is the only extra address allowed', AM.isAllowedUrl('https://127.0.0.1:5/web', 'https://127.0.0.1:5') && !AM.isAllowedUrl('https://127.0.0.1:5/web') && !AM.isAllowedUrl('https://127.0.0.1:6/web', 'https://127.0.0.1:5') && !AM.isAllowedUrl('http://127.0.0.1:5/web', 'http://127.0.0.1:5'), '');

  check('apple music: the page probe looks for the Apple Music card\'s slot only (a constant script)', /\.w-card\.applemusic \.sp-web-slot/.test(AM.PROBE) && !/spotify/.test(AM.PROBE) && /\.w-card\.spotify \.sp-web-slot/.test(SW.PROBE) && !/applemusic/.test(SW.PROBE), AM.PROBE);
  check('apple music: the probe hides the view while editing or with a picker open', /w-editing/.test(AM.PROBE) && /w-picker, dialog\[open\]/.test(AM.PROBE), '');

  // The shared view helpers (the same ones Spotify's tests cover through spotify-web.js)
  check('web player: only protected media is permitted (camera, mic, location, notifications, clipboard are refused)', WP.permissionAllowed('mediaKeySystem') && WP.permissionAllowed('protectedMediaIdentifier') && ['media', 'geolocation', 'notifications', 'clipboard-read', 'fullscreen', 'openExternal', 'display-capture', '', undefined].every((p) => !WP.permissionAllowed(p)), '');
  check('web player: a narrow card zooms out to a compact layout, a wide one is not zoomed', WP.layoutZoom(300) === 0.75 && WP.layoutZoom(100) === 0.5 && WP.layoutZoom(400) === 1 && WP.layoutZoom(900) === 1 && WP.layoutZoom(NaN) === 1, '');
  const page = { x: 40, y: 100, width: 800, height: 500 };
  const v = WP.viewBounds({ x: 20, y: 50, w: 300.4, h: 400.6 }, page);
  check('web player: the view is placed over the card in window coordinates and cut to the visible page', v && v.x === 60 && v.y === 150 && v.width === 300 && v.height === 401 && JSON.stringify(WP.viewBounds({ x: 700, y: 400, w: 300, h: 300 }, page)) === '{"x":740,"y":500,"width":100,"height":100}', JSON.stringify(v));
  check('web player: a card scrolled away, tiny, or a bad answer hides the view', [WP.viewBounds({ x: 0, y: 600, w: 300, h: 300 }, page), WP.viewBounds({ x: 0, y: 0, w: 20, h: 300 }, page), WP.viewBounds(null, page)].every((r) => r === null), '');
  check('web player: the Widevine check only asks the page for a yes or no', /requestMediaKeySystemAccess\('com\.widevine\.alpha'/.test(WP.DRM_PROBE) && !/fetch|XMLHttpRequest|cookie|localStorage/.test(WP.DRM_PROBE), '');
  check('web player: a failed load is told apart (offline, failed, a replaced navigation is none)', WP.loadFailure(-106) === 'offline' && WP.loadFailure(-200) === 'failed' && WP.loadFailure(-3) === null && WP.loadFailure(-106, false) === null, '');
  check('web player: the card class goes into the probe as given', WP.probeScript('applemusic').includes('.w-card.applemusic .sp-web-slot'), '');

  // The widget in the layout, the lists and the page's setup kinds
  check('apple music layout: it has size limits and the Spotify card\'s default size', WL.limitsOf('applemusic').minW >= 2 && WL.defaultSize('applemusic').h === 4 && WL.defaultSize('applemusic', 12).w === 4, JSON.stringify(WL.defaultSize('applemusic')));
  check('apple music: the picker lists it with a name and a plain line, after Spotify', WS.kindName('applemusic') === 'Apple Music' && /Apple Music/.test(WS.kindHint('applemusic')) && WS.ORDER.indexOf('applemusic') === WS.ORDER.indexOf('spotify') + 1, WS.kindHint('applemusic'));

  // The connector: nothing to sign in to here, nothing fetched from Apple
  let calls = 0;
  let signedIn = null;
  let viewStatus = null;
  let reloads = 0;
  let spotifyReloads = 0;
  let settings = {};
  const w = createWidgets({
    readSettings: () => settings,
    writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); },
    fetch: async () => { calls++; throw new Error('the Apple Music card must not call any API'); },
    getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}),
    spotifyWebReload: () => { spotifyReloads++; },
    appleMusicWebSignedIn: () => signedIn,
    appleMusicWebStatus: () => viewStatus,
    appleMusicWebReload: () => { reloads++; },
  });
  check('apple music: the type is offered in Settings\' picker', w.state().types.some((t) => t.type === 'applemusic' && t.label === 'Apple Music'), JSON.stringify(w.state().types.map((t) => t.type)));
  const saved = await w.save({ type: 'applemusic', mode: 'web' }).catch((e) => ({ error: e.message }));
  check('apple music: saving needs no key, no account and no network', !saved.error && w.list()[0]?.type === 'applemusic' && calls === 0, saved.error || '');
  const id = w.list()[0].id;
  await w.refresh(w.list()[0]);
  const card = () => w.forPage().find((c) => c.id === id);
  check('apple music: the card data is Apple\'s address and what main knows, no API call', card().data.url === 'https://music.apple.com/' && card().data.signedIn === null && card().data.view === null && calls === 0, JSON.stringify(card().data));
  signedIn = false;
  check('apple music: the card learns the site is signed out (it offers "Open in a tab to sign in")', card().data.signedIn === false, '');
  signedIn = true;
  check('apple music: …and signed in', card().data.signedIn === true, '');
  viewStatus = { state: 'offline', drm: 'missing' };
  check('apple music: the card is told what the view is doing (offline, no Widevine)', card().data.view?.state === 'offline' && card().data.view?.drm === 'missing', JSON.stringify(card().data));
  check('apple music: "Try again" (do=reload) reloads Apple Music\'s view, not Spotify\'s', w.actionFrom(`file:///newtab.html?widget=${id}&do=reload`)?.do === 'reload' && (await w.act({ id, do: 'reload' })) === true && reloads === 1 && spotifyReloads === 0, `${reloads} ${spotifyReloads}`);
  check('apple music: an unknown card is refused', (await w.act({ id: 'wnope0001', do: 'reload' })) === false && reloads === 1, String(reloads));
  const entry = w.state().widgets.find((x) => x.id === id);
  check('apple music: the Settings list says Web player in web mode and offers no account to connect', /web player/i.test(entry?.summary || '') && WS.accountStatus({ type: 'applemusic' }, {}) === null, JSON.stringify(entry));
  const kept = cleanList([{ id: 'wapple001', type: 'applemusic', mode: 'web', colors: 'mono', x: 0, y: 0, w: 4, h: 5 }, { id: 'wapple002', type: 'applemusic', colors: '<x>' }]);
  check('apple music: cleanList keeps the card and its color mode, and a bad color mode falls back', kept.length === 2 && kept[0].colors === 'mono' && kept[1].colors !== '<x>' && kept[0].w === 4 && kept[0].h === 5 && kept[0].mode === 'web' && kept[1].mode === 'status' && kept[1].art === true, JSON.stringify(kept));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
