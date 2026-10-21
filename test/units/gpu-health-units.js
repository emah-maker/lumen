// Plain Node checks (no Electron) of the GPU-health decisions (features/gpu-health.js) and of the throttle hysteresis in Performance mode
// (features/performance.js): the calm window and its rate limit, software-fallback detection, once-per-session, and a flapping power source.
const gh = require('../../src/features/gpu-health');
const perf = require('../../src/features/performance');
const { EventEmitter } = require('events');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const S = 1000;

// ---- software fallback, from feature-status objects
{
  const hw = { gpu_compositing: 'enabled', rasterization: 'enabled', webgl: 'enabled' };
  check('status: all enabled is hardware', !gh.softwareFallback(hw), JSON.stringify(hw));
  check('status: compositing disabled_software is software', gh.softwareFallback({ ...hw, gpu_compositing: 'disabled_software' }), '');
  check('status: compositing unavailable_software is software', gh.softwareFallback({ ...hw, gpu_compositing: 'unavailable_software' }), '');
  check('status: compositing disabled_off is software', gh.softwareFallback({ ...hw, gpu_compositing: 'disabled_off' }), '');
  check('status: rasterization disabled_software is software', gh.softwareFallback({ ...hw, rasterization: 'disabled_software' }), '');
  check('status: rasterization unavailable_off is software', gh.softwareFallback({ ...hw, rasterization: 'unavailable_off' }), '');
  check('status: webgl off alone is not software drawing', !gh.softwareFallback({ ...hw, webgl: 'disabled_off' }), '');
  check('status: nothing, null, a string are not software', !gh.softwareFallback({}) && !gh.softwareFallback(null) && !gh.softwareFallback('x'), '');
  const w = gh.statusWords({ gpu_compositing: 'enabled_on', rasterization: 'C:\\Users\\me', adapter: 'NVIDIA', webgl: 'disabled_software' });
  check('status words: only plain words of the known keys are kept', JSON.stringify(w) === '{"gpu_compositing":"enabled_on","webgl":"disabled_software"}', JSON.stringify(w));
}

// ---- the calm window: a GPU loss or a real display change; one window per 3 minutes; never more than 10 s in 3 minutes
{
  const c = gh.createCalm();
  check('calm: off to begin with', !c.active(0), '');
  check('calm: a GPU loss begins it', c.poke('gpu', 1000) === true && c.active(1000), '');
  check('calm: it lasts 10 s, then ends by itself', c.active(10999) && !c.active(11000), '');
  check('calm: a power event never starts one', c.poke('power', 500000) === false && !c.active(500000), '');
  check('calm: speed-limit and thermal never start one', !c.poke('speed-limit', 500000) && !c.poke('thermal', 500000), '');
  const d = gh.createCalm();
  d.poke('gpu', 0);
  check('calm: a second loss inside the window does not extend it', d.poke('gpu', 8 * S) === false && !d.active(10 * S), '');
  check('calm: a burst of resets after it ends is ignored for 3 minutes', d.poke('gpu', 12 * S) === false && !d.active(12 * S) && d.poke('display', 100 * S) === false, '');
  check('calm: a new window may begin 3 minutes after the last began', d.poke('display', 180 * S) === true && d.active(185 * S), '');
  // 20 minutes of resets every 250 ms: calm time in any 3-minute span is at most 10 s
  const e = gh.createCalm();
  const spans = [];
  for (let t = 0; t < 20 * 60 * S; t += 250) { e.poke(t % 2000 === 0 ? 'gpu' : 'display', t); if (e.active(t)) spans.push(t); }
  let worst = 0;
  for (let i = 0, j = 0; i < spans.length; i++) { while (spans[i] - spans[j] >= 180 * S) j++; worst = Math.max(worst, (i - j + 1) * 250); }
  check(`calm: under constant resets the worst 3-minute span has at most 10 s of calm (${worst / S} s)`, worst > 0 && worst <= 10 * S, worst);
}

// ---- the notice: once per session, again after a further reset, only after a real reset, only with acceleration on
{
  const soft = { gpu_compositing: 'disabled_software', rasterization: 'disabled_software' };
  const hw = { gpu_compositing: 'enabled', rasterization: 'enabled' };
  const n = gh.createNotice();
  check('notice: not before any reset, even if drawing is in software', !n.shouldShow({ status: soft, hwOn: true }), '');
  n.reset();
  check('notice: not while drawing is on the GPU', !n.shouldShow({ status: hw, hwOn: true }), '');
  check('notice: not when acceleration is off in Settings', !n.shouldShow({ status: soft, hwOn: false }), '');
  check('notice: not when it was already software before the reset (a restart would not help)', !n.shouldShow({ status: soft, hwOn: true, baselineSoft: true }), '');
  check('notice: shown after a reset that left software drawing', n.shouldShow({ status: soft, hwOn: true }) === true, '');
  check('notice: not again for the same reset (checks repeat)', !n.shouldShow({ status: soft, hwOn: true }) && !n.shouldShow({ status: soft, hwOn: true }), '');
  n.reset();
  check('notice: again after a further reset', n.shouldShow({ status: soft, hwOn: true }) === true && !n.shouldShow({ status: soft, hwOn: true }), '');
}

