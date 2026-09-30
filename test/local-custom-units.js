// Custom recipes, Notes, Countdown and Timer (run from test/units.js): recipe checks and shaping, the
// timer's steps, countdown dates, and the connectors' act() and present() (no network, no Electron).
const CW = require('../features/custom-widget');
const LW = require('../features/local-widgets');
const { cleanWidget, CONNECTORS } = require('../features/widgets');
const WS = require('../renderer/widget-summary');

module.exports = async function localCustomUnits(check) {
  const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  // ---- recipes ----
  for (const ex of CW.EXAMPLES) check(`custom: example "${ex.name}" is a valid recipe`, Boolean(CW.cleanRecipe(ex)), JSON.stringify(ex));
  check('custom: http:// is refused', throws(() => CW.cleanRecipe({ url: 'http://x.example/a', stats: [{ path: 'a' }] }), /https/), '');
  check('custom: a path into __proto__ is refused', throws(() => CW.cleanRecipe({ url: 'https://x.example/', stats: [{ path: 'a.__proto__.b' }] }), /isn’t a path/), '');
  check('custom: a path with code in it is refused', throws(() => CW.cleanRecipe({ url: 'https://x.example/', stats: [{ path: 'a;alert(1)' }] }), /isn’t a path/), '');
  check('custom: more than 6 stats is refused', throws(() => CW.cleanRecipe({ url: 'https://x.example/', stats: Array.from({ length: 7 }, () => ({ path: 'a' })) }), /At most 6/), '');
  check('custom: a list recipe needs a list', throws(() => CW.cleanRecipe({ url: 'https://x.example/', view: 'list' }), /needs a "list"/), '');
  const r = CW.cleanRecipe({ url: 'https://x.example/', every: 1, stats: [{ label: 'EUR', path: 'rates.EUR', decimals: 3, prefix: '€' }, { label: 'Up', path: 'ok' }, { label: 'First', path: 'items[0].name' }] });
  check('custom: every is clamped to at least 5 minutes', r.every === 5, String(r.every));
  const got = CW.shape({ rates: { EUR: 0.91234 }, ok: true, items: [{ name: 'a' }] }, r);
  check('custom: stats are formatted as text (decimals, prefix, booleans, indexes)', JSON.stringify(got.stats.map((x) => x.value)) === '["€0.912","Yes","a"]', JSON.stringify(got));
  check('custom: an answer with none of the paths is an error', throws(() => CW.shape({}, r), /None of the recipe/), '');
  check('custom: get() reads own properties only', CW.get({}, 'constructor') === undefined && CW.get({ a: [{ b: 2 }] }, 'a[0].b') === 2 && CW.get({ a: { hasOwnProperty: 1 } }, 'a.toString') === undefined, '');
  const lr = CW.cleanRecipe(CW.EXAMPLES[1]);
  const items = CW.shape({ hits: [{ title: 'One', points: 10, url: 'https://a.example/' }, { title: 'Two', points: 3, url: 'javascript:alert(1)' }, { points: 1 }] }, lr).items;
  check('custom: list items keep https links only and skip items without a title', items.length === 2 && items[0].url === 'https://a.example/' && items[1].url === null && items[0].detail === '10', JSON.stringify(items));
  const K = CONNECTORS.custom;
  let err = null;
  try { await K.resolve({ recipe: '{ nope' }, {}); } catch (e) { err = e; }
  check('custom: a recipe that isn’t JSON is explained', err && /isn’t valid JSON/.test(err.message), String(err));
  const res = await K.resolve({ recipe: JSON.stringify(CW.EXAMPLES[0]) }, { json: async () => ({ stargazers_count: 5, forks_count: 1, open_issues_count: 2 }) });
  check('custom: Test fetches the address and says what it found', /3 of 3 values found/.test(res.message) && res.config.recipe.url === CW.EXAMPLES[0].url, JSON.stringify(res));
  check('custom: a stored widget with a broken recipe is dropped', cleanWidget({ id: 'wcus00001', type: 'custom', recipe: { url: 'http://x' } }) === null, '');

  // ---- countdown ----
  check('countdown: 2026-02-31 isn’t a date', LW.cleanCountdown({ date: '2026-02-31' }) === null && LW.cleanCountdown({ date: 'soon' }) === null, '');
  const cd = LW.cleanCountdown({ date: '2027-01-01', time: '09:30', label: ' New  year ' });
  check('countdown: date, time and label are kept (label tidied)', cd.date === '2027-01-01' && cd.time === '09:30' && cd.label === 'New year' && LW.countdownTarget(cd) === new Date(2027, 0, 1, 9, 30).getTime(), JSON.stringify(cd));
  check('countdown: a bad time is dropped, the date stays', LW.cleanCountdown({ date: '2027-01-01', time: '25:00' }).time === '', '');

  // ---- timer ----
  const t0 = 1e12;
  let tm = LW.cleanTimer({});
  check('timer: defaults to a 25/5 Pomodoro, idle', tm.work === 25 && tm.rest === 5 && tm.pomodoro && LW.timerView(tm, t0).state === 'idle', JSON.stringify(tm));
  tm = LW.timerStep(tm, 'start', t0);
  check('timer: start runs to a moment', tm.endsAt === t0 + 25 * 60e3 && LW.timerView(tm, t0 + 60e3).state === 'running' && LW.timerView(tm, t0 + 60e3).left === 24 * 60e3, JSON.stringify(tm));
  tm = LW.timerStep(tm, 'pause', t0 + 5 * 60e3);
  check('timer: pause keeps what is left', tm.endsAt === null && tm.left === 20 * 60e3 && LW.timerView(tm, t0 + 99e6).state === 'paused', JSON.stringify(tm));
  tm = LW.timerStep(tm, 'start', t0 + 10 * 60e3);
  check('timer: resume continues from there', tm.endsAt === t0 + 30 * 60e3, JSON.stringify(tm));
  check('timer: past the end it is done', LW.timerView(tm, t0 + 31 * 60e3).state === 'done', '');
  tm = LW.timerStep(tm, 'start', t0 + 31 * 60e3);
  check('timer: start after focus begins the break and counts a round', tm.phase === 'rest' && tm.rounds === 1 && tm.endsAt === t0 + 36 * 60e3, JSON.stringify(tm));
  tm = LW.timerStep(tm, 'reset', t0 + 32 * 60e3);
  check('timer: reset goes back to idle focus (rounds kept)', tm.phase === 'work' && !tm.endsAt && !tm.left && tm.rounds === 1, JSON.stringify(tm));
  const plain = LW.timerStep(LW.timerStep(LW.cleanTimer({ pomodoro: false, work: 3 }), 'start', t0), 'start', t0 + 4 * 60e3);
  check('timer: a plain timer starts again with the same length', plain.phase === 'work' && plain.endsAt === t0 + 7 * 60e3, JSON.stringify(plain));
  check('timer: hostile stored numbers are replaced', JSON.stringify(LW.cleanTimer({ work: 1e9, rest: -1, endsAt: 'x', left: Infinity })) === JSON.stringify(LW.cleanTimer({})), '');
  const T = CONNECTORS.timer;
  const acted = T.act({ tm: LW.cleanTimer({}) }, { do: 'timer', arg: 'start' }, { now: () => t0 });
  check('timer: the card’s Start is stored as config, nothing fetched', acted.local && acted.config.tm.endsAt === t0 + 25 * 60e3, JSON.stringify(acted));

  // ---- notes ----
  const N = CONNECTORS.notes;
  const n = N.act({ note: { text: '' } }, { do: 'note', text: 'a\r\nb' });
  check('notes: typing is stored, line ends normalised', n.local && n.config.note.text === 'a\nb', JSON.stringify(n));
  check('notes: at most 4000 characters', LW.cleanNote({ text: 'x'.repeat(5000) }).text.length === 4000, '');
  check('notes: present gives the page the text', N.present({ note: { text: 'hi' } }).text === 'hi', '');
  check('new kinds are in Settings’ picker with names', ['notes', 'countdown', 'timer', 'custom'].every((k) => CONNECTORS[k] && WS.ORDER.includes(k) && WS.kindName(k) !== k), '');
};
