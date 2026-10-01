// Keep-alive pings for a held resize drag (app.js): main thaws a freeze that has been quiet for 6 s, and a still
// pointer sends no moves. The interval is capped, so a pointer held for minutes does not ping forever: after maxMs
// it stops itself and main's last-resort timer thaws the page. A plain script in the UI; test/units.js require()s it.
(function (root) {
  function freezeKeepAlive(ping, { ms = 1000, maxMs = 60000, setTimer = setInterval, clearTimer = clearInterval, now = Date.now } = {}) {
    const started = now();
    let id = null;
    const stop = () => { if (id !== null) { clearTimer(id); id = null; } };
    id = setTimer(() => { if (now() - started >= maxMs) stop(); else ping(); }, ms);
    return { stop };
  }
  const api = { freezeKeepAlive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.freezeKeepAlive = freezeKeepAlive;
})(typeof window !== 'undefined' ? window : globalThis);
