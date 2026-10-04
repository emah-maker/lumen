// [warm per chat] Claude Code keeps its CLI process running between a chat's messages (claude-code.js keepAlive), so a
// later message skips the process start, the MCP handshake and the session load. Sidebar chats run side by side
// (parallel CLI chats), so each tab chat gets an engine of its own, keyed by its chat id, whose process (and with it its
// own MCP token, revoked when the process ends) stays warm between that chat's messages.
//
// An engine is freed (its process killed, its token revoked, its entry dropped):
//  - when its chat is deleted, or its tab closes and no other tab shows it (drop(), from main.js; a chat still working
//    is freed as soon as its message ends),
//  - after idleMs() with no message (the engine's own process idle timer is the same length),
//  - when more than maxIdle() chats have an idle warm process: the least recently used idle one goes. A chat with a
//    message in flight is never evicted and never counted: active runs stay unlimited,
//  - on quit (disposeAll()).
//
// Grok Build has no process to keep between messages here (grok reads its prompt at spawn; features/grok-warm.js is the
// opt-in for that), so this pool is for Claude Code only.
//
// deps: { make(key): a new engine (ClaudeCodeEngine-shaped: isWarm(), release(), dispose(), owns(tag)),
//   maxIdle(): how many idle warm chats to keep, idleMs(): how long an idle chat keeps its engine,
//   now / setTimer / clearTimer (tests) }
function createWarmChats({ make, maxIdle = () => 4, idleMs = () => 10 * 60 * 1000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const chats = new Map(); // key -> { key, engine, holds, last, gone, timer }

  function entry(key) {
    let e = chats.get(key);
    if (!e) {
      e = { key, engine: make(key), holds: 0, last: now(), gone: false, timer: null };
      chats.set(key, e);
    }
    return e;
  }

  // Ends the chat's engine: an idle process (and one a warm() is still starting) goes, with its MCP token.
  function forget(e) {
    clearTimer(e.timer);
    if (chats.get(e.key) === e) chats.delete(e.key);
    try { e.engine.release?.(); } catch { /* already gone */ }
    try { e.engine.dispose?.(); } catch { /* already gone */ }
  }

  const warm = (e) => { try { return Boolean(e.engine.isWarm?.()); } catch { return false; } };

  // Past the cap, the least recently used idle warm chats lose their process.
  function trim() {
    const cap = Math.max(0, Number(maxIdle()) || 0);
    const idle = [...chats.values()].filter((e) => e.holds === 0 && warm(e)).sort((a, b) => a.last - b.last);
    for (const e of idle.slice(0, Math.max(0, idle.length - cap))) forget(e);
  }

  // No message holds the chat's engine any more: it is freed if its chat went meanwhile, else kept for idleMs().
  function settle(e) {
    if (e.holds > 0) return;
    if (e.gone) { forget(e); return; }
    clearTimer(e.timer);
    const ms = Number(idleMs());
    e.timer = null;
    if (ms !== Infinity) { // Infinity: never (until its chat goes, the idle cap, or quit)
      e.timer = setTimer(() => { if (e.holds === 0) forget(e); }, Math.max(1000, ms || 0));
      e.timer?.unref?.();
    }
    trim();
  }

  return {
    // The chat's engine for one message: { engine, release }. Held until release() (twice is harmless).
    lease(key) {
      const e = entry(key);
      e.holds++;
      e.gone = false; // (a chat that came back: drop() may have marked it while its last message ran)
      e.last = now();
      clearTimer(e.timer);
      let done = false;
      return {
        engine: e.engine,
        shared: false,
        release() {
          if (done) return;
          done = true;
          e.holds = Math.max(0, e.holds - 1);
          e.last = now();
          settle(e);
        },
      };
    },
    // The chat's engine outside a message (agent.js prewarm starts its process ahead of the message), kept like an
    // idle one. warmed(): call after starting a process on it, so the cap counts it.
    peek(key) {
      const e = entry(key);
      e.last = now();
      if (e.holds === 0) settle(e);
      return e.engine;
    },
    warmed: () => trim(),
    // The chat is gone (deleted, or no tab shows it any more): its engine goes now, or when its message ends.
    drop(key) {
      const e = chats.get(key);
      if (!e) return false;
      if (e.holds > 0) { e.gone = true; return false; }
      forget(e);
      return true;
    },
    // The chat's idle process goes (its conversation was rewound: the session it holds is stale); the engine stays.
    releaseIdle(key) {
      const e = chats.get(key);
      if (e && e.holds === 0) { try { e.engine.release?.(); } catch {} }
    },
    // Lumen quits: every engine goes, busy or not.
    disposeAll() {
      for (const e of [...chats.values()]) forget(e);
    },
    busy: (key) => (chats.get(key)?.holds || 0) > 0,
    has: (key) => chats.has(key),
    engineOf: (key) => chats.get(key)?.engine || null,
    engines: () => [...chats.values()].map((e) => e.engine),
    // The engine whose live process carries this MCP tag (features/ai-agents.js engineForSession).
    owner: (tag) => [...chats.values()].find((e) => { try { return e.engine.owns(tag); } catch { return false; } })?.engine || null,
    stats: () => {
      const all = [...chats.values()];
      return { chats: all.length, busy: all.filter((e) => e.holds > 0).length, idleWarm: all.filter((e) => e.holds === 0 && warm(e)).length };
    },
  };
}

module.exports = { createWarmChats };
