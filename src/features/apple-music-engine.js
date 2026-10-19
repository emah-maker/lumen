// The Apple Music widget's engine: Apple's own MusicKit JS, running in one hidden music.apple.com view (features/web-player.js makes and
// keeps the view; features/apple-music-bridge.js is the script that reports MusicKit's state and the checks on every message). The
// engine itself (what the card shows, the lists, search, the sign-in window, the unload after idle) is features/music-engine.js, shared
// with Spotify's. The desktop Apple Music app (features/apple-music-native.js) is the fallback source.
'use strict';

const AMB = require('./apple-music-bridge');
const { createMusicEngine, UNLOAD_MS } = require('./music-engine');

const createEngine = (deps) => createMusicEngine({ ...deps, bridge: AMB, name: 'Apple Music', signInTitle: 'Sign in to Apple Music' });

module.exports = { createEngine, UNLOAD_MS };
