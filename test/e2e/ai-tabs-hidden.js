// [ai tabs] The tabs the AI opens for its own work stay out of the user's way (main.js aiGroupIdOf / signedInReader.reuse / idleAiTab,
// agent.js readSignedIn / parallelTasks). A run that reads one signed-in site over and over, reads pages signed out (research tabs) and
// hands the same two jobs to parallel helpers twice once filled the whole strip with purple "AI: <site> (signed in)" groups, one tab each.
// Now, while that run works:
//  1. the strip gains one folded "AI tabs" label and no tab of its own (no purple group, no new visible tab per step);
//  2. every read of the signed-in site, the parallel ones in one call included, uses one tab;
//  3. the second parallel_tasks on the same two sites reuses the first one's helper tabs;
//  4. the tabs stay reachable from the chat: the card's Tabs list names the signed-in tab, each helper card names its tab, and
//     the chip's click (Go to tab) brings that tab forward.
// Real Lumen, throwaway profile, a fake model (no network, no key), local pages, hidden windows.
// Run alone: LUMEN_TEST_BACKGROUND=1 node test/e2e/ai-tabs-hidden.js
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(150); } return v; };
const serve = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE ${req.url}</h1><p>${'Some text to read on this page. '.repeat(8)}</p></body>`); });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const site = await serve(); // the signed-in site (127.0.0.1) and, as localhost, the pages read signed out
  const helperA = await serve();
  const helperB = await serve();
  const T = `http://127.0.0.1:${site.port}`;
  const L = `http://localhost:${site.port}`;
  const HA = `http://127.0.0.1:${helperA.port}/a`;
  const HB = `http://127.0.0.1:${helperB.port}/b`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ai-tabs-hidden-'));
  const missing = path.join(profile, 'no-such-cli.exe');
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: missing, LUMEN_CODEX_BIN: missing, LUMEN_GROK_BIN: missing, LUMEN_AGY_BIN: missing },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate((_e, now) => global.__patchSettings({ actingHelpers: true, sidebarNewChat: false, closeAiTabs: 'off', aiSignedInSites: [{ host: '127.0.0.1', added: now }] }), Date.now());

    // The fake model. The lead plays global.__fake.script, one tool call per turn, then answers "run done" once global.__fake.release()
    // is called (so the run is still working while the strip is looked at). A helper (system "You are a browser helper") goes to its
    // start address, then reports.
    await app.evaluate((_e, steps) => {
      const fake = global.__fake = { script: steps, release: () => {} };
      const hold = new Promise((r) => { fake.release = r; });
      const textOf = (c) => (Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : String(c ?? ''));
      const reply = (content, stop, wait = null) => {
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 50, output_tokens: 10 } };
        const ready = wait ? wait.then(() => message) : Promise.resolve(message);
        return {
          async *[Symbol.asyncIterator]() { await ready; for (const [index, b] of content.entries()) if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; },
          finalMessage: () => ready,
        };
      };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const msgs = params.messages || [];
        const step = msgs.filter((m) => m.role === 'assistant').length;
        if (String(typeof params.system === 'string' ? params.system : JSON.stringify(params.system || '')).startsWith('You are a browser helper')) {
          const start = /Start at: (\S+)/.exec(textOf(msgs[0]?.content))?.[1] || '';
          if (step === 0) return reply([{ type: 'tool_use', id: `h-${Math.random().toString(36).slice(2)}`, name: 'navigate', input: { url: start } }], 'tool_use');
          return reply([{ type: 'text', text: `REPORT for ${start}` }], 'end_turn');
        }
        if (step < fake.script.length) return reply([{ type: 'text', text: `step ${step + 1}` }, { type: 'tool_use', id: `lead-${step}`, name: fake.script[step].name, input: fake.script[step].input }], 'tool_use');
        return reply([{ type: 'text', text: 'run done' }], 'end_turn', hold);
      } } } });
    }, [
      { name: 'read_urls', input: { urls: [`${T}/todo/a`], as_user: true } },
      { name: 'read_urls', input: { urls: [`${T}/todo/b`], as_user: true } },
      { name: 'read_urls', input: { urls: [`${T}/todo/c`, `${T}/todo/d`], as_user: true } }, // (read side by side, in one call)
      { name: 'read_urls', input: { urls: [`${L}/news/1`, `${L}/news/2`] } }, // signed out: research tabs
      { name: 'parallel_tasks', input: { tasks: [{ task: 'Look at site A', url: HA }, { task: 'Look at site B', url: HB }] } },
      { name: 'parallel_tasks', input: { tasks: [{ task: 'Look at site A again', url: HA }, { task: 'Look at site B again', url: HB }] } },
      { name: 'read_urls', input: { urls: [`${T}/todo/e`], as_user: true } },
    ]);

    const win = () => app.evaluate(() => { const w = global.__windows.list()[0]; return { activeId: w.activeId, ids: w.tabs.map((t) => t.id) }; });
    const aiTabs = () => app.evaluate(() => global.__windows.list()[0].tabs.map((t) => global.__aiTabs.tab(t.id)).filter((t) => t?.openedBy).map((t) => ({ id: t.id, groupId: t.groupId ?? null, signedIn: Boolean(t.aiSignedIn), isolated: Boolean(t.isolated), url: (() => { try { return t.view.webContents.getURL(); } catch { return t.sleepUrl || ''; } })() })));
    const groups = () => app.evaluate(() => [...global.__tabGroups.groups.values()].map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed })));
    const strip = () => ui.evaluate(() => ({ labels: [...document.querySelectorAll('#tabs .group-label .group-name')].map((l) => l.textContent.trim()), tabs: [...document.querySelectorAll('#tabs .tab')].filter((el) => el.offsetParent !== null).length }));
    const stepsDone = () => ui.evaluate(() => /step 7/.test(document.body.innerText));

    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#prompt', { state: 'visible' });
    const user = (await win()).activeId;
    await waitFor(async () => (await strip()).tabs > 0);
    const before = await strip();
    const groupsBefore = (await groups()).length;

    await ui.fill('#prompt', 'Add my tasks: chat-A');
    await ui.press('#prompt', 'Enter');
    // (the last step done, and the run held on its answer: every tab it opened is still open)
    const ready = await waitFor(async () => { if (!(await stepsDone())) return null; const ai = await aiTabs(); return ai.filter((t) => t.signedIn).length >= 1 && ai.filter((t) => !t.signedIn && !t.isolated).length >= 2 && ai.filter((t) => t.isolated).length >= 2 ? ai : null; }, 60000);
    await sleep(1500); // (the last read's tab has settled into its group, the strip has redrawn)
    const ai = await aiTabs();
    check('(set up) the run opened its tabs: signed-in, research and helper tabs', Boolean(ready), JSON.stringify(ai));

    // ---- 1. hidden: one folded "AI tabs" label, no new tab in the strip
    const g = await groups();
    const after = await strip();
    const aiGroup = g.find((x) => x.name === 'AI tabs');
    check('(1) the strip gains at most one group, and it is the folded gray "AI tabs" group', g.length - groupsBefore <= 1 && Boolean(aiGroup) && aiGroup.collapsed === true && aiGroup.color === 'gray', JSON.stringify({ groupsBefore, g }));
    check('(1) no purple "AI: ..." group, and every tab the AI opened is in that one group', g.every((x) => !/^AI: /.test(x.name)) && ai.length > 0 && ai.every((t) => t.groupId === aiGroup?.id), JSON.stringify({ g, ai }));
    check('(1) the strip shows one label more and not one tab more', after.labels.length - before.labels.length <= 1 && after.labels.filter((l) => l === 'AI tabs').length === 1 && after.tabs === before.tabs, JSON.stringify({ before, after }));
    check('(1) the user is still on their own tab', (await win()).activeId === user, JSON.stringify(await win()));

    // ---- 2. one tab per signed-in site: five reads (two of them side by side) in one tab
    const signedIn = ai.filter((t) => t.signedIn);
    check('(2) every read of the signed-in site used one tab', signedIn.length === 1, JSON.stringify(signedIn));
    check('(2) ...which shows the last page read', signedIn.length === 1 && signedIn[0].url.endsWith('/todo/e'), JSON.stringify(signedIn));

    // ---- 3. the second parallel_tasks on the same sites reused the helper tabs
    const helpers = ai.filter((t) => !t.signedIn && !t.isolated);
    check('(3) two parallel_tasks calls on the same two sites left two helper tabs, not four', helpers.length === 2, JSON.stringify(helpers));
    check('(3) the research reads opened one tab per page', ai.filter((t) => t.isolated).length === 2, JSON.stringify(ai.filter((t) => t.isolated)));

    // ---- 4. reachable from the chat
    const reach = await ui.evaluate(() => ({
      chips: [...document.querySelectorAll('#messages .act-tabs-list .tab-ref[data-key]')].map((c) => parseInt(c.dataset.key, 10)),
      helperTabs: [...document.querySelectorAll('#messages .helper-card')].map((c) => Number(c.dataset.tab)).filter(Number.isInteger),
    }));
    check('(4) the card\'s Tabs list names the signed-in tab', signedIn.length === 1 && reach.chips.includes(signedIn[0].id), JSON.stringify({ reach, signedIn }));
    check('(4) each helper card names its tab', helpers.length === 2 && helpers.every((h) => reach.helperTabs.includes(h.id)), JSON.stringify({ reach, helpers }));
    if (signedIn.length === 1 && reach.chips.includes(signedIn[0].id)) {
      await ui.evaluate((id) => { const c = [...document.querySelectorAll('#messages .act-tabs-list .tab-ref[data-key]')].find((x) => parseInt(x.dataset.key, 10) === id); c.closest('details')?.setAttribute('open', ''); c.click(); }, signedIn[0].id);
      check('(4) its chip brings that tab forward (Go to tab)', await waitFor(async () => (await win()).activeId === signedIn[0].id, 8000), JSON.stringify(await win()));
    }
    await app.evaluate(() => global.__fake.release());
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    for (const s of [site, helperA, helperB]) s.server.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall ai-tabs-hidden checks passed');
  process.exit(failures ? 1 : 0);
})();
