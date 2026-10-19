// Settings > Advanced > Diagnostics > "Record tab-switch timings": an opt-in recorder that times each tab switch on the user's own machine,
// where hidden test windows cannot (they count every tab as visible, so compositing, raster and visibility costs never show up).
//
// Privacy: a record holds numbers and a few words (input kind, page kind, tab state), the tab's session number and its renderer's process id.
// It never holds a URL, a title, a site name or a hash of one: no site is recorded at all. Nothing leaves the computer; the user exports the
// last 200 switches to a file they choose.
//
// Off (the default): nothing runs. main.js loads this module only when the setting is on (a lazy proxy), `begin` returns null, and the
// recorder owns no listener and no timer. On: one switch costs a few `performance.now()` reads, one rAF probe in the tab (an isolated world),
// one event-loop-delay histogram while the switch settles, and two getAppMetrics() calls.
//
// One switch, in order (all wall-clock ms, from `performance.timeOrigin + performance.now()`):
//   input   the click or key reached the UI (clicks carry their own time; keys: main's handler)
//   main    switchTab began        shown   the view was made visible (layout() done)
//   paint   the tab's first animation frame after it became visible (its renderer produced a frame)
//   strip   the UI's tab strip drew the tab active
const { monitorEventLoopDelay } = require('perf_hooks');

const MAX = 200; // the ring buffer
const SETTLE_MS = 1500; // a switch that never reports its paint or strip is closed after this long

const wallNow = () => performance.timeOrigin + performance.now();
const round = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
// os.getPriority() of a renderer on Windows: 19 is the idle class Chromium gives a hidden tab's process (background), 10 below normal, 0 normal.
// (Efficiency mode, EcoQoS, which Chromium turns on with it, cannot be read from here: the priority class is the visible half of the same state.)
const priorityLabel = (n) => (!Number.isFinite(n) ? null : n >= 15 ? 'idle' : n >= 5 ? 'below-normal' : n > -4 ? 'normal' : n > -10 ? 'above-normal' : 'high');
const idleBucket = (ms) => (!Number.isFinite(ms) ? 'never' : ms < 5e3 ? 'under 5 s' : ms < 60e3 ? '5-60 s' : ms < 600e3 ? '1-10 min' : 'over 10 min');
const quantile = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? round(v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]) : null; };
const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? round(b - a) : null);

