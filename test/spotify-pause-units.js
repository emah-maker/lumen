// Pressing Pause (or Play) on the Spotify card: the card shows the pressed state at once and KEEPS it until the source says the same, however late the source is.
// Spotify's GET /me/player keeps answering is_playing: true for a second or two after a pause went through, and a poll that started before the press brings the old state; the
// old code showed Pause, then Play, then Pause again. Here the fake API lags 1.5 s, and the card's state is sampled every 50 ms. A press the source never confirms (3 s) goes
// back to what the source says, with a short note. Runs on its own (npm run test:units picks up test/*-units.js). Takes about twenty seconds.
'use strict';
const { createWidgets } = require('../src/features/widgets');

const CLIENT = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });

// world: { playing (what Spotify really does), lagMs (how long GET /me/player keeps the old answer after a change), changedAt, oldPlaying, ignore (a press that never takes effect), putStatus }
function make(world) {
  const hits = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host === 'accounts.spotify.com') return reply(200, { access_token: 'T', token_type: 'Bearer', expires_in: 3600 });
    const p = u.pathname.replace(/^\/v1/, '');
    const method = opts.method || 'GET';
    hits.push(`${method} ${p}`);
    if (p === '/me/player/pause' || p === '/me/player/play') {
      if (world.putStatus) return reply(world.putStatus, { error: { status: world.putStatus, message: 'boom' } });
      if (!world.ignore) { world.oldPlaying = world.playing; world.playing = p.endsWith('/play'); world.changedAt = Date.now(); }
      return reply(204);
    }
    if (p === '/me/player') {
      const shows = world.changedAt && Date.now() - world.changedAt < world.lagMs ? world.oldPlaying : world.playing;
      return reply(200, { is_playing: shows, progress_ms: 30000, currently_playing_type: 'track', device: { name: 'Kitchen', id: 'dev1' }, item: { type: 'track', id: 'T1', name: 'Night Shift', duration_ms: 200000, artists: [{ name: 'Ann' }], album: { name: 'Quiet Hours', images: [] }, external_urls: {} } });
    }
    return reply(404);
  };
  const id = 'wpause0001';
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 4, h: 3 }] }), writeSettings: () => {},
    fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 1e6, searchRateMax: () => 1e6,
  });
  const shown = () => { const d = w.forPage().find((c) => c.id === id).data || {}; return { state: d.state, notice: d.notice || '' }; };
  const look = async () => { const e = w.cache.get(id); if (e) e.at = 0; await w.refresh(w.list()[0], { force: true }); };
  // press, then sample the card every 50 ms for `ms`
  const press = async (action, ms) => {
    const seen = [];
    const run = w.act({ id, do: action });
    const end = Date.now() + ms;
    while (Date.now() < end) { seen.push(shown().state); await sleep(50); }
    await run;
    return seen;
  };
  return { w, hits, look, shown, press, id };
}

// Play as Lumen: the hidden player's page is the source (features/spotify-engine.js); its state event can carry the state read just before the click.
function makeEngine(world) {
  const engine = {
    read: async () => {
      const shows = world.changedAt && Date.now() - world.changedAt < world.lagMs ? world.oldPlaying : world.playing;
      return { mode: 'status', state: shows ? 'playing' : 'paused', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art: '', signedIn: true, can: {} };
    },
    control: async (button) => { if (!world.ignore) { world.oldPlaying = world.playing; world.playing = button === 'play'; world.changedAt = Date.now(); } return true; },
    warm() {}, command: () => true,
  };
  const id = 'wpause0002';
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode: 'status', clientId: '', art: false, x: 0, y: 0, w: 4, h: 3 }] }), writeSettings: () => {},
    fetch: async () => reply(404), getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), spotifyEngine: engine,
  });
  const shown = () => { const d = w.forPage().find((c) => c.id === id).data || {}; return { state: d.state, notice: d.notice || '' }; };
  return { w, id, shown, look: async () => { const e = w.cache.get(id); if (e) e.at = 0; await w.refresh(w.list()[0], { force: true }); } };
}

