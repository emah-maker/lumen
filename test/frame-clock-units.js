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
  check('frames: the rate gate lets one call through per gap', gate(0) === true && gate(3) === false && gate(7.9) === false && gate(8) === true && gate(10) === false && gate(16) === true);
};
