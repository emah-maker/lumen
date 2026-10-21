// Plain Node: the per-tab call queue of an MCP session (features/tab-queue.js), and the tab_id lists in automation/mcp.js.
const { createTabQueue } = require('../../src/features/tab-queue');
const mcp = require('../../src/automation/mcp');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Same tab: in order, never overlapping. Different tabs: at the same time.
  {
    const q = createTabQueue();
    const log = [];
    let running = 0; let overlap = false;
    const job = (name, ms) => async () => { running++; if (running > 1) overlap = true; log.push(`start ${name}`); await sleep(ms); log.push(`end ${name}`); running--; return name; };
    const out = await Promise.all([q.run(1, job('a', 30)), q.run(1, job('b', 5)), q.run(1, job('c', 5))]);
    check('same tab: calls run one after another, in the order they came', out.join() === 'a,b,c' && !overlap && log.join() === 'start a,end a,start b,end b,start c,end c', log.join());
    const t0 = Date.now();
    await Promise.all([q.run(1, job('x', 60)), q.run(2, job('y', 60)), q.run(3, job('z', 60))]);
    check('different tabs: side by side, not queued', Date.now() - t0 < 150, `${Date.now() - t0} ms`);
    check('no tab: no queue', (await q.run(null, async () => 7)) === 7, 'no result');
  }
  // A failed call does not hold up the next one, and its error reaches its own caller.
  {
    const q = createTabQueue();
    const bad = q.run(1, async () => { throw new Error('boom'); });
    const good = q.run(1, async () => 'ok');
    const err = await bad.then(() => null, (e) => e.message);
    check('an error reaches its own call and the next one still runs', err === 'boom' && (await good) === 'ok', `${err}`);
  }
  // The Map does not grow: an entry goes when its queue drains.
  {
    const q = createTabQueue();
    await Promise.all([1, 2, 3, 4].map((k) => q.run(k, async () => k)));
    await sleep(10);
    check('finished queues leave nothing behind', q.size() === 0, q.size());
  }
  // Stop: a call still waiting is dropped and never runs; the one running is left to its own signal.
  {
    const q = createTabQueue();
    const ctl = new AbortController();
    let ran = false;
    const first = q.run(1, async () => { await sleep(40); return 'first'; });
    const waiting = q.run(1, async () => { ran = true; return 'second'; }, ctl.signal);
    const third = q.run(1, async () => 'third');
    ctl.abort();
    const err = await waiting.then(() => null, (e) => e.message);
    check('a call aborted while queued fails at once with "Stopped by the user."', err === 'Stopped by the user.', err);
    check('...and never runs, and the calls around it are unaffected', (await first) === 'first' && (await third) === 'third' && ran === false, `ran=${ran}`);
    const pre = new AbortController(); pre.abort();
    const err2 = await q.run(1, async () => 'x', pre.signal).then(() => null, (e) => e.message);
    check('a call whose signal is already aborted never starts', err2 === 'Stopped by the user.', err2);
  }
  // The tab_id lists.
  {
    check('every tool advertised with tab_id accepts it', [...mcp.TAB_ADVERTISED].every((n) => mcp.TAB_ARG_TOOLS.has(n)), [...mcp.TAB_ADVERTISED].filter((n) => !mcp.TAB_ARG_TOOLS.has(n)).join());
    check('tools that already name a tab keep their own tab_id (not in the list)', ['screenshot', 'read_pdf', 'get_console', 'get_network', 'handle_dialog', 'switch_tab', 'close_tab'].every((n) => !mcp.TAB_ARG_TOOLS.has(n)), 'overlap');
    check('annotate queues behind other calls on its tab (it draws on the page); the pure reads never wait', !mcp.QUEUE_EXEMPT.has('annotate') && ['read_page', 'find', 'screenshot', 'wait_for', 'list_tabs'].every((n) => mcp.QUEUE_EXEMPT.has(n)) && !mcp.QUEUE_EXEMPT.has('click'), [...mcp.QUEUE_EXEMPT].join());
    check('clipboard is not tab-specific: no tab_id', !mcp.TAB_ARG_TOOLS.has('clipboard'), 'listed');
  }
  console.log(failures ? `\n${failures} failed` : '\nall tab-queue checks passed');
  process.exit(failures ? 1 : 0);
})();
