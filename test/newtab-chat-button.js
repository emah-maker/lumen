// The new-tab page's Chat button (renderer/newtab.html + newtab.js, features/chat-page.js fromHome): it turns the tab into
// the full-page chat in place (the reverse of the chat page's Home button), Ctrl+click / middle-click open the chat in a
// new tab, and what was typed in the new-tab box waits in the chat's composer as a draft that is not sent.
// Hidden window (LUMEN_TEST_BACKGROUND), a fresh profile, a fake Claude client that counts how often anything is sent.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-newtab-chat-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    global.__sent = 0;
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => { global.__sent++; throw new Error('nothing should be sent'); } } } });
  });

  const tabs = () => app.evaluate(() => global.__chatPage.tabs());
  const activeId = () => app.evaluate(() => global.__chatPage.activeId());
  const chatTabs = async () => (await tabs()).filter((t) => t.chat && /chat-page\.html$/.test(t.url));
  const inTab = (id, code) => app.evaluate(async (_e, { i, c }) => { try { return await global.__chatPage.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, { i: id, c: code });
  // A fresh new-tab page, in front, loaded.
  const newTab = async () => {
    const id = await app.evaluate(async () => {
      const t = global.__agent.browser.openTab();
      await new Promise((r) => { t.webContents.once('did-finish-load', r); setTimeout(r, 6000); });
      global.__chatPage.switchTab(t.id);
      return t.id;
    });
    await waitFor(async () => (await activeId()) === id);
    await waitFor(async () => (await inTab(id, "document.getElementById('chat-btn') ? 'yes' : 'no'")) === 'yes');
    return id;
  };

  // ---- the button itself
  let home = await newTab();
  const btnRaw = await inTab(home, `(() => { const b = document.getElementById('chat-btn'); const r = b.getBoundingClientRect();
    return JSON.stringify({ tag: b.tagName, label: b.getAttribute('aria-label'), title: b.title, text: b.textContent.trim(), icon: Boolean(b.querySelector('svg')), tabindex: b.tabIndex,
      shown: r.width > 0 && r.height > 0 && r.right <= innerWidth && r.top >= 0, shortcut: b.getAttribute('aria-keyshortcuts') }); })()`);
  const btn = JSON.parse(btnRaw);
  check('the new-tab page has a Chat button (icon + label, aria-label, tooltip with the shortcut)', btn.tag === 'BUTTON' && btn.label === 'Open full-page chat' && btn.text === 'Chat' && btn.icon && /^Open full-page chat \((Ctrl\+Shift|Shift\+Cmd)\+L\)$/.test(btn.title) && /Shift\+L$/.test(btn.shortcut), JSON.stringify(btn));
  check('it is visible in the corner and reachable with the keyboard', btn.shown && btn.tabindex === 0, JSON.stringify(btn));
  const focusable = await inTab(home, "(() => { const b = document.getElementById('chat-btn'); b.focus(); return document.activeElement === b; })()");
  check('it takes focus', focusable === true, focusable);

  // ---- 1. click: this tab becomes the chat page
  const before = await tabs();
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const index = before.findIndex((t) => t.id === home);
  await inTab(home, "document.getElementById('chat-btn').click()");
  const chat = await waitFor(async () => (await chatTabs())[0]);
  check('clicking Chat shows the full-page chat', Boolean(chat), JSON.stringify(await tabs()));
  const after = await tabs();
  check('it is the same tab slot: the new-tab page is gone, the tab count and place are unchanged', !after.some((t) => t.id === home) && after.length === before.length && after.findIndex((t) => t.id === chat.id) === index, JSON.stringify({ before, after }));
  check('the chat tab is in front, no extra window', (await activeId()) === chat.id && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === windowsBefore, `${await activeId()} windows ${await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)} (was ${windowsBefore})`);
  check('the address bar shows lumen://chat', await waitFor(() => ui.evaluate(() => document.getElementById('address').value === 'lumen://chat')), 'address');
  await waitFor(async () => (await inTab(chat.id, "document.getElementById('cp-home') ? 'yes' : 'no'")) === 'yes');

  // ---- 2. Home brings the new-tab page back, in place
  await inTab(chat.id, "document.getElementById('cp-home').click()");
  const back = await waitFor(async () => (await chatTabs()).length === 0 && (await tabs()).find((t) => /newtab\.html/.test(t.url)));
  check('Home from the chat goes back to the new-tab page, with the Chat button again', Boolean(back) && (await waitFor(async () => (await inTab(back.id, "document.getElementById('chat-btn') ? 'yes' : 'no'")) === 'yes')), JSON.stringify(await tabs()));
  check('(no chat tab is left behind)', (await chatTabs()).length === 0, JSON.stringify(await tabs()));
  home = back.id;

  // ---- 3. typed text carries over as a draft, never sent
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), home);
  await inTab(home, "(() => { const q = document.getElementById('q'); q.value = 'plan a trip to Lisbon & Porto'; })()");
  await inTab(home, "document.getElementById('chat-btn').click()");
  const withDraft = await waitFor(async () => (await chatTabs())[0]);
  const composer = await waitFor(async () => { const v = await inTab(withDraft.id, "document.getElementById('prompt')?.value || ''"); return v || null; });
  check('the text typed in the new-tab box is in the chat composer as a draft', composer === 'plan a trip to Lisbon & Porto', composer);
  check('and nothing was sent', (await app.evaluate(() => global.__sent)) === 0 && (await inTab(withDraft.id, "document.querySelectorAll('#messages .msg.user, #messages .user').length")) === 0, await app.evaluate(() => global.__sent));
  check('the composer has focus for editing the draft', await waitFor(async () => (await inTab(withDraft.id, "document.activeElement && document.activeElement.id")) === 'prompt'), await inTab(withDraft.id, 'document.activeElement && document.activeElement.id'));
  await inTab(withDraft.id, "document.getElementById('cp-home').click()");
  const home2 = await waitFor(async () => (await chatTabs()).length === 0 && (await tabs()).find((t) => /newtab\.html/.test(t.url)));
  check('Home again', Boolean(home2), JSON.stringify(await tabs()));
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), home2.id);

  // ---- 4. Ctrl+click and middle-click: the chat opens in a new tab, the new-tab page stays
  await waitFor(async () => (await inTab(home2.id, "document.getElementById('chat-btn') ? 'yes' : 'no'")) === 'yes');
  const n0 = (await tabs()).length;
  await inTab(home2.id, "document.getElementById('chat-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))");
  const ctrlChat = await waitFor(async () => (await chatTabs())[0]);
  const t1 = await tabs();
  check('Ctrl+click opens the chat in a new tab and leaves the new-tab page', Boolean(ctrlChat) && t1.length === n0 + 1 && t1.some((t) => t.id === home2.id), JSON.stringify(t1));
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), home2.id);
  await app.evaluate((_e, id) => global.__chatPage.contents(id).executeJavaScript("document.getElementById('q').value = 'second draft'"), home2.id);
  await inTab(home2.id, "document.getElementById('chat-btn').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))");
  const second = await waitFor(async () => { const c = await chatTabs(); return c.length === 2 && c.find((t) => t.id !== ctrlChat.id); });
  check('middle-click opens another chat tab and leaves the new-tab page', Boolean(second) && (await tabs()).some((t) => t.id === home2.id), JSON.stringify(await tabs()));
  const middleDraft = second && await waitFor(async () => (await inTab(second.id, "document.getElementById('prompt')?.value || ''")) || null);
  check('the draft goes along to a chat opened in a new tab too', middleDraft === 'second draft', middleDraft);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
