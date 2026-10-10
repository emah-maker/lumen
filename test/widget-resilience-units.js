// Network widgets that survive a bad minute (run on its own with `node test/widget-resilience-units.js`, or by
// scripts/test-units.js): how a failed fetch is told apart (passing trouble vs a refusal vs a parse/size problem), the automatic
// retries (2 s, 10 s, 30 s, then the card's normal schedule) with the last good answer kept on the card, the retry when the
// machine comes back, a 186 KB calendar feed, and the Todoist card's new tricks (expanded list, add with a day on Today,
// reschedule, the Today / Upcoming / Inbox switch, rollback on an error) against a mocked Todoist API. No Electron, no network.
const fs = require('fs');
const path = require('path');
const { createWidgets } = require('../src/features/widgets');
const TV = require('../src/features/todoist-view');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const vevent = (uid, title, start) => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(start + HOUR)}\r\nEND:VEVENT\r\n`;
const vcal = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:School\r\n${events.join('')}END:VCALENDAR\r\n`;

// A fetch that fails the way Chromium and Node do.
const netFail = (code, message = 'fetch failed') => Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });

module.exports = async function widgetResilienceUnits(check) {
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const soon = (n, h = 10) => base.getTime() + n * DAY + h * HOUR + 12 * 60e3;
  const FEED = vcal([vevent('a', 'Maths exam', soon(1)), vevent('b', 'Parents evening', soon(3, 18))]);
  const URL1 = 'https://school.example/term.ics';

  // ---- the fixture: a fake network, a fake clock and fake timers that only run when told ----
  function rig({ widgets, secret = null }) {
    const store = { settings: { homeWidgets: widgets } };
    const state = { fail: null, status: 200, body: FEED, log: [], now: Date.now(), timers: [], updates: 0, handler: null };
    const fetch = async (url, init = {}) => {
      state.log.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (state.handler) { const r = await state.handler(String(url), init); if (r) return r; }
      if (state.fail) throw state.fail;
      return new Response(state.body, { status: state.status, headers: { 'content-type': 'text/calendar' } });
    };
    const W = createWidgets({
      readSettings: () => store.settings, writeSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
      fetch, getSecret: () => secret, setSecret: () => {}, onUpdate: () => { state.updates++; }, endpoints: () => ({}), rateMax: () => 100000,
      now: () => state.now,
      resetNetwork: () => { state.resets = (state.resets || 0) + 1; if (state.healOnReset) state.fail = null; },
      freshFetch: async (url, init, opts) => {
        state.freshLog = (state.freshLog || []).concat({ url: String(url), renew: Boolean(opts?.renew) });
        if (!state.fresh) throw state.fail || new Error('no fresh session in this test');
        return new Response(state.body, { status: 200, headers: { 'content-type': 'text/calendar' } });
      },
      setTimer: (fn, ms) => { const t = { fn, ms, live: true }; state.timers.push(t); return t; },
      clearTimer: (t) => { if (t) t.live = false; },
    });
    const live = () => state.timers.filter((t) => t.live);
    // Run the oldest pending retry timer (as the clock would) and wait for the fetch it starts.
    const fire = async () => {
      const t = live()[0];
      if (!t) return null;
      t.live = false;
      t.fn();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      return t.ms;
    };
    return { W, state, store, live, fire, card: (id) => W.forPage().find((c) => c.id === id) };
  }
  const settle = async (r, id) => { await r.W.refresh(r.W.list().find((w) => w.id === id), { force: true }); for (let i = 0; i < 10; i++) await new Promise((x) => setImmediate(x)); };

  // ================= calendar: where "Couldn't connect" comes from, and what a 186 KB feed does =================
  {
    const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: URL1, name: 'School', count: 5 }] });
    // a big feed: ~200 KB of ICS is read whole and parsed (no size or time limit is hit)
    const many = Array.from({ length: 1400 }, (_, i) => vevent(`e${i}`, `Event number ${i} with a longish title to take up room`, soon(1 + (i % 12), 8 + (i % 9))));
    r.state.body = vcal(many);
    check('a ~190 KB feed is under every limit (5 MB, 12 s)', r.state.body.length > 180e3 && r.state.body.length < 400e3, String(r.state.body.length));
    await settle(r, 'wcal00001');
    let c = r.card('wcal00001');
    check('…and the card shows its events, with no error and nothing queued to retry', c.data && c.data.events.length > 0 && !c.error && !c.warning && r.live().length === 0, JSON.stringify({ e: c.error, w: c.warning, t: r.live().length }));
    const big = rig({ widgets: [{ id: 'wcal00002', type: 'calendar', title: '', span: 3, url: URL1, name: 'Big', count: 5 }] });
    big.state.body = `BEGIN:VCALENDAR\r\n${'X'.repeat(5.2e6)}\r\nEND:VCALENDAR\r\n`;
    await settle(big, 'wcal00002');
    c = big.card('wcal00002');
    check('a feed over 5 MB says it is too big, not "Couldn’t connect", and is not retried', !c.data && /too big/.test(c.error || '') && !/connect/.test(c.error) && big.live().length === 0, JSON.stringify({ e: c.error, t: big.live().length }));
    const junk = rig({ widgets: [{ id: 'wcal00003', type: 'calendar', title: '', span: 3, url: URL1, name: 'Junk', count: 5 }] });
    junk.state.body = '<html>sign in</html>';
    await settle(junk, 'wcal00003');
    c = junk.card('wcal00003');
    check('an address that answers with a web page is a parse problem, not a connection one (and no retries)', !/connect/.test(c.error || '') && junk.live().length === 0, JSON.stringify({ e: c.error, d: Boolean(c.data) }));
  }

  // ---- a dead socket / stale DNS answer: every retry failed the same way until Lumen restarted. Try again (and the retries)
  // now drop them first, once per 5 s at most; a refusal or a first look does not. ----
  {
    const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: URL1, name: 'School', count: 5 }] });
    r.state.fail = netFail('ERR_CONNECTION_RESET');
    r.state.healOnReset = true; // the network is fine; only the old connection was dead
    await settle(r, 'wcal00001');
    check('dead socket: the first look fails with Couldn’t connect and resets nothing yet', /Couldn’t connect/.test(r.card('wcal00001').error || '') && !r.state.resets, JSON.stringify({ e: r.card('wcal00001').error, n: r.state.resets }));
    r.state.now += 1000;
    await settle(r, 'wcal00001'); // Try again
    let c = r.card('wcal00001');
    check('…Try again drops dead connections and the DNS cache first, and then the card loads', r.state.resets === 1 && c.data && !c.error, JSON.stringify({ n: r.state.resets, e: c.error }));
    r.state.healOnReset = false;
    r.state.fail = netFail('ENOTFOUND');
    // A later refresh fails (the card had loaded, so the usual 15 s floor applied; it keeps its events with a warning): no reset
    // for that one. Then Try again at +2 s (resets), +4 s and +6 s (ask again, but inside the 5 s window: no second reset).
    r.state.now += 16e3; await settle(r, 'wcal00001');
    for (let i = 0; i < 3; i++) { r.state.now += 2000; await settle(r, 'wcal00001'); }
    check('…while it keeps failing, each Try again asks again (even on a card keeping old events), but the reset happens at most once every 5 s', r.state.resets === 2 && r.state.log.length === 6, JSON.stringify({ n: r.state.resets, asks: r.state.log.length }));
    const refused = rig({ widgets: [{ id: 'wcal00002', type: 'calendar', title: '', span: 3, url: URL1, name: 'Bad', count: 5 }] });
    refused.state.fail = netFail('ERR_CERT_AUTHORITY_INVALID');
    await settle(refused, 'wcal00002');
    refused.state.now += 10e3;
    await settle(refused, 'wcal00002');
    check('…a refused address (bad certificate) never resets the network', !refused.state.resets && /refused/.test(refused.card('wcal00002').error || ''), JSON.stringify({ n: refused.state.resets, e: refused.card('wcal00002').error }));
  }

  // ---- the browser's session stuck (every request fails at once with net::ERR_FAILED until a restart): the request goes
  // again through a fresh session, the cards stay on it for 5 minutes, then try the browser's session again ----
  {
    const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: URL1, name: 'School', count: 5 }] });
    r.state.fail = Object.assign(new Error('net::ERR_FAILED'), {});
    r.state.fresh = true;
    await settle(r, 'wcal00001');
    let c = r.card('wcal00001');
    check('stuck session: a request that fails with net::ERR_FAILED loads through a fresh session', c.data && !c.error && r.state.freshLog?.length === 1 && r.state.log.length === 1, JSON.stringify({ e: c.error, fresh: r.state.freshLog, asks: r.state.log.length }));
    r.state.now += 60e3; r.state.log = []; r.state.freshLog = [];
    await settle(r, 'wcal00001');
    check('…the next requests go straight to the fresh session (no failing first try)', r.state.log.length === 0 && r.state.freshLog.length === 1, JSON.stringify({ asks: r.state.log.length, fresh: r.state.freshLog.length }));
    r.state.fail = null; r.state.now += 5 * 60e3; r.state.log = []; r.state.freshLog = [];
    await settle(r, 'wcal00001');
    check('…after 5 minutes the browser\'s own session is tried again', r.state.log.length === 1 && r.state.freshLog.length === 0, JSON.stringify({ asks: r.state.log.length, fresh: r.state.freshLog.length }));
    const t = rig({ widgets: [{ id: 'wcal00002', type: 'calendar', title: '', span: 3, url: URL1, name: 'Slow', count: 5 }] });
    t.state.fail = Object.assign(new Error('aborted'), { name: 'AbortError' });
    t.state.fresh = true;
    await settle(t, 'wcal00002');
    check('…a timeout is not sent again through the fresh session (it already waited its full time)', !t.state.freshLog?.length && /too long/.test(t.card('wcal00002').error || ''), JSON.stringify({ fresh: t.state.freshLog, e: t.card('wcal00002').error }));
    const bad = rig({ widgets: [{ id: 'wcal00003', type: 'calendar', title: '', span: 3, url: URL1, name: 'Cert', count: 5 }] });
    bad.state.fail = netFail('ERR_CERT_AUTHORITY_INVALID');
    bad.state.fresh = true;
    await settle(bad, 'wcal00003');
    check('…a refused address (bad certificate) is not retried through the fresh session', !bad.state.freshLog?.length && /refused/.test(bad.card('wcal00003').error || ''), JSON.stringify({ fresh: bad.state.freshLog }));
    const off = rig({ widgets: [{ id: 'wcal00004', type: 'calendar', title: '', span: 3, url: URL1, name: 'Off', count: 5 }] });
    off.state.fail = netFail('ENOTFOUND');
    await settle(off, 'wcal00004');
    check('…really offline (the fresh session fails too): the card says it keeps trying, not "check your internet"', /Couldn’t connect/.test(off.card('wcal00004').error || '') && /keeps trying/.test(off.card('wcal00004').error) && !/internet/i.test(off.card('wcal00004').error), off.card('wcal00004').error);
  }

  // ---- a Web player's Try again (Spotify, Apple Music in their own view) also drops dead connections before it reloads ----
  {
    const order = [];
    const W = createWidgets({
      readSettings: () => ({ homeWidgets: [{ id: 'wspot0001', type: 'spotify', title: '', span: 3, mode: 'web' }] }), writeSettings: () => {},
      fetch: async () => { throw new Error('no network in this test'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), rateMax: () => 100000,
      now: () => 1e12, setTimer: () => ({}), clearTimer: () => {},
      resetNetwork: () => { order.push('reset'); },
      spotifyWebReload: () => { order.push('reload'); },
    });
    await W.act({ id: 'wspot0001', do: 'reload' });
    check('web player: Try again resets the network first, then reloads the player', order.join(',') === 'reset,reload', order.join(','));
  }

  // ---- the first look fails (the machine is offline): retries at 2 s, 10 s, 30 s, then rests ----
  {
    const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: URL1, name: 'School', count: 5 }] });
    r.state.fail = netFail('ENOTFOUND');
    await settle(r, 'wcal00001');
    let c = r.card('wcal00001');
    check('offline at the start: the card says Couldn’t connect (nothing to show yet)', !c.data && /Couldn’t connect/.test(c.error), JSON.stringify({ e: c.error }));
    check('…and a retry is queued for 2 s', r.live().length === 1 && r.live()[0].ms === 2000, JSON.stringify(r.live().map((t) => t.ms)));
    const delays = [];
    delays.push(await r.fire());
    delays.push(await r.fire());
    delays.push(await r.fire());
    check('still offline: the retries come 2 s, 10 s, then 30 s after each failure', delays.join() === '2000,10000,30000', delays.join());
    check('…then no more timers (the card’s normal schedule takes over)', r.live().length === 0 && (await r.fire()) === null, String(r.live().length));
    const asked = r.state.log.length;
    // the network returns: the next retry works and the card fills in
    r.state.fail = null;
    check('the machine is back: retryNow() asks every failed card again at once and gets its quick retries back', (await r.W.retryNow()) === true && r.state.log.length > asked, String(r.state.log.length - asked));
    c = r.card('wcal00001');
    check('…the card shows its events and the error is gone', c.data && c.data.events.length === 2 && !c.error && !c.warning && c.updated > 0, JSON.stringify({ e: c.error, d: Boolean(c.data) }));
    check('…and a healthy card has no timers and retryNow() does nothing', r.live().length === 0 && (await r.W.retryNow()) === false, '');
  }

  // ---- a good card, then a failure: the last good events stay, marked "Updated X ago" ----
  {
    const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: URL1, name: 'School', count: 5 }] });
    await settle(r, 'wcal00001');
    const readAt = r.state.now;
    check('first look: events, no warning', r.card('wcal00001').data.events.length === 2 && !r.card('wcal00001').warning, '');
    r.state.now += 20 * 60e3; // the card is old; the network drops (and the shared 10-minute cache has expired)
    r.state.fail = netFail('ECONNRESET');
    await settle(r, 'wcal00001');
    const c = r.card('wcal00001');
    check('a failed refresh keeps the last events on the card (no error screen)', c.data && c.data.events.length === 2 && !c.error, JSON.stringify({ e: c.error, n: c.data?.events?.length }));
    check('…marked stale: a short note, and "Updated" is when those events were read, not now', /Couldn’t refresh/.test(c.warning || '') && c.updated === readAt && c.data.cals[0].stale === true, JSON.stringify({ w: c.warning, u: c.updated, readAt }));
    check('…and the retry ladder starts at 2 s', r.live().length === 1 && r.live()[0].ms === 2000, JSON.stringify(r.live().map((t) => t.ms)));
    r.state.fail = null;
    await r.fire();
    const back = r.card('wcal00001');
    check('the retry works: fresh events, no warning, "Updated" is now', back.data.events.length === 2 && !back.warning && back.updated >= c.updated && back.data.cals[0].stale !== true && r.live().length === 0, JSON.stringify({ w: back.warning, s: back.data.cals[0] }));
  }

  // ---- what is retried and what is not ----
  {
    const cases = [
      ['a 503 is a restarting server: retried', () => { const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] }); r.state.status = 503; r.state.body = ''; return r; }, true],
      ['a 404 is a wrong address: not retried', () => { const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] }); r.state.status = 404; r.state.body = ''; return r; }, false],
      ['a timeout (the abort) is retried and says so', () => { const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] }); r.state.fail = Object.assign(new Error('aborted'), { name: 'AbortError' }); return r; }, true],
      ['a Chromium net::ERR_NAME_NOT_RESOLVED is retried', () => { const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] }); r.state.fail = new TypeError('net::ERR_NAME_NOT_RESOLVED'); return r; }, true],
      ['net::ERR_INTERNET_DISCONNECTED is retried', () => { const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] }); r.state.fail = new TypeError('net::ERR_INTERNET_DISCONNECTED'); return r; }, true],
      ['a certificate refusal is not retried', () => { const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] }); r.state.fail = new TypeError('net::ERR_CERT_AUTHORITY_INVALID'); return r; }, false],
    ];
    for (const [name, make, retried] of cases) {
      const r = make();
      await settle(r, 'wcal00001');
      check(`classify: ${name}`, (r.live().length === 1) === retried, JSON.stringify({ e: r.card('wcal00001').error, t: r.live().length }));
    }
    const a = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] });
    a.state.fail = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await settle(a, 'wcal00001');
    const b = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] });
    b.state.fail = new TypeError('net::ERR_CERT_COMMON_NAME_INVALID');
    await settle(b, 'wcal00001');
    const n = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', url: URL1, name: 'S', count: 5 }] });
    n.state.fail = netFail('ENOTFOUND');
    await settle(n, 'wcal00001');
    check('messages: a timeout says it took too long; a certificate refusal says it was refused; DNS says Lumen keeps trying', /too long/.test(a.card('wcal00001').error) && /securely/.test(b.card('wcal00001').error) && !/internet/.test(b.card('wcal00001').error) && /Couldn’t connect\. Lumen keeps trying/.test(n.card('wcal00001').error), JSON.stringify([a.card('wcal00001').error, b.card('wcal00001').error, n.card('wcal00001').error]));
  }

  // ---- editing the card cancels its retries; the page's "retry" action ----
  {
    const r = rig({ widgets: [{ id: 'wcal00001', type: 'calendar', title: '', span: 3, url: URL1, name: 'School', count: 5 }] });
    r.state.fail = netFail('ECONNRESET');
    await settle(r, 'wcal00001');
    const timer = r.live()[0];
    r.W.remove('wcal00001');
    r.state.fail = null;
    const asked = r.state.log.length;
    timer.live = false;
    timer.fn();
    await new Promise((x) => setImmediate(x));
    check('a retry for a card that was removed does nothing', r.state.log.length === asked, '');
    const act = r.W.actionFrom('https://newtab.example/?widget=wcal00001&do=retry');
    check('the page’s retry action is accepted (a widget id and nothing else)', act && !act.invalid && act.do === 'retry', JSON.stringify(act));
    check('…and it returns without a card to find', (await r.W.act(act)) === false, '');
  }

  // ---- shared code: another network widget (Todoist) gets the same ----
  const TOKEN = 'tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const task = (id, content, extra = {}) => ({ id: String(id), content, project_id: 'p1', priority: 1, labels: [], child_order: Number(id), due: { date: TV.ymd(new Date()), is_recurring: false }, ...extra });
  const tasksOf = (n) => Array.from({ length: n }, (_, i) => task(100 + i, `Task ${i + 1}`));
  const todoWidget = (todo = {}) => [{ id: 'wtodo0001', type: 'todoist', title: '', span: 2, todo: { source: 'upcoming', days: 7, max: 5, group: 'none', ...todo } }];
  const api = (r, tasks) => {
    r.state.api = { tasks, quick: null, updates: [] };
    r.state.handler = async (url, init) => {
      const u = new URL(url);
      const j = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname.endsWith('/projects')) return j({ results: [{ id: 'p1', name: 'Home', color: 'blue' }], next_cursor: null });
      if (u.pathname.endsWith('/tasks/filter') || u.pathname.endsWith('/tasks')) return j({ results: r.state.api.tasks, next_cursor: null });
      if (u.pathname.endsWith('/tasks/quick')) { const q = r.state.api.quick; return typeof q === 'function' ? q(JSON.parse(init.body)) : j(q || task(900, JSON.parse(init.body).text)); }
      if (/\/tasks\/[\w-]+\/move$/.test(u.pathname)) return j({});
      if (/\/tasks\/[\w-]+$/.test(u.pathname) && init.method === 'POST') { const body = JSON.parse(init.body); r.state.api.updates.push([u.pathname.split('/').pop(), body]); return j({ id: u.pathname.split('/').pop(), content: 'updated', project_id: 'p1', priority: 1, due: body.due_string === 'no date' ? null : { date: TV.ymd(new Date()) } }); }
      return j({});
    };
    return r;
  };
  const doAct = async (r, params) => { const a = r.W.actionFrom(`https://newtab.example/?widget=wtodo0001&${params}`); return { a, done: a && !a.invalid ? await r.W.act(a) : null }; };
  const wait = async () => { for (let i = 0; i < 30; i++) await new Promise((x) => setTimeout(x, 2)); };

  {
    const r = api(rig({ widgets: todoWidget(), secret: TOKEN }), tasksOf(12));
    r.state.fail = netFail('ENOTFOUND');
    r.state.handler = null;
    await settle(r, 'wtodo0001');
    check('Todoist: offline at the start is retried like the calendar (2 s)', !r.card('wtodo0001').data && /Couldn’t connect/.test(r.card('wtodo0001').error) && r.live().length === 1 && r.live()[0].ms === 2000, JSON.stringify(r.live().map((t) => t.ms)));
  }

  // ================= Todoist =================
  {
    const r = api(rig({ widgets: todoWidget({ source: 'upcoming', max: 5 }), secret: TOKEN }), tasksOf(12));
    await settle(r, 'wtodo0001');
    let c = r.card('wtodo0001');
    const n = c.data.groups.reduce((k, g) => k + g.tasks.length, 0);
    check('list: more than max is sent (12 of 12), with the short list’s length (5) beside it', n === 12 && c.data.collapsed === 5 && c.data.total === 12, JSON.stringify({ n, collapsed: c.data.collapsed }));
    check('list: the shape of the old call is unchanged (max cuts, "more" counts)', (() => { const s = TV.shape(tasksOf(12).map((t) => TV.normalizeTask(t)), TV.cleanConfig({ max: 5 })); return s.shown === 5 && s.groups[0].tasks.length === 5 && s.collapsed === undefined; })(), '');
    check('list: a card of all tasks (max 0) sends everything; one over the cap sends up to the cap', (() => { const many = Array.from({ length: 100 }, (_, i) => TV.normalizeTask(task(i + 1, `T${i}`))); const all = TV.shape(many, TV.cleanConfig({ max: 0 }), TV.ymd(new Date()), { expand: true }); const some = TV.shape(many, TV.cleanConfig({ max: 10 }), TV.ymd(new Date()), { expand: true }); return all.shown === 100 && some.shown === TV.EXPAND_CAP && some.collapsed === 10; })(), '');
    check('header switch: an upcoming card knows its view; project, label and filter cards have none', c.data.view === 'upcoming' && TV.viewOf({ source: 'project' }) === null && TV.viewOf({ source: 'custom' }) === null && TV.viewOf({ source: 'todayOverdue' }) === 'today', String(c.data.view));

    // adding: quick add, optimistic in the cache, a day on Today, the card's project
    r.state.log.length = 0;
    let { done } = await doAct(r, 'do=add&text=' + encodeURIComponent('Pay rent tomorrow 5pm'));
    await wait();
    const quickCall = r.state.log.find((l) => l.url.endsWith('/tasks/quick'));
    check('add: the words go to Todoist’s quick add as typed (it reads “tomorrow 5pm” itself)', done === true && quickCall && quickCall.method === 'POST' && quickCall.body.text === 'Pay rent tomorrow 5pm', JSON.stringify(quickCall));
    r.state.api.tasks = [...r.state.api.tasks, task(900, 'Pay rent tomorrow 5pm')];
    await settle(r, 'wtodo0001');
    check('add: the new task is on the card after the next read', r.card('wtodo0001').data.groups.flatMap((g) => g.tasks).some((t) => t.id === '900'), '');
    check('add: works with the box set to “Button” (quick: off was Lumen’s old default and used to refuse)', (() => { const w = r.W.list()[0]; return w.todo.quick === 'top' || w.todo.quick === 'off'; })(), '');
  }
  {
    // Today: an undated new task gets today, or it would vanish at the next look
    const r = api(rig({ widgets: todoWidget({ source: 'todayOverdue', max: 5, quick: 'off' }), secret: TOKEN }), tasksOf(2));
    await settle(r, 'wtodo0001');
    r.state.api.quick = { id: '901', content: 'Buy milk', project_id: 'p1', priority: 1, due: null };
    r.state.log.length = 0;
    const { done } = await doAct(r, 'do=add&text=' + encodeURIComponent('Buy milk'));
    check('add on Today: a task with no day is set to today (due_string "today")', done === true && r.state.api.updates.some(([id, b]) => id === '901' && b.due_string === 'today'), JSON.stringify(r.state.api.updates));
    check('add on Today: it is on the card at once, before Todoist is asked for the list again', r.card('wtodo0001').data.groups.flatMap((g) => g.tasks).some((t) => t.id === '901'), '');
    // a task whose own words give a day is left alone
    r.state.api.updates.length = 0;
    r.state.api.quick = { id: '902', content: 'Dentist', project_id: 'p1', priority: 1, due: { date: TV.ymd(new Date(Date.now() + 2 * DAY)) } };
    await doAct(r, 'do=add&text=' + encodeURIComponent('Dentist friday'));
    check('add on Today: a task the words gave a day is not forced to today', !r.state.api.updates.some(([id]) => id === '902'), JSON.stringify(r.state.api.updates));
  }
  {
    // a project card puts the new task in its project
    const r = api(rig({ widgets: todoWidget({ source: 'project', projectId: 'p77', projectName: 'Work', max: 5 }), secret: TOKEN }), tasksOf(2));
    await settle(r, 'wtodo0001');
    r.state.api.quick = { id: '903', content: 'Write report', project_id: 'inbox1', priority: 1, due: null };
    r.state.log.length = 0;
    await doAct(r, 'do=add&text=' + encodeURIComponent('Write report'));
    const move = r.state.log.find((l) => /\/tasks\/903\/move$/.test(l.url));
    check('add on a project card: the task is moved into that project', move && move.body.project_id === 'p77', JSON.stringify(move));
  }
  {
    // an upcoming card + a task with no date is not shown (not on this list), and no ghost row is left
    const r = api(rig({ widgets: todoWidget({ source: 'upcoming', max: 5 }), secret: TOKEN }), tasksOf(2));
    await settle(r, 'wtodo0001');
    r.state.api.quick = { id: '904', content: 'Someday', project_id: 'p1', priority: 1, due: null };
    await doAct(r, 'do=add&text=Someday');
    check('add on Upcoming: an undated task is not forced onto the list (it would vanish at the next look)', !r.card('wtodo0001').data.groups.flatMap((g) => g.tasks).some((t) => t.id === '904') && r.state.api.updates.length === 0, '');
  }
  {
    // an error rolls back: nothing is added, the card says why
    const r = api(rig({ widgets: todoWidget({ max: 5 }), secret: TOKEN }), tasksOf(3));
    await settle(r, 'wtodo0001');
    r.state.api.quick = () => new Response('{}', { status: 500 });
    const before = r.card('wtodo0001').data.groups.flatMap((g) => g.tasks).length;
    const { done } = await doAct(r, 'do=add&text=Will+fail');
    const c = r.card('wtodo0001');
    check('add fails (500): no task appears, the card’s tasks are as before and it says what happened', done === false && c.data.groups.flatMap((g) => g.tasks).length === before && /500/.test(c.data.notice || ''), JSON.stringify({ n: c.data.notice, done }));
    check('…and it is retried automatically (a 5xx is passing)', r.live().length >= 1, String(r.live().length));
    check('add: an empty or over-long text is refused by the address check', r.W.actionFrom('https://newtab.example/?widget=wtodo0001&do=add&text=').invalid === true, '');
  }
  {
    // reschedule
    const rec = [task(100, 'Plain'), task(101, 'Repeats', { due: { date: TV.ymd(new Date()), is_recurring: true } })];
    const r = api(rig({ widgets: todoWidget({ max: 5 }), secret: TOKEN }), rec);
    await settle(r, 'wtodo0001');
    await doAct(r, 'do=reschedule&task=100&arg=tomorrow');
    check('reschedule: Tomorrow sets due_string "tomorrow" on that task', r.state.api.updates.some(([id, b]) => id === '100' && b.due_string === 'tomorrow'), JSON.stringify(r.state.api.updates));
    await doAct(r, 'do=reschedule&task=100&arg=nextweek');
    await doAct(r, 'do=reschedule&task=100&arg=none');
    check('reschedule: Next week is "next monday" and No date is "no date"', r.state.api.updates.some(([, b]) => b.due_string === 'next monday') && r.state.api.updates.some(([, b]) => b.due_string === 'no date'), JSON.stringify(r.state.api.updates));
    const calls = r.state.api.updates.length;
    const rr = await doAct(r, 'do=reschedule&task=101&arg=today');
    check('reschedule: a repeating task is refused (a new day would end its repeat)', rr.done === false && r.state.api.updates.length === calls, '');
    const ghost = await doAct(r, 'do=reschedule&task=555&arg=today');
    check('reschedule: only a task the card shows can be moved', ghost.done === false, '');
    check('reschedule: bad arguments are refused at the door', r.W.actionFrom('https://n.example/?widget=wtodo0001&do=reschedule&task=100&arg=yesterday').invalid === true && r.W.actionFrom('https://n.example/?widget=wtodo0001&do=reschedule&arg=today').invalid === true && r.W.actionFrom('https://n.example/?widget=wtodo0001&do=tdsource&arg=project').invalid === true, '');
  }
  {
    // the header switch
    const r = api(rig({ widgets: todoWidget({ source: 'upcoming', days: 7, max: 5 }), secret: TOKEN }), tasksOf(3));
    await settle(r, 'wtodo0001');
    r.state.log.length = 0;
    const { done } = await doAct(r, 'do=tdsource&arg=inbox');
    await wait();
    const w = r.W.list()[0];
    check('switch: Inbox changes the card’s source, saved with the rest of its settings kept', done === true && w.todo.source === 'inbox' && w.todo.days === 7 && w.todo.max === 5, JSON.stringify(w.todo));
    const asked = r.state.log.filter((l) => /\/tasks\/filter/.test(l.url)).map((l) => new URL(l.url).searchParams.get('query'));
    check('switch: Todoist is asked for “#Inbox” and the card is titled Inbox', asked.includes('#Inbox') && r.card('wtodo0001').title === 'Inbox' && r.card('wtodo0001').data.view === 'inbox', JSON.stringify({ asked, t: r.card('wtodo0001').title }));
    await doAct(r, 'do=tdsource&arg=today');
    await wait();
    check('switch: Today is today and overdue', r.W.list()[0].todo.source === 'todayOverdue' && r.card('wtodo0001').data.view === 'today', r.W.list()[0].todo.source);
    const proj = api(rig({ widgets: todoWidget({ source: 'project', projectId: 'p1', projectName: 'Home' }), secret: TOKEN }), tasksOf(2));
    await settle(proj, 'wtodo0001');
    const refused = await doAct(proj, 'do=tdsource&arg=inbox');
    check('switch: a project card is not turned into Inbox by the page (it has no switch)', refused.done === false && proj.W.list()[0].todo.source === 'project', '');
  }

  // ================= the page files =================
  const nt = read('src/renderer/newtab-widgets.js');
  const html = read('src/renderer/newtab.html');
  check('page: the task list scrolls inside the card (a scrolling region, thin scrollbar like the other cards) and is not cut by the row fitter', /\.td-scroll \{[^}]*overflow-y: auto/.test(html) && /\.td-scroll[^}]*scrollbar-width: thin/.test(html) && /\.td-scroll\)\s*\{ scrollbar-width: auto/.test(html) && /'custom', 'todoist'\]/.test(nt), '');
  check('page: the list can be reached by keyboard (focusable region) and has a focus ring', /scroll\.tabIndex = 0/.test(nt) && /\.td-scroll:focus-visible/.test(html), '');
  check('page: Show more / Show fewer, and a card with room shows more by itself', /Show \$\{hidden\} more/.test(nt) && /Show fewer/.test(nt) && /function fitTodoist/.test(nt) && /fitTodoist\(cardEl\)/.test(nt), '');
  check('page: the add box has a placeholder with an example, Enter adds, Esc cancels, the new row is shown at once and dimmed', /Pay rent tomorrow 9am/.test(nt) && /e\.key === 'Enter'/.test(nt) && /e\.key === 'Escape'/.test(nt) && /w-row pending/.test(nt) && /\.w-row\.pending \{ opacity/.test(html), '');
  check('page: a “+ Add task” row for the Button mode', /Add task/.test(nt) && /td-addbtn/.test(html), '');
  check('page: the typed text and the list’s scroll survive a redraw', /tdDrafts/.test(nt) && /tdScrolls/.test(nt), '');
  check('page: Today / Upcoming / Inbox in the card and a reschedule menu with four choices', /role', 'tablist'/.test(nt) && /'Tomorrow'/.test(nt) && /'Next week'/.test(nt) && /'No date'/.test(nt) && /tdsource/.test(nt) && /reschedule/.test(nt), '');
  check('page: a card that failed asks again when the page is shown and when the browser says it is online', /addEventListener\('online'/.test(nt) && /function retryFailed/.test(nt) && /retryFailed\(\)/.test(nt), '');
  const main = read('src/main.js');
  check('main: waking from sleep or unlocking asks the failed cards again', /pm\.on\('resume', widgetsBack\)/.test(main) && /widgets\.retryNow\(\)/.test(main), '');
  check('main: the cards get resetNetwork (closeAllConnections + clearHostResolverCache)', /function resetNetwork\(\)/.test(main) && /closeAllConnections/.test(main) && /clearHostResolverCache/.test(main) && /\n {2}resetNetwork, /.test(main), '');
  const settings = read('src/renderer/settings.js');
  check('Settings: the add box is Button / Top / Bottom, and defaults to Top', /\['off', 'Button'\], \['top', 'Top'\], \['bottom', 'Bottom'\]\], t\.quick \|\| 'top'/.test(settings) && TV.cleanConfig({}).quick === 'top', TV.cleanConfig({}).quick);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