// ---- the safety net: six GPU losses within two minutes
{
  const c = gh.createLossCounter();
  let hit = false;
  for (let i = 0; i < 5; i++) hit = c.add(i * 10 * S);
  check('losses: five in a row are not yet "keeps failing"', !hit && c.count() === 5, c.count());
  check('losses: the sixth within two minutes is', c.add(60 * S) === true, c.count());
  const d = gh.createLossCounter();
  let any = false;
  for (let i = 0; i < 20; i++) any = d.add(i * 30 * S) || any; // one every 30 s: never six inside 120 s
  check('losses: one every 30 s never trips it (the window slides)', !any, d.count());
  check('losses: the limits are 6 in 2 minutes', gh.UNSTABLE_LOSSES === 6 && gh.UNSTABLE_WINDOW_MS === 120 * S, '');
}

// ---- safe drawing mode is for one session: the flag is in the relaunch arguments only, never in settings
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'settings', 'settings-backend.js'), 'utf8');
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  check('safe mode: --lumen-safe-gpu turns acceleration off at launch without touching the setting', /--lumen-safe-gpu'\)\) app\.disableHardwareAcceleration\(\)/.test(src) && !/hardwareAcceleration\s*:\s*false[^\n]*safe/i.test(src), '');
  check('safe mode: the relaunch adds the flag only when asked, and drops an old one', /filter\(\(a\) => a !== '--lumen-safe-gpu'\)/.test(main) && /safe === true \? \[\.\.\.args, '--lumen-safe-gpu'\] : args/.test(main), '');
  check('safe mode: the crash limit switch is on only with hardware drawing', /else if \(!process\.env\.LUMEN_TEST_KEEP_GPU_CRASH_LIMIT\) app\.commandLine\.appendSwitch\('disable-gpu-process-crash-limit'\)/.test(src), '');
}

// ---- Performance mode: a flapping power source must not flip the mode (hysteresis, fake clock)
function rig() {
  let now = 0; const timers = [];
  const pm = new EventEmitter();
  const changes = [];
  const app = { commandLine: { appendSwitch() {} }, getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }), isHardwareAccelerationEnabled: () => true };
  const p = perf.create({
    app, readSettings: () => ({ performanceMode: 'auto' }), powerMonitor: pm, totalMem: 16 * 1024 ** 3, cpus: 16,
    onChange: (i) => changes.push({ at: now, active: i.active }),
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, live: true, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
  });
  p.start();
  const advance = (to) => { // run the timers due by `to`, in order
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false; now = Math.max(now, due.at); due.fn();
    }
    now = to;
  };
  return { pm, p, changes, advance };
}
{
  const r = rig();
  for (let t = 2 * S, i = 0; t <= 10 * 60 * S; t += 2 * S, i++) { r.advance(t); r.pm.emit('speed-limit-change', { limit: i % 2 ? 100 : 50 }); }
  r.advance(11 * 60 * S);
  check(`perf: 10 minutes of speed-limit flapping every 2 s changes the mode at most once (${r.changes.length})`, r.changes.length <= 1, JSON.stringify(r.changes));
}
{
  const r = rig();
  r.pm.emit('speed-limit-change', { limit: 50 });
  r.advance(14 * S);
  check('perf: throttled for 14 s: not yet on', !r.p.active() && r.changes.length === 0, '');
  r.advance(16 * S);
  check('perf: throttled for 15 s: on', r.p.active() && r.changes.length === 1, JSON.stringify(r.changes));
  r.pm.emit('speed-limit-change', { limit: 100 });
  r.advance(16 * S + 59 * S);
  check('perf: back to normal for 59 s: still on', r.p.active(), '');
  r.advance(16 * S + 125 * S);
  check('perf: stable for 60 s and 2 minutes since the switch: off', !r.p.active() && r.changes.length === 2, JSON.stringify(r.changes));
}
{
  const r = rig();
  r.pm.emit('speed-limit-change', { limit: 50 }); r.advance(20 * S); // on at 15 s
  r.pm.emit('speed-limit-change', { limit: 100 }); r.advance(90 * S); // stable 60 s, but the last switch was less than 2 minutes ago
  check('perf: no switch within 2 minutes of the last one', r.p.active() && r.changes.length === 1, JSON.stringify(r.changes));
  r.advance(136 * S);
  check('perf: it leaves once 2 minutes have passed', !r.p.active() && r.changes.length === 2, JSON.stringify(r.changes));
  r.pm.emit('thermal-state-change', { state: 'critical' }); r.pm.emit('thermal-state-change', { state: 'nominal' });
  r.advance(300 * S);
  check('perf: a thermal blip shorter than 15 s changes nothing', r.changes.length === 2, JSON.stringify(r.changes));
}
{
  const r = rig();
  r.pm.emit('speed-limit-change', { limit: 50 }); r.advance(5 * S);
  r.pm.emit('speed-limit-change', { limit: 40 }); r.advance(16 * S); // still throttled: the first report's hold stands
  check('perf: repeated throttled reports do not restart the 15 s hold', r.p.active(), '');
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nAll passed');
