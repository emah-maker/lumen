// Per-site readers (src/ai/site-extractors.js), plain Node: URL matching, Reddit JSON / RSS / page parsing, comment
// flattening and budgets, Hacker News, YouTube caption choice and transcripts, X tokens and tweets, TikTok, GitHub, and
// falling back (null) on any failure. Fixtures only: no network, no Electron.
require('./_tmp-cleanup');
const se = require('../src/ai/site-extractors');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const NOW = Date.parse('2026-10-06T12:00:00Z');
const res = (status, text, extra = {}) => ({ ok: status >= 200 && status < 300, status, text, url: '', ...extra });
// A fake `get` that answers by URL prefix from a table and records the calls.
const router = (table) => {
  const calls = [];
  const get = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    for (const [prefix, answer] of Object.entries(table)) {
      if (url.startsWith(prefix)) { const a = typeof answer === 'function' ? await answer(url, opts, calls) : answer; if (a instanceof Error) throw a; return a; }
    }
    return res(404, '');
  };
  return { get, calls };
};
const run = (url, table, o = {}) => { const r = router(table); return se.readSite(url, { get: r.get, now: () => NOW, sleep: async () => {}, ...o }).then((out) => ({ out, calls: r.calls })); };

(async () => {
  // 1) URL matching
  {
    const yes = ['https://www.reddit.com/r/programming/comments/abc123/some_title/', 'https://old.reddit.com/r/rust/', 'https://reddit.com/r/rust/top/?t=week', 'https://www.reddit.com/user/spez', 'https://www.reddit.com/search/?q=electron',
      'https://news.ycombinator.com/item?id=8863', 'https://news.ycombinator.com/', 'https://news.ycombinator.com/ask',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=5', 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://x.com/jack/status/20', 'https://twitter.com/jack/status/20?s=20', 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
      'https://github.com/electron/electron', 'https://github.com/electron/electron/issues/1', 'https://github.com/electron/electron/pull/22'];
    const no = ['https://www.reddit.com/settings', 'https://www.reddit.com/', 'https://www.reddit.com/r/rust/wiki/index', 'https://www.reddit.com/user/spez/settings', 'https://www.reddit.com/search',
      'https://news.ycombinator.com/login', 'https://news.ycombinator.com/item', 'https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://www.youtube.com/watch', 'https://www.youtube.com/playlist?list=PL1',
      'https://x.com/jack', 'https://x.com/home', 'https://www.tiktok.com/@scout2015', 'https://github.com/', 'https://github.com/settings/profile', 'https://github.com/electron', 'https://github.com/electron/electron/blob/main/README.md', 'https://github.com/orgs/electron/people',
      'https://example.com/r/rust/', 'https://notreddit.com/r/rust/', 'https://reddit.com.evil.test/r/rust/', 'ftp://reddit.com/r/rust/', 'not a url', ''];
    for (const u of yes) check(`matches ${u}`, Boolean(se.extractorFor(u)), String(se.extractorFor(u)));
    for (const u of no) check(`does not match ${u || '(empty)'}`, se.extractorFor(u) === null);
    check('names', se.extractorFor(yes[0]).name === 'reddit' && se.extractorFor('https://youtu.be/dQw4w9WgXcQ').name === 'youtube' && se.extractorFor('https://x.com/a/status/1').name === 'x');
    const t = se.redditTarget('https://www.reddit.com/r/rust/top/?t=week&utm=1');
    const reqs = se.redditRequests(t);
    check('reddit order json -> old rss -> www rss', reqs.length === 3 && /^https:\/\/www\.reddit\.com\/r\/rust\/top\.json\?/.test(reqs[0].url) && /old\.reddit\.com\/r\/rust\/top\/\.rss/.test(reqs[1].url) && /^https:\/\/www\.reddit\.com\/r\/rust\/top\/\.rss/.test(reqs[2].url), JSON.stringify(reqs.map((r) => r.url)));
    check('reddit keeps sort query, drops tracking', /t=week/.test(reqs[0].url) && !/utm/.test(reqs[0].url) && /raw_json=1/.test(reqs[0].url));
  }

  // 2) helpers
  {
    check('fmtCount', se.fmtCount(950) === '950' && se.fmtCount(1234) === '1.2k' && se.fmtCount(10400) === '10.4k' && se.fmtCount(123456) === '123k' && se.fmtCount(2500000) === '2.5M' && se.fmtCount(2000) === '2k');
    check('ago', se.ago(NOW - 3 * 3600e3, NOW) === '3h' && se.ago(NOW - 90e3, NOW) === '1m' && se.ago(NOW - 5 * 86400e3, NOW) === '5d' && se.ago('bad', NOW) === '');
    const t = se.htmlToText('<div class="md"><p>Hello &amp; <a href="https://a.test/x">link</a></p>\n<p>second<br>line <a href="https://b.test">https://b.test</a></p><ul><li>one</li><li>two</li></ul></div>');
    check('htmlToText', t.includes('Hello & link (https://a.test/x)') && t.includes('second\nline https://b.test') && t.includes('- one') && !t.includes('<'), JSON.stringify(t));
  }

  // 3) Reddit JSON: post header, selftext, flattened comments, flags, more markers, budget
  const comment = (author, body, score, depth, replies, extra = {}) => ({ kind: 't1', data: { author, body, score, depth, created_utc: NOW / 1000 - 7200, replies: replies ? { data: { children: replies } } : '', ...extra } });
  const thread = [
    { data: { children: [{ kind: 't3', data: { name: 't3_abc', title: 'Why &amp; how', subreddit: 'rust', author: 'opuser', score: 1234, num_comments: 57, created_utc: NOW / 1000 - 3 * 3600, link_flair_text: 'Discussion', over_18: true, is_self: true, selftext: 'Self text here.', permalink: '/r/rust/comments/abc/why/', domain: 'self.rust', url: 'https://www.reddit.com/r/rust/comments/abc/why/' } }] } },
    { data: { children: [
      comment('opuser', 'OP edit: thanks all', 400, 0, [comment('bob', 'Reply to OP\nsecond para', 12, 1, [comment('carol', 'deep reply', 3, 2, null)])], { is_submitter: true }),
      comment('AutoModerator', 'Please read the rules', 1, 0, null, { distinguished: 'moderator', stickied: true }),
      { kind: 'more', data: { count: 5, children: ['x'], depth: 0 } },
    ] } },
  ];
  {
    const m = se.parseRedditJson(JSON.stringify(thread));
    check('reddit json: thread parsed', m.type === 'thread' && m.post.title === 'Why & how' && m.comments.length === 5, JSON.stringify(m.comments.map((c) => c.depth)));
    const out = se.formatRedditThread(m, 'json', { now: NOW, maxChars: 4000 });
    const lines = out.text.split('\n');
    check('reddit json: source line first', lines[0] === 'Source: reddit (json)', lines[0]);
    check('reddit json: header', lines[1] === 'r/rust · u/opuser · 1.2k pts · 57 comments · 3h ago · flair: Discussion · NSFW', lines[1]);
    check('reddit json: selftext', out.text.includes('\nSelf text here.\n'));
    check('reddit json: comment lines', out.text.includes('[d0] u/opuser (OP) 400 · 2h: OP edit: thanks all') && out.text.includes('[d1] u/bob 12 · 2h: Reply to OP ¶ second para') && out.text.includes('[d2] u/carol 3 · 2h: deep reply'), out.text);
    check('reddit json: mod / pinned flags', out.text.includes('u/AutoModerator (mod, pinned) 1 · 2h: Please read the rules'));
    check('reddit json: more replies marker', out.text.includes('[d0] +5 more replies'));
    // budget: deep levels dropped first, then a note
    const tight = se.formatRedditThread(m, 'json', { now: NOW, maxChars: 420 });
    check('reddit json: tight budget stays inside', tight.text.length <= 420, String(tight.text.length));
    const mid = se.renderComments(m.comments, 190, { now: NOW });
    check('budget: drops deepest levels first with a count', !mid.lines.some((l) => l.includes('[d2]')) && /replies deeper than d\d not shown/.test(mid.omitted), JSON.stringify(mid));
    const many = Array.from({ length: 200 }, (_, i) => ({ depth: 0, author: `u${i}`, text: 'x'.repeat(100), flags: [] }));
    const cut = se.renderComments(many, 2000, {});
    check('budget: tail cut counts the rest', cut.lines.join('\n').length <= 2000 && /more comments not shown/.test(cut.omitted) && cut.lines.length < 200);
    const long = se.renderComments([{ depth: 0, author: 'a', text: 'y'.repeat(2000), flags: [] }], 5000, {});
    check('per-comment cap ~400', long.lines[0].length < 450 && long.lines[0].endsWith('…'), String(long.lines[0].length));
  }

  // 4) Reddit RSS (the live shape, abridged)
  const atom = (entries, title = 'programming') => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><category term="programming" label="r/programming"/><updated>2026-10-06T05:49:35+00:00</updated><id>/r/x/.rss</id><subtitle>Computer Programming</subtitle><title>${title}</title>${entries}</feed>`;
  const entry = (id, author, href, title, content, ts = '2026-10-06T09:00:00+00:00') => `<entry><author><name>/u/${author}</name><uri>https://www.reddit.com/user/${author}</uri></author><category term="programming" label="r/programming"/><content type="html">${content}</content><id>${id}</id><link href="${href}" /><updated>${ts}</updated><published>${ts}</published><title>${title}</title></entry>`;
  const postBody = '&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;We are on a &lt;a href=&quot;https://elm-lang.org/news&quot;&gt;faster&lt;/a&gt; cycle.&lt;/p&gt; &lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/wheatBread&quot;&gt; /u/wheatBread &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://elm-lang.org/news&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/programming/comments/1wy7in8/elm/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;';
  const linkBody = '&amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/H&quot;&gt; /u/H &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://medium.com/@x/y-123&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/programming/comments/1wyumm6/now/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;';
  const cBody = (t) => `&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;${t}&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;`;
  const threadRss = atom(entry('t3_1wy7in8', 'wheatBread', 'https://www.reddit.com/r/programming/comments/1wy7in8/elm/', 'Another step towards Elm 1.0', postBody)
    + entry('t1_aaa', 'alice', 'https://www.reddit.com/r/programming/comments/1wy7in8/elm/aaa/', '/u/alice on Another step towards Elm 1.0', cBody('Great &amp;amp; useful'))
    + entry('t1_bbb', 'wheatBread', 'https://www.reddit.com/r/programming/comments/1wy7in8/elm/bbb/', '/u/wheatBread on Another step', cBody('Thanks!')), 'Another step : programming');
  const HTML_BLOCK = '<!DOCTYPE html><html lang="en-US" class="theme-beta"><head></head><body>blocked</body></html>';
  {
    const m = se.parseRedditRss(threadRss);
    check('rss: entries typed', m.entries.length === 3 && m.entries[0].type === 'post' && m.entries[1].type === 'comment', JSON.stringify(m.entries.map((e) => e.type)));
    check('rss: author /u/ stripped, link, selftext from SC_OFF/SC_ON', m.entries[0].author === 'wheatBread' && m.entries[0].text === 'We are on a faster (https://elm-lang.org/news) cycle.' && m.entries[1].text === 'Great & useful', JSON.stringify(m.entries[0]));
    const link = se.parseRedditRss(atom(entry('t3_1wyumm6', 'H', 'https://www.reddit.com/r/programming/comments/1wyumm6/now/', 'No now', linkBody)));
    check('rss: [link] anchor is the destination', link.entries[0].url === 'https://medium.com/@x/y-123' && link.entries[0].domain === 'medium.com' && link.entries[0].text === '', JSON.stringify(link.entries[0]));
    check('rss: html block page rejected', se.parseRedditRss(HTML_BLOCK) === null);
  }
  const url = 'https://www.reddit.com/r/programming/comments/1wy7in8/elm/';
  {
    // JSON blocked (403 html) -> old.reddit serves HTML -> www rss works
    const { out, calls } = await run(url, { 'https://www.reddit.com/r/programming/comments/1wy7in8/elm.json': res(403, HTML_BLOCK), 'https://old.reddit.com/': res(200, HTML_BLOCK), 'https://www.reddit.com/r/programming/comments/1wy7in8/elm/.rss': res(200, threadRss) });
    check('reddit: falls through json 403 and html rss to www rss', out && /^Source: reddit \(rss\)/.test(out.text) && out.title === 'Another step towards Elm 1.0' && calls.length === 3, JSON.stringify(calls.map((c) => c.url)));
    check('reddit rss thread text', out.text.includes('u/alice') && out.text.includes('Great & useful') && out.text.includes('u/wheatBread') && out.text.includes('no scores or reply nesting') && out.text.includes('Link: https://elm-lang.org/news'), out.text);
    check('no cookies/auth sent', calls.every((c) => !c.headers || (!c.headers.cookie && !c.headers.authorization)));
  }
  {
    // JSON works when it can
    const { out } = await run(url, { 'https://www.reddit.com/r/programming/comments/1wy7in8/elm.json': res(200, JSON.stringify(thread)) });
    check('reddit: json first when it answers', out && out.text.startsWith('Source: reddit (json)') && out.source === 'reddit');
  }
  {
    // 429 -> one backoff retry then success; and persistent 429 everywhere -> null
    let n = 0;
    const slept = [];
    const r = router({ 'https://www.reddit.com/r/programming/comments/1wy7in8/elm.json': () => (++n === 1 ? res(429, '') : res(200, JSON.stringify(thread))) });
    const out = await se.readSite(url, { get: r.get, now: () => NOW, sleep: async (ms) => { slept.push(ms); } });
    check('reddit: 429 backs off once and retries', out && /json/.test(out.text.split('\n')[0]) && slept.length === 1 && n === 2, `${n} ${slept}`);
    const all = await run(url, { 'https://': res(429, '') });
    check('reddit: 429 everywhere -> null (fall back to page read)', all.out === null && all.calls.length === 4, String(all.calls.length)); // json, retry, old rss, www rss
  }
  {
    // private community reported by the JSON endpoint; network error -> next source -> null
    const priv = await run('https://www.reddit.com/r/secretclub/', { 'https://www.reddit.com/r/secretclub.json': res(403, JSON.stringify({ reason: 'private', message: 'Forbidden', error: 403 })) });
    check('reddit: private community message', priv.out && /private community/.test(priv.out.text) && priv.out.text.startsWith('Source: reddit'), priv.out && priv.out.text);
    const q = await run('https://www.reddit.com/r/quar/', { 'https://www.reddit.com/r/quar.json': res(403, JSON.stringify({ reason: 'quarantined', message: 'Forbidden', error: 403 })) });
    check('reddit: quarantined message', q.out && /quarantined/.test(q.out.text));
    const boom = await run(url, { 'https://': new Error('net::ERR_FAILED') });
    check('reddit: every request throwing -> null, no throw', boom.out === null);
    const bad = await run(url, { 'https://www.reddit.com/r/programming/comments/1wy7in8/elm.json': res(200, 'not json at all'), 'https://old.reddit.com/': res(200, '<feed><entry>junk'), 'https://www.reddit.com/r/programming/comments/1wy7in8/elm/.rss': res(200, '') });
    check('reddit: garbage bodies -> null', bad.out === null);
  }
  {
    // listings and user pages from RSS and JSON
    const list = atom(entry('t3_1', 'a', 'https://www.reddit.com/r/programming/comments/1/x/', 'First post', linkBody) + entry('t3_2', 'b', 'https://www.reddit.com/r/programming/comments/2/y/', 'Second post', postBody));
    const { out } = await run('https://www.reddit.com/r/programming/', { 'https://www.reddit.com/r/programming.json': res(403, ''), 'https://old.reddit.com/': res(200, HTML_BLOCK), 'https://www.reddit.com/r/programming/.rss': res(200, list) });
    check('reddit listing from rss', out && out.text.includes('1. First post') && out.text.includes('2. Second post') && out.text.includes('medium.com') && out.text.includes('https://www.reddit.com/r/programming/comments/2/y/'), out && out.text);
    const jl = { kind: 'Listing', data: { children: [{ kind: 't3', data: { title: 'Hot one', subreddit: 'rust', author: 'z', score: 5000, num_comments: 321, created_utc: NOW / 1000 - 600, permalink: '/r/rust/comments/q/hot/', domain: 'self.rust', is_self: true, selftext: 'body text' } }, { kind: 't1', data: { author: 'z', subreddit: 'rust', body: 'a comment', score: 7, created_utc: NOW / 1000 - 60, link_title: 'Some post', permalink: '/r/rust/comments/q/hot/c/' } }] } };
    const j = await run('https://www.reddit.com/user/z', { 'https://www.reddit.com/user/z.json': res(200, JSON.stringify(jl)) });
    check('reddit user page from json (posts and comments)', j.out && j.out.text.includes('1. Hot one — r/rust · u/z · 5k pts · 321 comments · 10m ago') && j.out.text.includes('2. [comment] u/z in r/rust on "Some post"'), j.out && j.out.text);
  }
  {
    // in-page DOM probe against a tiny fake document
    const el = (attrs, kids = {}, text = '') => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null), querySelector: (sel) => kids[sel] || null, innerText: text, textContent: text });
    const post = el({ 'post-title': 'DOM post', 'subreddit-name': 'rust', author: 'op', score: '42', 'comment-count': '3', 'created-timestamp': '2026-10-06T09:00:00.000Z', permalink: '/r/rust/comments/abc123/dom/', domain: 'self.rust' }, { '[slot="text-body"]': el({}, {}, 'dom selftext') });
    const c1 = el({ author: 'op', score: '5', thingid: 't1_a', depth: '0' }, { '[slot="comment"]': el({}, {}, 'first   comment') });
    const c2 = el({ author: 'zed', score: '2', thingid: 't1_b', depth: '1' }, { 'div[id*="richtext"]': el({}, {}, 'nested') });
    const doc = { body: el({}, {}, 'x'), querySelector: (s) => (s === 'shreddit-post' ? post : null), querySelectorAll: (s) => (s === 'shreddit-comment' ? [c1, c2] : []) };
    const raw = se.redditPageProbe(doc);
    check('reddit page probe reads attrs and bodies', raw.post.title === 'DOM post' && raw.post.text === 'dom selftext' && raw.comments.length === 2 && raw.comments[0].text === 'first comment' && raw.comments[1].depth === '1', JSON.stringify(raw));
    const out = await se.readSiteInPage('https://www.reddit.com/r/rust/comments/abc123/dom/', async (code) => { new Function(`return ${code}`); return JSON.parse(JSON.stringify(raw)); }, { now: () => NOW });
    check('reddit page format', out && out.text.startsWith('Source: reddit (page)') && out.text.includes('[d1] u/zed 2') && out.text.includes('[d0] u/op (OP) 5'), out && out.text);
    const gone = await se.readSiteInPage('https://www.reddit.com/r/rust/comments/abc123/dom/', async () => ({ gone: 'private community' }));
    check('reddit page without a post -> null (normal read)', gone === null);
    const sc = se.extractorFor('https://www.reddit.com/r/rust/').inPage;
    check('reddit inPage is a script string', typeof sc === 'string' && sc.includes('shreddit-post'));
  }

  // 5) Hacker News
  const hnItem = { id: 8863, type: 'story', author: 'dhouston', title: 'My YC app: Dropbox', url: 'http://getdropbox.com/x', points: 104, text: null, created_at: '2007-04-04T19:16:40.000Z', children: [
    { id: 1, author: 'zaidf', points: null, text: '<p>This has great potential! <a href="https://a.test">x</a></p><p>second</p>', created_at: '2007-04-04T20:00:00.000Z', children: [
      { id: 2, author: 'dhouston', text: 'thanks!', created_at: '2007-04-04T21:00:00.000Z', children: [] }] },
    { id: 3, author: null, text: null, children: [] },
  ] };
  {
    const { out, calls } = await run('https://news.ycombinator.com/item?id=8863', { 'https://hn.algolia.com/api/v1/items/8863': res(200, JSON.stringify(hnItem)) });
    check('hn item: api used, source first', out && calls[0].url === 'https://hn.algolia.com/api/v1/items/8863' && out.text.startsWith('Source: hacker news (algolia)') && out.title === 'My YC app: Dropbox');
    check('hn item: header and comment lines', out.text.includes('by dhouston · 104 pts · 2 comments') && out.text.includes('Link: http://getdropbox.com/x (getdropbox.com)') && out.text.includes('[d0] zaidf ') && out.text.includes('This has great potential! x (https://a.test) ¶ second') && out.text.includes('[d1] dhouston (OP) ') && !out.text.includes('null'), out.text);
    const front = { hits: [{ objectID: '1', title: 'Story one', url: 'https://example.com/a', points: 321, num_comments: 45, author: 'a', created_at: '2026-10-06T08:00:00.000Z' }, { objectID: '2', title: 'Ask HN: x', url: null, points: 10, num_comments: 2, author: 'b', created_at: '2026-10-06T11:00:00.000Z' }] };
    const f = await run('https://news.ycombinator.com/', { 'https://hn.algolia.com/api/v1/search?tags=front_page': res(200, JSON.stringify(front)) });
    check('hn front page list', f.out && f.out.text.includes('1. Story one — example.com · 321 pts · 45 comments · by a · 4h ago') && f.out.text.includes('item?id=2'), f.out && f.out.text);
    const a = await run('https://news.ycombinator.com/ask', {});
    check('hn ask uses tags=ask_hn', a.calls[0].url.includes('tags=ask_hn'));
    const bad = await run('https://news.ycombinator.com/item?id=8863', { 'https://hn.algolia.com/': res(500, 'oops') });
    check('hn failure -> null', bad.out === null);
  }

  // 6) YouTube
  const tracks = [
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=de', languageCode: 'de', name: { simpleText: 'German' } },
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } },
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en', languageCode: 'en', name: { simpleText: 'English' } },
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en-GB', languageCode: 'en-GB', name: { simpleText: 'English (UK)' } },
  ];
  {
    check('track: manual in wanted language beats asr', se.pickCaptionTrack(tracks, 'en').baseUrl.endsWith('lang=en'));
    check('track: asr in language beats other manual', se.pickCaptionTrack([tracks[0], tracks[1]], 'en').kind === 'asr');
    check('track: other language manual when none match', se.pickCaptionTrack([tracks[0], tracks[1]], 'fr').languageCode === 'de');
    check('track: regional match (en-GB wanted)', se.pickCaptionTrack([tracks[0], tracks[3]], 'en-GB').languageCode === 'en-GB' && se.pickCaptionTrack([tracks[0], tracks[3]], 'en').languageCode === 'en-GB');
    check('track: none', se.pickCaptionTrack([], 'en') === null && se.pickCaptionTrack(undefined) === null);
    const json3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000 }, { tStartMs: 1000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] }, { tStartMs: 12000, segs: [{ utf8: '\n' }] }, { tStartMs: 35000, segs: [{ utf8: 'later  text' }] }] });
    const c = se.parseTranscript(json3);
    check('transcript json3', c.length === 2 && c[0].text === 'Hello world' && c[0].t === 1 && c[1].t === 35, JSON.stringify(c));
    const srv3 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="1360" d="1680">[♪♪♪]</p><p t="18640" d="3240">We&#39;re no strangers</p><p t="22640" d="4320">rules\nand so do I</p><p t="65000" d="100"><s>a</s><s t="1">b</s></p></body></timedtext>';
    const x = se.parseTranscript(srv3);
    check('transcript srv3 xml', x.length === 4 && x[1].text === "We're no strangers" && x[2].text === 'rules and so do I' && x[3].text === 'ab' && x[1].t === 18.64, JSON.stringify(x));
    const legacy = se.parseTranscript('<transcript><text start="0.5" dur="2">Hi &amp;amp; bye</text><text start="31" dur="2">next</text></transcript>');
    check('transcript legacy xml', legacy.length === 2 && legacy[0].text === 'Hi & bye' && legacy[1].t === 31, JSON.stringify(legacy));
    check('transcript empty / garbage', se.parseTranscript('').length === 0 && se.parseTranscript('{bad').length === 0 && se.parseTranscript('<html/>').length === 0);
    const merged = se.mergeCues([{ t: 1, text: 'a' }, { t: 20, text: 'b' }, { t: 35, text: 'c' }, { t: 3700, text: 'd' }], 30);
    check('cues merge into ~30s paragraphs, h:mm:ss over an hour', merged.length === 3 && merged[0] === '[0:01] a b' && merged[1] === '[0:35] c' && merged[2] === '[1:01:40] d', JSON.stringify(merged));
  }
  const player = { videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna', author: 'Rick', lengthSeconds: '213', viewCount: '1823000000', shortDescription: 'The official video.\nLine two.' }, playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en', languageCode: 'en', name: { simpleText: 'English' } }] } } };
  const watchHtml = (p) => `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(p)};var meta = {"a":"}"};</script><script>other()</script></html>`;
  const caps = JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'We are no strangers' }] }, { tStartMs: 40000, segs: [{ utf8: 'second paragraph' }] }] });
  const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  {
    check('jsonAfter balances braces and strings', se.jsonAfter(watchHtml(player), 'ytInitialPlayerResponse').videoDetails.title === 'Never Gonna' && se.jsonAfter('nothing', 'ytInitialPlayerResponse') === null);
    const { out, calls } = await run('https://youtu.be/dQw4w9WgXcQ?t=5', {
      'https://www.youtube.com/oembed': res(200, JSON.stringify({ title: 'Never Gonna', author_name: 'Rick' })),
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ': res(200, watchHtml(player)),
      'https://www.youtube.com/api/timedtext': (u) => (u.endsWith('&fmt=json3') ? res(200, caps) : res(200, '')),
    });
    check('youtube: transcript path', out && out.text.startsWith('Source: youtube (transcript)') && out.text.includes('Channel: Rick · Length: 3:33 · 1823M views') && out.text.includes('Description:\nThe official video.') && out.text.includes('Transcript (English):\n[0:01] We are no strangers\n[0:40] second paragraph') && out.title === 'Never Gonna', out && out.text);
    check('youtube: canonical watch url fetched (no start time)', calls.some((c) => c.url === YT));
    // captions withheld by the web player (empty bodies) -> the app player API supplies working ones
    const apiPlayer = { ...player, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&caps=asr', languageCode: 'en', name: { simpleText: 'English' } }] } } };
    const viaApi = await run(YT, {
      'https://www.youtube.com/oembed': res(404, ''),
      'https://www.youtube.com/watch?v=': res(200, watchHtml(player)),
      'https://www.youtube.com/youtubei/v1/player': (u, o) => (o.method === 'POST' && /ANDROID/.test(o.body) ? res(200, JSON.stringify(apiPlayer)) : res(400, '')),
      'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&caps=asr': res(200, '<timedtext format="3"><body><p t="2000" d="1000">from the api</p></body></timedtext>'),
      'https://www.youtube.com/api/timedtext': res(200, ''),
    });
    check('youtube: falls back to the player API when the page links give nothing', viaApi.out && viaApi.out.text.includes('[0:02] from the api'), viaApi.out && viaApi.out.text);
    const none = await run(YT, { 'https://www.youtube.com/oembed': res(200, JSON.stringify({ title: 'T', author_name: 'A' })), 'https://www.youtube.com/watch?v=': res(200, watchHtml({ videoDetails: player.videoDetails, playabilityStatus: { status: 'OK' } })), 'https://www.youtube.com/youtubei/v1/player': res(200, JSON.stringify({ videoDetails: player.videoDetails })) });
    check('youtube: no captions says so, never fabricates', none.out && none.out.text.includes('No captions available; transcript not fabricated.') && none.out.text.startsWith('Source: youtube (metadata)') && none.out.text.includes('Channel: Rick'), none.out && none.out.text);
    const withheld = await run(YT, { 'https://www.youtube.com/oembed': res(404, ''), 'https://www.youtube.com/watch?v=': res(200, watchHtml(player)), 'https://www.youtube.com/youtubei/v1/player': res(500, ''), 'https://www.youtube.com/api/timedtext': res(200, '') });
    check('youtube: withheld captions say so', withheld.out && /would not release them/.test(withheld.out.text) && /not fabricated/.test(withheld.out.text), withheld.out && withheld.out.text);
    const oembedOnly = await run(YT, { 'https://www.youtube.com/oembed': res(200, JSON.stringify({ title: 'Only oembed', author_name: 'A' })), 'https://www.youtube.com/watch?v=': res(500, ''), 'https://www.youtube.com/youtubei/v1/player': res(500, '') });
    check('youtube: oembed alone still gives a header', oembedOnly.out && oembedOnly.out.title === 'Only oembed' && /No captions/.test(oembedOnly.out.text));
    const nothing = await run(YT, { 'https://www.youtube.com/': res(500, '') });
    check('youtube: nothing answers -> null', nothing.out === null);
    const unplayable = await run(YT, { 'https://www.youtube.com/oembed': res(401, ''), 'https://www.youtube.com/watch?v=': res(200, watchHtml({ videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Private' }, playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } })), 'https://www.youtube.com/youtubei/v1/player': res(500, '') });
    check('youtube: unplayable explained', unplayable.out && /login_required: Sign in/.test(unplayable.out.text));
    const small = await run(YT, { 'https://www.youtube.com/oembed': res(404, ''), 'https://www.youtube.com/watch?v=': res(200, watchHtml(player)), 'https://www.youtube.com/api/timedtext': () => res(200, JSON.stringify({ events: Array.from({ length: 400 }, (_, i) => ({ tStartMs: i * 31000, segs: [{ utf8: `sentence number ${i}` }] })) })) }, { maxChars: 1500 });
    check('youtube: long transcript fits the budget and says where it resumes', small.out.text.length <= 1500 && /transcript continues from \d+:\d\d/.test(small.out.text), small.out.text.slice(-200));
  }

  // 7) X / Twitter
  {
    check('x token matches react-tweet (id 20)', se.xToken('20') === '6dq1a2xwd93' && se.xToken('1700000000000000000') === ((1700000000000000000 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''), se.xToken('20'));
    check('x ids', se.xStatusId('https://x.com/jack/status/20') === '20' && se.xStatusId('https://twitter.com/i/web/status/99') === '99' && se.xStatusId('https://x.com/jack/status/abc') === null && se.xStatusId('https://x.com/jack/with_replies') === null);
    const tweet = { __typename: 'Tweet', id_str: '20', text: 'hello https://t.co/abc &amp; https://t.co/pic', display_text_range: [0, 80], created_at: '2026-10-06T10:00:00.000Z', favorite_count: 1200, conversation_count: 34, user: { name: 'Jack', screen_name: 'jack' },
      entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/post' }], media: [{ url: 'https://t.co/pic' }] }, mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg', ext_alt_text: 'a cat' }, { type: 'video', media_url_https: 'https://pbs.twimg.com/thumb.jpg', video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'u.m3u8' }, { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/low.mp4' }, { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/hi.mp4' }] } }],
      quoted_tweet: { text: 'quoted words', user: { name: 'Q', screen_name: 'quoter' }, favorite_count: 5 } };
    const { out, calls } = await run('https://x.com/jack/status/20', { 'https://cdn.syndication.twimg.com/tweet-result': res(200, JSON.stringify(tweet)) });
    check('x: syndication url with computed token', calls[0].url === 'https://cdn.syndication.twimg.com/tweet-result?id=20&lang=en&token=6dq1a2xwd93', calls[0].url);
    check('x: formatting', out && out.text.startsWith('Source: x (syndication)') && out.text.includes('@jack (Jack) · 2h ago (2026-10-06) · 1.2k likes · 34 replies') && out.text.includes('hello https://example.com/post &') && !out.text.includes('t.co') && out.text.includes('photo https://pbs.twimg.com/media/a.jpg (alt: a cat)') && out.text.includes('video https://video.twimg.com/hi.mp4') && out.text.includes('Quoting:\n> @quoter (Q)') && out.text.includes('> quoted words'), out && out.text);
    const oembed = { author_name: 'jack', author_url: 'https://twitter.com/jack', html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20">March 21, 2006</a></blockquote>' };
    const fb = await run('https://x.com/jack/status/20', { 'https://cdn.syndication.twimg.com/': res(403, ''), 'https://publish.twitter.com/oembed': res(200, JSON.stringify(oembed)) });
    check('x: oembed fallback', fb.out && fb.out.text.startsWith('Source: x (oembed)') && fb.out.text.includes('just setting up my twttr') && fb.out.text.includes('@jack'), fb.out && fb.out.text);
    const tomb = await run('https://x.com/jack/status/20', { 'https://cdn.syndication.twimg.com/': res(200, JSON.stringify({ __typename: 'TweetTombstone' })) });
    check('x: tombstone says unavailable', tomb.out && /unavailable/.test(tomb.out.text));
    const dead = await run('https://x.com/jack/status/20', { 'https://cdn.syndication.twimg.com/': res(404, ''), 'https://publish.twitter.com/': res(404, '') });
    check('x: both fail -> null', dead.out === null);
  }

  // 8) TikTok
  {
    const U = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
    const { out, calls } = await run(U, { 'https://www.tiktok.com/oembed': res(200, JSON.stringify({ title: 'Scramble up ur name #fyp', author_name: 'Scout, Suki & Stella', author_url: 'https://www.tiktok.com/@scout2015' })) });
    check('tiktok: oembed', out && calls[0].url === `https://www.tiktok.com/oembed?url=${encodeURIComponent(U)}` && out.text.startsWith('Source: tiktok (oembed)') && out.text.includes('@scout2015') && out.text.includes('Scramble up ur name #fyp'), out && out.text);
    const state = { __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { id: '6718', desc: 'caption here', author: { uniqueId: 'scout2015', nickname: 'Scout' }, stats: { playCount: 1500000, diggCount: 120000, commentCount: 3400, shareCount: 900 }, createTime: String(NOW / 1000 - 86400 * 2), music: { title: 'original sound' } } } } } };
    const doc = { querySelector: (s) => (s === 'script#__UNIVERSAL_DATA_FOR_REHYDRATION__' ? { textContent: JSON.stringify(state) } : null) };
    const raw = se.tiktokPageProbe(doc);
    check('tiktok: rehydration parse', raw.desc === 'caption here' && raw.author === 'scout2015' && raw.stats.playCount === 1500000);
    const page = await se.readSiteInPage(U, async () => raw, { now: () => NOW });
    check('tiktok: page format has stats', page && page.text.includes('1.5M plays') && page.text.includes('120k likes') && page.text.includes('3.4k comments') && page.text.includes('2d ago') && page.text.includes('Sound: original sound'), page && page.text);
    check('tiktok: no rehydration -> null', se.tiktokPageProbe({ querySelector: () => null }) === null && await se.readSiteInPage(U, async () => null) === null);
    check('tiktok: oembed 404 -> null', (await run(U, { 'https://www.tiktok.com/oembed': res(404, '') })).out === null);
  }

  // 9) GitHub
  {
    check('github targets', se.githubTarget('https://github.com/electron/electron').kind === 'repo' && se.githubTarget('https://github.com/a/b/pull/7').kind === 'pr' && se.githubTarget('https://github.com/a/b/issues/7').n === '7' && se.githubTarget('https://github.com/a/b/issues') === null && se.githubTarget('https://github.com/features/copilot') === null);
    const repo = { full_name: 'electron/electron', description: 'Build apps', language: 'C++', stargazers_count: 123456, forks_count: 17600, open_issues_count: 718, license: { spdx_id: 'MIT' }, pushed_at: '2026-10-06T06:00:00Z', homepage: 'https://electronjs.org', topics: ['electron', 'js'] };
    const readme = '[![badge](x)](y)\n# Electron\n\nBuild cross-platform apps.\n\n\n\n## Install\n';
    const { out, calls } = await run('https://github.com/electron/electron', { 'https://api.github.com/repos/electron/electron/readme': (u, o) => res(200, o.accept === 'application/vnd.github.raw' ? readme : ''), 'https://api.github.com/repos/electron/electron': res(200, JSON.stringify(repo)) });
    check('github repo: header, topics, README without badges', out && out.text.startsWith('Source: github (api)') && out.text.includes('C++ · 123k stars · 17.6k forks · 718 open issues · MIT') && out.text.includes('Topics: electron, js') && out.text.includes('README:\n# Electron\n\nBuild cross-platform apps.') && !out.text.includes('badge'), out && out.text);
    check('github: raw accept for readme', calls.some((c) => c.url.endsWith('/readme') && c.accept === 'application/vnd.github.raw'));
    const issue = { number: 22, title: 'Fix the thing', state: 'closed', user: { login: 'dev' }, created_at: '2026-10-04T12:00:00Z', comments: 2, labels: [{ name: 'bug' }], body: 'Body text', pull_request: {} };
    const comments = [{ user: { login: 'dev' }, body: 'first', created_at: '2026-10-04T13:00:00Z' }, { user: { login: 'rev' }, body: 'LGTM', created_at: '2026-10-05T13:00:00Z' }];
    const pr = await run('https://github.com/a/b/pull/22', { 'https://api.github.com/repos/a/b/issues/22/comments': res(200, JSON.stringify(comments)), 'https://api.github.com/repos/a/b/issues/22': res(200, JSON.stringify(issue)), 'https://api.github.com/repos/a/b/pulls/22': res(200, JSON.stringify({ merged: true, head: { ref: 'fix' }, base: { ref: 'main' }, changed_files: 3, additions: 40, deletions: 5 })) });
    check('github PR: merged, branches, diff size, comments', pr.out && pr.out.text.includes('PR #22: Fix the thing') && pr.out.text.includes('merged · by dev') && pr.out.text.includes('fix -> main · 3 files · +40/-5') && pr.out.text.includes('[d0] dev (OP) 1d: first') && pr.out.text.includes('[d0] rev 23h: LGTM'), pr.out && pr.out.text);
    const limited = await run('https://github.com/electron/electron', { 'https://api.github.com/': res(403, '{"message":"API rate limit exceeded"}') });
    check('github: 403 rate limit -> null', limited.out === null);
  }

  // 10) runner behaviour: budget, unsupported, thrown errors, junk
  {
    const big = await run('https://news.ycombinator.com/item?id=8863', { 'https://hn.algolia.com/api/v1/items/8863': res(200, JSON.stringify({ ...hnItem, children: Array.from({ length: 300 }, (_, i) => ({ id: i + 10, author: `u${i}`, text: 'word '.repeat(150), children: [] })) })) }, { maxChars: 3000 });
    check('maxChars honoured end to end', big.out && big.out.text.length <= 3000 && /more comments not shown/.test(big.out.text), big.out && String(big.out.text.length));
    check('default budget is read_urls\' 8000', se.DEFAULT_MAX_CHARS === 8000);
    check('unsupported url -> null without any request', (await run('https://example.com/', {})).calls.length === 0 && (await se.readSite('https://example.com/', { get: async () => { throw new Error('should not be called'); } })) === null);
    check('no get function -> null', (await se.readSite('https://news.ycombinator.com/', {})) === null);
    const thrown = await se.readSite('https://news.ycombinator.com/item?id=1', { get: async () => { throw new Error('boom'); } });
    check('a throwing fetch never escapes', thrown === null);
    const badJson = await run('https://news.ycombinator.com/item?id=1', { 'https://hn.algolia.com/': res(200, '<html>not json</html>') });
    check('non-JSON answer -> null', badJson.out === null);
    const inPageBoom = await se.readSiteInPage('https://www.reddit.com/r/rust/comments/abc123/x/', async () => { throw new Error('page gone'); });
    check('inPage failure -> null', inPageBoom === null && (await se.readSiteInPage('https://news.ycombinator.com/', async () => ({}))) === null);
  }

  // 11) makeGet: user agent, no cookies, redirect off the known sites is a failure
  {
    const seen = [];
    const get = se.makeGet(async (u, o) => { seen.push({ u, o }); return { ok: true, status: 200, url: u.includes('redir') ? 'https://evil.test/x' : u, text: async () => 'body' }; });
    const a = await get('https://www.reddit.com/r/x/.rss', { accept: 'application/atom+xml' });
    check('makeGet: desktop Chrome UA, omit credentials, accept, timeout signal', a.ok && /Chrome\/\d+/.test(seen[0].o.headers['user-agent']) && seen[0].o.credentials === 'omit' && seen[0].o.headers.accept === 'application/atom+xml' && seen[0].o.signal instanceof AbortSignal && !('cookie' in seen[0].o.headers));
    const b = await get('https://www.reddit.com/redir');
    check('makeGet: redirect to another site fails the request', b.ok === false && b.text === '');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall site-extractor checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
