// A page can call window.open (or click target=_blank links) in a loop: hundreds of windows and tabs a
// second, which buries the browser. Chromium's own popup blocker lives above the part Electron uses,
// so Lumen caps the rate: one opener may open `max` windows or tabs per `windowMs`; the rest are refused.
// Attempts count whether they were refused or not, so a page that keeps going stays blocked until it
// stops for a whole window. A person opening tabs (Ctrl+click, middle-click) never comes near the cap.
// (test/popup-guard-units.js runs this.)
'use strict';

function createBurstLimit({ max = 8, windowMs = 3000, now = Date.now } = {}) {
  let times = [];
  return {
    // true: this open may go ahead.
    allow() {
      const t = now();
      times = times.filter((at) => t - at < windowMs);
      times.push(t);
      if (times.length > max + 1) times = times.slice(-(max + 1)); // (only the count matters)
      return times.length <= max;
    },
  };
}

module.exports = { createBurstLimit };
