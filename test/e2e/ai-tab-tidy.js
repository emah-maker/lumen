// Lumen tidies the AI's tabs by itself (features/ai-tab-tidy.js, main.js "[ai tab tidy]"), end to end with a fake Claude client whose
// tool calls go through the real open_tab path and local fixture pages: no network, no key. Checks that a run that opened 5 tabs
// leaves only the one its answer links to, in a "Kept from …" group; that the reply says "Closed 4 tabs" with Undo; that the sweep puts
// that kept tab to sleep after 15 idle minutes and closes it after the grace period (with Undo); that a finished run's leftover tab
// closes on the sweep while the user's own tabs stay; and that a chat keeps about 8 tabs, the ones closed to make room on the same Undo.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const MIN = 60 * 1000;

// The model: a message that names "chat-X" is chat X. global.__plans[X] tabs are opened one per turn with open_tab (the real tool), then
// it answers "X done", with global.__answer[X] after it (a link to one of the pages, say). global.__hold[X] keeps the answer from finishing.
const fakeModel = (app, base) => app.evaluate((_e, b) => {
  global.__plans = {};
  global.__answer = {};
  global.__hold = {};
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    const done = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result')).length;
    const usage = { input_tokens: 100, output_tokens: 20 };
    if (done < (global.__plans[who] || 0)) {
      const text = `${who} opening ${done + 1}`;
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}-${done}`, name: 'open_tab', input: { url: `${b}/${who}-${done}` } }], usage }),
      };
    }
    const text = `${who} done. ${global.__answer[who] || ''}`;
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; if (global.__hold[who]) await global.__hold[who]; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
    };
  } } } });
}, base);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE ${req.url}</h1></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aitidy-probe-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', LUMEN_AI_TIDY_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const prefs = await app.evaluate(() => global.__settings.backend.prefs());
  check('(set up) on by default: tidy on, 1 hour grace, Close when the AI finishes, AI tabs grouped', prefs.aiTabsTidy === true && prefs.aiTabsGrace === '1h' && prefs.closeAiTabs === 'always' && prefs.groupAiTabs !== false, JSON.stringify([prefs.aiTabsTidy, prefs.aiTabsGrace, prefs.closeAiTabs, prefs.groupAiTabs]));
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await fakeModel(app, base);

  const urlsNow = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs.map((t) => t.url)));
  const hasUrl = async (suffix) => (await urlsNow()).some((u) => u.endsWith(suffix));
  const marks = () => app.evaluate(() => global.__aiTabTidy.marks());
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const bodyText = () => ui.evaluate(() => document.body.innerText);
  const newChat = async () => { await ui.click('#new-chat'); await sleep(300); };
  const rowText = () => ui.evaluate(() => [...document.querySelectorAll('#messages .ai-tabs')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).pop() || '');
  const sweep = (now) => app.evaluate((_e, n) => global.__aiTabTidy.sweep(n), now);
  const age = (suffix, ms) => app.evaluate((_e, a) => { for (const w of global.__windows.list()) for (const t of w.tabs) if (t.url.endsWith(a.suffix)) { const tab = global.__aiTabs.tab(t.id); if (tab?.openedBy) { tab.openedBy.at -= a.ms; if (tab.openedBy.usedAt) tab.openedBy.usedAt -= a.ms; } } }, { suffix, ms });

  // ---- set up: the user's own tabs, and the sidebar
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#sidebar', { state: 'visible' });
  await app.evaluate(({ webContents }, u) => { webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).loadURL(u); }, `${base}/user`);
  await waitFor(() => hasUrl('/user'));
  await app.evaluate((_e, u) => global.__agent.browser.openTab(u, { background: true }).id, `${base}/mine`);
  check('(set up) the user has two tabs of their own, unmarked', (await marks()).length === 0, JSON.stringify(await marks()));

  // ---- 1. An agent opens 5 tabs and finishes: only the one its answer links to stays.
  await newChat();
  await app.evaluate((_e, b) => { global.__plans.T = 5; global.__answer.T = `The result is at ${b}/T-2.`; }, base);
  await send('chat-T: look at five pages, each in a new tab');
  await waitFor(async () => /T done/.test(await bodyText()), 20000);
  const left = await waitFor(async () => { const u = (await urlsNow()).filter((x) => /\/T-\d$/.test(x)); return u.length === 1 && u; }, 15000);
  check('a run that opened 5 tabs leaves only the one its answer links to', Boolean(left) && left[0].endsWith('/T-2'), JSON.stringify(await urlsNow()));
  const kept = (await marks()).find((x) => x.url.endsWith('/T-2'));
  check('...kept as a result (still the AI\'s: keep, linked)', Boolean(kept?.keep && kept.linked), JSON.stringify(kept));
  const inKept = await waitFor(async () => { const k = (await marks()).find((x) => x.url.endsWith('/T-2')); return /^Kept from /.test(k?.group || '') && k; });
  check('...in a "Kept from …" group, out of the folded AI tabs group', Boolean(inKept), JSON.stringify(await marks()));
  check('...the reply says "Closed 4 tabs" with Undo, no step spent on closing', Boolean(await waitFor(async () => /Closed 4 tabs/.test(await rowText()) && /Undo/.test(await rowText()))), await rowText());
  check('...and the model was never asked to close one', !(await bodyText()).includes('Closing tab'));
  check('...the user\'s own tabs are still open', (await hasUrl('/user')) && (await hasUrl('/mine')), JSON.stringify(await urlsNow()));

  // ---- 2. The sweep: the kept tab sleeps after 15 idle minutes, closes after the grace period (with Undo).
  const now = () => app.evaluate(() => Date.now());
  await age('/T-2', 20 * MIN);
  const s1 = await sweep(await now());
  const asleep = (await marks()).find((x) => x.url.endsWith('/T-2'));
  check('sweep: the kept tab idle 20 minutes sleeps, not closed', s1.slept === 1 && s1.closed === 0 && asleep?.asleep === true, JSON.stringify({ s1, asleep }));
  await age('/T-2', 60 * MIN);
  const s2 = await sweep(await now());
  check('sweep: past the 1 hour grace it closes', s2.closed === 1 && !(await hasUrl('/T-2')), JSON.stringify({ s2, urls: await urlsNow() }));
  const back = await app.evaluate((_e, tk) => global.__aiTabs.reopen(tk), s2.token);
  check('...and Undo brings it back', back.reopened === 1 && Boolean(await waitFor(() => hasUrl('/T-2'))), JSON.stringify(back));
  check('...as the user\'s own tab now', !(await marks()).some((x) => x.url.endsWith('/T-2')), JSON.stringify(await marks()));

  // ---- 3. A finished run's leftover (kept when it ended, a helper's late tab, a restored one) closes on the sweep; the user's stay.
  const leftId = await app.evaluate((_e, u) => { const id = global.__agent.browser.openTab(u, { background: true }).id; const tab = global.__aiTabs.tab(id); tab.openedBy = { chatId: null, runId: 4242, at: Date.now() - 5 * 60 * 1000 }; return id; }, `${base}/leftover`);
  await waitFor(() => hasUrl('/leftover'));
  const s3 = await sweep(await now());
  check('sweep: a finished run\'s leftover tab closes', s3.closed === 1 && Boolean(await waitFor(async () => !(await hasUrl('/leftover')))), JSON.stringify({ s3, leftId, urls: await urlsNow() }));
  check('...the user\'s own tabs are untouched', (await hasUrl('/user')) && (await hasUrl('/mine')) && (await hasUrl('/T-2')), JSON.stringify(await urlsNow()));
  const s4 = await sweep(await now() + 10 * 60 * MIN);
  check('sweep: with nothing of the AI\'s left, ten hours later it closes nothing', s4.closed === 0 && (await hasUrl('/user')) && (await hasUrl('/mine')), JSON.stringify(s4));

  // ---- 4. About 8 tabs per chat: opening more closes the oldest idle one, and the reply's Undo covers those too.
  await newChat();
  await app.evaluate(() => { global.__plans.C = 11; global.__hold.C = new Promise((r) => { global.__releaseC = r; }); });
  await send('chat-C: open eleven pages, each in a new tab');
  const most = await waitFor(async () => /C opening 11/.test(await bodyText()) && (await waitFor(async () => (await urlsNow()).some((x) => x.endsWith('/C-10')), 10000)) && (await urlsNow()).filter((x) => /\/C-\d+$/.test(x)), 30000);
  const cOpen = async () => (await urlsNow()).filter((x) => /\/C-\d+$/.test(x));
  await waitFor(async () => (await cOpen()).length <= 9, 15000); // (a close takes a second or two: the page check, its beforeunload)
  const open = await cOpen();
  check('cap: a chat that opened 11 tabs has about 8 open', Boolean(most) && open.length <= 9 && open.length >= 7, JSON.stringify(open));
  check('...the oldest went first', !open.some((x) => x.endsWith('/C-0')) && open.some((x) => x.endsWith('/C-10')), JSON.stringify(open));
  await app.evaluate(() => global.__releaseC());
  await waitFor(async () => /C done/.test(await bodyText()), 15000);
  const row = await waitFor(async () => { const m = /Closed (\d+) tabs/.exec(await rowText()); return m && Number(m[1]); });
  check('...and the reply\'s "Closed 11 tabs" counts the ones closed to make room, on one Undo', row === 11, await rowText());
  check('no script errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
