// "Organize tabs with AI" finds the tabs: node test/organize-units.js (pure Node, no Electron).
// Tab objects are shaped like main.js's (sleeping restored tabs carry sleepUrl/sleepTitle; live ones a view).
// TG_MODULE=<path> runs the same checks against another copy of tab-groups.js (to see them fail on the old one).
const path = require('path');
const tg = require(process.env.TG_MODULE ? path.resolve(process.env.TG_MODULE) : '../src/browser/tab-groups');

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`); };

const isWebUrl = (u) => /^https?:\/\//i.test(u);
// The same wiring as main.js: a sleeping tab answers from its stored URL and title.
function window_(specs) {
  let tabs = [];
  const g = tg.createTabGroups({
    getTabs: () => tabs, setTabs: (l) => { tabs = l; },
    urlOf: (t) => (t.view ? t.view.url : t.sleepUrl || ''), titleOf: (t) => (t.view ? t.view.title : t.sleepTitle || ''),
    textOf: () => '', isWeb: isWebUrl, mode: () => 'topic', aiTopics: () => false,
  });
  let id = 1;
  for (const [title, url, extra = {}] of specs) tabs.push({ id: id++, sleeping: true, sleepTitle: title, sleepUrl: url, groupId: null, userRemoved: false, ...extra });
  return { g, tabs: () => tabs };
}
const RECIPES = [['Easy Banana Bread Recipe', 'https://a.example/banana-bread'], ['Chocolate Chip Cookie Recipes', 'https://b.example/cookies'], ['Classic Pancake Recipe', 'https://c.example/pancakes']];
const TRIP = [['Flights to Tokyo', 'https://kayak.example/flights/tokyo'], ['Tokyo hotels and ryokan', 'https://booking.example/tokyo']];
const gid = (t) => t.groupId || null;

// 1. a restored session: every loose tab is userRemoved, all asleep
{
  const w = window_([...RECIPES, ...TRIP].map(([a, b]) => [a, b, { userRemoved: true }]));
  check('restored sleeping tabs are all candidates', w.g.candidates().length === 5, String(w.g.candidates().length));
  check('organize groups them', w.g.organizeByTopic() >= 1 && w.tabs().slice(0, 3).every((t) => gid(t) && gid(t) === gid(w.tabs()[0])));
  check('undo puts the marks back', w.g.undoOrganize() && w.tabs().every((t) => t.userRemoved === true && !gid(t)));
}

// 2. tabs dragged around by hand (userMoved) still count for an explicit Organize, and Undo restores the mark
{
  const w = window_(RECIPES.map(([a, b]) => [a, b, { userMoved: true, userRemoved: true }]));
  check('hand-moved loose tabs are candidates', w.g.candidates().length === 3, String(w.g.candidates().length));
  w.g.organizeByTopic();
  check('hand-moved loose tabs get grouped', w.tabs().every((t) => gid(t) && gid(t) === gid(w.tabs()[0])));
  w.g.undoOrganize();
  check('undo restores userMoved', w.tabs().every((t) => t.userMoved === true && !gid(t)));
}

// 3. already auto-grouped by site: still regrouped by topic, not counted as nothing
{
  const w = window_([...RECIPES, ...TRIP]);
  const site = w.g.create('Examples', [1, 2, 3, 4, 5].map((n) => n), { auto: true, domain: 'example.test' });
  check('tabs in an automatic site group are candidates', w.g.candidates().length === 5, String(w.g.candidates().length));
  w.g.organizeByTopic();
  check('the site group is regrouped by topic', !w.g.groups.has(site.id) && gid(w.tabs()[0]) && gid(w.tabs()[0]) === gid(w.tabs()[2]) && gid(w.tabs()[0]) !== gid(w.tabs()[3]));
}

// 4. a group the user made (or named) is left alone; pinned and non-web tabs never count
{
  const w = window_([...RECIPES, ['Settings', 'lumen://settings'], ['Pinned mail', 'https://mail.example/', { pinned: true }], ...TRIP]);
  const mine = w.g.create('My trip', [6, 7]); // userPlaced, not auto
  check('user-made group members, pinned and internal tabs are not candidates', w.g.candidates().length === 3, String(w.g.candidates().length));
  w.g.organizeByTopic();
  check('user group untouched', gid(w.tabs()[5]) === mine.id && gid(w.tabs()[6]) === mine.id && !gid(w.tabs()[4]));
  const c = w.g.organizeCounts();
  check('counts say why (pinned, kept)', c.web === 6 && c.pinned === 1 && c.kept === 2, JSON.stringify(c));
}

// 5. live tabs and sleeping tabs mix; a closing tab is not counted; an error/blank live tab is not web
{
  const w = window_([
    ['Easy Banana Bread Recipe', '', { sleeping: false, view: { url: 'https://a.example/banana-bread', title: 'Easy Banana Bread Recipe' } }],
    ['Chocolate Chip Cookie Recipes', 'https://b.example/cookies'],
    ['Gone', '', { sleeping: false, closing: true, view: { url: 'https://x.example/', title: 'Gone' } }],
    ['New Tab', '', { sleeping: false, view: { url: '', title: 'New Tab' } }],
  ]);
  check('live + sleeping counted, closing/blank not', w.g.candidates().length === 2, String(w.g.candidates().length));
}

// 6. two windows: each window's own tab list is what counts (main.js swaps the array per window)
{
  const a = window_([...RECIPES]);
  const b = window_([TRIP[0]]);
  check('window A has enough, window B has too few', a.g.candidates().length === 3 && b.g.candidates().length === 1);
  check('B says there is too little', b.g.organizeCounts().web === 1);
}

// 7. nothing there at all
{
  const w = window_([['New Tab', '']]);
  check('no pages: no candidates, zero web tabs', w.g.candidates().length === 0 && w.g.organizeCounts().web === 0);
}

const at = (w, id) => w.tabs().find((t) => t.id === id); // grouping reorders the strip: tabs by id
// 8. a hand-added member of an automatic group is regrouped with the rest (not stranded, not called "kept"); Undo restores it
{
  const w = window_([...RECIPES, ...TRIP, ['Apple Pie Recipe', 'https://d.example/apple-pie']]);
  const auto = w.g.create('Baking', [1, 2], { auto: true });
  w.g.add(6, auto.id); // dragged in by hand: userPlaced
  check('the hand-added tab is marked', at(w, 6).userPlaced === true);
  check('it counts as organizable, not kept', w.g.candidates().length === 6 && w.g.organizeCounts().kept === 0, JSON.stringify(w.g.organizeCounts()));
  check('organizableCount matches candidates', w.g.organizableCount?.() === w.g.candidates().length);
  w.g.organizeByTopic();
  const recipeGroup = gid(at(w, 1));
  check('recipes (the hand-added one too) end in one group', recipeGroup && [1, 2, 3, 6].every((id) => gid(at(w, id)) === recipeGroup), w.tabs().slice().sort((x, y) => x.id - y.id).map(gid).join());
  check('the mark is cleared on the tab Organize took', at(w, 6).userPlaced === false);
  w.g.undoOrganize();
  check('undo puts the hand-added tab and its mark back', gid(at(w, 6)) === auto.id && at(w, 6).userPlaced === true && !gid(at(w, 3)));
}

// 9. nothing to group: the automatic groups stay exactly as they were, there is nothing to undo, and the marks are kept
{
  const w = window_([['Quarterly zebra', 'https://a.example/1', { userRemoved: true }], ['Ostrich marathon', 'https://b.example/2', { userRemoved: true }], ['Plumbing 101', 'https://c.example/3'], ['Sonnet review', 'https://d.example/4']]);
  const site = w.g.create('Sites', [3, 4], { auto: true, domain: 'c.example' });
  const before = w.tabs().slice().sort((x, y) => x.id - y.id).map(gid).join();
  const count = w.g.organizeByTopic();
  check('nothing grouped: 0', count === 0, String(count));
  check('the automatic group is still there with its tabs', w.g.groups.has(site.id) && w.tabs().slice().sort((x, y) => x.id - y.id).map(gid).join() === before, w.tabs().slice().sort((x, y) => x.id - y.id).map(gid).join());
  check('nothing to undo after a no-op organize', w.g.canUndo() === false);
  check('the loose tabs keep userRemoved', at(w, 1).userRemoved === true && at(w, 2).userRemoved === true);
}

// 10. userRemoved is cleared only on tabs Organize takes (not pinned tabs, not the user's own groups)
{
  const w = window_([...RECIPES.map(([a, b]) => [a, b, { userRemoved: true }]), ['Pinned', 'https://p.example/', { pinned: true, userRemoved: true }], ['Mine', 'https://m.example/', { userRemoved: true }]]);
  w.g.create('My group', [5]);
  at(w, 5).userRemoved = true; // a leftover mark on a member of the user's own group
  w.g.organizeByTopic();
  check('pinned and user-grouped tabs keep userRemoved; taken tabs lose it', at(w, 4).userRemoved === true && at(w, 5).userRemoved === true && [1, 2, 3].every((id) => at(w, id).userRemoved === false));
}

// 11. no AI: a realistic 31-tab bar ends mostly grouped, with good names and no giant "Other"
{
  const BAR = [
    ['Flights to Tokyo - Google Flights', 'https://www.google.com/travel/flights?q=tokyo'], ['Tokyo hotels - Booking.com', 'https://www.booking.com/city/jp/tokyo.html'],
    ['Things to do in Tokyo - Tripadvisor', 'https://www.tripadvisor.com/Tokyo'], ['Shibuya food guide', 'https://www.eater.com/tokyo-food'],
    ['Easy Banana Bread Recipe', 'https://www.allrecipes.com/banana-bread'], ['Best Chocolate Chip Cookies', 'https://www.seriouseats.com/cookies'], ['Sourdough starter guide', 'https://www.kingarthurbaking.com/sourdough'],
    ['React useEffect docs', 'https://react.dev/reference/react/useEffect'], ['Electron BrowserWindow API', 'https://www.electronjs.org/docs/api/browser-window'], ['node:fs documentation', 'https://nodejs.org/api/fs.html'],
    ['TypeScript handbook', 'https://www.typescriptlang.org/docs/handbook'], ['Stack Overflow - how to debounce', 'https://stackoverflow.com/questions/1'],
    ['CS 3500 - Canvas', 'https://canvas.northeastern.edu/courses/1'], ['Gradescope HW3', 'https://www.gradescope.com/courses/2'], ['Piazza CS3500', 'https://piazza.com/class/x'],
    ['Gmail - Inbox', 'https://mail.google.com/mail/u/0'], ['YouTube - lofi beats', 'https://www.youtube.com/watch?v=1'], ['Reddit - r/programming', 'https://www.reddit.com/r/programming'], ['Hacker News', 'https://news.ycombinator.com'],
    ['Amazon.com: mechanical keyboard', 'https://www.amazon.com/s?k=keyboard'], ['Best mechanical keyboards 2026 - RTINGS', 'https://www.rtings.com/keyboard'], ['Keychron Q1 review', 'https://www.theverge.com/keychron'],
    ['Weather Boston', 'https://weather.com/boston'], ['Linear algebra notes', 'https://example.edu/la'], ['Wikipedia - Eigenvalue', 'https://en.wikipedia.org/wiki/Eigenvalue'], ['Khan Academy - matrices', 'https://www.khanacademy.org/matrices'],
    ['Repo - lumen', 'https://github.com/me/lumen'], ['Pull request #12', 'https://github.com/me/lumen/pull/12'], ['Issues', 'https://github.com/me/lumen/issues'],
    ['Notion', 'https://www.notion.so/x'], ['Spotify', 'https://open.spotify.com/'],
  ];
  const run = () => { const w = window_(BAR.map(([a, b]) => [a, b, { userRemoved: true }])); w.g.organizeByTopic(); return w; };
  const w = run();
  const named = w.g.state();
  const grouped = w.tabs().filter((t) => gid(t)).length;
  const sizes = named.map((g) => w.tabs().filter((t) => t.groupId === g.id).length);
  check('31-tab bar: at least 90% grouped', grouped / 31 >= 0.9, `${grouped}/31`);
  check('31-tab bar: no giant group, no "Other"', Math.max(...sizes) <= 8 && !named.some((g) => /^other$/i.test(g.name)), named.map((g, i) => `${g.name}:${sizes[i]}`).join());
  const nameOf = (i) => named.find((g) => g.id === at(w, i + 1).groupId)?.name || '';
  check('31-tab bar: good names', /recipes/i.test(nameOf(4)) && /dev/i.test(nameOf(7)) && nameOf(7) === nameOf(11) && /school/i.test(nameOf(12)) && nameOf(12) === nameOf(23) && /mail/i.test(nameOf(15)) && nameOf(15) === nameOf(29) && /video/i.test(nameOf(16)), named.map((g) => g.name).join());
  check('31-tab bar: the keyboard review joins the keyboard group', nameOf(19) === nameOf(21) && nameOf(19) !== '', nameOf(21));
  check('31-tab bar: topics stay apart (Tokyo trip is not dev docs)', nameOf(0) !== nameOf(7) && nameOf(26) !== nameOf(7), `${nameOf(0)} / ${nameOf(26)} / ${nameOf(7)}`);
  check('31-tab bar: deterministic', run().g.state().map((g) => g.name).join() === named.map((g) => g.name).join());
}

process.exit(failed ? 1 : 0);
