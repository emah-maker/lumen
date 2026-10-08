// Small pieces that keep the tab strip's busy events from turning into disk writes (main.js sendTabs / saveSession).

// Writes the saved session only when it changed: `shouldWrite(stored, session, background)` is false for a background
// save of a session identical to the one last written, as long as nothing else has replaced it in the settings
// (`stored` is the session object the settings now hold). Closing and quitting (background false) always write.
function sessionWriteGate() {
  let last = null;
  let lastText = '';
  return {
    shouldWrite(stored, session, background) {
      const text = JSON.stringify(session);
      if (background && last && stored === last && text === lastText) return false;
      last = session;
      lastText = text;
      return true;
    },
  };
}

// A value rebuilt only when `generation()` changes (the bookmark URL set, keyed by the settings write counter).
function memoByGeneration(generation, build) {
  let gen = null;
  let value;
  return () => {
    const g = generation();
    if (gen !== g) { value = build(); gen = g; }
    return value;
  };
}

// Events for one key (a window) arrive in bursts; `fire(key, quiet)` runs once per burst, `delayMs` after the first.
// The burst is quiet only when every event in it was ("quiet": it changes nothing the saved session holds).
function quietBursts(delayMs, fire, schedule = setTimeout) {
  const pending = new Map();
  return (key, quiet = false) => {
    quiet = quiet === true;
    if (pending.has(key)) { if (!quiet) pending.set(key, false); return; }
    pending.set(key, quiet);
    schedule(() => { const q = pending.get(key); pending.delete(key); fire(key, q === true); }, delayMs);
  };
}

module.exports = { sessionWriteGate, memoByGeneration, quietBursts };
