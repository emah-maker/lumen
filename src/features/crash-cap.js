// A rolling cap on reloads after a renderer crash: a page that crashes as it loads would otherwise be
// reloaded forever. Used by the full-page chat (main.js) and by the browser UI's own window.
//
// crashBurst(times, now, { max, windowMs }) -> { times, reload }
//   times: the timestamps of earlier crashes (any array or undefined). Returns the ones still inside
//   the window plus this one, and whether this crash may still be answered with a reload (the first
//   `max` inside the window may; the next one may not).
function crashBurst(times, now = Date.now(), { max = 3, windowMs = 60e3 } = {}) {
  const kept = (Array.isArray(times) ? times : []).filter((at) => now - at < windowMs).concat(now);
  return { times: kept, reload: kept.length <= max };
}

module.exports = { crashBurst };
