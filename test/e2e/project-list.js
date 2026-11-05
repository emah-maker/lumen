// [project list] lumen://chat's Projects block with many projects, in a real (invisible) window:
//  - past 6 projects a filter and a Recent / A–Z switch; 8 rows, then "Show N more" (and Show less);
//  - the filter narrows the list (name or goal line) and says when nothing matches; Escape clears it;
//  - A–Z sorts by name and is kept after a reload; Recent puts the project with the newest chat first;
//  - ⋯ → Pin to top puts a project first with a pin mark; Unpin takes it off;
//  - ⋯ → Archive takes it out of the list with Undo; "Archived (N)" lists it; Move out of archive brings it back;
//  - Move to project on a chat leaves archived projects out and has its own filter.
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-profile-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); });
    // Seed: 12 projects; "Kiwi" has the newest chat, "Fig" has a goal line about birds.
    const names = ['Apple', 'Banana', 'Cherry', 'Date', 'Elder', 'Fig', 'Grape', 'Honeydew', 'Ice plum', 'Jujube', 'Kiwi', 'Lime'];
    const seed = await app.evaluate((_e, list) => {
      const store = global.__chats.store();
      const ids = {};
      for (const name of list) ids[name] = store.saveProject({ name, ...(name === 'Fig' ? { description: 'A study of birds' } : {}) }).id;
      const chat = store.newId();
      store.save(chat, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'kiwi question' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
      store.setProject(chat, ids.Kiwi);
      const loose = store.newId();
      store.save(loose, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'loose chat' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
      return { ids, chat, loose };
    }, names);
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    const ready = () => waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false && (await inPage("document.querySelectorAll('#cp-projects .cp-pj-item').length")) > 0, 20000);
    await ready();
    const rows = () => inPage("[...document.querySelectorAll('#cp-projects .cp-pj-item .cp-pj-name')].map((n) => n.textContent)");
    const type = (sel, text) => inPage(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
    const menuOf = async (name, item) => {
      await inPage(`document.querySelector('#cp-projects .cp-pj-item[data-project="${seed.ids[name]}"] .cp-pj-more').click()`);
      await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-actions'))"));
      return inPage(`(() => { const b = [...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].find((x) => x.textContent === ${JSON.stringify(item)}); if (!b) return [...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].map((x) => x.textContent).join('|'); b.click(); return true; })()`);
    };

    // ======== compact list, filter, sort ========
    check('past 6 projects: a filter and a sort switch', (await inPage("Boolean(document.querySelector('#cp-projects .cp-pj-find')) && Boolean(document.querySelector('#cp-projects .cp-pj-sort'))")) === true);
    const first = await rows();
    check('8 rows, Recent first: the project with the newest chat leads', first.length === 8 && first[0] === 'Kiwi', JSON.stringify(first));
    check('...then "Show 4 more"', (await inPage("document.querySelector('#cp-projects .cp-pj-more-rows')?.textContent")) === 'Show 4 more');
    await inPage("document.querySelector('#cp-projects .cp-pj-more-rows').click()");
    check('Show 4 more opens All projects, with every project as a card', await waitFor(async () => (await inPage("document.querySelectorAll('#cp-projects-all .pja-card').length")) === 12, 15000), await inPage("document.querySelectorAll('#cp-projects-all .pja-card').length"));
    await inPage("document.querySelector('#cp-projects-all .pjp-back').click()");
    await waitFor(async () => (await inPage("Boolean(document.getElementById('cp-projects-all'))")) === false);
    await type('#cp-projects .cp-pj-find', 'birds');
    check('the filter matches the goal line', JSON.stringify(await rows()) === '["Fig"]', JSON.stringify(await rows()));
    check('...and keeps focus while typing', (await inPage("document.activeElement?.classList.contains('cp-pj-find')")) === true);
    await type('#cp-projects .cp-pj-find', 'zzz');
    check('nothing matches: says so', (await rows()).length === 0 && /No project matches/.test(await inPage("document.getElementById('cp-projects').textContent")));
    await inPage("document.querySelector('#cp-projects .cp-pj-find').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check('Escape clears the filter', (await rows()).length === 8 && (await inPage("document.querySelector('#cp-projects .cp-pj-find').value")) === '');
    await inPage("document.querySelector('#cp-projects .cp-pj-sort').click()");
    check('A–Z sorts by name', JSON.stringify((await rows()).slice(0, 3)) === '["Apple","Banana","Cherry"]' && (await inPage("document.querySelector('#cp-projects .cp-pj-sort').textContent")) === 'A–Z', JSON.stringify(await rows()));
    await inPage('location.reload()');
    await ready();
    check('...and is kept after a reload', JSON.stringify((await rows()).slice(0, 2)) === '["Apple","Banana"]', JSON.stringify(await rows()));

    // ======== pin ========
    check('⋯ → Pin to top', (await menuOf('Honeydew', 'Pin to top')) === true);
    check('the pinned project comes first with a pin mark, also in A–Z', await waitFor(async () => (await rows())[0] === 'Honeydew' && (await inPage(`Boolean(document.querySelector('#cp-projects .cp-pj-item[data-project="${seed.ids.Honeydew}"] .cp-pj-pinmark'))`)) === true), JSON.stringify(await rows()));
    check('main keeps the pin', (await app.evaluate((_e, id) => global.__chats.store().projects().find((p) => p.id === id).pinned, seed.ids.Honeydew)) === true);
    check('⋯ → Unpin', (await menuOf('Honeydew', 'Unpin')) === true && await waitFor(async () => (await rows())[0] === 'Apple'));

    // ======== archive ========
    check('⋯ → Archive', (await menuOf('Apple', 'Archive')) === true);
    check('the project leaves the list and an Undo shows', await waitFor(async () => !(await rows()).includes('Apple') && (await inPage("Boolean(document.querySelector('.chat-undo-toast button'))")) === true), JSON.stringify(await rows()));
    check('"Archived (1)" at the foot of the block', (await inPage("document.querySelector('#cp-projects .cp-pj-shelf')?.textContent")) === 'Archived (1)');
    await inPage("document.querySelector('.chat-undo-toast button').click()");
    check('Undo brings it back', await waitFor(async () => (await rows())[0] === 'Apple' && !(await inPage("Boolean(document.querySelector('#cp-projects .cp-pj-shelf'))"))));
    await menuOf('Apple', 'Archive');
    await waitFor(async () => !(await rows()).includes('Apple'));
    await inPage("document.querySelector('#cp-projects .cp-pj-shelf').click()");
    check('Archived (1) lists the archived project', await waitFor(async () => JSON.stringify(await rows()) === '["Apple"]' && /Archived projects/.test(await inPage("document.querySelector('#cp-projects .cp-pj-title').textContent"))), JSON.stringify(await rows()));
    check('its ⋯ menu offers Move out of archive (no Pin)', (await menuOf('Apple', 'Move out of archive')) === true);
    check('...which brings it back to the list', await waitFor(async () => (await rows()).includes('Apple') && (await rows()).length === 8), JSON.stringify(await rows()));

    // ======== Move to project ========
    await menuOf('Banana', 'Archive');
    await waitFor(async () => !(await rows()).includes('Banana'));
    await inPage(`(() => { const row = document.querySelector('#chat-list .chat-item[data-id="${seed.loose}"], .chat-item[data-id="${seed.loose}"]'); row.querySelector('.chat-project')?.click(); })()`);
    const picked = await waitFor(() => inPage("document.querySelector('.cp-pj-pick') ? [...document.querySelectorAll('.cp-pj-pick .cp-pj-pick-item')].map((b) => b.textContent) : null"));
    if (picked) {
      check('Move to project leaves the archived project out', !picked.includes('Banana') && picked.includes('Cherry'), JSON.stringify(picked));
      check('...and has a filter with many projects', (await inPage("Boolean(document.querySelector('.cp-pj-pick .cp-pj-pick-find'))")) === true);
      await type('.cp-pj-pick .cp-pj-pick-find', 'cher');
      check('the filter hides the others', JSON.stringify(await inPage("[...document.querySelectorAll('.cp-pj-pick .cp-pj-pick-item:not([hidden])')].map((b) => b.textContent).filter((t) => !/project/i.test(t))")) === '["Cherry"]');
      await inPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    } else check('Move to project opens from a chat row', false, await inPage("document.querySelector('.chat-item')?.outerHTML?.slice(0, 300)"));

    // ======== All projects ========
    await inPage("document.querySelector('#cp-projects .cp-pj-allbtn').click()");
    const all = (code) => inPage(`(() => { const r = document.getElementById('cp-projects-all'); ${code} })()`);
    check('the grid button opens All projects', await waitFor(async () => (await all('return r.querySelectorAll(".pja-card").length')) === 11, 15000), await all('return r ? r.innerText.slice(0, 300) : "none"'));
    await inPage(`window.assistant.chats.projectFlag('${seed.ids.Cherry}', 'pinned', true)`);
    await waitFor(() => all('return r.querySelectorAll(".pja-group-pinned .pja-card").length === 1'));
    const heads = await all('return [...r.querySelectorAll(".pja-group-h")].map((h) => h.textContent)');
    check('groups with counts: Pinned, Recent, and Archived folded', JSON.stringify(heads) === JSON.stringify(['Pinned1', 'Recent10', 'Archived (1)']), JSON.stringify(heads));
    check('...the archived one shows when its group is opened', (await all('r.querySelector(".pja-group-toggle").click(); return r.querySelectorAll(".pja-group-archived .pja-card").length')) === 1);
    const card = await all(`const c = r.querySelector('.pja-card[data-project="${seed.ids.Kiwi}"]'); return { name: c.querySelector('.pja-name').textContent, when: c.querySelector('.pja-when').textContent, counts: c.querySelector('.pja-counts').textContent, mark: c.querySelector('.pja-mark').textContent }`);
    check('a card: the mark, the name, when it was used and how many chats', card.name === 'Kiwi' && card.mark === 'K' && /Used today/.test(card.when) && /1 chat/.test(card.counts), JSON.stringify(card));
    await all('const f = r.querySelector(".pja-find"); f.value = "birds"; f.dispatchEvent(new Event("input"));');
    check('find narrows the cards (the goal line counts)', JSON.stringify(await all('return [...r.querySelectorAll(".pja-card .pja-name")].map((n) => n.textContent)')) === '["Fig"]');
    await all('const f = r.querySelector(".pja-find"); f.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));');
    await all('r.querySelector(".pja-view-btn[data-view=list]").click()');
    check('List shows rows instead of cards', (await all('return r.querySelectorAll(".pja-row").length > 0 && !r.querySelector(".pja-card")')) === true);
    await inPage('location.reload()');
    await ready();
    await inPage("document.querySelector('#cp-projects .cp-pj-allbtn').click()");
    check('...and is kept after a reload', await waitFor(() => all('return Boolean(r && r.querySelector(".pja-row")) && r.querySelector(".pja-view-btn[data-view=list]").getAttribute("aria-pressed") === "true"'), 15000));
    await all('r.querySelector(".pja-view-btn[data-view=grid]").click()');
    await all(`r.querySelector('.pja-card[data-project="${seed.ids.Date}"] .pja-more').click()`);
    const cardMenu = await waitFor(() => inPage("document.querySelector('.cp-pj-actions') ? [...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].map((b) => b.textContent) : null"));
    check('a card\'s ⋯ menu: Open project, Pin to top, Rename…, Archive', JSON.stringify(cardMenu) === JSON.stringify(['Open project', 'Pin to top', 'Rename…', 'Archive']), JSON.stringify(cardMenu));
    await inPage("[...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].find((b) => b.textContent === 'Pin to top').click()");
    check('Pin to top from a card moves it to Pinned', await waitFor(() => all(`return Boolean(r.querySelector('.pja-group-pinned .pja-card[data-project="${seed.ids.Date}"]'))`)));
    await all(`r.querySelector('.pja-card[data-project="${seed.ids.Kiwi}"] .pja-line, .pja-card[data-project="${seed.ids.Kiwi}"] .pja-foot').click()`);
    check('clicking a card opens its project', await waitFor(async () => (await inPage('window.chatProjectPage?.id()')) === seed.ids.Kiwi && (await inPage("Boolean(document.getElementById('cp-projects-all'))")) === false, 15000));
    // many projects: the cards come in chunks as the page scrolls
    await inPage("(async () => { for (let i = 0; i < 40; i++) await window.assistant.chats.saveProject({ name: 'Bulk project ' + String(i).padStart(2, '0'), folderMode: 'none' }); })()");
    await sleep(800);
    await inPage("document.querySelector('#cp-projects .cp-pj-allbtn').click()");
    await waitFor(() => all('return r && r.querySelectorAll(".pja-card").length > 0'), 15000);
    const firstChunk = await all('return r.querySelectorAll(".pja-group-recent .pja-card").length');
    check('with 50 recent projects the first chunk is 24 cards', firstChunk === 24, firstChunk);
    await all('r.scrollTop = r.scrollHeight;');
    check('...and the rest come as the page scrolls', await waitFor(async () => (await all('r.scrollTop = r.scrollHeight; return r.querySelectorAll(".pja-group-recent .pja-card").length')) >= 48, 10000), await all('return r.querySelectorAll(".pja-group-recent .pja-card").length'));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
