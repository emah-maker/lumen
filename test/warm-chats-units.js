// [warm per chat] features/warm-chats.js (each tab chat's own Claude Code engine, kept warm between its messages) and
// grok-build.js's sign-in lock (shareAuth / holdAuth: one link for overlapping Grok Build runs in a home, one
// copy-back when the last ends). Plain Node, fake engines and clocks; the end-to-end version with fake CLIs is
// test/acceptance/chat-warm-per-chat.js.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWarmChats } = require('../src/features/warm-chats');
const gb = require('../src/ai/grok-build');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);

// A fake engine: warm() starts a "process", release() ends an idle one, dispose() ends it whatever it does.
function fakeEngine(key, log) {
  return {
    key, proc: null, made: Date.now(),
    warm() { this.proc ||= { pid: Math.random() }; },
    isWarm() { return Boolean(this.proc); },
    release() { if (this.proc) log.push(`release:${key}`); this.proc = null; },
    dispose() { if (this.proc) log.push(`dispose:${key}`); this.proc = null; },
    owns(tag) { return Boolean(this.proc && tag === `tag-${key}`); },
  };
}
function fakeTimers() {
  let t = 0;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.add(h); return h; },
    clearTimer: (h) => { timers.delete(h); },
    advance(ms) { t += ms; for (const h of [...timers].sort((a, b) => a.at - b.at)) if (h.at <= t) { timers.delete(h); h.fn(); } },
    tick() { t += 1; },
  };
}

// ---- one engine per chat, reused across its messages
{
  const log = [];
  const clock = fakeTimers();
  const made = [];
  const pool = createWarmChats({ make: (k) => { const e = fakeEngine(k, log); made.push(e); return e; }, maxIdle: () => 4, idleMs: () => 60000, ...clock });
  const a1 = pool.lease('A'); const b1 = pool.lease('B');
  check('lease: two chats at once get two engines', a1.engine !== b1.engine && made.length === 2);
  a1.engine.warm(); b1.engine.warm();
  a1.release(); b1.release(); clock.tick();
  const a2 = pool.lease('A');
  check('lease: a chat\'s next message gets its own engine again, process still warm', a2.engine === a1.engine && a2.engine.isWarm() && made.length === 2);
  check('busy: a chat with a message in flight is busy, the other is not', pool.busy('A') && !pool.busy('B'));
  a2.release(); a2.release();
  check('release twice is harmless', !pool.busy('A') && pool.stats().idleWarm === 2, J(pool.stats()));
  check('owner: an MCP tag finds the chat engine whose process carries it', pool.owner('tag-B') === b1.engine && pool.owner('tag-X') === null);
  check('peek: the open chat\'s engine outside a message is the same one', pool.peek('A') === a1.engine && made.length === 2);
}

// ---- idle time "never" (Settings: the same choice as a kept Grok Build's, 0 -> Infinity): no idle timer at all
{
  const log = [];
  const clock = fakeTimers();
  const pool = createWarmChats({ make: (k) => fakeEngine(k, log), maxIdle: () => 4, idleMs: () => Infinity, ...clock });
  const a = pool.lease('A'); a.engine.warm(); a.release();
  clock.advance(365 * 24 * 3600e3);
  check('idle never: an idle warm chat is kept (no timer that would fire at once)', a.engine.isWarm() && pool.has('A') && log.length === 0, J(log));
}

// ---- freed on drop (chat deleted / last tab closed), mid-message drop waits for the message
{
  const log = [];
  const clock = fakeTimers();
  const pool = createWarmChats({ make: (k) => fakeEngine(k, log), maxIdle: () => 4, idleMs: () => 60000, ...clock });
  const a = pool.lease('A'); a.engine.warm(); a.release();
  check('drop: an idle chat\'s engine and process go at once', pool.drop('A') === true && !pool.has('A') && !a.engine.isWarm() && log.includes('release:A'), J(log));
  const b = pool.lease('B'); b.engine.warm();
  check('drop mid-message: nothing is killed yet', pool.drop('B') === false && b.engine.isWarm() && pool.has('B'));
  b.release();
  check('drop mid-message: freed when the message ends', !pool.has('B') && !b.engine.isWarm());
  const c = pool.lease('C'); c.engine.warm(); pool.drop('C');
  const c2 = pool.lease('C'); // the chat came back (adopted by another tab) before its message ended
  c.release(); c2.release();
  check('drop then back: a chat leased again is kept', pool.has('C') && c.engine.isWarm());
  check('drop of an unknown chat is harmless', pool.drop('nope') === false);
}

// ---- idle timeout
{
  const log = [];
  const clock = fakeTimers();
  const pool = createWarmChats({ make: (k) => fakeEngine(k, log), maxIdle: () => 4, idleMs: () => 10000, ...clock });
  const a = pool.lease('A'); a.engine.warm(); a.release();
  clock.advance(9000);
  check('idle: kept before the idle time', pool.has('A') && a.engine.isWarm());
  const a2 = pool.lease('A'); clock.advance(20000);
  check('idle: never while a message holds it', pool.has('A') && a2.engine.isWarm());
  a2.release(); clock.advance(10001);
  check('idle: freed (process and entry) after the idle time with no message', !pool.has('A') && !a.engine.isWarm(), J(log));
  const p = pool.peek('P'); p.warm(); pool.warmed(); clock.advance(10001);
  check('idle: a pre-warmed chat that never sent goes too', !pool.has('P') && !p.isWarm());
}

