// The Spotify widget's engine: Spotify's own web player (open.spotify.com) running in one hidden view (features/web-player.js makes and
// keeps the view, in the user's normal session), and a fixed bridge script in it (features/spotify-bridge.js: the page's mediaSession,
// its own playbar controls found by data-testid, and its own router for search). The engine itself (what the card shows, search, the
// sign-in window, the unload after idle) is features/music-engine.js, shared with Apple Music's. Whether the user is signed in comes
// from Spotify's own sign-in cookie, which the view's player already watches.
'use strict';

const SPB = require('./spotify-bridge');
const { createMusicEngine, UNLOAD_MS } = require('./music-engine');

const createEngine = (deps) => createMusicEngine({ ...deps, bridge: SPB, name: 'Spotify', signInTitle: 'Sign in to Spotify', isAuthorized: () => deps.player.isSignedIn() });

module.exports = { createEngine, UNLOAD_MS };
