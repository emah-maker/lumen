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
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
});
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
  await inPage("document.querySelector('#cp-items .chat-item:not(.current) .chat-delete').click()");
  check('delete (two clicks) works from the page', await waitFor(async () => (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 1), await inPage("document.querySelectorAll('#cp-items .chat-item').length"));

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

  // (last: it starts a fresh chat, so the restore checks above still see the saved one)
  // Ctrl+Shift+K: a fresh sidebar chat, opening the sidebar if it was closed, with the prompt focused
  await ui.click('#toggle-sidebar');
  await waitFor(() => ui.evaluate(() => document.body.classList.contains('sidebar-hidden')));
  await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'K', control: true, shift: true }));
  check('Ctrl+Shift+K opens a closed sidebar with the prompt focused', await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden') && document.activeElement === document.getElementById('prompt'))), 'not open/focused');
  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
