// analyze_posts (ai/post-analysis.js), its place in the tool list, and the built-in research skills (features/skills.js).
// Plain Node: no Electron, no network.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const pa = require('../src/ai/post-analysis');
const skills = require('../src/features/skills');
const { EXTERNAL_TOOLS, validateInput } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const rows = (account, values, extra = {}) => values.map((v, i) => ({ url: `https://x.test/${account}/${i}`, account, views: v, ...extra }));
const find = (r, url) => r.outliers.find((o) => o.url === url);

// medians and lift
check('median: odd, even, empty', pa.median([3, 1, 2]) === 2 && pa.median([1, 2, 3, 4]) === 2.5 && pa.median([]) === 0);
const base = pa.analyze({ posts: [...rows('a', Array(9).fill(100)), { url: 'hit', account: 'a', views: 700 }] });
check('baseline is the account median and lift = value / baseline', base.accounts[0].baseline === 100 && find(base, 'hit').lift === 7, J(base.accounts));
check('huge is >= 5x', find(base, 'hit').label === 'huge');
const lab = (v) => find(pa.analyze({ posts: [...rows('a', Array(9).fill(100)), { url: 'p', account: 'a', views: v }] }), 'p');
check('labels at the thresholds: 5x huge, 2x strong, 1.5x mild, below that nothing', lab(500).label === 'huge' && lab(499).label === 'strong' && lab(200).label === 'strong' && lab(199).label === 'mild' && lab(150).label === 'mild' && lab(149) === undefined, J([lab(500), lab(200), lab(150), lab(149)]));
const sorted = pa.analyze({ posts: [...rows('a', Array(9).fill(100)), { url: 'p1', account: 'a', views: 300 }, { url: 'p2', account: 'a', views: 900 }] });
check('outliers are sorted by lift', sorted.outliers.map((o) => o.url).join() === 'p2,p1', J(sorted.outliers.map((o) => o.url)));

// per account and per format
const two = pa.analyze({ posts: [...rows('a', Array(10).fill(100)), ...rows('b', Array(10).fill(1000)), { url: 'bhit', account: 'b', views: 3400 }] });
check('each account has its own baseline', two.accounts.find((a) => a.account === 'a').baseline === 100 && two.accounts.find((a) => a.account === 'b').baseline === 1000 && find(two, 'bhit').lift === 3.4, J(two.accounts));
const fm = pa.analyze({ posts: [...rows('a', Array(5).fill(1000), { format: 'reel' }), ...rows('a', Array(5).fill(100), { format: 'photo' }), { url: 'ph', account: 'a', format: 'photo', views: 500 }] });
check('with 5+ rows of a format, that format has its own baseline', fm.accounts[0].formats.length === 2 && find(fm, 'ph').lift === 5 && find(fm, 'ph').scope === 'photo', J(fm.outliers));
const fm2 = pa.analyze({ posts: [...rows('a', Array(4).fill(1000), { format: 'reel' }), ...rows('a', Array(5).fill(100), { format: 'photo' })] });
check('with fewer than 5 rows of a format, the account baseline is used', fm2.accounts[0].formats.length === 1 && fm2.accounts[0].formats[0].format === 'photo', J(fm2.accounts));

// metrics
const txt = pa.analyze({ posts: [...Array.from({ length: 9 }, (_, i) => ({ url: `t${i}`, account: 'a', likes: 5, replies: 3, reposts: 2 })), { url: 'big', account: 'a', likes: 50, replies: 20, reposts: 10, comments: 5, shares: 5 }] });
check('auto picks engagement when most rows have no views', txt.metric === 'engagement' && find(txt, 'big').value === 90 && find(txt, 'big').lift === 9, J(txt.outliers));
check('auto picks views when most rows have them', base.metric === 'views');
check('metric can be forced', pa.analyze({ posts: [{ url: 'u', views: 10, likes: 1 }, { url: 'v', views: 20, likes: 1 }], metric: 'engagement' }).metric === 'engagement');
check('raw metrics are kept', find(txt, 'big').raw.likes === 50 && find(txt, 'big').raw.shares === 5 && /likes 50/.test(pa.render(txt)));

