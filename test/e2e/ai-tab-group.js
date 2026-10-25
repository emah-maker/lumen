// Settings → AI and agents → AI tabs → "Group tabs the AI opens" (groupAiTabs, on; main.js joinAiGroup): every tab the AI opens with the real open_tab
// joins one gray "AI tabs" group in its window, folded when made, so the strip shows one label instead of a row of tabs. A second chat's
// tabs join the same group; the user's unfolding is kept; a tab the user types in leaves the group; the group goes when its tabs close;
// with the setting off, tabs stay loose. Real Lumen, throwaway profile, a fake model, local pages.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

// The model: a message that names "chat-X" opens global.__plans[X] tabs, one open_tab per turn, then answers "X done".
const fakeModel = (app, base) => app.evaluate((_e, b) => {
  global.__plans = {};
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    const done = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result')).length;
    const usage = { input_tokens: 100, output_tokens: 20 };
    const text = done < (global.__plans[who] || 0) ? `${who} opening ${done + 1}` : `${who} done`;
    const content = done < (global.__plans[who] || 0)
      ? [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}-${done}`, name: 'open_tab', input: { url: `${b}/${who}-${done}` } }]
      : [{ type: 'text', text }];
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: content.length > 1 ? 'tool_use' : 'end_turn', content, usage }),
    };
  } } } });
}, base);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${req.url}</title><body><input id="q"><h1>PAGE ${req.url}</h1></body>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aigroup-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    check('(set up) Group tabs the AI opens is on by default', (await app.evaluate(() => global.__settings.backend.prefs().groupAiTabs)) === true);
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('closeAiTabs', 'off'); }); // (the close is close-ai-tabs.js)
    await fakeModel(app, base);

    const active = () => app.evaluate(() => global.__windows.list()[0].activeId);
    const aiIds = () => app.evaluate(() => global.__windows.list()[0].tabs.map((t) => t.id).filter((id) => global.__aiTabs.tab(id)?.openedBy));
    const groups = () => app.evaluate(() => [...global.__tabGroups.groups.values()].map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed, members: global.__windows.list()[0].tabs.filter((t) => global.__aiTabs.tab(t.id)?.groupId === g.id).map((t) => t.id) })));
    const groupOf = (id) => app.evaluate((_e, i) => global.__aiTabs.tab(i)?.groupId ?? null, id);
    const strip = () => ui.evaluate(() => ({ labels: [...document.querySelectorAll('#tabs .group-label .group-name')].map((l) => l.textContent.trim()), tabs: document.querySelectorAll('#tabs .tab').length }));
    const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const bodyText = () => ui.evaluate(() => document.body.innerText);
    const plan = (who, n) => app.evaluate((_e, a) => { global.__plans[a.who] = a.n; }, { who, n });
    const newChat = async () => { await ui.click('#new-chat'); await sleep(300); };

    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    const user = await active();
    const before = await strip();

    // ---- 1. a chat opens five tabs: one folded gray "AI tabs" group holds them all, the user stays on their tab
    await plan('A', 5);
    await send('chat-A: open five');
    await waitFor(async () => /A done/.test(await bodyText()), 20000);
    const five = await waitFor(async () => { const x = await aiIds(); return x.length === 5 && x; });
    let g = (await groups()).filter((x) => x.name === 'AI tabs');
    check('five AI tabs, all in one group named "AI tabs"', Boolean(five) && g.length === 1 && g[0].members.length === 5 && five.every((id) => g[0].members.includes(id)), JSON.stringify(await groups()));
    check('the group is gray and folded', g[0]?.color === 'gray' && g[0]?.collapsed === true, JSON.stringify(g));
    check('the user is still on their own tab', (await active()) === user, String(await active()));
    const after = await waitFor(async () => { const s = await strip(); return s.labels.includes('AI tabs') && s; });
    check('the strip shows the one "AI tabs" label and none of the five tabs', Boolean(after) && after.labels.filter((l) => l === 'AI tabs').length === 1 && after.tabs === before.tabs, JSON.stringify({ before, after }));

    // ---- 2. a second chat's tabs join the same group
    await newChat();
    await plan('B', 2);
    await send('chat-B: open two');
    await waitFor(async () => /B done/.test(await bodyText()), 20000);
    await waitFor(async () => (await aiIds()).length === 7);
    g = (await groups()).filter((x) => x.name === 'AI tabs');
    check('another chat\'s tabs join the same group (one group, seven tabs)', g.length === 1 && g[0].members.length === 7, JSON.stringify(await groups()));

    // ---- 3. the user unfolds it: the next AI tab leaves it unfolded
    await app.evaluate(({ ipcMain }, id) => ipcMain.emit('group:toggle', {}, id), g[0].id);
    await newChat();
    await plan('C', 1);
    await send('chat-C: open one');
    await waitFor(async () => /C done/.test(await bodyText()), 20000);
    await waitFor(async () => (await aiIds()).length === 8);
    g = (await groups()).filter((x) => x.name === 'AI tabs');
    check('a group the user unfolded stays unfolded when the next AI tab joins', g.length === 1 && g[0].collapsed === false && g[0].members.length === 8, JSON.stringify(g));

    // ---- 4. the user types in one of them: it is theirs, and leaves the group
    const taken = five[0];
    await app.evaluate((_e, id) => global.__aiTabs.switchTo(id), taken);
    await waitFor(async () => (await active()) === taken);
    await app.evaluate(({ webContents }, id) => { const wc = webContents.fromId(global.__windows.list()[0].tabs.find((t) => t.id === id).contentsId); wc.sendInputEvent({ type: 'keyDown', keyCode: 'a' }); wc.sendInputEvent({ type: 'char', keyCode: 'a' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'a' }); }, taken);
    check('a tab the user types in leaves the "AI tabs" group', await waitFor(async () => (await groupOf(taken)) === null), String(await groupOf(taken)));
    g = (await groups()).filter((x) => x.name === 'AI tabs');
    check('...and the others stay in it', g.length === 1 && g[0].members.length === 7, JSON.stringify(g));

    // ---- 5. the group goes when its tabs close
    await app.evaluate((_e, ids) => { for (const id of ids) global.__notifyClick.closeTab(id); }, g[0].members);
    check('closing the AI\'s tabs removes the group', await waitFor(async () => (await groups()).every((x) => x.name !== 'AI tabs')), JSON.stringify(await groups()));

    // ---- 6. setting off: AI tabs stay loose
    await app.evaluate((_e, id) => global.__aiTabs.switchTo(id), user); // (back to the user's tab, where the sidebar is open)
    await ui.waitForSelector('#new-chat', { state: 'visible' });
    await app.evaluate(() => global.__settings.backend.set('groupAiTabs', false));
    await newChat();
    await plan('D', 2);
    await send('chat-D: open two');
    await waitFor(async () => /D done/.test(await bodyText()), 20000);
    const loose = await waitFor(async () => { const x = await aiIds(); return x.length === 2 && x; });
    check('with the setting off, the AI\'s tabs are not grouped', Boolean(loose) && (await Promise.all(loose.map(groupOf))).every((x) => x === null), JSON.stringify(await groups()));
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall ai-tab-group checks passed');
  process.exit(failures ? 1 : 0);
})();
