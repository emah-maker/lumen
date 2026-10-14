// The new-tab page's one way into the AI: the "Ask AI" option under the search box (renderer/newtab.html + newtab.js,
// features/chat-page.js fromHome). There is no separate Chat button. Ask AI picks the mode; when it already is the mode (or with
// Ctrl/Cmd held) clicking it is the chat button: the tab turns into the full-page chat (Ctrl/Cmd+click: a new tab). Enter with a
// question asks it in a new chat there; Ctrl+Enter asks from Search mode too; Search still searches; the mode is remembered.
// Hidden window (LUMEN_TEST_BACKGROUND), a fresh profile, a stubbed provider that records what it is asked.
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-newtab-ask-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    global.__prompts = [];
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const last = params.messages[params.messages.length - 1];
      global.__prompts.push(typeof last.content === 'string' ? last.content : last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
      const content = [{ type: 'text', text: 'Here is an answer.' }];
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is an answer.' } }; }, finalMessage: async () => message };
    } } } });
  });

  const tabs = () => app.evaluate(() => global.__chatPage.tabs());
  const activeId = () => app.evaluate(() => global.__chatPage.activeId());
  const chatTabs = async () => (await tabs()).filter((t) => t.chat && /chat-page\.html$/.test(t.url));
  const prompts = () => app.evaluate(() => global.__prompts);
  const inTab = (id, code) => app.evaluate(async (_e, { i, c }) => { try { return await global.__chatPage.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, { i: id, c: code });
  // A fresh new-tab page, in front, loaded; anything it navigates to (a search) is recorded and cancelled, never loaded.
  const newTab = async () => {
    const id = await app.evaluate(async () => {
      const t = global.__agent.browser.openTab();
      await new Promise((r) => { t.webContents.once('did-finish-load', r); setTimeout(r, 6000); });
      global.__navs = [];
      t.webContents.on('will-navigate', (e, url) => { if (/^https?:/.test(url)) { global.__navs.push(url); e.preventDefault(); } });
      global.__chatPage.switchTab(t.id);
      return t.id;
    });
    await waitFor(async () => (await activeId()) === id);
    await waitFor(async () => (await inTab(id, "document.getElementById('mode-ask') ? 'yes' : 'no'")) === 'yes');
    return id;
  };
  const key = (id, k, mods = '') => inTab(id, `document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ${mods} }))`);
  const type = (id, text) => inTab(id, `(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(text)}; q.focus(); })()`);
  const enter = (id) => inTab(id, "document.getElementById('q').form.requestSubmit()");
  const mode = (id) => inTab(id, "document.querySelector('#mode [aria-checked=true]')?.dataset.mode");
  const goHome = async (chatId) => {
    await waitFor(async () => (await inTab(chatId, "document.getElementById('cp-home') ? 'yes' : 'no'")) === 'yes');
    const slot = (await tabs()).findIndex((t) => t.id === chatId); // Home turns this very tab back into the new-tab page
    await inTab(chatId, "document.getElementById('cp-home').click()");
    const back = await waitFor(async () => { const all = await tabs(); return (await chatTabs()).length === 0 && all[slot] && /newtab\.html/.test(all[slot].url) && all[slot]; });
    await app.evaluate((_e, id) => global.__chatPage.switchTab(id), back.id);
    await waitFor(async () => (await inTab(back.id, "document.getElementById('mode-ask') ? 'yes' : 'no'")) === 'yes');
    return back.id;
  };

  // ---- the page itself: one entry point
  let home = await newTab();
  check('the old corner Chat button is gone', (await inTab(home, "document.getElementById('chat-btn') === null && document.querySelector('.chat-btn') === null && !/chat-btn/.test(document.documentElement.outerHTML)")) === true, 'still there');
  const pillRaw = await inTab(home, `(() => { const b = document.getElementById('mode-ask'); return JSON.stringify({ role: b.getAttribute('role'), icon: Boolean(b.querySelector('svg')), text: b.textContent.trim(), title: b.title, keys: b.getAttribute('aria-keyshortcuts') }); })()`);
  const pill = JSON.parse(pillRaw);
  check('Ask AI has the chat icon, the label and a tooltip that says it opens the chat', pill.icon && pill.text === 'Ask AI' && /^Open chat \((Ctrl\+Shift|Shift\+Cmd)\+L\)/.test(pill.title) && /Shift\+L$/.test(pill.keys), pillRaw);
  check('Search is the default mode, and the box says what it searches', (await mode(home)) === 'search' && /^Search /.test(await inTab(home, "document.getElementById('q').placeholder")), await mode(home));

  // ---- Search mode still searches
  await type(home, 'lumen browser');
  await enter(home);
  const searched = await waitFor(async () => (await app.evaluate(() => global.__navs))[0]);
  check('Enter in Search mode searches (and does not open the chat)', /^https?:.*lumen(\+|%20)browser/.test(searched || ''), searched);
  check('...the tab is still the new-tab page, nothing was asked', (await chatTabs()).length === 0 && (await prompts()).length === 0, JSON.stringify(await tabs()));

  // ---- Ctrl+/ toggles; the mode is remembered by the next new tab
  await key(home, '/', 'ctrlKey: true');
  const askPh = await inTab(home, "document.getElementById('q').placeholder");
  check('Ctrl+/ switches to Ask AI, and the box then asks the AI', (await mode(home)) === 'ask' && /^Ask /.test(askPh), `${await mode(home)} ${askPh}`);
  const remembered = await newTab();
  check('the mode is remembered by the next new tab', (await mode(remembered)) === 'ask', await mode(remembered));
  await key(remembered, '/', 'ctrlKey: true');
  check('Ctrl+/ switches back to Search', (await mode(remembered)) === 'search', await mode(remembered));
  const again = await newTab();
  check('...and that is remembered too', (await mode(again)) === 'search', await mode(again));
  home = again;

  // ---- clicking Ask AI: first click picks the mode, an empty Ask AI click is then the chat button
  await inTab(home, "document.getElementById('mode-ask').click()");
  check('a first click on Ask AI picks the mode and stays on the page', (await mode(home)) === 'ask' && (await chatTabs()).length === 0, await mode(home));
  const before = await tabs();
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const index = before.findIndex((t) => t.id === home);
  await inTab(home, "document.getElementById('mode-ask').click()");
  const chat = await waitFor(async () => (await chatTabs())[0]);
  check('clicking Ask AI with an empty box opens the full-page chat', Boolean(chat), JSON.stringify(await tabs()));
  const after = await tabs();
  check('it is the same tab slot: the new-tab page is gone, the count and place are unchanged', !after.some((t) => t.id === home) && after.length === before.length && after.findIndex((t) => t.id === chat.id) === index, JSON.stringify({ before, after }));
  check('the chat is in front, no extra window, the address bar shows lumen://chat', (await activeId()) === chat.id && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === windowsBefore && (await waitFor(() => ui.evaluate(() => document.getElementById('address').value === 'lumen://chat'))), 'chat');
  check('nothing was asked: an empty click only opens the chat', (await prompts()).length === 0, JSON.stringify(await prompts()));
  home = await goHome(chat.id);
  check('Home goes back to the new-tab page in the remembered mode', (await mode(home)) === 'ask', await mode(home));

  // ---- Enter in Ask AI: the chat opens and the question is asked, once, in a fresh chat
  const chatsBefore = (await chatTabs()).length;
  await type(home, 'what is a good pasta recipe & why');
  await enter(home);
  const asked = await waitFor(async () => (await chatTabs())[0]);
  check('Enter in Ask AI turns this tab into the full-page chat', Boolean(asked) && !(await tabs()).some((t) => t.id === home) && chatsBefore === 0, JSON.stringify(await tabs()));
  const got = await waitFor(async () => { const p = await prompts(); return p.length ? p : null; });
  check('the question was sent to the AI, once, as typed', Array.isArray(got) && got.length === 1 && got[0].includes('what is a good pasta recipe & why'), JSON.stringify(got));
  const shown = await waitFor(async () => { const t = await inTab(asked.id, "[...document.querySelectorAll('#messages .msg.user')].map((m) => m.textContent.trim()).join('|')"); return t || null; });
  check('and shows as a message in the chat, not left in the composer', shown === 'what is a good pasta recipe & why' && (await inTab(asked.id, "document.getElementById('prompt').value")) === '', shown);
  check('the address carries nothing of it', (await tabs()).find((t) => t.id === asked.id).url.endsWith('chat-page.html'), JSON.stringify(await tabs()));
  await waitFor(async () => (await inTab(asked.id, "document.getElementById('send') && !document.getElementById('send').classList.contains('stop') ? 'idle' : 'busy'")) === 'idle', 10000);
  home = await goHome(asked.id);

  // ---- Ctrl+Enter asks the AI from Search mode too
  await key(home, '/', 'ctrlKey: true');
  check('(back in Search mode)', (await mode(home)) === 'search', await mode(home));
  await type(home, 'second question');
  await key(home, 'Enter', 'ctrlKey: true');
  const ctrlAsked = await waitFor(async () => (await chatTabs())[0]);
  const got2 = await waitFor(async () => { const p = await prompts(); return p.length > 1 ? p : null; });
  check('Ctrl+Enter in Search mode asks the AI in the chat', Boolean(ctrlAsked) && Array.isArray(got2) && got2.length === 2 && got2[1].includes('second question'), JSON.stringify(got2));
  check('...and did not search', (await app.evaluate(() => global.__navs)).length === 0, JSON.stringify(await app.evaluate(() => global.__navs)));
  await waitFor(async () => (await inTab(ctrlAsked.id, "document.getElementById('send') && !document.getElementById('send').classList.contains('stop') ? 'idle' : 'busy'")) === 'idle', 10000);
  home = await goHome(ctrlAsked.id);

  // ---- Ctrl+click on Ask AI: the chat opens in a new tab and the new-tab page stays
  const n0 = (await tabs()).length;
  await type(home, 'third question');
  await inTab(home, "document.getElementById('mode-ask').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))");
  const newChat = await waitFor(async () => (await chatTabs())[0]);
  const t1 = await tabs();
  check('Ctrl+click on Ask AI opens the chat in a new tab and leaves the new-tab page', Boolean(newChat) && t1.length === n0 + 1 && t1.some((t) => t.id === home), JSON.stringify(t1));
  const got3 = await waitFor(async () => { const p = await prompts(); return p.length > 2 ? p : null; });
  check('...with the typed question asked there', Array.isArray(got3) && got3.length === 3 && got3[2].includes('third question'), JSON.stringify(got3));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
