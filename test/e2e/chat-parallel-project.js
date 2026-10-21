// A new chat can be started, typed in and sent while another chat is running a reply, including a new chat inside a project
// (main.js chats:new-in-project, renderer/chat-page.js "New chat here"). Both chats work at once (the default has no cap);
// with a cap of 1 the new chat shows "Waiting for another chat to finish (1 running)" with a "Run now" button, and the view stays on it.
// Run in the full-page chat (lumen://chat) and in the sidebar. A fake slow model, invisible windows (LUMEN_TEST_BACKGROUND=1), no network.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-parallel-project-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    // A message with "slow" in it is held until release(n) (each slow reply has its own gate); any other answers at once.
    await app.evaluate(() => {
      const fake = global.__fake = { gates: [], asked: [] };
      global.__fakeRelease = () => { for (const g of fake.gates.splice(0)) g(); };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => {
        const first = params.messages.find((m) => m.role === 'user');
        const asked = JSON.stringify(first?.content || '');
        fake.asked.push(asked);
        const slow = /slow/.test(asked);
        const text = slow ? 'Slow reply done.' : 'Quick reply done.';
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 5) } };
            if (slow) await Promise.race([new Promise((r) => fake.gates.push(r)), new Promise((_, rej) => opts?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }))))]);
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(5) } };
          },
          finalMessage: async () => message,
        };
      } } } });
    });
    const release = () => app.evaluate(() => global.__fakeRelease());
    const live = () => app.evaluate(() => global.__tabChats.runs().filter((r) => r.live).length);
    const queued = () => app.evaluate(() => global.__tabChats.runs().filter((r) => r.queued).length);
    const idle = () => waitFor(async () => (await live()) === 0, 10000);
    const saveChat = (title, project) => app.evaluate((_e, a) => {
      const store = global.__chats.store();
      const id = store.newId();
      store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: a.title }] }, { role: 'assistant', content: [{ type: 'text', text: `${a.title} answer` }] }] });
      if (a.project) store.setProject(id, a.project);
      return id;
    }, { title, project });
    const project = await app.evaluate(() => global.__chats.store().saveProject({ name: 'Zoo', instructions: 'Talk about animals.' }).id);
    const oldInProject = await saveChat('old zoo chat', project);

    // ======== the full-page chat ========
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const send = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    const pageText = () => inPage("document.getElementById('messages').textContent");
    const newChatHere = async () => {
      await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj'))"));
      await inPage("(() => { const row = document.querySelector('.cp-pj'); if (!row.classList.contains('on')) row.click(); })()");
      await waitFor(() => inPage("Boolean([...document.querySelectorAll('.cp-pj-act')].find((b) => /New chat/.test(b.textContent)))"));
      await inPage("[...document.querySelectorAll('.cp-pj-act')].find((b) => /New chat/.test(b.textContent)).click()");
    };

    await send('slow question in chat A');
    check('page: chat A is working', await waitFor(async () => (await live()) === 1), await live());
    check('page: its composer shows Stop', await inPage("document.getElementById('send').classList.contains('stop')"), 'no stop');
    const chatA = await app.evaluate(() => global.__tabChats.chatId());

    await newChatHere();
    check('page: "New chat here" while A runs starts an empty new chat in front', await waitFor(async () => (await app.evaluate(() => global.__tabChats.chatId())) !== chatA && !/chat A/.test(await pageText())), `${await app.evaluate(() => global.__tabChats.chatId())} ${await pageText()}`);
    const chatB = await app.evaluate(() => global.__tabChats.chatId());
    check('page: the new chat is in the project (its instructions will apply)', await app.evaluate((_e, a) => global.__chats.store().projects().some((p) => p.id === a), project), 'no project');
    check('page: the composer is not in the Stop state and is usable', (await inPage("!document.getElementById('send').classList.contains('stop') && !document.getElementById('prompt').disabled")) === true, await inPage("document.getElementById('send').className"));
    check('page: chat A keeps working', (await live()) === 1, await live());
    await send('quick question in chat B');
    check('page: the message in the new chat is answered while A still works', await waitFor(async () => /Quick reply done/.test(await pageText())), await pageText());
    check('page: ...A did not finish meanwhile, and the view is still on B', (await live()) === 1 && (await app.evaluate(() => global.__tabChats.chatId())) === chatB, `${await live()}`);
    check('page: B was saved into the project', await waitFor(() => app.evaluate((_e, a) => { const s = global.__chats.store(); return s.list().some((c) => c.project === a.project && c.id === a.id); }, { project, id: chatB })), 'not in project');

    // Opening an existing chat of the project while A runs.
    await inPage(`document.querySelector('#cp-items .chat-item[data-id="${oldInProject}"] .chat-open')?.click()`);
    check('page: an existing project chat opens while A runs', await waitFor(async () => /old zoo chat answer/.test(await pageText())), await pageText());
    await send('quick follow-up in the old chat');
    check('page: and can be sent in', await waitFor(async () => /Quick reply done/.test(await pageText())) && (await live()) === 1, await pageText());
    await release();
    await idle();

    // With a cap of one: the new chat waits, says so, and "Run now" starts it.
    await app.evaluate(() => global.__settings.backend.set('maxChatRuns', 1));
    await inPage("document.getElementById('new-chat').click()");
    await send('slow question in chat C');
    check('page (cap 1): chat C holds the one slot', await waitFor(async () => (await live()) === 1), await live());
    await newChatHere();
    await waitFor(async () => !/chat C/.test(await pageText()));
    await send('quick question in chat D');
    check('page (cap 1): chat D waits, and the view stays on it', await waitFor(async () => (await queued()) === 1), `${await queued()} ${await pageText()}`);
    const waitingLine = await waitFor(() => inPage("document.querySelector('.working')?.dataset.status || ''"));
    check('page (cap 1): it says "Waiting for another chat to finish (1 running)"', /Waiting for another chat to finish \(1 running\)/.test(waitingLine || ''), waitingLine);
    check('page (cap 1): ...with a Run now button', await inPage("Boolean([...document.querySelectorAll('.run-now, .working button')].find((b) => /Run now/.test(b.textContent)))"), await inPage("document.getElementById('messages').innerHTML.slice(-600)"));
    await inPage("[...document.querySelectorAll('.run-now, .working button')].find((b) => /Run now/.test(b.textContent)).click()");
    check('page (cap 1): Run now starts it beside C, and it is answered', await waitFor(async () => /Quick reply done/.test(await pageText())) && (await live()) === 1 && (await queued()) === 0, `${await live()} ${await queued()}`);
    await release();
    await idle();
    await app.evaluate(() => global.__settings.backend.set('maxChatRuns', 0));

    // ======== the sidebar ========
    await app.evaluate(() => { const t = global.__chatPage.tabs().find((x) => x.chat); if (t) global.__chatPage.contents(t.id).close?.(); });
    await ui.evaluate(() => { const b = document.getElementById('toggle-sidebar'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); });
    await waitFor(() => ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true' && !document.body.classList.contains('sidebar-moving')));
    const sendSide = (text) => ui.evaluate((v) => { const p = document.getElementById('prompt'); p.value = v; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); }, text);
    const sideText = () => ui.evaluate(() => document.getElementById('messages').textContent);
    await ui.evaluate(() => document.getElementById('new-chat').click());
    await sendSide('slow question in chat E');
    check('sidebar: chat E is working', await waitFor(async () => (await live()) === 1), await live());
    const chatE = await app.evaluate(() => global.__tabChats.chatId());
    await ui.evaluate(() => document.getElementById('new-chat').click());
    check('sidebar: New chat while E runs shows an empty chat and a usable composer', await waitFor(async () => (await app.evaluate(() => global.__tabChats.chatId())) !== chatE && !/chat E/.test(await sideText())) && (await ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && !document.getElementById('prompt').disabled)), await sideText());
    await sendSide('quick question in the sidebar');
    check('sidebar: the new chat is answered while E still works', await waitFor(async () => /Quick reply done/.test(await sideText())) && (await live()) === 1, `${await live()} ${await sideText()}`);
    // An existing chat of a project, opened from the sidebar's history list.
    await ui.evaluate(() => document.getElementById('chat-history').click());
    await waitFor(() => ui.evaluate((id) => Boolean(document.querySelector(`#chat-list .chat-item[data-id="${id}"] .chat-open`)), oldInProject));
    await ui.evaluate((id) => document.querySelector(`#chat-list .chat-item[data-id="${id}"] .chat-open`).click(), oldInProject);
    check('sidebar: an existing project chat opens while E runs', await waitFor(async () => /old zoo chat answer/.test(await sideText())), await sideText());
    await sendSide('quick follow-up from the sidebar');
    check('sidebar: and can be sent in', await waitFor(async () => /Quick reply done/.test(await sideText())) && (await live()) === 1, await sideText());
    await release();
    await idle();

    check('no page errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
