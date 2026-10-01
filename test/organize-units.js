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

process.exit(failed ? 1 : 0);
