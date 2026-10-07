// When the new-tab page must draw a widget's card again (renderer/newtab-widgets.js renderWidgets): only when what the card shows changed.
// A card drawn again is a new element: its buttons, its open search field and what is typed in it are replaced, a click that was under
// way is lost, and it has to be put back in its place on the grid. So a now-playing card (Spotify, Apple Music) must not be drawn again
// just because it was read again: every read stamps a new `at` (when the playhead was where `progressMs` says), and while a song plays
// both move on together. What the card shows is the same as long as the playhead lands where the card already shows it.
//
//   cardKey(w)            -> { key, head }: `key` is everything the card is drawn from except where the playhead is; `head` is where
//                            the playhead is (null: the card has none): { playing, start } (start: when the song would have begun, ms) or
//                            { playing: false, at } (paused at, ms)
//   sameCard(prev, next)  -> may the card drawn for `prev` stay for `next`?
//
// Pure, no DOM: the page loads it as a script (globalThis.WidgetCardKey) and the unit tests require it.
(function () {
'use strict';

// What the page applies to a card as it is, without drawing it again (a new size, place, age, turn in a stack or edit-form value).
const LIVE = ['span', 'height', 'layout', 'updated', 'warning', 'colors', 'setup', 'stack', 'sid', 'top', 'rotate', 'smart'];
const PLAYHEAD = new Set(['spotify', 'applemusic']);
const DRIFT_MS = 1500; // a playhead this close to where the card already shows it is the same

function cardKey(w) {
  const rest = { ...(w || {}) };
  for (const k of LIVE) delete rest[k];
  const d = rest.data;
  let head = null;
  if (PLAYHEAD.has(rest.type) && d && typeof d === 'object' && Number.isFinite(d.at) && Number.isFinite(d.progressMs)) {
    const { at, progressMs, ...still } = d;
    rest.data = still;
    head = d.state === 'playing' ? { playing: true, start: at - progressMs } : { playing: false, at: progressMs };
  }
  return { key: JSON.stringify(rest), head };
}

function sameCard(prev, next) {
  if (!prev || !next || prev.key !== next.key) return false;
  const a = prev.head;
  const b = next.head;
  if (!a || !b) return !a && !b;
  if (a.playing !== b.playing) return false;
  return a.playing ? Math.abs(a.start - b.start) <= DRIFT_MS : Math.abs(a.at - b.at) <= DRIFT_MS;
}

const api = { cardKey, sameCard, DRIFT_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetCardKey = api;
})();
