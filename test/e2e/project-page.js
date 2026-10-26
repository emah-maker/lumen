// [project page] The Projects block of lumen://chat's rail and a project's own page, in a real (invisible) window with a fake model:
//  - a project is one row (no row of grey buttons under it): its name opens the project page, a + starts a chat in it and a ⋯ menu
//    (Open project, New chat here, Instructions, Rename and folder) shows on hover or focus; every button has a name; the menu is
//    keyboard-driven (arrows, Escape gives focus back);
//  - the page: the name (editable), the project's chats (newest first, pinned first, filter, pin, delete), instructions written in place and
//    saved when the box loses focus, the box that starts a chat (Enter sends, with the project's instructions), empty states, one column when narrow.
// With PROJECT_PAGE_SHOTS=<dir> it also saves screenshots (webContents.capturePage of the hidden window): the rail row, the page in dark and
// light, and narrow.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const SHOTS = process.env.PROJECT_PAGE_SHOTS || '';

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
    await app.evaluate(() => {
      const fake = global.__fake = { requests: [] };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        fake.requests.push({ system: (params.system || []).map((s) => s.text).join('\n') });
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Plain reply.' }], usage: { input_tokens: 10, output_tokens: 5 } };
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Plain reply.' } }; }, finalMessage: async () => message };
      } } } });
    });
    // Seed: "Coop/Internships" with eight chats (no instructions yet), "Project search" with none.
    const titles = ['Resume bullets for the Boston co-op', 'Cover letter: robotics startup', 'Interview prep: thermodynamics', 'Follow-up email to the recruiter', 'Offer comparison: Austin vs Boston', 'What to ask in the final round', 'Portfolio site feedback', 'Zebra crossing signal timing question'];
    const seed = await app.evaluate((_e, list) => {
      const store = global.__chats.store();
      const coop = store.saveProject({ name: 'Coop/Internships' }).id;
      const search = store.saveProject({ name: 'Project search' }).id;
      const ids = list.map((title, i) => {
        const id = store.newId();
        store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: title }] }, { role: 'assistant', content: [{ type: 'text', text: `${title} answer` }] }] });
        store.setProject(id, coop);
        return id;
      });
      return { coop, search, ids };
    }, titles);
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      const png = await app.evaluate(async () => { const t = global.__chatPage.tabs().find((x) => x.chat); const img = await global.__chatPage.contents(t.id).capturePage(); return img.toPNG().toString('base64'); });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'));
    };
    // (the hidden page's own colour scheme is emulated: the test window does not follow nativeTheme)
    const theme = async (mode) => { await app.evaluate(async (_e, m) => { const t = global.__chatPage.tabs().find((x) => x.chat); const dbg = global.__chatPage.contents(t.id).debugger; if (!dbg.isAttached()) dbg.attach('1.3'); await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: m }] }); }, mode); await sleep(400); };
    const size = async (w, h) => { await app.evaluate(({ BrowserWindow }, [a, b]) => BrowserWindow.getAllWindows()[0].setSize(a, b), [w, h]); await sleep(500); };
    const point = (sel) => inPage(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const hover = async (sel) => { const p = await point(sel); await app.evaluate(({ webContents }, { pt }) => { const t = global.__chatPage.tabs().find((x) => x.chat); global.__chatPage.contents(t.id).sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y }); }, { pt: p }); await sleep(250); };
    await theme('dark');
    const row = `.cp-pj-item[data-project="${seed.coop}"]`;

    // ======== the rail: one row per project ========
    await waitFor(() => inPage(`Boolean(document.querySelector('${row}'))`));
    check('the rail has a row per project', (await inPage("document.querySelectorAll('.cp-pj-item').length")) === 2, await inPage("document.getElementById('cp-projects').textContent"));
    check('no row of grey buttons under a project', (await inPage("document.querySelectorAll('.cp-pj-bar, .cp-pj-act').length")) === 0);
    check('the row shows the name and the number of chats', (await inPage(`document.querySelector('${row} .cp-pj-name').textContent`)) === 'Coop/Internships' && (await inPage(`document.querySelector('${row} .cp-pj-count').textContent`)) === '8');
    const labels = await inPage(`[...document.querySelectorAll('${row} button')].map((b) => b.getAttribute('aria-label') || b.textContent)`);
    check('the chevron, + and ⋯ have names that say which project', labels.some((l) => /Show chats: Coop/.test(l)) && labels.some((l) => /New chat here: Coop/.test(l)) && labels.some((l) => /More actions: Coop/.test(l)), JSON.stringify(labels));
    check('the + and ⋯ are hidden until the row is hovered or focused', (await inPage(`getComputedStyle(document.querySelector('${row} .cp-pj-tools')).opacity`)) === '0');
    await inPage(`document.querySelector('${row} .cp-pj-more').focus()`);
    check('...and show when a button in the row has focus (keyboard)', (await inPage(`getComputedStyle(document.querySelector('${row} .cp-pj-tools')).opacity`)) === '1');
    await inPage('document.activeElement.blur()');
    await shot('01-rail-dark');
    await hover(`${row} .cp-pj`);
    await shot('02-rail-hover-dark');

    // ======== ⋯ menu ========
    await inPage(`document.querySelector('${row} .cp-pj-more').click()`);
    const items = await waitFor(() => inPage("[...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].map((b) => b.textContent)"));
    check('the ⋯ menu lists Open project, New chat here, Add instructions, Rename and folder', JSON.stringify(items) === JSON.stringify(['Open project', 'New chat here', 'Add instructions', 'Rename and folder…']), JSON.stringify(items));
    check('...and the first item has focus; ⋯ says it is expanded', (await inPage("document.activeElement.textContent")) === 'Open project' && (await inPage(`document.querySelector('${row} .cp-pj-more').getAttribute('aria-expanded')`)) === 'true');
    await inPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
    check('ArrowDown moves to the next item', (await inPage('document.activeElement.textContent')) === 'New chat here', await inPage('document.activeElement.textContent'));
    await inPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check('Escape closes the menu and gives focus back to ⋯', (await inPage("Boolean(document.querySelector('.cp-pj-actions'))")) === false && (await inPage(`document.activeElement === document.querySelector('${row} .cp-pj-more')`)) === true);
    await inPage(`document.querySelector('${row} .cp-pj-more').click()`);
    await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-actions'))"));
    await inPage("[...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].find((b) => /Rename and folder/.test(b.textContent)).click()");
    check('Rename and folder… opens the project editor', await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-dialog .cp-pj-input'))")), '');
    await inPage("document.querySelector('.cp-pj-dialog').remove()");
    await inPage(`document.querySelector('${row} .cp-pj-more').click()`);
    await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-actions'))"));
    await inPage("[...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].find((b) => /instructions/i.test(b.textContent)).click()");
    check('Add instructions opens the page with the instructions box in focus', await waitFor(() => inPage("document.activeElement?.classList.contains('pjp-text')")), await inPage('document.activeElement?.className'));
    check('the row of the open project is marked as the current page', (await inPage(`document.querySelector('${row} .cp-pj').getAttribute('aria-current')`)) === 'page' && (await inPage(`document.querySelector('${row} .cp-pj').classList.contains('on')`)) === true);

    // ======== the page ========
    check('the page shows the name, the number of chats and the box that starts one', (await inPage("document.querySelector('.pjp-title').value")) === 'Coop/Internships' && /8 chats/.test(await inPage("document.querySelector('.pjp-sub').textContent")) && (await inPage("Boolean(document.querySelector('.pjp-compose-text'))")) === true);
    check('it lists the 8 chats as rows', (await inPage("document.querySelectorAll('.pjp-chat').length")) === 8);
    check('...each with a title, a date and named Pin / Move / Delete buttons', await inPage(`(() => { const r = document.querySelector('.pjp-chat'); const names = [...r.querySelectorAll('.pjp-chat-acts button')].map((b) => b.getAttribute('aria-label')); return r.querySelector('.pjp-chat-title').textContent.length > 0 && r.querySelector('.pjp-chat-when').textContent.length > 0 && names.length === 3 && names.every((n) => n.includes(r.querySelector('.pjp-chat-title').textContent)); })()`), '');
    check('a project without instructions says so in the box', (await inPage("document.querySelector('.pjp-text').value")) === '' && /How should the AI work/.test(await inPage("document.querySelector('.pjp-text').placeholder")));
    await inPage('document.activeElement.blur()');
    await shot('03-page-dark');
    await theme('light');
    await shot('04-page-light');
    await theme('dark');

    // pin
    const third = await inPage("document.querySelectorAll('.pjp-chat')[2].dataset.chat");
    await inPage("document.querySelectorAll('.pjp-chat')[2].querySelector('.chat-pin').click()");
    check('Pin moves the chat to the top of the page\'s list', await waitFor(() => inPage(`document.querySelector('.pjp-chat').dataset.chat === ${JSON.stringify(third)} && document.querySelector('.pjp-chat').classList.contains('pinned')`)), await inPage("document.querySelector('.pjp-chat')?.textContent"));
    // filter
    await inPage("(() => { const i = document.querySelector('.pjp-search-input'); i.value = 'zebra'; i.dispatchEvent(new Event('input')); })()");
    check('the search shows only this project\'s chats that match', await waitFor(() => inPage("document.querySelectorAll('.pjp-results .pjp-hit').length === 1 && /Zebra/.test(document.querySelector('.pjp-results').textContent) && document.querySelector('.pjp-chat-list').hidden")), await inPage("document.querySelector('.pjp-results').textContent"));
    await inPage("(() => { const i = document.querySelector('.pjp-search-input'); i.value = ''; i.dispatchEvent(new Event('input')); })()");
    check('clearing it brings the list back', await waitFor(() => inPage("!document.querySelector('.pjp-chat-list').hidden && document.querySelector('.pjp-results').hidden")));
    // instructions in place
    await inPage("(() => { const t = document.querySelector('.pjp-text'); t.focus(); t.value = 'Answer for a mechanical engineering co-op search. Keep it short.'; t.dispatchEvent(new Event('input')); })()");
    check('typing in the instructions box shows Save', (await inPage("document.querySelector('.pjp-save').hidden")) === false);
    await inPage('document.querySelector(\'.pjp-title\').focus()'); // (the box loses focus: it saves)
    check('...and leaving the box saves it', await waitFor(async () => (await app.evaluate((_e, id) => global.__chats.store().projects().find((p) => p.id === id).instructions, seed.coop)) === 'Answer for a mechanical engineering co-op search. Keep it short.'), '');
    check('...Save hides again', await waitFor(() => inPage("document.querySelector('.pjp-save').hidden")));
    // rename
    await inPage("(() => { const t = document.querySelector('.pjp-title'); t.focus(); t.value = 'Co-op search'; t.blur(); })()");
    check('renaming the project in the page renames its row in the rail', await waitFor(async () => (await inPage(`document.querySelector('${row} .cp-pj-name')?.textContent`)) === 'Co-op search'), await inPage("document.getElementById('cp-projects').textContent"));
    await inPage("(() => { const t = document.querySelector('.pjp-title'); t.focus(); t.value = 'Coop/Internships'; t.blur(); })()");
    check('...and back', await waitFor(async () => (await inPage(`document.querySelector('${row} .cp-pj-name')?.textContent`)) === 'Coop/Internships'), '');
    // delete
    const before = await inPage("document.querySelectorAll('.pjp-chat').length");
    await inPage("document.querySelectorAll('.pjp-chat')[7].querySelector('.chat-delete').click()");
    check('Delete removes the row (Undo is offered)', await waitFor(async () => (await inPage("document.querySelectorAll('.pjp-chat').length")) === before - 1), await inPage("document.querySelectorAll('.pjp-chat').length"));
    check('...and the rail counts one fewer', await waitFor(async () => (await inPage(`document.querySelector('${row} .cp-pj-count').textContent`)) === '7'));

    // ======== start a chat from the page ========
    await inPage("(() => { const t = document.querySelector('.pjp-compose-text'); t.focus(); t.value = 'Draft a thank-you note'; t.dispatchEvent(new Event('input')); })()");
    await inPage("document.querySelector('.pjp-compose-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
    check('Enter in the page\'s box starts a chat in the project: the page gives way to the conversation', await waitFor(async () => (await inPage("Boolean(document.getElementById('cp-project-page'))")) === false && (await inPage("document.getElementById('chat-root').hidden")) === false), '');
    check('...it was sent with the project\'s instructions', await waitFor(async () => { const f = await app.evaluate(() => global.__fake); return f.requests.some((r) => /mechanical engineering co-op/.test(r.system)); }), JSON.stringify(await app.evaluate(() => global.__fake)));
    check('...and the message and the project chip are on screen', await waitFor(async () => /Draft a thank-you note/.test(await inPage("document.getElementById('messages').textContent")) && /Coop\/Internships/.test(await inPage("document.getElementById('cp-project-chip').textContent"))), JSON.stringify([await inPage("document.getElementById('messages').textContent"), await inPage("document.getElementById('cp-project-chip').textContent")]));
    check('...the chat is saved in the project', await waitFor(() => app.evaluate((_e, id) => global.__chats.store().list().filter((c) => c.project === id).length === 8, seed.coop)), '');
    // + on a row
    const rowB = `.cp-pj-item[data-project="${seed.search}"]`;
    await inPage(`document.querySelector('${rowB} .cp-pj-new').click()`);
    check('+ on a row starts an empty chat in that project', await waitFor(() => inPage("/Project search/.test(document.getElementById('cp-project-chip').textContent) && document.getElementById('messages').children.length < 3")), await inPage("document.getElementById('cp-project-chip').textContent"));

    // ======== an empty project ========
    await inPage(`document.querySelector('${rowB} .cp-pj').click()`);
    await waitFor(() => inPage("Boolean(document.getElementById('cp-project-page'))"));
    check('a project with no chats says so, and says what to do', (await inPage("document.querySelector('.pjp-empty-state').hidden")) === false && /No chats yet/.test(await inPage("document.querySelector('.pjp-empty-state').textContent")) && (await inPage("document.querySelector('.pjp-chat-list').hidden")) === true);
    check('...and the files and pages cards have their own empty text', /No files yet/.test(await inPage("document.querySelector('.pjp-side').textContent")) && /No pages yet/.test(await inPage("document.querySelector('.pjp-side').textContent")));
    await inPage('document.activeElement.blur()');
    await shot('05-page-empty-dark');

    // ======== narrow ========
    await inPage(`document.querySelector('${row} .cp-pj').click()`);
    await waitFor(async () => (await inPage("document.querySelector('.pjp-title')?.value")) === 'Coop/Internships');
    await size(760, 900);
    const cols = await inPage("getComputedStyle(document.querySelector('.pjp-cols')).gridTemplateColumns.split(' ').length");
    check('in a narrow window the setup moves under the chats (one column)', cols === 1, cols);
    check('...with nothing wider than the window', (await inPage("document.querySelector('.pjp').scrollWidth <= document.querySelector('.pjp').clientWidth + 1")) === true);
    await shot('06-page-narrow-dark');
    await size(1280, 900);
    const wide = await inPage("getComputedStyle(document.querySelector('.pjp-cols')).gridTemplateColumns.split(' ').length");
    check('in a wide window it has two columns', wide === 2, wide);
    await inPage("document.querySelector('.pjp-back').click()");
    check('the back button returns to the conversation and unmarks the row', await waitFor(async () => (await inPage("document.getElementById('chat-root').hidden")) === false && (await inPage(`document.querySelector('${row} .cp-pj').classList.contains('on')`)) === false));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
