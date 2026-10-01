// Timing helpers for the main process's own short animations (the drop glide, a new window's fade) and
// for work that must not run faster than the screen can show it. Pure: no Electron, so tests run them.
//
// Why: `setInterval(fn, 16)` on Windows fires on the coarse system timer, so the 16 ms often becomes
// 15.6 or 31 ms and the steps arrive unevenly (visible as stutter), and a busy turn of the event loop
// delays every later step as well. A step here is placed against the animation's own clock instead:
// each frame's value comes from the elapsed time (a late frame skips ahead, it never slows the motion),
// and each timer is aimed at the next frame boundary, not at "16 ms from now".

const FRAME_MS = 1000 / 60;

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// How far through a `duration` ms animation that began at `start` we are, 0..1.
const progress = (now, start, duration) => (duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - start) / duration)));

// Milliseconds until the next frame boundary after `now`, for boundaries `interval` apart from `start`.
// Never less than 1, so a late tick doesn't spin; at most `interval`.
function untilNextFrame(now, start, interval = FRAME_MS) {
  const into = (now - start) % interval;
  return Math.max(1, Math.min(interval, Math.round(interval - into)));
}

// Runs onFrame(eased, t) for each frame of a `duration` ms animation, the last one with t === 1, then
// onDone. Returns { stop() }. `now` and `schedule` are injectable for tests.
function tween({ duration, ease = easeOutCubic, onFrame, onDone, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const start = now();
  let timer = null;
  let stopped = false;
  const step = () => {
    timer = null;
    if (stopped) return;
    const t = progress(now(), start, duration);
    onFrame(ease(t), t);
    if (stopped) return; // (onFrame may have stopped it)
    if (t >= 1) { onDone?.(); return; }
    const at = now();
    timer = schedule(step, Math.max(1, Math.min(untilNextFrame(at, start), Math.ceil(start + duration - at)))); // the last frame lands on the end
  };
  timer = schedule(step, 0);
  return { stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; } };
}

// A gate that lets through at most one call per `gap` ms: `gate(now)` is true when the work may run.
// For input that arrives faster than frames (a 1 kHz mouse reporting every move to a handler that moves a window).
function rateGate(gap) {
  let last = -Infinity;
  return (now = Date.now()) => {
    if (now - last < gap) return false;
    last = now;
    return true;
  };
}

module.exports = { FRAME_MS, easeOutCubic, progress, untilNextFrame, tween, rateGate };
