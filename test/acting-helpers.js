// [acting helpers] parallel_tasks in a real window (agent.js parallelTasks / stopHelper, the renderer's helper cards), with a fake
// Claude (no network, no key) and local sites on two ports each (two hosts), a throwaway profile, hidden windows:
//  1. with "Let helpers act in tabs" on, the lead hands 2 jobs to helpers: two helper cards show a status, a step and their tab; each
//     helper clicks the button on its own site; both finish; the lead gets both reports inside one untrusted wrapper;
//  2. in Ask mode each helper's first click on a new site shows the usual approval card, marked "Helper n:"; Allow lets it go on;
//  3. a helper card's Stop stops that helper only: its card says Stopped and its tab closes, while the other one finishes;
//  4. with the setting off the tool is not offered (and refused if called anyway), and plan mode refuses it too;
//  5. helper tabs never become the user's tab: the tab in front stays the user's, and in the strip they are marked as the AI's.
// Run alone: LUMEN_TEST_BACKGROUND=1 node test/acting-helpers.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// A site with one button; a press is recorded server side (GET /pressed), so a check never depends on a tab that may be closed.
const hits = [];
const site = (label) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/pressed')) { hits.push(label); res.setHeader('Content-Type', 'text/plain'); return res.end('ok'); }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Site ${label}</title><body><h1>Site ${label}</h1><button onclick="fetch('/pressed').then(() => { document.title = 'Pressed ${label}'; document.querySelector('h1').textContent = 'Pressed ${label}'; })">Press</button></body>`);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, label, url: `http://127.0.0.1:${server.address().port}/`, host: `127.0.0.1:${server.address().port}` }));
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const sites = {};
  for (const label of ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']) sites[label] = await site(label);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-acting-helpers-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  const ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await app.evaluate(() => global.__patchSettings({ actingHelpers: true }));

  // The fake model. The lead (any call that is not a helper's) calls parallel_tasks with __fake.leadInput on its first turn and
  // records the tool result it gets back; a helper (system "You are a browser helper") navigates to its start URL, clicks Press,
  // then reports. __fake.hang[url]: that helper's click turn waits until it is stopped. __fake.hold: helpers' report turns wait for
  // __fake.release().
  await app.evaluate(() => {
    const fake = global.__fake = { leadInput: null, leadTools: [], leadResults: [], helperTurns: 0, hang: {}, hold: null, release: () => {} };
    const sysText = (s) => (typeof s === 'string' ? s : JSON.stringify(s || ''));
    const textOf = (c) => (Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : String(c ?? ''));
    const reply = (content, stop, signal, wait = null) => {
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 50, output_tokens: 10 } };
      const ready = new Promise((resolve, reject) => {
        if (!wait) return resolve(message);
        if (signal?.aborted) return reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })), { once: true });
        wait.then(() => resolve(message));
      });
      ready.catch(() => {});
      return {
        async *[Symbol.asyncIterator]() { await ready; for (const [index, b] of content.entries()) if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; },
        finalMessage: () => ready,
      };
    };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts = {}) => {
      const msgs = params.messages || [];
      if (sysText(params.system).startsWith('You are a browser helper')) {
        fake.helperTurns++;
        const start = /Start at: (\S+)/.exec(textOf(msgs[0]?.content))?.[1] || '';
        const step = msgs.filter((m) => m.role === 'assistant').length;
        if (step === 0) return reply([{ type: 'tool_use', id: `h-nav-${fake.helperTurns}`, name: 'navigate', input: { url: start } }], 'tool_use', opts.signal);
        if (step === 1) {
          const hang = fake.hang[start] ? new Promise(() => {}) : null; // (resolved only by Stop: the abort rejects it)
          return reply([{ type: 'tool_use', id: `h-click-${fake.helperTurns}`, name: 'click', input: { text: 'Press' } }], 'tool_use', opts.signal, hang);
        }
        const last = msgs[msgs.length - 1];
        const result = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result').map((b) => textOf(b.content)).join(' ') : '';
        return reply([{ type: 'text', text: `REPORT for ${start}: clicked Press (${result.replace(/\s+/g, ' ').slice(0, 120)})` }], 'end_turn', opts.signal, fake.hold);
      }
      fake.leadTools = (params.tools || []).map((t) => t.name);
      const last = msgs[msgs.length - 1];
      const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
      if (results.length) {
        fake.leadResults.push({ text: results.map((r) => textOf(r.content)).join('\n'), error: results.some((r) => r.is_error), tools: fake.leadTools });
        return reply([{ type: 'text', text: 'All done.' }], 'end_turn', opts.signal);
      }
      if (!fake.leadInput) return reply([{ type: 'text', text: 'Nothing to do.' }], 'end_turn', opts.signal);
      return reply([{ type: 'tool_use', id: `lead-${Date.now()}`, name: 'parallel_tasks', input: fake.leadInput }], 'tool_use', opts.signal);
    } } } });
  });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#prompt', { state: 'visible' });
  // Every helper card change, as the user would have seen it (a step is shown only while it runs).
  await ui.evaluate(() => {
    window.__helperSeen = [];
    const record = () => {
      for (const c of document.querySelectorAll('#messages .helper-card')) {
        window.__helperSeen.push({ name: c.querySelector('.helper-card-name')?.textContent, state: c.querySelector('.helper-card-state')?.textContent, step: c.querySelector('.helper-card-step')?.textContent, tab: c.dataset.tab || '', chip: !c.querySelector('.helper-card-tab')?.hidden });
      }
    };
    new MutationObserver(record).observe(document.getElementById('messages'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const cards = () => ui.evaluate(() => [...document.querySelectorAll('#messages .helper-card')].map((c) => ({ name: c.querySelector('.helper-card-name').textContent, state: c.querySelector('.helper-card-state').textContent, step: c.querySelector('.helper-card-step').textContent, tab: c.dataset.tab || '', stopShown: !c.querySelector('.helper-card-stop').hidden })));
  const running = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
  const resultsCount = () => app.evaluate(() => global.__fake.leadResults.length);
  const lastResult = () => app.evaluate(() => global.__fake.leadResults[global.__fake.leadResults.length - 1] || null);
  const tabs = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, url: t.url, active: t.active })));
  const newChat = async () => { await ui.click('#new-chat'); await waitFor(async () => (await ui.evaluate(() => document.querySelectorAll('#messages .helper-card, #messages .msg.user').length)) === 0); };
  const send = async (text, { plan = false } = {}) => {
    if (plan) await ui.evaluate((t) => ask(t, [], null, undefined, { plan: true }), text); // eslint-disable-line no-undef
    else { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); }
  };
  const runEnds = (before) => waitFor(async () => (await resultsCount()) > before && !(await running()), 45000);
  const setLead = (input) => app.evaluate((_e, i) => { global.__fake.leadInput = i; }, input);
  const twoTasks = (a, b) => ({ tasks: [{ task: `Press the button on site ${a.label}`, url: a.url }, { task: `Press the button on site ${b.label}`, url: b.url }] });

  // ---- 1 + 5. two helpers, two sites (test mode auto-allows), the helper tabs while they work
  const userTabBefore = (await tabs()).find((t) => t.active);
  await setLead(twoTasks(sites.A1, sites.B1));
  await app.evaluate(() => { global.__fake.hold = new Promise((r) => { global.__fake.release = r; }); });
  let before = await resultsCount();
  await send('Press the button on both sites');
  // (both helpers have clicked and wait on their report turn: their tabs are open)
  const working = await waitFor(async () => { const c = await cards(); return c.length === 2 && c.every((x) => x.tab) && hits.includes('A1') && hits.includes('B1') ? c : null; }, 30000);
  check('(1) two helper cards appear, one per task, each with its tab', working && working.map((c) => c.name).join('|') === 'Helper 1|Helper 2' && working.every((c) => c.tab && c.stopShown), JSON.stringify(working || await cards()));
  check('(1) each helper clicked the button on its own site', hits.filter((h) => h === 'A1').length === 1 && hits.filter((h) => h === 'B1').length === 1, JSON.stringify(hits));
  const seen = await ui.evaluate(() => window.__helperSeen);
  for (const n of [1, 2]) {
    const mine = seen.filter((s) => s.name === `Helper ${n}`);
    check(`(1) Helper ${n}'s card showed a working status and a step`, mine.some((s) => s.state === 'Working') && mine.some((s) => /Clicking|Opening|Reading|Looking/.test(s.step || '')), JSON.stringify(mine.slice(-6)));
  }
  const helperTabIds = (working || []).map((c) => Number(c.tab));
  const during = await tabs();
  const strip = await ui.evaluate((ids) => ids.map((id) => { const el = document.querySelector(`.tab[data-id="${id}"]`); return { id, shown: Boolean(el), ai: Boolean(el?.classList.contains('ai-opened')), active: Boolean(el?.classList.contains('active')) }; }), helperTabIds);
  check('(5) the helpers\' tabs are open while they work, and the tab in front is still the user\'s', helperTabIds.length === 2 && helperTabIds.every((id) => during.some((t) => t.id === id)) && during.find((t) => t.active)?.id === userTabBefore?.id, JSON.stringify({ during, userTabBefore, helperTabIds }));
  check('(5) in the strip a helper tab is either hidden or marked as the AI\'s, never shown as a plain or active tab', strip.length === 2 && strip.every((s) => !s.active && (!s.shown || s.ai)), JSON.stringify(strip));
  const userTabsMarked = await ui.evaluate((ids) => [...document.querySelectorAll('.tab[data-id]')].filter((el) => !ids.includes(Number(el.dataset.id)) && el.classList.contains('ai-opened')).length, helperTabIds);
  check('(5) the user\'s own tabs are not marked as the AI\'s', userTabsMarked === 0, String(userTabsMarked));
  await app.evaluate(() => global.__fake.release());
  await runEnds(before);
  const done1 = await cards();
  check('(1) both helpers finish: their cards say Done, with no step and no Stop', done1.length === 2 && done1.every((c) => c.state === 'Done' && !c.step && !c.stopShown), JSON.stringify(done1));
  const r1 = await lastResult();
  const body1 = r1?.text || '';
  check('(1) the lead gets both reports inside one untrusted wrapper', /^<untrusted_page_content>\n[\s\S]*<\/untrusted_page_content>$/.test(body1.trim()) && (body1.match(/<untrusted_page_content>/g) || []).length === 1 && body1.includes(`REPORT for ${sites.A1.url}`) && body1.includes(`REPORT for ${sites.B1.url}`), body1);
  check('(1) ...each marked done with its tab', /Helper 1 \[done, 3 steps\] tab \d+/.test(body1) && /Helper 2 \[done, 3 steps\] tab \d+/.test(body1) && !r1.error, body1);
  check('(1) the lead was offered parallel_tasks', (r1?.tools || []).includes('parallel_tasks'), JSON.stringify(r1?.tools));

  // ---- 2. Ask mode: each helper's first click on a new site asks on the chat's card, marked with its number
  await newChat();
  await app.evaluate(() => { global.__fake.hold = null; global.__agent.browser.autoApprove = () => false; }); // (tests auto-allow by default)
  await setLead(twoTasks(sites.A2, sites.B2));
  before = await resultsCount();
  await send('Press the button on both sites, asking first');
  const asked = await waitFor(async () => { const a = await ui.evaluate(() => [...document.querySelectorAll('#messages .approval')].map((c) => ({ title: c.querySelector('.approval-title')?.textContent || '', helper: c.dataset.helper || '' }))); return a.length === 2 ? a : null; }, 30000);
  const titles = (asked || []).map((a) => a.title).sort();
  check('(2) each helper\'s first click on a new site shows an approval card', Boolean(asked) && asked.length === 2, JSON.stringify(asked));
  check('(2) ...labelled "Helper n:" and naming its site', titles.length === 2 && titles[0].startsWith('Helper 1:') && titles[1].startsWith('Helper 2:') && titles.some((t) => t.includes(sites.A2.host)) && titles.some((t) => t.includes(sites.B2.host)), JSON.stringify(titles));
  check('(2) nothing was clicked before the answer', !hits.includes('A2') && !hits.includes('B2'), JSON.stringify(hits));
  await ui.evaluate(() => { for (const b of document.querySelectorAll('#messages .approval .btn.primary')) b.click(); });
  await runEnds(before);
  const r2 = await lastResult();
  check('(2) once allowed, both helpers go on: they click and finish', hits.includes('A2') && hits.includes('B2') && /Helper 1 \[done/.test(r2?.text || '') && /Helper 2 \[done/.test(r2?.text || ''), `${JSON.stringify(hits)} ${r2?.text}`);
  await app.evaluate(() => { global.__agent.browser.autoApprove = () => true; });

  // ---- 3. Stop on one helper's card: that one stops (its tab closes), the other finishes
  await newChat();
  await app.evaluate((_e, url) => { global.__fake.hang = { [url]: true }; }, sites.B3.url);
  await setLead(twoTasks(sites.A3, sites.B3));
  before = await resultsCount();
  await send('Press the button on both sites, I may stop one');
  const stuck = await waitFor(async () => { const c = await cards(); const two = c.find((x) => x.name === 'Helper 2'); return two?.tab && two.stopShown && hits.includes('A3') ? two : null; }, 30000);
  check('(3) the helper to stop is working in its own tab', Boolean(stuck), JSON.stringify(await cards()));
  const stoppedTab = Number(stuck?.tab);
  await ui.evaluate(() => [...document.querySelectorAll('#messages .helper-card')].find((c) => c.querySelector('.helper-card-name').textContent === 'Helper 2').querySelector('.helper-card-stop').click());
  await runEnds(before);
  const done3 = await cards();
  const one = done3.find((c) => c.name === 'Helper 1');
  const two = done3.find((c) => c.name === 'Helper 2');
  check('(3) the stopped helper\'s card says Stopped', two?.state === 'Stopped' && !two.stopShown, JSON.stringify(done3));
  check('(3) ...and its tab is closed', Number.isInteger(stoppedTab) && !(await tabs()).some((t) => t.id === stoppedTab), JSON.stringify({ stoppedTab, tabs: await tabs() }));
  check('(3) the other helper finished', one?.state === 'Done' && hits.includes('A3') && !hits.includes('B3'), JSON.stringify({ done3, hits }));
  const r3 = await lastResult();
  check('(3) the lead hears which one was stopped and gets the other\'s report', /Helper 1 \[done/.test(r3?.text || '') && /Helper 2 \[stopped\]/.test(r3?.text || '') && (r3?.text || '').includes(`REPORT for ${sites.A3.url}`), r3?.text);
  check('(3) stopping one helper did not stop the chat\'s run (the lead answered after)', await ui.evaluate(() => /All done\./.test(document.getElementById('messages').textContent)), '');
  await app.evaluate(() => { global.__fake.hang = {}; });

  // ---- 4. setting off: not offered, refused if called; plan mode: not offered, refused
  await newChat();
  await app.evaluate(() => global.__patchSettings({ actingHelpers: false }));
  const pressedBefore = hits.length;
  before = await resultsCount();
  await send('Press the buttons with helpers (setting off)');
  await runEnds(before);
  const r4 = await lastResult();
  check('(4) with the setting off, parallel_tasks is not offered to the model', !(r4?.tools || []).includes('parallel_tasks') && (r4?.tools || []).includes('click'), JSON.stringify(r4?.tools));
  check('(4) ...and a call anyway is refused, with no helper', r4?.error && /Acting helpers are off/.test(r4.text) && hits.length === pressedBefore && (await cards()).length === 0, JSON.stringify(r4));
  await newChat();
  await app.evaluate(() => global.__patchSettings({ actingHelpers: true }));
  before = await resultsCount();
  await send('Plan pressing the buttons with helpers', { plan: true });
  await runEnds(before);
  const r5 = await lastResult();
  check('(4) in plan mode parallel_tasks is not offered (propose_plan is)', !(r5?.tools || []).includes('parallel_tasks') && (r5?.tools || []).includes('propose_plan'), JSON.stringify(r5?.tools));
  check('(4) ...and plan mode refuses a call anyway, with no helper', r5?.error && /^Plan mode/.test(r5.text.trim()) && hits.length === pressedBefore && (await cards()).length === 0, JSON.stringify(r5));

  // ---- 5 (after). no helper tab is the one in front, and none is left marked as the user's
  const end = await tabs();
  check('(5) after all runs the tab in front is still the user\'s own', end.find((t) => t.active)?.id === userTabBefore?.id, JSON.stringify({ end, userTabBefore }));

  await app.close();
  for (const s of Object.values(sites)) s.server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
