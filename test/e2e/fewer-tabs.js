// Fewer tabs (features/open-tab-reuse.js, agent.js reuseForOpenTab): open_tab opens no tab it does not need. A fake Claude client whose tool
// calls go through the real open_tab path; no network, no key. A chat's second open_tab loads in its own tab, the same page again opens
// nothing, a page the user already has open is left alone, and asking for "a new tab" still opens one.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 12000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..', '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
});

// global.__script[who]: the tool calls, one per turn ({ name, input }); then the model answers "X done". global.__hold[who] keeps the
// last answer from finishing; global.__fail[who] makes the answer throw instead (the run ends in an error).
const fakeModel = (app, base) => app.evaluate((_e, b) => {
  global.__script = {};
  global.__hold = {};
  global.__fail = {};
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    const done = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result')).length;
    const usage = { input_tokens: 100, output_tokens: 20 };
    const calls = global.__script[who] || [];
    if (done < calls.length) {
      const call = calls[done];
      const text = `${who} step ${done + 1}`;
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}-${done}`, name: call.name, input: { ...call.input, url: call.input.url ? b + call.input.url : undefined } }], usage }),
      };
    }
    const text = `${who} done`;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
        if (global.__hold[who]) await global.__hold[who];
        if (global.__fail[who]) throw new Error('the model failed');
      },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
    };
  } } } });
}, base);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE ${req.url}</h1><input id="f" type="text"><a id="l" href="/link${req.url}" target="_blank">link</a></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fewertabs-'));
  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  await app.evaluate(() => global.__settings.backend.set('groupAiTabs', false)); // (these paths click the AI's tabs loose in the strip; the folded group is ai-tab-group.js)
  await app.evaluate(() => global.__settings.backend.set('closeAiTabs', 'always'));
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await fakeModel(app, base);

  const tabsNow = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs.map((t) => ({ id: t.id, url: t.url }))));
  const aiTabs = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs).filter((t) => global.__aiTabs.tab(t.id)?.openedBy).map((t) => t.url));
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const bodyText = () => ui.evaluate(() => document.body.innerText);
  const script = (who, calls) => app.evaluate((_e, a) => { global.__script[a.who] = a.calls; }, { who, calls });
  const newChat = async () => { await ui.click('#new-chat'); await sleep(300); };
  const finish = async (who) => { await waitFor(async () => new RegExp(who + ' done').test(await bodyText()), 30000); await sleep(500); };
  const open = (p) => ({ name: 'open_tab', input: { url: p } });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#sidebar', { state: 'visible' });
  await app.evaluate(({ webContents }, u) => { webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).loadURL(u); }, base + '/user');
  await waitFor(async () => (await tabsNow()).some((t) => t.url.endsWith('/user')), 10000);
  const before = (await tabsNow()).length;

  // 1. Three open_tab calls: two pages, then the second again. One AI tab, on the last new page.
  await script('A', [open('/a1'), open('/a2'), open('/a2')]);
  await send('chat-A: look at these pages');
  await finish('A');
  const a = await aiTabs();
  check('A: three open_tab calls leave one AI tab, not three', a.length === 1, JSON.stringify(a));
  check('A: that tab shows the last page (the chat own tab was reused)', a[0]?.endsWith('/a2'), JSON.stringify(a));
  check('A: one tab more than before in all', (await tabsNow()).length === before + 1, JSON.stringify(await tabsNow()));

  // 2. A page the user already has open: nothing opens, the user's tab is left as it is.
  await newChat();
  const beforeB = await tabsNow();
  await script('B', [open('/user')]);
  await send('chat-B: check the page');
  await finish('B');
  const afterB = await tabsNow();
  check('B: open_tab on a page already open in the user tab opens no tab', afterB.length <= beforeB.length && afterB.filter((t) => t.url.endsWith('/user')).length === 1, JSON.stringify(afterB));
  check('B: the user tab is where it was', afterB.some((t) => t.url.endsWith('/user')), JSON.stringify(afterB));

  // 3. The user asks for new tabs: each opens one.
  await newChat();
  const beforeC = (await aiTabs()).length;
  await script('C', [open('/c1'), open('/c2')]);
  await send('chat-C: open both in a new tab each');
  await finish('C');
  const c = await aiTabs();
  check('C: "in a new tab" opens a tab for each page', c.length === beforeC + 2 && c.some((u) => u.endsWith('/c1')) && c.some((u) => u.endsWith('/c2')), JSON.stringify(c));

  check('no script errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  console.log(failures ? failures + ' check(s) failed' : 'All checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
