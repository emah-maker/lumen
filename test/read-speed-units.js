// read_urls / navigate speed helpers, plain Node (no Electron, no network): the `wait` decision (load-wait.js), the warm
// reader view pool, the cross-run result cache and the reader-only asset filter (read-speed.js).
require('./_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const { normalizeWait, loadDone, MEANINGFUL_TEXT, DEFAULT_WAIT, MODES, PROBE_SCRIPT } = require('../src/ai/load-wait');
const { ReaderPool, ResultCache, shouldBlockReaderRequest, installReaderFilter } = require('../src/ai/read-speed');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

(async () => {
  // ---- wait decision
  check('default is interactive', DEFAULT_WAIT === 'interactive' && MODES.length === 3);
  check('normalizeWait: unknown falls back', normalizeWait('bogus') === 'interactive' && normalizeWait(undefined, 'load') === 'load' && normalizeWait('networkidle') === 'networkidle');
  const p = (o) => ({ readyState: 'loading', textChars: 0, idleMs: 0, loading: true, ...o });
  check('interactive: parsed + real text is done', loadDone('interactive', p({ readyState: 'interactive', textChars: MEANINGFUL_TEXT })));
  check('interactive: parsed but an empty app shell keeps waiting', !loadDone('interactive', p({ readyState: 'interactive', textChars: 20 })));
  check('interactive: still loading the document keeps waiting', !loadDone('interactive', p({ readyState: 'loading', textChars: 5000 })));
  check('interactive: complete is done even with little text', loadDone('interactive', p({ readyState: 'complete', textChars: 3 })));
  check('load: only complete', !loadDone('load', p({ readyState: 'interactive', textChars: 9000 })) && loadDone('load', p({ readyState: 'complete' })));
  check('networkidle: needs 500 ms idle and nothing loading', !loadDone('networkidle', p({ readyState: 'complete', idleMs: 499, loading: false })) && !loadDone('networkidle', p({ readyState: 'complete', idleMs: 900, loading: true })) && loadDone('networkidle', p({ readyState: 'complete', idleMs: 500, loading: false })));
  check('networkidle: the tab request tracker (netIdle) overrides the idleMs guess', !loadDone('networkidle', p({ readyState: 'complete', idleMs: 5000, loading: false, netIdle: false })) && loadDone('networkidle', p({ readyState: 'complete', idleMs: 0, loading: false, netIdle: true })) && !loadDone('networkidle', p({ readyState: 'complete', idleMs: 0, loading: true, netIdle: true })));
  check('every mode ends at the cap', MODES.every((m) => loadDone(m, p({}), 15000, 15000)) && !loadDone('load', p({}), 14999, 15000));
  check('no probe is never done before the cap', !loadDone('interactive', null, 100, 15000) && loadDone('interactive', null, 15000, 15000));
  check('probe script is an expression string', typeof PROBE_SCRIPT === 'string' && (() => { try { new Function(`return ${PROBE_SCRIPT}`); return true; } catch { return false; } })());

  // ---- pool, with fake views
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.cleared = true; };
  const made = [];
  const mk = () => new ReaderPool({
    create: () => { const e = { id: made.length, dead: false, blank: true, closed: 0 }; made.push(e); return e; },
    reset: async (e) => e.blank,
    destroy: (e) => { e.dead = true; e.closed++; },
    alive: (e) => !e.dead,
    setTimer, clearTimer,
  });
  let pool = mk();
  const a = await pool.acquire();
  const b = await pool.acquire();
  check('pool: parallel acquires make separate views', a !== b && made.length === 2);
  await pool.release(a);
  const a2 = await pool.acquire();
  check('pool: a released view is reused', a2 === a && pool.stats.reused === 1 && made.length === 2);
  await pool.release(a2);
  await pool.release(b);
  check('pool: two idle', pool.idle.length === 2);
  const four = [await pool.acquire(), await pool.acquire(), await pool.acquire(), await pool.acquire()];
  for (const x of four) await pool.release(x);
  check('pool: at most 3 idle, the 4th release is destroyed', pool.idle.length === 3 && four.filter((x) => x.dead).length === 1, `${pool.idle.length}`);
  const sick = await pool.acquire();
  await pool.release(sick, false);
  check('pool: unhealthy release is destroyed, not reused', sick.dead && !pool.idle.includes(sick));
  const stuck = await pool.acquire();
  stuck.blank = false;
  await pool.release(stuck);
  check('pool: a view that will not blank is destroyed', stuck.dead);
  const crashed = pool.idle[0];
  crashed.dead = true;
  const next = await pool.acquire();
  check('pool: a dead idle view is skipped and closed', next !== crashed && crashed.closed === 1);
  // idle timeout
  pool = mk();
  const g = await pool.acquire();
  await pool.release(g);
  const live = timers.filter((t) => !t.cleared).pop();
  check('pool: idle timer is 60 s', live && live.ms === 60000);
  live.fn();
  check('pool: idle timeout destroys every idle view', g.dead && pool.idle.length === 0 && pool.timer === null);
  const h = await pool.acquire();
  check('pool: after the timeout a fresh view is made', h !== g);
  await pool.release(h);
  pool.closeAll();
  check('pool: closeAll is deterministic', h.dead && pool.idle.length === 0);

  // ---- result cache
  let t = 1000;
  const cache = new ResultCache({ max: 3, ttlMs: 5 * 60 * 1000, now: () => t });
  const pg = (url, over = {}) => ({ url, title: 'T', text: 'body', ...over });
  check('cache: miss then hit', cache.get('https://a.com/', { wait: 'load' }, 's') === null && cache.put('https://a.com/', { wait: 'load' }, 's', pg('https://a.com/')) && cache.get('https://a.com/', { wait: 'load' }, 's').title === 'T');
  check('cache: options and scope are part of the key', cache.get('https://a.com/', { wait: 'interactive' }, 's') === null && cache.get('https://a.com/', { wait: 'load' }, 'other') === null);
  t += 5 * 60 * 1000 - 1;
  check('cache: alive just before the TTL', cache.get('https://a.com/', { wait: 'load' }, 's') !== null);
  t += 2;
  check('cache: expired after the TTL', cache.get('https://a.com/', { wait: 'load' }, 's') === null && cache.map.size === 0);
  for (const n of [1, 2, 3]) cache.put(`https://x${n}.com/`, {}, 's', pg(`https://x${n}.com/`));
  cache.get('https://x1.com/', {}, 's'); // x1 is now the freshest
  cache.put('https://x4.com/', {}, 's', pg('https://x4.com/'));
  check('cache: evicts the least recently used past max', cache.get('https://x2.com/', {}, 's') === null && cache.get('https://x1.com/', {}, 's') && cache.get('https://x4.com/', {}, 's') && cache.map.size === 3);
  check('cache: failed reads are not cached', !cache.put('https://f.com/', {}, 's', pg('https://f.com/', { title: '', text: 'Could not read this page: x' })) && !cache.put('https://f.com/', {}, 's', pg('https://f.com/', { text: 'Could not read this page: x' })));
  check('cache: a redirect to another host is not cached', !cache.put('https://r.com/', {}, 's', pg('https://other.com/')));
  check('cache: same host, different path is cached', cache.put('https://r.com/a', {}, 's', pg('https://r.com/b')));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'agent.js'), 'utf8');
  check('agent: as_user reads bypass the cache', /input\.as_user \? null : readResults\.get/.test(src) && /if \(!input\.as_user\) readResults\.put/.test(src));

  // ---- asset filter
  check('filter: images, media, fonts are blocked', ['image', 'media', 'font'].every((r) => shouldBlockReaderRequest({ resourceType: r })));
  check('filter: pages, scripts, styles, XHR are not', ['mainFrame', 'subFrame', 'script', 'stylesheet', 'xhr', 'other', undefined].every((r) => !shouldBlockReaderRequest({ resourceType: r })));
  let handler = null;
  let filter = null;
  const ses = { webRequest: { onBeforeRequest: (f, h) => { filter = f; handler = h; } } };
  installReaderFilter(ses, 'claude-reader');
  let out = null;
  handler({ resourceType: 'image' }, (r) => { out = r; });
  check('filter: installs on the reader session and cancels an image', filter.urls.every((u) => /^https?:/.test(u)) && out.cancel === true);
  handler({ resourceType: 'script' }, (r) => { out = r; });
  check('filter: lets a script through', out.cancel === false);
  let threw = 0;
  for (const part of ['persist:main', '', undefined, 'lumen-research', 'persist:claude-reader']) { try { installReaderFilter(ses, part); } catch { threw++; } }
  check('filter: refuses any other partition', threw === 5);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check('main.js: installed on the claude-reader session only', (main.match(/installReaderFilter\(/g) || []).length === 1 && /installReaderFilter\(reader, 'claude-reader'\)/.test(main) && /const reader = session\.fromPartition\('claude-reader'\)/.test(main));

  if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((err) => { console.error(err); process.exit(1); });
