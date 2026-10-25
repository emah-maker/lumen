// Opt-in live check of the Reddit readers against the real site, SIGNED OUT (never an account, never a login: the app runs in a
// throwaway profile). Not in npm test: needs the network, and Reddit rate-limits signed-out reads and changes its pages.
// Run: LUMEN_LIVE=1 node test/e2e/live-reddit.js [outDir]   (hidden: LUMEN_TEST_BACKGROUND=1, under scripts/test/e2e-lock.js)
// Per case: what read_urls and read_page (the AI's read tools) return, the raw HTTP status of Reddit's feeds as the reader's
// session sees them, whether the result is a wall, and the timing. Writes live-reddit-results.json to outDir.
// Cases: subreddit listing, a thread with comments, a thread with a big "more replies" tail, search, old.reddit.com, a
// /r/x/comments link, a share link (/r/x/s/<id>, found from a real post's page when Reddit offers one), a user page.
if (!process.env.LUMEN_LIVE) { console.log('SKIP  live-reddit needs LUMEN_LIVE=1 (it reads reddit.com)'); process.exit(0); }
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-live-reddit-'));
fs.mkdirSync(OUT, { recursive: true });
// A popular, stable thread (spez's 2026 "Modernizing Reddit's infrastructure" post: 480+ comments, a long "more replies" tail).
const BIG_THREAD = 'https://www.reddit.com/r/u_spez/comments/1vgbkge/modernizing_reddits_infrastructure_with_you/';
const BIG_THREAD_COMMENTS_LINK = 'https://www.reddit.com/user/spez/comments/1vgbkge/modernizing_reddits_infrastructure_with_you/';
const SUB = 'programming';
const WALL = /Page: wall|Reddit shows this page only to signed-in users|bot check/;
let app = null;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-live-reddit-profile-'));
  app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const bail = setTimeout(() => { console.error('live-reddit: 8 min cap, closing'); app.close().finally(() => process.exit(1)); }, 8 * 60000);
  await ui.waitForSelector('.tab');

  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    const started = Date.now();
    try { const r = await global.__agent.execute(n, i); return { ms: Date.now() - started, text: typeof r === 'string' ? r : JSON.stringify(r) }; } catch (err) { return { ms: Date.now() - started, text: `ERROR: ${err.message}` }; }
  }, [name, input]);
  // The status Reddit's JSON endpoint gives the reader's cookie-less session (what the old reader hit first).
  const jsonStatus = (url) => app.evaluate(async ({ session }, [u]) => {
    try { const r = await session.fromPartition('claude-reader').fetch(`${u.split('?')[0].replace(/\/$/, '')}.json?raw_json=1&limit=5`, { credentials: 'omit', headers: { accept: 'application/json' } }); await r.text(); return r.status; } catch (err) { return `ERR ${err.message}`; }
  }, [url]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  const results = {};
  const save = () => fs.writeFileSync(path.join(OUT, 'live-reddit-results.json'), JSON.stringify({ rows, results }, null, 1));
  const squash = (t) => String(t).replace(/\s+/g, ' ');
  const record = async (label, url, { want, tab = true, delay = 4000 } = {}) => {
    const status = await jsonStatus(url);
    const urls = await run('read_urls', { urls: [url] });
    let page = null;
    if (tab) {
      await run('navigate', { url });
      await sleep(2500);
      page = await run('read_page', {});
    }
    const src = (urls.text.match(/Source: [^\n]+/) || [''])[0];
    const wall = WALL.test(urls.text);
    const ok = want(urls.text) && !wall;
    const pageOk = !tab || (want(page.text) && !/Page: wall/.test(page.text));
    results[label] = { url, jsonStatus: status, read_urls: { ms: urls.ms, source: src, chars: urls.text.length, wall, head: urls.text.slice(0, 1500) }, read_page: page && { ms: page.ms, chars: page.text.length, head: page.text.slice(0, 1500) } };
    rows.push({ label, ok, pageOk });
    console.log(`${ok && pageOk ? 'PASS' : 'FAIL'}  ${label}  json:${status}  read_urls ${urls.ms} ms ${src || '(no site source)'} ${urls.text.length}ch${wall ? ' WALL' : ''}${tab ? `  read_page ${page.ms} ms ${page.text.length}ch${pageOk ? '' : ' BAD'}` : ''}\n      ${squash(urls.text).slice(0, 200)}`);
    save();
    await sleep(delay); // (Reddit rate-limits signed-out feed reads hard)
  };

  // 1. a subreddit listing: titles with links back to their threads
  await record('listing r/programming', `https://www.reddit.com/r/${SUB}/`, { want: (t) => /\/r\/programming\/comments\/[a-z0-9]+\//.test(t) && /\n10\. /.test(t) }); // the first screen of posts, not just the first few cards
  const threadLink = (results['listing r/programming']?.read_urls.head.match(/https:\/\/www\.reddit\.com\/r\/programming\/comments\/[a-z0-9]+\/[^\s]*/) || [])[0];
  // 2. a thread with comments (the newest top post, found above) and the big one
  if (threadLink) await record('thread (top post of the listing)', threadLink, { want: (t) => /Comments \(|\(No comments\.\)/.test(t) });
  else { rows.push({ label: 'thread (top post of the listing)', ok: false, pageOk: false }); console.log('FAIL  thread: no link found in the listing'); }
  await record('thread with a long reply tail', BIG_THREAD, { want: (t) => /Comments \(\d+ of/.test(t) && /\[d0\] /.test(t) });
  // the same thread, asked for 40000 characters: the page's "more replies" buttons are followed
  {
    const big = await run('read_urls', { urls: [BIG_THREAD], max_chars: 40000 });
    const n = (big.text.match(/\n\[d\d\] u\//g) || []).length;
    const ok = n > 40 && !WALL.test(big.text);
    results['thread, max_chars 40000'] = { ms: big.ms, comments: n, head: big.text.slice(0, 600) };
    rows.push({ label: 'thread, 40000 chars: more replies followed', ok, pageOk: true });
    console.log(`${ok ? 'PASS' : 'FAIL'}  thread, 40000 chars  ${big.ms} ms  ${n} comment lines  ${squash(big.text).slice(0, 120)}`);
    await sleep(4000);
  }
  // 3. a /r/x/comments link on another host spelling, and the user-comments spelling
  await record('comments link (www, /user/ spelling)', BIG_THREAD_COMMENTS_LINK, { want: (t) => /Comments \(\d+ of/.test(t), tab: false });
  // 4. search
  await record('search', 'https://www.reddit.com/search/?q=electron+browser', { want: (t) => /\n5\. /.test(t) && /\/comments\//.test(t) });
  // 5. old.reddit.com (signed out it sends everything to a login page; the reader goes to www instead)
  await record('old.reddit.com listing', `https://old.reddit.com/r/${SUB}/`, { want: (t) => /\/r\/programming\/comments\//.test(t), tab: false });
  if (threadLink) await record('old.reddit.com thread', threadLink.replace('www.reddit.com', 'old.reddit.com'), { want: (t) => /Comments \(|\(No comments\.\)/.test(t), tab: false });
  // 6. a user page
  await record('user page u/spez', 'https://www.reddit.com/user/spez/', { want: (t) => /\n1\. /.test(t) });
  await record('user comments u/spez', 'https://www.reddit.com/user/spez/comments/', { want: (t) => /\[comment\]/.test(t) });
  // 7. a share link. Reddit mints these per viewer; a signed-out page has no Share button that makes one, so use the
  // LUMEN_REDDIT_SHARE env value when given (a real https://www.reddit.com/r/<sub>/s/<id>), else check a made-up id is read as a
  // wall or a not-found (never as someone else's page) and say so.
  const share = process.env.LUMEN_REDDIT_SHARE;
  if (share) await record('share link', share, { want: (t) => /Comments \(|\(No comments\.\)/.test(t), tab: false });
  else {
    const fake = await run('read_urls', { urls: ['https://www.reddit.com/r/programming/s/Zz9Zz9Zz9Z'] });
    results['share link (made-up id)'] = { ms: fake.ms, head: fake.text.slice(0, 600) };
    const ok = /share link that did not open a post/.test(fake.text) || !/Source: reddit \(/.test(fake.text);
    rows.push({ label: 'share link (made-up id): no invented page', ok, pageOk: true });
    console.log(`${ok ? 'PASS' : 'FAIL'}  share link (made-up id; set LUMEN_REDDIT_SHARE for a real one)  ${fake.ms} ms  ${squash(fake.text).slice(0, 160)}`);
  }

  save();
  const failed = rows.filter((r) => !r.ok || !r.pageOk).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed; results in ${OUT}`);
  clearTimeout(bail);
  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a locked file in the throwaway profile */ }
  process.exit(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); try { await app?.close(); } catch { /* already gone */ } process.exit(1); });
