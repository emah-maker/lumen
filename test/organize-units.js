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
    ['Amazon.com: mechanical keyboard', 'https://www.amazon.com/s?k=keyboard'], ['Best mechanical keyboards 2026 - RTINGS', 'https://www.rtings.com/keyboard'], ['Keychron Q1 mechanical keyboard review', 'https://www.theverge.com/keychron'],
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
  check('31-tab bar: good names', /recipes|baking/i.test(nameOf(4)) && /dev|programming|javascript/i.test(nameOf(7)) && nameOf(7) === nameOf(11) && /school/i.test(nameOf(12)) && nameOf(12) === nameOf(23) && /mail/i.test(nameOf(15)) && nameOf(15) === nameOf(29) && /video/i.test(nameOf(16)), named.map((g) => g.name).join());
  check('31-tab bar: the keyboard review joins the keyboard group', nameOf(19) === nameOf(21) && nameOf(19) !== '', nameOf(21));
  check('31-tab bar: topics stay apart (Tokyo trip is not dev docs)', nameOf(0) !== nameOf(7) && nameOf(26) !== nameOf(7), `${nameOf(0)} / ${nameOf(26)} / ${nameOf(7)}`);
  check('31-tab bar: deterministic', run().g.state().map((g) => g.name).join() === named.map((g) => g.name).join());
}

// Organizes a list of [title, url] and returns { name per tab index (or ''), same(i, j) }.
function organized(specs) {
  const w = window_(specs.map(([a, b]) => [a, b, { userRemoved: true }]));
  w.g.organizeByTopic();
  const names = w.g.state();
  const name = (i) => names.find((g) => g.id === at(w, i + 1).groupId)?.name || '';
  return { name, same: (i, j) => Boolean(at(w, i + 1).groupId) && at(w, i + 1).groupId === at(w, j + 1).groupId };
}

