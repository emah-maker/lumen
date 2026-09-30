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

process.exit(failed ? 1 : 0);
