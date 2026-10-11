// lumen://chat extras (renderer/chat-page-tools.js, chat-projects.js, main.js chats:temporary / chats:project-* / chats:markdown):
// the title edited in the header, a temporary chat (never saved), Projects (a chat moved in, its instructions reaching the AI), read
// aloud, retry with another model, Stop then Edit message, a search hit opening at its message, Copy as Markdown and a PDF.
// A fake Claude client (no network, no key) drives it; the window is hidden (LUMEN_TEST_BACKGROUND). Screenshots go to
// LUMEN_SHOTS (a folder) when it is set, light and dark.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chatf2-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    global.__settings.backend.set('sidebarNewChat', false);
    const fake = global.__fake = { n: 0, gate: null, systems: [], models: [] };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => {
      const text = `Reply ${++fake.n}. The quick brown fox jumps over the lazy dog.`;
      fake.systems.push(typeof params.system === 'string' ? params.system : (params.system || []).map((s) => s.text).join('\n'));
      fake.models.push(params.model);
      const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 } };
      return {
        async *[Symbol.asyncIterator]() {
          if (fake.gate) await Promise.race([fake.gate, new Promise((_, reject) => opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }))))]); // (Stop reaches a held reply)
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });

  await app.evaluate(() => global.__chatPage.open());
  const tab = await waitFor(() => app.evaluate(() => global.__chatPage.tabs().find((t) => t.chat && /chat-page\.html$/.test(t.url))));
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  check('the chat page opens', Boolean(tab), 'no chat tab');
  await waitFor(async () => (await inPage("document.body.classList.contains('cp-booting')")) === false);
  const send = async (text) => {
    const had = await inPage("document.querySelectorAll('.msg.assistant .reply-copy').length");
    await inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    await waitFor(async () => (await inPage("document.querySelectorAll('.msg.assistant .reply-copy').length")) > had && !(await inPage("document.getElementById('send').classList.contains('stop')")));
  };
  const replies = () => inPage("document.querySelectorAll('.msg.assistant .reply-copy').length");
  const chatList = () => app.evaluate(() => global.__chats.store().list().map((c) => ({ id: c.id, title: c.title, project: c.project })));
  const shot = async (name) => {
    const dir = process.env.LUMEN_SHOTS;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const png = await app.evaluate(async () => { const t = global.__chatPage.tabs().find((x) => x.chat); return (await global.__chatPage.contents(t.id).capturePage()).toPNG().toString('base64'); });
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(png, 'base64'));
  };
  const scheme = (value) => app.evaluate(async (_e, v) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    const wc = global.__chatPage.contents(t.id);
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
  }, value);

  // ---- a first chat
  await send('Tell me about foxes');
  check('a reply arrives on the page', (await replies()) === 1, await replies());
  await waitFor(async () => (await chatList()).length === 1);
  const first = (await chatList())[0];

  // ---- 1. the title in the header, edited in place
  check('the header shows the chat title', await waitFor(async () => (await inPage("document.getElementById('cp-title').textContent")) === first.title), await inPage("document.getElementById('cp-title').textContent"));
  await inPage("document.getElementById('cp-title').click()");
  check('a click turns the title into a text box', await inPage("Boolean(document.querySelector('.cp-title-input')) && document.activeElement.classList.contains('cp-title-input')"), 'no input');
  await inPage(`(() => { const i = document.querySelector('.cp-title-input'); i.value = 'Fox facts'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('Enter renames the chat (saved, and in the list)', await waitFor(async () => (await chatList())[0].title === 'Fox facts' && (await inPage("document.querySelector('#cp-items .chat-title')?.textContent")) === 'Fox facts'), JSON.stringify(await chatList()));
  await inPage("document.getElementById('cp-title').click()");
  await inPage(`(() => { const i = document.querySelector('.cp-title-input'); i.value = 'Nope'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  check('Escape leaves the title as it was', (await chatList())[0].title === 'Fox facts' && (await inPage("document.getElementById('cp-title').textContent")) === 'Fox facts' && !(await inPage("Boolean(document.querySelector('.cp-title-input'))")), await inPage("document.getElementById('cp-title').textContent"));

  // ---- 2. read aloud
  check('a finished reply has a Read aloud button', await inPage("Boolean(document.querySelector('.msg.assistant .reply-meta .reply-speak'))"), 'none');
  await inPage("window.__spoken = []; speechSynthesis.speak = (u) => { window.__spoken.push(u.text); }; speechSynthesis.cancel = () => {}; document.querySelector('.reply-speak').click()");
  const spoken = await inPage('window.__spoken');
  check('it reads the reply text, without the buttons around it', Array.isArray(spoken) && /quick brown fox/.test(spoken.join(' ')) && !/Read aloud|Copy/.test(spoken.join(' ')), JSON.stringify(spoken));
  check('while reading it shows Stop reading', (await inPage("document.querySelector('.reply-speak').getAttribute('aria-pressed')")) === 'true');
  await inPage("document.querySelector('.reply-speak').click()");
  check('a second click stops it', (await inPage("document.querySelector('.reply-speak').getAttribute('aria-pressed')")) === 'false');

  // ---- 3. retry with another model
  check('the latest reply has Retry with another model', await inPage("Boolean(document.querySelector('.reply-regen + .reply-retry'))"), 'none');
  await inPage("document.querySelector('.reply-retry').click()");
  const items = await inPage("[...document.querySelectorAll('.cp-retry-menu .cp-retry-item')].map((b) => b.textContent)");
  check('it lists the other models', Array.isArray(items) && items.length > 0, JSON.stringify(items));
  const before = await app.evaluate(() => global.__fake.n);
  const modelBefore = await inPage("document.getElementById('model').value");
  await inPage("document.querySelector('.cp-retry-menu .cp-retry-item').click()");
  check('choosing one asks again, on that model', await waitFor(async () => (await app.evaluate(() => global.__fake.n)) === before + 1) && (await app.evaluate(() => global.__fake.models.at(-1))) !== modelBefore, JSON.stringify(await app.evaluate(() => global.__fake.models)));
  await waitFor(async () => !(await inPage("document.getElementById('send').classList.contains('stop')")));
  check('the answer is the new reply, with a version switch back', (await replies()) === 1 && /Reply 2\./.test(await inPage("document.getElementById('messages').textContent")), await inPage("document.getElementById('messages').textContent"));

  // ---- 4. a model switched by hand shows a divider
  await app.evaluate(() => { const t = global.__chatPage.tabs().find((x) => x.chat); return global.__chatPage.contents(t.id).executeJavaScript(`(async () => { const s = document.getElementById('model'); const other = [...s.options].find((o) => o.value && o.value !== s.value && !o.value.endsWith(':__more')); s.value = other.value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`, true); });
  check('switching the model mid-chat leaves a "Switched to" divider', await waitFor(() => inPage("Boolean(document.querySelector('.notice.model-switch'))")), await inPage("document.getElementById('messages').textContent"));

  // ---- 5. Projects
  await inPage("document.querySelector('.cp-pj-add').click()");
  check('the + opens the project editor', await inPage("Boolean(document.querySelector('.cp-pj-dialog .cp-pj-input'))"), 'no dialog');
  await shot('projects-editor-light');
  await inPage(`(() => { document.querySelector('.cp-pj-input').value = 'Zoology'; document.querySelector('.cp-pj-text').value = 'Always answer in exactly one word per sentence.'; document.querySelector('.cp-pj-box').requestSubmit(); })()`);
  check('saving makes the project (and shows it in the rail)', await waitFor(async () => (await app.evaluate(() => global.__chats.store().projects().map((p) => p.name))).join() === 'Zoology' && (await inPage("document.querySelector('.cp-pj .cp-pj-name')?.textContent")) === 'Zoology'), await inPage("document.getElementById('cp-projects').textContent"));
  check('a project made with + opens its (empty) list', await inPage("document.querySelector('.cp-pj.on .cp-pj-name')?.textContent") === 'Zoology' && (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 0, '');
  await inPage("document.querySelector('.cp-pj.on').click()"); // back to all chats
  await waitFor(async () => (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 1);
  // Move the chat in from its row menu.
  await inPage("document.querySelector('#cp-items .chat-item .chat-more').click()");
  await inPage("document.querySelector('#cp-items .chat-item .chat-project').click()");
  check('"Move to project" lists the projects', await waitFor(() => inPage("[...document.querySelectorAll('.cp-pj-pick .cp-pj-pick-item')].some((b) => b.textContent === 'Zoology')")), await inPage("document.body.innerHTML.includes('cp-pj-pick')"));
  await inPage("[...document.querySelectorAll('.cp-pj-pick .cp-pj-pick-item')].find((b) => b.textContent === 'Zoology').click()");
  check('the chat is now in the project', await waitFor(async () => (await chatList())[0].project === (await app.evaluate(() => global.__chats.store().projects()[0].id))), JSON.stringify(await chatList()));
  check('the rail counts it', await waitFor(async () => (await inPage("document.querySelector('.cp-pj .cp-pj-count')?.textContent")) === '1'), await inPage("document.getElementById('cp-projects').textContent"));
  // The AI gets the instructions on the chat's next message.
  const systemsBefore = await app.evaluate(() => global.__fake.systems.length);
  await send('And what do they eat?');
  await waitFor(async () => (await app.evaluate(() => global.__fake.systems.length)) > systemsBefore);
  const sys = await app.evaluate(() => global.__fake.systems.at(-1));
  check('the project\'s instructions reach the AI for that chat', /<project_instructions>/.test(sys) && /exactly one word per sentence/.test(sys), sys.slice(-400));
  // A new chat started in the project gets them from its first message and is recorded in it.
  await inPage("document.querySelector('.cp-pj.on, .cp-pj').click()");
  await inPage("[...document.querySelectorAll('.cp-pj-act')].find((b) => /New chat/.test(b.textContent)).click()");
  await waitFor(async () => (await inPage("document.querySelectorAll('.msg').length")) === 0);
  await send('A fresh question');
  const n2 = await app.evaluate(() => global.__fake.systems.length);
  check('a new chat in the project has the instructions at once', /exactly one word per sentence/.test(await app.evaluate(() => global.__fake.systems.at(-1))), n2);
  check('and is saved in the project', await waitFor(async () => (await chatList()).filter((c) => c.project).length === 2), JSON.stringify(await chatList()));
  check('the project\'s view lists only its chats', (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 2);
  // A chat outside the project gets none.
  await inPage("document.querySelector('.cp-pj.on').click()"); // back to all chats
  await inPage("document.getElementById('new-chat').click()");
  await waitFor(async () => (await inPage("document.querySelectorAll('.msg').length")) === 0);
  await send('Unrelated');
  check('a chat outside any project has no project instructions', !/project_instructions/.test(await app.evaluate(() => global.__fake.systems.at(-1))), '');
  const outsider = (await chatList()).find((c) => !c.project);
  // Delete the project: chats stay.
  await inPage("document.querySelector('.cp-pj').click()");
  await inPage("[...document.querySelectorAll('.cp-pj-act')].find((b) => /instructions|Instructions/i.test(b.textContent)).click()");
  await inPage("document.querySelector('.cp-pj-delete').click(); document.querySelector('.cp-pj-delete').click();");
  check('deleting the project keeps its chats, now outside any project', await waitFor(async () => { const l = await chatList(); return l.length === 3 && l.every((c) => !c.project) && (await app.evaluate(() => global.__chats.store().projects().length)) === 0; }), JSON.stringify(await chatList()));
  check('the outsider is untouched', (await chatList()).some((c) => c.id === outsider.id));

  // ---- 6. temporary chat
  const listBefore = (await chatList()).length;
  const filesBefore = await app.evaluate(() => global.__chatFiles());
  await inPage("document.getElementById('cp-more').click(); document.getElementById('cp-temp').click()");
  check('Temporary chat starts an empty chat with a badge and a note', await waitFor(() => inPage("!document.getElementById('cp-temp-badge').hidden && !document.getElementById('cp-temp-note').hidden && document.body.classList.contains('cp-temporary')")), 'no badge');
  check('the header says so', (await inPage("document.getElementById('cp-title').textContent")) === 'Temporary chat');
  await send('A secret question');
  await shot('temporary-light');
  check('it answers like any chat', (await replies()) === 1);
  await sleep(1800); // (the save that would have followed the reply)
  check('nothing is saved: not listed, no file written', (await chatList()).length === listBefore && (await app.evaluate(() => global.__chatFiles())) === filesBefore && !(await inPage("document.getElementById('cp-items').textContent.includes('secret')")), JSON.stringify(await chatList()));
  await inPage("document.getElementById('new-chat').click()");
  check('New chat leaves it: the badge goes', await waitFor(() => inPage("document.getElementById('cp-temp-badge').hidden && !document.body.classList.contains('cp-temporary')")), 'badge still shown');
  await send('A normal one');
  check('a chat after it is saved as usual', await waitFor(async () => (await chatList()).length === listBefore + 1), JSON.stringify(await chatList()));

  // ---- 7. Stop, then Edit message
  await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'a question I mistyped'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await waitFor(() => inPage("document.getElementById('send').classList.contains('stop')"));
  await inPage("document.getElementById('send').click()");
  await waitFor(() => inPage("Boolean(document.querySelector('.notice.stopped'))"));
  await app.evaluate(() => global.__fake.release());
  check('after Stop with no answer there is an Edit message button', await waitFor(() => inPage("Boolean(document.querySelector('.notice.stopped .notice-edit'))")), await inPage("document.getElementById('messages').innerHTML.slice(-600)"));
  await shot('stop-edit-light');
  await inPage("document.querySelector('.notice-edit').click()");
  check('it puts the message back in the box and takes it off the page', await waitFor(async () => (await inPage("document.getElementById('prompt').value")) === 'a question I mistyped' && !/mistyped/.test(await inPage("document.getElementById('messages').textContent"))), `${await inPage("document.getElementById('prompt').value")} | ${await inPage("document.getElementById('messages').textContent")}`);
  await app.evaluate(() => { global.__fake.gate = null; });

  // ---- 8. a search hit opens at its message
  await inPage("document.getElementById('prompt').value = ''; document.getElementById('prompt').dispatchEvent(new Event('input'))");
  await inPage("document.getElementById('new-chat').click()");
  await send('Marker one: alpha');
  for (let i = 0; i < 6; i++) await send(`Filler question ${i}`);
  await send('The word zyzzyva is rare');
  await inPage("document.getElementById('new-chat').click()");
  await waitFor(async () => (await inPage("document.querySelectorAll('.msg').length")) === 0);
  await inPage(`(() => { const s = document.querySelector('.chat-search'); s.value = 'zyzzyva'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(() => inPage("document.querySelectorAll('#cp-items .chat-item').length === 1"));
  await inPage("document.querySelector('#cp-items .chat-item .chat-open').click()");
  check('opening a hit highlights the matching message', await waitFor(() => inPage("Boolean(document.querySelector('.msg.cp-hit mark.cp-hit-word'))")), await inPage("document.getElementById('messages').textContent.slice(0, 200)"));
  check('the highlighted message is the one with the word', /zyzzyva/.test(await inPage("document.querySelector('.msg.cp-hit').textContent")));
  check('and it is scrolled into view', await waitFor(() => inPage("(() => { const r = document.querySelector('.msg.cp-hit').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()")), 'off screen');

  // ---- 9. Copy as Markdown and a PDF
  const id = await app.evaluate(() => global.__chats.id());
  const md = await inPage(`window.assistant.chats.markdown(${JSON.stringify(id)})`);
  check('the chat comes as Markdown with both sides', md?.ok && /## You/.test(md.markdown) && /zyzzyva/.test(md.markdown) && /## Assistant/.test(md.markdown), JSON.stringify(md).slice(0, 200));
  const pdf = await app.evaluate(async (_e, i) => { const buf = await global.__chatPdf(i); return buf ? { head: buf.subarray(0, 5).toString(), size: buf.length } : null; }, id);
  check('and as a PDF', pdf?.head === '%PDF-' && pdf.size > 1000, JSON.stringify(pdf));
  await inPage("navigator.clipboard.writeText = async (t) => { window.__copied = t; }; document.getElementById('cp-more').click(); document.getElementById('cp-copy-md').click()");
  check('the menu\'s Copy chat as Markdown puts it on the clipboard', await waitFor(async () => /zyzzyva/.test((await inPage('window.__copied')) || '')), await inPage('window.__copied'));

  // ---- screenshots, light and dark
  await shot('chat-light');
  await scheme('dark');
  await sleep(300);
  await shot('chat-dark');
  await inPage("document.querySelector('.cp-pj-add')?.click()");
  await sleep(200);
  await shot('projects-editor-dark');
  await inPage("document.querySelector('.cp-pj-dialog')?.remove()");
  await scheme('light');

  check('no page errors in the sidebar', errors.length === 0, errors.join(' | '));
  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
