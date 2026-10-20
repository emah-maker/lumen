// Every way a run can leave a tab behind, with "When the AI finishes" on Close (features/ai-manners.js, main.js "[ai manners]").
// A fake Claude client whose tool calls go through the real tool paths (open_tab, navigate); no network, no key. One run opens tabs
// through several paths while it is held open, the test touches some of them the way a user would (pins, types, fronts one), then
// the run ends three ways (normally, by Stop, by an error) and the suite asserts that exactly the untouched AI tabs closed:
//   open_tab, navigate's own tab, a link / window.open tab opened by an AI page, a popup window an AI page opened, a tab asleep when the
//   run ends; and a restart after a crash closes what a killed run left behind.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 12000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclosepaths-'));
  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  await app.evaluate(() => global.__settings.backend.set('closeAiTabs', 'always'));
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await fakeModel(app, base);

  const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const tabsNow = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs.map((t) => ({ id: t.id, url: t.url, pinned: t.pinned }))));
  const urlsNow = async () => (await tabsNow()).map((t) => t.url);
  const has = async (suffix) => (await urlsNow()).some((u) => u.endsWith(suffix));
  const marks = () => app.evaluate(() => global.__windows.list().flatMap((w) => w.tabs).map((t) => ({ id: t.id, url: t.url, mark: global.__aiTabs.tab(t.id)?.openedBy || null })).filter((t) => t.mark));
  const idOf = async (suffix) => (await tabsNow()).find((t) => t.url.endsWith(suffix))?.id;
  const popupWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /\/win-/.test(w.webContents.getURL())).map((w) => w.webContents.getURL()));
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const bodyText = () => ui.evaluate(() => document.body.innerText);
  const script = (who, calls) => app.evaluate((_e, a) => { global.__script[a.who] = a.calls; }, { who, calls });
  const hold = (who) => app.evaluate((_e, w) => { global.__hold[w] = new Promise((r) => { global[`__release_${w}`] = r; }); }, who);
  const release = (who) => app.evaluate((_e, w) => global[`__release_${w}`](), who);
  const newChat = async () => { await ui.click('#new-chat'); await sleep(300); };
  const inPage = (id, code) => app.evaluate(({ webContents }, a) => webContents.fromId(global.__windows.list().flatMap((w) => w.tabs).find((t) => t.id === a.id).contentsId).executeJavaScript(a.code, true), { id, code });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#sidebar', { state: 'visible' });
  await app.evaluate(({ webContents }, u) => { webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).loadURL(u); }, `${base}/user`);
  await waitFor(() => has('/user'));
  const user = await active();
  const mine = await app.evaluate((_e, u) => global.__agent.browser.openTab(u, { background: true }).id, `${base}/mine`);

  // ---- 1. A normal end. Six tabs by open_tab, one by navigate, a link tab and a popup window from an AI page, one asleep.
  const open = (n) => ({ name: 'open_tab', input: { url: `/N-${n}` } });
  await script('N', [{ name: 'navigate', input: { url: '/N-nav' } }, open(0), open(1), open(2), open(3), open(4), open(5)]);
  await hold('N');
  await send('chat-N: open tabs');
  await waitFor(async () => (await marks()).length >= 7, 30000);
  const m0 = await marks();
  check('(set up) open_tab x6 and navigate left seven marked tabs', m0.length === 7, JSON.stringify(m0.map((x) => x.url)));
  await waitFor(async () => { const us = await urlsNow(); return [0, 1, 2, 3, 4, 5].every((n) => us.some((u) => u.endsWith(`/N-${n}`))); }, 15000); // (each page has committed its address)
  const id = (n) => idOf(`/N-${n}`);
  const [t0, t1, t3, t4] = [await id(0), await id(1), await id(3), await id(4)];
  await inPage(t0, `window.open('/N-link', '_blank'); 0`); // a tab by window.open from an AI page
  await inPage(t0, `document.getElementById('l').click(); 0`); // a target=_blank link
  await inPage(t0, `window.open('/win-1', 'w1', 'popup,width=300,height=300'); 0`); // a popup window
  await waitFor(async () => (await marks()).length >= 9, 8000);
  const popWin = await waitFor(async () => (await popupWindows()).length >= 1, 8000);
  await waitFor(async () => (await marks()).every((x) => x.url), 8000); // (a tab opened from a page names its address once it commits)
  const m1 = await marks();
  check('a tab opened by an AI page (window.open, a link) is marked as the AI\'s, with its run', m1.filter((x) => /\/N-link$|\/link\/N-0$/.test(x.url)).length === 2 && m1.every((x) => x.mark.runId === m1[0].mark.runId), JSON.stringify(m1.map((x) => [x.url, x.mark.runId])));
  await app.evaluate((_e, tid) => global.__tabSleep.sleep(tid), t1); // asleep when the run ends
  await app.evaluate((_e, tid) => { const w = global.__windows.list()[0]; global.__windows.pin(w.windowId, tid, true); }, t3); // the user pins one
  await app.evaluate(async ({ webContents }, tid) => { const wc = webContents.fromId(global.__windows.list().flatMap((w) => w.tabs).find((t) => t.id === tid).contentsId); await wc.executeJavaScript(`document.getElementById('f').focus(); 0`, true); wc.insertText('hello'); }, t4); // the user types
  await release('N');
  await waitFor(async () => /N done/.test(await bodyText()), 20000);
  await waitFor(async () => (await marks()).length <= 3 && true, 20000);
  await sleep(1500);
  const left = await tabsNow();
  const leftUrls = left.map((t) => t.url);
  check('the user\'s own tabs stay', left.some((t) => t.id === user) && left.some((t) => t.id === mine), JSON.stringify(leftUrls));
  check('the tab the user pinned and the one they typed in stay', left.some((t) => t.id === t3) && left.some((t) => t.id === t4), JSON.stringify(leftUrls));
  check('open_tab\'s plain tab closed', !left.some((t) => t.id === t0), JSON.stringify(leftUrls));
  check('the tab that was asleep when the run ended closed', !(await app.evaluate((_e, tid) => global.__tabSleep.state().some((s) => s.id === tid), t1)), JSON.stringify(leftUrls));
  check('navigate\'s own tab closed', !leftUrls.some((u) => u.endsWith('/N-nav')), JSON.stringify(leftUrls));
  check('the tabs an AI page opened (window.open, a link) closed', !leftUrls.some((u) => /\/N-link$|\/link\/N-0$/.test(u)), JSON.stringify(leftUrls));
  check('the popup window an AI page opened closed', popWin && (await popupWindows()).length === 0, JSON.stringify(await popupWindows()));
  check('nothing else of the run is left marked except what the user did not touch', (await marks()).every((x) => [t4].includes(x.id) === false), JSON.stringify(await marks()));

  // ---- 2. Stop.
  await app.evaluate(() => { for (const t of global.__windows.list().flatMap((w) => w.tabs)) if (t.url.includes('/N-')) global.__aiTabs.close({}); });
  await newChat();
  await script('S', [{ name: 'open_tab', input: { url: '/S-0' } }, { name: 'open_tab', input: { url: '/S-1' } }]);
  await hold('S');
  await send('chat-S: open and be stopped');
  await waitFor(async () => (await marks()).filter((x) => /\/S-/.test(x.url)).length === 2, 30000);
  await ui.evaluate(() => window.assistant.stop());
  await sleep(500);
  await release('S');
  const sGone = await waitFor(async () => !(await urlsNow()).some((u) => /\/S-/.test(u)), 20000);
  check('a run ended by Stop closes the tabs it opened', Boolean(sGone), JSON.stringify(await urlsNow()));

  // ---- 3. An error.
  await newChat();
  await script('E', [{ name: 'open_tab', input: { url: '/E-0' } }, { name: 'open_tab', input: { url: '/E-1' } }]);
  await app.evaluate(() => { global.__fail.E = true; });
  await send('chat-E: open and fail');
  await waitFor(async () => /model failed|went wrong|Something/i.test(await bodyText()), 20000);
  const eGone = await waitFor(async () => !(await urlsNow()).some((u) => /\/E-/.test(u)), 20000);
  check('a run that ends in an error closes the tabs it opened', Boolean(eGone), JSON.stringify(await urlsNow()));

  // ---- 4. A crash: the app is killed with a run's tabs open; the next start closes them (the setting is Close).
  await newChat();
  await script('C', [{ name: 'open_tab', input: { url: '/C-0' } }, { name: 'open_tab', input: { url: '/C-1' } }]);
  await hold('C');
  await send('chat-C: open and crash');
  await waitFor(async () => (await marks()).filter((x) => /\/C-/.test(x.url)).length === 2, 30000);
  const crash = async () => { // what a crash leaves: the saved session, and the marker
    await sleep(5000); // (the session is saved a moment after a change)
    await app.evaluate(() => global.__settingsFlush && global.__settingsFlush());
    await sleep(1000);
    await app.close();
    await sleep(2000);
    fs.writeFileSync(path.join(profile, 'running'), '1'); // the marker a run that did not quit normally leaves (a hard kill leaves helper processes holding the profile, so a quit stands in for it)
    for (let attempt = 0; attempt < 5; attempt++) {
      app = await launch(profile).catch(() => null);
      ui = app ? await app.firstWindow().catch(() => null) : null;
      if (ui && await ui.waitForSelector('.tab', { timeout: 20000 }).then(() => true, () => false)) break;
      await app?.close().catch(() => {});
      await sleep(3000);
      ui = null;
    }
    if (!ui) throw new Error('Lumen did not come back after the crash');
  };
  await app.evaluate(() => global.__settings.backend.set('closeAiTabs', 'off')); // first with Leave open: the killed run's tabs must come back (so the check below is not vacuous)
  await crash();
  const cBack = await waitFor(async () => (await marks()).filter((x) => /[/]C-/.test(x.url)).length === 2, 20000);
  check('(set up) with Leave open a crash leaves the runs two tabs, still marked', Boolean(cBack), JSON.stringify(await urlsNow()));
  await app.evaluate(() => global.__settings.backend.set('closeAiTabs', 'always'));
  await crash();
  const cGone = await waitFor(async () => !(await urlsNow()).some((u) => /\/C-/.test(u)), 20000);
  check('after a crash the next start closes the tabs the killed run left (Close)', Boolean(cGone), JSON.stringify(await urlsNow()));

  check('no script errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
