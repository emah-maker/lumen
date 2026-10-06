// Smarter page reading (src/ai/page-health.js, page-markdown.js, page-outline.js, page-reading.js): page-health
// classification, JSON-LD / data-island compaction, the HTML -> markdown converter, the outline walk (landmark link
// groups, repeated block, next page), read_urls max_chars / offset paging and the tool schemas. Plain Node: no
// window, no network. The page scripts are run against HTML strings through the small parser in page-markdown.js.
require('./_tmp-cleanup');
const health = require('../src/ai/page-health');
const { htmlToMarkdown, parseHtml } = require('../src/ai/page-markdown');
const { outlineDom, formatOutline } = require('../src/ai/page-outline');
const reading = require('../src/ai/page-reading');
const { ToolCallCache } = require('../src/ai/loop-guard');
const { validateInput, EXTERNAL_TOOLS } = require('../src/ai/agent');

let failed = 0;
let total = 0;
const check = (label, ok, detail = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const long = (n) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);

(async () => {
  // ---- page health
  const kind = (sig) => health.classifyPage(sig).kind;
  check('health: an ordinary article is ok', kind({ title: 'How kettles work', textHead: long(3000), textLen: 9000, scriptBytes: 90000, scriptCount: 12 }) === 'ok');
  check('health: tiny text + lots of script is a js_shell', kind({ title: 'App', textHead: 'Loading', textLen: 7, scriptBytes: 300000, scriptCount: 9 }) === 'js_shell');
  check('health: an empty root div is a js_shell', kind({ title: 'App', textHead: '', textLen: 0, rootEmpty: true }) === 'js_shell');
  check('health: a noscript notice is a js_shell', kind({ title: 'x', textHead: 'You need to enable JavaScript to run this app.', textLen: 45 }) === 'js_shell');
  check('health: little text with a big data island is a data_shell', kind({ title: 'Shop', textHead: 'Shop', textLen: 40, islandBytes: 90000, scriptBytes: 100000, scriptCount: 8 }) === 'data_shell');
  check('health: a password field on a short page is a wall (sign-in)', health.classifyPage({ title: 'Welcome', textHead: 'Email Password Forgot?', textLen: 120, hasPassword: true }).reason === 'sign-in');
  check('health: "log in to continue" is a sign-in wall', health.classifyPage({ title: 'x', textHead: 'Please log in to continue', textLen: 60 }).reason === 'sign-in');
  check('health: a paywall is a wall', health.classifyPage({ title: 'Story', textHead: `Subscribe to continue reading. ${long(300)}`, textLen: 400 }).reason === 'paywall');
  check('health: a bot check is a wall', health.classifyPage({ title: 'Just a moment...', textHead: 'Checking your browser before accessing', textLen: 60 }).reason === 'bot check');
  check('health: a captcha widget on a short page is a wall', health.classifyPage({ title: 'x', textHead: 'Hold on', textLen: 20, hasCaptcha: true }).reason === 'bot check');
  check('health: a captcha on a long page is not', kind({ title: 'Contact', textHead: long(2500), textLen: 3000, hasCaptcha: true }) === 'ok');
  check('health: a cookie wall is a wall', health.classifyPage({ title: 'x', textHead: 'Accept all cookies to continue', textLen: 40 }).reason === 'consent');
  check('health: "subscribe to continue" in a long article stays ok', kind({ title: 'Long read', textHead: `${long(2000)} subscribe to continue`, textLen: 12000 }) === 'ok');
  check('health: a 404 title with short text is soft_404', kind({ title: '404 - Page not found', textHead: 'Sorry', textLen: 200 }) === 'soft_404');
  check('health: "not found" in a long article is not soft_404', kind({ title: 'Why 404 pages matter', textHead: long(3000), textLen: 8000 }) === 'ok');
  check('health: ok has no line', health.healthLine({ kind: 'ok' }) === '');
  check('health: lines say what to do', /^Page: wall — sign-in required; try as_user$/.test(health.healthLine({ kind: 'wall', reason: 'sign-in' })) && /^Page: js_shell — /.test(health.healthLine({ kind: 'js_shell' })) && /^Page: soft_404/.test(health.healthLine({ kind: 'soft_404' })) && /embedded data below/.test(health.healthLine({ kind: 'data_shell' })));

  // ---- compaction
  const noisy = {
    '@context': 'https://schema.org', __typename: 'Product', name: 'Kettle', trackingParams: 'abc', image: `data:image/png;base64,${'A'.repeat(500)}`,
    blob: 'Q'.repeat(300), url: 'https://shop.example/k?utm_source=x&gclid=1&color=red', empty: null, list: [], blank: '',
    offers: { price: 19, deep: { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } } },
    reviews: Array.from({ length: 30 }, (_, i) => ({ text: `review ${i}` })),
    long: 'word '.repeat(200),
  };
  const compact = health.compactJson(noisy, 3000);
  const back = JSON.parse(compact);
  check('compact: drops @context, __typename, tracking keys, base64, empty values', !('@context' in back) && !('__typename' in back) && !('trackingParams' in back) && !('image' in back) && !('blob' in back) && !('empty' in back) && !('list' in back) && !('blank' in back), compact);
  check('compact: strips tracking params from URLs, keeps real ones', back.url === 'https://shop.example/k?color=red', back.url);
  check('compact: caps depth, array length and string length', JSON.stringify(back.offers).includes('{…}') || JSON.stringify(back.offers).includes('"price":19'), JSON.stringify(back.offers));
  check('compact: arrays are cut with a count of the rest', back.reviews.length <= 9 && /more\)$/.test(back.reviews.at(-1)), JSON.stringify(back.reviews));
  check('compact: long strings are clipped', back.long.length <= 201 && back.long.endsWith('…'));
  check('compact: stays inside the budget', health.compactJson({ a: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `n${i}`.repeat(10) })) }, 500).length <= 501);
  check('compact: nothing left -> empty string', health.compactJson({ a: null, b: '' }) === '');
  const yt = health.extractAssignedJson(`<x>var a=1;var ytInitialData = {"t":"a } { \\" b","n":{"k":[1,2,{"z":3}]}};var ytInitialPlayerResponse = {}; window.other=1`, ['ytInitialData']);
  check('data island: the assigned object is found with string-aware braces', yt?.name === 'ytInitialData' && JSON.parse(yt.text).n.k[2].z === 3, JSON.stringify(yt));
  check('data island: window.__NUXT__ = {...} and a miss', health.extractAssignedJson('window.__NUXT__={"data":{"a":1}};', ['__NUXT__'])?.name === '__NUXT__' && health.extractAssignedJson('var foo = {"a":1}', ['__NUXT__']) === null);

  const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', headline: 'Kettles', author: { '@type': 'Person', name: 'Ann' }, datePublished: '2026-01-02' }, { '@type': 'BreadcrumbList', itemListElement: [{ name: 'Home' }, { name: 'Kettles' }] }] });
  const next = JSON.stringify({ props: { pageProps: { products: [{ id: 1, title: 'Kettle', price: 19 }], __N_SSP: true }, buildId: 'zzz' }, page: '/p', query: {} });
  const raw = { meta: { description: 'All about kettles', 'og:type': 'article', 'article:published_time': '2026-01-02', canonical: 'https://e.com/k' }, jsonld: [ld, '{not json'], islands: [{ name: '__NEXT_DATA__', bytes: 90000, text: next }, { name: 'bad', bytes: 3000, text: '{oops' }] };
  const structured = health.formatStructured(raw, { islands: 3, budget: 4000 });
  check('structured: meta, JSON-LD entities and the unwrapped data island', /^Structured data:/.test(structured) && structured.includes('description: All about kettles') && structured.includes('JSON-LD Article:') && structured.includes('JSON-LD BreadcrumbList:') && structured.includes('"title":"Kettle"') && structured.includes('__NEXT_DATA__ (88 KB') && !structured.includes('buildId') && !structured.includes('__N_SSP') && !structured.includes('oops'), structured);
  check('structured: an ordinary page gets no islands', !health.formatStructured(raw, { islands: 0 }).includes('__NEXT_DATA__'));
  check('structured: nothing -> empty string', health.formatStructured({}) === '' && health.formatStructured({ meta: {}, jsonld: ['{x'] }) === '');
  check('structured: stays inside the budget', health.formatStructured({ islands: [{ name: 'a', bytes: 9e4, text: JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ k: `value ${i}` })) }) }] }, { islands: 3, budget: 800 }).length <= 801);
  const sum = health.summarizeStructured(raw);
  check('structured: the outline digest names types, headline and islands', /JSON-LD: Article "Kettles", BreadcrumbList/.test(sum) && /og:type article/.test(sum) && /__NEXT_DATA__ 88 KB \(page, query, products\)/.test(sum), sum);

  // ---- markdown
  const base = 'https://example.com/blog/post/';
  const md = htmlToMarkdown(`<div><h1>Kettles &amp; how</h1><p>Read <a href="/x?a=1&amp;b=2">this guide</a>, <a href="#top">top</a>, <a href="javascript:void(0)">js</a> and <strong>stay</strong> <em>calm</em> with <code>boil()</code>.<br>Next line</p>
    <h2>Steps</h2><ol><li>Fill<ul><li>cold water</li></ul></li><li>Heat<li>Pour</ol><ul><li>one</li><li><p>two</p></li></ul>
    <pre><code class="language-js">const a = 1;\n  if (a) { go(); }</code></pre><blockquote><p>Quote text</p></blockquote>
    <table><thead><tr><th>Name</th><th>Watts</th></tr></thead><tbody><tr><td>A | B</td><td>1500</td></tr><tr><td>C</td><td></td></tr></tbody></table>
    <img src="x.png" alt="pic"><script>evil()</script><style>p{}</style><hr><p>Last&nbsp;one</p></div>`, { baseUrl: base });
  check('markdown: headings', md.startsWith('# Kettles & how\n\n') && md.includes('\n\n## Steps\n\n'), md);
  check('markdown: links are absolute, empty/js/anchor links keep only their text', md.includes('[this guide](https://example.com/x?a=1&b=2)') && !md.includes('javascript') && !md.includes('#top') && md.includes('top, js and'), md);
  check('markdown: bold, italic, inline code, br', md.includes('**stay** *calm*') && md.includes('`boil()`') && md.includes('.\nNext line'), md);
  check('markdown: ordered, nested and unclosed list items', md.includes('1. Fill\n   - cold water\n2. Heat\n3. Pour') && md.includes('- one\n- two'), md);
  check('markdown: fenced code keeps its language and indentation', md.includes('```js\nconst a = 1;\n  if (a) { go(); }\n```'), md);
  check('markdown: blockquote and rule', md.includes('> Quote text') && md.includes('\n---\n'), md);
  check('markdown: simple table, pipes escaped, ragged rows padded', md.includes('| Name | Watts |\n| --- | --- |\n| A \\| B | 1500 |\n| C |  |'), md);
  check('markdown: no scripts, styles or images; entities decoded', !md.includes('evil') && !md.includes('p{}') && !md.includes('pic') && md.includes('Last one'), md);
  check('markdown: empty input', htmlToMarkdown('') === '' && htmlToMarkdown('<div> </div>') === '');
  check('markdown: a code fence longer than any backtick run inside', htmlToMarkdown('<pre>a ``` b</pre>').startsWith('````\n'));

  // ---- outline
  const PAGE = `<html><body>
    <header><a href="/">Home</a><a href="/login">Sign in</a></header>
    <nav><ul>${Array.from({ length: 6 }, (_, i) => `<li><a href="/c/${i}">Category ${i}</a></li>`).join('')}</ul></nav>
    <main id="content"><h1>Search results</h1><h2>Filters</h2><h3>Brand</h3><h4>skipped</h4>
      <ul class="results">${Array.from({ length: 20 }, (_, i) => `<li class="result"><a href="/item/${i}">Kettle model number ${i}</a><span>$${i}</span></li>`).join('')}</ul>
      <p><a href="https://other.example/ref">External reference</a></p>
      <div class="pager"><a href="/search?q=k&page=1">1</a><a href="/search?q=k&page=2">2</a><a href="/search?q=k&page=3">3</a></div>
    </main>
    <aside><a href="/ad">Sponsored</a><div hidden><a href="/hidden">Hidden</a></div></aside>
    <footer><a href="/about">About</a><a href="/privacy">Privacy</a><a href="mailto:a@b.c">Mail</a></footer>
  </body></html>`;
  const out = outlineDom(parseHtml(PAGE), { href: 'https://shop.example/search?q=k' });
  const g = Object.fromEntries(out.groups.map((x) => [x.region, x]));
  check('outline: h1-h3 only, in order', out.headings.map((h) => `${h.level}:${h.text}`).join('|') === '1:Search results|2:Filters|3:Brand', JSON.stringify(out.headings));
  check('outline: links grouped by landmark with counts', g.main.count === 24 && g.nav.count === 6 && g.header.count === 2 && g.footer.count === 2 && g.aside.count === 1, JSON.stringify(out.groups.map((x) => [x.region, x.count])));
  check('outline: same-origin links are paths, others absolute; mailto and hidden links are left out', g.main.links[0].href === '/item/0' && g.main.links.some((l) => l.href === 'https://other.example/ref') && !JSON.stringify(out.groups).includes('mailto') && !JSON.stringify(out.groups).includes('Hidden'));
  check('outline: repeated block described with its path and a sample', out.repeat?.count === 20 && out.repeat.path === 'main#content > ul.results' && out.repeat.tag === 'li' && out.repeat.sample.startsWith('Kettle model number 0'), JSON.stringify(out.repeat));
  check('outline: next page found by page=N+1', out.next?.href === 'https://shop.example/search?q=k&page=2', JSON.stringify(out.next));
  const text = formatOutline(out, { title: 'Kettles', url: 'https://shop.example/search?q=k', healthLine: '', structured: 'Structured data: JSON-LD: ItemList' });
  const order = ['main (24)', 'aside (1)', 'nav (6)', 'header (2)', 'footer (2)'].map((s) => text.indexOf(s));
  check('outline: content groups come before page chrome', order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]), text);
  check('outline: at most 15 links per group, with the count of the rest', (text.match(/^- .* → \/item\//gm) || []).length === 15 && text.includes('(+9 more)'), text);
  check('outline: wrapped as untrusted content with headings, repeat and next', text.startsWith('<untrusted_page_content>') && text.endsWith('</untrusted_page_content>') && text.includes('# Search results\n  ## Filters\n    ### Brand') && text.includes("Repeated block: main#content > ul.results: 20 items like 'Kettle model number 0") && text.includes('Next page: [2](https://shop.example/search?q=k&page=2)') && text.includes('Structured data: JSON-LD: ItemList'), text);
  const rel = outlineDom(parseHtml('<main><a href="/b" rel="next">Older stuff</a><a href="/a">A</a></main>'), { href: 'https://e.com/a' });
  check('outline: rel=next wins', rel.next?.href === 'https://e.com/b' && rel.repeat === null);
  const word = outlineDom(parseHtml('<main><a href="/more">Next ›</a><a class="disabled" href="/x">Next</a></main>'), { href: 'https://e.com/a' });
  check('outline: a "Next" link is found by its text; a disabled one is not', word.next?.href === 'https://e.com/more', JSON.stringify(word.next));
  const path = outlineDom(parseHtml('<main><a href="/blog/page/3/">3</a><a href="/blog/page/4/">4</a></main>'), { href: 'https://e.com/blog/page/3/' });
  check('outline: /page/N+1 in the path', path.next?.href === 'https://e.com/blog/page/4/', JSON.stringify(path.next));
  check('outline: no next link -> null', outlineDom(parseHtml('<main><a href="/x">x</a></main>'), { href: 'https://e.com/' }).next === null);
  const menu = outlineDom(parseHtml(`<nav><ul>${Array.from({ length: 5 }, (_, i) => `<li><a href="/${i}">Item ${i}</a></li>`).join('')}</ul></nav><main><div>${Array.from({ length: 4 }, (_, i) => `<article class="card"><h3>Card ${i} headline</h3></article>`).join('')}</div></main>`), { href: 'https://e.com/' });
  check('outline: a content repeat beats a nav menu', menu.repeat?.tag === 'article' && menu.repeat.count === 4, JSON.stringify(menu.repeat));
  check('outline: three similar items are not a repeat', outlineDom(parseHtml('<main><ul><li>First item here</li><li>Second item here</li><li>Third item here</li></ul></main>'), { href: 'https://e.com/' }).repeat === null);
  check('outline: a header inside an article is the article\'s, not the page header', (() => { const o = outlineDom(parseHtml('<article><header><a href="/a">By Ann</a></header></article>'), { href: 'https://e.com/' }); return o.groups.length === 1 && o.groups[0].region === 'article'; })());
  check('outline: ARIA roles name regions', (() => { const o = outlineDom(parseHtml('<div role="navigation"><a href="/a">A</a></div><div role="contentinfo"><a href="/b">B</a></div>'), { href: 'https://e.com/' }); return o.groups.map((x) => x.region).sort().join() === 'footer,nav'; })());

  // ---- paging
  const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'); // ~9.8k chars
  const first = health.slicePage(body, {});
  check('paging: defaults to 8000 chars, cut at a line end, says how to continue', first.from === 0 && first.to <= 8000 && first.to > 7000 && body[first.to] === '\n' && first.more && first.note.includes(`offset: ${first.to}`) && first.note.includes(`of ${body.length}`), first.note);
  const second = health.slicePage(body, { offset: first.to });
  check('paging: the next chunk starts where the last ended and is the end', second.from === first.to && !second.more && first.text + second.text === body.slice(0, second.to) && second.to === body.length && /the end\]/.test(second.note), second.note);
  check('paging: max_chars is clamped to 1000-30000', health.slicePage(body, { maxChars: 10 }).to <= 1000 && health.clampChars(10) === 1000 && health.clampChars(99999) === 30000 && health.clampChars(undefined) === 8000 && health.clampChars('x') === 8000);
  check('paging: a short page has no note, an offset past the end is empty', health.slicePage('hi', {}).note === '' && health.slicePage('hi', { offset: 50 }).text === '');
  check('paging: a bigger max_chars shows more', health.slicePage(body, { maxChars: 30000 }).text === body);

  // ---- a whole read
  const articleHtml = `<div><h2>Kettles</h2>${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} ${long(120)} <a href="/more/${i}">more</a></p>`).join('')}</div>`;
  const rawArticle = { url: 'https://e.com/post', title: 'Kettles', text: `${long(2400)}\nSkip to content\nFooter`, textLen: 2430, article: { title: 'Kettles', byline: 'Ann', content: articleHtml }, probe: { scriptCount: 4, scriptBytes: 5000, meta: { description: 'About kettles' }, jsonld: [], islands: [] } };
  const read = reading.finishRead(rawArticle, {});
  check('read: a readerable page comes back as markdown with its byline, no health line', read.article && read.health === 'ok' && read.text.startsWith('By Ann\n\n## Kettles') && read.text.includes('[more](https://e.com/more/0)') && !read.text.includes('Page:') && !read.text.includes('Skip to content'), read.text.slice(0, 200));
  check('read: meta shows in a compact structured section', read.text.endsWith('Structured data:\nmeta: description: About kettles'), read.text.slice(-120));
  const plain = reading.finishRead({ ...rawArticle, article: null }, {});
  check('read: without an article the plain text is used', !plain.article && plain.text.startsWith('lorem ipsum') && plain.text.includes('Skip to content'));
  const tiny = reading.finishRead({ ...rawArticle, article: { title: 'x', byline: '', content: '<p>short</p>' } }, {});
  check('read: an article that lost most of the page is not trusted', !tiny.article);
  const shell = reading.finishRead({ url: 'https://spa.example/', title: 'Shop', text: 'Shop', textLen: 4, article: null, probe: { scriptCount: 9, scriptBytes: 200000, islandBytes: 50000, meta: {}, jsonld: [], islands: [{ name: '__NEXT_DATA__', bytes: 50000, text: next }] } }, {});
  check('read: a data shell says so and shows the data after the text', shell.health === 'data_shell' && shell.text.startsWith('Page: data_shell — ') && shell.text.includes('data __NEXT_DATA__') && shell.text.includes('"title":"Kettle"'), shell.text);
  const wall = reading.finishRead({ url: 'https://x.example/', title: 'Sign in', text: 'Please log in to continue', textLen: 25, article: null, probe: { hasPassword: true } }, {});
  check('read: a wall says what to try', wall.text.startsWith('Page: wall — sign-in required; try as_user'), wall.text);
  const big = { ...rawArticle, article: null, text: body, textLen: body.length };
  const c1 = reading.finishRead(big, { maxChars: 3000 });
  const c2 = reading.finishRead(big, { maxChars: 3000, offset: 3000 });
  check('read: max_chars and offset slice the read, the note names the next offset', /\[chars 0-\d+ of \d+; for the next chunk call read_urls again with offset: \d+\]/.test(c1.text) && c1.text.length < 3400, c1.text.slice(-120));
  check('read: a later chunk repeats neither the health line nor the structured data', c2.text.length > 0 && !c2.text.includes('Structured data') && !c2.text.includes('Page:'), c2.text.slice(0, 80));
  const dup = reading.finishRead(big, { offset: 1 });
  check('read: offset 1 is not the first chunk', !dup.text.includes('Structured data'));

  // ---- in-page scripts: they must compile, and the probe must read a (fake) document
  for (const [name, code] of [['probe', reading.probeScript(true)], ['outline', reading.outlineScript()], ['background', reading.backgroundReadScript()]]) {
    let ok = true; let err = '';
    try { new Function(`return ${code}`); } catch (e) { ok = false; err = e.message; }
    check(`scripts: the ${name} script is valid JavaScript`, ok, err);
  }
  const el = (props) => ({ type: '', id: '', src: '', textContent: '', getAttribute: () => null, ...props });
  const fakeDoc = {
    scripts: [el({ textContent: 'x'.repeat(3000) }), el({ type: 'application/json', id: '__NEXT_DATA__', textContent: next.padEnd(2100, ' ') }), el({ type: 'application/ld+json', textContent: ld }), el({ textContent: `window.ytInitialData = {"a":"${'b'.repeat(2100)}"};` })],
    getElementById: (id) => (id === 'root' ? { textContent: '  ', children: [] } : null),
    querySelector: () => null,
    querySelectorAll: (sel) => (/ld\+json/.test(sel) ? [el({ textContent: ld })] : /meta/.test(sel) ? [{ getAttribute: (k) => ({ property: 'og:title', content: 'T' })[k] || null }, { getAttribute: (k) => ({ name: 'viewport', content: 'x' })[k] || null }] : []),
  };
  const probe = new Function('document', `return ${reading.probeScript(true)}`)(fakeDoc);
  check('probe: counts scripts, sees the empty root, finds the biggest data island', probe.scriptCount === 4 && probe.rootEmpty && probe.islandBytes >= 2100 && probe.islands.map((i) => i.name).sort().join() === '__NEXT_DATA__,ytInitialData', JSON.stringify(probe).slice(0, 300));
  check('probe: JSON-LD and wanted meta only', probe.jsonld.length === 1 && probe.meta['og:title'] === 'T' && !('viewport' in probe.meta), JSON.stringify(probe.meta));
  const cheap = new Function('document', `return ${reading.probeScript(false)}`)(fakeDoc);
  check('probe: without data it sends no islands', !('islands' in cheap) && cheap.islandBytes >= 2100);

  // ---- tools
  check('tools: read_urls accepts max_chars and offset, refuses a string', validateInput('read_urls', { urls: ['https://e.com'], max_chars: 20000, offset: 8000 }) === null && /max_chars/.test(validateInput('read_urls', { urls: ['https://e.com'], max_chars: '5' }) || ''));
  check('tools: read_page accepts mode outline and structured', validateInput('read_page', { mode: 'outline' }) === null && validateInput('read_page', { mode: 'full', structured: true }) === null && validateInput('read_page', { mode: 'bogus' }) !== null);
  const slim = (name) => EXTERNAL_TOOLS.find((t) => t.name === name).input_schema.properties;
  check('tools: the slim listing leaves the paging options out', !('max_chars' in slim('read_urls')) && !('offset' in slim('read_urls')) && !('structured' in slim('read_page')) && 'urls' in slim('read_urls') && 'as_user' in slim('read_urls'));
  check('tools: the slim read_page mode lists outline', slim('read_page').mode.enum.includes('outline'));
  const cache = new ToolCallCache();
  const key = (input) => cache.keyOf({ name: 'read_urls', input }, '');
  check('cache: max_chars and offset are part of the cache key', key({ urls: ['a'] }) !== key({ urls: ['a'], offset: 8000 }) && key({ urls: ['a'], offset: 8000 }) !== key({ urls: ['a'], offset: 16000 }) && key({ urls: ['a'], max_chars: 3000 }) !== key({ urls: ['a'] }));
  let runs = 0;
  await cache.run({ name: 'read_urls', input: { urls: ['a'], offset: 0 } }, '', async () => { runs++; return 'one'; });
  await cache.run({ name: 'read_urls', input: { urls: ['a'], offset: 8000 } }, '', async () => { runs++; return 'two'; });
  check('cache: the next chunk is a real call, not "same as before"', runs === 2);

  console.log(`${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
