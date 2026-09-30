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

process.exit(failed ? 1 : 0);
