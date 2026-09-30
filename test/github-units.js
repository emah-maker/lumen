// The GitHub new-tab widget, without Electron or the network (run from test/units.js, or on its own:
// `node test/github-units.js`): features/github-view.js (settings, searches, items, counts, rate limits and
// refusals) and the connector in features/widgets.js against a stand-in for api.github.com (a fetch that
// answers with canned Responses): a bad token, rate limits (Retry-After, x-ratelimit-reset), paging caps,
// partly refused lists, and the token staying out of everything the page gets.
const GV = require('../src/features/github-view');
const { createWidgets } = require('../src/features/widgets');

const TOKEN = `github_pat_${'A1b2C3d4E5'.repeat(4)}`;
const json = (obj, init = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });
const pr = (n, extra = {}) => ({ number: n, title: `Fix thing ${n}`, html_url: `https://github.com/acme/app/pull/${n}`, user: { login: 'octo-cat' }, updated_at: '2026-09-28T10:00:00Z', pull_request: {}, comments: 2, ...extra });

module.exports = async function githubUnits(check) {
  // ---- settings ----
  const cfg = GV.cleanConfig;
  check('github config: the default is all three lists, ten items, drafts shown', JSON.stringify(cfg()) === JSON.stringify({ reviews: true, assigned: true, notifications: true, max: 10, hideDrafts: false }), JSON.stringify(cfg()));
  check('github config: values are checked (max is 5, 10 or 20; non-booleans fall back)', cfg({ max: 7 }).max === 10 && cfg({ max: 20 }).max === 20 && cfg({ reviews: 'no' }).reviews === true && cfg({ hideDrafts: 'yes' }).hideDrafts === false && cfg({ assigned: false }).assigned === false, '');
  check('github config: a card with every list off is the default card', cfg({ reviews: false, assigned: false, notifications: false }).reviews === true, '');
  check('github token: fine-grained and classic tokens pass, other things do not', GV.looksLikeToken(TOKEN) && GV.looksLikeToken(`ghp_${'a'.repeat(36)}`) && !GV.looksLikeToken('hunter2') && !GV.looksLikeToken('github_pat_short') && !GV.looksLikeToken(`${TOKEN}\n`) && !GV.looksLikeToken(null), '');
  check('github searches: review requests are open pull requests asked of @me; drafts can be left out', GV.searchFor('reviews', cfg()) === 'is:open archived:false is:pr review-requested:@me' && / draft:false$/.test(GV.searchFor('reviews', cfg({ hideDrafts: true }))) && GV.searchFor('assigned', cfg()) === 'is:open archived:false assignee:@me', GV.searchFor('reviews', cfg()));

  // ---- items ----
  const item = GV.normalizeItem(pr(7, { title: '  Fix\n<b>bold</b>  ', draft: true }));
  check('github item: normalized (repo, number, kind, author, draft), text flattened and left as text', item.id === 'acme/app#7' && item.kind === 'pr' && item.draft && item.title === 'Fix <b>bold</b>' && item.author === 'octo-cat' && item.updated === Date.parse('2026-09-28T10:00:00Z'), JSON.stringify(item));
  check('github item: an issue is an issue', GV.normalizeItem({ number: 3, title: 'x', html_url: 'https://github.com/a/b/issues/3' }).kind === 'issue', '');
  check('github item: junk and foreign addresses are dropped', [null, 5, {}, pr(1, { html_url: 'javascript:alert(1)' }), pr(1, { html_url: 'https://evil.example/acme/app/pull/1' }), pr(1, { html_url: 'https://github.com.evil.example/a/b/pull/1' }), pr(1, { title: '   ' }), pr(1, { html_url: 'https://github.com/a/b/pull/1/../../x' })].every((x) => GV.normalizeItem(x) === null), '');
  check('github item: an odd login and date are left out, not trusted', GV.normalizeItem(pr(1, { user: { login: '<img src=x>' }, updated_at: 'yesterday' })).author === '' && GV.normalizeItem(pr(1, { updated_at: 'yesterday' })).updated === null, '');
  const many = { total_count: 120, incomplete_results: true, items: [...Array.from({ length: 30 }, (_, i) => pr(i + 1)), pr(1), null] };
  const read = GV.readSearch(many, cfg({ max: 5 }));
  check('github search: cut to the item cap, the real total kept, duplicates gone, partial results flagged', read.items.length === 5 && read.total === 120 && read.partial === true && new Set(read.items.map((i) => i.id)).size === 5, JSON.stringify([read.items.length, read.total, read.partial]));
  check('github search: drafts are dropped when asked, and the answer must be a search result', GV.readSearch({ total_count: 2, items: [pr(1, { draft: true }), pr(2)] }, cfg({ hideDrafts: true })).items.length === 1 && GV.readSearch({ message: 'x' }, cfg()) === null && GV.readSearch([], cfg()) === null, '');

  // ---- notification count ----
  const link = '<https://api.github.com/notifications?per_page=1&page=2>; rel="next", <https://api.github.com/notifications?per_page=1&page=42>; rel="last"';
  check('github notifications: the "last" page of a one-per-page list is the count', GV.lastPage(link) === 42 && GV.readNotificationCount([{}], link).count === 42 && GV.readNotificationCount([{}], null).count === 1 && GV.readNotificationCount([], null).count === 0 && GV.readNotificationCount({}, null) === null, '');
  const huge = GV.readNotificationCount([{}], '<https://x/n?per_page=1&page=5000>; rel="last"');
  check('github notifications: a huge count is capped and shown as 999+', huge.count === 999 && huge.capped && GV.countLabel(huge) === '999+' && GV.countLabel({ count: 4, capped: false }) === '4', JSON.stringify(huge));

  // ---- refusals and rate limits ----
  const H = (o) => new Headers(o);
  const NOW = 1_800_000_000_000;
  check('github refusals: 401 says the token was rejected', GV.classify(401, H({}), '', NOW).kind === 'auth' && /rejected the token/.test(GV.classify(401, H({}), '', NOW).message), '');
  const reset = GV.classify(403, H({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 90e3) / 1000) }), '{"message":"API rate limit exceeded"}', NOW);
  check('github rate limit: 403 with x-ratelimit-remaining 0 waits until x-ratelimit-reset', reset.kind === 'rate' && reset.waitMs === 90e3 && /2 minutes|minute/.test(reset.message), JSON.stringify(reset));
  check('github rate limit: Retry-After wins (429 or a 403 secondary limit)', GV.classify(429, H({ 'retry-after': '30' }), '', NOW).waitMs === 30e3 && GV.classify(403, H({ 'retry-after': '45', 'x-ratelimit-remaining': '12' }), '', NOW).waitMs === 45e3, '');
  check('github rate limit: waits are kept between 5 seconds and an hour; a 429 with no hint waits a minute', GV.rateLimitWait(429, H({ 'retry-after': '0' }), '', NOW) === 5e3 && GV.rateLimitWait(429, H({ 'retry-after': '99999' }), '', NOW) === 3600e3 && GV.rateLimitWait(429, H({}), '', NOW) === 60e3 && GV.rateLimitWait(403, H({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW - 5e3) / 1000) }), '', NOW) === 5e3, '');
  check('github rate limit: a 403 that mentions the limit with no headers is one; a plain 403 is a permission problem', GV.rateLimitWait(403, H({}), '{"message":"You have exceeded a secondary rate limit"}', NOW) === 60e3 && GV.classify(403, H({ 'x-ratelimit-remaining': '4999' }), '{"message":"Resource not accessible by personal access token"}', NOW).kind === 'scope' && /Resource not accessible/.test(GV.classify(403, H({}), '{"message":"Resource not accessible by personal access token"}', NOW).message), '');
  check('github refusals: 404, 422, 5xx and others each get a plain sentence', GV.classify(404, H({}), '', NOW).kind === 'missing' && GV.classify(422, H({}), '', NOW).kind === 'scope' && /trouble \(502\)/.test(GV.classify(502, H({}), '', NOW).message) && /418/.test(GV.classify(418, H({}), '', NOW).message) && GV.rateLimitWait(200, H({}), '', NOW) === 0, '');
  check('github refusals: a body that is not JSON is ignored', GV.apiMessage('<html>') === '' && GV.apiMessage('{"message":"a\\nb"}') === 'a b' && GV.apiMessage(null) === '', '');

  // ---- what the card gets ----
  const shaped = GV.shape({ reviews: { items: [item], total: 3, partial: false }, assigned: { error: 'x'.repeat(500) }, notifications: { count: 12, capped: false } }, cfg());
  check('github card data: lists, per-list errors (cut), the unread count and github.com links', shaped.reviews.total === 3 && shaped.assigned.error.length === 200 && shaped.notifications.label === '12' && shaped.open === 'https://github.com/pulls/review-requested' && shaped.openNotifications === 'https://github.com/notifications', JSON.stringify(shaped).slice(0, 300));
  check('github card data: a switched-off list is null', GV.shape({ reviews: null, assigned: null, notifications: { count: 0, capped: false } }, cfg({ reviews: false, assigned: false })).reviews === null, '');

  // ---- the connector, against a stand-in for api.github.com ----
  const log = [];
  let clock = NOW;
  let script = () => null; // (url) -> Response
  const fetch = async (url, opts) => {
    const u = new URL(url);
    log.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: opts.headers?.Authorization || '', creds: opts.credentials });
    return script(u, opts) || new Response('{}', { status: 404 });
  };
  const okScript = (u) => {
    if (u.pathname === '/search/issues') return json({ total_count: 42, items: Array.from({ length: 30 }, (_, i) => pr(i + 1)) });
    if (u.pathname === '/notifications') return json([{ id: '1' }], { headers: { link: '<https://api.github.com/notifications?per_page=1&page=7>; rel="last"' } });
    return null;
  };
  const settings = { keys: {} };
  const secrets = {};
  const W = createWidgets({
    readSettings: () => settings,
    writeSettings: (s) => { Object.assign(settings, s); },
    fetch,
    getSecret: (n) => secrets[n] || null,
    setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; },
    onUpdate() {},
    endpoints: () => ({ github: 'https://api.github.test' }),
    now: () => clock,
  });
  const forPage = () => W.forPage().find((w) => w.type === 'github');
  const settle = async () => { await W.refreshAll({ force: true }); return forPage(); };

  script = () => new Response('{"message":"Bad credentials"}', { status: 401 });
  let r = await W.test({ type: 'github', token: TOKEN });
  check('github widget: Check with a rejected token says so plainly', !r.ok && r.error && /rejected the token/.test(r.message), JSON.stringify(r));
  r = await W.test({ type: 'github', token: 'hunter2' });
  check('github widget: something that is not a token is refused before any request', !r.ok && /doesn’t look like a GitHub token/.test(r.message) && log.length === 1, JSON.stringify([r, log.length]));
  r = await W.test({ type: 'github' });
  check('github widget: no token at all asks for one', !r.ok && /Paste your GitHub token/.test(r.message), JSON.stringify(r));

  script = okScript;
  log.length = 0;
  r = await W.test({ type: 'github', token: TOKEN, gh: { max: 5 } });
  check('github widget: Check counts the lists', r.ok && /42 review requests, 42 assigned, 7 unread/.test(r.message), JSON.stringify(r));
  const searches = log.filter((l) => l.path === '/search/issues');
  check('github widget: one page per search, sized to the cap, newest first, asked of @me', searches.length === 2 && searches.every((l) => l.q.per_page === '5' && l.q.sort === 'updated' && l.q.order === 'desc') && /review-requested:@me/.test(searches[0].q.q) && /assignee:@me/.test(searches[1].q.q), JSON.stringify(searches));
  check('github widget: the notifications call is one item per page', log.some((l) => l.path === '/notifications' && l.q.per_page === '1'), JSON.stringify(log));
  check('github widget: the token goes only to the API host, as a Bearer header, with no cookies', log.every((l) => l.auth === `Bearer ${TOKEN}` && l.creds === 'omit'), JSON.stringify(log[0]));
  check('github widget: a Check stores nothing', !secrets.github && !(settings.homeWidgets || []).length, '');

  const saved = await W.save({ type: 'github', token: TOKEN, gh: { max: 5, notifications: true } });
  check('github widget: saved with the token in the encrypted slot only', secrets.github === TOKEN && !JSON.stringify(settings).includes(TOKEN) && saved.widget.gh.max === 5 && saved.widget.w === 3 && saved.widget.h === 4, JSON.stringify(saved.widget));
  let card = await settle();
  check('github widget: the page gets 5 items of 42, the unread count and no token', card.data.reviews.items.length === 5 && card.data.reviews.total === 42 && card.data.notifications.count === 7 && !JSON.stringify(W.forPage()).includes(TOKEN) && !JSON.stringify(W.state()).includes(TOKEN) && W.state().secrets.github === true, JSON.stringify(card).slice(0, 300));
  check('github widget: the type is in Settings’ picker with its label', W.state().types.some((t) => t.type === 'github' && t.label === 'GitHub') && W.state().widgets[0].summary.includes('review requests'), JSON.stringify(W.state().types));

  // A rate limit: the widget keeps its old data with a warning and is not asked again before the reset.
  script = () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((clock + 300e3) / 1000) } });
  clock += 6 * 60e3; // the data is stale
  card = await settle();
  check('github widget: a rate limit is a warning under the old data, with the wait in it', card.data && /rate limit is used up/.test(card.warning) && /5 minutes/.test(card.warning), JSON.stringify([card.warning, card.error]));
  const calls = log.length;
  clock += 60e3;
  await settle();
  check('github widget: nothing is sent while the limit holds (even when refresh is forced)', log.length === calls, `${log.length - calls} extra calls`);
  script = okScript;
  clock += 300e3;
  card = await settle();
  check('github widget: after the reset it asks again and recovers', log.length > calls && !card.warning && card.data.reviews.total === 42, JSON.stringify([card.warning, log.length - calls]));

  // 429 with Retry-After.
  script = () => new Response('', { status: 429, headers: { 'retry-after': '120' } });
  clock += 6 * 60e3;
  card = await settle();
  check('github widget: 429 with Retry-After is honoured too', /2 minutes/.test(card.warning || ''), JSON.stringify(card.warning));
  script = okScript;
  clock += 200e3;
  await settle();

  // A token that stops working.
  script = () => new Response('{"message":"Bad credentials"}', { status: 401 });
  clock += 6 * 60e3;
  card = await settle();
  check('github widget: a token that GitHub revokes later shows the clear 401 message (old data kept as a warning)', /rejected the token/.test(card.warning || ''), JSON.stringify(card.warning));

  // Notifications refused to a fine-grained token: the two lists still show.
  script = (u) => (u.pathname === '/notifications' ? new Response('{"message":"Resource not accessible by personal access token"}', { status: 403, headers: { 'x-ratelimit-remaining': '4990' } }) : okScript(u));
  clock += 6 * 60e3;
  W.flush();
  card = await settle();
  check('github widget: refused notifications leave the lists and explain themselves', card.data?.reviews.total === 42 && /classic token with the notifications scope/.test(card.data.notifications.error) && !card.error, JSON.stringify(card).slice(0, 400));

  // Every list refused: the whole card fails with GitHub's own words.
  script = () => new Response('{"message":"Resource not accessible by personal access token"}', { status: 403, headers: { 'x-ratelimit-remaining': '4990' } });
  W.remove(saved.widget.id);
  const again = await W.save({ type: 'github', token: TOKEN, gh: { notifications: false } }).catch((err) => ({ err }));
  check('github widget: with every list refused, saving says why and stores no token', /Resource not accessible/.test(again.err?.message || '') && !secrets.github, JSON.stringify(again.err?.message));

  // Removing the last GitHub card removes the token.
  script = okScript;
  const s2 = await W.save({ type: 'github', token: TOKEN });
  check('github widget: the token is stored again on a good save', secrets.github === TOKEN, '');
  W.remove(s2.widget.id);
  check('github widget: removing the last GitHub card removes its token', !secrets.github, '');
};

if (require.main === module) {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  module.exports(check).then(() => { console.log(failures ? `${failures} failed` : 'all passed'); process.exit(failures ? 1 : 0); }, (err) => { console.error(err); process.exit(1); });
}
