// When has a page loaded "enough"? The decision behind navigate's and read_urls' `wait` option, pure so it is unit-testable
// (test/read-speed-units.js); agent.js loadPage feeds it a probe of the page (document.readyState, visible text length,
// time since the last network resource finished) every ~150 ms.
//   interactive  the DOM is parsed (dom-ready) AND already shows real text; a page that has not painted any yet
//                (a JS app shell, a splash) keeps waiting for the full load, so the old behaviour is the fallback
//   load         the load event fired (what loadURL resolved at before)
//   networkidle  loaded, and no resource has finished or started for ~500 ms (late XHR/fetch, lazy content)
// Every mode is capped by capMs, so a page that never settles costs what it always did.
const MODES = ['interactive', 'load', 'networkidle'];
const DEFAULT_WAIT = 'interactive';
const MEANINGFUL_TEXT = 200; // visible characters that make an early read worth having (a nav bar alone is ~50)
const IDLE_MS = 500;

const normalizeWait = (value, fallback = DEFAULT_WAIT) => (MODES.includes(value) ? value : fallback);

// probe: { readyState, textChars, idleMs (since the last resource finished), loading (wc.isLoading()), netIdle? }
// netIdle (optional): the tab's own request tracker says the network is quiet (page-debug.js / idle-tracker.js: it sees
// requests still in flight, and ignores analytics and long-polls); when given it replaces the idleMs guess.
function loadDone(mode, probe, elapsedMs = 0, capMs = 15000) {
  if (elapsedMs >= capMs) return true;
  const rs = probe?.readyState;
  const parsed = rs === 'interactive' || rs === 'complete';
  if (mode === 'load') return rs === 'complete';
  if (mode === 'networkidle') return rs === 'complete' && !probe.loading && (typeof probe.netIdle === 'boolean' ? probe.netIdle : probe.idleMs >= IDLE_MS);
  return rs === 'complete' || (parsed && probe.textChars >= MEANINGFUL_TEXT);
}

// In the page (Claude's isolated world): the probe loadDone reads.
const PROBE_SCRIPT = `(() => {
  let last = 0;
  for (const e of performance.getEntriesByType('resource')) if (e.responseEnd > last) last = e.responseEnd;
  const body = document.body;
  return { readyState: document.readyState, textChars: body ? (body.innerText || '').length : 0, idleMs: Math.round(performance.now() - last) };
})()`;

// Is loading `target` in a tab now at `current` a same-document navigation? Chromium does not load a page for those:
//   'hash'       only the #fragment differs (and target has one): did-navigate-in-page fires, never did-finish-load
//   'identical'  the same URL: loadURL(same) is treated as a reload-ish no-op, so the caller does wc.reload()
//   null         a normal navigation (a fragment-less target of a page that has one is a real load too)
function sameDocument(current, target) {
  if (!current || !target) return null;
  if (current === target) return 'identical';
  const i = target.indexOf('#'), j = current.indexOf('#');
  if (i < 0) return null;
  const tb = target.slice(0, i), cb = j < 0 ? current : current.slice(0, j);
  return tb === cb ? 'hash' : null;
}

module.exports = { sameDocument, MODES, DEFAULT_WAIT, MEANINGFUL_TEXT, IDLE_MS, normalizeWait, loadDone, PROBE_SCRIPT };