// confidence, missing data, zero baseline
check('under 10 rows is low confidence, 10 is not', two.accounts.find((a) => a.account === 'a').low === false && pa.analyze({ posts: rows('z', [1, 2, 3]) }).accounts[0].low === true);
const miss = pa.analyze({ posts: [...rows('a', Array(10).fill(100)), { url: 'nometric', account: 'a' }, { url: 'neg', account: 'a', views: -5 }] });
check('rows with no usable metric are skipped and named', miss.notes.some((n) => /2 rows have no views/.test(n)) && miss.accounts[0].n === 10, J(miss.notes));
const zero = pa.analyze({ posts: [...rows('a', Array(9).fill(0)), { url: 'z', account: 'a', views: 50 }] });
check('a zero baseline gives no lift (and a note), not Infinity', zero.outliers.length === 0 && zero.notes.some((n) => /baseline is 0/.test(n)), J(zero));
check('numeric strings count, junk does not', pa.analyze({ posts: [{ url: 'a', views: '1200' }, { url: 'b', views: 'lots' }, null, 'x'], metric: 'views' }).accounts[0].n === 1);
check('empty or wrong input is an error, not a throw', pa.analyze({}).error && pa.analyze({ posts: [] }).error && pa.analyze(null).error && pa.analyze({ posts: [{ url: 'a' }], metric: 'bogus' }).error && /^Error/.test(pa.run({ posts: 'x' })));
const big = pa.analyze({ posts: Array.from({ length: 250 }, (_, i) => ({ url: `u${i}`, account: 'a', views: 10 })) });
check('rows beyond the cap of 200 are ignored with a note', big.rows === 200 && big.notes.some((n) => /250 rows given; only the first 200/.test(n)), J(big.notes));

// output
const out = pa.run({ posts: [...rows('alpha', Array(9).fill(1000)), { url: 'https://x.test/hit', account: '@alpha', views: 3400 }, { url: 'few', account: 'beta', views: 5 }] });
check('output: baseline line per account, then outliers with url, metric, lift and label', /^views baselines/.test(out) && /@alpha: 1000 \(n=10\)/.test(out) && /1\. https:\/\/x\.test\/hit \| @alpha \| views 3400 \| ×3\.4 strong/.test(out), out);
check('output: low-confidence account and Not enough data notes', /@beta: 5 \(n=1, low confidence\)/.test(out) && /Not enough data:/.test(out), out);
check('output stays compact', pa.run({ posts: Array.from({ length: 200 }, (_, i) => ({ url: `https://x.test/${i}`, account: `a${i % 4}`, views: i % 17 === 0 ? 100000 : 1000 })) }).length < 20000);
check('no outliers is said plainly', /No outliers/.test(pa.run({ posts: rows('a', Array(10).fill(100)) })));
check('numbers are shortened', pa.fmt(1500) === '1500' && pa.fmt(12345) === '12.3K' && pa.fmt(2500000) === '2.5M');

// the tool
const tool = EXTERNAL_TOOLS.find((t) => t.name === 'analyze_posts');
check('analyze_posts is in the tool list every engine gets, with a short description', tool && tool.description.length <= 90 && J(tool).length < 600, tool && J(tool).length);
check('its input is validated', !validateInput('analyze_posts', { posts: [{ url: 'u', views: 1 }] }) && Boolean(validateInput('analyze_posts', {})) && Boolean(validateInput('analyze_posts', { posts: [{ views: 1 }] })) && Boolean(validateInput('analyze_posts', { posts: [{ url: 'u' }], metric: 'likes' })) && Boolean(validateInput('analyze_posts', { posts: 'x' })));

// the research skills
const RECIPES = ['comment-mining', 'competitor-brief', 'outlier-finder', 'transcript-breakdown', 'social-listening'];
for (const name of RECIPES) {
  const b = skills.BUILTINS.find((x) => x.name === name);
  const n = b && skills.normalizeSkill({ ...b, source: 'builtin' });
  const words = b ? b.prompt.split(/\s+/).length : 0;
  check(`skill /${name}: valid, about 120 words, uses tools, takes a target`, Boolean(n && n.ok) && words >= 60 && words <= 140 && b.mode === 'agent' && b.inputRequired === true && /\{\{input\}\}/.test(b.prompt), `${words} ${n && n.error}`);
  check(`skill /${name}: never fabricates and keeps sources`, /never|do not|not invent|nothing/i.test(b.prompt) && /URL|source|link/i.test(b.prompt));
}
const prompt = (name) => skills.BUILTINS.find((x) => x.name === name).prompt;
check('recipes name the tools they rely on', /analyze_posts/.test(prompt('competitor-brief')) && /analyze_posts/.test(prompt('outlier-finder')) && /web_search/.test(prompt('social-listening')));
check('every built-in name is unique and not reserved', new Set(skills.BUILTINS.map((b) => b.name)).size === skills.BUILTINS.length && skills.BUILTINS.every((b) => !skills.RESERVED.has(b.name)));

process.exit(failures ? 1 : 0);
