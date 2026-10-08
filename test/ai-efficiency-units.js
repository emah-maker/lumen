// AI efficiency round 2, plain Node (no Electron, no network): stubbing old attached pages once past the
// context-management trigger, prompt-cache layout of the Claude request, parallel read-only tool calls and
// identical-call caching in the agent loop (fake model + fake tools, timed), repeat nudges, sign-off routing,
// streamed-event coalescing and the resumable markdown stable-length scan.
const { Agent, requestFor } = require('../src/ai/agent');
const { ToolCallCache, stubOldPages, advancePageStub, RepeatDetector, CONTEXT_TRIGGER_TOKENS } = require('../src/ai/loop-guard');
const { createCoalescer } = require('../src/features/event-coalesce');
const modelRoute = require('../src/features/model-route');
const md = require('../src/renderer/markdown');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (n) => `<browser_state>\nActive tab id: 1\n</browser_state>\n\n<untrusted_page_content title="Page ${n}" url="https://example.com/${n}">\nText of the user's current tab.\n\n${`word${n} `.repeat(1200)}\n</untrusted_page_content>\n\n`;
const history = (turns) => {
  const m = [];
  m.settings = { model: 'claude-sonnet-5', adhdMode: false };
  for (let i = 0; i < turns; i++) {
    m.push({ role: 'user', content: [{ type: 'text', text: page(i) + `question ${i}` }] });
    m.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'find', input: { query: 'x' } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'found' }] });
    m.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] });
  }
  return m;
};
const size = (x) => JSON.stringify(x).length;

