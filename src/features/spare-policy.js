// When the spare new-tab page (main.js makeSpareNewTab) may exist. At most ONE spare, and it costs a renderer process,
// so it is made only once start-up has settled (the first tab loaded: not during session restore) and is dropped while
// the machine is short of memory. Pure: main.js passes the facts in and does what this says.
const LOW_FREE_FRACTION = 0.1; // less than 10% of system memory free
const LOW_FREE_BYTES = 1024 * 1024 * 1024; // or under 1 GB free
const LUMEN_BYTES_CAP = 6 * 1024 * 1024 * 1024; // or Lumen itself already holds more than 6 GB

// facts: { totalBytes, freeBytes, lumenBytes, pressure } (any may be missing: then no limit from it applies)
function memoryTight(f = {}) {
  if (f.pressure) return true; // macOS' own pressure level (main.js memoryInfo)
  const { totalBytes: total, freeBytes: free, lumenBytes: lumen } = f;
  if (total > 0 && free >= 0 && (free / total < LOW_FREE_FRACTION || free < LOW_FREE_BYTES)) return true;
  return lumen > LUMEN_BYTES_CAP;
}

// state: { hasSpare, firstTabDone, memory: facts }. Returns 'make' (none yet, fine to start one), 'keep', 'drop' (memory is
// tight: free it) or 'wait' (none, and not now: start-up still loading, or memory tight).
function spareAction({ hasSpare = false, firstTabDone = false, memory = {} } = {}) {
  const tight = memoryTight(memory);
  if (hasSpare) return tight ? 'drop' : 'keep';
  return firstTabDone && !tight ? 'make' : 'wait';
}

module.exports = { memoryTight, spareAction, LOW_FREE_FRACTION, LOW_FREE_BYTES, LUMEN_BYTES_CAP };
