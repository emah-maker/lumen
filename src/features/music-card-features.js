// What a music card (Spotify, Apple Music) can do at the size it has: progressive disclosure, one table for both services and all their
// engines. The card (renderer/newtab-music.js) asks "which features at this size?" and "which of those does this engine have?"; the answer
// is the controls it draws. A control the engine can't do is not drawn at all (never a broken button).
//
//   tierOf(width, height)         -> 'small' | 'medium' | 'large' | 'xl', from the card's content box in CSS px (what a container query sees)
//   featuresAt(tier)              -> the features of that tier and every smaller one
//   engineOf(type, mode)          -> 'spotify-lumen' | 'spotify-api' | 'applemusic' | null
//   caps(engine)                  -> what the engine can do at best (the static table); a live `can` from the engine can only narrow it
//   shown(tier, engine, can)      -> the features drawn now: this size's features that the engine has (and `can` has not switched off)
//   TIER_MIN                      -> the thresholds; renderer/newtab.html's @container rules use the same numbers (a test compares them)
//
// Pure, no DOM: the page loads it as a script (globalThis.MusicCardFeatures) and the unit tests require it.
(function () {
'use strict';

const TIERS = ['small', 'medium', 'large', 'xl'];
// The card's content box (inside its padding), px. Both must hold. A 4x3 card (the default) is small; 4x4 and up is medium; 6x5 is large;
// 6x7 and up (or wide: 8x6) is extra large.
const TIER_MIN = { medium: { w: 300, h: 200 }, large: { w: 380, h: 300 }, xl: { w: 600, h: 400 } };

const FEATURES = {
  small: ['art', 'title', 'playPause', 'next', 'progress'],
  medium: ['prev', 'seek', 'like', 'shuffle', 'repeat', 'volume'],
  large: ['tabs', 'search', 'queue', 'library', 'devices'],
  xl: ['tracks', 'lyrics'],
};

function tierOf(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return 'small';
  let tier = 'small';
  for (const t of TIERS.slice(1)) if (w >= TIER_MIN[t].w && h >= TIER_MIN[t].h) tier = t;
  return tier;
}

function featuresAt(tier) {
  const upTo = TIERS.indexOf(tier);
  const out = [];
  TIERS.forEach((t, i) => { if (i <= (upTo < 0 ? 0 : upTo)) out.push(...FEATURES[t]); });
  return out;
}

// What each engine can do at best. `true` means the engine has it; `devices` is 'pick' (choose the output), 'browser' (only says "this
// browser") or false. Spotify "Play as Lumen" has no Web API: it presses the web player's own controls, so what it finds is also
// reported live (the page's `has`), which can only switch a control off.
const ENGINES = {
  'spotify-lumen': { art: true, title: true, playPause: true, next: true, progress: true, prev: true, seek: true, like: true, shuffle: true, repeat: true, volume: true, tabs: true, search: true, queue: true, queueAdd: true, library: true, devices: 'browser', tracks: true, lyrics: true },
  'spotify-api': { art: true, title: true, playPause: true, next: true, progress: true, prev: true, seek: true, like: true, shuffle: true, repeat: true, volume: true, tabs: true, search: true, queue: true, queueAdd: true, library: true, devices: 'pick', tracks: true, lyrics: false },
  applemusic: { art: true, title: true, playPause: true, next: true, progress: true, prev: true, seek: true, like: true, shuffle: true, repeat: true, volume: true, tabs: true, search: true, queue: true, queueAdd: true, library: true, devices: false, tracks: true, lyrics: true },
};

function engineOf(type, mode) {
  if (type === 'applemusic') return mode === 'web' ? null : 'applemusic';
  if (type === 'spotify') return mode === 'status' ? 'spotify-lumen' : mode === 'api' ? 'spotify-api' : null;
  return null;
}

const caps = (engine) => (Object.prototype.hasOwnProperty.call(ENGINES, engine) ? { ...ENGINES[engine] } : {});

// tier + engine (+ the engine's live `can`, where a flag that is exactly false switches the feature off) -> the features to draw.
function shown(tier, engine, can) {
  const have = caps(engine);
  const live = can && typeof can === 'object' ? can : {};
  return featuresAt(tier).filter((f) => have[f] && live[f] !== false);
}

// repeat: the next mode when the button is pressed (off -> all -> one -> off); `modes` is what the engine has (Apple and Spotify have all three).
function nextRepeat(mode, modes = ['off', 'all', 'one']) {
  const i = modes.indexOf(mode);
  return modes[(i + 1) % modes.length] || 'off';
}

const api = { TIERS, TIER_MIN, FEATURES, ENGINES, tierOf, featuresAt, engineOf, caps, shown, nextRepeat };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.MusicCardFeatures = api;
})();