(async () => {
  // 1) Old attached pages are stubbed, the newest message keeps its page, nothing is mutated.
  {
    const m = history(8);
    m.push({ role: 'user', content: [{ type: 'text', text: page(99) + 'latest question' }] });
    const before = size(m);
    const out = stubOldPages(m);
    check('stub: old pages cut, newest kept', size(out) < before / 5 && out.at(-1) === m.at(-1) && out.at(-1).content[0].text.includes('word99'), `${before} -> ${size(out)}`);
    check('stub: keeps title and url, says how to get the page', /title="Page 0" url="https:\/\/example.com\/0"/.test(out[0].content[0].text) && /call read_page/.test(out[0].content[0].text) && out[0].content[0].text.includes('question 0'));
    check('stub: input not mutated, untouched messages are the same objects', m[0].content[0].text.includes('word0') && out[1] === m[1]);
    const one = [m.at(-1)];
    check('stub: nothing to stub returns the same array', stubOldPages(one) === one);
    check('stub: upTo limits it', stubOldPages(m, 4)[0].content[0].text.includes('left out') && stubOldPages(m, 4)[4] === m[4]);
    console.log(`INFO  stub: ${before} chars -> ${size(out)} chars (${Math.round(100 - (size(out) / before) * 100)}% less) for 9 turns of 7 KB pages`);
    check('stub: idempotent (a stubbed history stubs to itself, so the cached prefix is stable)', size(stubOldPages(out)) === size(out) && JSON.stringify(stubOldPages(out)) === JSON.stringify(out));
  }

  // 2) The request: stubbing only after the trigger (messages.pageStub), and the cache layout.
  {
    const m = history(6);
    m.push({ role: 'user', content: [{ type: 'text', text: page(50) + 'next' }] });
    const normal = requestFor(m.settings, m);
    check('request: Haiku 5.5 is a model of its own, and a chat saved on Haiku 4.5 runs as 5.5 (not as the default)', requestFor({ ...m.settings, model: 'claude-haiku-5-5' }, m).model === 'claude-haiku-5-5' && requestFor({ ...m.settings, model: 'claude-haiku-4-5' }, m).model === 'claude-haiku-5-5');
    check('request: normal turn sends old pages whole (cache prefix untouched)', JSON.stringify(normal.messages[0]) === JSON.stringify(m[0]));
    const small = history(1);
    small.push({ role: 'user', content: [{ type: 'text', text: page(7) + 'q' }] });
    advancePageStub(small);
    check('stub: batched, one old page is not enough to start', !small.pageStubUpTo);
    m.pageStub = true;
    advancePageStub(m);
    check('stub: batched, piled-up pages move the line to the newest message', m.pageStubUpTo === m.length - 1, String(m.pageStubUpTo));
    const line = m.pageStubUpTo;
    m.push({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: [{ type: 'text', text: page(60) + 'y' }] });
    advancePageStub(m);
    check('stub: and does not move again for a single new page', m.pageStubUpTo === line);
    m.length -= 2;
    const stubbed = requestFor(m.settings, m);
    check('request: after the 60k trigger old pages are stubbed', size(stubbed.messages) < size(normal.messages) / 4);
    check('request: trigger constant matches the API edit', requestFor(m.settings, m).context_management.edits[0].trigger.value === CONTEXT_TRIGGER_TOKENS);
    // cache layout: breakpoints on the last tool and the system block; nothing per-turn before them
    const a = requestFor(m.settings, m);
    m.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: page(51) + 'one more' }] });
    const b = requestFor(m.settings, m);
    check('cache: last tool and system carry breakpoints', a.tools.at(-1).cache_control?.type === 'ephemeral' && a.tools.slice(0, -1).every((t) => !t.cache_control) && a.system[0].cache_control?.type === 'ephemeral' && a.cache_control?.type === 'ephemeral');
    check('cache: tools and system are byte-identical from turn to turn', JSON.stringify(a.tools) === JSON.stringify(b.tools) && JSON.stringify(a.system) === JSON.stringify(b.system));
    check('cache: the history prefix is byte-identical, only the tail grows', JSON.stringify(b.messages.slice(0, a.messages.length)) === JSON.stringify(a.messages));
    check('cache: no clock or per-turn text in the system prompt', !/\b20\d\d-\d\d-\d\d\b|browser_state/.test(a.system[0].text));
    const fresh = [];
    fresh.settings = { model: 'claude-sonnet-5' };
    fresh.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    const first = JSON.stringify(requestFor(fresh.settings, fresh).system) + JSON.stringify(requestFor(fresh.settings, fresh).tools);
    fresh.push({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, { role: 'user', content: [{ type: 'text', text: '<browser_state>Active tab id: 9</browser_state>\n\nmore' }] });
    check('cache: browser_state lives in the message tail, never in system or tools', first === JSON.stringify(requestFor(fresh.settings, fresh).system) + JSON.stringify(requestFor(fresh.settings, fresh).tools));
  }

  // 3) ToolCallCache on its own.
  {
    const cache = new ToolCallCache();
    let runs = 0;
    const find = { name: 'find', input: { query: 'price' } };
    const go = (use, url = 'u1', fn = async () => { runs++; await sleep(5); return 'RESULT'; }) => cache.run(use, url, fn);
    const [r1, r2, r3] = await Promise.all([go(find), go(find), go({ name: 'find', input: { query: 'other' } })]);
    check('cache: identical calls in one turn share one run', runs === 2 && r1 === 'RESULT' && /Same call as another/.test(r2) && r3 === 'RESULT', `${runs} ${r2}`);
    cache.nextTurn();
    check('cache: a repeat in a later turn is one short line', /Same as your earlier find call/.test(await go(find)) && runs === 2);
    await go({ name: 'click', input: { text: 'x' } }, 'u1', async () => 'clicked');
    check('cache: an acting tool clears it', (await go(find)) === 'RESULT' && runs === 3);
    check('cache: another URL is a different call', (await go(find, 'u2')) === 'RESULT' && runs === 4);
    let failed = 0;
    const bad = { name: 'web_search', input: { query: 'q' } };
    await go(bad, 'u1', async () => { failed++; throw new Error('net'); }).catch(() => {});
    await go(bad, 'u1', async () => { failed++; return 'fine'; });
    check('cache: failures are not remembered', failed === 2);
    const c2 = new ToolCallCache(3);
    let n = 0;
    await c2.run(find, 'u', async () => { n++; return 'A'; });
    for (let i = 0; i < 4; i++) await c2.run({ name: 'screenshot', input: { i } }, 'u', async () => 'png');
    check('cache: stale after a few calls (the API clears old results)', (await c2.run(find, 'u', async () => { n++; return 'A'; })) === 'A' && n === 2);
    check('cache: read_urls as_user is never cached', new ToolCallCache().keyOf({ name: 'read_urls', input: { urls: ['https://a.com'], as_user: true } }, 'u') === null);
  }

  // 4) The agent loop with a fake model: three independent reads in one turn run together, repeats are cached.
  {
    const DELAY = 120;
    const calls = [];
    const agent = Object.assign(Object.create(Agent.prototype), {
      scopes: new Set(), runs: new Map(), approvedHosts: new Set(),
      browser: { maxSteps: () => 0, fallbackOptions: () => [], autoFallback: () => false, aiOff: () => false, noTabReason: () => 'x', effectiveModel: (m) => m, activeTab: () => null },
      isExternalTool: () => false,
      async describeStep() { return 'step'; },
      async ensureAllowed() {},
      closeSignedInTabs() {},
      guardRedirects: () => null,
      taskTab: () => ({ webContents: { getURL: () => 'https://example.com/' } }),
      newActionLog: () => ({}), undoSummary: () => null,
      async execute(name, input) { calls.push({ name, at: Date.now() }); await sleep(DELAY); return `${name}:${JSON.stringify(input)}`; },
    });
    const turns = [];
    const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
    let script = [];
    agent.claudeTurn = async function (messages) {
      const step = script.shift();
      turns.push({ at: Date.now(), results: messages.at(-1).content });
      return step || { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 5 } };
    };
    const ask = async () => {
      const m = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
      m.settings = { model: 'claude-sonnet-5' };
      const events = [];
      const t0 = Date.now();
      await agent.loop(m, new AbortController().signal, (e) => events.push(e));
      return { m, ms: Date.now() - t0, events };
    };
    const step = (...uses) => ({ content: uses, stop_reason: 'tool_use', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 5 } });

    script = [step(use('a', 'read_page', { tab_id: 1 }), use('b', 'read_page', { tab_id: 2 }), use('c', 'read_urls', { urls: ['https://a.com'] }))];
    const par = await ask();
    check('parallel: 3 independent reads run together', par.ms < DELAY * 2, `${par.ms} ms for 3 x ${DELAY} ms`);
    check('parallel: results come back in call order', par.m.at(-2).content.map((r) => r.tool_use_id).join('') === 'abc');
    console.log(`INFO  parallel: 3 reads of ${DELAY} ms took ${par.ms} ms (sequential would be ${DELAY * 3} ms)`);

    script = [step(use('a', 'click', { text: 'x' }), use('b', 'type_text', { element_id: 1, text: 'y' }))];
    calls.length = 0;
    const seq = await ask();
    check('parallel: acting tools stay sequential', seq.ms >= DELAY * 2 - 10 && calls[1].at - calls[0].at >= DELAY - 10, `${seq.ms} ms`);

    // identical find repeated across turns, nothing done in between: the second is not run
    script = [step(use('a', 'find', { query: 'price' })), step(use('b', 'find', { query: 'price' }))];
    calls.length = 0;
    const rep = await ask();
    const second = rep.m.filter((x) => x.role === 'user' && Array.isArray(x.content) && x.content[0]?.type === 'tool_result')[1].content[0].content;
    check('repeat: an identical find is answered without running', calls.length === 1 && /Same as your earlier find call/.test(second), `${calls.length} runs; ${second}`);
    check('repeat: the short answer is far smaller than a result', String(second).length < 200);

    // an act in between: it runs again
    script = [step(use('a', 'find', { query: 'price' })), step(use('b', 'click', { text: 'x' })), step(use('c', 'find', { query: 'price' }))];
    calls.length = 0;
    await ask();
    check('repeat: after an action the find runs again', calls.filter((c) => c.name === 'find').length === 2);

    // past the trigger the loop starts stubbing pages
    script = [{ ...step(use('a', 'find', { query: 'q' })), usage: { input_tokens: 70000, output_tokens: 5 } }];
    const big = await ask();
    check('loop: usage over 60k tokens sets the page-stub flag', big.m.pageStub === true);
    script = [step(use('a', 'find', { query: 'q' }))];
    check('loop: normal usage leaves it off', (await ask()).m.pageStub !== true);
  }

  // 5) Repeat nudges come early for identical reads.
  {
    const d = new RepeatDetector();
    const notes = [1, 2, 3].map(() => d.record('find', { query: 'a' }, true));
    check('guard: third identical find carries a nudge', notes[0] === null && notes[1] === null && /same find call 3 times/.test(notes[2]), String(notes));
    const s = new RepeatDetector();
    check('guard: varied reads stay quiet', [1, 2, 3, 4].every((i) => s.record('find', { query: `q${i}` }, true) === null));
    const w = new RepeatDetector();
    check('guard: scroll with the same input is still normal', [1, 2, 3, 4, 5].every(() => w.record('scroll', { direction: 'down' }, true) === null));
  }

  // 6) Sign-offs go to the smallest model; routing is cheap.
  {
    const tier = (p, prev, pinned = false) => modelRoute.tierFor(p, { previous: prev, pinned }).tier;
    const heavy = { tier: 'heavy', turns: 4 };
    check('route: "thanks" after a heavy turn is light', ['thanks', 'Thanks!', 'thank you so much', 'great, thanks', 'ok thanks', 'got it', 'perfect'].every((p) => tier(p, heavy) === 'light'));
    check('route: "ok", "yes", "continue" still follow the previous tier', ['ok', 'yes', 'continue', 'do it'].every((p) => tier(p, heavy) === 'heavy'));
    check('route: a thanks that asks something is not a sign-off', tier('thanks, now refactor the whole codebase across files and debug the race condition', heavy) !== 'light');
    check('route: a pinned CLI session is never lowered by a sign-off', tier('thanks', heavy, true) === 'heavy');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) modelRoute.tierFor('thanks', { previous: heavy });
    const per = Number(process.hrtime.bigint() - t0) / 1e6 / 2000;
    check('route: scoring costs under 5 ms (measured)', per < 5, `${per} ms`);
    console.log(`INFO  route: ${per.toFixed(4)} ms per message`);
  }

  // 7) Coalescing streamed events keeps order and cuts messages.
  {
    const sent = [];
    const timers = [];
    const c = createCoalescer((m) => sent.push(m), { setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    for (let i = 0; i < 100; i++) c.push({ type: 'text', text: `t${i} ` });
    c.push({ type: 'tool', id: 'x', name: 'find' });
    c.push({ type: 'text', text: 'after' });
    c.push({ type: 'thinking', text: 'hmm' });
    c.push({ type: 'done' });
    const order = sent.map((m) => m.type).join(',');
    check('coalesce: order is kept and chunks are joined', order === 'text,tool,text,thinking,done' && sent[0].text.startsWith('t0 t1 ') && sent[0].text.endsWith('t99 '), order);
    check('coalesce: 100 chunks became one message', sent.filter((m) => m.type === 'text').length === 2);
    const odd = [];
    const c2 = createCoalescer((m) => odd.push(m));
    c2.push({ type: 'text', text: 'a', extra: 1 });
    check('coalesce: an event with other fields is sent as is', odd.length === 1 && odd[0].extra === 1);
    const timed = [];
    const c3 = createCoalescer((m) => timed.push(m), { ms: 10 });
    c3.push({ type: 'text', text: 'a' });
    c3.push({ type: 'text', text: 'b' });
    await sleep(40);
    check('coalesce: a held chunk is sent by the timer', timed.length === 1 && timed[0].text === 'ab');
  }

  // 8) The resumable markdown scan gives the same answer as a full scan, at every prefix.
  {
    const para = 'Text with `code` and $$x$$ here.\n\n';
    const text = `${para}- a\n- b\n\n\`\`\`js\nconst a = 1;\n\n\n\`\`\`\n\n$$\nx = 1\n\n$$\n\n\\[\ny\n\\]\n\nend of it\n\n${para}tail without newline`;
    const memo = {};
    let same = true;
    for (let n = 0; n <= text.length; n += 3) if (md.stableLength(text.slice(0, n), memo) !== md.stableLength(text.slice(0, n))) { same = false; break; }
    check('markdown: resumed stableLength equals a full scan at every prefix', same);
    const m2 = {};
    md.stableLength('one\n\ntwo\n\nthree', m2);
    check('markdown: a text that is not an extension starts over', md.stableLength('different\n\nstuff\n\nx', m2) === md.stableLength('different\n\nstuff\n\nx'));
    const big = `${para}${'- item\n\n'.repeat(5000)}`;
    let t0 = process.hrtime.bigint();
    for (let n = 400; n <= big.length; n += 400) md.stableLength(big.slice(0, n));
    const full = Number(process.hrtime.bigint() - t0) / 1e6;
    const memo2 = {};
    t0 = process.hrtime.bigint();
    for (let n = 400; n <= big.length; n += 400) md.stableLength(big.slice(0, n), memo2);
    const resumed = Number(process.hrtime.bigint() - t0) / 1e6;
    check('markdown: resuming is cheaper than rescanning', resumed < full / 3, `${resumed.toFixed(1)} vs ${full.toFixed(1)} ms`);
    console.log(`INFO  markdown: ${Math.round(big.length / 400)} frames over ${big.length} chars: full rescans ${full.toFixed(1)} ms, resumed ${resumed.toFixed(1)} ms`);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})();
