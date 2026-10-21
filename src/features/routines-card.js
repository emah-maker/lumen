// [widgets] The Routines card for the home page: what the user's scheduled routines will do next and what they did last,
// shaped small from the runner's view (background-runner.js routineView). Text and numbers only: the page sets all of it with
// textContent and formats the times itself (in the page's language), so nothing here is markup or a locale string.
// Pure (no Electron, no clock of its own): main.js hands shape() the view, test/units/routines-card-units.js runs it.
//
//   shape(view)       { enabled, offline, counts: { total, on, waitingApproval }, upcoming: [{ id, title, nextRun }],
//                       latest: [{ id, title, status, at, trigger, snippet, error, unseen, waiting }] }
//   ROUTINE_ID_RE     the shape of a routine's id (the page names one in do=routine-open; widgets.js checks it)
(function () {
'use strict';

const MAX_UPCOMING = 3;
const MAX_LATEST = 3;
const SNIPPET = 140;
const STATUSES = ['done', 'failed', 'stopped', 'interrupted', 'skipped'];
const TRIGGERS = ['schedule', 'catch-up', 'manual'];
const ROUTINE_ID_RE = /^[\w-]{1,60}$/;

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const time = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function shape(view) {
  const v = view && typeof view === 'object' ? view : {};
  const all = (Array.isArray(v.routines) ? v.routines : []).filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && ROUTINE_ID_RE.test(r.id));
  const title = (r) => clean(r.title, 80) || 'Routine';
  const waiting = (r) => Number(r.pending) > 0;
  const upcoming = all
    .filter((r) => r.enabled !== false && time(r.nextRun) > 0 && (v.enabled !== false))
    .sort((a, b) => time(a.nextRun) - time(b.nextRun) || title(a).localeCompare(title(b)))
    .slice(0, MAX_UPCOMING)
    .map((r) => ({ id: r.id, title: title(r), nextRun: time(r.nextRun) }));
  // A routine waiting for the user's OK is listed first even before it has a finished run: that is the thing to act on.
  const last = (r) => (r.last && typeof r.last === 'object' ? r.last : {});
  const stamp = (r) => time(last(r).at) || (waiting(r) ? time(r.lastRun) || time(v.now) || 1 : 0);
  const latest = all
    .filter((r) => stamp(r) > 0)
    .sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || stamp(b) - stamp(a) || title(a).localeCompare(title(b)))
    .slice(0, MAX_LATEST)
    .map((r) => ({
      id: r.id,
      title: title(r),
      status: STATUSES.includes(last(r).status) ? last(r).status : 'done',
      at: stamp(r),
      trigger: TRIGGERS.includes(last(r).trigger) ? last(r).trigger : 'schedule',
      snippet: clean(last(r).snippet, SNIPPET),
      error: clean(last(r).error, SNIPPET),
      unseen: r.unseen === true,
      waiting: waiting(r),
    }));
  return {
    enabled: v.enabled !== false,
    offline: v.offline === true,
    counts: { total: all.length, on: all.filter((r) => r.enabled !== false).length, waitingApproval: all.filter(waiting).length },
    upcoming,
    latest,
  };
}

const api = { shape, ROUTINE_ID_RE, MAX_UPCOMING, MAX_LATEST, SNIPPET };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
