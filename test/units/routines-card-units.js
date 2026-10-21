// The home page's Routines card (features/routines-card.js): what it keeps from the runner's view, in what order, and that
// everything it hands the page is plain, short text. Pure node: no window, no clock, no network.
const RC = require('../../src/features/routines-card');

module.exports = async function routinesCardUnits(check) {
  const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
  const H = 3600e3;
  const r = (id, over = {}) => ({ id, title: `Routine ${id}`, schedule: {}, enabled: true, status: 'idle', template: '', nextRun: null, lastRun: null, unseen: false, pending: 0, runs: 0, last: null, ...over });
  const ran = (at, over = {}) => ({ status: 'done', at, trigger: 'schedule', scheduledFor: at, snippet: 'All quiet.', error: '', ...over });

  // ---- empty and odd input ----
  const none = RC.shape({ ok: true, enabled: true, routines: [] }, NOW);
  check('routines card: no routines gives empty lists and zero counts', none.upcoming.length === 0 && none.latest.length === 0 && none.counts.total === 0 && none.enabled === true && none.offline === false, JSON.stringify(none));
  const odd = RC.shape(null, NOW);
  check('routines card: no view at all is an empty card, not an error', odd.counts.total === 0 && Array.isArray(odd.upcoming), JSON.stringify(odd));
  const junk = RC.shape({ routines: [null, 5, 'x', { id: 7 }, { id: '../x' }, { id: 'a b' }, r('ok1')] }, NOW);
  check('routines card: entries without a plain id are dropped', junk.counts.total === 1 && junk.upcoming.length === 0, JSON.stringify(junk.counts));

  // ---- upcoming ----
  const view = {
    enabled: true,
    offline: false,
    routines: [
      r('late', { nextRun: NOW + 9 * H }),
      r('soon', { nextRun: NOW + H }),
      r('mid', { nextRun: NOW + 3 * H }),
      r('fourth', { nextRun: NOW + 20 * H }),
      r('off', { enabled: false, nextRun: null }),
      r('never', { nextRun: null }),
    ],
  };
  const d = RC.shape(view, NOW);
  check('routines card: up to three upcoming runs, soonest first', d.upcoming.map((u) => u.id).join() === 'soon,mid,late', d.upcoming.map((u) => u.id).join());
  check('routines card: an upcoming run is just id, title and time', Object.keys(d.upcoming[0]).sort().join() === 'id,nextRun,title' && d.upcoming[0].nextRun === NOW + H, JSON.stringify(d.upcoming[0]));
  check('routines card: counts say how many routines there are and how many are on', d.counts.total === 6 && d.counts.on === 5 && d.counts.waitingApproval === 0, JSON.stringify(d.counts));
  const offOne = RC.shape({ routines: [r('x', { enabled: false, nextRun: NOW + H })] }, NOW);
  const asking = RC.shape({ now: NOW, routines: [{ id: 'ask', title: 'Asks', enabled: true, pending: 1, lastRun: NOW - 5000, nextRun: NOW + H, last: null }, { id: 'old', title: 'Old', enabled: true, nextRun: NOW + 2 * H, last: { status: 'done', at: NOW - 1000, trigger: 'schedule', snippet: 'x' } }] });
  check('routines card: a routine waiting for an OK is listed first even with no finished run yet', asking.latest.map((x) => x.id).join() === 'ask,old' && asking.latest[0].waiting === true && asking.latest[0].at === NOW - 5000 && asking.counts.waitingApproval === 1, JSON.stringify(asking.latest));
  check('routines card: a routine with no run and no approval is not in the latest results', RC.shape({ now: NOW, routines: [{ id: 'new', title: 'New', enabled: true, nextRun: NOW + H, last: null }] }).latest.length === 0);
  check('routines card: a switched-off routine is never upcoming', offOne.upcoming.length === 0, JSON.stringify(offOne.upcoming));
  const paused = RC.shape({ enabled: false, routines: [r('x', { nextRun: NOW + H })] }, NOW);
  check('routines card: with Routines paused there is nothing upcoming and the card says so', paused.enabled === false && paused.upcoming.length === 0, JSON.stringify(paused));
  const tie = RC.shape({ routines: [r('b', { title: 'Beta', nextRun: NOW + H }), r('a', { title: 'Alpha', nextRun: NOW + H })] }, NOW);
  check('routines card: the same time sorts by title, so the card does not reshuffle', tie.upcoming.map((u) => u.id).join() === 'a,b', '');

  // ---- latest ----
  const lv = RC.shape({
    routines: [
      r('old', { last: ran(NOW - 9 * H) }),
      r('new', { last: ran(NOW - H, { snippet: 'Fresh' }), unseen: true }),
      r('fail', { last: ran(NOW - 2 * H, { status: 'failed', snippet: '', error: 'The page did not load.' }) }),
      r('late', { last: ran(NOW - 3 * H, { trigger: 'catch-up' }) }),
      r('never'),
    ],
  }, NOW);
  check('routines card: up to three latest results, newest first, only routines that have run', lv.latest.map((x) => x.id).join() === 'new,fail,late', lv.latest.map((x) => x.id).join());
  check('routines card: a result keeps status, time, trigger, snippet, error and whether it is unseen', lv.latest[0].snippet === 'Fresh' && lv.latest[0].unseen === true && lv.latest[0].status === 'done' && lv.latest[1].status === 'failed' && lv.latest[1].error === 'The page did not load.' && lv.latest[2].trigger === 'catch-up' && lv.latest[0].at === NOW - H, JSON.stringify(lv.latest));
  const weird = RC.shape({ routines: [r('w', { last: ran(NOW, { status: 'exploded', trigger: 'cosmic' }) })] }, NOW);
  check('routines card: an unknown status or trigger falls back to the plain ones', weird.latest[0].status === 'done' && weird.latest[0].trigger === 'schedule', JSON.stringify(weird.latest[0]));
  const nothing = RC.shape({ routines: [r('z', { last: { status: 'done', at: 0 } })] }, NOW);
  check('routines card: a result with no time is not shown', nothing.latest.length === 0, '');

  // ---- approvals ----
  const ap = RC.shape({ routines: [r('a', { pending: 2, last: ran(NOW - H) }), r('b', { pending: 0, last: ran(NOW - 2 * H) }), r('c', { pending: 1 })] }, NOW);
  check('routines card: routines waiting for an OK are counted, and their result is marked', ap.counts.waitingApproval === 2 && ap.latest.find((x) => x.id === 'a').waiting === true && ap.latest.find((x) => x.id === 'b').waiting === false, JSON.stringify(ap.counts));

  // ---- text is plain and short ----
  const long = 'word '.repeat(100);
  const t = RC.shape({ routines: [r('t', { title: `Hello\n\u0007${long}`, nextRun: NOW + H, last: ran(NOW, { snippet: `line one\n\nline   two ${long}`, error: long }) })] }, NOW);
  check('routines card: the snippet is one clean line of at most 140 characters', t.latest[0].snippet.length <= 140 && !/[\n\u0007]/.test(t.latest[0].snippet) && t.latest[0].snippet.startsWith('line one line two'), JSON.stringify(t.latest[0].snippet));
  check('routines card: titles and errors are cut and have no control characters', t.upcoming[0].title.length <= 80 && !/[\n\u0007]/.test(t.upcoming[0].title) && t.latest[0].error.length <= 140, '');
  const untitled = RC.shape({ routines: [r('u', { title: '   ', nextRun: NOW + H })] }, NOW);
  check('routines card: a routine without a title still gets a name', untitled.upcoming[0].title === 'Routine', '');

  // ---- offline, and the same view twice ----
  check('routines card: offline passes through', RC.shape({ offline: true, routines: [] }, NOW).offline === true, '');
  check('routines card: the same view gives byte-identical data (the page is only refreshed when it changes)', JSON.stringify(RC.shape(view, NOW)) === JSON.stringify(RC.shape(JSON.parse(JSON.stringify(view)), NOW + 5 * H)), '');
  // ---- the widget: saved like the others, read live, buttons that only open the sidebar ----
  const { createWidgets } = require('../../src/features/widgets');
  let settings = {};
  let updates = 0;
  const acts = [];
  let live = { enabled: true, routines: [] };
  const w = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); }, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), onUpdate: () => { updates++; }, routines: () => live, routineAct: (req) => { acts.push(req); return { ok: true }; } });
  check('routines card: no card on the page, nothing to refresh', w.routinesChanged() === false && updates === 0, String(updates));
  await w.save({ type: 'routines' });
  const wid = settings.homeWidgets[0].id;
  check('routines card: the widget saves as a plain card of its own type with no settings', settings.homeWidgets.length === 1 && settings.homeWidgets[0].type === 'routines', JSON.stringify(settings.homeWidgets));
  check('routines card: the page is refreshed once when the data first differs, then only when it changes', w.routinesChanged() === true && w.routinesChanged() === false, '');
  live = { enabled: true, routines: [r('abc-1', { title: 'Morning brief', nextRun: NOW + H })] };
  check('routines card: a changed routine refreshes the page again', w.routinesChanged() === true && w.routinesChanged() === false, '');
  const quiet = console.error;
  console.error = () => {};
  try {
    await new Promise((res) => setTimeout(res, 30));
    const card = w.forPage().find((x) => x.id === wid);
    check('routines card: the page reads the live view on every read', card.data.upcoming.length === 1 && card.data.upcoming[0].title === 'Morning brief' && card.title === 'Routines', JSON.stringify(card.data));
  } finally { console.error = quiet; }
  const parse = (q) => w.actionFrom(`file:///newtab.html?${q}`);
  check('routines card: the page actions parse, and an open without a plain id is refused', parse(`widget=${wid}&do=routine-new`).do === 'routine-new' && parse(`widget=${wid}&do=routine-open&id=abc-1`).routine === 'abc-1' && parse(`widget=${wid}&do=routine-open`).invalid === true && parse(`widget=${wid}&do=routine-open&id=${encodeURIComponent('../x')}`).invalid === true && parse(`widget=${wid}&do=routine-open&id=${encodeURIComponent('<b>')}`).invalid === true, '');
  const before = JSON.stringify(settings.homeWidgets);
  const a1 = await w.act(parse(`widget=${wid}&do=routine-new`));
  const a2 = await w.act(parse(`widget=${wid}&do=routine-open&id=abc-1`));
  check('routines card: the buttons ask the runner to open the editor or a result and change nothing stored', a1 === true && a2 === true && JSON.stringify(acts) === JSON.stringify([{ act: 'new' }, { act: 'open', id: 'abc-1' }]) && JSON.stringify(settings.homeWidgets) === before, JSON.stringify(acts));
  await w.save({ type: 'weather' }).catch(() => {});
  const other = settings.homeWidgets.find((x) => x.type !== 'routines');
  check('routines card: another kind of card cannot use the routine buttons', !other || (await w.act({ id: other.id, do: 'routine-new', task: null })) === false, '');

  check('routines card: the id shape accepts a uuid and refuses markup and paths', RC.ROUTINE_ID_RE.test('3f2b8c1e-9a7d-4e1b-8c55-0a1b2c3d4e5f') && !RC.ROUTINE_ID_RE.test('<b>') && !RC.ROUTINE_ID_RE.test('../x') && !RC.ROUTINE_ID_RE.test(''), '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