// deps: { now, monitor (-> { enable, disable, reset, max }), metrics (-> app.getAppMetrics()), gpuStatus (-> app.getGPUFeatureStatus()), versions }
function create(deps = {}) {
  const now = deps.now || wallNow;
  const monitor = deps.monitor || (() => monitorEventLoopDelay({ resolution: 10 }));
  let on = false;
  let seq = 0;
  let ring = [];
  let open = null; // the switch still collecting its paint and strip
  let hist = null;
  let gpu = null;
  let gpuTaken = false;

  function gpuOnce() {
    if (gpuTaken) return gpu;
    gpuTaken = true;
    try { gpu = deps.gpuStatus ? { ...deps.gpuStatus() } : null; } catch { gpu = null; }
    return gpu;
  }
  function cpuNow(pid) {
    const out = { gpu: null, renderer: null, browser: null };
    try {
      for (const m of deps.metrics ? deps.metrics() : []) {
        const pct = round(m.cpu?.percentCPUUsage);
        if (m.type === 'GPU') out.gpu = (out.gpu ?? 0) + pct;
        else if (m.type === 'Browser') out.browser = pct;
        else if (m.pid === pid) out.renderer = pct;
      }
    } catch { /* leave nulls */ }
    return out;
  }

  function finish(h) {
    if (!h || h.closed) return;
    h.closed = true;
    clearTimeout(h.timer);
    const r = h.rec;
    if (open === h) {
      open = null;
      try { r.loopLagMaxMs = round(hist.max / 1e6); hist.disable(); } catch { /* none */ }
    }
    r.cpuPercent = cpuNow(r.rendererPid);
    r.ms = {
      inputToMain: diff(h.t.input, h.t.main),
      mainToShown: diff(h.t.main, h.t.shown),
      shownToPaint: diff(h.t.shown, h.t.paint),
      inputToStrip: diff(h.t.input, h.t.strip),
      inputToPaint: diff(h.t.input, h.t.paint),
    };
  }

  // `facts`: { source: 'click'|'key'|'other', inputAt, tab (number), page: 'lumen'|'web', state: 'live'|'frozen'|'unloaded'|'placeholder', pid, throttled }.
  function begin(facts = {}) {
    if (!on) return null;
    if (open) finish(open); // a newer switch closes the one before
    const t = { input: Number.isFinite(facts.inputAt) ? facts.inputAt : null, main: now(), shown: null, paint: null, strip: null };
    if (t.input === null) t.input = t.main;
    const rec = {
      n: ++seq,
      source: ['click', 'key'].includes(facts.source) ? facts.source : 'other',
      page: facts.page === 'lumen' ? 'lumen' : 'web',
      tab: Number.isInteger(facts.tab) ? facts.tab : null,
      state: ['live', 'frozen', 'unloaded', 'placeholder'].includes(facts.state) ? facts.state : 'live',
      reloaded: false,
      rendererPid: Number.isInteger(facts.pid) ? facts.pid : null,
      visibilityBefore: null,
      visibilityAfter: null,
      throttledBackground: Boolean(facts.throttled),
      kept: ['hover', 'recent'].includes(facts.ready) ? facts.ready : null, // kept ready (tab-ready.js) when the switch began: 'hover', 'recent' or not
      idleMs: Number.isFinite(facts.idleMs) ? Math.round(facts.idleMs) : null, // since the tab was last in front (null: never was)
      priorityBefore: Number.isFinite(facts.priority) ? facts.priority : null, // the renderer's OS priority as the switch began (see priorityLabel)
      priorityBeforeLabel: priorityLabel(facts.priority),
      priorityAfter: null,
      priorityAfterLabel: null,
      onBattery: Boolean(facts.onBattery),
      visibleCalls: null, // setVisible calls made while the switch settled (a final switch: 2, a show and a hide)
      layoutDeferred: Boolean(facts.rapid), // (a switch in a burst: its view swap waited for the frame and went to the latest tab)
      superseded: false,
      loopLagMaxMs: null,
      cpuPercent: null,
      ms: null,
    };
    ring.push(rec);
    if (ring.length > MAX) ring = ring.slice(ring.length - MAX);
    try { hist ||= monitor(); hist.reset(); hist.enable(); } catch { hist = null; }
    const h = { rec, t, closed: false, timer: null };
    h.timer = setTimeout(() => finish(h), SETTLE_MS);
    h.timer.unref?.();
    open = h;
    gpuOnce();
    return {
      record: rec,
      reloaded: () => { rec.reloaded = true; },
      visibilityBefore: (v) => { rec.visibilityBefore = typeof v === 'string' ? v.slice(0, 12) : null; },
      shown: () => { t.shown = now(); cpuNow(); }, // (the call is the CPU baseline: usage is measured since the last call)
      paint: (at, visibility) => { if (h.closed) return; t.paint = Number.isFinite(at) ? at : now(); rec.visibilityAfter = typeof visibility === 'string' ? visibility.slice(0, 12) : null; if (t.strip !== null) finish(h); },
      strip: (at) => { if (h.closed) return; t.strip = Number.isFinite(at) ? at : now(); if (t.paint !== null) finish(h); },
      after: ({ priority, visibleCalls } = {}) => {
        if (Number.isFinite(priority)) { rec.priorityAfter = priority; rec.priorityAfterLabel = priorityLabel(priority); }
        if (Number.isFinite(visibleCalls) && Number.isFinite(facts.visibleCallsAtStart)) rec.visibleCalls = visibleCalls - facts.visibleCallsAtStart;
      },
      superseded: () => { rec.superseded = true; },
      finish: () => finish(h),
    };
  }

  // Groups of switches side by side: the question "is the slow one the tab that sat idle in efficiency mode?" answered from the numbers.
  function summarize(list) {
    const group = (keyOf) => {
      const by = {};
      for (const r of list) {
        if (!r.ms || r.superseded) continue;
        const k = keyOf(r);
        (by[k] ||= []).push(r);
      }
      return Object.fromEntries(Object.entries(by).map(([k, rs]) => [k, { n: rs.length, inputToPaintMedian: quantile(rs.map((r) => r.ms.inputToPaint), 0.5), inputToPaintP95: quantile(rs.map((r) => r.ms.inputToPaint), 0.95), shownToPaintMedian: quantile(rs.map((r) => r.ms.shownToPaint), 0.5), shownToPaintP95: quantile(rs.map((r) => r.ms.shownToPaint), 0.95) }]));
    };
    return {
      byState: group((r) => r.state),
      byIdleBefore: group((r) => idleBucket(r.idleMs)),
      byRendererPriorityBefore: group((r) => r.priorityBeforeLabel || 'unknown'),
      byKeptReady: group((r) => r.kept || 'no'),
      byTrigger: group((r) => (r.layoutDeferred ? 'burst' : r.source)),
      maxVisibleCallsPerSwitch: Math.max(0, ...list.map((r) => r.visibleCalls || 0)),
    };
  }

  return {
    enabled: () => on,
    setEnabled(next) {
      next = Boolean(next);
      if (next === on) return;
      on = next;
      if (!on && open) finish(open);
    },
    begin,
    count: () => ring.length,
    clear() { ring = []; },
    // The file the user saves: no URL, no title, no site (see the top).
    exportData() {
      if (open) finish(open);
      return {
        format: 'lumen-tab-switch-timings',
        version: 2, // 2: kept, idleMs, priorityBefore/After, onBattery, visibleCalls, layoutDeferred per switch; summary; settings; flags
        ...(deps.extra ? (() => { try { return deps.extra() || {}; } catch { return {}; } })() : {}), // (the tab settings, the switches and the OS: numbers and names only, see main.js)
        summary: summarize(ring),
        privacy: 'Numbers and kinds only: no URL, title or site is recorded. Times are milliseconds.',
        exportedAt: new Date().toISOString(),
        app: deps.versions || null,
        gpuFeatureStatus: gpuOnce(),
        switches: ring.map((r) => ({ ...r })),
      };
    },
    exportJson() { return JSON.stringify(this.exportData(), null, 2); },
    MAX,
  };
}

module.exports = { create, MAX };
