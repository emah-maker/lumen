// A press of a card's Refresh (or Try again) always does a real refresh (run on its own with `node test/widget-refresh-press-units.js`, or by
// scripts/test-units.js). Against a mocked Todoist API: a press right after a load is not dropped by the 15 s floor, a press during a run joins
// it (one request, the card says it is refreshing until it ends), a press after an error or with an old answer showing asks again, a rate-limit
// pause is shown instead of hiding the press, and a fetch or network reset that never answers still ends. The page's own timers (arg=auto)
// keep the minimum interval. No Electron, no network.
const fs = require('fs');
const path = require('path');
const { createWidgets } = require('../src/features/widgets');
const TV = require('../src/features/todoist-view');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const TOKEN = 'tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const task = (id, content) => ({ id: String(id), content, project_id: 'p1', priority: 1, labels: [], child_order: Number(id), due: { date: TV.ymd(new Date()), is_recurring: false } });
const netFail = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

module.exports = async function widgetRefreshPressUnits(check) {
  function rig() {
    const store = { settings: { homeWidgets: [{ id: 'wtodo0001', type: 'todoist', title: '', span: 2, todo: { source: 'upcoming', days: 7, max: 5, group: 'none' } }] } };
    const state = { tasks: [task(1, 'First')], fail: null, status: 200, hang: false, gate: null, asks: 0, resets: 0, hangReset: false, timers: [], updates: 0, now: Date.now() };
    const j = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    const fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/projects')) return j({ results: [{ id: 'p1', name: 'Home', color: 'blue' }], next_cursor: null });
      state.asks++;
      const snap = state.tasks; // what the server holds when the request arrives
      if (state.hang) return new Promise(() => {});
      if (state.gate) await state.gate;
      if (state.fail) throw state.fail;
      if (state.status !== 200) return j({ error: 'x' }, state.status);
      return j({ results: snap, next_cursor: null });
    };
    const W = createWidgets({
      readSettings: () => store.settings, writeSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
      fetch, getSecret: () => TOKEN, setSecret: () => {}, onUpdate: () => { state.updates++; }, endpoints: () => ({}), rateMax: () => 100000,
      now: () => state.now,
      resetNetwork: () => { state.resets++; if (state.healOnReset) state.fail = null; return state.hangReset ? new Promise(() => {}) : undefined; },
      setTimer: (fn, ms) => { const t = { fn, ms, live: true }; state.timers.push(t); return t; },
      clearTimer: (t) => { if (t) t.live = false; },
    });
    const live = () => state.timers.filter((t) => t.live);
    const widget = () => W.list()[0];
    const card = () => W.forPage().find((c) => c.id === 'wtodo0001');
    const names = () => (card().data?.groups || []).flatMap((g) => g.tasks).map((t) => t.title).join(',');
    return { W, state, live, widget, card, names };
  }
  const press = (r) => r.W.refresh(r.widget(), { force: true, user: true });
  const auto = (r) => r.W.refresh(r.widget(), { force: true });

  // ---- a press right after a load is a real fetch; the page's own timer is held to the minimum interval ----
  {
    const r = rig();
    await r.W.refresh(r.widget());
    check('after a load: the card shows its list', r.names() === 'First', r.names());
    const before = r.state.asks;
    r.state.tasks = [task(1, 'First'), task(2, 'Second')];
    check('the page’s own timer (arg=auto) right after a load is still held back by the 15 s floor', (await auto(r)) === false && r.state.asks === before, String(r.state.asks - before));
    const done = await press(r);
    check('a press right after a load is a real fetch (not held back, not served from the minute’s cache)', done === true && r.state.asks === before + 1 && r.names() === 'First,Second', JSON.stringify({ asks: r.state.asks - before, names: r.names() }));
    check('…and the card is not left refreshing', !r.card().refreshing && !r.live().length, JSON.stringify({ rf: r.card().refreshing, t: r.live().length }));
  }

  // ---- a press while a refresh is running joins it ----
  {
    const r = rig();
    let open;
    r.state.gate = new Promise((res) => { open = res; });
    const first = r.W.refresh(r.widget()); // the page's own load
    await tick();
    check('a load in progress is not shown as a press', !r.card().refreshing, JSON.stringify(r.card().refreshing));
    const updatesBefore = r.state.updates;
    const second = press(r);
    const third = press(r);
    check('a press during a run joins it (the same run, not a second request)', second === first && third === first && r.state.asks === 1, String(r.state.asks));
    check('…the card says it is refreshing, and the page is told at once', r.card().refreshing === true && r.state.updates > updatesBefore, JSON.stringify({ rf: r.card().refreshing, u: r.state.updates - updatesBefore }));
    open();
    await second;
    check('when the run ends the card is no longer refreshing and shows the list', !r.card().refreshing && r.names() === 'First', JSON.stringify({ rf: r.card().refreshing, n: r.names() }));
  }

  // ---- after an error ----
  {
    const r = rig();
    r.state.fail = netFail('ENOTFOUND');
    await r.W.refresh(r.widget());
    await tick();
    check('offline at the start: the card has an error and no list', !r.card().data && /Couldn’t connect/.test(r.card().error), JSON.stringify(r.card().error));
    r.state.fail = null;
    r.state.healOnReset = true;
    const asks = r.state.asks;
    await press(r);
    check('Try again right after the error asks again, drops dead connections first, and the list loads', r.state.asks === asks + 1 && r.state.resets === 1 && r.names() === 'First' && !r.card().error, JSON.stringify({ asks: r.state.asks - asks, resets: r.state.resets, e: r.card().error }));

    // a refusal (not a passing failure) is asked again too, right away
    const q = rig();
    q.state.status = 403;
    await q.W.refresh(q.widget());
    check('a refused token shows an error', /./.test(q.card().error || ''), JSON.stringify(q.card()));
    q.state.status = 200;
    await press(q);
    check('Try again after a refusal fetches again at once', q.names() === 'First' && !q.card().error, JSON.stringify({ n: q.names(), e: q.card().error }));
  }

  // ---- with the last good list showing ----
  {
    const r = rig();
    await r.W.refresh(r.widget());
    r.state.fail = netFail('ECONNRESET');
    await auto(r).catch(() => {});
    r.state.now += 20e3;
    await auto(r);
    const c = r.card();
    check('a failed refresh keeps the last good list under a warning', r.names() === 'First' && /./.test(c.warning || ''), JSON.stringify({ n: r.names(), w: c.warning }));
    r.state.fail = null;
    r.state.tasks = [task(1, 'First'), task(3, 'Third')];
    await press(r);
    check('a press with the old list showing fetches (even inside the floor) and replaces it, the warning gone', r.names() === 'First,Third' && !r.card().warning, JSON.stringify({ n: r.names(), w: r.card().warning }));
  }

  // ---- a rate-limit pause does not swallow the press ----
  {
    const r = rig();
    await r.W.refresh(r.widget());
    r.state.status = 429;
    r.state.now += 20e3;
    await auto(r);
    r.state.status = 200;
    check('after a 429 the page’s own timer waits quietly', (await auto(r)) === false, '');
    const ans = await press(r);
    check('…a press is answered (a visible message, not nothing) and is not left spinning', ans === true && !r.card().refreshing && (r.card().warning || r.card().error), JSON.stringify({ ans, w: r.card().warning, e: r.card().error }));
  }

  // ---- an API call that never answers still ends ----
  {
    const r = rig();
    await r.W.refresh(r.widget());
    r.state.hang = true;
    const run = press(r);
    await tick();
    check('a press whose request never answers is refreshing, with a watchdog queued', r.card().refreshing === true && r.live().some((t) => t.ms >= 30e3), JSON.stringify(r.live().map((t) => t.ms)));
    r.live().find((t) => t.ms >= 30e3).fn();
    await run;
    const c = r.card();
    check('…the watchdog ends it: no longer refreshing, the old list kept, a message under it (Try again works)', !c.refreshing && r.names() === 'First' && /in time/.test(c.warning || ''), JSON.stringify({ rf: c.refreshing, w: c.warning }));
    r.state.hang = false;
    await press(r);
    check('…and the next press loads normally', r.names() === 'First' && !r.card().warning && !r.card().refreshing, JSON.stringify(r.card().warning));
  }
  // a network reset that never answers does not hold the press
  {
    const r = rig();
    r.state.fail = netFail('ECONNRESET');
    await r.W.refresh(r.widget());
    r.state.fail = null;
    r.state.hangReset = true;
    r.state.now += 10e3;
    const run = press(r);
    await tick();
    const cap = r.live().find((t) => t.ms === 4e3);
    check('a reset that never answers is given up on after 4 s', Boolean(cap), JSON.stringify(r.live().map((t) => t.ms)));
    cap?.fn();
    await run;
    check('…and the press then fetches and shows the list', r.names() === 'First' && !r.card().refreshing, JSON.stringify({ n: r.names(), e: r.card().error }));
  }

  // ---- the page's action: a press from a button is a press, the page's own timers say arg=auto ----
  {
    const r = rig();
    const a = r.W.actionFrom('https://newtab.example/?widget=wtodo0001&do=refresh');
    const b = r.W.actionFrom('https://newtab.example/?widget=wtodo0001&do=refresh&arg=auto');
    const c = r.W.actionFrom('https://newtab.example/?widget=wtodo0001&do=refresh&arg=whatever');
    check('do=refresh is a press; arg=auto is the page’s own; anything else is a press', a.arg === null && b.arg === 'auto' && c.arg === null, JSON.stringify([a.arg, b.arg, c.arg]));
    await r.W.refresh(r.widget());
    const asks = r.state.asks;
    await r.W.act(b);
    const afterAuto = r.state.asks;
    await r.W.act(a);
    check('act: an automatic refresh inside the floor is skipped, a press is not', afterAuto === asks && r.state.asks === asks + 1, JSON.stringify([asks, afterAuto, r.state.asks]));
  }

  // ---- after a write (an added task) the list is read again after the write, never from a run that began before it ----
  {
    const r = rig();
    let open;
    r.state.gate = new Promise((res) => { open = res; });
    const early = r.W.refresh(r.widget()); // began before the write: it carries the old list
    await tick();
    r.state.tasks = [task(1, 'First'), task(2, 'Added')]; // the write
    const later = r.W.refresh(r.widget(), { after: true });
    check('a read after a write does not join the run that began before it', later !== early && r.state.asks === 1, String(r.state.asks));
    r.state.gate = null;
    open();
    await later;
    check('...it asks again once that run is over, and the card has the added task', r.state.asks === 2 && r.names() === 'First,Added', JSON.stringify({ a: r.state.asks, n: r.names() }));
  }

  // ---- the other widgets share the path: a card that fetches by another connector gets the same press ----
  {
    const store = { settings: { homeWidgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: 'https://school.example/t.ics', name: 'School', count: 5 }] } };
    let asks = 0;
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    const W = createWidgets({ readSettings: () => store.settings, writeSettings: () => {}, fetch: async () => { asks++; return new Response(ics, { status: 200 }); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), rateMax: () => 100000, setTimer: () => ({}), clearTimer: () => {} });
    await W.refresh(W.list()[0]);
    const n = asks;
    await W.act(W.actionFrom('https://newtab.example/?widget=wcal00001&do=refresh'));
    check('a calendar’s Refresh press right after a load also fetches again', asks === n + 1, String(asks - n));
  }

  // ---- the page: one shared button for every card, spinning and off while it runs, in step with main ----
  {
    const nt = read('src/renderer/newtab-widgets.js');
    const html = read('src/renderer/newtab.html');
    const key = read('src/features/widget-card-key.js');
    check('page: every card’s Refresh is the one button that spins and goes off while a run is on', /function pressRefresh/.test(nt) && /function setRefreshButton/.test(nt) && /\.w-icon-btn\.spinning svg \{ animation: w-spin/.test(html) && /prefers-reduced-motion: reduce\) \{ \.w-icon-btn\.spinning/.test(html), '');
    check('page: Try again buttons go to “Trying…” and come back when main says the run ended', /\.w-retry/.test(nt) && /function setRefreshing/.test(nt) && /setRefreshing\(card, w\)/.test(nt), '');
    check('page: what main says (refreshing) is applied without drawing the card again', /'refreshing'\]/.test(key), '');
    check('page: its own timers (stale card, ended timer, music) ask with arg=auto', (nt.match(/arg: 'auto'/g) || []).length >= 2 && /arg: 'auto'/.test(read('src/renderer/newtab-music.js')), '');
  }
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` -- ${detail}` : ''}`); if (!ok) failed++; })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