// ---- LRU cap on idle warm chats; active runs uncapped
{
  const log = [];
  const clock = fakeTimers();
  let cap = 2;
  const pool = createWarmChats({ make: (k) => fakeEngine(k, log), maxIdle: () => cap, idleMs: () => 600000, ...clock });
  const use = (k) => { const l = pool.lease(k); l.engine.warm(); clock.tick(); l.release(); clock.tick(); return l.engine; };
  const A = use('A'); const B = use('B');
  check('cap: two idle warm chats fit under a cap of 2', A.isWarm() && B.isWarm());
  use('A'); // A is now the most recent
  const C = use('C');
  check('cap: a third goes past it: the least recently used (B) loses its process', A.isWarm() && !B.isWarm() && C.isWarm() && !pool.has('B'), J(log));
  const held = ['D', 'E', 'F'].map((k) => { const l = pool.lease(k); l.engine.warm(); return l; });
  check('cap: chats with a message in flight are not counted or evicted', held.every((l) => l.engine.isWarm()) && A.isWarm() && C.isWarm() && pool.stats().busy === 3, J(pool.stats()));
  for (const l of held) { clock.tick(); l.release(); }
  check('cap: once they end, the cap holds again (the 2 most recent stay)', pool.stats().idleWarm === 2 && held[1].engine.isWarm() && held[2].engine.isWarm() && !A.isWarm() && !C.isWarm(), J(pool.stats()));
  cap = 1; // Performance mode turned on
  use('G');
  check('cap: read live (Performance mode lowers it)', pool.stats().idleWarm === 1, J(pool.stats()));
  const pk = pool.peek('H'); pk.warm(); pool.warmed();
  check('cap: a pre-warmed open chat counts too (the older idle one goes)', pk.isWarm() && pool.stats().idleWarm === 1, J(pool.stats()));
}

// ---- quit
{
  const log = [];
  const pool = createWarmChats({ make: (k) => fakeEngine(k, log), ...fakeTimers() });
  const a = pool.lease('A'); a.engine.warm();
  const b = pool.lease('B'); b.engine.warm(); b.release();
  pool.disposeAll();
  check('quit: every engine goes, busy or idle', !a.engine.isWarm() && !b.engine.isWarm() && pool.stats().chats === 0, J(pool.stats()));
}

// ---- Grok Build sign-in lock
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-authlock-'));
  const user = path.join(tmp, 'user'); const home = path.join(tmp, 'home');
  fs.mkdirSync(user); fs.mkdirSync(home);
  fs.writeFileSync(path.join(user, 'auth.json'), 'v1');
  const own = path.join(home, 'auth.json');
  // A refresh lands later than the link; the test's writes can share one timestamp tick, so say so explicitly.
  const laterMtime = (file, seconds) => { const t = new Date(Date.now() + seconds * 1000); fs.utimesSync(file, t, t); };
  try {
    // Three runs prepare at once: one link.
    const links = await Promise.all([gb.shareAuth(user, home), gb.shareAuth(user, home), gb.shareAuth(user, home)]);
    check('grok lock: concurrent prepares share one link (made once)', gb.authStats(home).links === 1 && links.every((b) => b === links[0]), J(gb.authStats(home)));
    const r1 = gb.holdAuth(user, home); const r2 = gb.holdAuth(user, home);
    // Run 1's Grok refreshes the token (replaces Lumen's file).
    fs.rmSync(own); fs.writeFileSync(own, 'v2'); laterMtime(own, 1);
    await gb.shareAuth(user, home); // a run starting while two are in flight
    check('grok lock: a link asked for under runs in flight is the shared one (refreshed token kept)', gb.authStats(home).links === 1 && fs.readFileSync(own, 'utf8') === 'v2');
    await r1();
    check('grok lock: no copy-back while another run is going', fs.readFileSync(path.join(user, 'auth.json'), 'utf8') === 'v1');
    // Run 2 refreshes once more before it ends.
    fs.rmSync(own); fs.writeFileSync(own, 'v3'); laterMtime(own, 2);
    await r2(); await r2(); // (twice: harmless)
    check('grok lock: the last run\'s end copies the newest token back, once', fs.readFileSync(path.join(user, 'auth.json'), 'utf8') === 'v3' && gb.authStats(home).runs === 0);
    // A later run links afresh, and a refresh in it is copied back too (Lumen's own copy-back is not "the user signed in again").
    await gb.shareAuth(user, home);
    const r3 = gb.holdAuth(user, home);
    check('grok lock: with no run in flight the next run links again', gb.authStats(home).links === 2, J(gb.authStats(home)));
    fs.rmSync(own); fs.writeFileSync(own, 'v4'); laterMtime(own, 3);
    await r3();
    check('grok lock: a refresh in a later run is copied back as well', fs.readFileSync(path.join(user, 'auth.json'), 'utf8') === 'v4');
    // The user signs in again in a terminal during a run: their new file wins, nothing is copied over it.
    await gb.shareAuth(user, home);
    const r4 = gb.holdAuth(user, home);
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(user, 'auth.json.tmp'), 'user-new'); fs.renameSync(path.join(user, 'auth.json.tmp'), path.join(user, 'auth.json'));
    fs.rmSync(own); fs.writeFileSync(own, 'v5'); laterMtime(own, 4);
    await r4();
    check('grok lock: a sign-in the user made meanwhile is not overwritten', fs.readFileSync(path.join(user, 'auth.json'), 'utf8') === 'user-new');
  } catch (err) {
    check('grok lock: crashed', false, err.stack);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
