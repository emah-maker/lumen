// "Close the tabs the AI opened" end to end (features/ai-manners.js, main.js "[ai manners]", the sidebar and the tab strip), with a fake
// Claude client whose tool calls go through the real open_tab tool path: no network, no key. Checks that the tabs are marked, that the
// reply shows "Close 5 tabs this chat opened", that the button closes exactly those 5 (not the user's tabs, not a pinned AI tab),
// that Undo brings them back, that the tab menu's "all chats" item works across two chats, that a run still using a tab keeps it
// (and says so), that the mark survives a quit and restore, and that Close (the default) closes a run's tabs when it ends but keeps the
// one it opened with keep:true.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..', '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
});

// The model: a message that names "chat-X" is chat X. global.__plans[X] tabs are opened one per turn with open_tab (the real tool),
// then it answers "X done". global.__hold[X] (a promise) keeps the last answer from finishing, so a run can be caught mid-flight.
// global.__keep[X]: the turns whose open_tab asks keep:true.
const fakeModel = (app, base) => app.evaluate((_e, b) => {
  global.__plans = {};
  global.__hold = {};
  global.__keep = {};
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    const done = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result')).length;
    const usage = { input_tokens: 100, output_tokens: 20 };
    if (done < (global.__plans[who] || 0)) {
      const text = `${who} opening ${done + 1}`;
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}-${done}`, name: 'open_tab', input: { url: `${b}/${who}-${done}`, ...((global.__keep[who] || []).includes(done) ? { keep: true } : {}) } }], usage }),
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
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE ${req.url}</h1></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclose-probe-'));
  const shots = process.env.CLOSE_AI_TABS_SHOTS || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  let app = await launch(profile);
  check('(set up) When the AI finishes is Close by default', (await app.evaluate(() => global.__settings.backend.prefs().closeAiTabs)) === 'always');
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  await app.evaluate(() => global.__settings.backend.set('groupAiTabs', false)); // (the AI's tabs loose in the strip, where these steps look at them; the folded group is ai-tab-group.js)
  await app.evaluate(() => global.__settings.backend.set('closeAiTabs', 'off')); // steps 1-7 are about the Close button under the reply (Leave open); step 8 is the default
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await fakeModel(app, base);

  const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const tabsNow = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs.map((t) => ({ id: t.id, url: t.url, pinned: t.pinned }))));
  const urlsNow = async () => (await tabsNow()).map((t) => t.url);
  const hasUrl = async (suffix) => (await urlsNow()).some((u) => u.endsWith(suffix));
  const marks = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs).map((t) => ({ id: t.id, url: t.url, mark: global.__aiTabs.tab(t.id)?.openedBy || null })).filter((t) => t.mark));
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const bodyText = () => ui.evaluate(() => document.body.innerText);
  const plan = (who, n) => app.evaluate((_e, a) => { global.__plans[a.who] = a.n; }, { who, n });
  const newChat = async () => { await ui.click('#new-chat'); await sleep(300); };
  const rowText = () => ui.evaluate(() => [...document.querySelectorAll('#messages .ai-tabs')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).pop() || '');
  const toastText = () => ui.evaluate(() => document.querySelector('.organize-note')?.innerText.replace(/\s+/g, ' ').trim() || '');

  // ---- set up: the user's own tabs, and the sidebar
  const user = await active();
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#sidebar', { state: 'visible' });
  await app.evaluate(({ webContents }, u) => { webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).loadURL(u); }, `${base}/user`);
  await waitFor(() => hasUrl('/user'));
  const mine = await app.evaluate((_e, u) => global.__agent.browser.openTab(u, { background: true }).id, `${base}/mine`); // a tab the user opened
  check('(set up) the user has two tabs of their own, unmarked', (await marks()).length === 0);

  // ---- 1. A chat opens one tab through the real open_tab; the user pins it, which takes it over.
  await plan('P', 1);
  await send('chat-P: open one');
  await waitFor(async () => /P done/.test(await bodyText()));
  let m = await waitFor(async () => { const x = await marks(); return x.length === 1 && x; });
  check('open_tab marks the tab with its chat, run and time', Boolean(m) && typeof m[0].mark.chatId === 'string' && m[0].mark.chatId && Number.isFinite(m[0].mark.runId) && m[0].mark.at > 0, JSON.stringify(m));
  check('the user stays on their own tab', (await active()) === user, String(await active()));
  const pinnedAi = m && m[0].id;
  await app.evaluate((_e, id) => { const w = global.__windows.list()[0]; global.__windows.pin(w.windowId, id, true); }, pinnedAi);
  check('pinning an AI tab takes it over: the mark is gone', (await waitFor(async () => (await marks()).length === 0)) === true, JSON.stringify(await marks()));

  // ---- 2. A second chat opens five tabs; the reply offers "Close 5 tabs".
  await newChat();
  await plan('F', 5);
  await send('chat-F: open five');
  await waitFor(async () => /F done/.test(await bodyText()));
  m = await waitFor(async () => { const x = await marks(); return x.length === 5 && x; });
  check('five tabs are marked, all with the same chat and run', Boolean(m) && new Set(m.map((x) => x.mark.chatId)).size === 1 && new Set(m.map((x) => x.mark.runId)).size === 1, JSON.stringify(m));
  const five = m.map((x) => x.id);
  check('they opened behind: the user is still on their tab', (await active()) === user);
  const strip = await waitFor(async () => { const x = await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab.ai-opened')].map((e) => ({ id: +e.dataset.id, mark: getComputedStyle(e.querySelector('.tab-ai-mark')).display }))); return x.length === 5 && x; });
  check('the strip marks those five (the sparkle on the favicon)', Boolean(strip) && strip.every((x) => five.includes(x.id) && x.mark !== 'none'), JSON.stringify(strip));
  const button = await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('#messages .ai-tabs button')].map((b) => b.textContent.trim()).find((t) => /^Close \d+ tabs/.test(t)) || ''));
  check('the chat shows "Close 5 tabs this chat opened"', button === 'Close 5 tabs this chat opened', button);
  if (shots) {
    await ui.screenshot({ path: path.join(shots, 'chat-button-and-tab-marker.png') });
    const strip2 = await ui.$('#tabs');
    if (strip2) await strip2.screenshot({ path: path.join(shots, 'tab-marker-strip.png') });
  }

  // ---- 3. The button closes exactly those five.
  await ui.evaluate(() => [...document.querySelectorAll('#messages .ai-tabs button')].find((b) => /^Close \d+ tabs/.test(b.textContent.trim())).click());
  await waitFor(async () => !(await tabsNow()).some((t) => five.includes(t.id)));
  const after = await tabsNow();
  check('exactly the five are closed', !after.some((t) => five.includes(t.id)), JSON.stringify(after));
  check('the user\'s own tabs and the pinned (taken-over) AI tab are still open', after.some((t) => t.id === user) && after.some((t) => t.id === mine) && after.some((t) => t.id === pinnedAi && t.pinned), JSON.stringify(after));
  check('the row says what closed and offers Undo', Boolean(await waitFor(async () => /Closed 5 tabs/.test(await rowText()) && /Undo/.test(await rowText()))), await rowText());

  // ---- 4. Undo brings them back.
  await ui.evaluate(() => [...document.querySelectorAll('#messages .ai-tabs button')].find((b) => b.textContent.trim() === 'Undo').click());
  const back = await waitFor(async () => { const urls = await urlsNow(); return [0, 1, 2, 3, 4].every((i) => urls.some((u) => u.endsWith(`/F-${i}`))) && urls; });
  check('Undo reopens all five', Boolean(back), JSON.stringify(await urlsNow()));
  check('...as the user\'s own tabs (no mark) and the user never left theirs', (await marks()).length === 0 && (await active()) === user);

  // ---- 5. The tab menu's "Close tabs the AI opened" closes the tabs of every chat.
  await newChat();
  await plan('G', 2);
  await send('chat-G: open two');
  await waitFor(async () => /G done/.test(await bodyText()));
  await newChat();
  await plan('H', 3);
  await send('chat-H: open three');
  await waitFor(async () => /H done/.test(await bodyText()));
  m = await waitFor(async () => { const x = await marks(); return x.length === 5 && x; });
  check('two chats opened five tabs between them', Boolean(m) && new Set(m.map((x) => x.mark.chatId)).size === 2, JSON.stringify(m));
  const ids5 = m.map((x) => x.id);
  await app.evaluate((_e, id) => global.__tabMenu(id, 'Close tabs the AI opened'), user);
  await waitFor(async () => !(await tabsNow()).some((t) => ids5.includes(t.id)));
  const after2 = await tabsNow();
  check('the menu item closed all five, from both chats', !after2.some((t) => ids5.includes(t.id)), JSON.stringify(after2));
  check('...and left the user\'s tabs and the pinned tab', after2.some((t) => t.id === user) && after2.some((t) => t.id === mine) && after2.some((t) => t.id === pinnedAi));
  check('...with a toast that has Undo', Boolean(await waitFor(async () => /Closed 5 tabs/.test(await toastText()) && /Undo/.test(await toastText()))), await toastText());

  // ---- 6. A run still using a tab keeps it, and says so.
  await ui.evaluate(() => document.querySelector('.organize-note button')?.click()); // Undo: the five are back as the user's (they are not marked)
  await waitFor(async () => (await tabsNow()).length >= 8);
  const live = await app.evaluate(() => { global.__hold.L = new Promise((r) => { global.__release = r; }); return true; });
  await newChat();
  await plan('L', 1);
  await send('chat-L: open one and keep working');
  const lm = await waitFor(async () => { const x = await marks(); return x.length === 1 && x; });
  check('(set up) a run is still going and has opened a tab', Boolean(live) && Boolean(lm), JSON.stringify(lm));
  const busyId = lm && lm[0].id;
  const sel = await app.evaluate((_e, id) => { const busy = global.__agent.runTabIds(); return { busy: busy.includes(id), closed: null }; }, busyId);
  if (sel.busy) {
    const r = await app.evaluate(() => global.__aiTabs.close({}));
    check('a close keeps a tab the run is working in and counts it', r.closed === 0 && r.busy === 1, JSON.stringify(r));
    check('...so the tab is still open and still the AI\'s', (await marks()).length === 1);
  } else {
    check('(the run was not working in the tab it opened: nothing to keep)', true);
  }
  await app.evaluate(() => global.__release());
  await waitFor(async () => /L done/.test(await bodyText()));

  // ---- 7. The mark survives a quit and a restore.
  await newChat();
  await plan('Q', 2);
  await send('chat-Q: open two');
  await waitFor(async () => /Q done/.test(await bodyText()));
  const before = await waitFor(async () => { const x = await marks(); return x.filter((y) => /\/Q-/.test(y.url)).length === 2 && x; });
  const wantUrls = before.filter((y) => /\/Q-|\/L-/.test(y.url)).map((y) => y.url).sort();
  const chatsBefore = before.map((y) => y.mark.chatId);
  await app.evaluate(() => global.__settingsFlush && global.__settingsFlush());
  await app.close();
  await sleep(2000); // (let the old process let go of the profile before the next one starts)
  for (let attempt = 0; attempt < 3; attempt++) { // a start that comes up with no window (a slow release of the profile lock) is tried again
    app = await launch(profile).catch(() => null); // (a copy that finds the profile still locked exits at once)
    ui = app ? await app.firstWindow().catch(() => null) : null;
    if (ui && await ui.waitForSelector('.tab', { timeout: 20000 }).then(() => true, () => false)) break;
    await app?.close().catch(() => {});
    await sleep(3000);
    ui = null;
  }
  if (!ui) throw new Error('Lumen did not come back after the restart');
  await fakeModel(app, base);
  const restored = await waitFor(async () => { const x = await marks(); return x.length === wantUrls.length && x; }, 15000);
  check('after a restart the same tabs are still marked as the AI\'s', Boolean(restored) && JSON.stringify(restored.map((y) => y.url).sort()) === JSON.stringify(wantUrls), JSON.stringify({ restored, wantUrls }));
  check('...with the chat they belong to (the run id is not kept)', Boolean(restored) && restored.every((y) => chatsBefore.includes(y.mark.chatId) && y.mark.runId === null && y.mark.at > 0), JSON.stringify(restored));
  check('...and the pinned AI tab is the user\'s, unmarked', !(await marks()).some((y) => y.url.endsWith('/P-0')));
  // Right-click on the sidebar's Hide AI tabs toggle: the switch, and Close with the count.
  const menu = () => app.evaluate(() => global.__hideAiMenu().map(({ label, type, enabled, checked }) => ({ label, type, enabled, checked })));
  const m1 = await menu();
  check('right-click menu on Hide AI tabs: a Hide switch and "Close tabs the AI opened, in all windows (N)"', m1[0]?.type === 'checkbox' && m1[0].label === 'Hide AI tabs' && m1[2]?.enabled && m1[2].label.includes(`(${wantUrls.length})`), JSON.stringify(m1));
  await app.evaluate(() => global.__hideAiMenu()[0].run());
  const hiddenOn = await waitFor(() => app.evaluate(() => global.__settings.backend.prefs?.().hideAiTabs === true));
  check('...its Hide switch turns hiding on', Boolean(hiddenOn), await app.evaluate(() => global.__settings.backend.prefs?.().hideAiTabs));
  await app.evaluate(() => global.__hideAiMenu()[0].run());
  check('...and off again', Boolean(await waitFor(() => app.evaluate(() => global.__settings.backend.prefs?.().hideAiTabs !== true))));
  check('...the toggle in the UI opens the menu on right-click', await ui.evaluate(() => typeof window.browser.hideAiTabsMenu === 'function'));
  const closed = await app.evaluate(() => global.__aiTabs.close({}));
  check('a restored tab can be closed with the all-chats close', closed.closed === wantUrls.length, JSON.stringify(closed));
  const m2 = await waitFor(async () => { const m = await menu(); return !m[2]?.enabled && m; });
  check('...and with none left, the menu\'s Close is greyed out', Boolean(m2) && /No tabs the AI opened/.test(m2[2].label), JSON.stringify(m2));

  // ---- 8. Close (the default): a run's tabs close as soon as it ends, except the one it opened with keep:true.
  await app.evaluate(() => global.__settings.backend.set('closeAiTabs', 'always'));
  await ui.evaluate(() => { if (document.getElementById('sidebar')?.offsetParent === null) document.getElementById('toggle-sidebar').click(); });
  await ui.waitForSelector('#sidebar', { state: 'visible' });
  await newChat();
  await app.evaluate(() => { global.__keep.K = [1]; });
  await plan('K', 3);
  await send('chat-K: open three, keep the second');
  await waitFor(async () => /K done/.test(await bodyText()));
  const kLeft = await waitFor(async () => { const u = (await urlsNow()).filter((x) => /\/K-\d$/.test(x)); return u.length === 1 && u; }, 15000);
  check('Close: the run\'s tabs closed when it ended, all but the keep:true one', Boolean(kLeft) && kLeft[0].endsWith('/K-1'), JSON.stringify(await urlsNow()));
  const kMark = (await marks()).find((y) => y.url.endsWith('/K-1'));
  check('...which is still the AI\'s, marked keep (the user\'s own Close still reaches it)', Boolean(kMark?.mark?.keep), JSON.stringify(kMark));
  const kRow = await waitFor(async () => /Closed 2 tabs/.test(await rowText()) && rowText());
  check('...and the reply says what closed, with Undo', Boolean(kRow), await rowText());
  check('...the user\'s own tabs are still open', (await hasUrl('/user')) && (await hasUrl('/mine')), JSON.stringify(await urlsNow()));

  check('no script errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
