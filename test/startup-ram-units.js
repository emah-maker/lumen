// Pure unit tests for the start-up and memory work: which saved tabs get a page, the deferred start-up queue's order,
// the idle teardown timer, extension match patterns (a late extension reloads the page it missed), the favicon store's
// lazy read, the music engine not starting for a page nobody sees, and the read cache's byte cap.
// Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A clock and timers a test steps by hand.
function fakeTimers() {
  let now = 0;
  const timers = [];
  let id = 0;
  return {
    setTimer: (fn, ms) => { const t = { id: ++id, at: now + ms, fn, unref() { return t; } }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
    count: () => timers.length,
  };
}

(async () => {
  // ---- which saved tabs get a page (features/session-restore.js)
  const { liveIndices } = require('../src/features/session-restore');
  check('restore: only the front tab gets a page', same([...liveIndices(25, 3)], [3]), [...liveIndices(25, 3)]);
  check('restore: a front index past the end is clamped to the last tab', same([...liveIndices(5, 99)], [4]), '');
  check('restore: a negative or missing front index is the first tab', same([...liveIndices(5, -2)], [0]) && same([...liveIndices(5, undefined)], [0]), '');
  check('restore: no saved tabs, no pages', liveIndices(0, 0).size === 0, '');
  check('restore: neighbours load on both sides, never out of range', same([...liveIndices(10, 0, { neighbors: 2 })].sort(), [0, 1, 2]) && same([...liveIndices(10, 9, { neighbors: 1 })].sort(), [8, 9]) && same([...liveIndices(10, 5, { neighbors: 1 })].sort(), [4, 5, 6]), '');
  check('restore: 25 tabs make 24 placeholders', 25 - liveIndices(25, 12).size === 24, '');

  // ---- the deferred start-up queue (features/startup-queue.js)
  const { createStartupQueue } = require('../src/features/startup-queue');
  {
    const t = fakeTimers();
    const order = [];
    const q = createStartupQueue({ gapMs: 50, taskCapMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    q.add('updates', () => { order.push('updates'); }, { priority: 4 });
    q.add('spare', () => { order.push('spare'); }, { priority: 1 });
    q.add('models-b', () => { order.push('models-b'); }, { priority: 3 });
    q.add('models-a', () => { order.push('models-a'); }, { priority: 3 });
    check('queue: nothing runs before it is released', order.length === 0 && same(q.pendingNames(), ['spare', 'models-b', 'models-a', 'updates']), q.pendingNames());
    q.release();
    await Promise.resolve();
    check('queue: lower priority first, one task at a time', same(order, ['spare']), order);
    t.advance(10);
    check('queue: the next task waits out the gap', same(order, ['spare']), order);
    for (let i = 0; i < 6; i++) { t.advance(60); await Promise.resolve(); await Promise.resolve(); }
    check('queue: equal priorities keep the order they were added in', same(order, ['spare', 'models-b', 'models-a', 'updates']), order);
    q.add('late', () => { order.push('late'); }, { priority: 0 });
    for (let i = 0; i < 3; i++) { t.advance(60); await Promise.resolve(); await Promise.resolve(); }
    check('queue: a task added after the release still runs', order.at(-1) === 'late', order);
  }
  {
    const t = fakeTimers();
    const order = [];
    const q = createStartupQueue({ gapMs: 10, taskCapMs: 500, setTimer: t.setTimer, clearTimer: t.clearTimer });
    q.add('hangs', () => new Promise(() => {}), { priority: 1 });
    q.add('throws', () => { throw new Error('boom'); }, { priority: 2 });
    q.add('after', () => { order.push('after'); }, { priority: 3 });
    q.release();
    for (let i = 0; i < 8; i++) { t.advance(300); await Promise.resolve(); await Promise.resolve(); }
    check('queue: a task that hangs (cap) or throws does not hold up the rest', same(order, ['after']) && same(q.ran(), ['hangs', 'throws', 'after']), `${order} ${q.ran()}`);
  }

  // ---- idle teardown (features/idle-reaper.js)
  const { createIdleReaper } = require('../src/features/idle-reaper');
  {
    const t = fakeTimers();
    let closed = 0;
    let busy = false;
    const reaper = createIdleReaper({ ms: 1000, onIdle: () => { closed++; }, busy: () => busy, setTimer: t.setTimer, clearTimer: t.clearTimer });
    check('reaper: nothing is scheduled until the helper is used', !reaper.pending(), '');
    reaper.touch();
    t.advance(900);
    reaper.touch(); // used again: the wait starts over
    t.advance(900);
    check('reaper: each use restarts the wait', closed === 0 && reaper.pending(), closed);
    t.advance(200);
    check('reaper: closed once it has sat unused for the whole wait', closed === 1 && !reaper.pending(), closed);
    reaper.touch();
    busy = true;
    t.advance(1000);
    check('reaper: busy at the deadline means look again later, not close', closed === 1 && reaper.pending(), closed);
    busy = false;
    t.advance(1000);
    check('reaper: closed on the next look once it is free', closed === 2, closed);
    reaper.touch();
    reaper.cancel();
    t.advance(5000);
    check('reaper: cancel stops the timer for good', closed === 2 && t.count() === 0, closed);
  }

  // ---- extension match patterns (browser/match-pattern.js)
  const mp = require('../src/browser/match-pattern');
  check('match: <all_urls> matches web pages, not Lumen pages', mp.matchesUrl('<all_urls>', 'https://a.com/x') && !mp.matchesUrl('<all_urls>', 'lumen://settings') && !mp.matchesUrl('<all_urls>', 'about:blank'), '');
  check('match: https://*.example.com/* covers the host and its subdomains only', mp.matchesUrl('https://*.example.com/*', 'https://example.com/') && mp.matchesUrl('https://*.example.com/*', 'https://a.b.example.com/p?q=1') && !mp.matchesUrl('https://*.example.com/*', 'https://notexample.com/') && !mp.matchesUrl('https://*.example.com/*', 'http://example.com/'), '');
  check('match: * scheme means http and https', mp.matchesUrl('*://*/*', 'http://x.org/') && mp.matchesUrl('*://*/*', 'https://x.org/') && !mp.matchesUrl('*://*/*', 'file:///c:/a.html'), '');
  check('match: paths are matched with wildcards', mp.matchesUrl('https://x.org/themes*', 'https://x.org/themes/blue') && !mp.matchesUrl('https://x.org/themes*', 'https://x.org/other'), '');
  const manifest = { content_scripts: [{ matches: ['<all_urls>'], exclude_matches: ['https://ext.site.com/*'] }, { matches: ['https://calendar.google.com/*'] }] };
  check('match: content scripts apply unless excluded', mp.contentScriptsApply(manifest, 'https://news.com/a') && !mp.contentScriptsApply(manifest, 'https://ext.site.com/a') && !mp.contentScriptsApply({ permissions: ['storage'] }, 'https://news.com/'), '');
  const tabs = [{ id: 1, url: 'https://news.com/', active: false, startedBeforeLoad: true, busy: false }, { id: 2, url: 'https://news.com/', active: true, startedBeforeLoad: true, busy: false }, { id: 3, url: 'https://x.com/', active: true, startedBeforeLoad: true, busy: true }];
  check('late extension: only the front page its scripts match reloads', same(mp.pagesToReload(manifest, tabs), [2]), mp.pagesToReload(manifest, tabs));
  check('late extension: not a page with text typed in, and not after the first moments', same(mp.pagesToReload(manifest, [tabs[2]]), []) && same(mp.pagesToReload(manifest, tabs, { withinStartup: false }), []), '');

  // ---- the favicon store reads its file off the main thread, and answers before that read is done
  {
    const { createFaviconStore } = require('../src/browser/favicon-store');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fav-'));
    fs.writeFileSync(path.join(dir, 'favicons.json'), JSON.stringify({ 'a.com': 'data:image/png;base64,AAA', 'b.com': 'data:image/png;base64,BBB' }));
    const early = createFaviconStore(dir);
    check('favicons: a lookup before the async read has finished still answers', early.get('a.com') === 'data:image/png;base64,AAA' && early.has('b.com'), '');
    await sleep(50);
    check('favicons: and the same after it', early.get('b.com') === 'data:image/png;base64,BBB' && !early.has('zzz'), '');
    const empty = createFaviconStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fav-')), { 'old.com': 'data:image/png;base64,OLD' });
    await sleep(50);
    check('favicons: no file yet: the old settings.json icons are migrated', empty.get('old.com') === 'data:image/png;base64,OLD', '');
    empty.set('new.com', 'data:image/png;base64,NEW');
    check('favicons: new icons are kept', empty.has('new.com'), '');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- a page nobody can see does not start the music engine's hidden web player
  {
    const { createEngine } = require('../src/features/apple-music-engine');
    const player = { ensured: 0, wc: null, ensure() { player.ensured++; player.wc = player.wc || { executeJavaScript: () => Promise.resolve() }; }, webContents: () => player.wc, status: () => ({ state: 'ready', drm: 'ok' }), destroy() { player.wc = null; }, showIn() {}, release() {}, reload() {} };
    const engine = createEngine({ player, native: null, now: () => 1e12, fetchBytes: async () => null, resizeArt: (b) => b, BrowserWindow: function BrowserWindow() {}, getParent: () => null, hasCard: () => true, onChange() {}, setInterval: () => ({ unref() {} }) });
    const idle = await engine.read({ wake: false });
    check('music engine: a read with wake:false does not load the hidden page', player.ensured === 0 && idle.state === 'idle' && idle.reason === 'loading', JSON.stringify(idle));
    await engine.read();
    check('music engine: a normal read does', player.ensured === 1, player.ensured);
  }

  // ---- the read cache keeps at most so many bytes of page text (ai/read-speed.js)
  {
    const { ResultCache } = require('../src/ai/read-speed');
    const cache = new ResultCache({ max: 50, maxBytes: 10000 });
    const page = (n, chars) => ({ title: `T${n}`, url: `https://a.com/${n}`, text: 'x'.repeat(chars) });
    for (let i = 0; i < 4; i++) cache.put(`https://a.com/${i}`, {}, '', page(i, 2000)); // 4 KB each (UTF-16)
    check('read cache: over its byte cap the oldest pages go first', cache.get('https://a.com/0', {}, '') === null && cache.get('https://a.com/3', {}, '') !== null && cache.bytes() <= 10000, cache.bytes());
    cache.put('https://a.com/big', {}, '', page('big', 20000));
    check('read cache: one page bigger than the cap is kept alone, never an empty loop', cache.map.size === 1, cache.map.size);
    const small = new ResultCache({ max: 2 });
    for (let i = 0; i < 5; i++) small.put(`https://a.com/${i}`, {}, '', page(i, 10));
    check('read cache: the entry-count cap still applies', small.map.size === 2, small.map.size);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
