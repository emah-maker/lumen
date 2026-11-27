// A project's chats are listed under the project, not in the dated chat list (Today / Yesterday / ...), in lumen://chat's rail and in
// the browser sidebar's history panel (renderer/chat-items.js pick({ folded }), chat-projects.js, sidebar-projects.js). Covers: a project
// chat left out of the dated list and shown under its project; a chat of an archived project staying in the list; search still finding a
// project chat (by title); opening a project chat opening its project in the rail; a working chat marking its project's row, also with the
// project shut. A fake slow model, invisible windows (LUMEN_TEST_BACKGROUND=1), a temp profile, no network.
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-fold-'));
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
    await app.evaluate(() => {
      const fake = global.__fake = { gates: [] };
      global.__fakeRelease = () => { for (const g of fake.gates.splice(0)) g(); };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => {
        const asked = JSON.stringify(params.messages.filter((m) => m.role === 'user').at(-1)?.content || '');
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

    // Seed: a loose chat, a chat in "Coop" (a project), a chat in "Old" (an archived project). All from today.
    const seed = await app.evaluate(() => {
      const store = global.__chats.store();
      const make = (title) => { const id = store.newId(); store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: title }] }, { role: 'assistant', content: [{ type: 'text', text: `${title} answer` }] }] }); return id; };
      const loose = make('loose topic');
      const inCoop = make('about you setup');
      const inOld = make('old project topic');
      const coop = store.saveProject({ name: 'Coop' }).id;
      const old = store.saveProject({ name: 'Old' }).id;
      store.setProject(inCoop, coop);
      store.setProject(inOld, old);
      store.setProjectFlag(old, 'archived', true);
      return { loose, inCoop, inOld, coop, old };
    });
    const oldArchived = await app.evaluate((_e, id) => Boolean(global.__chats.store().projects().find((p) => p.id === id)?.archived), seed.old);

    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    await waitFor(() => app.evaluate(() => global.__chatPage.tabs().find((t) => t.chat)?.id));
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false && (await inPage("document.querySelectorAll('#cp-projects .cp-pj-item').length")) > 0, 20000);
    const dated = () => inPage("[...document.querySelectorAll('#cp-items .chat-item')].map((r) => r.dataset.id)");
    const pjItem = (id) => `#cp-projects .cp-pj-item[data-project="${id}"]`;
    const underProject = (pid) => inPage(`[...document.querySelectorAll('#cp-projects .cp-pj-chats[data-project="${pid}"] .cp-pj-chat')].map((b) => b.dataset.id)`);

    // ======== lumen://chat ========
    check('the loose chat is in the dated list', await waitFor(async () => (await dated()).includes(seed.loose)), JSON.stringify(await dated()));
    const list = await dated();
    check('a project chat is not in the dated list', !list.includes(seed.inCoop), JSON.stringify(list));
    check('the dated list still has its Today heading for the loose chat', /Today/.test(await inPage("document.getElementById('cp-items').textContent")), await inPage("document.getElementById('cp-items').textContent"));
    if (oldArchived) check('a chat of an archived project stays in the dated list', list.includes(seed.inOld), JSON.stringify(list));
    else check('the archived project was set up', false, 'no archive call on the store');
    check('the project row counts its chat', (await inPage(`document.querySelector('${pjItem(seed.coop)} .cp-pj-count')?.textContent`)) === '1', await inPage("document.getElementById('cp-projects').textContent"));
    if ((await inPage(`document.querySelector('${pjItem(seed.coop)}').classList.contains('open')`)) !== true) await inPage(`document.querySelector('${pjItem(seed.coop)} .cp-pj-chev').click()`);
    check('expanding the project lists the chat under it', await waitFor(async () => (await underProject(seed.coop)).includes(seed.inCoop)), JSON.stringify(await underProject(seed.coop)));

    // search still finds the project chat
    await inPage("(() => { const b = document.querySelector('#cp-rail .chat-search, .chat-search'); b.value = 'about you'; b.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check('search finds the project chat', await waitFor(async () => { const d = await dated(); return d.includes(seed.inCoop) && !d.includes(seed.loose); }), JSON.stringify(await dated()));
    await inPage("(() => { const b = document.querySelector('#cp-rail .chat-search, .chat-search'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check('clearing the search folds it back under the project', await waitFor(async () => { const d = await dated(); return d.includes(seed.loose) && !d.includes(seed.inCoop); }), JSON.stringify(await dated()));

    // shut the project, then open its chat from search: the project opens in the rail with the chat marked as the one on show
    await inPage(`document.querySelector('${pjItem(seed.coop)} .cp-pj-chev').click()`);
    check('the project shuts', await waitFor(async () => (await inPage(`document.querySelector('${pjItem(seed.coop)}').classList.contains('open')`)) === false), '');
    await inPage("(() => { const b = document.querySelector('.chat-search'); b.value = 'about you'; b.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await waitFor(async () => (await dated()).includes(seed.inCoop));
    await inPage(`document.querySelector('#cp-items .chat-item[data-id="${seed.inCoop}"] .chat-open').click()`);
    await waitFor(async () => /about you setup answer/.test(await inPage("document.getElementById('messages').textContent")));
    await inPage("(() => { const b = document.querySelector('.chat-search'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check('opening a project chat opens its project in the rail', await waitFor(async () => (await inPage(`document.querySelector('${pjItem(seed.coop)}').classList.contains('open')`)) === true), await inPage("document.getElementById('cp-projects').innerHTML.slice(0, 400)"));
    check('...with that chat marked as the one on show', await waitFor(() => inPage(`document.querySelector('#cp-projects .cp-pj-chat[data-id="${seed.inCoop}"]')?.classList.contains('current')`)), await inPage("document.getElementById('cp-projects').innerHTML.slice(0, 400)"));

    // a working chat marks its project's row, also with the project shut
    await sleep(600);
    await inPage("(() => { const p = document.getElementById('prompt'); p.value = 'slow please'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()");
    check('a working chat shows a mark on its project row', await waitFor(() => inPage(`Boolean(document.querySelector('${pjItem(seed.coop)} .cp-pj .cp-pj-live.running'))`), 15000), await inPage(`document.querySelector('${pjItem(seed.coop)}')?.outerHTML.slice(0, 600)`));
    check('...and on its row under the project', (await inPage(`Boolean(document.querySelector('#cp-projects .cp-pj-chat[data-id="${seed.inCoop}"] .cp-pj-live'))`)) === true, '');
    check('...the mark is named for screen readers', (await inPage(`document.querySelector('${pjItem(seed.coop)} .cp-pj-live')?.getAttribute('aria-label')`)) === 'Working', '');
    check('...while working it is still not in the dated list', !(await dated()).includes(seed.inCoop), JSON.stringify(await dated()));
    await inPage(`document.querySelector('${pjItem(seed.coop)} .cp-pj-chev').click()`);
    check('...the mark stays with the project shut', await waitFor(async () => (await inPage(`document.querySelector('${pjItem(seed.coop)}').classList.contains('open')`)) === false) && (await inPage(`Boolean(document.querySelector('${pjItem(seed.coop)} .cp-pj-live'))`)) === true, '');
    if (process.env.LUMEN_SHOTS) {
      fs.mkdirSync(process.env.LUMEN_SHOTS, { recursive: true });
      const png = await app.evaluate(async () => { const t = global.__chatPage.tabs().find((x) => x.chat); return (await global.__chatPage.contents(t.id).capturePage()).toPNG().toString('base64'); });
      fs.writeFileSync(path.join(process.env.LUMEN_SHOTS, 'project-working-mark.png'), Buffer.from(png, 'base64'));
    }
    await app.evaluate(() => global.__fakeRelease());
    check('the mark goes when the reply is done', await waitFor(async () => (await inPage(`Boolean(document.querySelector('${pjItem(seed.coop)} .cp-pj-live'))`)) === false, 15000), await inPage(`document.querySelector('${pjItem(seed.coop)}')?.outerHTML.slice(0, 400)`));

    // ======== the browser sidebar's history panel ========
    await ui.evaluate(() => document.getElementById('chat-history').click());
    const sideIds = () => ui.evaluate(() => [...document.querySelectorAll('#chat-list .chat-items .chat-item')].map((r) => r.dataset.id));
    check('sidebar: the loose chat is in the dated list', await waitFor(async () => (await sideIds()).includes(seed.loose), 10000), JSON.stringify(await sideIds()));
    check('sidebar: the project chat is not in the dated list', !(await sideIds()).includes(seed.inCoop), JSON.stringify(await sideIds()));
    check('sidebar: the Projects block lists the project', await waitFor(() => ui.evaluate((id) => Boolean(document.querySelector(`#chat-list .cp-pj-item[data-project="${id}"]`)), seed.coop)), await ui.evaluate(() => document.getElementById('chat-list').textContent.slice(0, 300)));
    const sideOpen = () => ui.evaluate((id) => document.querySelector(`#chat-list .cp-pj-item[data-project="${id}"]`)?.classList.contains('open'), seed.coop);
    if (!(await sideOpen())) await ui.evaluate((id) => document.querySelector(`#chat-list .cp-pj-item[data-project="${id}"] .cp-pj-chev`).click(), seed.coop);
    check('sidebar: expanding the project lists the chat under it', await waitFor(() => ui.evaluate((a) => Boolean(document.querySelector(`#chat-list .cp-pj-chats[data-project="${a.coop}"] .cp-pj-chat[data-id="${a.inCoop}"]`)), seed)), await ui.evaluate(() => document.getElementById('chat-list').innerHTML.slice(0, 500)));
    await ui.evaluate(() => { const b = document.querySelector('#chat-list .chat-search'); b.value = 'about you'; b.dispatchEvent(new Event('input', { bubbles: true })); });
    check('sidebar: search finds the project chat', await waitFor(async () => { const d = await sideIds(); return d.includes(seed.inCoop) && !d.includes(seed.loose); }), JSON.stringify(await sideIds()));
    await ui.evaluate(() => { const b = document.querySelector('#chat-list .chat-search'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); });
    check('sidebar: clearing the search folds it back', await waitFor(async () => { const d = await sideIds(); return d.includes(seed.loose) && !d.includes(seed.inCoop); }), JSON.stringify(await sideIds()));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failures++;
    console.log('FAIL  crashed:', e?.stack || e);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* left for the tmp sweep */ }
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll project-fold checks passed');
  process.exit(failures ? 1 : 0);
})();
