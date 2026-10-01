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
  check('31-tab bar: good names', /recipes|baking/i.test(nameOf(4)) && /dev|programming/i.test(nameOf(7)) && nameOf(7) === nameOf(11) && /school/i.test(nameOf(12)) && nameOf(12) === nameOf(23) && /mail/i.test(nameOf(15)) && nameOf(15) === nameOf(29) && /video/i.test(nameOf(16)), named.map((g) => g.name).join());
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
  check('irs.gov + dmv.ca.gov group as Government, not School', r.same(0, 1) && /^government$/i.test(r.name(0)), r.name(0));
  check('a .gov.uk page joins them', r.same(0, 2), r.name(2));
  check('.edu / .ac.uk / schoology still School', r.same(3, 4) && /school/i.test(r.name(3)) && !r.same(0, 3), `${r.name(3)} / ${r.name(4)}`);
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
  check('GOV.UK and .gov pages join the Government group, not one named "GOV"', gov.same(0, 1) && gov.same(0, 2) && gov.name(0) === 'Government' && !gov.same(0, 3), gov.name(0));
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
  check('the IRS among government pages (one money tab) stays Government', irs.same(0, 1) && irs.same(0, 2) && !irs.same(0, 3) && irs.name(0) === 'Government', irs.name(0));
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
}

process.exit(failed ? 1 : 0);
