// A size-capped record of errors in the main process, <userData>/diagnostics/main-errors.log. A packaged Windows build has no stderr, so an uncaught
// exception, an unhandled rejection or a crashed page process left nothing behind. One line per event: ISO time, kind, message, trimmed stack, tab-separated
// (line breaks inside a field are written as \n). Web addresses and the user's home folder are removed, so the file is safe to send along with a bug report.
// Append-only; past MAX_BYTES the file is moved to main-errors.log.1 (replacing the older one) and a fresh one begins. Never throws, never calls back into
// the handlers that use it. Loaded on the first error, not at startup (test/e2e/perf-budget.js counts startup modules).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
const MAX_MESSAGE = 1000;
const MAX_STACK = 2000;
const FILE = 'main-errors.log';

function clean(text, home) {
  let s = String(text ?? '');
  s = s.replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"<>)]+/gi, '<url>');
  if (home) s = s.split(home).join('~').split(home.split(String.fromCharCode(92)).join('/')).join('~');
  return s;
}
const oneLine = (s) => s.replace(/\r?\n/g, String.fromCharCode(92, 110)).replace(/\t/g, ' ');
const trim = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);

// One log line (no trailing newline) for a thrown value or a plain message.
function format(kind, value, { now = new Date(), home = os.homedir() } = {}) {
  let message;
  let stack = '';
  try {
    if (value && typeof value === 'object' && (value.message !== undefined || value.stack !== undefined)) {
      message = value.name && value.name !== 'Error' ? `${value.name}: ${value.message}` : String(value.message);
      stack = typeof value.stack === 'string' ? value.stack.split(/\r?\n/).filter((l) => /^\s+at /.test(l)).join('\n') : '';
    } else if (typeof value === 'string') message = value;
    else message = JSON.stringify(value) ?? String(value);
  } catch { message = '(unprintable)'; }
  return [now.toISOString(), String(kind), oneLine(trim(clean(message, home), MAX_MESSAGE)), oneLine(trim(clean(stack, home), MAX_STACK))].join('\t');
}

// create({ dir }): dir() gives the diagnostics folder. A test passes its own folder and a small cap.
function create({ dir, maxBytes = MAX_BYTES, home } = {}) {
  let busy = false; // an error while logging an error is dropped, never logged again
  const file = () => path.join(dir(), FILE);
  function log(kind, value) {
    if (busy) return false;
    busy = true;
    try {
      const f = file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      let size = 0;
      try { size = fs.statSync(f).size; } catch { /* none yet */ }
      if (size > maxBytes) {
        try { fs.renameSync(f, `${f}.1`); } catch { try { fs.truncateSync(f, 0); } catch { /* best effort */ } }
      }
      const line = format(kind, value, { home: home ?? os.homedir() });
      fs.appendFileSync(f, `${line}\n`);
      return true;
    } catch { return false; } finally { busy = false; }
  }
  // The last n lines (newest last), for the diagnostics export.
  function tail(n = 50) {
    try { return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
  }
  return { log, tail, file };
}

module.exports = { create, format, clean, MAX_BYTES, FILE };
