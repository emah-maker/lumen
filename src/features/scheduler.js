// One main-process scheduler for the always-on housekeeping timers (run-slot sweep, tab-sleep sweep, spare new-tab
// policy, AI-status refresh, background tasks), and one shared memory sample, instead of a setInterval each.
//
// - One setTimeout chain: it sleeps until the earliest job is due and runs every job that is due, so jobs with
//   different periods wake the process together (due times are rounded up to a `gridMs` grid, so 5/15/30/60 s
//   periods coincide) instead of once each.
// - Quiet: while every window is hidden or minimised, the screen is locked, the machine is suspended, or the system
//   has been idle a while, a job runs at its `whenHidden` period (a number: slower; false: not at all; omitted: the
//   same, for work that must go on such as background tasks). When things are active again, overdue jobs run at once.
// - memorySample(): one app.getAppMetrics() + system memory read per `ttlMs`, shared by the tab-sleep sweep and the
//   spare-tab policy (separate 30 s and 60 s samplers before).
// Everything time- or Electron-related is injected, so it is unit-tested with a fake clock (test/scheduler-units.js).
function createScheduler({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  gridMs = 5000,
  idleState = null, // () => 'active' | 'idle' | 'locked' | 'unknown' (powerMonitor.getSystemIdleState): read at each wake, no polling of its own
  idleSeconds = 300,
  readMemory = null, // () => Promise|object: { totalBytes, freeBytes, lumenBytes, pressure? }
  memoryTtlMs = 10000,
} = {}) {
  const jobs = new Map();
  const reasons = new Set(); // 'hidden' | 'locked' | 'suspended' | anything a caller names
  let timer = null;
  let timerAt = 0;
  let wakeups = 0;
  let running = false;
  let memo = null; // { at, promise, value }
  let samples = 0;
  let override = null; // tests / measurement: true forces quiet, false forces active, null = detect

  const quiet = () => {
    if (override !== null) return override;
    if (reasons.size) return true;
    try { const s = idleState?.(idleSeconds); if (s === 'idle' || s === 'locked') return true; } catch { /* unknown */ }
    return false;
  };
  const periodOf = (job, q) => (q && job.whenHidden !== undefined ? job.whenHidden : job.ms);
  const grid = (t) => (gridMs > 0 ? Math.ceil(t / gridMs) * gridMs : t);

  function arm() {
    if (running) return; // (re-armed when the run ends)
    let earliest = Infinity;
    for (const j of jobs.values()) if (j.next < earliest) earliest = j.next;
    clearTimer(timer);
    timer = null;
    if (earliest === Infinity) return;
    timerAt = earliest;
    timer = setTimer(wake, Math.max(0, earliest - now()));
    timer?.unref?.();
  }

  function wake() {
    timer = null;
    wakeups++;
    running = true;
    try {
      const t = now();
      const q = quiet();
      for (const j of [...jobs.values()]) {
        if (!jobs.has(j.name) || j.next > t) continue;
        const period = periodOf(j, q);
        // Paused (whenHidden false): not run, not due again until things are active.
        j.next = period === false ? Infinity : grid(t + period);
        if (period === false) continue;
        if (j.busy) { j.skipped++; continue; } // (an async run still going: never two at once)
        j.runs++;
        j.last = t;
        try {
          const r = j.fn();
          if (r && typeof r.then === 'function') { j.busy = true; r.then(() => { j.busy = false; }, () => { j.busy = false; j.errors++; }); }
        } catch { j.errors++; }
      }
    } finally { running = false; }
    arm();
  }

  // The activity state changed (a window was shown or minimised, the screen locked, the Mac woke): jobs whose cadence
  // changes are re-timed from their last run. Coming back to active makes overdue jobs run at once.
  function retime() {
    const t = now();
    const q = quiet();
    for (const j of jobs.values()) {
      const period = periodOf(j, q);
      if (period === false) { j.next = Infinity; continue; }
      const due = (j.last || j.since) + period;
      j.next = due <= t ? t : grid(due);
    }
    arm();
  }

  return {
    // every('sweep', 30000, fn, { whenHidden: 120000 }): returns { stop }. A job with the same name is replaced.
    every(name, ms, fn, { whenHidden, runNow = false } = {}) {
      const t = now();
      const job = { name, ms, fn, whenHidden, since: t, last: 0, next: 0, runs: 0, skipped: 0, errors: 0, busy: false };
      const period = periodOf(job, quiet());
      job.next = runNow ? t : period === false ? Infinity : grid(t + period);
      jobs.set(name, job);
      arm();
      return { stop: () => { if (jobs.get(name) === job) { jobs.delete(name); arm(); } } };
    },
    pause(reason = 'hidden') { if (!reasons.has(reason)) { reasons.add(reason); retime(); } },
    resume(reason = 'hidden') { if (reasons.delete(reason)) retime(); },
    // Tests and measurement only: force quiet (true) or active (false); null goes back to detecting.
    setQuietOverride(v) { override = v; retime(); },
    isQuiet: quiet,
    poke: retime,
    memorySample({ ttlMs = memoryTtlMs } = {}) {
      const t = now();
      if (memo && t - memo.at < ttlMs) return memo.promise;
      const promise = Promise.resolve().then(() => (readMemory ? readMemory() : {})).catch(() => ({})).then((v) => { if (memo && memo.promise === promise) memo.value = v; samples++; return v; });
      memo = { at: t, promise, value: undefined };
      return promise;
    },
    // The last finished sample (synchronous callers); null before the first one.
    lastMemory() { return memo?.value ?? null; },
    stats() {
      return { wakeups, samples, quiet: quiet(), reasons: [...reasons], jobs: [...jobs.values()].map((j) => ({ name: j.name, ms: j.ms, whenHidden: j.whenHidden, next: j.next, runs: j.runs, skipped: j.skipped, errors: j.errors })) };
    },
    jobNames: () => [...jobs.keys()],
    stop() { clearTimer(timer); timer = null; jobs.clear(); },
  };
}

module.exports = { createScheduler };