// 12. government sites are "Government", never "School"; schools are still "School"
{
  const r = organized([['Where is my refund? | Internal Revenue Service', 'https://www.irs.gov/refunds'], ['Driver license renewal - California DMV', 'https://www.dmv.ca.gov/portal/'], ['Universal Credit - GOV.UK', 'https://www.gov.uk/universal-credit'],
    ['Syllabus - CS 3500', 'https://www.northeastern.edu/cs3500'], ['Reading list', 'https://www.cam.ac.uk/reading'], ['Schoology - Home', 'https://app.schoology.com/home']]);
  // Round 10: a host alone (.gov, .edu, .ac.uk) forms no group: the tabs must share a word or concept too.
  check('irs.gov, dmv.ca.gov and gov.uk share only the kind of host: no group, and never School', !r.same(0, 1) && !r.same(0, 2) && !/school/i.test(r.name(0)) && !/school/i.test(r.name(1)), r.name(0));
  check('.edu / .ac.uk / schoology share only the kind of host: no group', !r.same(3, 4) && !r.same(3, 5) && !r.same(0, 3), `${r.name(3)} / ${r.name(4)}`);
  const govWord = organized([['Driver license renewal - California DMV', 'https://www.dmv.ca.gov/portal/'], ['Driver license renewal - Texas DPS', 'https://www.dps.texas.gov/renew'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('two agency pages that share a title word still group (and are not School)', govWord.same(0, 1) && !/school/i.test(govWord.name(0)) && !govWord.same(0, 2), govWord.name(0));
}

// 13. CJK and Cyrillic titles group
{
  const jp = organized([['東京のホテル予約 - 宿泊サイト', 'https://yado.jp/tokyo'], ['東京観光スポット おすすめ20選', 'https://kanko.jp/tokyo'], ['Easy Banana Bread Recipe', 'https://a.example/banana-bread']]);
  check('Japanese Tokyo hotel + sightseeing tabs group', jp.same(0, 1) && !jp.same(0, 2), `${jp.name(0)}|${jp.name(1)}`);
  check('the Japanese group is named for Tokyo', /東京/.test(jp.name(0)) || /travel/i.test(jp.name(0)), jp.name(0));
  const ru = organized([['Отели Берлина — лучшие предложения', 'https://otely.ru/berlin'], ['Берлин: что посмотреть за 3 дня', 'https://gid.travel/berlin'], ['Входящие — Яндекс Почта', 'https://mail.yandex.ru/'], ['Письма — Почта Mail.ru', 'https://e.mail.ru/inbox']]);
  check('Russian Berlin tabs group', ru.same(0, 1), `${ru.name(0)}`);
  check('Russian mail tabs group apart from Berlin', ru.same(2, 3) && !ru.same(0, 2), `${ru.name(2)}`);
  const tok = tg.tokens('東京のホテルとコーヒー Москва');
  check('tokens: CJK bigrams, Katakana long-vowel kept, Cyrillic word', tok.some((t) => t.key === '東京') && tok.some((t) => t.key === 'ホテ') && tok.some((t) => t.key === 'ヒー') && tok.some((t) => /^москв/.test(t.key)), tok.map((t) => t.key).join());
}

// 14. a group that is almost all one site is named for the site, not a category
{
  const gh = Array.from({ length: 12 }, (_, i) => [`acme/tool${i} - ${['parser', 'router', 'logger', 'cache'][i % 4]} library`, `https://github.com/acme/tool${i}`]);
  const r = organized([...gh, ['React docs', 'https://react.dev/learn'], ['Node docs', 'https://nodejs.org/api']]);
  check('12 GitHub repos: named GitHub, not Dev docs', r.same(0, 11) && r.name(0) === 'GitHub', r.name(0));
}

// 15. CJK filler words are not topics, and names are whole words
{
  const keys = (t) => tg.tokens(t).map((x) => x.key);
  check('tokens: おすすめ, これは and です make no bigrams', !keys('東京のおすすめ').some((k) => /^(のお|おす|すめ)$/.test(k)) && keys('これは です').length === 0, keys('これは です').join());
  check('tokens: 如何 is dropped, the topic after it stays', !keys('如何学习Python').includes('如何') && keys('如何学习Python').includes('学习'), keys('如何学习Python').join());
  const jp = organized([['東京のおすすめラーメン店10選', 'https://a.example/1'], ['福岡のおすすめグルメ', 'https://b.example/2'], ['Pythonの基本文法を学ぶ', 'https://c.example/3'], ['Reactのフック入門', 'https://d.example/4']]);
  check('unrelated "おすすめ" titles do not form one group', !jp.same(0, 1) && !jp.same(0, 2) && !/おす|のお/.test(jp.name(0) + jp.name(1)), `${jp.name(0)}|${jp.name(1)}`);
  const pen = organized([['これは ペン です', 'https://a.example/1'], ['これは 本 です', 'https://b.example/2']]);
  check('"これは ペン です" / "これは 本 です" stay apart', !pen.same(0, 1), pen.name(0));
  const zh = organized([['如何学习Python编程', 'https://a.cn/1'], ['如何做红烧肉', 'https://b.cn/2'], ['如何选择笔记本电脑', 'https://c.cn/3']]);
  check('"如何..." titles about different things do not group', !zh.same(0, 1) && !zh.same(1, 2) && !zh.same(0, 2), zh.name(0));
  const ko = organized([['파이썬 기초 강의', 'https://a.kr/1'], ['파이썬 기초 배우기', 'https://b.kr/2'], ['파이썬 기초 튜토리얼', 'https://c.kr/3']]);
  check('Korean 파이썬 group is named 파이썬, not "파이 이썬"', ko.same(0, 1) && ko.same(1, 2) && ko.name(0) === '파이썬', ko.name(0));
  const cn = organized([['如何学习Python编程', 'https://a.cn/1'], ['学习Python编程入门', 'https://b.cn/2'], ['Python编程学习路线', 'https://c.cn/3']]);
  check('Chinese group is named for the longest shared run', cn.same(0, 2) && cn.name(0) === 'Python 编程', cn.name(0));
}

// 16. Russian: one word in every case, and a city shared with an unrelated page is not a topic
{
  const ru = organized([['Погода в Москве', 'https://yandex.ru/1'], ['Новости Москвы сегодня', 'https://lenta.ru/2'], ['Москва отели', 'https://ostrovok.ru/3'], ['Купить iPhone 15 в Москве', 'https://dns.ru/4'], ['Рецепт пирога с яблоками', 'https://povar.ru/5'], ['Рецепты пирогов', 'https://eda.ru/6']]);
  check('Moscow tabs group and the group is named Москва', ru.same(0, 1) && ru.same(1, 2) && ru.name(0) === 'Москва', ru.name(0));
  check('"Купить iPhone в Москве" is not pulled into the Moscow group', !ru.same(0, 3) && !ru.same(2, 3), ru.name(3));
  const borsch = organized([['Как приготовить борщ', 'https://a.ru/1'], ['Рецепт борща классический', 'https://b.ru/2'], ['Борщ со свеклой', 'https://c.ru/3'], ['Как настроить роутер', 'https://d.ru/4']]);
  check('борщ / борща / Борщ are one word', borsch.same(0, 1) && borsch.same(1, 2) && !borsch.same(0, 3), borsch.name(0));
  check('stemWord keys: борща = борщ, Москве = Москвы', tg.tokens('борща')[0].key === tg.tokens('борщ')[0].key && tg.tokens('Москве')[0].key === tg.tokens('Москвы')[0].key);
}

// 17. site names: known names, .gov hosts are Government
{
  check('siteName: The Verge, Hacker News, GOV.UK, IRS', tg.siteName('https://www.theverge.com/x') === 'The Verge' && tg.siteName('https://news.ycombinator.com/') === 'Hacker News' && tg.siteName('https://www.gov.uk/universal-credit') === 'GOV.UK' && tg.siteName('https://www.irs.gov/refunds') === 'IRS',
    [tg.siteName('https://www.theverge.com/x'), tg.siteName('https://www.gov.uk/'), tg.siteName('https://www.irs.gov/')].join());
  const hn = organized([['Hacker News 7', 'https://news.ycombinator.com/'], ['Hacker News 38', 'https://news.ycombinator.com/newest'], ...RECIPES]);
  check('two Hacker News tabs are named Hacker News', hn.same(0, 1) && hn.name(0) === 'Hacker News', hn.name(0));
  const gov = organized([['GOV.UK', 'https://www.gov.uk/'], ['Weather.gov', 'https://weather.gov/'], ['Where is my refund? | IRS', 'https://www.irs.gov/refunds'], ['Easy Banana Bread Recipe', 'https://a.example/banana-bread']]);
  check('GOV.UK, weather.gov and the IRS share only a host kind: no group, and none named "GOV"', !gov.same(0, 1) && !gov.same(0, 2) && !gov.same(1, 2) && gov.name(0) !== 'GOV', gov.name(0));
}

// 18. a window that is all about one thing: the word every tab carries is the topic, not noise (once nothing else grouped)
{
  const parts = ['food reviews', 'toys diy', 'beds best', 'vets near me', 'adoption centers', 'grooming tips', 'litter types', 'vaccines schedule'];
  for (const n of [4, 6, 8]) {
    const r = organized(parts.slice(0, n).map((w, i) => [`Kitten ${w}`, `https://s${i}.example/${i}`]));
    check(`${n} kitten tabs on ${n} sites are one group named Kitten`, Array.from({ length: n }, (_, i) => r.same(0, i)).every(Boolean) && /kitten/i.test(r.name(0)), `${r.name(0)} ${r.same(0, n - 1)}`);
  }
  const mid = organized(parts.slice(0, 4).map((w, i) => [`Best ${w} for kitten owners`, `https://s${i}.example/${i}`]));
  check('"kitten" inside the title counts too', mid.same(0, 3) && /kitten/i.test(mid.name(0)), mid.name(0));
  const withNoise = organized([...parts.slice(0, 4).map((w, i) => [`Kitten ${w}`, `https://s${i}.example/${i}`]), ['Sourdough bread recipe', 'https://x.example/1'], ['Mortgage rates today', 'https://y.example/2'], ['React hooks guide', 'https://z.example/3']]);
  check('kitten tabs among unrelated ones: still one group, the others loose', withNoise.same(0, 3) && !withNoise.same(0, 4) && !withNoise.name(4), withNoise.name(4));
  const one = window_(parts.slice(0, 4).map((w, i) => [`Kitten ${w}`, `https://s${i}.example/${i}`, { userRemoved: true }]));
  check('a window of one topic: organize makes the one group (not "no groups")', one.g.organizeByTopic() === 1 && one.g.state().length === 1);
  // the same word on one site is that site's template unless it opens every title
  const weather = organized(Array.from({ length: 6 }, (_, i) => [`Weather in Moscow ${i}`, `https://forecastly.example/p/${i}`]));
  check('6 "Weather in Moscow N" tabs of one host are one group', [1, 2, 3, 4, 5].every((i) => weather.same(0, i)) && /moscow|weather/i.test(weather.name(0)), weather.name(0));
  const mdn = organized(['Fetch API', 'Array.map', 'CSS grid', 'Canvas API'].map((t, i) => [`${t} - Web APIs | MDN`, `https://developer.mozilla.org/en-US/docs/${i}`]));
  check("a site's trailing tagline (\"Web APIs | MDN\") on every tab never names the group", !/api|mdn|web/i.test(mdn.name(0)), mdn.name(0));
  const nav = organized(['Acme', 'Bolt', 'Cedar', 'Dune'].map((t, i) => [`${t} dashboard`, `https://s${i}.example/${i}`]));
  check('"dashboard" on every tab of four sites is nav, not a topic', !nav.same(0, 1) && !nav.same(2, 3), nav.name(0));
  const plants = organized([['Intro to ferns', 'https://plantwiki.example/a'], ['Fern watering schedule', 'https://plantwiki.example/b'], ['Growing moss indoors', 'https://plantwiki.example/c'], ['Succulent care basics', 'https://plantwiki.example/d'], ['Orchid repotting', 'https://plantwiki.example/e'], ['Bonsai pruning', 'https://plantwiki.example/f']]);
  check('6 plant tabs of one site are one group, not "Ferns" and 4 loose', [1, 2, 3, 4, 5].every((i) => plants.same(0, i)) && /plant/i.test(plants.name(0)), `${plants.name(0)} ${plants.name(2)}`);
}

// 19. tabs of one errand that share no word: a concept draws them together (finance, machine learning, fitness)
{
  const fin = organized([['Roth IRA limits', 'https://www.fidelity.com/roth'], ['Vanguard index funds', 'https://investor.vanguard.com/funds'], ['401k rollover guide', 'https://www.nerdwallet.com/401k'], ['Tax return 2025 deadlines', 'https://www.irs.gov/filing'], ['Easy Banana Bread Recipe', 'https://a.example/banana-bread']]);
  check('Roth IRA, Vanguard funds, 401k rollover and the IRS tax page: Finance', [1, 2, 3].every((i) => fin.same(0, i)) && fin.name(0) === 'Finance' && !fin.same(0, 4), fin.name(0));
  const brokers = organized([['Fidelity - Portfolio', 'https://www.fidelity.com/'], ['Vanguard - Funds', 'https://investor.vanguard.com/'], ['Schwab Brokerage', 'https://www.schwab.com/'], ['Robinhood', 'https://robinhood.com/']]);
  check('Fidelity / Vanguard / Schwab / Robinhood: Finance', [1, 2, 3].every((i) => brokers.same(0, i)) && brokers.name(0) === 'Finance', brokers.name(0));
  const irs = organized([['Where is my refund? | Internal Revenue Service', 'https://www.irs.gov/refunds'], ['Driver license renewal - California DMV', 'https://www.dmv.ca.gov/portal/'], ['Universal Credit - GOV.UK', 'https://www.gov.uk/universal-credit'], ['Roth IRA limits', 'https://www.fidelity.com/roth']]);
  check('the IRS among government pages (one money tab): not grouped with them by host alone', !irs.same(0, 1) && !irs.same(0, 2) && !irs.same(1, 2), irs.name(0));
  const ml = organized([['Machine learning course - Coursera', 'https://www.coursera.org/learn/ml'], ['Attention is all you need', 'https://arxiv.org/abs/1706.03762'], ['Transformers explained', 'https://huggingface.co/blog/transformers'], ['Gradient descent visualized', 'https://distill.pub/gd'], ['Neural network basics', 'https://3blue1brown.com/nn'],
    ['Python asyncio tutorial', 'https://realpython.com/async'], ['Python dataclasses', 'https://docs.python.org/3/library/dataclasses.html'], ['PyTorch tutorials', 'https://pytorch.org/tutorials']]);
  check('Coursera, arXiv, Hugging Face, Distill, 3Blue1Brown: Machine learning', [1, 2, 3, 4].every((i) => ml.same(0, i)) && /machine learning/i.test(ml.name(0)), ml.name(0));
  check('PyTorch joins Machine learning, not Python', ml.same(0, 7) && !ml.same(5, 7) && ml.same(5, 6), `${ml.name(7)} / ${ml.name(5)}`);
  const fit = organized([['Best running shoes 2026', 'https://runnersworld.example/shoes'], ['Marathon training plan 16 weeks', 'https://runners.example/plan'], ['Couch to 5K', 'https://nhs.uk/c25k'], ['Sourdough starter guide', 'https://www.kingarthurbaking.com/sourdough']]);
  check('running shoes, marathon plan and Couch to 5K: Fitness', [1, 2].every((i) => fit.same(0, i)) && fit.name(0) === 'Fitness' && !fit.same(0, 3), fit.name(0));
  const few = organized([['Roth limits', 'https://a.example/roth'], ['Vanguard login', 'https://b.example/login'],['Quarterly zebra', 'https://a.example/1'], ['Plumbing 101', 'https://b.example/2']]);
  check('two money tabs are not enough to make a concept group', !few.same(0, 1), few.name(0));
}

// 20. Russian: filler words and case endings do not hide the dish or the city
{
  const borsch = organized([['Рецепт борща', 'https://a.ru/1'], ['Борщ классический', 'https://b.ru/2'], ['Как варить борщ', 'https://c.ru/3'], ['Вкусный борща рецепт', 'https://d.ru/4']]);
  check('4 borscht tabs: one group named Борщ (not Рецепт)', [1, 2, 3].every((i) => borsch.same(0, i)) && borsch.name(0) === 'Борщ', borsch.name(0));
  const moscow = organized([['Погода в Москве', 'https://a.ru/1'], ['Москва отели', 'https://b.ru/2'], ['Достопримечательности Москвы', 'https://c.ru/3'], ['Новости Москвы сегодня', 'https://d.ru/4']]);
  check('4 Moscow tabs: one group named Москва (weather included, not "Travel")', [1, 2, 3].every((i) => moscow.same(0, i)) && moscow.name(0) === 'Москва', moscow.name(0));
  const keys = (t) => tg.tokens(t).map((x) => x.key);
  check('tokens: рецепт, купить, погода, новости are filler', keys('Рецепт борща').length === 1 && keys('Купить ноутбук').length === 1 && keys('Погода в Москве').length === 1 && keys('Новости Москвы').length === 1, keys('Рецепт борща Купить ноутбук Погода в Москве').join());
  const family = (w) => new Set(w.split(' ').map((x) => keys(x)[0])).size;
  check('stemWord: one key for every case (борщ, Москва, Россия, вкусный, отель)', family('борщ борща борщу борщом борще борщи') === 1 && family('москва москвы москве москву москвой') === 1 && family('россия россии россию россией') === 1 && family('красный красного красной красную красные') === 1 && family('отель отеля отелю отеле отели отелей') === 1);
  const pies = organized([['Рецепт пирога с яблоками', 'https://a.ru/1'], ['Рецепты пирогов', 'https://b.ru/2'], ['Погода в Москве', 'https://c.ru/3'], ['Купить ноутбук', 'https://d.ru/4']]);
  check('a group of pies is named for the dictionary form, Пирог', pies.same(0, 1) && pies.name(0) === 'Пирог', pies.name(0));
}

// 21. round 5: ordinary English windows. Filler title words do not make groups, one topic is one group, programming and film/book tabs meet
{
  const keys = (t) => tg.tokens(t).map((x) => x.key);
  check('tokens: explained, intuition, basics, tutorial, overview, beginners are filler', ['Explained', 'Intuition', 'Basics', 'Tutorial', 'Overview', 'Beginners', 'Ultimate', 'Complete', 'Introduction'].every((w) => keys(w).length === 0), keys('Explained Intuition Basics Tutorial Overview Beginners').join());
  const fifteen = organized([['Dividend investing basics', 'https://s0.example/a'], ['Index fund returns', 'https://s1.example/b'], ['Bond yields explained', 'https://s2.example/c'],
    ['Neural network backpropagation', 'https://s3.example/d'], ['Transformer attention explained', 'https://s4.example/e'], ['Gradient descent intuition', 'https://s5.example/f'],
    ['Deadlift form', 'https://s6.example/g'], ['Squat progression', 'https://s7.example/h'], ['Hypertrophy training volume', 'https://s8.example/i'],
    ['Monstera care', 'https://s9.example/j'], ['Fiddle leaf fig watering', 'https://s10.example/k'], ['Succulent soil mix', 'https://s11.example/l'],
    ['Pasta carbonara', 'https://s12.example/m'], ['Paris hotels', 'https://s13.example/n'], ['NBA scores', 'https://s14.example/o']]);
  check('15 tabs: "explained" does not group a finance tab with an ML tab', !fifteen.same(2, 4) && fifteen.name(2) !== 'Explained' && fifteen.name(4) !== 'Explained', `${fifteen.name(2)} / ${fifteen.name(4)}`);
  check('15 tabs: Finance, Machine learning, Fitness and Plants each get their three', [[0, 1, 2, 'Finance'], [3, 4, 5, 'Machine learning'], [6, 7, 8, 'Fitness'], [9, 10, 11, 'Plants']].every(([a, b, c, n]) => fifteen.same(a, b) && fifteen.same(a, c) && fifteen.name(a) === n), [0, 3, 6, 9].map(fifteen.name).join());
  check('15 tabs: the three unrelated tabs stay loose', [12, 13, 14].every((i) => !fifteen.name(i)), [12, 13, 14].map(fifteen.name).join());
  const fillerOnly = organized([['Photosynthesis explained', 'https://a.example/1'], ['Mortgage rates explained', 'https://b.example/2'], ['Guide to guitar chords', 'https://c.example/3'], ['Tips for tomato seedlings', 'https://d.example/4']]);
  check('a filler word is never the only thing two tabs share', [0, 1, 2, 3].every((i) => !fillerOnly.name(i)), [0, 1, 2, 3].map(fillerOnly.name).join());
  const bake = organized([['Sourdough starter', 'https://a.example/1'], ['Sourdough bread recipe', 'https://a.example/2'], ['Sourdough scoring', 'https://a.example/3'], ['Sourdough hydration', 'https://a.example/4'], ['Dutch oven bread', 'https://a.example/5']]);
  check('5 sourdough tabs of one site are one group, not "Sourdough" (3) + "Bread" (2)', [1, 2, 3, 4].every((i) => bake.same(0, i)), [0, 1, 2, 3, 4].map(bake.name).join());
  const py = organized([['Python list comprehension tutorial', 'https://realpython.com/1'], ['pandas groupby', 'https://pandas.pydata.org/1'], ['numpy broadcasting', 'https://numpy.org/1'], ['Matplotlib subplots', 'https://matplotlib.org/1'], ['Django models', 'https://docs.djangoproject.com/1'], ['Pasta carbonara', 'https://x.example/1']]);
  check('Python, pandas, NumPy, Matplotlib and Django tabs across sites: one group named Python', [1, 2, 3, 4].every((i) => py.same(0, i)) && !py.same(0, 5) && py.name(0) === 'Python', py.name(0));
  const dev = organized([['Next.js app router docs', 'https://nextjs.org/docs'], ['TypeScript generics handbook', 'https://www.typescriptlang.org/docs'], ['useState vs useReducer', 'https://react.dev/a'], ['Python list comprehension tutorial', 'https://realpython.com/1'], ['Easy Banana Bread Recipe', 'https://a.example/banana-bread']]);
  check('Next.js, TypeScript, React and Python tabs: "Programming", not a vague "Dev docs"', [1, 2, 3].every((i) => dev.same(0, i)) && !dev.same(0, 4) && dev.name(0) === 'Programming', dev.name(0));
  const lumen = organized([['GitHub - lumen/lumen', 'https://github.com/lumen/lumen'], ['Pull requests - lumen/lumen', 'https://github.com/lumen/lumen/pulls'], ['Issues - lumen/lumen', 'https://github.com/lumen/lumen/issues'], ['pandas groupby', 'https://pandas.pydata.org/1'], ['numpy broadcasting', 'https://numpy.org/1'], ['Matplotlib subplots', 'https://matplotlib.org/1'], ['Django models', 'https://docs.djangoproject.com/1']]);
  check("a repo's GitHub tabs stay \"Lumen\" beside a Python stack", lumen.same(0, 1) && lumen.same(0, 2) && !lumen.same(0, 3) && /lumen/i.test(lumen.name(0)) && [4, 5, 6].every((i) => lumen.same(3, i)), `${lumen.name(0)} / ${lumen.name(3)}`);
  const film = organized([['Dune Part Two review', 'https://www.rottentomatoes.com/m/dune_part_two'], ['Best sci-fi books', 'https://www.goodreads.com/list/sci-fi'], ['Oppenheimer trailer', 'https://www.imdb.com/title/tt15398776'], ['Severance season 2 episodes', 'https://letterboxd.com/film/severance'], ['Amazon.com: standing desk', 'https://www.amazon.com/1'], ['Monitor arm', 'https://www.amazon.com/2'], ['Ergonomic chair deals', 'https://www.amazon.com/3']]);
  check('film and book tabs group together; "review" is not a shopping word', [1, 2, 3].every((i) => film.same(0, i)) && film.name(0) !== 'Shopping' && !film.same(0, 4), film.name(0));
  check('the shop tabs still group', film.same(4, 5) && film.same(4, 6) && !film.same(0, 4), film.name(4));
  const pair = organized([['Roth IRA limits 2026', 'https://a.example/1'], ['Vanguard index funds vs ETFs', 'https://b.example/2'], ['Quarterly zebra', 'https://c.example/3'], ['Plumbing 101', 'https://d.example/4']]);
  check('two tabs that both carry two finance words form a Finance pair', pair.same(0, 1) && pair.name(0) === 'Finance' && !pair.same(0, 2), pair.name(0));
  const weak = organized([['Dividend dates', 'https://a.example/1'], ['Mutual fund fees', 'https://b.example/2'], ['Quarterly zebra', 'https://c.example/3'], ['Plumbing 101', 'https://d.example/4']]);
  check('two tabs with one finance word each are not enough', !weak.same(0, 1), weak.name(0));
  const misfit = organized([['Roth IRA limits', 'https://a.example/1'], ['Neural network backpropagation', 'https://a.example/2'], ['Quarterly zebra', 'https://c.example/3']]);
  check('a finance tab and an ML tab are never a pair', !misfit.same(0, 1));
  // Round 6 rater defects: a pair needs something in common, shopping needs a product, programming and DevOps are their own groups.
  const unrel = organized([['Houseplant care tips', 'https://alpha.example/p0'], ['Resume template', 'https://bravo.example/p1']]);
  check('two unrelated tabs on fake hosts stay loose (no group named for a host)', !unrel.same(0, 1) && !unrel.name(0) && !unrel.name(1), `${unrel.name(0)} / ${unrel.name(1)}`);
  const unrelReal = organized([['Houseplant care tips', 'https://www.thespruce.com/houseplant-care'], ['Resume template', 'https://www.canva.com/resumes/templates']]);
  check('two unrelated tabs on real hosts stay loose', !unrelReal.same(0, 1) && !unrelReal.name(0), `${unrelReal.name(0)} / ${unrelReal.name(1)}`);
  const unrelMore = organized([['Houseplant care tips', 'https://alpha.example/p0'], ['Resume template', 'https://bravo.example/p1'], ['Tax filing deadline', 'https://charlie.example/p2'], ['Guitar chords for beginners', 'https://delta.example/p3']]);
  check('four unrelated tabs: no group, and none named for a host', [0, 1, 2, 3].every((i) => !unrelMore.name(i)), [0, 1, 2, 3].map(unrelMore.name).join());
  const shopBooks = organized([['Laptop deals', 'https://alpha.example/p0'], ['Best novels 2026', 'https://bravo.example/p1']]);
  check('"Laptop deals" and "Best novels 2026" are not a Shopping pair', !shopBooks.same(0, 1) && shopBooks.name(0) !== 'Shopping' && shopBooks.name(1) !== 'Shopping', `${shopBooks.name(0)} / ${shopBooks.name(1)}`);
  const shopPair = organized([['Laptop deals this week', 'https://alpha.example/p0'], ['Gaming laptop price drop', 'https://bravo.example/p1']]);
  check('two product and price tabs are still a pair', shopPair.same(0, 1), shopPair.name(0));
  const prog = organized([['Python asyncio tutorial', 'https://realpython.com/a'], ['pytest fixtures', 'https://docs.pytest.org/f'], ['Flask quickstart', 'https://flask.palletsprojects.com/q'],
    ['JavaScript promises', 'https://alpha.example/js'], ['TypeScript generics', 'https://bravo.example/ts'], ['CSS grid guide', 'https://charlie.example/css']]);
  check('Python, JavaScript, TypeScript and CSS tabs: one group named Programming, none left loose', [1, 2, 3, 4, 5].every((i) => prog.same(0, i)) && prog.name(0) === 'Programming', [0, 1, 2, 3, 4, 5].map(prog.name).join());
  const pyOnly = organized([['Python asyncio tutorial', 'https://realpython.com/a'], ['pytest fixtures', 'https://docs.pytest.org/f'], ['Flask quickstart', 'https://flask.palletsprojects.com/q'], ['pandas groupby', 'https://pandas.pydata.org/g']]);
  check('mostly Python tabs are "Python", not the name of a host', [1, 2, 3].every((i) => pyOnly.same(0, i)) && pyOnly.name(0) === 'Python', pyOnly.name(0));
  const devops = organized([['Kubernetes pods docs', 'https://kubernetes.io/docs/pods'], ['Docker compose networking', 'https://docs.docker.com/n'], ['AWS Lambda pricing', 'https://aws.amazon.com/lambda/pricing'], ['Terraform modules', 'https://registry.terraform.io/m'],
    ['Python asyncio tutorial', 'https://realpython.com/a'], ['pytest fixtures', 'https://docs.pytest.org/f'], ['JavaScript promises', 'https://alpha.example/js'], ['CSS grid guide', 'https://charlie.example/css']]);
  check('Kubernetes, Docker, AWS and Terraform tabs are one DevOps group', [1, 2, 3].every((i) => devops.same(0, i)) && /devops/i.test(devops.name(0)), devops.name(0));
  check('...kept apart from the programming tabs, which are one Programming group', [5, 6, 7].every((i) => devops.same(4, i)) && !devops.same(0, 4) && devops.name(4) === 'Programming', `${devops.name(0)} / ${devops.name(4)}`);
  const repos = organized([['Python tutorial for beginners', 'https://a.example/1'], ['Python virtual environments', 'https://b.example/2'], ['Python dataclasses', 'https://c.example/3'], ['JavaScript promises', 'https://d.example/4'], ['CSS grid guide', 'https://e.example/5'],
    ['GitHub - python/cpython', 'https://github.com/python/cpython'], ['GitHub - nodejs/node', 'https://github.com/nodejs/node']]);
  check('lone repo pages stay out of the programming group', [1, 2, 3, 4].every((i) => repos.same(0, i)) && !repos.same(0, 5) && !repos.same(0, 6) && repos.name(0) === 'Programming', `${repos.name(0)} / ${repos.name(5)}`);
  check('...and are filed together under GitHub', repos.same(5, 6) && repos.name(5) === 'GitHub', repos.name(5));
  const rl = organized([['Reinforcement learning basics', 'https://a.example/1'], ['Neural networks explained', 'https://b.example/2'], ['RLHF explained simply', 'https://c.example/3'], ['Diffusion models intro', 'https://d.example/4'], ['Pizza dough', 'https://e.example/5']]);
  check('reinforcement learning, RLHF and diffusion tabs join the machine learning group', [1, 2, 3].every((i) => rl.same(0, i)) && rl.name(0) === 'Machine learning' && !rl.same(0, 4), rl.name(0));

}

// ---- Round 7 rater's defects (Organize Tabs): local grouping ----

// Defect 1 (local half): an explicit Organize groups tabs marked userRemoved (restored session, hand-ungrouped); Undo brings the marks back.
{
  const w = window_(RECIPES.map(([a, b]) => [a, b]));
  w.g.organizeByTopic();
  for (const t of w.tabs().slice()) w.g.remove(t.id, { byUser: true }); // the user ungroups every tab by hand
  check('hand-ungrouped tabs are all marked userRemoved', w.tabs().every((t) => t.userRemoved === true && !gid(t)));
  check('an explicit local Organize groups the hand-ungrouped tabs again', w.g.organizeByTopic() >= 1 && w.tabs().every((t) => gid(t) && gid(t) === gid(w.tabs()[0])));
  check('...and clears their marks; Undo puts them back', w.tabs().every((t) => t.userRemoved === false) && w.g.undoOrganize() && w.tabs().every((t) => t.userRemoved === true && !gid(t)));
  // ...while the automatic pass keeps respecting the marks.
  check('automatic grouping of loose tabs still skips userRemoved tabs', w.g.organizeLoose() === 0 && w.tabs().every((t) => !gid(t)));
}
// ...and organizeView({ explicit }) shows them to a model, though the plain view (what automatic grouping may touch) does not.
{
  const w = window_([...RECIPES, ...TRIP].map(([a, b]) => [a, b, { userRemoved: true }]));
  check('the plain organizeView hides userRemoved tabs', w.g.organizeView().leftovers.length === 0);
  check('the explicit organizeView lists every organizable tab', w.g.organizeView({ explicit: true }).leftovers.length === 5);
  const pinned = window_([['Pinned page', 'https://p.example/1', { pinned: true, userRemoved: true }], ['Other', 'https://q.example/2', { userRemoved: true }]]);
  check('...never pinned ones', pinned.g.organizeView({ explicit: true }).leftovers.length === 1);
  // applyRefinement({ fresh }) clears the marks of the tabs it groups and Undo restores them; tabs it leaves loose keep theirs.
  const ids = w.tabs().map((t) => t.id);
  const res = w.g.applyRefinement({ groups: [{ name: 'Baking', ids: ids.slice(0, 3) }] }, { fresh: true });
  check('applyRefinement fresh groups userRemoved tabs', res.created === 1 && ids.slice(0, 3).every((id) => gid(at(w, id)) && at(w, id).userRemoved === false), JSON.stringify(res));
  check('...tabs it did not take keep their marks', ids.slice(3).every((id) => at(w, id).userRemoved === true && !gid(at(w, id))));
  check('...and one Undo removes the group and restores the marks', w.g.undoOrganize() && ids.every((id) => at(w, id).userRemoved === true && !gid(at(w, id))));
  const plain = window_(RECIPES.map(([a, b]) => [a, b, { userRemoved: true }]));
  const none = plain.g.applyRefinement({ groups: [{ name: 'Baking', ids: [1, 2] }] }, { seq: 1 });
  check('a non-fresh refinement still respects the marks', none.created === 0 && plain.tabs().every((t) => !gid(t)));
}

// Defect 2: generic words never make or name a group.
{
  const near = organized([['Dentist near me', 'https://a.example/1'], ['Flu shot near me', 'https://b.example/2']]);
  check('two "near me" tabs are no "Near" group', !near.same(0, 1) && near.name(0) === '', near.name(0));
  const olds = organized([['Birthday party ideas for 8 year olds', 'https://a.example/1'], ['Fever in kids: when to call a doctor', 'https://b.example/2'], ['Old Navy kids jeans', 'https://c.example/3']]);
  check('"kids", "old", "olds" do not group tabs or name a group', [0, 1, 2].every((i) => olds.name(i) === ''), [0, 1, 2].map(olds.name).join());
  const buy = organized([['Rent vs buy calculator', 'https://a.example/1'], ['Used piano buying guide', 'https://b.example/2']]);
  check('"buy" / "buying" link nothing', !buy.same(0, 1), buy.name(0));
  const sched = organized([['Office hours schedule', 'https://a.example/1'], ['Little League schedule', 'https://b.example/2']]);
  check('"schedule" links nothing', !sched.same(0, 1), sched.name(0));
  const generic = organized([['Weekend plan with friends', 'https://a.example/1'], ['Marathon plan spreadsheet', 'https://b.example/2']]);
  check('two tabs that share only a generic stem ("plan") are no group', !generic.same(0, 1), generic.name(0));
  const real = organized([['Sourdough starter guide', 'https://a.example/1'], ['Feeding a sourdough starter', 'https://b.example/2']]);
  check('a pair that shares a real stem is still a group', real.same(0, 1) && /sourdough|starter/i.test(real.name(0)), real.name(0));
}

// Defect 3: a shared host or a single word must not outweigh topic.
{
  const mail = organized([['Inbox - mah.e@northeastern.edu - Outlook', 'https://outlook.office.com/mail/'], ['Calendar - Outlook', 'https://outlook.office.com/calendar/'], ['Northeastern Library', 'https://library.northeastern.edu/'],
    ['Office hours schedule', 'https://khoury.northeastern.edu/oh'], ['Husky Card balance', 'https://myhuskycard.northeastern.edu/']]);
  check('Northeastern Library is not in the Outlook group', !mail.same(0, 2) && !mail.same(1, 2), mail.name(0));
  check('...Outlook inbox and calendar are still a group, the university pages another', mail.same(0, 1) && mail.same(2, 4), `${mail.name(0)} / ${mail.name(2)}`);
  check('...and the address in a title is not a word the university page shares', !mail.same(0, 3), mail.name(0));
  const shop = organized([['School district calendar 2026-27', 'https://www.example-isd.org/calendar'], ['ParentSquare', 'https://www.parentsquare.com/'], ['Target: Back to school', 'https://www.target.com/c/back-to-school'],
    ['Home Depot - Paint colors', 'https://www.homedepot.com/b/Paint'], ['Amazon.com: toddler shoes', 'https://www.amazon.com/s?k=toddler+shoes'], ['Old Navy kids jeans', 'https://oldnavy.gap.com/browse/category.do?cid=1']]);
  check('"Target: Back to school" is not filed with the school district page', !shop.same(2, 0), shop.name(2));
  check('...Target is a shop: it goes with the shopping tabs', shop.same(2, 3) && shop.same(2, 4) && /shop/i.test(shop.name(2)), shop.name(2));
}

// Defect 4: work, observability and research tools; SaaS workspaces; an Orlando trip by airport code and theme park.
{
  const work = organized([['Jira - Sprint 42 board', 'https://acme.atlassian.net/jira/software/projects/ENG/boards/1'], ['Linear - My issues', 'https://linear.app/acme/my-issues'], ['Asana - Home', 'https://app.asana.com/0/home'], ['Notion - Team wiki', 'https://www.notion.so/team'],
    ['Mechanical keyboard switches guide', 'https://www.reddit.com/r/MechanicalKeyboards/1'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('Jira, Linear, Asana and Notion are one Work tools group', [1, 2, 3].every((i) => work.same(0, i)) && work.name(0) === 'Work tools' && !work.same(0, 4), work.name(0));
  const obs = organized([['Datadog - Dashboards', 'https://app.datadoghq.com/dashboard/lists'], ['PagerDuty - Incidents', 'https://acme.pagerduty.com/incidents'], ['Sentry Issues', 'https://sentry.io/organizations/acme/issues/'], ['Grafana', 'https://grafana.com/'], ['New Relic', 'https://one.newrelic.com/'],
    ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('Datadog, PagerDuty, Sentry, Grafana and New Relic are one Observability group', [1, 2, 3, 4].every((i) => obs.same(0, i)) && obs.name(0) === 'Observability' && !obs.same(0, 5), obs.name(0));
  const res = organized([['Overleaf, Online LaTeX Editor', 'https://www.overleaf.com/project/1'], ['Zotero | Your personal research assistant', 'https://www.zotero.org/'], ['Google Scholar', 'https://scholar.google.com/'], ['Semantic Scholar', 'https://www.semanticscholar.org/'], ['Mendeley Reference Manager', 'https://www.mendeley.com/reference-manager'],
    ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('Overleaf, Zotero, Scholar, Semantic Scholar and Mendeley are one Research group', [1, 2, 3, 4].every((i) => res.same(0, i)) && res.name(0) === 'Research' && !res.same(0, 5), res.name(0));
  const ml = organized([['Attention Is All You Need - arXiv', 'https://arxiv.org/abs/1706.03762'], ['BERT: Pre-training of Deep Bidirectional Transformers', 'https://arxiv.org/abs/1810.04805'], ['PyTorch documentation', 'https://pytorch.org/docs/stable/index.html'], ['Hugging Face - Models', 'https://huggingface.co/models'],
    ['Overleaf, Online LaTeX Editor', 'https://www.overleaf.com/project/1'], ['Zotero | Your personal research assistant', 'https://www.zotero.org/'], ['Google Scholar', 'https://scholar.google.com/']]);
  check('arXiv papers among machine learning tabs stay Machine learning; the research tools are their own group', [1, 2, 3].every((i) => ml.same(0, i)) && ml.name(0) === 'Machine learning' && [5, 6].every((i) => ml.same(4, i)) && !ml.same(0, 4), `${ml.name(0)} / ${ml.name(4)}`);
  const saas = organized([['Acme release notes', 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1'], ['Standup board', 'https://acme.atlassian.net/jira/software/projects/ENG/boards/1'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara'], ['Sonnet review', 'https://alpha.example/s']]);
  check('two pages of one SaaS workspace (acme.atlassian.net) are a group though their titles share nothing', saas.same(0, 1) && !saas.same(0, 2), saas.name(0));
  const orl = organized([['Disney World ticket prices', 'https://disneyworld.disney.go.com/admission/tickets/'], ['Orlando hotels', 'https://www.booking.com/city/us/orlando.html'], ['Universal Orlando Resort', 'https://www.universalorlando.com/'], ['Flights to MCO', 'https://www.google.com/travel/flights'],
    ['Chicken tikka masala recipe', 'https://www.seriouseats.com/tikka'], ['Sonnet review', 'https://alpha.example/s']]);
  check('Disney World tickets and Flights to MCO join the Orlando trip', [1, 2, 3].every((i) => orl.same(0, i)) && !orl.same(0, 4), orl.name(0));
}

// Defect 7: naming and merging.
{
  const ml = organized([['CUDA out of memory - Stack Overflow', 'https://stackoverflow.com/questions/54374935'], ['GitHub - karpathy/nanoGPT', 'https://github.com/karpathy/nanoGPT'], ['PyTorch documentation', 'https://pytorch.org/docs/stable/index.html'], ['Hugging Face - Models', 'https://huggingface.co/models'],
    ['torch.nn.Linear - PyTorch', 'https://pytorch.org/docs/stable/generated/torch.nn.Linear.html'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('CUDA out of memory and nanoGPT go to Machine learning, not Dev docs', [1, 2, 3, 4].every((i) => ml.same(0, i)) && ml.name(0) === 'Machine learning' && !ml.same(0, 5), ml.name(0));
  const boston = organized([['Boston to NYC bus tickets', 'https://www.flixbus.com/bus/boston'], ['Best ramen in Boston - Yelp', 'https://www.yelp.com/search?find_desc=ramen&find_loc=Boston'], ['Boston rent prices by neighborhood', 'https://www.rentcafe.com/boston'], ['Boston weather this week', 'https://weather.com/boston']]);
  check('a city word alone (Boston) makes no group', [0, 1, 2, 3].every((i) => boston.name(i) === ''), [0, 1, 2, 3].map(boston.name).join());
  const trip = organized([['Boston to NYC bus tickets', 'https://www.flixbus.com/bus/boston'], ['Amtrak Northeast Regional schedule', 'https://www.amtrak.com/tickets'], ['Airbnb - Brooklyn stays', 'https://www.airbnb.com/s/Brooklyn']]);
  check('...but travel tabs of the same city still group', trip.same(0, 1) && trip.same(0, 2) && trip.name(0) === 'Travel', trip.name(0));
  const homes = organized([['Boston rent prices by neighborhood', 'https://www.rentcafe.com/boston'], ['Apartments in Boston - Zillow', 'https://www.zillow.com/boston-ma/rentals/']]);
  check('...and housing tabs of the same city still group', homes.same(0, 1), homes.name(0));
  const aws = organized([['AWS Management Console', 'https://us-east-1.console.aws.amazon.com/console/home'], ['EC2 Instances', 'https://us-east-1.console.aws.amazon.com/ec2/home'], ['CloudWatch Logs', 'https://us-east-1.console.aws.amazon.com/cloudwatch/home'],
    ['Terraform Registry - aws_s3_bucket', 'https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket'], ['Kubernetes Documentation', 'https://kubernetes.io/docs/home/'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('AWS, EC2, CloudWatch and Terraform are one Cloud & DevOps group', [1, 2, 3, 4].every((i) => aws.same(0, i)) && aws.name(0) === 'Cloud & DevOps' && !aws.same(0, 5), [0, 1, 2, 3, 4].map(aws.name).join());
}

// Round 8 rater: speed, places and brands that bridge topics, CJK names, regional concepts, and the Organize AI gate.
const oai = require('../src/features/organize-ai');
const en = require('../src/locales/en.json');
{
  // 300 realistic tabs organize in well under a second (the centroid loops used to rebuild every centroid per pair: 4-16 s).
  const pool = [['Flights to Tokyo - Google Flights', 'https://www.google.com/travel/flights'], ['Tokyo hotels - Booking.com', 'https://www.booking.com/city/jp/tokyo.html'], ['Easy Banana Bread Recipe', 'https://www.allrecipes.com/banana-bread'], ['Sourdough starter guide', 'https://www.kingarthurbaking.com/sourdough'],
    ['React useEffect docs', 'https://react.dev/reference/react/useEffect'], ['node:fs documentation', 'https://nodejs.org/api/fs.html'], ['Stack Overflow - how to debounce', 'https://stackoverflow.com/questions/1'], ['CS 3500 - Canvas', 'https://canvas.northeastern.edu/courses/1'],
    ['Gradescope HW3', 'https://www.gradescope.com/courses/1'], ['Roth IRA contribution limits - Fidelity', 'https://www.fidelity.com/roth'], ['Vanguard index funds', 'https://investor.vanguard.com/funds'], ['Best noise cancelling headphones - Wirecutter', 'https://www.nytimes.com/wirecutter/headphones'],
    ['Sony WH-1000XM5 review - RTINGS', 'https://www.rtings.com/headphones/sony'], ['Marathon training plan - Runner\'s World', 'https://www.runnersworld.com/marathon'], ['Strava - Morning run', 'https://www.strava.com/activities/1'], ['Monstera care guide', 'https://www.plantcare.example/monstera'],
    ['Pothos propagation', 'https://www.gardenersworld.example/pothos'], ['PyTorch documentation', 'https://pytorch.org/docs/stable/index.html'], ['Attention Is All You Need - arXiv', 'https://arxiv.org/abs/1706.03762'], ['Kubernetes Documentation', 'https://kubernetes.io/docs/home/'],
    ['Zillow - apartments for rent', 'https://www.zillow.com/rentals/'], ['Software engineer jobs - Indeed', 'https://www.indeed.com/jobs?q=software+engineer'], ['NBA Finals Game 3 recap - ESPN', 'https://www.espn.com/nba/recap'], ['Fed holds rates steady - Reuters', 'https://www.reuters.com/markets/fed']];
  const words = ['alpha', 'river', 'budget', 'garden', 'python', 'recipe', 'ticket', 'guide', 'review', 'news', 'match', 'course', 'notes', 'price', 'plan'];
  const specs = Array.from({ length: 300 }, (_, i) => { const [a, b] = pool[i % pool.length]; return [`${a} ${words[(i * 7) % 15]} ${words[(i * 3 + Math.floor(i / pool.length)) % 15]}`, `${b}${b.includes('?') ? '&' : '?'}n=${i}`]; });
  const w = window_(specs.map(([a, b]) => [a, b, { userRemoved: true }]));
  const t0 = Date.now();
  const made = w.g.organizeByTopic();
  const ms = Date.now() - t0;
  check('perf: 300 realistic tabs organize in under 1.5 s', made >= 5 && ms < 1500, `${ms} ms, ${made} groups`);
}
{
  // One place word must not bridge a registration office, a flat, trains and a football club.
  const de = organized([['Gewerbeanmeldung Berlin', 'https://service.berlin.de/dienstleistung/121921/'], ['Wohnung mieten Berlin - ImmoScout24', 'https://www.immobilienscout24.de/Suche/de/berlin/wohnung-mieten'], ['2-Zimmer Wohnung Prenzlauer Berg', 'https://www.immobilienscout24.de/expose/1'], ['WG-Zimmer Neukölln - WG-Gesucht', 'https://www.wg-gesucht.de/wg-zimmer-in-berlin.1.html'],
    ['Deutsche Bahn - Berlin nach München', 'https://www.bahn.de/buchung'], ['Flüge Berlin München - Skyscanner', 'https://www.skyscanner.de/fluge/ber/muc'], ['Hotel München Hauptbahnhof - Booking.com', 'https://www.booking.com/hotel/de/munchen.html'], ['Bayern München - Spielplan', 'https://fcbayern.com/de/spielplan'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('German set: the two flats and the WG room are one housing group, apart from the trains and flights', de.same(1, 2) && de.same(1, 3) && de.same(4, 5) && de.same(4, 6) && !de.same(1, 4), [1, 4].map(de.name).join());
  check('German set: Berlin registration and Bayern football are not in the trip or the housing group', !de.same(0, 4) && !de.same(0, 1) && !de.same(7, 4) && !de.same(7, 1), [0, 7].map(de.name).join());
  const india = organized([['Delhi to Goa flights - ixigo', 'https://www.ixigo.com/flights/delhi-goa'], ['Goa hotels - MakeMyTrip', 'https://www.makemytrip.com/hotels/goa'], ['Goa beaches guide - Lonely Planet', 'https://www.lonelyplanet.com/india/goa'], ['Times of India', 'https://timesofindia.indiatimes.com/'], ['Naukri - Software Engineer jobs Bangalore', 'https://www.naukri.com/software-engineer-jobs-in-bangalore'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('India set: Goa travel is not mixed with the Times of India or Naukri', india.same(0, 1) && india.same(0, 2) && !india.same(0, 3) && !india.same(0, 4), india.name(0));
  const live = organized([['RCB vs CSK live score', 'https://www.cricbuzz.com/live-cricket-scores/1'], ['Aaj Tak Live', 'https://www.aajtak.in/live-tv'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('"Live" in a site\'s own name does not link an IPL score to Aaj Tak Live', !live.same(0, 1));
  const naver = organized([['네이버 지도', 'https://map.naver.com/'], ['손흥민 경기 결과 - 네이버 스포츠', 'https://sports.naver.com/'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('a portal\'s own name (네이버) does not link its maps to its sports', !naver.same(0, 1));
  const trip = organized([['Flights to Tokyo - Kayak', 'https://www.kayak.com/flights/tokyo'], ['Tokyo hotels - Booking.com', 'https://www.booking.com/city/jp/tokyo.html'], ['Where to eat in Tokyo - Eater', 'https://www.eater.com/tokyo'], ['Tokyo Subway Ticket - Tokyo Metro', 'https://www.tokyometro.jp/en/ticket/'],
    ['Kyoto ryokan - Tripadvisor', 'https://www.tripadvisor.com/Kyoto'], ['Japan Rail Pass prices', 'https://www.japan-guide.com/e/e2361.html'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('a big one-place trip still stays whole (subway pass and restaurants included)', [1, 2, 3, 4, 5].every((i) => trip.same(0, i)) && !trip.same(0, 6), trip.name(0));
}
{
  // CJK: named from whole runs, linked by whole runs.
  const jp = organized([['Yahoo!ニュース', 'https://news.yahoo.co.jp/'], ['NHK ニュース', 'https://www3.nhk.or.jp/news/'], ['阪神タイガース 試合結果', 'https://www.hanshin.example/results'], ['京都 観光 おすすめ - じゃらん', 'https://www.jalan.net/kyoto'], ['京都 紅葉 2026 見頃', 'https://www.kyoto.example/koyo'],
    ['クックパッド - 肉じゃが', 'https://cookpad.com/recipe/1'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('Yahoo!ニュース and NHK ニュース are a group named from a whole run, never "ース"; the Tigers are not in it', jp.same(0, 1) && !jp.same(0, 2) && jp.name(0) !== 'ース' && jp.name(0).length >= 2, jp.name(0));
  check('Cookpad 肉じゃが is not pulled into the Kyoto trip', jp.same(3, 4) && !jp.same(3, 5), jp.name(5));
  const three = organized([['Yahoo!ニュース', 'https://news.yahoo.co.jp/'], ['NHK ニュース', 'https://www3.nhk.or.jp/news/'], ['阪神タイガース 試合結果', 'https://www.hanshin.example/results'], ['東京タイガース ニュース', 'https://www.tokyo.example/news']]);
  check('no CJK group is named by a bigram fragment (ース, ュー)', [0, 1, 2, 3].every((i) => !/^(ース|ュー|ニュ)$/.test(three.name(i))), [0, 1, 2, 3].map(three.name).join());
}
{
  // Regional concepts, within Finance and Sports.
  const fin = organized([['PhonePe - Transactions', 'https://www.phonepe.com/'], ['HDFC NetBanking', 'https://netbanking.hdfcbank.com/'], ['Zerodha Kite - Holdings', 'https://kite.zerodha.com/holdings'], ['Nifty 50 today - Moneycontrol', 'https://www.moneycontrol.com/nifty'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('Indian finance (PhonePe, HDFC, Zerodha, Nifty) is one Finance group', [1, 2, 3].every((i) => fin.same(0, i)) && fin.name(0) === 'Finance' && !fin.same(0, 4), fin.name(0));
  const br = organized([['Nubank - Fatura', 'https://app.nubank.com.br/fatura'], ['Itaú - Conta corrente', 'https://www.itau.com.br/conta'], ['Bradesco Internet Banking', 'https://banco.bradesco/'], ['Ibovespa hoje - InfoMoney', 'https://www.infomoney.com.br/ibovespa'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('Brazilian finance (Nubank, Itaú, Bradesco, Ibovespa) is one Finance group', [1, 2, 3].every((i) => br.same(0, i)) && br.name(0) === 'Finance' && !br.same(0, 4), br.name(0));
  const ipl = organized([['IPL 2026 Points Table', 'https://www.espncricinfo.com/ipl/points-table'], ['RCB vs CSK live score', 'https://www.cricbuzz.com/live-cricket-scores/1'], ['Virat Kohli stats', 'https://www.espncricinfo.com/player/virat-kohli'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('IPL, Cricbuzz and Kohli are one Sports group', [1, 2].every((i) => ipl.same(0, i)) && ipl.name(0) === 'Sports' && !ipl.same(0, 3), ipl.name(0));
}
// 20. Round 9: precision over recall. A group needs two real topic words, a shared concept, one site (or a CJK run); generic words ("student",
// "sales", "calendar", "post") and a place or a brand alone link nothing and name nothing; trips keep their place; the stores, taxes, monitoring and
// housing errands are concepts. The sets are trimmed from the raters' personas (a parent, an engineer, a student abroad, a candle seller, a Leeds renter).
{
  const knowledge = require('../src/features/topic-knowledge');
  const PERSONAS = {
    parent: [
      ['Summer camps near Austin - ActivityHero', 'https://www.activityhero.com/austin'], ['YMCA Camp Austin registration', 'https://www.ymca.org/camp'],
      ['AISD school calendar 2026-27', 'https://www.austinisd.org/calendar'], ['ParentSquare - Mrs Lee class update', 'https://www.parentsquare.com/feed'],
      ['PTA bake sale signup - SignUpGenius', 'https://www.signupgenius.com/go/bake'], ['Pediatrician appointment - MyChart', 'https://mychart.example.com/appt'],
      ['Kids birthday party ideas - Pinterest', 'https://www.pinterest.com/ideas/kids-party'], ['Chuck E. Cheese party packages', 'https://www.chuckecheese.com/party'],
      ['Disney World vacation planning - Disney', 'https://disneyworld.disney.go.com/plan'], ['Orlando hotels family - Booking.com', 'https://www.booking.com/city/us/orlando.html'],
      ['Flights Austin to Orlando - Google Flights', 'https://www.google.com/travel/flights'], ['Disney Genie+ tips - Mouse Hacks', 'https://www.mousehacks.com/genie'],
      ['Easy weeknight dinners kids will eat - Budget Bytes', 'https://www.budgetbytes.com/easy-dinners'], ['Chicken nuggets homemade recipe', 'https://www.allrecipes.com/chicken-nuggets'],
      ['Target - school supplies list', 'https://www.target.com/school-supplies'], ['Amazon - Lego Star Wars set', 'https://www.amazon.com/lego-star-wars'],
      ['Prodigy math - login', 'https://play.prodigygame.com/'], ['IXL - 3rd grade math', 'https://www.ixl.com/math/grade-3'],
      ['Google Calendar', 'https://calendar.google.com/calendar'], ['Zillow - Austin homes for sale', 'https://www.zillow.com/austin-tx'],
      ['529 plan - Fidelity', 'https://www.fidelity.com/529'], ['Pay water bill - Austin Utilities', 'https://www.austintexas.gov/utilities'],
    ],
    swe: [
      ['Pull requests - lumen', 'https://github.com/me/lumen/pulls'], ['Fix race in tab restore #412', 'https://github.com/me/lumen/pull/412'],
      ['Electron BrowserView API', 'https://www.electronjs.org/docs/latest/api/browser-view'], ['Stack Overflow - electron webContents destroyed', 'https://stackoverflow.com/questions/1/electron-destroyed'],
      ['Datadog - APM traces', 'https://app.datadoghq.com/apm'], ['Sentry - TypeError', 'https://sentry.io/issues/123'],
      ['AWS Console - Lambda', 'https://console.aws.amazon.com/lambda'], ['Terraform registry - aws_s3_bucket', 'https://registry.terraform.io/aws_s3_bucket'], ['Kubernetes docs - Deployments', 'https://kubernetes.io/docs/deployments'],
      ['Designing Data-Intensive Applications notes', 'https://notes.example.com/ddia'], ['Hacker News', 'https://news.ycombinator.com/'],
      ['Greenhouse - Stripe SWE application', 'https://boards.greenhouse.io/stripe'], ['Glassdoor - Stripe interviews', 'https://www.glassdoor.com/stripe'],
      ['Mechanical keyboard - Keychron Q1', 'https://www.keychron.com/q1'], ['r/MechanicalKeyboards', 'https://www.reddit.com/r/MechanicalKeyboards'],
      ['Flights SFO to Tokyo', 'https://www.google.com/travel/flights'], ['Tokyo itinerary 7 days', 'https://www.tripadvisor.com/tokyo'], ['Chase - Accounts', 'https://secure.chase.com/'],
    ],
    abroad: [
      ['University of Edinburgh - Learn', 'https://www.learn.ed.ac.uk/'], ['INFR08026 lecture 5 slides', 'https://www.learn.ed.ac.uk/infr08026'],
      ['Student visa UK - gov.uk', 'https://www.gov.uk/student-visa'], ['Student accommodation Edinburgh - Unite Students', 'https://www.unitestudents.com/edinburgh'],
      ['Flat to rent Marchmont - SpareRoom', 'https://www.spareroom.co.uk/edinburgh'], ['Council tax exemption student', 'https://www.edinburgh.gov.uk/council-tax'],
      ['Flights Edinburgh to Delhi - Skyscanner', 'https://www.skyscanner.net/edi-del'], ['Hostel Dublin - Hostelworld', 'https://www.hostelworld.com/dublin'],
      ['Things to do in Dublin - TripAdvisor', 'https://www.tripadvisor.com/Dublin'], ['Trains Edinburgh to London - LNER', 'https://www.lner.co.uk/'],
      ['Arthur Seat hike guide', 'https://www.alltrails.com/arthurs-seat'], ['Butter chicken recipe - Hebbars Kitchen', 'https://hebbarskitchen.com/butter-chicken'],
      ['Part-time jobs for students Edinburgh - Indeed', 'https://uk.indeed.com/jobs?q=student&l=edinburgh'], ['Machine learning - Andrew Ng', 'https://www.coursera.org/learn/ml'],
    ],
    smallbiz: [
      ['Square Dashboard - Sales', 'https://squareup.com/dashboard/sales'], ['Shopify admin - Orders', 'https://admin.shopify.com/orders'],
      ['Etsy Shop Manager - Listings', 'https://www.etsy.com/your/shops/me/tools/listings'], ['QuickBooks - Profit and Loss', 'https://app.qbo.intuit.com/app/reports'],
      ['IRS - Estimated taxes', 'https://www.irs.gov/estimated-taxes'], ['Texas Comptroller - Sales tax', 'https://comptroller.texas.gov/taxes/sales'],
      ['LegalZoom - LLC annual report', 'https://www.legalzoom.com/llc'], ['Candle wax supplier - CandleScience', 'https://www.candlescience.com/wax'],
      ['USPS - Click-N-Ship', 'https://cns.usps.com/'], ['Pirate Ship - label', 'https://ship.pirateship.com/'], ['Canva - Instagram post', 'https://www.canva.com/design/ig'],
      ['Instagram - Business Insights', 'https://business.instagram.com/insights'], ['Craft fair applications 2026 - Zapplication', 'https://www.zapplication.org/'],
      ['Indeed - post a job: part-time packer', 'https://employers.indeed.com/'], ['Small business loan - SBA', 'https://www.sba.gov/loans'], ['Roth IRA limits - Fidelity', 'https://www.fidelity.com/roth'],
    ],
    uk: [
      ['Trains from London to Edinburgh - Trainline', 'https://www.thetrainline.com/trains/london/edinburgh'], ['Edinburgh hotels - Booking.com', 'https://www.booking.com/city/gb/edinburgh.html'],
      ['Things to do in Edinburgh - VisitScotland', 'https://www.visitscotland.com/edinburgh'], ['Edinburgh Fringe 2026 tickets', 'https://www.edfringe.com/tickets'],
      ['Rightmove - houses to rent in Leeds', 'https://www.rightmove.co.uk/property-to-rent/leeds'], ['Zoopla - flats to rent Leeds', 'https://www.zoopla.co.uk/to-rent/leeds'],
      ['Tenancy agreement template - Citizens Advice', 'https://www.citizensadvice.org.uk/tenancy'], ['HMRC - Self Assessment', 'https://www.gov.uk/self-assessment-tax-returns'],
      ['Premier League table - BBC Sport', 'https://www.bbc.co.uk/sport/football/premier-league/table'], ['Arsenal vs Chelsea live - Sky Sports', 'https://www.skysports.com/arsenal'],
      ['Arsenal transfer news - The Athletic', 'https://theathletic.com/arsenal'], ['BBC News', 'https://www.bbc.co.uk/news'], ['Guardian - Politics', 'https://www.theguardian.com/politics'],
      ['Tesco - groceries', 'https://www.tesco.com/groceries'], ['Monzo', 'https://app.monzo.com/'],
    ],
    korea: [
      ['서울 맛집 추천 - 망고플레이트', 'https://www.mangoplate.com/seoul'], ['성수동 카페 추천', 'https://blog.naver.com/cafe1'], ['홍대 맛집 베스트', 'https://blog.naver.com/hongdae'],
      ['손흥민 경기 결과 - 네이버 스포츠', 'https://sports.naver.com/son'], ['EPL 순위', 'https://sports.naver.com/epl'], ['파이썬 기초 강의 - 인프런', 'https://www.inflearn.com/python'],
      ['제주도 항공권 - 스카이스캐너', 'https://www.skyscanner.co.kr/jeju'], ['제주도 숙소 추천 - 야놀자', 'https://www.yanolja.com/jeju'], ['제주도 3박4일 여행 코스', 'https://blog.naver.com/jeju'],
    ],
  };
  // Round 10 personas (trimmed from the raters' wedding planner, bio grad student and retiree): added to the precision sets below.
  Object.assign(PERSONAS, {
    wedding: [
      ['Wedding venues in Napa - The Knot', 'https://www.theknot.com/marketplace/napa'], ['Zola - wedding registry', 'https://www.zola.com/registry'], ['Wedding photographer packages Napa', 'https://www.weddingwire.com/napa-photographers'],
      ['Honeymoon in Amalfi Coast - Conde Nast', 'https://www.cntraveler.com/amalfi'], ['Flights to Naples - Kayak', 'https://www.kayak.com/flights/BOS-NAP'], ['Hotels in Positano - Booking.com', 'https://www.booking.com/city/it/positano.html'],
      ['Mortgage rates today - Bankrate', 'https://www.bankrate.com/mortgages/rates'], ['Zillow - homes for sale Somerville MA', 'https://www.zillow.com/somerville-ma'], ['Redfin - Medford MA listings', 'https://www.redfin.com/city/medford'], ['First-time homebuyer programs Massachusetts', 'https://www.mass.gov/homebuyer'],
      ['Pull request #482 - acme/api', 'https://github.com/acme/api/pull/482'], ['Pull request #490 - acme/api', 'https://github.com/acme/api/pull/490'], ['Issues - acme/api', 'https://github.com/acme/api/issues'],
      ['Datadog - API latency dashboard', 'https://app.datadoghq.com/dashboard/abc'], ['PagerDuty - incidents', 'https://acme.pagerduty.com/incidents'], ['Gmail', 'https://mail.google.com/mail/u/0'], ['NYT - The Daily', 'https://www.nytimes.com/the-daily'],
    ],
    biograd: [
      ['PubMed - CRISPR off-target effects', 'https://pubmed.ncbi.nlm.nih.gov/12345/'], ['bioRxiv - prime editing efficiency', 'https://www.biorxiv.org/content/10.1101/2026.01'], ['Addgene - pX330 plasmid', 'https://www.addgene.org/42230/'],
      ['Benchling - gRNA design', 'https://benchling.com/crispr'], ['NEB - Gibson assembly protocol', 'https://www.neb.com/protocols/gibson'], ['Thermo Fisher - Lipofectamine 3000', 'https://www.thermofisher.com/lipofectamine'],
      ['R ggplot2 volcano plot tutorial', 'https://r-graph-gallery.com/volcano'], ['DESeq2 vignette - Bioconductor', 'https://bioconductor.org/packages/DESeq2'], ['RStudio Posit Cloud', 'https://posit.cloud/'],
      ['Boston to Seattle flights - Google Flights', 'https://www.google.com/travel/flights?q=BOS+SEA'], ['Seattle Airbnb - Capitol Hill', 'https://www.airbnb.com/s/Seattle'],
      ['ASGCT 2026 annual meeting - Seattle', 'https://www.asgct.org/annual-meeting'], ['Abstract submission - ASGCT', 'https://www.asgct.org/abstracts'], ['Netflix', 'https://www.netflix.com/browse'],
    ],
    retiree: [
      ['Birding in Costa Rica - Audubon', 'https://www.audubon.org/costarica'], ['eBird - Hotspots near me', 'https://ebird.org/hotspots'], ['Merlin Bird ID', 'https://merlin.allaboutbirds.org/'],
      ['Best binoculars for birding 2026 - Wirecutter', 'https://www.nytimes.com/wirecutter/binoculars'], ['Vortex Diamondback HD 8x42 - B&H', 'https://www.bhphotovideo.com/vortex'],
      ['Medicare Part D plans 2027', 'https://www.medicare.gov/plan-compare'], ['AARP - Medicare guide', 'https://www.aarp.org/medicare'], ['Social Security - my account', 'https://www.ssa.gov/myaccount'],
      ['Fidelity - Required minimum distributions', 'https://www.fidelity.com/rmd'], ['Vanguard - Retirement dashboard', 'https://investor.vanguard.com/'],
      ['Tomato blight treatment - Extension', 'https://extension.umn.edu/tomato'], ['Raised bed garden soil mix', 'https://www.gardeners.com/soil'], ['Burpee - heirloom seeds', 'https://www.burpee.com/seeds'],
      ['Crossword - NYT', 'https://www.nytimes.com/crosswords'], ['Wordle', 'https://www.nytimes.com/games/wordle'], ['Spelling Bee - NYT', 'https://www.nytimes.com/puzzles/spelling-bee'],
      ['Amtrak - Boston to Washington', 'https://www.amtrak.com/tickets'], ['Hilton Garden Inn Washington DC', 'https://www.hilton.com/dc'], ['Smithsonian - Natural History Museum hours', 'https://naturalhistory.si.edu/visit'], ['Cherry blossom bloom forecast DC', 'https://www.nps.gov/cherry-blossom'],
      ['Weather.com - 10 day', 'https://weather.com/forecast'], ['Gmail', 'https://mail.google.com/mail/u/0'],
    ],
  });
  // Round 11 personas (trimmed from the raters' freelance designer, high-school teacher and retired trucker): added to the precision sets too.
  Object.assign(PERSONAS, {
    designer: [
      ['Dribbble - logo design inspiration', 'https://dribbble.com/search/logo'], ['Behance - branding projects', 'https://www.behance.net/search/projects/branding'],
      ['Figma - Client Acme brand kit', 'https://www.figma.com/file/a1'], ['Figma - Bakery website mockup', 'https://www.figma.com/file/b2'],
      ['Adobe Fonts - Browse', 'https://fonts.adobe.com/fonts'], ['Google Fonts - Playfair Display', 'https://fonts.google.com/specimen/Playfair+Display'],
      ['Coolors - color palette generator', 'https://coolors.co/'], ['Pantone color of the year', 'https://www.pantone.com/color-of-the-year'],
      ['Invoice template - FreshBooks', 'https://www.freshbooks.com/invoice-template'], ['Toggl Track - timer', 'https://track.toggl.com/timer'],
      ['Upwork - messages', 'https://www.upwork.com/messages'], ['Quarterly taxes for freelancers - IRS', 'https://www.irs.gov/businesses/small-businesses-self-employed/estimated-taxes'],
      ['Canva - Instagram post', 'https://www.canva.com/design/x'], ['Reddit - r/graphic_design', 'https://www.reddit.com/r/graphic_design'],
      ['Wacom Intuos Pro review', 'https://www.theverge.com/wacom-review'], ['Wacom Intuos Pro - Best Buy', 'https://www.bestbuy.com/wacom-intuos'],
      ['Sourdough bread recipe - King Arthur', 'https://www.kingarthurbaking.com/recipes/sourdough'], ['Easy weeknight pasta - NYT Cooking', 'https://cooking.nytimes.com/pasta'],
      ['Gmail', 'https://mail.google.com/mail/u/0'], ['Google Calendar', 'https://calendar.google.com/'], ['Untitled', 'about:blank'],
    ],
    teacher: [
      ['Canvas - Gradebook Period 3', 'https://school.instructure.com/courses/1/gradebook'], ['Canvas - Assignments', 'https://school.instructure.com/courses/1/assignments'],
      ['Google Classroom - AP Lit', 'https://classroom.google.com/c/abc'], ['Google Classroom - English 10', 'https://classroom.google.com/c/def'],
      ['Lesson plan: Macbeth Act 3 - ReadWriteThink', 'https://www.readwritethink.org/macbeth'], ['Macbeth full text - Folger', 'https://www.folger.edu/macbeth'],
      ['SparkNotes - Macbeth Act 3 summary', 'https://www.sparknotes.com/shakespeare/macbeth/section6'], ['Macbeth film 2015 - IMDb', 'https://www.imdb.com/title/tt2884018'],
      ['Turnitin - Submissions', 'https://www.turnitin.com/t_inbox.asp'], ['Quizlet - Literary devices', 'https://quizlet.com/literary-devices'],
      ['Kahoot - create quiz', 'https://create.kahoot.it/'], ['Teachers Pay Teachers - poetry unit', 'https://www.teacherspayteachers.com/poetry'],
      ['Massachusetts curriculum framework ELA - DESE', 'https://www.doe.mass.edu/frameworks/ela'], ['Payroll - ADP', 'https://my.adp.com/'],
      ['Soccer coach - team schedule', 'https://www.teamsnap.com/teams/123'], ['Girls soccer scores - MaxPreps', 'https://www.maxpreps.com/ma/soccer'],
      ['Summer vacation: Acadia National Park', 'https://www.nps.gov/acad/planyourvisit'], ['Acadia camping reservations - recreation.gov', 'https://www.recreation.gov/camping/acadia'],
      ['Hiking trails Mount Desert Island - AllTrails', 'https://www.alltrails.com/acadia'], ['Cabin rentals Bar Harbor - Vrbo', 'https://www.vrbo.com/bar-harbor'],
      ['Linkedin Learning - Excel', 'https://www.linkedin.com/learning/excel'], ['Facebook', 'https://www.facebook.com/'], ['Netflix', 'https://www.netflix.com/browse'],
    ],
    trucker: [
      ['Weigh station status - DriveWyze', 'https://www.drivewyze.com/map'], ['Truck stops near me - Pilot Flying J', 'https://pilotflyingj.com/locations'],
      ['Loves Travel Stops - Fuel prices', 'https://www.loves.com/fuel'], ['Trucker Path - parking', 'https://truckerpath.com/parking'],
      ['FMCSA - hours of service rules', 'https://www.fmcsa.dot.gov/regulations/hours-of-service'], ['DAT load board', 'https://one.dat.com/loads'],
      ['I-80 road conditions Wyoming - WYDOT', 'https://www.wyoroad.info/'], ['Wyoming weather forecast - NWS', 'https://forecast.weather.gov/wy'],
      ['Diesel prices - GasBuddy', 'https://www.gasbuddy.com/diesel'], ['CDL renewal - DMV', 'https://www.dmv.ca.gov/cdl-renewal'],
      ['DOT medical card exam near Cheyenne', 'https://www.yelp.com/search?find=dot+physical'], ['Medicare Advantage plans 2027', 'https://www.medicare.gov/plan-compare'],
      ['Social Security - my account', 'https://www.ssa.gov/myaccount'], ['Holland America - Alaska cruise 2027', 'https://www.hollandamerica.com/alaska'],
      ['Princess Cruises - Alaska Inside Passage', 'https://www.princess.com/alaska'], ['Cruise Critic - Alaska cruise reviews', 'https://www.cruisecritic.com/alaska'],
      ['Flights to Seattle - Southwest', 'https://www.southwest.com/air/booking'], ['Hotels near Seattle cruise terminal - Hilton', 'https://www.hilton.com/seattle'],
      ['Cowboys vs Eagles - ESPN', 'https://www.espn.com/nfl/game/1'], ['NFL standings', 'https://www.espn.com/nfl/standings'],
      ['Facebook - Marketplace', 'https://www.facebook.com/marketplace'], ['Facebook', 'https://www.facebook.com/'], ['Walmart pharmacy - refill', 'https://www.walmart.com/pharmacy'],
      ['Weather Cheyenne WY', 'https://weather.com/cheyenne'], ['Costco - tires', 'https://www.costco.com/tires'],
    ],
  });
  // "r9" helper: tabs are found by a word of their title; `loose` is a tab in no group.
  const setOf = (key) => {
    const specs = PERSONAS[key];
    const o = organized(specs);
    const ix = (re) => { const i = specs.findIndex(([t]) => re.test(t)); if (i < 0) throw new Error(`no tab ${re}`); return i; };
    return { ...o, specs, ix, together: (a, b) => o.same(ix(a), ix(b)), nameOf: (re) => o.name(ix(re)), loose: (re) => !o.name(ix(re)) };
  };
  const parent = setOf('parent');
  check('r9: "529 plan - Fidelity" does not join Disney (a finance tab on "plan")', !parent.together(/529/, /Disney World/) && !/disney|orlando/i.test(parent.nameOf(/529/)), parent.nameOf(/529/));
  check('r9: Disney World planning, the Orlando hotels and the flight are one trip, without the 529 plan', parent.together(/Disney World/, /Orlando hotels/) && parent.together(/Disney World/, /Flights Austin/) && parent.nameOf(/Disney World/) === 'Orlando', parent.nameOf(/Disney World/));
  check('r9: the school calendar and Google Calendar are not a group called "Calendar"', !/^calendar$/i.test(parent.nameOf(/AISD/)) && !/^calendar$/i.test(parent.nameOf(/Google Calendar/)), parent.nameOf(/AISD/));
  check('r9: "bake sale" is a fundraiser, not Recipes', !/recipe/i.test(parent.nameOf(/bake sale/)), parent.nameOf(/bake sale/));
  check('r9: two camp pages and two party pages still group', parent.together(/Summer camps/, /YMCA/) && parent.together(/birthday party/, /Chuck E/), `${parent.nameOf(/Summer camps/)}|${parent.nameOf(/birthday/)}`);
  const swe = setOf('swe');
  check('r9: Datadog and Sentry are one Observability group (two monitoring tools)', swe.together(/Datadog/, /Sentry/) && swe.nameOf(/Datadog/) === 'Observability', swe.nameOf(/Datadog/));
  check('r9: "Applications" (a book, a job application) is not a group', !swe.together(/Designing Data/, /Greenhouse/) && !/application/i.test(swe.nameOf(/Greenhouse/)), swe.nameOf(/Greenhouse/));
  check('r9: Chase beside Tokyo flights and Kubernetes stays loose', swe.loose(/Chase/));
  const abroad = setOf('abroad');
  check('r9: no "Student" lump: the visa, the accommodation, council tax and part-time jobs are not linked by "student"', !abroad.together(/Student visa/, /accommodation/) && !abroad.together(/accommodation/, /Council tax/) && !abroad.together(/Council tax/, /Part-time/) && !abroad.together(/Student visa/, /Part-time/), ['Student visa', 'accommodation', 'Council', 'Part-time'].map((w) => abroad.nameOf(new RegExp(w))).join('|'));
  check('r9: no group is called "Student"', ![/Student visa/, /accommodation/, /Council tax/, /Part-time/].some((re) => /student/i.test(abroad.nameOf(re))));
  check('r9: the Dublin hostel and the Dublin sights are one trip named Dublin, not pulled into a visa group', abroad.together(/Hostel Dublin/, /Things to do in Dublin/) && abroad.nameOf(/Hostel Dublin/) === 'Dublin' && !abroad.together(/Hostel Dublin/, /Student visa/), abroad.nameOf(/Hostel Dublin/));
  check('r9: the Delhi flight and the London trains of an Edinburgh stay are one trip named Edinburgh', abroad.together(/Delhi/, /Trains Edinburgh/) && abroad.nameOf(/Delhi/) === 'Edinburgh', abroad.nameOf(/Delhi/));
  check('r9: student accommodation and a flat to rent are Housing', abroad.together(/accommodation/, /Flat to rent/) && /housing/i.test(abroad.nameOf(/Flat to rent/)), abroad.nameOf(/Flat to rent/));
  const uk = setOf('uk');
  check('r9: Edinburgh trains, hotels, things to do and Fringe tickets are one trip named Edinburgh', [/Edinburgh hotels/, /Things to do/, /Fringe/].every((re) => uk.together(/Trains from London/, re)) && uk.nameOf(/Fringe/) === 'Edinburgh', uk.nameOf(/Fringe/));
  check('r9: the Premier League table goes with Arsenal in Sports, not News & social', uk.together(/Premier League table/, /Arsenal vs Chelsea/) && uk.together(/Premier League table/, /Arsenal transfer/) && uk.nameOf(/Premier League table/) === 'Sports', uk.nameOf(/Premier League table/));
  check('r9: Rightmove, Zoopla and the tenancy agreement are Housing', uk.together(/Rightmove/, /Zoopla/) && uk.together(/Rightmove/, /Tenancy/) && uk.nameOf(/Rightmove/) === 'Housing', uk.nameOf(/Rightmove/));
  const biz = setOf('smallbiz');
  check('r9: Square and the Texas Comptroller are not a "Sales" group', !biz.together(/Square/, /Comptroller/) && !/sales/i.test(biz.nameOf(/Square/)) && !/sales/i.test(biz.nameOf(/Comptroller/)), `${biz.nameOf(/Square/)}|${biz.nameOf(/Comptroller/)}`);
  check('r9: Square, Shopify, Etsy seller, USPS and Pirate Ship are the Store', [/Shopify/, /Etsy/, /USPS/, /Pirate/].every((re) => biz.together(/Square/, re)) && biz.nameOf(/Square/) === 'Store', biz.nameOf(/Square/));
  check('r9: the IRS, the comptroller and LegalZoom are Taxes & legal, and the Roth IRA and the 529-style money tabs are not', [/Comptroller/, /LegalZoom/].every((re) => biz.together(/IRS/, re)) && biz.nameOf(/IRS/) === 'Taxes & legal' && !biz.together(/IRS/, /Roth IRA/), biz.nameOf(/IRS/));
  check('r9: "Post" and "Business" are not group names ("post a job" is not "Instagram post")', !biz.together(/Instagram post/, /post a job/) && !biz.together(/Business Insights/, /Small business loan/), `${biz.nameOf(/Instagram post/)}|${biz.nameOf(/Business Insights/)}`);
  const kr = setOf('korea');
  check('r9: Korean football (손흥민, EPL) is Sports', kr.together(/손흥민/, /EPL/) && kr.nameOf(/EPL/) === 'Sports', kr.nameOf(/EPL/));
  check('r9: the Korean cafe and restaurant tabs are one group', kr.together(/성수동 카페/, /서울 맛집/) && kr.together(/서울 맛집/, /홍대 맛집/), kr.nameOf(/카페/));
  check('r9: the Jeju trip stays whole', kr.together(/항공권/, /숙소/) && kr.together(/항공권/, /3박4일/), kr.nameOf(/항공권/));
  // Generic words, a place and a brand never link two tabs on their own.
  const lone = organized([['Student discounts - UNiDAYS', 'https://www.myunidays.com/'], ['Student loans explained', 'https://studentaid.gov/loans'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r9: two tabs that share only "student" stay loose', !lone.same(0, 1), `${lone.name(0)}|${lone.name(1)}`);
  const sales = organized([['Sales dashboard - Looker', 'https://looker.example.com/sales'], ['Sales tax rates by state', 'https://www.salestaxinstitute.com/rates'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r9: two tabs that share only "sales" stay loose', !sales.same(0, 1), `${sales.name(0)}|${sales.name(1)}`);
  const place = organized([['Weather Austin', 'https://weather.com/austin'], ['Austin farmers market vendor form', 'https://www.sfcmarket.com/vendor'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r9: two tabs that share only a place stay loose', !place.same(0, 1), `${place.name(0)}|${place.name(1)}`);
  check('r9: the generic list says student, jobs-adjacent and sales words', ['student', 'sales', 'calendar', 'post', 'business', 'applications', 'plan', 'dashboard', 'table', 'guide', 'tips', 'near', 'buy', 'schedule'].every((w) => new RegExp(`\\b${w}\\b`).test(`${knowledge.GENERIC_WORDS} ${knowledge.WEAK_WORDS} guide tips near buy schedule`)));
  // "train" is a travel word only beside a place: "train a model" is machine learning.
  const train = organized([['How to train a neural network from scratch', 'https://blog.example.com/train'], ['Train times Boston to New York - Amtrak', 'https://www.amtrak.com/schedule'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r9: "train a model" and a train timetable are not one topic', !train.same(0, 1));
  const trip = organized([['Trains Edinburgh to London - LNER', 'https://www.lner.co.uk/'], ['Edinburgh hotels', 'https://www.booking.com/city/gb/edinburgh.html'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r9: trains beside a shared place link (Edinburgh trains and hotels)', trip.same(0, 1) && trip.name(0) === 'Edinburgh', trip.name(0));
  // A group's name is a topic word most of its tabs carry, a concept or a place; never a generic word.
  const names = Object.values(PERSONAS).flatMap((specs) => { const w = window_(specs.map(([a, b]) => [a, b, { userRemoved: true }])); w.g.organizeByTopic(); return w.g.state().map((g) => g.name); });
  const genericName = /^(post|calendar|business|applications?|student|students|sales|plan|table|guide|tips?|near|buy|schedule|jobs?|dashboard|orders?|tickets?|template|form|report)$/i;
  check('r9: no group in any persona is named with a generic word', !names.some((n) => genericName.test(n)), names.filter((n) => genericName.test(n)).join());
  // Precision: tabs placed in a group where most of the other members share no concept, topic word, site or hint with them.
  const docsOf = (specs) => tg._vectorize(specs.map(([title, url], id) => ({ id, title, url })));
  const generic = new Set(`${knowledge.GENERIC_WORDS} ${knowledge.WEAK_WORDS}`.split(/\s+/).filter(Boolean).map((w) => tg.tokens(w)[0]?.key || w));
  const shares = (a, b) => {
    if (a.site && a.site === b.site) return true;
    if (a.siteHint && a.siteHint === b.siteHint && !knowledge.BROAD_HINTS.has(a.siteHint)) return true;
    for (const [k, v] of a.words) {
      if (!b.words.has(k)) continue;
      if (k[0] === '%') { if (k !== '%shopping') return true; continue; }
      if (v.weight >= 0.7 && b.words.get(k).weight >= 0.7 && /^[\p{L}\p{N}]/u.test(k) && !generic.has(k)) return true;
    }
    return (a.words.has('%tax') && b.words.has('%finance')) || (a.words.has('%finance') && b.words.has('%tax'));
  };
  const categoryNames = new Set(knowledge.FALLBACK_CATEGORIES.map((c) => c.name)); // "Video & music", "News & social" ... are kinds of site: their tabs share the kind
  let placed = 0;
  let strangers = 0;
  const odd = [];
  for (const specs of Object.values(PERSONAS)) {
    const w = window_(specs.map(([a, b]) => [a, b, { userRemoved: true }]));
    w.g.organizeByTopic();
    const docs = docsOf(specs);
    const by = new Map();
    w.tabs().forEach((t) => { if (t.groupId) by.set(t.groupId, [...(by.get(t.groupId) || []), t.id - 1]); }); // strip order is not the order given: tabs by id
    const names = new Map(w.g.state().map((g) => [g.id, g.name]));
    for (const [gid, members] of by) {
      for (const i of members) {
        placed++;
        if (categoryNames.has(names.get(gid))) continue;
        const others = members.filter((j) => j !== i);
        if (others.filter((j) => !shares(docs[i], docs[j])).length * 2 > others.length) { strangers++; odd.push(`${names.get(gid)}: ${specs[i][0]}`); }
      }
    }
  }
  check(`r9: precision: tabs in a group that most of it shares nothing with (${strangers} of ${placed}) are at most 2`, strangers <= 2, odd.join(' ; '));

  // ---- Round 10 ----
  const wed = setOf('wedding');
  check('r10: Honeymoon in Amalfi Coast, Flights to Naples and Hotels in Positano are one trip named Amalfi Coast', wed.together(/Honeymoon/, /Naples/) && wed.together(/Honeymoon/, /Positano/) && wed.nameOf(/Honeymoon/) === 'Amalfi Coast', wed.nameOf(/Honeymoon/));
  check('r10: mortgage rates and the first-time homebuyer page join Zillow and Redfin in Housing', wed.together(/Mortgage/, /Zillow/) && wed.together(/homebuyer/, /Redfin/) && wed.nameOf(/Zillow/) === 'Housing', wed.nameOf(/homebuyer/));
  check('r10: the repo group is not named "Api", and the Datadog dashboard is not in it (Observability with PagerDuty)', !/^api$/i.test(wed.nameOf(/Pull request #482/)) && !wed.together(/Datadog/, /Pull request #482/) && wed.together(/Datadog/, /PagerDuty/) && wed.nameOf(/Datadog/) === 'Observability', `${wed.nameOf(/Pull request #482/)}|${wed.nameOf(/Datadog/)}`);
  const bio = setOf('biograd');
  check('r10: Addgene, Benchling, NEB, Lipofectamine, ggplot2, DESeq2, RStudio and PubMed are one lab group', [/bioRxiv/, /Addgene/, /Benchling/, /NEB/, /Lipofectamine/, /ggplot2/, /DESeq2/, /RStudio/].every((re) => bio.together(/PubMed/, re)) && /lab|research/i.test(bio.nameOf(/PubMed/)), bio.nameOf(/PubMed/));
  check('r10: two ASGCT tabs are a group (a shared acronym)', bio.together(/ASGCT 2026/, /Abstract submission/) && /asgct/i.test(bio.nameOf(/Abstract submission/)), bio.nameOf(/Abstract submission/));
  check('r10: "Capitol Hill" is not a topic: the Seattle flights and the Airbnb are a Seattle trip', bio.together(/Boston to Seattle/, /Seattle Airbnb/) && /seattle/i.test(bio.nameOf(/Seattle Airbnb/)), bio.nameOf(/Seattle Airbnb/));
  const ret = setOf('retiree');
  check('r10: eBird, Audubon, Merlin, binoculars (and a Vortex 8x42) are Birding', [/eBird/, /Merlin/, /binoculars/, /Vortex/].every((re) => ret.together(/Audubon/, re)) && ret.nameOf(/Audubon/) === 'Birding', ret.nameOf(/Audubon/));
  check('r10: crossword, Wordle and Spelling Bee are Games, not News & social', [/Wordle/, /Spelling Bee/].every((re) => ret.together(/Crossword/, re)) && ret.nameOf(/Crossword/) === 'Games', ret.nameOf(/Crossword/));
  check('r10: Hilton Garden Inn is travel, not Garden: with Amtrak, the Smithsonian and the cherry blossoms it is a Washington trip', [/Hilton/, /Smithsonian/, /Cherry/].every((re) => ret.together(/Amtrak/, re)) && ret.nameOf(/Hilton/) === 'Washington' && !ret.together(/Hilton/, /Raised bed/), ret.nameOf(/Hilton/));
  check('r10: an extension service page is gardening, a museum and a park are travel: none of them is School or Government', !/school|government/i.test(ret.nameOf(/Tomato/)) && !/school|government/i.test(ret.nameOf(/Smithsonian/)) && ret.together(/Tomato/, /Raised bed/) && ret.together(/Raised bed/, /Burpee/) && /plants|garden/i.test(ret.nameOf(/Tomato/)), `${ret.nameOf(/Tomato/)}|${ret.nameOf(/Smithsonian/)}`);
  check('r10: Medicare Part D and the AARP Medicare guide share a name: a group', ret.together(/Medicare Part D/, /AARP/), ret.nameOf(/AARP/));
  check('r10: Social Security, Fidelity RMD and Vanguard retirement are Finance', [/Fidelity/, /Vanguard/].every((re) => ret.together(/Social Security/, re)) && ret.nameOf(/Fidelity/) === 'Finance', ret.nameOf(/Fidelity/));
  // Brand phrases: masked words are no topic words
  const brands = organized([['Hilton Garden Inn Boston', 'https://www.hilton.com/boston'], ['Olive Garden menu', 'https://www.olivegarden.com/menu'], ['Raised bed garden soil mix', 'https://www.gardeners.com/soil'], ['Home Depot - Paint colors', 'https://www.example.org/paint'], ['Best Buy - Laptop deals', 'https://www.example.org/laptops'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r10: Hilton Garden Inn and Olive Garden are not gardening; Home Depot and Best Buy share no word', !brands.same(0, 2) && !brands.same(1, 2) && !brands.same(0, 1) && !brands.same(3, 4), [0, 1, 2, 3, 4].map(brands.name).join('|'));
  const hotels = organized([['Marriott Bonvoy - Denver', 'https://www.marriott.com/denver'], ['Hyatt Regency Denver', 'https://www.hyatt.com/denver'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r10: two hotel chains are travel', hotels.same(0, 1) && !hotels.same(0, 2), hotels.name(0));
  // Host-only matches
  const hostOnly = organized([['Admissions - State University', 'https://www.stateu.edu/admissions'], ['Library hours', 'https://www.otheru.edu/library'], ['Weather advisory', 'https://www.weather.gov/box'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r10: two .edu tabs and a .gov tab, sharing nothing else, are loose', !hostOnly.same(0, 1) && !hostOnly.name(0) && !hostOnly.name(2), hostOnly.name(0));
  const edu = organized([['Linear algebra notes', 'https://www.stateu.edu/la'], ['Calculus homework 4', 'https://www.otheru.edu/calc'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r10: .edu tabs whose titles say school work (linear algebra, homework) are School', edu.same(0, 1) && edu.name(0) === 'School', edu.name(0));
  // No group escapes the cohesion check (kinds of site excepted: mail, dev docs, video, news, shops)
  {
    const kinds = new Set(knowledge.FALLBACK_CATEGORIES.filter((c) => c.kind).map((c) => c.name));
    const escaped = [];
    for (const [key, specs] of Object.entries(PERSONAS)) {
      const w = window_(specs.map(([a, b]) => [a, b, { userRemoved: true }]));
      w.g.organizeByTopic();
      const docs = docsOf(specs);
      const names = new Map(w.g.state().map((g) => [g.id, g.name]));
      const by = new Map();
      w.tabs().forEach((t) => { if (t.groupId) by.set(t.groupId, [...(by.get(t.groupId) || []), t.id - 1]); });
      for (const [id, members] of by) {
        if (kinds.has(names.get(id))) continue;
        const parts = tg._cohere(members, docs);
        if (!(parts.length === 1 && parts[0].length === members.length)) escaped.push(`${key}/${names.get(id)}`);
      }
    }
    check('r10: no group in any persona escapes the cohesion check (cohere keeps it whole)', escaped.length === 0, escaped.join(' ; '));
  }
  // ---- Round 11 ----
  const des = setOf('designer');
  check('r11: Dribbble, Behance, Figma, Canva, Adobe Fonts and r/graphic_design are one Design group (a concept, not a lone word)', [/Behance/, /Figma - Client/, /Canva/, /Adobe Fonts/, /Google Fonts/, /graphic_design/].every((re) => des.together(/Dribbble/, re)) && des.nameOf(/Dribbble/) === 'Design', des.nameOf(/Dribbble/));
  check('r11: no group is called "Branding" or "Color" (a lone word)', !des.specs.some(([t]) => /^(branding|color)$/i.test(des.nameOf(new RegExp(t.replace(/[^\w ]/g, '.'))))), des.nameOf(/Behance/));
  check('r11: freelance tools (invoice, timer, Upwork, taxes for freelancers) are one Freelance group', [/Toggl/, /Upwork/, /Quarterly taxes/].every((re) => des.together(/Invoice/, re)), des.nameOf(/Invoice/));
  const tea = setOf('teacher');
  check('r11: Turnitin, Kahoot, Teachers Pay Teachers and a state DESE curriculum page join the Canvas and Classroom School group', [/Turnitin/, /Kahoot/, /Teachers Pay/, /curriculum framework/, /Quizlet/, /Classroom - AP/].every((re) => tea.together(/Canvas - Gradebook/, re)) && tea.nameOf(/Canvas - Gradebook/) === 'School', tea.nameOf(/curriculum framework/));
  check('r11: the Acadia pages, AllTrails (Mount Desert Island) and Vrbo (Bar Harbor) are one Acadia trip', [/Acadia camping/, /Hiking trails/, /Cabin rentals/].every((re) => tea.together(/Summer vacation/, re)) && tea.nameOf(/Summer vacation/) === 'Acadia', tea.nameOf(/Hiking trails/));
  check('r11: "LinkedIn Learning - Excel" is not filed as News & social', !/news/i.test(tea.nameOf(/Linkedin Learning/)) && !tea.together(/Linkedin Learning/, /Facebook/), tea.nameOf(/Linkedin Learning/));
  const truck = setOf('trucker');
  check('r11: truck stops, weigh stations, Trucker Path, FMCSA, DAT, I-80, diesel, CDL and a DOT medical exam are one Trucking group', [/Truck stops/, /Loves/, /Trucker Path/, /FMCSA/, /DAT load/, /I-80/, /Diesel/, /CDL/, /DOT medical/].every((re) => truck.together(/Weigh station/, re)) && truck.nameOf(/Weigh station/) === 'Trucking', truck.nameOf(/Weigh station/));
  check('r11: a place alone is no group: "DOT medical card exam near Cheyenne" and "Weather Cheyenne WY" are not one', !truck.together(/DOT medical/, /Weather Cheyenne/) && !/cheyenne/i.test(truck.nameOf(/Weather Cheyenne/)), truck.nameOf(/Weather Cheyenne/));
  check('r11: Facebook Marketplace is Shopping, not News & social', truck.nameOf(/Marketplace/) === 'Shopping' && truck.together(/Marketplace/, /Costco/), truck.nameOf(/Marketplace/));
  check('r11: an agency host alone is no Government group: "CDL renewal - DMV" and "Social Security" stay apart', !truck.together(/CDL renewal/, /Social Security/) && !/government/i.test(truck.nameOf(/Social Security/)), truck.nameOf(/Social Security/));
  // Two tabs that share a service word (renewal) are a Government group
  const gov = organized([['Driver license renewal - California DMV', 'https://www.dmv.ca.gov/portal/'], ['Vehicle registration renewal - Texas DMV', 'https://www.txdmv.gov/renew'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r11: two agency tabs that share a service word (DMV renewal) are Government', gov.same(0, 1) && gov.name(0) === 'Government', gov.name(0));
  // cohereAll: a group whose only shared tokens are place keys is rejected
  {
    const specs = [['Weather Cheyenne WY', 'https://weather.com/cheyenne'], ['DOT medical card exam near Cheyenne', 'https://www.yelp.com/search?find=dot+physical'], ['Hours Laramie Library', 'https://www.laramielibrary.org/hours'], ['Laramie farmers market', 'https://www.example.org/market']];
    const docs = docsOf(specs);
    check('r11: cohere rejects a group whose only shared tokens are place keys (Cheyenne, Laramie)', tg._cohere([0, 1], docs).length === 2 && tg._cohere([2, 3], docs).length === 2, JSON.stringify([tg._cohere([0, 1], docs), tg._cohere([2, 3], docs)]));
    const placeOnly = organized([['Weather Cheyenne WY', 'https://weather.com/cheyenne'], ['Cheyenne dentist appointment', 'https://www.example.org/dentist'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
    check('r11: a city key links tabs only beside a shared topic word or concept', !placeOnly.same(0, 1), `${placeOnly.name(0)}|${placeOnly.name(1)}`);
  }
  // Thin pairs: one generic word ("brand", "design") makes no two-tab group; two shared words, a concept or a site do
  const thin = organized([['Behance - branding projects', 'https://www.example.net/a'], ['Acme brand kit - Notion', 'https://www.notion.so/brand'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r11: two tabs sharing only "brand" are no group', !thin.same(0, 1), `${thin.name(0)}|${thin.name(1)}`);
  const generic1 = organized([['Garden design ideas', 'https://www.example.net/a'], ['Kitchen design software', 'https://www.example.org/b'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r11: two tabs sharing only "design" are no group', !generic1.same(0, 1), `${generic1.name(0)}|${generic1.name(1)}`);
  check('r11: Dribbble and r/graphic_design are Design on concept evidence', des.together(/Dribbble/, /graphic_design/) && des.nameOf(/graphic_design/) === 'Design');
  // Learning sites
  const learn = organized([['Excel for beginners - LinkedIn Learning', 'https://www.linkedin.com/learning/excel'], ['Python basics - Udemy', 'https://www.udemy.com/course/python'], ['Intro to statistics - Khan Academy', 'https://www.khanacademy.org/math/statistics'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara']]);
  check('r11: LinkedIn Learning, Udemy and Khan Academy are one Learning group', learn.same(0, 1) && learn.same(0, 2) && learn.name(0) === 'Learning', learn.name(0));
  // Hosts
  check('r11: state education hosts (doe.mass.edu, dese.mo.gov, a k12 district) are School; doe.gov is not', ['https://www.doe.mass.edu/x', 'https://dese.mo.gov/x', 'https://springfield.k12.ma.us/x'].every((u) => tg.siteHint(u) === 'School') && tg.siteHint('https://www.doe.gov/x') !== 'School');
}

{
  // The note reads "1 group", not "1 groups"; every key exists.
  const keys = [[1, 0], [3, 0], [1, 1], [1, 4], [3, 1], [3, 4]].map(([g, l]) => oai.summaryKey(g, l));
  check('summary strings: every singular and plural key exists in en.json', keys.every((k) => typeof en[k] === 'string'), keys.filter((k) => typeof en[k] !== 'string').join());
  const say = (g, l) => en[oai.summaryKey(g, l)].replace('{groups}', g).replace('{loose}', l);
  check('summary strings read "1 group." and "1 group, 1 tab left loose." and "3 groups, 4 tabs left loose."', say(1, 0) === '1 group.' && say(1, 1) === '1 group, 1 tab left loose.' && say(3, 4) === '3 groups, 4 tabs left loose.' && say(3, 1) === '3 groups, 1 tab left loose.' && say(2, 0) === '2 groups.', `${say(1, 0)} / ${say(1, 1)}`);
}
let asked = 0;
// Round 12: one rule for every link - a single shared word is never enough. The round-12 persona sets (a night-shift nurse, a college athlete, an indie game
// developer) are the fixtures: [title, url, what the tab is about (acceptable labels, '|' apart)]. A tab is misgrouped when its group's topic (the label most of
// its tabs carry) is none of its own.
{
  const R12 = {
    nurse: [
      ['NCLEX-RN practice questions - UWorld', 'https://nursing.uworld.com/qbank', 'work'],
      ['Pharmacology cheat sheet: beta blockers - Nurseslabs', 'https://nurseslabs.com/beta-blockers', 'work'],
      ['ACLS algorithms 2026 - AHA', 'https://cpr.heart.org/acls', 'work'],
      ['Sepsis bundle nursing interventions', 'https://www.nursingcenter.com/sepsis', 'work'],
      ['Night shift nurse sleep tips - Healthline', 'https://www.healthline.com/night-shift-sleep', 'work|sleep'],
      ['Blackout curtains - Amazon.com', 'https://www.amazon.com/s?k=blackout+curtains', 'sleep|shopping'],
      ['Best blackout curtains for day sleeping - Wirecutter', 'https://www.wirecutter.com/blackout-curtains', 'sleep'],
      ['Melatonin dosage shift work - WebMD', 'https://www.webmd.com/melatonin', 'sleep'],
      ['Kronos Workforce - Schedule', 'https://mercy.kronos.net/wfc', 'work'],
      ['Epic Hyperspace', 'https://epic.mercy.org/', 'work'],
      ['Shift swap request - Mercy HR', 'https://hr.mercy.org/swap', 'work'],
      ['Travel nurse jobs Denver - Aya Healthcare', 'https://www.ayahealthcare.com/denver', 'jobs'],
      ['Travel nurse pay comparison - Vivian', 'https://www.vivian.com/pay', 'jobs'],
      ['Nurse salary Colorado - Indeed', 'https://www.indeed.com/salaries/nurse-co', 'jobs'],
      ['BSN to DNP programs - Johns Hopkins', 'https://nursing.jhu.edu/dnp', 'school'],
      ['FNP program tuition - Walden University', 'https://www.waldenu.edu/fnp', 'school'],
      ['Meal prep high protein for 12 hour shifts', 'https://www.budgetbytes.com/meal-prep-protein', 'meals'],
      ['Overnight oats 5 ways - Minimalist Baker', 'https://minimalistbaker.com/overnight-oats', 'meals'],
      ['Sheet pan chicken thighs recipe - Serious Eats', 'https://www.seriouseats.com/sheet-pan-chicken', 'meals'],
      ['Compression socks for nurses - Amazon', 'https://www.amazon.com/s?k=compression+socks', 'work|shopping'],
      ['Best nursing shoes 2026 - Dansko vs Hoka', 'https://www.runnersworld.com/nursing-shoes', 'work|shopping'],
      ['Hoka Clifton 10 - Zappos', 'https://www.zappos.com/hoka-clifton', 'work|shopping'],
      ['Gmail', 'https://mail.google.com/mail/u/0', 'mail'],
      ['Google Calendar - Week of Oct 6', 'https://calendar.google.com/', 'mail'],
      ['Spotify - Night Shift Playlist', 'https://open.spotify.com/playlist/1', 'media'],
      ['Reddit - r/nursing', 'https://www.reddit.com/r/nursing', 'work'],
      ['Reddit - r/nightshift', 'https://www.reddit.com/r/nightshift', 'work|sleep|media'],
      ['Chase - Accounts', 'https://secure.chase.com/web/auth', 'bank'],
      ['Student loan forgiveness PSLF nurses - studentaid.gov', 'https://studentaid.gov/pslf', 'loans'],
      ['PSLF employment certification form', 'https://studentaid.gov/pslf/employer', 'loans'],
      ['Flights Denver to Maui - Google Flights', 'https://www.google.com/travel/flights', 'maui'],
      ['Maui hotels - Booking.com', 'https://www.booking.com/maui', 'maui'],
      ['Things to do in Maui - TripAdvisor', 'https://www.tripadvisor.com/Maui', 'maui'],
      ['Netflix', 'https://www.netflix.com/browse', 'media'],
      ['Untitled', 'about:blank', ''],
    ],
    athlete: [
      ['Canvas - Dashboard', 'https://nu.instructure.com/', 'school'],
      ['BIOL 2101 Anatomy - Canvas', 'https://nu.instructure.com/courses/22', 'school'],
      ['Anatomy and Physiology Chapter 9 - Quizlet', 'https://quizlet.com/anatomy-ch9', 'school'],
      ['Organic Chemistry Practice Exam - Khan Academy', 'https://www.khanacademy.org/orgo', 'school'],
      ['Study guide: muscle contraction - Kenhub', 'https://www.kenhub.com/muscle', 'school'],
      ['NCAA Eligibility Center', 'https://web3.ncaa.org/ecwr3', 'sport'],
      ['NCAA transfer portal rules 2026', 'https://www.ncaa.org/transfer', 'sport'],
      ['Team travel itinerary - Away at Duke', 'https://teamworks.com/travel', 'sport'],
      ['Teamworks - Practice Schedule', 'https://app.teamworks.com/schedule', 'sport'],
      ['Hudl - Game film vs Syracuse', 'https://www.hudl.com/video/3/film', 'sport'],
      ['Hudl - Highlights reel', 'https://www.hudl.com/profile/hi', 'sport'],
      ['Soccer positioning drills - Coerver', 'https://www.coerver.com/drills', 'sport|fitness'],
      ['Interval training for midfielders - Breaking Muscle', 'https://breakingmuscle.com/intervals', 'sport|fitness'],
      ['Hamstring injury recovery timeline - Mayo Clinic', 'https://www.mayoclinic.org/hamstring-strain', 'fitness|sport'],
      ['Sports nutrition for college athletes - Gatorade Sports Science Institute', 'https://www.gssiweb.org/nutrition', 'fitness|sport'],
      ['Creatine monohydrate dosage - Examine', 'https://examine.com/creatine', 'fitness'],
      ['Protein powder - Optimum Nutrition Gold Standard - Amazon', 'https://www.amazon.com/optimum-nutrition', 'fitness'],
      ['Nike Phantom GX cleats - Nike.com', 'https://www.nike.com/phantom-gx', 'sport|shopping'],
      ['Soccer cleats review - Pro-Direct Soccer', 'https://www.prodirectsoccer.com/cleats', 'sport|shopping'],
      ['Premier League table - BBC Sport', 'https://www.bbc.com/sport/football/tables', 'sport'],
      ['Champions League fixtures - ESPN', 'https://www.espn.com/soccer/fixtures', 'sport'],
      ['USWNT roster announced - The Athletic', 'https://www.nytimes.com/athletic/uswnt', 'sport'],
      ['NIL deal contract review - Opendorse', 'https://opendorse.com/nil', 'sport|money'],
      ['Sponsorship pitch deck template - Canva', 'https://www.canva.com/templates/pitch', 'sport|design'],
      ['Instagram', 'https://www.instagram.com/', 'social'],
      ['TikTok - For You', 'https://www.tiktok.com/foryou', 'social'],
      ['Venmo', 'https://venmo.com/', 'money'],
      ['Spring internship - Handshake', 'https://app.joinhandshake.com/jobs', 'jobs'],
      ['Sports management internships - LinkedIn Jobs', 'https://www.linkedin.com/jobs/sports', 'jobs'],
      ['Resume template - Overleaf', 'https://www.overleaf.com/latex/resume', 'jobs'],
      ['Dining hall menu - Northeastern', 'https://nu.sodexomyway.com/menu', 'dining'],
      ['Gmail', 'https://mail.google.com/mail/u/0', 'mail'],
      ['YouTube - Messi best dribbles', 'https://www.youtube.com/watch?v=9', 'sport|media'],
      ['YouTube - Lofi study beats', 'https://www.youtube.com/watch?v=8', 'media'],
      ['Spotify - Pregame playlist', 'https://open.spotify.com/playlist/2', 'media'],
      ['New Tab', 'chrome://newtab', ''],
    ],
    gamedev: [
      ['Unity Manual - Cinemachine', 'https://docs.unity3d.com/Packages/com.unity.cinemachine', 'gamedev'],
      ['Unity Discussions - Tilemap collider jitter', 'https://discussions.unity.com/t/tilemap', 'gamedev'],
      ['Stack Overflow - Unity 2D raycast ignore layer', 'https://stackoverflow.com/questions/111', 'gamedev'],
      ['GitHub - me/pixel-heist', 'https://github.com/me/pixel-heist', 'project'],
      ['Pull request 14 - enemy AI patrol - pixel-heist', 'https://github.com/me/pixel-heist/pull/14', 'project'],
      ['Issues - pixel-heist', 'https://github.com/me/pixel-heist/issues', 'project'],
      ['Aseprite - Pixel art tool', 'https://www.aseprite.org/', 'gamedev'],
      ['Lospec - Palette list', 'https://lospec.com/palette-list', 'gamedev'],
      ['itch.io - Pixel art assets free', 'https://itch.io/game-assets/free/tag-pixel-art', 'gamedev'],
      ['itch.io - Dashboard - Pixel Heist', 'https://itch.io/dashboard/game/1', 'project'],
      ['Steamworks - Pixel Heist app admin', 'https://partner.steamgames.com/apps/1', 'project'],
      ['Steam - Wishlists report', 'https://partner.steamgames.com/wishlists', 'gamedev|project'],
      ['How to market your indie game - GDC Vault', 'https://www.gdcvault.com/play/marketing', 'gamedev'],
      ['How many wishlists do you need - HOWTOMARKETAGAME', 'https://howtomarketagame.com/wishlists', 'gamedev'],
      ['Game Developer - Postmortem: Celeste', 'https://www.gamedeveloper.com/celeste', 'gamedev'],
      ['Reddit - r/gamedev', 'https://www.reddit.com/r/gamedev', 'gamedev'],
      ['Reddit - r/IndieDev', 'https://www.reddit.com/r/IndieDev', 'gamedev'],
      ['Discord - Pixel Heist community', 'https://discord.com/channels/1', 'project'],
      ['Twitter / X - screenshotsaturday', 'https://x.com/search?q=screenshotsaturday', 'gamedev|project'],
      ['FMOD Studio - Documentation', 'https://www.fmod.com/docs', 'gamedev'],
      ['Freesound - door creak', 'https://freesound.org/search/?q=door', 'gamedev'],
      ['Epidemic Sound - Heist music', 'https://www.epidemicsound.com/music', 'project|gamedev'],
      ['Trello - Pixel Heist roadmap', 'https://trello.com/b/abc', 'project'],
      ['Notion - GDD Pixel Heist', 'https://www.notion.so/gdd', 'project'],
      ['Mailchimp - Devlog newsletter', 'https://admin.mailchimp.com/campaigns', 'gamedev|project'],
      ['Press kit - Pixel Heist', 'https://pixelheist.dev/presskit', 'project|gamedev'],
      ['Wikipedia - Metroidvania', 'https://en.wikipedia.org/wiki/Metroidvania', 'gamedev'],
      ['YouTube - Hollow Knight level design analysis', 'https://www.youtube.com/watch?v=5', 'gamedev'],
      ['YouTube - Brackeys Unity tutorial', 'https://www.youtube.com/watch?v=6', 'gamedev'],
      ['Mac mini M4 - Apple', 'https://www.apple.com/mac-mini', 'hardware'],
      ['Mac mini M4 review - The Verge', 'https://www.theverge.com/mac-mini-m4', 'hardware'],
      ['Gmail', 'https://mail.google.com/mail/u/0', 'mail'],
      ['Stripe - Dashboard', 'https://dashboard.stripe.com/', 'biz'],
      ['Quarterly estimated tax - IRS Direct Pay', 'https://www.irs.gov/payments/direct-pay', 'biz'],
      ['Spotify - Focus', 'https://open.spotify.com/playlist/3', 'media'],
      ['Untitled', 'about:blank', ''],
    ],
  };
  // -> { w, wrong: [tab titles in a group of another topic], group: (re) => the name of the group of the tab whose title matches }
  const judge = (set) => {
    const w = window_(set.map(([title, url]) => [title, url, { userRemoved: true }]));
    w.g.organizeByTopic();
    const names = new Map(w.g.state().map((g) => [g.id, g.name]));
    const by = new Map();
    w.tabs().forEach((t) => { if (t.groupId) { if (!by.has(t.groupId)) by.set(t.groupId, []); by.get(t.groupId).push(t.id - 1); } });
    const wrong = [];
    for (const idx of by.values()) {
      const count = new Map();
      for (const i of idx) for (const l of set[i][2].split('|').filter(Boolean)) count.set(l, (count.get(l) || 0) + 1);
      const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      for (const i of idx) if (!set[i][2].split('|').includes(top)) wrong.push(set[i][0]);
    }
    const gid = (re) => { const i = set.findIndex(([t]) => re.test(t)); if (i < 0) throw new Error(`no tab ${re}`); return at(w, i + 1).groupId; };
    return { w, wrong, names, gid, together: (a, b) => Boolean(gid(a)) && gid(a) === gid(b), nameOf: (re) => names.get(gid(re)) || '', loose: set.filter((_s, i) => !at(w, i + 1).groupId).length };
  };
  const nurse = judge(R12.nurse);
  const athlete = judge(R12.athlete);
  const dev = judge(R12.gamedev);
  check('r12 precision: no tab of the three persona sets is in a group of another topic', nurse.wrong.length + athlete.wrong.length + dev.wrong.length === 0, JSON.stringify([...nurse.wrong, ...athlete.wrong, ...dev.wrong]));
  check('r12 nurse: "sheet" (a cheat sheet, a sheet-pan recipe) links nothing', !nurse.together(/cheat sheet/, /Sheet pan/) && !/sheet/i.test(nurse.nameOf(/cheat sheet/)), nurse.nameOf(/cheat sheet/));
  check('r12 nurse: "shift" (sleep tips, a swap request, a playlist, a meal prep) links nothing', !nurse.together(/Melatonin/, /Spotify - Night/) && !nurse.together(/Shift swap/, /Meal prep/) && !/^shift/i.test(nurse.nameOf(/Shift swap/)), nurse.nameOf(/Shift swap/));
  check('r12 nurse: NCLEX, ACLS, Kronos and Epic are one Nursing group', nurse.together(/NCLEX/, /ACLS/) && nurse.together(/ACLS/, /Kronos/) && nurse.together(/Kronos/, /Epic/) && nurse.nameOf(/NCLEX/) === 'Nursing', nurse.nameOf(/NCLEX/));
  check('r12 nurse: travel-nurse jobs are a job search, not the Maui trip (a city alone never joins one)', nurse.together(/Aya Healthcare/, /Vivian/) && nurse.together(/Vivian/, /Nurse salary/) && !nurse.together(/Aya Healthcare/, /Flights Denver to Maui/) && /job/i.test(nurse.nameOf(/Aya Healthcare/)), nurse.nameOf(/Aya Healthcare/));
  check('r12 nurse: the Maui flights, hotels and things to do are one trip', nurse.together(/Flights Denver to Maui/, /Maui hotels/) && nurse.together(/Maui hotels/, /Things to do in Maui/), nurse.nameOf(/Maui hotels/));
  check('r12 nurse: a nurse\'s degree and loans are not the clinical Nursing group', !nurse.together(/BSN to DNP/, /NCLEX/) && !nurse.together(/PSLF nurses/, /NCLEX/) && !nurse.together(/BSN to DNP/, /Aya Healthcare/), `${nurse.nameOf(/BSN/)}|${nurse.nameOf(/PSLF nurses/)}`);
  check('r12 athlete: "practice" (an exam, a team schedule) and "study" (a guide, lofi beats) link nothing', !athlete.together(/Practice Exam/, /Practice Schedule/) && !athlete.together(/Study guide/, /Lofi study/), `${athlete.nameOf(/Practice Exam/)}|${athlete.nameOf(/Practice Schedule/)}`);
  check('r12 athlete: Canva (a pitch deck) is not Canvas (the school site)', !athlete.together(/Canvas - Dashboard/, /pitch deck/) && tg.tokens('Canvas')[0].key !== tg.tokens('Canva')[0].key, athlete.nameOf(/pitch deck/));
  check('r12 athlete: Canvas, the anatomy chapter and the orgo exam are one School group', athlete.together(/Canvas - Dashboard/, /BIOL 2101/) && athlete.together(/BIOL 2101/, /Anatomy and Physiology/) && athlete.together(/Anatomy and Physiology/, /Organic Chemistry/), athlete.nameOf(/Canvas - Dashboard/));
  check('r12 athlete: Hudl, NCAA, cleats and the practice schedule are the team\'s Sports group', athlete.together(/Hudl - Game film/, /Hudl - Highlights/) && athlete.together(/NCAA Eligibility/, /Hudl - Game film/) && athlete.together(/Nike Phantom/, /Practice Schedule/) && athlete.nameOf(/Hudl - Game film/) === 'Sports', athlete.nameOf(/Hudl - Game film/));
  check('r12 athlete: recovery, creatine and sports nutrition are Fitness, apart from the internships', athlete.together(/Hamstring/, /Creatine/) && !athlete.together(/Hamstring/, /internship/i), athlete.nameOf(/Hamstring/));
  check('r12 game dev: Lospec, Aseprite, itch.io, FMOD, Freesound, GDC and Game Developer are one Game dev group', ['Aseprite', 'Lospec', 'itch.io - Pixel art', 'FMOD', 'Freesound', 'GDC Vault', 'Game Developer'].every((x) => dev.together(new RegExp(x), /Unity Manual/)) && dev.nameOf(/Lospec/) === 'Game dev', dev.nameOf(/Lospec/));
  check('r12 game dev: the project\'s own repo, store pages and board are Pixel Heist, apart from the pixel art tools', dev.together(/GitHub - me\/pixel-heist/, /Steamworks/) && dev.together(/Steamworks/, /Trello/) && !dev.together(/Aseprite/, /GitHub - me\/pixel-heist/) && dev.nameOf(/Trello/) === 'Pixel Heist', dev.nameOf(/Trello/));
  // The structural rule itself, on small windows: none of these shares more than one word.
  const one = (a, b, c) => organized([[a, 'https://x1.example/a'], [b, 'https://x2.example/b'], [c, 'https://x3.example/c']]);
  const sheets = one('Python cheat sheet', 'Sheet pan salmon dinner', 'Weather in Lima');
  check('a single shared word never links two tabs ("sheet")', !sheets.same(0, 1), sheets.name(0));
  const pairs = organized([['Spring practice schedule', 'https://a.example/1'], ['Piano practice tips', 'https://b.example/2'], ['Chess endgame study', 'https://c.example/3'], ['Study abroad deadlines', 'https://d.example/4']]);
  check('"practice" and "study" alone link nothing, in any window', !pairs.same(0, 1) && !pairs.same(2, 3), `${pairs.name(0)}|${pairs.name(2)}`);
  const shared2 = organized([['Kitten vaccine schedule', 'https://a.example/1'], ['Kitten vaccine costs', 'https://b.example/2'], ['Pasta carbonara', 'https://c.example/3']]);
  check('two shared words (one of them no ordinary one) do link', shared2.same(0, 1), shared2.name(0));
  const city = organized([['Best ramen in Boston', 'https://a.example/1'], ['Boston rent prices', 'https://b.example/2'], ['Boston to NYC bus tickets', 'https://c.example/3']]);
  check('a shared city alone links nothing', !city.same(0, 1) && !city.same(1, 2) && !city.same(0, 2), city.name(0));
  // Names: one normalization. The same tabs in any order get the same name; Program and Programs are one.
  const prog = (order) => { const specs = [['Nursing programs near me', 'https://p1.example/a'], ['Nursing program tuition costs', 'https://p2.example/b'], ['Pasta carbonara', 'https://p3.example/c']]; return organized(order.map((i) => specs[i])).name(order.indexOf(0)); };
  check('a group of title words is named in one form whatever the tab order ("Program" and "Programs" are one name)', prog([0, 1, 2]) === prog([1, 0, 2]) && prog([2, 1, 0]) === prog([0, 1, 2]) && !/s$/i.test(prog([0, 1, 2])), `${prog([0, 1, 2])}|${prog([1, 0, 2])}|${prog([2, 1, 0])}`);
  check('group names say a concept before an ordinary title word: nursing sleep tips and "shift" tabs are not named "Shift"', !/^(shift|practice|study|sheet)$/i.test(nurse.nameOf(/Night shift nurse/)), nurse.nameOf(/Night shift nurse/));
  // Speed: 300 tabs stay fast. This guards against an algorithmic blowup (quadratic work), not a few
  // milliseconds, so it takes the best of three fresh runs against a bound that a loaded shared CI runner
  // (macOS measured 439 ms against the old 400 ms bound) still clears, while a real regression would not.
  {
    const topics = ['react hooks', 'pasta carbonara', 'tokyo hotels', 'mortgage rates', 'yoga poses', 'tesla model', 'python pandas', 'garden soil', 'guitar chords', 'camera lenses', 'neural network', 'sourdough starter', 'movie reviews', 'novel recommendations'];
    const specs = Array.from({ length: 300 }, (_v, i) => [`${topics[i % topics.length]} ${['tips', 'review', 'explained', 'how to'][i % 4]} ${i}`, `https://site${i % 40}.example/${i}`]);
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const w = window_(specs.map(([a, b]) => [a, b, { userRemoved: true }]));
      const t0 = Date.now();
      w.g.organizeByTopic();
      runs.push(Date.now() - t0);
    }
    const best = Math.min(...runs);
    check('organize: 300 tabs stay fast (best of three under 1500 ms)', best < 1500, `${runs.join(', ')} ms`);
  }
  // Group colours: neighbours never share a colour, nor read as one (red and pink, blue and purple).
  {
    const w = window_(R12.nurse.map(([title, url]) => [title, url, { userRemoved: true }]));
    w.g.organizeByTopic();
    const colors = w.g.state().map((g) => g.color);
    const like = { red: ['pink', 'orange'], pink: ['red', 'purple'], orange: ['red', 'yellow'], yellow: ['orange'], blue: ['purple'], purple: ['blue', 'pink'] };
    const bad = colors.filter((c, i) => i > 0 && (c === colors[i - 1] || (like[c] || []).includes(colors[i - 1])));
    check('organize: neighbouring new groups get distinct colours', colors.length >= 5 && bad.length === 0, colors.join());
  }
}

(async () => {
  // topicAi off (or no route): the model is never asked and nothing is reported as a failure.
  const ask = () => { asked++; return Promise.resolve({}); };
  check('askIfEnabled: setting off means no ask function', oai.askIfEnabled({ enabled: false, route: { api: 'm' }, ask }) === null);
  check('askIfEnabled: no usable route means no ask function', oai.askIfEnabled({ enabled: true, route: null, ask }) === null);
  check('askIfEnabled: setting on and a route means the ask function', oai.askIfEnabled({ enabled: true, route: { engine: 'claudecode' }, ask }) === ask);
  const w = window_([...RECIPES, ...TRIP].map(([a, b]) => [a, b, { userRemoved: true }]));
  const phases = [];
  const stats = await oai.organizeProgressive({ tabGroups: w.g, ask: oai.askIfEnabled({ enabled: false, route: null, ask }), onPhase: (n) => phases.push(n) });
  check('topicAi off: organizeProgressive makes the local groups, asks nothing, reports no AI failure', stats.groups >= 1 && asked === 0 && stats.requests === 0 && !stats.failed && stats.reason === 'local' && !phases.includes('asking'), JSON.stringify({ asked, reason: stats.reason, failed: stats.failed }));
  check('topicAi off: the local groups can be undone', w.g.undoOrganize() && w.tabs().every((t) => !t.groupId));
  // A timeout aborts the request itself, not just the wait.
  const ctl = new AbortController();
  const err = await oai.withTimeout(new Promise(() => {}), 30, undefined, ctl).catch((e) => e);
  check('withTimeout: a timeout aborts the request\'s AbortController', err.code === 'timeout' && ctl.signal.aborted === true, `${err.code} ${ctl.signal.aborted}`);
  let seen = null;
  const w2 = window_([...RECIPES, ...TRIP].map(([a, b]) => [a, b, { userRemoved: true }]));
  const st2 = await oai.organizeProgressive({ tabGroups: w2.g, timeoutMs: 40, alwaysAsk: true, ask: (wire, { signal }) => { seen = signal; return new Promise(() => {}); } });
  check('organizeProgressive: the signal handed to ask is aborted when the wait times out', st2.failed === 'timeout' && seen && seen.aborted === true, `${st2.failed} ${seen && seen.aborted}`);
  // Round 10: a model's group named like a local one joins it ("Finance" and "Finance (2)")
  {
    const fin = [['Roth IRA limits', 'https://www.fidelity.com/roth'], ['Vanguard index funds', 'https://investor.vanguard.com/funds'], ['401k rollover guide', 'https://www.nerdwallet.com/401k'], ['Schwab Brokerage', 'https://www.schwab.com/'], ['Pasta carbonara', 'https://www.seriouseats.com/carbonara'], ['Tiramisu recipe', 'https://www.example.org/tiramisu'], ['Mortgage notes', 'https://www.example.org/m'], ['Budget spreadsheet', 'https://www.example.org/b']];
    const w = window_(fin.map(([a, b]) => [a, b, { userRemoved: true }]));
    await oai.organizeProgressive({ tabGroups: w.g, ask: async (wire) => ({ n: [], p: [], g: [{ s: 'Finance', t: Object.values(wire.u || {}).flat().map((x) => x[0]).slice(0, 2) }], m: [], h: [] }) });
    const names = w.g.state().map((g) => g.name);
    check('r10 AI: a model group named like a local group joins it: no "Finance (2)"', names.filter((n) => /^finance/i.test(n)).length <= 1 && !names.some((n) => /\(\d+\)$/.test(n)), names.join());
    const w2 = window_(fin.map(([a, b]) => [a, b, { userRemoved: true }]));
    w2.g.organizeByTopic();
    const view = w2.g.organizeView();
    const first = view.groups[0];
    const res = w2.g.applyRefinement({ renames: [], places: [], groups: [{ name: first.name, ids: view.leftovers.map((e) => e.id).slice(0, 2) }], merges: [] }, { explicit: true });
    check('r10 AI: applyRefinement files a created group under an existing automatic name instead of a twin', res.created === 0 && new Set(w2.g.state().map((g) => g.name)).size === w2.g.state().length, JSON.stringify(res));
    const w3 = window_(fin.map(([a, b]) => [a, b, { userRemoved: true }]));
    w3.g.organizeByTopic();
    const v3 = w3.g.organizeView();
    const res3 = w3.g.applyRefinement({ renames: v3.groups.length > 1 ? [{ id: v3.groups[1].id, name: v3.groups[0].name }] : [], places: [], groups: [], merges: [] }, { explicit: true });
    check('r10 AI: a rename onto another automatic group\'s name merges the two', v3.groups.length < 2 || (res3.merged === 1 && !w3.g.state().some((g) => /\(\d+\)$/.test(g.name))), JSON.stringify(res3));
  }
  // Round 13: lease / moving / relocation are not housing alone; baby, woodworking, crypto and real-estate work have groups; "Already organized"
  {
    const flat = [['Apartment hunting checklist', 'https://alpha.example/a'], ['Renting your first apartment: tenant rights', 'https://bravo.example/b'], ['Apartment lease terms explained', 'https://charlie.example/c']];
    const car = organized([...flat, ['Honda CR-V lease review', 'https://www.edmunds.com/honda/cr-v/lease']]);
    check('r13 housing: a car lease is not in the Housing group', car.same(0, 1) && car.same(0, 2) && !car.same(0, 3) && car.name(3) !== car.name(0), [0, 1, 2, 3].map(car.name).join());
    const lone = organized([['Honda CR-V lease review', 'https://alpha.example/a'], ['Job relocation package checklist', 'https://bravo.example/b'], ['Moving to Austin tips', 'https://charlie.example/c']]);
    check('r13 housing: lease, relocation and moving alone are no housing group', [0, 1, 2].every((i) => lone.name(i) !== 'Housing'), [0, 1, 2].map(lone.name).join());
    const withRent = organized([['Apartment lease terms explained', 'https://alpha.example/a'], ['Tenant rights when you rent', 'https://bravo.example/b'], ['Apartment rental application', 'https://charlie.example/c']]);
    check('r13 housing: lease beside apartment, rent or tenant is still housing', withRent.same(0, 1) && withRent.same(0, 2) && withRent.name(0) === 'Housing', [0, 1, 2].map(withRent.name).join());

    const baby = organized([['Newborn sleep: wake windows by age', 'https://alpha.example/a'], ['Postpartum recovery checklist', 'https://bravo.example/b'], ['Babylist registry', 'https://www.babylist.com/registry'], ['Best baby monitor 2026', 'https://charlie.example/c']]);
    check('r13 baby: newborn, postpartum, Babylist and baby gear tabs are one group named Baby', [1, 2, 3].every((i) => baby.same(0, i)) && baby.name(0) === 'Baby', [0, 1, 2, 3].map(baby.name).join());
    const wood = organized([['Cutting dovetails by hand', 'https://alpha.example/a'], ['Rockler router table review', 'https://www.rockler.com/router-table'], ['Walnut lumber prices', 'https://bravo.example/b'], ['Workbench build plans', 'https://charlie.example/c']]);
    check('r13 woodworking: tool shopping goes to Woodworking, not Shopping', [1, 2, 3].every((i) => wood.same(0, i)) && wood.name(0) === 'Woodworking', [0, 1, 2, 3].map(wood.name).join());
    const coins = [['Uniswap swap fees', 'https://app.uniswap.org/swap'], ['Etherscan gas tracker', 'https://etherscan.io/gastracker'], ['MetaMask wallet setup', 'https://metamask.io/download'], ['Koinly crypto tax report', 'https://koinly.io/'], ['Ethereum DeFi yields', 'https://defillama.com/yields']];
    const money = [['Roth IRA limits', 'https://www.fidelity.com/roth'], ['Vanguard index funds', 'https://investor.vanguard.com/funds'], ['401k rollover guide', 'https://www.nerdwallet.com/401k']];
    const mixed = organized([...coins, ...money]);
    check('r13 crypto: three or more crypto tabs are their own group beside Finance', [1, 2, 3, 4].every((i) => mixed.same(0, i)) && mixed.name(0) === 'Crypto' && [6, 7].every((i) => mixed.same(5, i)) && mixed.name(5) === 'Finance' && !mixed.same(0, 5), [0, 1, 2, 3, 4, 5, 6, 7].map(mixed.name).join());
    const two = organized([coins[0], coins[1], ...money]);
    check('r13 crypto: two crypto tabs stay with Finance', [1, 2, 3, 4].every((i) => two.same(0, i)) && two.name(0) === 'Finance', [0, 1, 2, 3, 4].map(two.name).join());
    const deal = organized([['Buyer representation agreement template', 'https://alpha.example/a'], ['Listing agreement: what to include', 'https://bravo.example/b'], ['DocuSign: sign the disclosure', 'https://app.docusign.com/envelopes'], ['Open house checklist for agents', 'https://charlie.example/c']]);
    check('r13 real estate: agreements, DocuSign and open houses are one group', [1, 2, 3].every((i) => deal.same(0, i)) && deal.name(0) === 'Real estate', [0, 1, 2, 3].map(deal.name).join());
    const staging = organized([['Deploy to staging server', 'https://alpha.example/a'], ['Staging environment variables', 'https://bravo.example/b'], ['Zxqv wibble plomf', 'https://charlie.example/c']]);
    check('r13 real estate: a software "staging" tab is not real-estate work', [0, 1, 2].every((i) => staging.name(i) !== 'Real estate'), [0, 1, 2].map(staging.name).join());

    // Already organized: a second Organize over the same groups changes nothing, and the signature says so
    const w = window_([...RECIPES, ...TRIP].map(([a, b]) => [a, b, { userRemoved: true }]));
    const first = w.g.layoutSignature();
    w.g.organizeByTopic();
    const grouped = w.g.layoutSignature();
    check('r13 signature: grouping changes the layout', first.groups === 0 && grouped.groups >= 1 && first.key !== grouped.key, JSON.stringify([first, grouped]));
    w.g.organizeByTopic();
    const again = w.g.layoutSignature();
    check('r13 signature: organizing again gives the same groups, names and members', again.key === grouped.key && again.groups === grouped.groups, JSON.stringify([grouped, again]));
  }
    // Round 14: recall for the obvious clusters of three more windows, without a wrong group
    {
      const P14 = require('./fixtures/organize-r14');
      const find = (rows, re) => { const i = rows.findIndex(([t]) => re.test(t)); if (i < 0) throw new Error(`no tab ${re}`); return i; };
      const looseShare = (rows, o) => rows.filter((_r, i) => !o.name(i)).length / rows.length;
      const together = (rows, o, head, list) => list.every((re) => o.same(find(rows, head), find(rows, re)));
      const apart = (rows, o, head, list) => list.every((re) => !o.same(find(rows, head), find(rows, re)));

      const parent = organized(P14.parent);
      check('r14 baby: wake windows, the pediatrician, vaccines, Baby Tracker, parental leave and the birth announcement are with the newborn tabs and named Baby',
        together(P14.parent, parent, /^Newborn sleep/, [/^Wake windows/, /^Pediatrician/, /^Vaccine schedule/, /^Baby Tracker/, /^Parental leave/, /new parents/, /^Shutterfly/, /^Target - Diapers/, /^Postpartum recovery/]) && parent.name(0) === 'Baby', parent.name(0));
      check('r14 baby: groceries, delivery, a TV show, mail and Venmo are not baby tabs', apart(P14.parent, parent, /^Newborn sleep/, [/^Instacart/, /^DoorDash/, /^Hulu/, /^Gmail/, /^Venmo/, /^Life insurance/]));
      check('r14 baby: at most 35% of the new parent\'s tabs stay loose', looseShare(P14.parent, parent) <= 0.35, String(looseShare(P14.parent, parent)));

      const realtor = organized(P14.realtor);
      check('r14 real estate: Redfin, staging, Follow Up Boss, DocuSign, commission and NAR tabs are with the agreements and named Real estate',
        together(P14.realtor, realtor, /^MLS Search/, [/^Redfin/, /^Staging tips/, /^Follow Up Boss/, /^DocuSign/, /negotiate commission/, /NAR settlement/, /^Buyer representation/, /^Listing agreement/, /^Open house checklist/]) && realtor.name(0) === 'Real estate', realtor.name(0));
      check('r14 real estate: BBQ, a car lease, Peloton, Netflix and the bank are not real-estate work', apart(P14.realtor, realtor, /^MLS Search/, [/^Best BBQ/, /^Franklin/, /^Honda/, /^Peloton/, /^Netflix/, /^Chase/, /^Dallas Cowboys/]));
      check('r14 names: no group is named for a bare place or "Shopping" in the realtor\'s, the parent\'s or the crypto window',
        [[P14.realtor, realtor], [P14.parent, parent], [P14.crypto, organized(P14.crypto)]].every(([rows, o]) => rows.every((_r, i) => !/^(texas|austin|shopping)$/i.test(o.name(i)))));
      check('r14 real estate: at most 35% of the realtor\'s tabs stay loose', looseShare(P14.realtor, realtor) <= 0.35, String(looseShare(P14.realtor, realtor)));

      const cw = organized(P14.crypto);
      check('r14 crypto: Coinbase, Uniswap, Ledger, Etherscan, DeFiLlama, Koinly, Solana, ETF flows and the DAO are one group named Crypto',
        together(P14.crypto, cw, /^Bitcoin price/, [/^Coinbase/, /^Uniswap/, /^Ledger Live/, /^Etherscan/, /^DeFiLlama/, /^Koinly/, /^Is Solana/, /^Bitcoin ETF/, /Bankless DAO/, /^TradingView/]) && cw.name(0) === 'Crypto', cw.name(0));
      check('r14 crypto: a Roth IRA, a brokerage and the Fed are Finance (or loose), never Crypto', apart(P14.crypto, cw, /^Bitcoin price/, [/^Roth IRA/, /^Fidelity/, /^Vanguard/, /^Fed rate/]));
      check('r14 woodworking: dovetails, Lie-Nielsen, walnut, a jig, Ana White and the lumber index are one group named Woodworking',
        together(P14.crypto, cw, /^Dovetail joint/, [/^Hand cut dovetails/, /^Lie-Nielsen/, /^Black walnut/, /^Home Depot - Pocket/, /^Kitchen table build/, /^Lumber price index/, /^Roubo/, /^Titebond/]) && cw.name(find(P14.crypto, /^Dovetail joint/)) === 'Woodworking', cw.name(find(P14.crypto, /^Dovetail joint/)));
      check('r14 crypto + woodworking: the two are never one group', apart(P14.crypto, cw, /^Bitcoin price/, [/^Dovetail joint/, /^Rockler/]));
      check('r14 crypto: at most 35% of the window stays loose', looseShare(P14.crypto, cw) <= 0.35, String(looseShare(P14.crypto, cw)));

      // A topical noun three tabs of two sites or more say forms a group; two tabs, or a word of no topic, never do.
      const filler = [['Quarterly roadmap meeting notes', 'https://docs.google.com/document/d/1'], ['Flights to Lisbon in March', 'https://www.kayak.com/flights/lis'], ['Rust ownership explained', 'https://doc.rust-lang.org/book/ch04'], ['Pasta carbonara recipe', 'https://www.seriouseats.com/carbonara'], ['Mortgage rates today', 'https://www.bankrate.com/mortgages/rates']];
      const kombucha = [['Kombucha second fermentation bottles flavor ideas', 'https://alpha.example/ferment'], ['Where to buy SCOBY kombucha for fermentation online', 'https://www.etsy.com/search?q=scoby'], ['Is kombucha fermentation safe during pregnancy', 'https://www.healthline.com/nutrition/kombucha']];
      const three = organized([...kombucha, ...filler]);
      check('r14 token: a noun three tabs of three sites say (kombucha) is a group named for it', three.same(0, 1) && three.same(0, 2) && /kombucha/i.test(three.name(0)), three.name(0));
      const pair = organized([['Kombucha bottles flavor ideas', 'https://alpha.example/ferment'], ['Where to buy SCOBY kombucha online', 'https://www.etsy.com/search?q=scoby'], ...filler]);
      check('r14 token: the same noun in only two tabs is no group (one word never links a pair)', !pair.same(0, 1), pair.name(0));
      const words = [['Complete guide to retirement planning', 'https://www.fidelity.com/a'], ['Travel guide to Lisbon neighborhoods', 'https://www.lonelyplanet.com/b'], ['Style guide for Python code', 'https://peps.python.org/c'], ['Beginner guide to sourdough starters', 'https://www.kingarthur.com/d'],
        ['Best way to learn Spanish 2026', 'https://www.duolingo.com/e'], ['Best practices for API design 2026', 'https://dev.example/f'], ['Best sci-fi books 2026', 'https://www.goodreads.com/g'],
        ['Product review tips tricks', 'https://hotel.example/h'], ['Packing list for hiking', 'https://www.rei.com/i'], ['Reading list for summer', 'https://www.goodreads.com/j'], ['Weekend plan for Austin', 'https://www.austinmonthly.com/k'],
        ['Restaurants near me open now', 'https://www.yelp.com/l'], ['Gyms near campus', 'https://maps.example/m'], ['Tips for first apartment', 'https://www.apartmentlist.com/n'], ['Affordable laptops for students', 'https://www.pcmag.com/o'], ['Affordable flights to Denver', 'https://www.expedia.com/p'], ['Affordable car insurance', 'https://www.geico.com/q']];
      const generic = organized(words);
      const guides = [0, 1, 2, 3], bests = [4, 5, 6], misc = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
      check('r14 token: "guide", "best", "2026", "review", "list", "plan", "tips", "near" and an adjective ("affordable") never form a group across topics',
        guides.every((i) => guides.every((j) => i === j || !generic.same(i, j))) && bests.every((i) => bests.every((j) => i === j || !generic.same(i, j))) && misc.every((i) => misc.every((j) => i === j || !generic.same(i, j))), words.map((_w, i) => generic.name(i)).join('|'));
      const ports = organized(P14.parent.map(([t], i) => [t, `http://127.0.0.1:${5000 + (i % 3)}/${i}`]));
      check('r14 names: a topic across three local ports is named for its topic, never for "127.0.0.1:5000"', ports.name(0) === 'Baby' && ports.same(0, find(P14.parent, /^Pediatrician/)), ports.name(0));
      const places = organized([['Austin city council agenda', 'https://www.austintexas.gov/council'], ['Austin dental clinic hours', 'https://www.example-dental.com/hours'], ['Austin bike lanes map', 'https://maps.example/bike'], ['Pasta carbonara recipe', 'https://www.seriouseats.com/carbonara']]);
      check('r14 names: three tabs that only share a city are not a group named for it', [0, 1, 2].every((i) => places.name(i) !== 'Austin'), [0, 1, 2].map(places.name).join());
    }
    // Round 14b: the rater's four work-tool and hobby windows, and probes of words that name several things
    {
      const R = require('./fixtures/organize-r14b');
      const find = (rows, re) => { const i = rows.findIndex(([t]) => re.test(t)); if (i < 0) throw new Error(`no tab ${re}`); return i; };
      const looseShare = (rows, o) => rows.filter((_r, i) => !o.name(i)).length / rows.length;
      const together = (rows, o, head, list) => list.every((re) => o.same(find(rows, head), find(rows, re)));
      const apart = (rows, o, head, list) => list.every((re) => !o.same(find(rows, head), find(rows, re)));

      const st = organized(R.student);
      const s0 = find(R.student, /^Common App - Dashboard/);
      check('r14b college: Common App, the essay, admissions pages, College Board, SAT, r/ApplyingToCollege, FAFSA, net price, scholarships and Naviance are one group named College applications',
        together(R.student, st, /^Common App - Dashboard/, [/^Common App Essay/, /personal statement/, /^Harvard College Admissions/, /Undergraduate Admissions/, /Early Action/, /^College Board/, /^SAT Practice/, /ApplyingToCollege/, /^FAFSA/, /^Net price/, /^Scholarships/, /^Naviance/]) && st.name(s0) === 'College applications', st.name(s0));
      check('r14b college: AP class work, Desmos, Chipotle, Letterboxd and Venmo are not college applications', apart(R.student, st, /^Common App - Dashboard/, [/^AP Calculus/, /^Google Classroom/, /^Quizlet/, /^Desmos/, /^Chipotle/, /^Letterboxd/, /^Venmo/]));
      check('r14b college: at most 40% of the senior\'s tabs stay loose', looseShare(R.student, st) <= 0.4, String(looseShare(R.student, st)));

      const rs = organized(R.restaurant);
      const r0 = find(R.restaurant, /^Toast POS/);
      check('r14b restaurant: Toast, 7shifts, Sysco, US Foods, ServSafe, food cost, OpenTable and DoorDash Merchant are one group named Restaurant',
        together(R.restaurant, rs, /^Toast POS/, [/^Toast Payroll/, /^7shifts/, /^Sysco/, /^US Foods/, /^ServSafe/, /^Food cost/, /^OpenTable/, /^DoorDash Merchant/]) && rs.name(r0) === 'Restaurant', rs.name(r0));
      check('r14b restaurant: a Little League schedule, a Zoom call and the family bank are not restaurant work', apart(R.restaurant, rs, /^Toast POS/, [/^Little League/, /^Zoom/, /^Chase/]));
      check('r14b restaurant: at most 40% of the owner\'s tabs stay loose', looseShare(R.restaurant, rs) <= 0.4, String(looseShare(R.restaurant, rs)));

      const kp = organized(R.kpop);
      const k0 = find(R.kpop, /^Stray Kids 2026/);
      check('r14b k-pop: the tour, Weverse, r/kpop, the preorders and the photocards are one group named K-pop, not "Stray" or "Album Preorder"',
        together(R.kpop, kp, /^Stray Kids 2026/, [/^Weverse - Stray/, /r\/kpop/, /^Kpop Sphere/, /^Ktown4u/, /^Mercari/]) && kp.name(k0) === 'K-pop', kp.name(k0));
      check('r14b k-pop: "Korean BBQ near me" is not in the Korean-language group', !kp.same(find(R.kpop, /^Korean BBQ/), find(R.kpop, /^Duolingo/)) && !kp.same(find(R.kpop, /^Korean BBQ/), find(R.kpop, /^Papago/)), kp.name(find(R.kpop, /^Korean BBQ/)));
      check('r14b k-pop: the lessons that name Korean stay together', together(R.kpop, kp, /^Duolingo/, [/^Papago/, /^Korean particles/]), kp.name(find(R.kpop, /^Duolingo/)));
      check('r14b k-pop: at most 40% of the fan\'s tabs stay loose', looseShare(R.kpop, kp) <= 0.4, String(looseShare(R.kpop, kp)));

      const th = organized(R.thruhike);
      const t0 = find(R.thruhike, /^PCT Long-Distance/);
      check('r14b thru-hike: the association, permits, Halfmile, Guthook, r/PacificCrestTrail and Trail Angels are one group named Thru-hike or PCT, never "Permit"',
        together(R.thruhike, th, /^PCT Long-Distance/, [/^Pacific Crest Trail Association/, /^Halfmile/, /^Guthook/, /PacificCrestTrail/, /^Trail Angels/]) && /^(thru-hike|pct)$/i.test(th.name(t0)), th.name(t0));
      check('r14b thru-hike: no group is named "Permit", "Stray" or "Sierra" in any of the four windows',
        [[R.thruhike, th], [R.kpop, kp], [R.student, st], [R.restaurant, rs]].every(([rows, o]) => rows.every((_r, i) => !/^(permit|stray|sierra)$/i.test(o.name(i)))));
      check('r14b all four windows: at most 40% of their tabs stay loose together', [[R.thruhike, th], [R.kpop, kp], [R.student, st], [R.restaurant, rs]].reduce((n, [rows, o]) => n + rows.filter((_r, i) => !o.name(i)).length, 0) / (R.thruhike.length + R.kpop.length + R.student.length + R.restaurant.length) <= 0.4);

      // Probes: the same word in tabs about different things never makes them one group
      const pa = organized(R['python-ambiguity']);
      const gn = organized(R['generic-noun']);
      const pairs = [[pa, R['python-ambiguity'], [[/^Mercury retrograde/, /^Mercury thermometer/], [/^Mercury thermometer/, /Freddie/], [/^Mars bar/, /^Mars rover/], [/^Mars rover/, /Bruno Mars/], [/^Ball python/, /^Java coffee/], [/^Java coffee/, /^Visit Java/], [/^Ball python/, /^Python monopoly/],
        [/^Jaguar F-Type/, /^Jaguar habitat/], [/^Jaguar habitat/, /^Jaguar Land Rover/], [/^Amazon rainforest/, /^Amazon Prime/], [/^Amazon Prime/, /^Amazon stock/], [/^Apple pie/, /^Apple iPhone/], [/^Taylor Swift/, /^Swift sparrow/], [/^Swift sparrow/, /^Swift tutorial/], [/^Taylor Swift/, /^Swift tutorial/]]],
        [gn, R['generic-noun'], [[/^Bank of America/, /^River bank/], [/^River bank/, /^Bank holiday/], [/^Bank of America/, /^Bank holiday/], [/^Cell phone/, /^Cell biology/], [/^Cell biology/, /^Prison cell/], [/^Chicken coop/, /^Chicken soup/], [/^Chicken Little/, /^Chicken coop/], [/^Best pizza dough/, /^Chicken coop/],
          [/^Table tennis/, /^Table saw/], [/^Table saw/, /^Periodic table/], [/^Spring Boot/, /^Spring break/], [/^Spring break/, /^Spring cleaning/], [/^Best laptop/, /^Best hiking/], [/^Review: Dune/, /^Review of Roth/]]]];
      for (const [o, rows, list] of pairs) {
        for (const [a, b] of list) check(`r14b probe: ${a.source.replace(/\\/g, '')} and ${b.source.replace(/\\/g, '')} are not one group`, !o.same(find(rows, a), find(rows, b)), `${o.name(find(rows, a))}|${o.name(find(rows, b))}`);
      }
      check('r14b probe: a ball python, Java coffee and the island of Java are not Programming', ['Ball python', 'Java coffee', 'Visit Java'].every((t) => pa.name(find(R['python-ambiguity'], new RegExp(`^${t}`))) !== 'Programming'));
      const code = organized([['Python tutorial for beginners', 'https://alpha.example/a'], ['Python dataclasses', 'https://bravo.example/b'], ['JavaScript promises', 'https://charlie.example/c'], ['CSS grid guide', 'https://delta.example/d'], ['Java API error handling', 'https://echo.example/e']]);
      check('r14b programming: tutorials, an API and a language beside code words are still Programming', [1, 2, 3, 4].every((i) => code.same(0, i)) && code.name(0) === 'Programming', [0, 1, 2, 3, 4].map(code.name).join());
      const chick = organized([['Sheet pan chicken thighs', 'https://alpha.example/a'], ['Meal prep chicken burrito bowls', 'https://bravo.example/b'], ['How long does cooked chicken last', 'https://charlie.example/c'], ['Chicken coop plans', 'https://delta.example/d'], ['Rust ownership explained', 'https://echo.example/e']]);
      check('r14b probe: chicken in three cooking titles is still a group, and the coop is not in it', chick.same(0, 1) && chick.same(0, 2) && !chick.same(0, 3), [0, 1, 2, 3].map(chick.name).join());
    }
})().then(() => process.exit(failed ? 1 : 0));
