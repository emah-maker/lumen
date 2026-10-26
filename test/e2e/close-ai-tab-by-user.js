// The USER closing a tab the AI is on (or was on) never closes the window while it has other tabs: Ctrl+W, the tab's X and the tab menu go
// through requestCloseTab; a fake Claude client drives the real open_tab path, so the tab is marked the AI's and a run is (or was) working in it.
// Covers: a run still going in the tab, a run that finished (tab kept), the AI working in the user's own tab, a sleeping AI tab, and the
// window's last tab (the user's close still closes it, as for any tab). No network, no key.
// Run with LUMEN_TEST_BACKGROUND=1 and a temp CLAUDE_BROWSER_PROFILE (scripts/e2e-lock.js).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };

// The model: "chat-X" opens global.__plans[X] tabs with the real open_tab tool, then answers; global.__hold[X] keeps the last answer from
// finishing, so the run is still going.
const fakeModel = (app, base) => app.evaluate((_e, b) => {
  global.__plans = {};
  global.__hold = {};
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    const done = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result')).length;
    const usage = { input_tokens: 100, output_tokens: 20 };
    if (done < (global.__plans[who] || 0)) {
      const text = `${who} opening ${done + 1}`;
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}-${done}`, name: 'open_tab', input: { url: `${b}/${who}-${done}`, keep: true } }], usage }),
      };
    }
    const text = `${who} done`;
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; if (global.__hold[who]) await global.__hold[who]; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
    };
  } } } });
}, base);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE ${req.url}</h1></body>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclose-user-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_AGENT_WINDOW_GRACE_MS: '1200', ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    await fakeModel(app, base);
    const wins = () => app.evaluate(() => global.__windows.list().map((w) => ({ id: w.windowId, tabs: w.tabs.map((t) => t.id), activeId: w.activeId })));
    const main = (await wins())[0];
    const bodyText = () => ui.evaluate(() => document.body.innerText);
    const newChat = async () => { if (!(await ui.isVisible('#sidebar'))) await ui.evaluate(() => document.getElementById('toggle-sidebar').click()); await ui.waitForSelector('#sidebar', { state: 'visible' }); await ui.click('#new-chat'); await sleep(300); };
    const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const marks = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs).map((t) => ({ id: t.id, mark: global.__aiTabs.tab(t.id)?.openedBy || null })).filter((t) => t.mark));
    const stillOpen = async (id) => (await wins()).some((w) => w.tabs.includes(id));
    const userClose = (id) => app.evaluate((_e, i) => global.__closeTabInteractive(i), id);
    const second = await app.evaluate((_e, w) => global.__windows.open(w, 'about:blank').id, main.id); // a second user tab
    await waitFor(async () => (await wins())[0].tabs.length === 2);

    // 1. A run is still going and has opened a tab; the user closes that tab.
    await app.evaluate(() => { global.__hold.A = new Promise((r) => { global.__release = r; }); global.__plans.A = 1; });
    await send('chat-A: open one and keep working');
    const aTab = (await waitFor(async () => { const x = await marks(); return x.length === 1 && x; }))?.[0]?.id;
    check('(set up) a run is going and opened a tab', Boolean(aTab));
    const winsBefore = (await wins()).length;
    await userClose(aTab);
    await waitFor(async () => !(await stillOpen(aTab)));
    await sleep(1500);
    check('closing a tab a run is working in leaves the window open with the others', (await wins()).length === winsBefore && (await stillOpen(main.tabs[0])) && (await stillOpen(second)), JSON.stringify(await wins()));
    await app.evaluate(() => global.__release());
    await waitFor(async () => /A done/.test(await bodyText()));
    await sleep(1500);
    check('...and the run ending afterwards does not close it either', (await wins()).length === winsBefore && (await stillOpen(second)), JSON.stringify(await wins()));

    // 2. A finished run's tab (kept), closed by the user.
    await newChat();
    await app.evaluate(() => { global.__plans.B = 1; });
    await send('chat-B: open one');
    await waitFor(async () => /B done/.test(await bodyText()));
    const bTab = (await marks()).find((x) => x.mark.keep)?.id;
    check('(set up) a finished run left its tab open', Boolean(bTab), JSON.stringify([await marks(), await wins()]));
    await userClose(bTab);
    await waitFor(async () => !(await stillOpen(bTab)));
    await sleep(1500);
    check('closing a finished run\'s tab leaves the window open', (await wins()).length === winsBefore && (await stillOpen(second)), JSON.stringify(await wins()));

    // 3. A sleeping AI tab.
    const sTab = await app.evaluate((_e, w) => { const t = global.__windows.open(w, 'about:blank'); global.__aiTabs.tab(t.id).openedBy = { chatId: 'x', runId: 1, at: Date.now() }; return t.id; }, main.id);
    await waitFor(async () => (await stillOpen(sTab)));
    await app.evaluate((_e, id) => global.__tabSleep.sleep(id), sTab);
    await userClose(sTab);
    await waitFor(async () => !(await stillOpen(sTab)));
    await sleep(1200);
    check('closing a sleeping AI tab leaves the window open', (await wins()).length === winsBefore && (await stillOpen(second)), JSON.stringify(await wins()));

    // 4. A run started in the user's own tab and is still going; the user closes that tab.
    await newChat();
    await app.evaluate(() => { global.__hold.C = new Promise((r) => { global.__release = r; }); global.__plans.C = 0; });
    await app.evaluate((_e, id) => global.__aiTabs.switchTo(id), second);
    await waitFor(async () => (await wins())[0].activeId === second);
    await send('chat-C: just work here');
    await sleep(1000);
    await userClose(second);
    await waitFor(async () => !(await stillOpen(second)));
    await sleep(1500);
    check('closing the tab the AI works in (the user\'s own) leaves the window open', (await wins()).length === winsBefore && (await stillOpen(main.tabs[0])), JSON.stringify(await wins()));
    await app.evaluate(() => global.__release());
    await waitFor(async () => /C done/.test(await bodyText()));

    // 6. The AI's tab is the one in front (the user is looking at it), with the AI's tabs grouped, hidden, or loose: Ctrl+W on it.
    for (const [label, prefs] of [['grouped (default)', {}], ['hidden', { hideAiTabs: true }], ['loose', { groupAiTabs: false }]]) {
      await app.evaluate((_e, p) => { global.__settings.backend.set('hideAiTabs', Boolean(p.hideAiTabs)); global.__settings.backend.set('groupAiTabs', p.groupAiTabs !== false); }, prefs);
      const aiIds = await app.evaluate((_e, w) => [1, 2].map(() => { const t = global.__windows.open(w, 'about:blank'); global.__aiTabs.tab(t.id).openedBy = { chatId: 'z', runId: 9, at: Date.now() }; return t.id; }), main.id);
      await sleep(300);
      const total = (await wins()).length;
      for (const id of aiIds) {
        await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), id);
        await app.evaluate((_e, i) => global.__closeTabInteractive(i), id);
        await waitFor(async () => !(await stillOpen(id)));
        await sleep(800);
      }
      check('Ctrl+W on each AI tab in front (' + label + ') leaves the window open', (await wins()).length === total && (await wins()).find((w) => w.id === main.id)?.tabs.length >= 1, JSON.stringify(await wins()));
    }

    // 7. An outside agent's own window (MCP): the user closes one of its tabs by hand (Ctrl+W, middle-click, the menu: none of them is a click
    // the window UI reports), then the session ends. The window is theirs by then, as if they had clicked in it: it stays with its other tabs.
    const agentRec = await app.evaluate(() => global.__agentWindows.windows.ensure('close-test', 'Claude Code').then((rec) => rec.win.id));
    const agentTabs = await app.evaluate((_e, w) => [1, 2, 3].map((i) => global.__windows.open(w, 'about:blank#' + i).id), agentRec);
    await waitFor(async () => (await wins()).find((w) => w.id === agentRec)?.tabs.length >= 3);
    await userClose(agentTabs[0]);
    await waitFor(async () => !(await stillOpen(agentTabs[0])));
    await app.evaluate(() => global.__agentWindows.windows.release('close-test'));
    await sleep(2500);
    const agentAfter = (await wins()).find((w) => w.id === agentRec);
    check('the user closing a tab in an agent window makes it theirs: it stays when the session ends, with the other tabs', Boolean(agentAfter) && agentAfter.tabs.length >= 2, JSON.stringify(await wins()));

    // 5. The window's last tab, the AI's: the user's close behaves as for any tab (the window goes).
    await app.evaluate(() => global.__hold.D = null);
    const w2 = await (async () => { const before = (await wins()).map((w) => w.id); await app.evaluate(() => global.__basics.openNewWindow()); return waitFor(async () => (await wins()).find((x) => !before.includes(x.id) && x.tabs.length)); })();
    const lone = w2.tabs[0];
    await app.evaluate((_e, id) => { global.__aiTabs.tab(id).openedBy = { chatId: 'y', runId: 2, at: Date.now() }; }, lone);
    const n = (await wins()).length;
    await userClose(lone);
    check('the user closing a window\'s last tab, even the AI\'s, closes that window like any tab', !!(await waitFor(async () => (await wins()).length === n - 1)), JSON.stringify(await wins()));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
