// [desktop apps] The Computer card's live picture of the app window the AI is working in. The pictures are made inside the helper process
// (uia-helper.ps1, "frame": PrintWindow with PW_RENDERFULLCONTENT, scaled to the card, compared with the last one sent, JPEG only when it
// changed), so Lumen's main process only schedules calls and forwards the small answers. This file is the schedule and the safety checks:
//   - about 8 pictures a second while the window changes, a quarter of that while it stands still (an unchanged frame is never sent), a
//     slower pace in Light graphics / software drawing, nothing while the card is off screen, the app is minimized or hidden, a call
//     is running in the app, the person took over, or the run is over;
//   - before each call the policy is asked again (settings can change mid-run), the helper checks the window still belongs to the approved
//     program (pid on every frame, pid + start time about once a second) and that its title still is the one that was approved. A new title
//     is judged first and captured only if allowed, so a window that turned into a bank, a password manager or a terminal is never captured;
//   - a frame is held in memory only long enough to be shown in the card. Nothing here writes a picture anywhere.
// Plain functions with injected deps (tests drive it with fake helper frames and a fake clock).
'use strict';

const CARD_CSS_W = 340; // the card's picture is about this wide in CSS pixels
const FAST_MS = 120; // between pictures while the window changes
const SLOW_MS = 450; // between looks while it stands still
const LIGHT_FAST_MS = 700;
const LIGHT_SLOW_MS = 1500;
const WAIT_MS = 1000; // minimized / hidden / error pace
const IDLE_MS = 250; // not allowed to look right now (busy, paused): check again soon
const STATIC_AFTER = 3; // unchanged looks in a row before the slow pace
const VERIFY_MS = 1000; // the helper re-checks the program (pid + start time) this often; every frame checks the pid
const MAX_ERRORS = 8;
const QUALITY = 50;
const LIGHT_QUALITY = 42;

// Width of the picture for a display scale: the card's width times the scale, capped at 2 (a 3x display gets 2x: small files).
const widthFor = (dpr, light) => (light ? CARD_CSS_W : Math.round(CARD_CSS_W * Math.min(2, Math.max(1, Number(dpr) || 1))));

// d: now(), setTimeout(fn, ms), clearTimeout(t), visible() card on screen, light(), dpr(),
//    canRun() no call in the app, not paused, session alive, target() -> { hwnd, pid, hpid, start } | null,
//    allowed() -> true | false (policy for the approved window), approved() / approve(title) the title the policy said yes to,
//    judge(title) -> true | false (policy for a window with this title),
//    frame(args) -> Promise<{ image?, same?, skip?, retitle?, w?, h?, ms? }>, onFrame(base64, info), onEnd(reason: 'blocked' | 'changed' | 'gone' | 'failed')
function createLive(d) {
  const now = d.now || Date.now;
  const later = d.setTimeout || setTimeout;
  const unlater = d.clearTimeout || clearTimeout;
  let running = false;
  let timer = null;
  let busy = false;
  let staticCount = 0;
  let errors = 0;
  let retitleRun = 0; // new titles in a row without a picture (a title that changes every moment must not starve the pictures)
  let lastMs = 0;
  let verifiedAt = 0;
  let reset = true; // the next call sends a picture even if it looks unchanged (a new window, a new start)
  const stats = { frames: 0, same: 0, retitled: 0, skipped: 0, errors: 0, bytes: 0, helperMs: 0, calls: 0 };

  const paces = () => (d.light?.() ? [LIGHT_FAST_MS, LIGHT_SLOW_MS] : [FAST_MS, SLOW_MS]);
  const schedule = (ms) => {
    if (!running) return;
    unlater(timer);
    timer = later(tick, Math.max(0, ms));
    timer?.unref?.();
  };

  async function tick() {
    timer = null;
    if (!running || busy) return;
    const [fast, slow] = paces();
    if (!d.visible()) { stats.skipped++; schedule(WAIT_MS); return; }
    const t = d.target();
    if (!d.canRun() || !t) { schedule(IDLE_MS); return; }
    if (!d.allowed()) { end('blocked'); return; }
    busy = true;
    let next = staticCount >= STATIC_AFTER ? slow : fast;
    try {
      const verify = now() - verifiedAt >= VERIFY_MS;
      const w = widthFor(d.dpr?.(), d.light?.());
      stats.calls++;
      const r = await d.frame({ hwnd: t.hwnd, pid: t.pid, hpid: t.hpid || 0, start: verify ? (t.start || 0) : 0, verify, title: d.approved() ?? null, w, q: d.light?.() ? LIGHT_QUALITY : QUALITY, reset });
      if (!running) return;
      if (verify) verifiedAt = now();
      errors = 0;
      if (r.retitle !== undefined) { stats.retitled++; // the title is not the approved one: judge it before anything is captured
        if (!d.judge(String(r.retitle))) { end('blocked'); return; }
        d.approve(String(r.retitle));
        next = 0;
        retitleRun++;
      } else if (r.skip) { stats.skipped++; next = WAIT_MS; } // minimized or hidden: nothing is captured
      else if (r.same) { stats.same++; staticCount++; next = staticCount >= STATIC_AFTER ? slow : fast; }
      else if (r.image) {
        stats.frames++;
        stats.bytes += r.image.length;
        staticCount = 0;
        reset = false;
        lastMs = Number(r.ms) || 0;
        stats.helperMs += lastMs;
        // the second look at the policy: a picture is shown only if the window is still one the AI may use
        if (!d.allowed()) { end('blocked'); return; }
        d.onFrame(r.image, { w: r.w, h: r.h, ms: r.ms });
        next = fast;
      }
      if (r.retitle === undefined) retitleRun = 0;
      if (r.ms && r.same) { lastMs = Number(r.ms) || lastMs; stats.helperMs += Number(r.ms) || 0; }
      if (!(r.retitle !== undefined && retitleRun <= 4)) next = Math.max(next, Math.round(lastMs * 2)); // the helper works at most about a third of the time (a new title is asked about again at once: it costs no picture)
    } catch (err) {
      if (!running) return;
      const msg = String(err?.message || err);
      if (err?.fromHelper && /different program/i.test(msg)) { end('changed'); return; }
      if (err?.fromHelper && /is gone|no longer exists/i.test(msg)) { end('gone'); return; }
      if (err?.aborted) { schedule(WAIT_MS); return; } // a call was cut short (the person took over): the schedule goes on
      stats.errors++;
      if (++errors >= MAX_ERRORS) { end('failed'); return; }
      next = WAIT_MS * 2;
    } finally { busy = false; }
    schedule(next);
  }

  function end(reason) {
    if (!running) return;
    running = false;
    unlater(timer);
    timer = null;
    try { d.onEnd?.(reason); } catch { /* the card is gone */ }
  }

  return {
    start() { if (running) return; running = true; errors = 0; staticCount = 0; reset = true; verifiedAt = 0; schedule(0); },
    stop() { running = false; unlater(timer); timer = null; },
    // A window changed (a call just ended, the AI moved to another window): look again now, and send a picture even if it looks the same.
    kick({ fresh = false } = {}) { if (!running) return; staticCount = 0; if (fresh) { reset = true; verifiedAt = 0; } if (!busy) schedule(0); },
    active: () => running,
    stats: () => ({ ...stats }),
  };
}

module.exports = { createLive, widthFor, FAST_MS, SLOW_MS, LIGHT_FAST_MS, LIGHT_SLOW_MS, WAIT_MS, CARD_CSS_W };
