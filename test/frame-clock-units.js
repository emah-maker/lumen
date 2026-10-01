// Plain Node checks for features/frame-clock.js: the easing, the frame-boundary timer, the elapsed-time
// tween (a late frame skips ahead instead of slowing the motion) and the rate gate. Run from test/units.js.
const C = require('../src/features/frame-clock');

module.exports = function frameClockUnits(check) {
  check('frames: easeOutCubic runs 0 to 1 and is fast at the start', C.easeOutCubic(0) === 0 && C.easeOutCubic(1) === 1 && C.easeOutCubic(0.5) === 0.875);
  check('frames: progress is clamped and a zero duration is done at once', C.progress(50, 0, 100) === 0.5 && C.progress(-5, 0, 100) === 0 && C.progress(500, 0, 100) === 1 && C.progress(0, 0, 0) === 1);
  const next = C.untilNextFrame(1000 / 60 + 3, 0);
  check('frames: the next timer aims at the frame boundary, not 16 ms after a late tick', next >= 13 && next <= 14, String(next));
  check('frames: a timer is never set for less than 1 ms or more than a frame', C.untilNextFrame(1000 / 60, 0) >= 1 && C.untilNextFrame(0, 0) <= 17);

  // A fake clock whose second tick is 50 ms late: the animation jumps ahead, and still ends on time.
  let t = 1000;
  const timers = [];
  const seen = [];
  let done = 0;
  C.tween({ duration: 120, now: () => t, schedule: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; }, cancel: () => {}, onFrame: (e, p) => seen.push([e, p]), onDone: () => { done++; } });
  const fire = (advance) => { const x = timers.shift(); t = Math.max(t + advance, x.at); x.fn(); };
  fire(0); fire(50); // a 50 ms stall before the second frame
  check('frames: a late frame skips ahead by the elapsed time', Math.abs(seen[1][1] - 50 / 120) < 0.02, JSON.stringify(seen));
  while (timers.length && seen.length < 50) fire(0);
  check('frames: the last frame is exactly 1 and onDone runs once', seen[seen.length - 1][1] === 1 && seen[seen.length - 1][0] === 1 && done === 1, JSON.stringify(seen.at(-1)));
  check('frames: the animation takes its duration, not one step per frame', t - 1000 >= 120 && t - 1000 <= 125, String(t - 1000));

  let calls = 0;
  const handle = C.tween({ duration: 100, now: () => t, schedule: (fn) => { timers.push({ fn, at: t }); return 1; }, cancel: () => {}, onFrame: () => { calls++; } });
  handle.stop();
  while (timers.length) timers.shift().fn();
  check('frames: a stopped tween never calls back', calls === 0);

  const gate = C.rateGate(8);
  // The fade's steps: 4 levels, and each only once.
  check('frames: quantize snaps a fade to a few steps', C.quantize(0, 4) === 0 && C.quantize(0.01, 4) === 0.25 && C.quantize(0.25, 4) === 0.25 && C.quantize(0.26, 4) === 0.5 && C.quantize(0.99, 4) === 1 && C.quantize(1, 4) === 1);
  const levels = new Set();
  for (let i = 0; i <= 120; i++) levels.add(C.quantize(C.progress(i, 0, 120), 4));
  check('frames: a 120 ms fade at 1 ms resolution touches at most 5 opacities (0 + 4 steps)', levels.size === 5, [...levels].join());

  // The drag tick gate shared by the pointer reports and the 8 ms poll.
  const tg = C.tickGuard();
  check('drag tick: due before any tick', tg.due(4, 100) === true);
  tg.mark(100);
  check('drag tick: a poll right after a pointer tick is skipped, and due again after the gap', tg.due(4, 102) === false && tg.due(4, 103.9) === false && tg.due(4, 104) === true);
  tg.mark(104);
  check('drag tick: a mark from either source restarts the gap', tg.due(4, 106) === false && tg.due(4, 108) === true);

  // The drop-target list: built once per window of time, not on every tick; invalidated when strips are re-measured.
  let builds = 0;
  const cache = C.ttlCache(() => ++builds, 120);
  const seenValues = [cache.get(0), cache.get(4), cache.get(8), cache.get(119)];
  check('drop targets: built once for the ticks inside the ttl', builds === 1 && seenValues.every((v) => v === 1), String(builds));
  check('drop targets: rebuilt once the ttl passes', cache.get(120) === 2 && cache.get(130) === 2 && builds === 2);
  cache.invalidate();
  check('drop targets: invalidate() forces the next read to rebuild', cache.get(131) === 3 && builds === 3);
  let ticks = 0;
  const burst = C.ttlCache(() => ++ticks, 120);
  for (let t = 0; t < 1000; t += 4) burst.get(t);
  check('drop targets: a second of 4 ms ticks builds ~9 times, not 250', ticks <= 9, String(ticks));

  // The snapshot's size: CSS pixels, never upscaled, aspect kept.
  const SS = require('../src/features/snapshot-size');
  check('snapshot size: a 2x capture is resized down to CSS pixels', JSON.stringify(SS.snapshotSize({ width: 3840, height: 2160 }, { width: 1920, height: 1080 })) === '{"width":1920,"height":1080}');
  check('snapshot size: the aspect ratio of the capture is kept', JSON.stringify(SS.snapshotSize({ width: 2400, height: 1350 }, { width: 1000, height: 999 })) === '{"width":1000,"height":563}');
  check('snapshot size: a capture already at or under CSS size is left alone', SS.snapshotSize({ width: 1280, height: 720 }, { width: 1280, height: 720 }) === null && SS.snapshotSize({ width: 800, height: 600 }, { width: 1200, height: 900 }) === null);
  check('snapshot size: an unusable size from the renderer leaves the capture as is', SS.snapshotSize({ width: 1280, height: 720 }, null) === null && SS.snapshotSize({ width: 1280, height: 720 }, { width: 0 }) === null && SS.snapshotSize({ width: 0, height: 0 }, { width: 100 }) === null && SS.snapshotSize({ width: 1280, height: 720 }, { width: NaN }) === null);
  check('snapshot size: the width is capped', SS.snapshotSize({ width: 20000, height: 10000 }, { width: 9000 }).width === SS.MAX_SIDE);

  check('frames: the rate gate lets one call through per gap', gate(0) === true && gate(3) === false && gate(7.9) === false && gate(8) === true && gate(10) === false && gate(16) === true);
};
