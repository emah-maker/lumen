// features/scheduler.js (finding 6 of the audit): one timer chain for the housekeeping jobs, slower while nothing is
// visible, one shared memory sample. Plain Node with a fake clock and a fake timer: no waiting.
const { createScheduler } = require('../src/features/scheduler');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

function rig(opts = {}) {
  const c = { t: 1000000, timers: [] };
  const sched = createScheduler({
    now: () => c.t,
    setTimer: (fn, ms) => { const h = { fn, at: c.t + ms, live: true }; c.timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.live = false; },
    ...opts,
  });
  // advance the fake clock, firing the pending timer when it is due
  c.advance = (ms) => {
    const end = c.t + ms;
    for (;;) {
      const next = c.timers.filter((h) => h.live).sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      c.t = Math.max(c.t, next.at);
      next.live = false;
      next.fn();
    }
    c.t = end;
  };
  c.pending = () => c.timers.filter((h) => h.live).length;
  return { c, sched };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = (sched, name) => sched.stats().jobs.find((j) => j.name === name);

(async () => {
  // one chain, ordering, coinciding periods
  {
    const { c, sched } = rig({ gridMs: 5000 });
    const log = [];
    sched.every('slots', 5000, () => log.push('s'));
    sched.every('ai', 15000, () => log.push('a'));
    sched.every('sweep', 30000, () => log.push('w'));
    sched.every('spare', 60000, () => log.push('p'));
    check('one timer pending for four jobs', c.pending() === 1, c.pending());
    c.advance(60000);
    const n = (x) => log.filter((l) => l === x).length;
    check('periods hold: 12 slot runs, 4 ai, 2 sweep, 1 spare in 60 s', n('s') === 12 && n('a') === 4 && n('w') === 2 && n('p') === 1, log.join(''));
    check('wakeups are shared: 12 in 60 s, not 19 separate timers', sched.stats().wakeups === 12, sched.stats().wakeups);
    check('still one timer pending', c.pending() === 1);
    check('jobNames lists the registered jobs', sched.jobNames().join() === 'slots,ai,sweep,spare');
  }
  // stop
  {
    const { c, sched } = rig({ gridMs: 0 });
    let n = 0;
    const h = sched.every('x', 1000, () => n++);
    c.advance(3000);
    h.stop();
    c.advance(5000);
    check('stop() ends a job and its timer', n === 3 && c.pending() === 0, `${n} ${c.pending()}`);
  }
  // pause (whenHidden slower / false), resume catches up at once
  {
    const { c, sched } = rig({ gridMs: 0 });
    const runs = { slots: 0, sweep: 0, bg: 0, vis: 0 };
    sched.every('slots', 5000, () => runs.slots++, { whenHidden: 15000 });
    sched.every('sweep', 30000, () => runs.sweep++, { whenHidden: 120000 });
    sched.every('bg', 15000, () => runs.bg++); // never slowed
    sched.every('only-visible', 10000, () => runs.vis++, { whenHidden: false });
    c.advance(30000);
    check('active cadence: slots 6, sweep 1, bg 2, only-visible 3', runs.slots === 6 && runs.sweep === 1 && runs.bg === 2 && runs.vis === 3, JSON.stringify(runs));
    sched.pause('hidden');
    check('quiet after pause', sched.isQuiet() === true);
    const before = { ...runs };
    c.advance(120000);
    check('hidden: slots back off to 15 s (8 runs in 120 s)', runs.slots - before.slots === 8, runs.slots - before.slots);
    check('hidden: sweep backs off to 120 s (1 run)', runs.sweep - before.sweep === 1, runs.sweep - before.sweep);
    check('hidden: a job with no whenHidden keeps its cadence (8 in 120 s)', runs.bg - before.bg === 8, runs.bg - before.bg);
    check('hidden: a whenHidden:false job does not run', runs.vis === before.vis, runs.vis - before.vis);
    sched.resume('hidden');
    c.advance(1);
    check('resume: the paused job runs again at once', runs.vis === before.vis + 1, runs.vis - before.vis);
    c.advance(5000);
    check('resume: normal cadence returns (slots every 5 s)', runs.slots - before.slots >= 9, runs.slots - before.slots);
    sched.pause('hidden'); sched.pause('locked'); sched.resume('hidden');
    check('locked keeps it quiet after the window is back', sched.isQuiet() === true);
    sched.resume('locked');
    check('both cleared: active', sched.isQuiet() === false);
  }
  // idle state from powerMonitor
  {
    let idle = 'active';
    const { c, sched } = rig({ gridMs: 0, idleState: () => idle });
    let n = 0;
    sched.every('x', 1000, () => n++, { whenHidden: 10000 });
    c.advance(5000);
    check('active system: normal cadence', n === 5, n);
    idle = 'idle';
    sched.poke();
    const at = n;
    c.advance(30000);
    check('idle system: backs off (3 runs in 30 s, not 30)', n - at <= 4, n - at);
    check('locked state counts as quiet', (idle = 'locked', sched.isQuiet()) === true);
    idle = 'active';
    check('back to active', sched.isQuiet() === false);
  }
  {
    const { sched } = rig({ idleState: () => { throw new Error('not ready'); } });
    check('an unreadable idle state is treated as active', sched.isQuiet() === false);
  }
  // a throwing job, an async job never overlapping itself
  {
    const { c, sched } = rig({ gridMs: 0 });
    let after = 0, slow = 0, release;
    sched.every('boom', 1000, () => { throw new Error('x'); });
    sched.every('after', 1000, () => after++);
    sched.every('slow', 1000, () => { slow++; return new Promise((r) => { release = r; }); });
    c.advance(5000);
    check('a throwing job does not stop the others', after === 5, after);
    check('an async job still running is not started again', slow === 1 && job(sched, 'slow').skipped === 4, JSON.stringify(job(sched, 'slow')));
    release(); await sleep(5);
    c.advance(1000);
    check('it runs again once it finished', slow === 2, slow);
    check('errors are counted', job(sched, 'boom').errors === 6, job(sched, 'boom').errors);
  }
  // override
  {
    const { c, sched } = rig({ gridMs: 0 });
    let n = 0;
    sched.every('x', 1000, () => n++, { whenHidden: false });
    sched.setQuietOverride(true);
    c.advance(5000);
    check('override quiet: paused', n === 0, n);
    sched.setQuietOverride(false);
    c.advance(2000);
    check('override active: runs', n >= 2, n);
  }
  // shared memory sample
  {
    let reads = 0;
    const { c, sched } = rig({ readMemory: () => { reads++; return Promise.resolve({ totalBytes: 100, freeBytes: 50, lumenBytes: 7, pressure: false }); }, memoryTtlMs: 10000 });
    const [a, b] = await Promise.all([sched.memorySample(), sched.memorySample()]);
    check('two callers in the same moment share one read', reads === 1 && a === b, reads);
    c.advance(5000);
    await sched.memorySample();
    check('within the ttl: still one read (the 30 s sweep and 60 s spare policy coincide)', reads === 1, reads);
    c.advance(6000);
    await sched.memorySample();
    check('after the ttl: a new read', reads === 2, reads);
    await sched.memorySample({ ttlMs: 0 });
    check('ttlMs 0 forces a fresh read', reads === 3, reads);
    check('lastMemory() holds the finished sample', sched.lastMemory()?.lumenBytes === 7);
    check('stats counts samples', sched.stats().samples === 3, sched.stats().samples);
  }
  {
    const { sched } = rig({ readMemory: () => Promise.reject(new Error('no metrics')) });
    const v = await sched.memorySample();
    check('a failing sample is an empty fact set, not a throw', v && Object.keys(v).length === 0);
    check('lastMemory before any sample is null', rig().sched.lastMemory() === null);
  }
  // real timers smoke
  {
    const sched = createScheduler({ gridMs: 0 });
    let n = 0;
    sched.every('x', 20, () => n++);
    await sleep(110);
    sched.stop();
    const seen = n;
    await sleep(60);
    check('real timers: fires roughly on period', seen >= 3 && seen <= 6, seen);
    check('stop() clears everything', n === seen && sched.jobNames().length === 0);
  }
  process.exit(failures ? 1 : 0);
})();