module.exports = async function spotifyPauseUnits(check) {
  const changes = (seen) => { let n = 0; for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) n++; return n; };
  {
    const world = { playing: true, lagMs: 1500 };
    const t = make(world);
    await t.look();
    check('pause: the card starts as playing', t.shown().state === 'playing', t.shown().state);
    const seen = await t.press('pause', 3600);
    const first = seen.findIndex((s) => s === 'paused');
    check('pause, an API that lags 1.5 s: the card shows paused at once and never goes back to playing (sampled every 50 ms)', first >= 0 && first <= 3 && seen.slice(first).every((s) => s === 'paused'), `${JSON.stringify([...new Set(seen)])} first=${first}`);
    check('pause: the icon changed once (no flicker)', changes(seen) <= 1, String(changes(seen)));
    await sleep(300);
    const e = t.w.cache.get(t.id);
    check('pause: the source confirmed it (the hold ended, the card says paused, no error note)', !e.intent && t.shown().state === 'paused' && !t.shown().notice, JSON.stringify([e.intent, t.shown()]));
    check('pause: it asked Spotify again while waiting (the poll is repeated, not given up on)', t.hits.filter((h) => h === 'GET /me/player').length >= 3, t.hits.join());
    // and Play, the same way
    const seen2 = await t.press('play', 3600);
    const first2 = seen2.findIndex((s) => s === 'playing');
    check('play, an API that lags 1.5 s: the card shows playing at once and never goes back to paused', first2 >= 0 && first2 <= 3 && seen2.slice(first2).every((s) => s === 'playing'), JSON.stringify([...new Set(seen2)]));
    await sleep(300);
    check('play: confirmed', !t.w.cache.get(t.id).intent && t.shown().state === 'playing', JSON.stringify(t.shown()));
  }
  {
    // an answer read before the press (a poll in flight) must not undo it
    const world = { playing: true, lagMs: 0 };
    const t = make(world);
    await t.look();
    const slow = t.w.refresh(t.w.list()[0], { force: true, user: true }); // (a poll started before the press)
    const seen = await t.press('pause', 1200);
    await slow;
    check('pause with a poll in flight: the card stays paused', seen.slice(2).every((s) => s === 'paused') && t.shown().state === 'paused', JSON.stringify([...new Set(seen)]));
  }
  {
    // a press that never takes effect: after 3 s the card goes back to what Spotify says, with a note
    const world = { playing: true, lagMs: 0, ignore: true };
    const t = make(world);
    await t.look();
    const seen = await t.press('pause', 4200);
    const last = seen[seen.length - 1];
    check('a pause Spotify never carries out: it shows paused for about 3 s, then goes back to playing', seen[2] === 'paused' && last === 'playing', JSON.stringify([...new Set(seen)]));
    check('...and says so ("It didn’t pause. Try again.")', /didn.t pause/.test(t.shown().notice), JSON.stringify(t.shown()));
    check('...the hold is over (no further polling loop)', !t.w.cache.get(t.id).intent, '');
  }
  {
    const world = { playing: true, lagMs: 1500 };
    const t = makeEngine(world);
    await t.look();
    const seen = [];
    const run = t.w.act({ id: t.id, do: 'pause' });
    for (const end = Date.now() + 3000; Date.now() < end;) { seen.push(t.shown().state); if (seen.length % 10 === 0) { const e = t.w.cache.get(t.id); e.at = 0; t.w.refresh(t.w.list()[0], { force: true }).catch(() => {}); } await sleep(50); } // (the page's state events keep coming)
    await run;
    const first = seen.findIndex((s) => s === 'paused');
    check('Play as Lumen, pause: the card shows paused at once and stays paused while the late state events of the page still say playing', first >= 0 && first <= 3 && seen.slice(first).every((s) => s === 'paused'), JSON.stringify([...new Set(seen)]));
    await sleep(400);
    check('Play as Lumen: ...and the page itself confirms it', !t.w.cache.get(t.id).intent && t.shown().state === 'paused' && !t.shown().notice, JSON.stringify(t.shown()));
  }
  {
    // the request itself fails: nothing is held, the message is shown
    const world = { playing: true, lagMs: 0, putStatus: 500 };
    const t = make(world);
    await t.look();
    await t.w.act({ id: t.id, do: 'pause' });
    await sleep(100);
    check('a pause request that fails (500): the card stays playing and says so', t.shown().state === 'playing' && t.shown().notice.length > 0 && !t.w.cache.get(t.id).intent, JSON.stringify(t.shown()));
  }
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
