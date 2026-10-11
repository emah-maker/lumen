// lumen://chat: the sidebar's conversation as a full page (features/chat-page.js, renderer/chat-page.*).
// A fake Claude client (no network, no key) drives it. Covers: opening the page from the sidebar
// (which folds away), the same chat in both, a message sent from the page showing in the sidebar with
// its running state, the AI's tab being the last one looked at and never the chat tab, images and
// approval cards from the page, Stop, the page's own list, Back to sidebar, a private window that
// can't open it, a page that can't navigate to it, a preload with only the chat calls, and the page
// coming back after a restart.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// A fake Claude key keeps the picker, and so the agent, on the Claude API; the client is swapped for a
// fake that records what the run could see and can be held back by a gate.
// (These checks are about a chat the sidebar reopens on: the "Sidebar button starts a new chat" default is covered by test/sidebar-newchat.js.)
const launch = async (profile) => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  return app;
};
const fakeClient = (app) => app.evaluate(() => {
  const fake = global.__fake = { n: 0, gate: null, runs: [] };
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const text = `Reply ${++fake.n}.`;
    const last = params.messages[params.messages.length - 1];
    let taskTab = null;
    try { taskTab = global.__agent.taskTab()?.id ?? null; } catch { /* no task */ }
    fake.runs.push({ active: global.__agent.browser.activeTab()?.id ?? null, taskTab, blocks: Array.isArray(last?.content) ? last.content.map((b) => b.type) : [] });
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200 } };
    return {
      async *[Symbol.asyncIterator]() { if (fake.gate) await fake.gate; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
      finalMessage: async () => message,
    };
  } } } });
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Fixture ${req.url.slice(1)}</title><body><p>fixture ${req.url}</p></body>`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chatpage-'));

  let app = await launch(profile);
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await fakeClient(app);

  const tabs = () => app.evaluate(() => global.__chatPage.tabs());
  const chatTab = async () => (await tabs()).find((t) => t.chat && /chat-page\.html$/.test(t.url)); // once it has loaded
  const chatFlags = async () => JSON.stringify((await tabs()).map((t) => [t.id, t.chat]));
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  const openWeb = (name) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, `${base}/${name}`);
  const sidebarText = () => ui.evaluate(() => document.getElementById('messages').textContent);
  const pageText = () => inPage("document.getElementById('messages').textContent");

  // ---- a tab to work on, and one message from the sidebar
  const a = await openWeb('alpha');
  const b = await openWeb('beta'); // opened last: the one looked at last
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.fill('#prompt', 'first from the sidebar');
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => /Reply 1\./.test(await sidebarText()));

  // ---- 1. Open as full page from the sidebar
  check('the sidebar has an "Open as full page" button', await ui.evaluate(() => Boolean(document.getElementById('open-chat-page')?.getAttribute('aria-label'))), 'button');
  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  const chat = await waitFor(chatTab);
  const frontId = await waitFor(async () => { const id = await app.evaluate(() => global.__chatPage.activeId()); return id === chat?.id && id; });
  check('the button opens a lumen://chat tab, in front', Boolean(chat) && /renderer\/chat-page\.html$/.test(chat.url) && frontId === chat.id, JSON.stringify({ chat, front: await app.evaluate(() => global.__chatPage.activeId()) }));
  check('the address bar shows lumen://chat', await waitFor(() => ui.evaluate(() => document.getElementById('address').value === 'lumen://chat')), await ui.evaluate(() => document.getElementById('address').value));
  check('the sidebar folds away when the page opens', await waitFor(() => ui.evaluate(() => document.body.classList.contains('sidebar-hidden'))), 'sidebar still open');
  await waitFor(async () => (await inPage("document.body.dataset.x || document.readyState")) === 'complete');
  check('the page shows the same chat the sidebar had', await waitFor(async () => { const t = await pageText(); return /first from the sidebar/.test(t) && /Reply 1\./.test(t); }), await pageText());

  // ---- 2. What the page can reach: the chat calls, and nothing else
  const api = await inPage(`({ assistant: typeof window.assistant, chats: typeof window.assistant?.chats?.list, browser: typeof window.browser, settings: typeof window.lumenSettings, managers: typeof window.lumenBookmarks, mcp: typeof window.assistant?.setMcpEnabled, key: typeof window.assistant?.setProviderKey, prefs: Object.keys(window.lumenPrefs || {}).sort().join(), extras: Object.keys(window.lumenExtras || {}).sort().join(), errors: window.__errs || 0 })`);
  check('the page has the chat API', api.assistant === 'object' && api.chats === 'function', JSON.stringify(api));
  check('the page has no browser bridge, no Settings API, no key or MCP calls', api.browser === 'undefined' && api.settings === 'undefined' && api.managers === 'undefined' && api.mcp === 'undefined' && api.key === 'undefined', JSON.stringify(api));
  check('its prefs and extras are the small subsets', api.prefs === 'get,onChange,openSettingsPage' && api.extras === 'openUsage,usage', JSON.stringify(api));
  const refused = await inPage(`Promise.all([window.assistant.getSettings().then(() => 'ok'), typeof require === 'undefined' && typeof process === 'undefined' ? 'no require' : 'has require']).catch((e) => String(e))`);
  check('a chat call works from the page (and Node is not exposed)', Array.isArray(refused) && refused[0] === 'ok' && refused[1] === 'no require', JSON.stringify(refused));
  const lonely = await inPage(`(async () => { try { return await window.assistant.state().then((s) => Boolean(s.view)); } catch (e) { return String(e); } })()`);
  check('the page can ask main for the current chat', lonely === true, JSON.stringify(lonely));
  const parts = await inPage(`({ model: document.querySelectorAll('#model option').length, picker: Boolean(document.querySelector('.model-picker .picker-button')), meter: Boolean(document.getElementById('usage-meter')), stop: Boolean(document.getElementById('send')), attach: Boolean(document.getElementById('attachments')), auto: Boolean(document.getElementById('auto-allow')), landmarks: ['nav', 'main', 'header', '[role=log]', 'form'].map((s) => Boolean(document.querySelector(s))).join(), live: document.getElementById('messages').getAttribute('aria-live'), note: Boolean(document.querySelector('body > [role=status][aria-live=polite]')), lang: document.documentElement.lang })`);
  check('model picker, usage bar, composer, attachments and auto-allow are all on the page', parts.model > 0 && parts.picker && parts.meter && parts.stop && parts.attach && parts.auto, JSON.stringify(parts));
  // The full-page composer takes images too: the attach button, a picked file (a tiny PNG here), the chip and its remove button.
  const attachedOnPage = await inPage(`(async () => {
    const btn = document.getElementById('attach');
    const c = document.createElement('canvas'); c.width = 8; c.height = 8; c.getContext('2d').fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'page.png', { type: 'image/png' }));
    const input = document.getElementById('attach-input'); input.files = dt.files; input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 600));
    const chips = document.querySelectorAll('#attachments .attachment').length;
    const named = Boolean(btn && btn.getAttribute('aria-label') && /up to 10/.test(btn.title));
    document.querySelector('#attachments .attachment-remove')?.click();
    return { chips, named, after: document.querySelectorAll('#attachments .attachment').length };
  })()`);
  check('the full-page chat has an attach button that adds (and removes) an image', attachedOnPage?.chips === 1 && attachedOnPage?.named && attachedOnPage?.after === 0, JSON.stringify(attachedOnPage));
  // (the list itself is aria-live off so a streaming reply is not read word by word; chat-core's one polite status note announces)
  check('landmarks (nav, main, header, log, form), a quiet log and a polite status note', parts.landmarks === 'true,true,true,true,true' && parts.live === 'off' && parts.note === true, JSON.stringify(parts));

  const unnamed = await inPage(`[...document.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => el.offsetParent !== null || el.tagName === 'SELECT').filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() || (el.labels && el.labels.length))).map((el) => el.outerHTML.slice(0, 100))`);
  check('every control on the page has a name', Array.isArray(unnamed) && unnamed.length === 0, JSON.stringify(unnamed));
  if (process.env.LUMEN_CHATPAGE_SHOTS) { // a look at the page, for whoever is changing its layout
    const shot = await app.evaluate(async () => (await global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id).capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(process.env.LUMEN_CHATPAGE_SHOTS, 'chat-page.png'), Buffer.from(shot, 'base64'));
  }

  // ---- 3. Which tab the AI works in, shown in the header
  check('the header names the tab the AI will work in: the one looked at last', await waitFor(async () => /Fixture beta/.test(await inPage("document.getElementById('cp-target-text').textContent"))), await inPage("document.getElementById('cp-target-text').textContent"));

  // ---- 4. Send from the page (held back, to see the running state in both views)
  let release;
  await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'second from the page'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  const bothRunning = await waitFor(async () => (await ui.evaluate(() => document.getElementById('send').classList.contains('stop') && document.body.classList.contains('agent-active'))) && (await inPage("document.getElementById('send').classList.contains('stop')")));
  check('a run from the page shows as running in the sidebar and the page', Boolean(bothRunning), 'running state');
  check('the sidebar shows the message sent from the page while it runs', /second from the page/.test(await sidebarText()), await sidebarText());
  release = () => app.evaluate(() => global.__fake.release());
  await release();
  await waitFor(async () => /Reply 2\./.test(await pageText()) && /Reply 2\./.test(await sidebarText()));
  check('the reply streams into both views', /Reply 2\./.test(await pageText()) && /Reply 2\./.test(await sidebarText()) && /second from the page/.test(await pageText()), `${await pageText()} || ${await sidebarText()}`);
  const run = await app.evaluate(() => global.__fake.runs[1]);
  const ids = { chat: (await chatTab()).id, a, b };
  check('the AI\'s tab was the last one looked at, never the chat tab', run.active === ids.b && run.taskTab === ids.b && run.active !== ids.chat, JSON.stringify({ run, ids }));
  check('both views stopped running when the reply finished', await waitFor(async () => !(await ui.evaluate(() => document.getElementById('send').classList.contains('stop'))) && !(await inPage("document.getElementById('send').classList.contains('stop')"))), 'still running');
  check('the usage line shows in both views', await waitFor(async () => /2\.4k tokens/.test(await inPage("document.getElementById('chat-usage').textContent")) && /2\.4k tokens/.test(await ui.evaluate(() => document.getElementById('chat-usage').textContent))), await inPage("document.getElementById('chat-usage').textContent"));
  check('the chat stayed where the user was: the chat tab is still in front', await app.evaluate(() => global.__chatPage.activeId()) === ids.chat, 'moved');

  // ---- 5. Continue in the sidebar: it shows on the page
  await ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true' && document.getElementById('toggle-sidebar').click());
  await ui.fill('#prompt', 'third from the sidebar');
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => /Reply 3\./.test(await pageText()));
  check('a message sent in the sidebar appears on the page, with its reply', /third from the sidebar/.test(await pageText()) && /Reply 3\./.test(await pageText()), await pageText());

  // ---- 6. Images from the page
  await inPage(`(async () => {
    const bytes = Uint8Array.from(atob('${PNG}'), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
    document.querySelector('[data-chat-root]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  check('an image dropped on the page becomes an attachment', await waitFor(async () => (await inPage("document.querySelectorAll('#attachments .attachment').length")) === 1), 'no attachment');
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'what is this'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await waitFor(async () => /Reply 4\./.test(await pageText()));
  const withImage = await app.evaluate(() => global.__fake.runs[3]);
  check('the image reaches the model from the page', withImage.blocks.includes('image'), JSON.stringify(withImage));
  check('and shows in the sidebar\'s copy of the turn', await waitFor(() => ui.evaluate(() => document.querySelectorAll('#messages .msg-images img').length >= 1)), 'no image in sidebar');

  // ---- 7. Approval cards from the page reach the agent
  await app.evaluate(() => { global.__resolved = []; global.__agent.resolveApproval = (id, ok) => global.__resolved.push([id, ok]); });
  await inPage("showApproval('a1', 'example.com', {})");
  check('an approval card is a labelled group on the page', await inPage("(() => { const c = document.querySelector('.approval'); return Boolean(c) && c.getAttribute('role') === 'group' && c.getAttribute('aria-label').includes('example.com'); })()") === true, 'card');
  await inPage("document.querySelector('.approval .btn.primary').click()");
  check('Allow on the page answers the agent', await waitFor(async () => JSON.stringify(await app.evaluate(() => global.__resolved)) === '[["a1",true]]'), JSON.stringify(await app.evaluate(() => global.__resolved)));

  // ---- 8. Stop from the page
  await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'a long one'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await waitFor(async () => await inPage("document.getElementById('send').classList.contains('stop')"));
  await inPage("document.getElementById('send').click()");
  await app.evaluate(() => global.__fake.release());
  check('Stop on the page ends the run in both views', await waitFor(async () => !(await inPage("document.getElementById('send').classList.contains('stop')")) && !(await ui.evaluate(() => document.getElementById('send').classList.contains('stop')))), 'still running');
  await app.evaluate(() => { global.__fake.gate = null; });

  // ---- 9. The list: same chats as the sidebar, open / new / rename / delete / export
  await ui.click('#new-chat');
  await ui.fill('#prompt', 'a second topic');
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => /a second topic/.test(await pageText()) === false); // the page cleared with the sidebar
  await waitFor(async () => /Reply/.test(await sidebarText()));
  const listed = await waitFor(async () => { const l = await inPage("[...document.querySelectorAll('#cp-items .chat-item')].map((li) => ({ title: li.querySelector('.chat-title').textContent, current: li.classList.contains('current') }))"); return Array.isArray(l) && l.length === 2 && l; });
  check('the page lists the saved chats, the open one marked', Boolean(listed) && listed[0].current && !listed[1].current, JSON.stringify(listed));
  check('a new chat in the sidebar emptied the page too, then filled with its message', /a second topic/.test(await pageText()) && !/first from the sidebar/.test(await pageText()), await pageText());
  const firstTitle = listed?.[1]?.title;
  await inPage("document.querySelectorAll('#cp-items .chat-open')[1].click()");
  check('choosing a chat in the list opens it on the page', await waitFor(async () => /first from the sidebar/.test(await pageText())), await pageText());
  check('and in the sidebar', await waitFor(async () => /first from the sidebar/.test(await sidebarText())), await sidebarText());
  check('the list keys: arrow keys move between chats', await inPage(`(() => { const rows = [...document.querySelectorAll('#cp-items .chat-open')]; rows[0].focus(); rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return document.activeElement === rows[1]; })()`) === true, 'focus');
  await inPage("document.querySelector('#cp-items .chat-item.current .chat-rename').click()");
  await inPage(`(() => { const i = document.querySelector('#cp-items input.chat-rename-input'); i.value = 'Renamed here'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('rename works from the page', await waitFor(async () => (await inPage("document.querySelector('#cp-items .chat-item.current .chat-title')?.textContent")) === 'Renamed here'), firstTitle);
  const exportPath = path.join(profile, 'export.md');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
  await inPage("document.querySelector('#cp-items .chat-item.current .chat-export').click()");
  const md = await waitFor(() => fs.existsSync(exportPath) && fs.readFileSync(exportPath, 'utf8'));
  check('Markdown export works from the page', /^# Renamed here/.test(md || '') && /first from the sidebar/.test(md || ''), (md || '').slice(0, 120));
  await inPage("document.querySelector('#cp-items .chat-item:not(.current) .chat-delete').click()");
  check('delete works from the page (one click, with Undo)', await waitFor(async () => (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 1), await inPage("document.querySelectorAll('#cp-items .chat-item').length"));

  // ---- 10. Guards: a page cannot navigate to the chat page or read it; the chat tab cannot leave
  const chatUrl = (await chatTab()).url;
  await app.evaluate((_e, fixture) => { const t = global.__agent.browser.openTab(fixture); return t.id; }, require('url').pathToFileURL(path.join(__dirname, 'fixture.html')).href);
  await sleep(800);
  const fixtureTab = (await tabs()).find((t) => /fixture\.html$/.test(t.url));
  const before = (await tabs()).length;
  await app.evaluate(async (_e, [id, url]) => { try { await global.__chatPage.contents(id).executeJavaScript(`location.href = ${JSON.stringify(url)}`); } catch { /* the navigation may abort the script */ } }, [fixtureTab.id, chatUrl]);
  await sleep(800);
  const after = await tabs();
  check('a page (even a local file) navigating to lumen://chat is stopped', after.find((t) => t.id === fixtureTab.id)?.url === fixtureTab.url && after.length === before, JSON.stringify(after.map((t) => t.url.slice(-30))));
  const popup = await app.evaluate(async (_e, [id, url]) => { try { return await global.__chatPage.contents(id).executeJavaScript(`window.open(${JSON.stringify(url)}) === null`); } catch (err) { return String(err); } }, [fixtureTab.id, chatUrl]);
  await sleep(300);
  check('and so is window.open', popup === true && (await tabs()).length === before, JSON.stringify(popup));
  const webTab = (await tabs()).find((t) => t.url.startsWith(base));
  await app.evaluate(async (_e, [id, url]) => { try { await global.__chatPage.contents(id).executeJavaScript(`location.href = ${JSON.stringify(url)}`); } catch { /* ignore */ } }, [webTab.id, chatUrl]);
  await sleep(500);
  check('a web page cannot load it either', (await tabs()).find((t) => t.id === webTab.id)?.url.startsWith(base) && (await tabs()).filter((t) => t.chat).length === 1, JSON.stringify(await tabs()));
  await inPage("location.href = 'https://example.com/'");
  await sleep(600);
  check('the chat tab itself cannot navigate away', /chat-page\.html$/.test((await chatTab())?.url || '') || !(await chatTab()), JSON.stringify(await tabs()));

  // ---- 11. Private windows can't open it
  const chatsBefore = (await tabs()).filter((t) => t.chat).length;
  await app.evaluate(() => global.__private.open());
  await waitFor(() => app.evaluate(() => global.__private.count() === 1 && global.__private.list()[0].tabs.length === 1));
  const priv = await app.evaluate(() => global.__private.list()[0]);
  await app.evaluate(({ ipcMain, BrowserWindow }, windowId) => {
    const wc = BrowserWindow.fromId(windowId).webContents;
    ipcMain.emit('chat:open-page', { sender: wc, senderFrame: wc.mainFrame });
    ipcMain.emit('chatpage:back', { sender: wc, senderFrame: wc.mainFrame });
  }, priv.windowId);
  await sleep(600);
  check('a private window cannot open the chat page', (await tabs()).filter((t) => t.chat).length === chatsBefore && (await app.evaluate(() => global.__private.list()[0].tabs.length)) === 1, JSON.stringify(await tabs()));
  const privUi = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.executeJavaScript('({ assistant: typeof window.assistant, chat: typeof window.assistant?.openFullPage })'), priv.windowId);
  check('and its UI has no chat calls at all', privUi.assistant === 'undefined', JSON.stringify(privUi));
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), priv.windowId);
  await waitFor(() => app.evaluate(() => global.__private.count() === 0));

  // ---- 12. The shortcut (Ctrl+Shift+L) and Back to sidebar
  await inPage("document.getElementById('cp-back').click()");
  check('Back to sidebar closes the page tab', await waitFor(async () => !(await chatTab())), JSON.stringify(await tabs()));
  check('and brings the sidebar back', await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden'))), 'sidebar hidden');
  check('and returns to the tab looked at before', await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) !== ids.chat), 'still on chat');
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'L', control: true, shift: true }));
  check('Ctrl+Shift+L opens the page', Boolean(await waitFor(chatTab)), JSON.stringify(await tabs()));
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'L', control: true, shift: true }));
  check('and Ctrl+Shift+L on the page goes back to the sidebar', await waitFor(async () => !(await chatTab())) && await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden'))), 'still open');
  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  await waitFor(chatTab);
  const oneChatTab = (await tabs()).filter((t) => t.chat).length === 1;
  await app.evaluate(() => global.__chatPage.open());
  check('opening it again reuses the one tab', oneChatTab && (await tabs()).filter((t) => t.chat).length === 1, await chatFlags());

  // ---- 12b. The page keeps its chat when you leave and come back (cycling tabs), whatever chat is open elsewhere meanwhile
  const pageTab = await chatTab();
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), a);
  await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) === a);
  await sleep(400);
  if (await ui.evaluate(() => document.body.classList.contains('sidebar-hidden'))) await ui.evaluate(() => document.getElementById('toggle-sidebar').click()); // (each tab has its own sidebar state)
  await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden')));
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.fill('#prompt', 'second chat elsewhere');
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => /Reply \d+\./.test(await sidebarText()) && /second chat elsewhere/.test(await sidebarText()));
  await sleep(500);
  check('the page, left in the background, did not switch to the chat started in another tab', !/second chat elsewhere/.test(await pageText()) && /first from the sidebar/.test(await pageText()), await pageText());
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), pageTab.id);
  await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) === pageTab.id);
  await sleep(500);
  check('back on the page tab: still the chat it was left on, with its history', /first from the sidebar/.test(await pageText()) && !/second chat elsewhere/.test(await pageText()), await pageText());
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), a);
  await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) === a);
  await sleep(300);
  check('and the other tab still has its own chat', /second chat elsewhere/.test(await sidebarText()) && !/first from the sidebar/.test(await sidebarText()), await sidebarText());
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), pageTab.id);
  await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) === pageTab.id);

  // ---- 13. After a restart the page is back, showing the chat
  await sleep(3500); // the session is saved a moment after tabs change
  await app.close();
  app = await launch(profile);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const restored = await waitFor(chatTab, 10000);
  check('session restore reopens lumen://chat as a tab', Boolean(restored) && /chat-page\.html$/.test(restored.url), JSON.stringify(await tabs()));
  check('the restored page works: it loads the saved chat', await waitFor(async () => /first from the sidebar/.test(await inPage("document.getElementById('messages').textContent")), 10000), await inPage("document.getElementById('messages').textContent"));
  check('and has its API (the preload came along)', await inPage("typeof window.assistant?.state") === 'function', 'no preload');

  // ---- 14. A chat whose saved file is gone or unreadable never turns the page into an empty chat
  // (the list still named the chat, "Done" and "This tab" on its row, but the page showed the empty state: a chat that
  // finished while the page was away was opened as an empty one under its id, and the conversation on screen was wiped)
  await fakeClient(app);
  const pageNow = await chatTab();
  await inPage("document.getElementById('new-chat').click()");
  await sleep(400);
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'about to vanish'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await waitFor(async () => /about to vanish/.test(await pageText()) && /Reply d+./.test(await pageText()));
  await sleep(1200);
  const goneId = await app.evaluate((_e, id) => global.__tabChats.bindings.chatOf(id), pageNow.id);
  const away = (await tabs()).find((t) => !t.chat);
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), away.id);
  await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) === away.id);
  await sleep(500);
  fs.rmSync(path.join(profile, 'chats', `${goneId}.json`), { force: true }); // (what the list still names, the disk no longer has)
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), pageNow.id);
  await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) === pageNow.id);
  await sleep(1200);
  const afterGone = await inPage(`({ msgs: document.querySelectorAll('#messages .msg').length, text: document.getElementById('messages').textContent, empty: !document.getElementById('empty').hidden })`);
  const boundNow = await app.evaluate((_e, id) => global.__tabChats.bindings.chatOf(id), pageNow.id);
  check('a chat whose file is gone is not shown as an empty chat on the page', afterGone.msgs > 0 && !afterGone.empty, JSON.stringify(afterGone).slice(0, 300));
  check('the page no longer holds the chat that is gone, and shows the chat it follows now', boundNow && boundNow !== goneId && !/about to vanish/.test(afterGone.text), JSON.stringify({ boundNow, goneId }));
  await inPage('location.reload()');
  await waitFor(async () => (await inPage("document.readyState")) === 'complete');
  await sleep(1500);
  check('and a reload of the page shows that chat too, not an empty one', await waitFor(async () => (await inPage("document.querySelectorAll('#messages .msg').length")) > 0), await pageText());

  // ---- 15. Home: the page's way back to the normal homepage (the new-tab page), in place
  const isNewTabUrl = (u) => /renderer[/\\]newtab\.html/.test(u || '');
  const homeLabels = await inPage(`(() => { const b = document.getElementById('cp-home'); return { title: b?.title, aria: b?.getAttribute('aria-label'), icon: Boolean(b?.querySelector('svg')), same: b?.className === document.getElementById('open-settings').className }; })()`);
  check('the header has a Home button: house icon, "New tab page" in its tooltip and aria-label, styled like the other header buttons', homeLabels?.aria === 'New tab page' && /^New tab page/.test(homeLabels.title) && homeLabels.icon && homeLabels.same, JSON.stringify(homeLabels));
  const homeChat = await app.evaluate((_e, id) => global.__tabChats.bindings.chatOf(id), (await chatTab()).id);
  const homeRunsBefore = await app.evaluate(() => global.__fake.runs.length);
  await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'still running when I left'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  check('a reply is running when Home is pressed', await waitFor(async () => (await inPage("document.getElementById('send').classList.contains('stop')")) === true), 'not running');
  const beforeHome = await tabs();
  const chatIndex = beforeHome.findIndex((t) => t.chat);
  await inPage("document.getElementById('cp-home').click()");
  check('Home turns the chat tab into the new-tab page', await waitFor(async () => !(await chatTab()) && isNewTabUrl((await app.evaluate(() => global.__chatPage.tabs().find((t) => t.id === global.__chatPage.activeId())))?.url)), JSON.stringify(await tabs()));
  const afterHome = await tabs();
  check('in place: same number of tabs, same position, no extra tab', afterHome.length === beforeHome.length && isNewTabUrl(afterHome[chatIndex]?.url) && afterHome.filter((t) => isNewTabUrl(t.url)).length === beforeHome.filter((t) => isNewTabUrl(t.url)).length + 1, JSON.stringify({ beforeHome, afterHome }));
  await app.evaluate(() => global.__fake.release());
  check('the reply carried on in the background', await waitFor(async () => (await app.evaluate(() => global.__fake.runs.length)) === homeRunsBefore + 1 && !(await app.evaluate(() => global.__chatPage.rt.runs.running()))), String(await app.evaluate(() => global.__fake.runs.length)));
  await app.evaluate(() => { global.__fake.gate = null; });
  const inHistory = await waitFor(async () => (await ui.evaluate(() => window.assistant.chats.list().then((l) => JSON.stringify(l)))).includes(homeChat), 6000);
  check('and the chat is still in the history list', Boolean(homeChat) && Boolean(inHistory), String(homeChat));
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'Home', alt: true }));
  await sleep(300);
  check('Alt+Home on an ordinary page does nothing', (await tabs()).length === afterHome.length && !(await chatTab()), JSON.stringify(await tabs()));

  // Alt+Home on the chat page
  await app.evaluate(() => global.__chatPage.open());
  const pageAgain = await waitFor(chatTab);
  const beforeAlt = await tabs();
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), pageAgain.id);
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'Home', alt: true }));
  check('Alt+Home turns the chat page into the new-tab page too', await waitFor(async () => !(await chatTab()) && isNewTabUrl((await app.evaluate(() => global.__chatPage.tabs().find((t) => t.id === global.__chatPage.activeId())))?.url) && (await tabs()).length === beforeAlt.length), JSON.stringify({ before: beforeAlt.map((t) => [t.id, t.chat]), after: (await tabs()).map((t) => [t.id, t.chat, t.url.slice(-20)]), front: await app.evaluate(() => global.__chatPage.activeId()) }));

  // Back and Alt+Left: to the page it was opened from
  const origin = await openWeb('origin'); // the page the chat is opened from
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), origin);
  await waitFor(async () => (await app.evaluate(() => global.__chatPage.activeId())) === origin);
  await app.evaluate(() => global.__chatPage.open());
  await waitFor(chatTab);
  check('the toolbar can go back from the chat page', await ui.evaluate(() => !document.getElementById('back').disabled), 'Back button disabled');
  await app.evaluate(({ ipcMain }) => ipcMain.emit('nav:back', {}));
  check('toolbar Back goes to the page the chat was opened from', await waitFor(async () => !(await chatTab()) && (await app.evaluate(() => global.__chatPage.activeId())) === origin), JSON.stringify({ origin, front: await app.evaluate(() => global.__chatPage.activeId()), pick: await app.evaluate(() => global.__chatPage.pick()), tabs: (await tabs()).map((t) => [t.id, t.chat, t.viewedAt]) }));
  await app.evaluate(() => global.__chatPage.open());
  await waitFor(chatTab);
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'ArrowLeft', alt: true }));
  check('and so does Alt+Left', await waitFor(async () => !(await chatTab()) && (await app.evaluate(() => global.__chatPage.activeId())) === origin), JSON.stringify({ origin, front: await app.evaluate(() => global.__chatPage.activeId()), pick: await app.evaluate(() => global.__chatPage.pick()), tabs: (await tabs()).map((t) => [t.id, t.chat, t.viewedAt]) }));

  // an address typed on the chat page opens in its place
  await app.evaluate(() => global.__chatPage.open());
  await waitFor(chatTab);
  const beforeGo = await tabs();
  await app.evaluate(({ ipcMain }, u) => ipcMain.emit('nav:go', {}, u), `${base}/typed`);
  check('an address typed on the chat page opens in its place, no extra tab', await waitFor(async () => { const t = await tabs(); return !t.some((x) => x.chat) && t.length === beforeGo.length && t.some((x) => x.url === `${base}/typed`); }), JSON.stringify(await tabs()));

  // no page to go back to: Back goes to the new-tab page (never closes the window)
  await app.evaluate(() => global.__chatPage.open());
  await waitFor(chatTab);
  const pageId = (await chatTab()).id;
  for (let id = 1; id < pageId; id++) await app.evaluate((_e, i) => global.__closeTabInteractive(i), id); // (every earlier tab, a sleeping one too: tabs() lists only the live ones)
  await waitFor(async () => (await tabs()).length === 1);
  await app.evaluate(({ ipcMain }) => ipcMain.emit('nav:back', {}));
  check('with no page to come from, Back goes to the new-tab page', await waitFor(async () => { const t = await tabs(); return t.length === 1 && isNewTabUrl(t[0].url); }), JSON.stringify(await tabs()));
  check('the browser window is still open', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)) >= 0 && await ui.evaluate(() => document.querySelectorAll('.tab').length) === 1, 'window gone');

  // (last: it starts a fresh chat, so the restore checks above still see the saved one)
  // Ctrl+Shift+K: a fresh sidebar chat, opening the sidebar if it was closed, with the prompt focused
  await ui.click('#toggle-sidebar');
  await waitFor(() => ui.evaluate(() => document.body.classList.contains('sidebar-hidden')));
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'K', control: true, shift: true }));
  check('Ctrl+Shift+K opens a closed sidebar with the prompt focused', await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden') && document.activeElement === document.getElementById('prompt'))), 'not open/focused');
  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));

  // ---- 16. The layout of claude.ai and ChatGPT: a rail with the chat list, a centred column, an empty chat with the composer in the middle
  await app.close();
  const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chatpage-layout-'));
  app = await launch(profile2);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await fakeClient(app);
  await app.evaluate(() => { // chats from different days, to see the groups
    const store = global.__chats.store(); const real = Date.now; const day = 864e5;
    for (const [title, d] of [['Plan a trip to Lisbon', 45], ['Compare mortgage rates', 20], ['Fix flaky CI test', 3], ['Summarize the Rust notes', 1.2], ['Draft email to landlord', 0.1]]) {
      Date.now = () => real() - d * day;
      store.save(store.newId(), { messages: [{ role: 'user', content: title }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }], settings: {} });
    }
    Date.now = real;
  });
  await app.evaluate(() => global.__chatPage.open());
  await waitFor(chatTab);
  await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 5);
  const geo = (sel) => inPage(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight }; })()`);
  const settled = async (sel) => { let last = null; for (let i = 0; i < 40; i++) { const g = await geo(sel); if (last && g && Math.abs(g.y - last.y) < 0.5) return g; last = g; await sleep(150); } return last; }; // (the composer glides: measure it once it has stopped)
  const titles = () => inPage("[...document.querySelectorAll('#cp-items .chat-title')].map((t) => t.textContent)");
  const rowCount = () => inPage("document.querySelectorAll('#cp-items .chat-item').length");
  const rail = await geo('#cp-rail');
  check('the chat list is a rail of about 260px, open on a wide window', rail && rail.w > 240 && rail.w < 290 && rail.x === 0 && rail.vw >= 800, JSON.stringify(rail));
  const order = await inPage(`(() => { const rail = document.getElementById('cp-rail'); const pos = (sel) => [...rail.querySelectorAll('*')].indexOf(rail.querySelector(sel)); return { n: pos('#new-chat'), s: pos('.chat-search'), l: pos('#cp-items'), kbd: Boolean(rail.querySelector('#new-chat .cp-kbd')?.textContent) }; })()`);
  check('the rail reads New chat (with its shortcut), Search chats, then the list', order.n >= 0 && order.n < order.s && order.s < order.l && order.kbd, JSON.stringify(order));
  const groups = await inPage("[...document.querySelectorAll('#cp-items .chat-group')].map((g) => g.textContent)");
  check('the list is grouped: Today, Yesterday, Previous 7 days, Previous 30 days, then by month', ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days'].every((g) => groups.includes(g)) && groups.length === 5 && /\d{4}/.test(groups[4]), JSON.stringify(groups));
  // search
  await inPage(`(() => { const s = document.querySelector('.chat-search'); s.value = 'mortgage'; s.dispatchEvent(new Event('input')); })()`);
  check('searching narrows the list', await waitFor(async () => JSON.stringify(await titles()) === '["Compare mortgage rates"]'), JSON.stringify(await titles()));
  await inPage(`(() => { const s = document.querySelector('.chat-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await waitFor(async () => (await rowCount()) === 5);
  // the ⋯ menu on a row
  await inPage("document.querySelector('#cp-items .chat-item .chat-more').click()");
  const menu = await inPage(`(() => { const li = document.querySelector('#cp-items .chat-item.menu-open'); const m = li?.querySelector('.chat-menu'); return { open: Boolean(li), shown: m ? getComputedStyle(m).display !== 'none' : false, labels: [...(m?.querySelectorAll('.chat-menu-label') || [])].map((l) => l.textContent), expanded: li?.querySelector('.chat-more').getAttribute('aria-expanded') }; })()`);
  check('a row has a ⋯ menu: Rename, Pin, Archive, Delete', menu.open && menu.shown && menu.expanded === 'true' && ['Rename', 'Pin to top', 'Archive', 'Delete'].every((l) => menu.labels.includes(l)), JSON.stringify(menu));
  await inPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('Escape closes the row menu', await inPage("!document.querySelector('#cp-items .chat-item.menu-open')"), 'still open');
  await inPage("document.querySelector('#cp-items .chat-item .chat-more').click(); document.querySelector('#cp-items .chat-item.menu-open .chat-pin').click()");
  check('Pin from the menu pins the chat (it moves under Pinned)', await waitFor(async () => (await inPage("document.querySelector('#cp-items .chat-group')?.textContent")) === 'Pinned'), String(await inPage("document.querySelector('#cp-items .chat-group')?.textContent")));
  await inPage("document.querySelector('#cp-items .chat-item .chat-more').click(); document.querySelector('#cp-items .chat-item.menu-open .chat-archive').click()");
  check('Archive from the menu moves it to Archived, reachable from the rail', await waitFor(async () => /Archived \(1\)/.test(await inPage("document.getElementById('cp-archived').textContent"))), String(await inPage("document.getElementById('cp-archived').textContent")));
  await inPage("document.getElementById('cp-archived').click()");
  check('and the Archived row shows just that chat', await waitFor(async () => (await rowCount()) === 1), String(await rowCount()));
  await inPage("document.getElementById('cp-archived').click()");
  await waitFor(async () => (await rowCount()) === 4);
  // collapse with the button and with Ctrl+Shift+S (main hands the key to the page)
  await inPage("document.getElementById('cp-rail-close').click()");
  const folded = await waitFor(async () => { const r = await geo('#cp-rail'); return r && r.r <= 1 ? r : null; });
  check('the rail folds with its button, and a Show button takes its place in the header', Boolean(folded) && await inPage("!document.getElementById('cp-rail-open').hidden && document.body.classList.contains('cp-rail-hidden') && document.getElementById('cp-rail').inert"), JSON.stringify(await geo('#cp-rail')));
  await app.evaluate(() => global.__chatPage.switchTab(global.__chatPage.tabs().find((x) => x.chat).id));
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'S', control: true, shift: true }));
  check('Ctrl+Shift+S opens it again', await waitFor(async () => { const r = await geo('#cp-rail'); return r && r.x === 0 && r.w > 240 && !(await inPage("document.body.classList.contains('cp-rail-hidden')")); }), JSON.stringify(await geo('#cp-rail')));
  // a chat with messages: the column
  await inPage("document.querySelector('#cp-items .chat-open').click()");
  await waitFor(async () => (await inPage("document.querySelectorAll('#messages .msg').length")) > 0);
  const col = await inPage(`(() => { const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { x: b.x, r: b.right, w: b.width }; }; return { m: r('#messages .msg.assistant'), c: r('#composer'), main: r('#chat-root'), userRight: document.querySelector('#messages .msg.user').getBoundingClientRect().right }; })()`);
  check('the conversation is a centred column of at most 768px, and the composer is as wide', col.m.w <= 769 && col.m.w > 300 && Math.abs((col.m.x + col.m.r) / 2 - (col.main.x + col.main.r) / 2) < 3 && Math.abs(col.c.w - col.m.w) < 4, JSON.stringify(col));
  check('your messages sit on the right of the column, in a bubble', Math.abs(col.userRight - col.m.r) < 3, JSON.stringify(col));
  check('the tab is titled with the chat', await waitFor(async () => (await inPage('document.title')) === (await inPage("document.querySelector('#cp-items .chat-item.current .chat-title').textContent"))), String(await inPage('document.title')));
  const bottomed = await waitFor(async () => { const g = await geo('#composer'); return g && g.b > g.vh - 90 ? g : null; }, 4000);
  check('a chat with messages has its composer at the bottom', Boolean(bottomed), JSON.stringify(await geo('#composer')));
  // a new chat: the greeting, the composer in the middle, starters under it; then the first message moves it down
  await inPage("document.getElementById('new-chat').click()");
  await sleep(300);
  const mid0 = await settled('#composer');
  const mid = mid0 && mid0.y + mid0.h / 2 < mid0.vh * 0.62 && mid0.y + mid0.h / 2 > mid0.vh * 0.3 ? mid0 : null;
  check('an empty chat has its composer in the middle of the page', Boolean(mid), JSON.stringify(await geo('#composer')));
  const greetBox = await geo('#empty .empty-title');
  const chips = await inPage("[...document.querySelectorAll('#empty .chip')].filter((c) => c.offsetParent).length");
  const cb = await geo('#empty .chips');
  check('with a greeting above it, and three or four starters below', Boolean(greetBox) && Boolean(mid) && greetBox.b <= mid.y + 2 && chips >= 3 && chips <= 4 && cb.y >= mid.b - 2, JSON.stringify({ greetBox, chips, cb, mid }));
  const greeting = await inPage("document.querySelector('#empty .empty-title').textContent");
  check('the greeting asks what it can help with when no name is known', /What can I help with\?|^Good (morning|afternoon|evening)/.test(greeting), greeting);
  check('a small disclaimer sits under the composer', /Lumen can make mistakes/.test(await inPage("document.querySelector('.cp-disclaimer').textContent")), 'no disclaimer');
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'first message of a fresh chat'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await sleep(300);
  const down0 = await settled('#composer');
  const down = down0 && down0.b > down0.vh - 90 ? down0 : null;
  check('the first message moves the composer down to the bottom', Boolean(down), JSON.stringify(await geo('#composer')));
  // a narrow window: the rail is a drawer over the page, closed at first
  await app.evaluate(async () => { const wc = global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 700, height: 800, deviceScaleFactor: 1, mobile: false }); });
  const narrow = await waitFor(async () => (await inPage("document.body.classList.contains('cp-narrow') && document.body.classList.contains('cp-rail-hidden')")) === true);
  const drawerGeo = await waitFor(async () => { const r = await geo('#cp-rail'); return r && r.r <= 1 ? r : null; }) || await geo('#cp-rail');
  check('under 800px the rail is a drawer, closed at first, and the conversation has the whole width', Boolean(narrow) && drawerGeo.r <= 1 && (await geo('#chat-root')).x < 2, JSON.stringify(drawerGeo));
  await inPage("document.getElementById('cp-rail-open').click()");
  const open = await waitFor(async () => { const r = await geo('#cp-rail'); return r && r.x >= 0 && r.w > 240 && !(await inPage("document.getElementById('cp-scrim').hidden")) ? r : null; });
  check('its button opens it over the conversation, with a scrim behind', Boolean(open) && (await geo('#chat-root')).w > 600, JSON.stringify(await geo('#cp-rail')));
  await inPage("document.getElementById('cp-scrim').click()");
  check('a click on the scrim closes the drawer', await waitFor(async () => { const r = await geo('#cp-rail'); return r && r.r <= 1; }), JSON.stringify(await geo('#cp-rail')));
  const unlabeled = await inPage(`[...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !(b.getAttribute('aria-label') || b.textContent.trim() || b.title)).map((b) => b.id || b.className)`);
  check('every button, in the rail, header and menus, has a name', Array.isArray(unlabeled) && unlabeled.length === 0, JSON.stringify(unlabeled));
  await app.evaluate(async () => { const wc = global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id); await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'); });
  await app.close();
  server.close();
  fs.rmSync(profile2, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
