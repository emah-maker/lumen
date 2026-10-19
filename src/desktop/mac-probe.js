// [desktop apps] macOS: the "you took over" and "stop" checks for index.js, the same calls winapi.js gives on Windows (cursor, pidUnderCursor,
// foregroundPid, escapeDown, mouseDown, typing). They have to answer at once, so one osascript (mac-probe.jxa) runs while the AI is using an
// app and streams the state as JSON lines; the calls here answer from the latest line. start() / stop() follow the session. If the stream
// stops coming (the script failed or hangs), failed() says so and index.js ends the session: the AI does not use apps without these checks.
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'mac-probe.jxa');
const STALE_MS = 2500; // no line for this long: the checks are not running

// deps (tests pass fakes): spawn(file, args, opts), source(), now()
function load(deps = {}) {
  const spawn = deps.spawn || ((...a) => require('../ai/cli-utils').spawn(...a));
  const now = deps.now || Date.now;
  let source = null;
  try { source = (deps.source || (() => fs.readFileSync(SCRIPT, 'utf8')))(); } catch (err) { return { ok: false, reason: 'script', detail: err.message }; }
  let child = null;
  let state = null;
  let at = 0;
  let startedAt = 0;
  let wanted = false;
  let broken = false;

  function begin() {
    let c;
    try { c = spawn('osascript', ['-l', 'JavaScript', '-e', source, '30000'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { broken = true; return; }
    child = c;
    startedAt = now();
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { state = JSON.parse(line); at = now(); } catch { /* a broken line: the next one counts */ }
      }
      if (buf.length > 1e5) buf = '';
    });
    c.on('error', () => { if (child === c) { child = null; broken = true; } });
    c.on('exit', (code) => {
      if (child !== c) return;
      child = null;
      if (wanted && code === 0) begin(); // (it ends itself after an hour: a session still running gets a fresh one)
      else if (wanted) broken = true;
    });
  }

  const fresh = () => (state && now() - at < STALE_MS ? state : null);
  return {
    ok: true,
    start() { wanted = true; broken = false; if (!child) begin(); },
    stop() { wanted = false; state = null; at = 0; const c = child; child = null; if (c) { try { c.kill(); } catch { /* gone */ } } },
    // true when the checks are not running: it could not start, it ended, or nothing came for a while (a fresh start gets a moment).
    failed: () => broken || (wanted && !fresh() && now() - startedAt > STALE_MS),
    cursor: () => { const s = fresh(); return s ? { x: s.x, y: s.y } : null; },
    pidUnderCursor: () => fresh()?.under || 0,
    foregroundPid: () => fresh()?.front || 0,
    escapeDown: () => fresh()?.esc === true,
    mouseDown: () => fresh()?.down === true,
    typing: () => fresh()?.typing === true,
  };
}

module.exports = { load, SCRIPT, STALE_MS };
