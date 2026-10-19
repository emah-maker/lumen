// The music card's search stays steady while you type, without Electron or the network:
//   - the pause before a search is asked (250 ms), a burst of keys is one search, a cancel drops it;
//   - what is on screen between two keys: the rows of a shorter or longer query it goes with, or the rows that were there, dimmed (never a blank list
//     and a skeleton that makes everything jump); a list that only gained pictures is patched, not rebuilt; the highlighted row keeps its place;
//   - an older answer never replaces a newer one (the Web API search), and a rate limit (429) is waited out quietly instead of shown as a failure;
//   - the card's page code does all of it (the source says so: there is no DOM here).
// Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const path = require('path');
const MS = require('../src/features/music-search-core');
const SAC = require('../src/features/spotify-api-card');

const row = (kind, id, thumb = '') => ({ kind, id, title: id, sub: '', ms: 0, thumb });
const songs = (...ids) => ids.map((i) => row('song', i));
const searchBody = (...ids) => JSON.stringify({ tracks: { items: ids.map((id) => ({ id, type: 'track', name: id, duration_ms: 1000, artists: [{ name: 'A' }], album: { images: [] } })) } });

module.exports = async function searchStabilityUnits(check) {
  // ---- the pause ----
  let clock = 0;
  const timers = [];
  const st = (f, ms) => { const t = { f, at: clock + ms, dead: false }; timers.push(t); return t; };
  const ct = (t) => { t.dead = true; };
  const advance = (ms) => { const end = clock + ms; for (;;) { const due = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; clock = due.at; due.dead = true; due.f(); } clock = end; };
  const sent = [];
  const cache = MS.createCache({ now: () => clock });
  const sched = MS.createScheduler({ send: (t) => sent.push(t), shown: () => {}, cache, scope: 'c', setTimeout: st, clearTimeout: ct });
  check('typing: the pause is 250 ms', MS.DEBOUNCE_MS === 250, String(MS.DEBOUNCE_MS));
  for (const t of ['sh', 'sha', 'shak', 'shake']) { sched.type(t); advance(80); }
  check('typing: a burst of keys is nothing asked until the pause, then one search for the whole text', sent.length === 0 && (advance(200), sent.join() === 'shake'), JSON.stringify(sent));
  sched.type('shaken'); sched.cancel(); advance(1000);
  check('typing: a cancelled (closed box) search is never asked', sent.join() === 'shake', JSON.stringify(sent));
  sched.type('shake it'); advance(100); sched.type('sh'); advance(1000);
  check('typing: a term typed over by a newer one (even a shorter) is dropped: only the newest is asked', sent.join() === 'shake,sh', JSON.stringify(sent));
  sched.type('zz'); advance(300); sent.length = 0; sched.type('zz'); advance(300);
  check('typing: the same term again is not asked twice in a row', sent.length === 0, JSON.stringify(sent));

  // ---- what is on screen between two keys ----
  const c2 = MS.createCache({ now: () => clock });
  c2.put('c', 'ab', songs('a1', 'a2'));
  c2.put('c', 'abcd', songs('d1'));
  check('cache: a shorter query already answered is found for a longer one typed (the longest one wins), never itself', c2.before('c', 'abc').term === 'ab' && c2.before('c', 'ab') === null && c2.before('c', 'a') === null && c2.before('c', 'abcde').term === 'abcd', '');
  check('cache: a longer query already answered is found for what is typed so far (as before)', c2.prefix('c', 'abc').term === 'abcd', '');
  check('rows: an answer is shown as it is', JSON.stringify(MS.pick({ answered: true, rows: songs('x') })) === JSON.stringify({ rows: songs('x'), provisional: false, skeleton: false }), '');
  check('rows: before the answer, this term’s cached rows are shown as they are', MS.pick({ answered: false, hit: { rows: songs('h') }, near: { rows: songs('n') } }).provisional === false && MS.pick({ answered: false, hit: { rows: songs('h') } }).rows[0].id === 'h', '');
  check('rows: ...else a longer or shorter query’s rows, dimmed, else the rows that were on screen, dimmed', MS.pick({ answered: false, near: { rows: songs('n') }, before: { rows: songs('b') } }).rows[0].id === 'n' && MS.pick({ answered: false, before: { rows: songs('b') }, last: songs('l') }).rows[0].id === 'b' && (() => { const x = MS.pick({ answered: false, last: songs('l') }); return x.rows[0].id === 'l' && x.provisional === true && x.skeleton === false; })(), '');
  check('rows: the outline (skeleton) is only for a list that never had rows: no blank list between two keys', MS.pick({ answered: false }).skeleton === true && MS.pick({ answered: false, last: [] }).skeleton === true && MS.pick({ answered: true, rows: [] }).skeleton === false, '');
  const a = [row('song', 'x', ''), row('album', 'y', '')];
  const b = [row('song', 'x', 'data:image/png;base64,AA'), row('album', 'y', 'data:image/png;base64,BB')];
  check('rows: a list that only gained pictures has the same shape (it is patched, not drawn again); another row is another shape', MS.shapeKey(a) === MS.shapeKey(b) && MS.shapeKey(a) !== MS.shapeKey([a[1], a[0]]) && MS.shapeKey(a) !== MS.shapeKey([a[0]]), '');
  const keys = ['song:a', 'song:b', 'song:c'];
  check('highlight: the same row stays highlighted when the list is drawn again (even if it moved); else the same place; none stays none', MS.keepActive(keys, 'song:c', 0) === 2 && MS.keepActive(keys, 'song:gone', 1) === 1 && MS.keepActive(keys, 'song:gone', 9) === 2 && MS.keepActive(keys, '', -1) === -1 && MS.keepActive([], 'song:a', 0) === -1, '');

  // ---- the page's code (no DOM here: what the source says) ----
  const music = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab-music.js'), 'utf8');
  check('page: the list is drawn from the shape of its rows (pictures are patched in place, not a rebuild)', /MS\.shapeKey\(results\)/.test(music) && /function patchThumbs/.test(music) && /if \(d0 === state\) \{[^}]*patchThumbs/.test(music), '');
  check('page: a list drawn again keeps its scroll position and the highlighted row', /const top = list\.scrollTop;/.test(music) && /list\.scrollTop = top;/.test(music) && /MS\.keepActive\(/.test(music), '');
  check('page: between two keys the rows that were there stay (dimmed) and the outline is only for a list with no rows yet', /MS\.pick\(\{ answered: false, hit,/.test(music) && /before: hit \? null : cache\.before\(id, term\)/.test(music) && /last: hit \? null : ui\.lastRows/.test(music), '');
  check('page: a typed-over answer cannot replace a newer one (the rows are for exactly the typed term)', /const answered = d\.query === term && d\.searching !== true;/.test(music), '');
  check('page: a rate limit reads as a calm line', /d\.searchWhy === 'busy'/.test(music), '');
  check('page: the card’s refresh never touches the box: the typed text is only set when it differs', /if \(p\.input\.value !== ui\.term\) p\.input\.value = ui\.term;/.test(music), '');

  // ---- the Web API search: older answers, rate limits ----
  const ui = {};
  const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
  const g1 = gate();
  const g2 = gate();
  const calls = [];
  const slow = async (m, p) => { calls.push(p); const term = decodeURIComponent(/q=([^&]*)/.exec(p)[1]); await (term === 'old' ? g1.p : g2.p); return { ok: true, status: 200, body: searchBody(term) }; };
  const first = SAC.runSearch(ui, 'old', { ui }, slow);
  const second = SAC.runSearch(ui, 'new', { ui }, slow);
  g2.go(); // the newer answer comes first
  const r2 = await second;
  g1.go(); // ...and the older one after it
  const r1 = await first;
  check('search race: an older answer arriving after a newer one is dropped and never replaces it', r1.stale === true && r2.ok === true && ui.search.term === 'new' && ui.search.items[0].id === 'new', JSON.stringify(ui.search));
  const d = SAC.directResults(ui);
  check('search race: the card is handed the newest term’s rows', d.query === 'new' && d.results[0].id === 'new' && d.searchOk === true, JSON.stringify(d));

  // a 429: waited out, then the answer comes: no failure was ever shown
  const ui2 = {};
  let n = 0;
  const waits = [];
  const limited = async () => (++n === 1 ? { ok: false, status: 429, body: '' } : { ok: true, status: 200, body: searchBody('ok') });
  const got = await SAC.runSearch(ui2, 'abc', { ui: ui2, sleep: async (ms) => { waits.push(ms); } }, limited);
  check('rate limit: a 429 is waited out quietly and asked again once: the answer shows, with no failure in between', got.ok === true && n === 2 && waits.length === 1 && ui2.search.ok === true && ui2.search.items[0].id === 'ok', JSON.stringify([got, n, waits]));
  const ui3 = {};
  const paused = async () => { throw Object.assign(new Error('The service asked Lumen to slow down. It will try again shortly.'), { waitMs: 5000 }); };
  let slept = 0;
  const got3 = await SAC.runSearch(ui3, 'abc', { ui: ui3, sleep: async () => { slept++; } }, paused);
  check('rate limit: Lumen’s own pause after a 429 is waited out at most twice, then it is "busy" (a calm line), not a failure of the page', got3.ok === false && got3.busy === true && slept === 2 && ui3.search.why === 'busy' && SAC.directResults(ui3).searchWhy === 'busy', JSON.stringify([got3, slept, ui3.search]));
  const ui4 = {};
  let slept4 = 0;
  const long = async () => { throw Object.assign(new Error('slow down'), { waitMs: 60000 }); };
  const got4 = await SAC.runSearch(ui4, 'abc', { ui: ui4, sleep: async () => { slept4++; } }, long);
  check('rate limit: a long pause is not waited for inside the search: it says busy at once', got4.busy === true && slept4 === 0, JSON.stringify(got4));
  const ui5 = {};
  const g5 = gate();
  let n5 = 0;
  const limited5 = async (m, p) => { n5++; const t = decodeURIComponent(/q=([^&]*)/.exec(p)[1]); return t === 'one' ? { ok: false, status: 429, body: '' } : { ok: true, status: 200, body: searchBody(t) }; };
  const one = SAC.runSearch(ui5, 'one', { ui: ui5, sleep: async () => { await g5.p; } }, limited5);
  await Promise.resolve();
  const two = SAC.runSearch(ui5, 'two', { ui: ui5 }, limited5);
  await two;
  g5.go();
  const r5 = await one;
  check('rate limit: a search that was waiting out a 429 is dropped, not asked again, when a newer one came', r5.stale === true && n5 === 2 && ui5.search.term === 'two', JSON.stringify([r5, n5, ui5.search]));
  const ui6 = {};
  const broken = async () => ({ ok: false, status: 500, body: '' });
  const got6 = await SAC.runSearch(ui6, 'abc', { ui: ui6 }, broken);
  check('a real failure still says so (the page’s own search takes over)', got6.ok === false && !got6.busy && ui6.search.why === 'page', JSON.stringify(got6));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } else console.log(`PASS ${name}`); })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
