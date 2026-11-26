// Finding a tab the AI opened, while it works and after (main.js "[ai tab finder]", renderer/chat-extras.js, tab-search.js):
//  1. the chat's header gets a Tabs button with how many of its tabs are open; its list shows them as chips, and a click switches to one
//  2. a tab of the chat that closed stays in the list, under Closed; a click opens it again
//  3. a tab the user took over (typed in) stays in the list, marked "Yours now"
//  4. every AI tab says which chat opened it: in the strip's state, its spoken label and hover card ("Opened by the AI for “…”")
//  5. tab search (Ctrl+Shift+A) finds an AI tab by its chat's name, has a "Tabs the AI opened" filter (and "@ai") with a section per chat
//  6. the Hide AI tabs button's menu ends with "Find a tab the AI opened…", which opens tab search with that filter on
// Real Lumen, throwaway profile, a fake model, local pages. Runs in the background (LUMEN_TEST_BACKGROUND).
/* global lastTabState */ // renderer/app.js: the newest tab list (read in the window)
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aifinder-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('closeAiTabs', 'off'); }); // (nothing closes by itself here: the closes are this suite's own)
    await fakeModel(app, base);

    const active = () => app.evaluate(() => global.__windows.list()[0].activeId);
    const aiIds = () => app.evaluate(() => global.__windows.list()[0].tabs.map((t) => t.id).filter((id) => global.__aiTabs.tab(id)?.openedBy));
    const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const bodyText = () => ui.evaluate(() => document.querySelector('#messages')?.innerText || '');
    const plan = (who, n) => app.evaluate((_e, a) => { global.__plans[a.who] = a.n; }, { who, n });
    const button = () => ui.evaluate(() => { const b = document.getElementById('chat-ai-tabs'); return b ? { hidden: b.hidden, count: b.querySelector('.chat-ai-tabs-count')?.textContent || '', label: b.getAttribute('aria-label') || '' } : null; });
    const listed = () => ui.evaluate(() => [...document.querySelectorAll('#chat-ai-tabs-pop .chat-ai-tabs-section')].map((s) => ({ head: s.querySelector('.chat-ai-tabs-head')?.textContent, rows: [...s.querySelectorAll('li')].map((li) => ({ title: li.querySelector('.tab-ref-title')?.textContent || '', key: li.querySelector('.tab-ref')?.dataset.key || '', state: li.querySelector('.tab-ref')?.dataset.state || '', tag: li.querySelector('.chat-ai-tabs-tag')?.textContent || '' })) })));
    const openList = async () => { if (await ui.evaluate(() => document.getElementById('chat-ai-tabs-pop')?.hidden !== false)) await ui.click('#chat-ai-tabs'); };

    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    const user = await active();
    check('(set up) no Tabs button before the chat has opened a tab', (await button())?.hidden === true, JSON.stringify(await button()));

    // ---- 1. a chat opens three tabs: the header's Tabs button says 3, the list has them, a click switches to one
    await plan('A', 3);
    await send('chat-A: open three');
    await waitFor(async () => /A done/.test(await bodyText()), 20000);
    const three = await waitFor(async () => { const x = await aiIds(); return x.length === 3 && x; });
    check('(set up) the run opened three tabs', Boolean(three), JSON.stringify(await aiIds()));
    const b1 = await waitFor(async () => { const b = await button(); return b && !b.hidden && b.count === '3' && b; });
    check('(1) the chat\'s Tabs button shows, with 3', Boolean(b1), JSON.stringify(await button()));
    check('(1) ...and says so in words', /3 tabs/.test(b1?.label || ''), b1?.label);
    await openList();
    const l1 = await waitFor(async () => { const l = await listed(); return l[0]?.rows.length === 3 && l[0].rows.every((r) => /^Page \/A-\d$/.test(r.title)) && l; });
    check('(1) the list shows the three tabs by title, under Open', Boolean(l1) && l1[0].head === 'Open', JSON.stringify(await listed()));
    check('(1) ...newest first', Boolean(l1) && l1[0].rows.map((r) => r.title).join() === 'Page /A-2,Page /A-1,Page /A-0', JSON.stringify(l1));
    const pick = three.find((id) => l1 && String(id) === l1[0].rows[1].key);
    await ui.click(`#chat-ai-tabs-pop .tab-ref[data-key="${l1?.[0].rows[1].key}"]`);
    check('(1) a click on one switches to that tab', Boolean(await waitFor(async () => (await active()) === pick)), JSON.stringify({ active: await active(), pick }));
    check('(1) ...and the list closes', await waitFor(() => ui.evaluate(() => document.getElementById('chat-ai-tabs-pop').hidden === true)));
    await app.evaluate((_e, id) => global.__aiTabs.switchTo(id), user);
    await waitFor(async () => (await active()) === user);
    await ui.waitForSelector('#chat-ai-tabs', { state: 'visible' });

    // ---- 4. every AI tab says which chat opened it
    const state = await waitFor(() => ui.evaluate((ids) => { const s = typeof lastTabState !== 'undefined' ? lastTabState : null; const mine = s?.tabs.filter((t) => ids.includes(t.id)) || []; return mine.length === 3 && mine.every((t) => t.aiChat === 'chat-A: open three') && mine; }, three));
    check('(4) the strip\'s state names the chat on each of its tabs (aiChat)', Boolean(state), JSON.stringify(await ui.evaluate(() => lastTabState.tabs.map((t) => ({ id: t.id, aiChat: t.aiChat })))));
    const user2 = await ui.evaluate((id) => lastTabState.tabs.find((t) => t.id === id)?.aiChat ?? null, user);
    check('(4) ...and not on the user\'s own tab', user2 === null, String(user2));
    const spoken = await waitFor(() => ui.evaluate((id) => document.querySelector(`#tabs .tab[data-id="${id}"]`)?.getAttribute('aria-label') || '', pick)); // (the tab the user went to: it stays in sight beside the folded label)
    check('(4) a tab\'s spoken label says "Opened by the AI for “chat-A: open three”"', spoken.includes('Opened by the AI for “chat-A: open three”'), spoken);
    const groupNames = await app.evaluate(() => [...global.__tabGroups.groups.values()].map((g) => g.name));
    check('(4) the strip\'s group for them is named after the chat', groupNames.includes('AI · chat-A: open three'), JSON.stringify(groupNames));

    // ---- 2. a tab that closed stays in the list; a click opens it again
    const gone = three[0];
    const goneUrl = `${base}/A-0`;
    await app.evaluate((_e, id) => global.__notifyClick.closeTab(id), gone);
    await waitFor(async () => !(await aiIds()).includes(gone));
    const b2 = await waitFor(async () => { const b = await button(); return b?.count === '2' && b; });
    check('(2) the button counts the two still open', Boolean(b2), JSON.stringify(await button()));
    await openList();
    const l2 = await waitFor(async () => { const l = await listed(); return l.length === 2 && l[1].rows.length === 1 && l; });
    check('(2) the closed one is listed under Closed', Boolean(l2) && /^Closed/.test(l2[1].head) && l2[1].rows[0].key === String(gone) && l2[1].rows[0].title === 'Page /A-0', JSON.stringify(await listed()));
    check('(2) ...drawn as closed', Boolean(l2) && l2[1].rows[0].state === 'closed', JSON.stringify(l2?.[1]));
    await ui.click(`#chat-ai-tabs-pop .tab-ref[data-key="${gone}"]`);
    const back = await waitFor(() => app.evaluate((_e, u) => global.__windows.list()[0].tabs.find((t) => t.url === u)?.id ?? null, goneUrl));
    check('(2) a click opens it again from its address', Boolean(back), JSON.stringify(await app.evaluate(() => global.__windows.list()[0].tabs.map((t) => t.url))));
    await ui.evaluate(() => window.chatAiTabs.refresh());
    const b2b = await waitFor(async () => { await ui.evaluate(() => window.chatAiTabs.refresh()); const b = await button(); return b?.count === '3' && b; });
    check('(2) ...and it counts as open again, not also as closed', Boolean(b2b), JSON.stringify(await button()));
    await app.evaluate((_e, id) => global.__aiTabs.switchTo(id), user);
    await waitFor(async () => (await active()) === user);
    await ui.waitForSelector('#chat-ai-tabs', { state: 'visible' });

    // ---- 3. a tab the user took over stays in the list, "Yours now"
    const taken = three[1];
    await app.evaluate((_e, id) => global.__aiTabs.handOver(global.__aiTabs.tab(id)), taken);
    check('(set up) the tab is the user\'s now', Boolean(await waitFor(async () => !(await aiIds()).includes(taken))));
    await ui.evaluate(() => window.chatAiTabs.refresh());
    await openList();
    const l3 = await waitFor(async () => { const l = await listed(); const row = l[0]?.rows.find((r) => r.key === String(taken)); return row?.tag === 'Yours now' && l; });
    check('(3) it is still in the chat\'s list, marked "Yours now"', Boolean(l3), JSON.stringify(await listed()));
    await ui.keyboard.press('Escape');

    // ---- 5. tab search: by the chat's name, the "Tabs the AI opened" filter, @ai
    await ui.click('#tab-search');
    await ui.waitForSelector('#tab-search-panel', { state: 'visible' });
    const chip = () => ui.evaluate(() => { const c = document.getElementById('tab-search-ai'); return c ? { hidden: c.hidden, pressed: c.getAttribute('aria-pressed'), text: c.textContent } : null; });
    const rows = () => ui.evaluate(() => [...document.querySelectorAll('#tab-search-results > li')].map((li) => (li.classList.contains('tab-search-section') ? `# ${li.textContent}` : li.querySelector('.tab-search-title')?.textContent + (li.querySelector('.tab-search-ai') ? ` [${li.querySelector('.tab-search-ai').textContent}]` : ''))));
    const c1 = await chip();
    check('(5) the panel has a "Tabs the AI opened" filter with the count', c1 && !c1.hidden && c1.pressed === 'false' && /Tabs the AI opened \(\d+\)/.test(c1.text), JSON.stringify(c1));
    const r0 = await rows();
    check('(5) an AI tab says its chat beside its address', r0.some((r) => /^Page \/A-2 \[AI · chat-A: open three\]$/.test(r)), JSON.stringify(r0));
    await ui.fill('#tab-search-input', 'open three');
    const r1 = await waitFor(async () => { const r = await rows(); return r.filter((x) => /^Page \/A-/.test(x)).length >= 2 && r; });
    check('(5) typing words of the chat\'s name finds its tabs', Boolean(r1), JSON.stringify(await rows()));
    await ui.fill('#tab-search-input', '@ai');
    const r2 = await waitFor(async () => { const r = await rows(); return r[0] === '# From “chat-A: open three”' && r; });
    check('(5) "@ai" lists only the AI\'s tabs, under a section for the chat', Boolean(r2) && r2.filter((x) => !x.startsWith('# ')).every((x) => /^Page \/A-/.test(x)) && (await chip()).pressed === 'true', JSON.stringify(await rows()));
    await ui.fill('#tab-search-input', '');
    await ui.click('#tab-search-ai');
    const r3 = await waitFor(async () => { const r = await rows(); return r[0] === '# From “chat-A: open three”' && r; });
    check('(5) the filter button does the same', Boolean(r3) && (await chip()).pressed === 'true', JSON.stringify(await rows()));
    await ui.press('#tab-search-input', 'Alt+a');
    check('(5) Alt+A turns it off again', (await chip()).pressed === 'false', JSON.stringify(await chip()));
    await ui.press('#tab-search-input', 'Escape');

    // ---- 6. the Hide AI tabs menu: "Find a tab the AI opened…" opens tab search with the filter on
    const menu = await app.evaluate(() => global.__hideAiMenu().map(({ label, type }) => ({ label, type })));
    check('(6) the Hide AI tabs menu ends with "Find a tab the AI opened…"', menu.at(-1)?.label === 'Find a tab the AI opened…' && menu[0].label === 'Hide AI tabs', JSON.stringify(menu));
    await app.evaluate(() => global.__hideAiMenu().at(-1).run());
    const opened = await waitFor(async () => (await ui.evaluate(() => document.getElementById('tab-search-panel')?.hidden === false)) && (await chip())?.pressed === 'true');
    check('(6) ...which opens tab search, filtered to the AI\'s tabs', Boolean(opened), JSON.stringify(await chip()));
    await ui.press('#tab-search-input', 'Escape');

    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall ai-tab-finder checks passed');
  process.exit(failures ? 1 : 0);
})();
