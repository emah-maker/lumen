// Warm-up for Grok Build ("Warm up Grok Build when Lumen starts", Settings -> AI and agents, key grokWarmup).
// Grok reads its prompt from --prompt-file at spawn, so unlike Claude Code's kept process it can't wait for
// the next message. What can be done ahead of it is the setup a message starts with: the binary lookup
// (a `where` spawn, ~55 ms), Lumen's HTTP gate, the folders, config.toml + gate script and the sign-in link
// (engine.prepare()). Never a model request, and never an extra `grok` spawn: Lumen's own startup look
// (`grok models`, ~430 ms) already runs the binary once, so --version would add ~20 ms of file cache at best.
// Nothing runs before the first tab has loaded: afterLook() is called only once Lumen's look at the CLIs
// (which waits for that tab) is done, so boot is never slowed.
// deps: { enabled(): setting on and Grok Build in use, engine(): the GrokBuildEngine, found(): installed,
//   powerMonitor?: emitter ('resume') } (tests fake these)
function createGrokWarmup({ enabled, engine, found = () => true, powerMonitor = null }) {
  let loaded = false; // the first tab has loaded and the CLIs were looked for: before that nothing is warmed
  let busy = null;
  let warmedAt = 0;
  const stats = { warmed: 0, skipped: 0 };

  // fresh: drop the engine's cached setup first (after a sleep the folders / sign-in link may have changed).
  function warm({ fresh = false } = {}) {
    if (!loaded || !enabled() || !found()) { stats.skipped++; return Promise.resolve(false); }
    if (busy) return busy;
    // Repeated pokes (every composer focus) cost nothing within a minute of the last warm-up.
    if (!fresh && Date.now() - warmedAt < 60000) return Promise.resolve(false);
    busy = (async () => {
      try {
        const eng = engine();
        if (fresh) eng.prep = null;
        const p = await eng.prepare();
        if (!p?.bin) return false; // not installed: nothing to warm (the next message says so)
        warmedAt = Date.now();
        stats.warmed++;
        return true;
      } catch { return false; } // a warm-up never reports an error: the message's own setup does
      finally { busy = null; }
    })();
    return busy;
  }

  // Lumen's first look at the CLIs is done (after the first tab loaded): the startup warm-up.
  const afterLook = () => { loaded = true; return warm(); };

  // Whenever the machine wakes (only once started).
  function watchResume() {
    powerMonitor?.on?.('resume', () => { if (loaded) warm({ fresh: true }); });
  }

  return { afterLook, warm, watchResume, stats };
}

module.exports = { createGrokWarmup };
