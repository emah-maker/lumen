// Drag chats into projects on lumen://chat (renderer/chat-project-drag.js, chat-projects.js, main.js chats:project-move / -restore),
// with real pointer input (webContents.sendInputEvent mouseDown / mouseMove / mouseUp). Covers: an old chat dragged onto a project
// (and kept after a reload), a collapsed project opening after the pointer rests on it, picking two chats with Ctrl+click and dragging
// them together, dragging out to "No project", the row menu's "Move to project", Undo, the sidebar's list following live, a running chat
// that keeps running, and moving never counting as activity. A fake slow model, invisible windows (LUMEN_TEST_BACKGROUND=1), no network.
// LUMEN_SHOTS (a folder) saves a picture of a drag in progress.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-drag-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
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

    // Five saved chats, made old (a month back, in order c1 newest .. c5 oldest), and two projects.
    const DAY = 864e5;
    const ids = {};
    for (const n of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      ids[n] = await app.evaluate((_e, name) => {
        const store = global.__chats.store();
        const id = store.newId();
        store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: `${name} topic` }] }, { role: 'assistant', content: [{ type: 'text', text: `${name} answer` }] }] });
        return id;
      }, n);
    }
    await app.evaluate((_e, a) => {
      const store = global.__chats.store();
      Object.keys(a.ids).forEach((n, i) => { const e = store.list().find((c) => c.id === a.ids[n]); e.updated = Date.now() - (40 + i) * a.DAY; });
      store.setPinned(a.ids.c1, true); store.setPinned(a.ids.c1, false); // (writes the index)
    }, { ids, DAY });
    const zoo = await app.evaluate(() => global.__chats.store().saveProject({ name: 'Zoo' }).id);
    const art = await app.evaluate(() => global.__chats.store().saveProject({ name: 'Art' }).id);
    const projectOf = (id) => app.evaluate((_e, i) => global.__chats.store().list().find((c) => c.id === i)?.project || null, id);
    const stamps = () => app.evaluate(() => JSON.stringify(global.__chats.store().list().map((c) => [c.id, c.updated])));
    const stampsBefore = await stamps();

    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const tabId = await waitFor(() => app.evaluate(() => global.__chatPage.tabs().find((t) => t.chat)?.id));
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false && (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 5, 20000);
    await inPage("document.documentElement.classList.remove('platform-darwin')"); // (Ctrl, not Cmd: the platform is pinned)
    check('the page is wide enough for the rail', (await inPage("!document.body.classList.contains('cp-rail-hidden')")) === true, await inPage('window.innerWidth'));

    // ---- real pointer input
    const mouse = (events) => app.evaluate(async (_e, evs) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      const wc = global.__chatPage.contents(t.id);
      for (const ev of evs) { if (ev.wait) await new Promise((r) => setTimeout(r, ev.wait)); else wc.sendInputEvent(ev); }
    }, events);
    const where = (sel) => inPage(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2) }; })()`);
    const L = ['leftButtonDown'];
    const rowSel = (id) => `#cp-items .chat-item[data-id="${id}"] .chat-open`;
    const pickUp = async (sel) => { // press on a row and move far enough to start the drag
      const p = await where(sel);
      await mouse([{ type: 'mouseMove', x: p.x, y: p.y }, { type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }, { type: 'mouseMove', x: p.x + 4, y: p.y + 3, modifiers: L }, { type: 'mouseMove', x: p.x + 12, y: p.y + 8, modifiers: L }]);
      return p;
    };
    const moveTo = async (sel, extra = []) => { const p = await where(sel); await mouse([{ type: 'mouseMove', x: p.x - 8, y: p.y - 4, modifiers: L }, { type: 'mouseMove', x: p.x, y: p.y, modifiers: L }, ...extra]); return p; };
    const drop = async (sel) => { const p = await moveTo(sel); await mouse([{ wait: 50 }, { type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 }]); };
    const dragTo = async (rowId, targetSel) => { await pickUp(rowSel(rowId)); await drop(targetSel); };
    const pjRow = (id) => `.cp-pj-item[data-project="${id}"] .cp-pj`;
    const toastText = () => inPage("document.querySelector('.chat-undo-toast span')?.textContent || ''");
    const settled = () => waitFor(async () => (await inPage("document.body.classList.contains('cp-dragging')")) === false);

    // 1. An old chat onto a project.
    const before = await inPage("[...document.querySelectorAll('#cp-items .chat-item')].map((r) => r.dataset.id).join()");
    await pickUp(rowSel(ids.c3));
    check('a drag in progress shows a ghost with the chat title', await waitFor(() => inPage("document.querySelector('.cp-drag-ghost')?.textContent")) === 'c3 topic', await inPage("document.body.innerHTML.includes('cp-drag-ghost')"));
    const shotDir = process.env.LUMEN_SHOTS;
    await moveTo(pjRow(zoo));
    check('while dragging, the project under the pointer is highlighted and the others are drop targets', await waitFor(() => inPage(`document.querySelector('.cp-pj-item[data-project="${zoo}"]').classList.contains('drop-over') && document.querySelector('.cp-pj-item[data-project="${art}"]').classList.contains('drop-ok') && document.body.classList.contains('cp-dragging')`)), await inPage("document.getElementById('cp-projects').innerHTML.slice(0, 500)"));
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      const png = await app.evaluate(async () => { const t = global.__chatPage.tabs().find((x) => x.chat); return (await global.__chatPage.contents(t.id).capturePage()).toPNG().toString('base64'); });
      fs.writeFileSync(path.join(shotDir, 'drag-in-progress.png'), Buffer.from(png, 'base64'));
    }
    const at = await where(pjRow(zoo));
    await mouse([{ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 }]);
    check('dropping an old chat on a project moves it', await waitFor(async () => (await projectOf(ids.c3)) === zoo), String(await projectOf(ids.c3)));
    check('...the toast says where, with Undo', /Moved to Zoo/.test(await waitFor(toastText) || '') && (await inPage("[...document.querySelectorAll('.chat-undo-toast button')].some((b) => b.textContent === 'Undo')")) === true, await toastText());
    check('...the rail counts it', await waitFor(async () => (await inPage(`document.querySelector('.cp-pj-item[data-project="${zoo}"] .cp-pj-count')?.textContent`)) === '1'), await inPage("document.getElementById('cp-projects').textContent"));
    check('...the live region says so', /Moved to Zoo/.test(await inPage("[...document.querySelectorAll('[role=status].sr-only')].map((e) => e.textContent).join('|')") || ''), await inPage("[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join('|')"));
    check('...moving is not activity: the order and every updated time are as they were', (await stamps()) === stampsBefore && (await inPage("[...document.querySelectorAll('#cp-items .chat-item')].map((r) => r.dataset.id).join()")) === before, await stamps());
    await settled();
    await inPage('location.reload()');
    await waitFor(async () => (await inPage("document.body.classList.contains('cp-booting')")) === false && (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 5, 20000);
    check('it persists across a reload of the page', (await projectOf(ids.c3)) === zoo && (await inPage(`document.querySelector('.cp-pj-item[data-project="${zoo}"] .cp-pj-count')?.textContent`)) === '1', await inPage("document.getElementById('cp-projects').textContent"));
    await inPage("document.documentElement.classList.remove('platform-darwin')");

    // 2. A collapsed project opens after the pointer rests on it.
    check('a project starts collapsed', (await inPage(`document.querySelector('.cp-pj-item[data-project="${art}"]').classList.contains('open')`)) === false, '');
    await pickUp(rowSel(ids.c4));
    await moveTo(pjRow(art));
    await sleep(250);
    check('...not yet after a moment', (await inPage(`document.querySelector('.cp-pj-item[data-project="${art}"]').classList.contains('open')`)) === false, '');
    check('...but after about 600 ms of hovering it expands', await waitFor(() => inPage(`document.querySelector('.cp-pj-item[data-project="${art}"]').classList.contains('open') && Boolean(document.querySelector('.cp-pj-chats[data-project="${art}"]'))`), 3000), '');
    check('...and the highlight is still on it after the redraw', (await inPage(`document.querySelector('.cp-pj-item[data-project="${art}"]').classList.contains('drop-over')`)) === true, '');
    const here = await where(`.cp-pj-chats[data-project="${art}"]`); // drop in its (empty) list
    await mouse([{ type: 'mouseMove', x: here.x, y: here.y, modifiers: L }, { wait: 60 }, { type: 'mouseUp', x: here.x, y: here.y, button: 'left', clickCount: 1 }]);
    check('dropping in its opened list moves the chat', await waitFor(async () => (await projectOf(ids.c4)) === art), String(await projectOf(ids.c4)));
    check('...and the chat is listed under the project', await waitFor(() => inPage(`Boolean(document.querySelector('.cp-pj-chats[data-project="${art}"] .cp-pj-chat[data-id="${ids.c4}"]'))`)), '');
    await settled();

    // 3. The same project again does nothing.
    await app.evaluate(() => { global.__moves = 0; });
    const t0 = await toastText();
    await dragTo(ids.c3, pjRow(zoo));
    await settled();
    check('dropping a chat on the project it is already in does nothing (no toast, no change)', (await projectOf(ids.c3)) === zoo && ((await toastText()) === t0 || (await toastText()) === ''), await toastText());

    // 4. Two chats picked with Ctrl+click and dragged together.
    const click = async (sel, modifiers) => { const p = await where(sel); await mouse([{ type: 'mouseMove', x: p.x, y: p.y }, { type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers }, { type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers }]); };
    await click(rowSel(ids.c1), ['control']);
    await click(rowSel(ids.c2), ['control']);
    check('Ctrl+click picks rows (and does not open them)', (await inPage("document.querySelectorAll('#cp-items .chat-item.selected').length")) === 2 && (await inPage("document.getElementById('messages').textContent")).includes('c1 answer') === false, await inPage("document.querySelectorAll('#cp-items .chat-item.selected').length"));
    await pickUp(rowSel(ids.c1));
    check('the ghost counts the chats it carries', (await waitFor(() => inPage("document.querySelector('.cp-drag-count')?.textContent"))) === '2', '');
    await drop(pjRow(zoo));
    check('dragging one of the picked rows moves them all', await waitFor(async () => (await projectOf(ids.c1)) === zoo && (await projectOf(ids.c2)) === zoo), `${await projectOf(ids.c1)} ${await projectOf(ids.c2)}`);
    check('...the toast counts them', /Moved 2 chats to Zoo/.test(await toastText()), await toastText());
    await settled();
    check('...and the selection is cleared', (await inPage("document.querySelectorAll('#cp-items .chat-item.selected').length")) === 0, '');

    // 5. Dragging out to "No project".
    await pickUp(rowSel(ids.c1));
    check('dragging a chat that is in a project shows a "Remove from project" target', await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-none'))")), '');
    await moveTo('#cp-items .chat-group');
    check('the history area is highlighted as the target', await waitFor(() => inPage("document.getElementById('cp-items').classList.contains('drop-over')")), await inPage('document.getElementById("cp-items").className'));
    const gp = await where('#cp-items .chat-group');
    await mouse([{ type: 'mouseUp', x: gp.x, y: gp.y, button: 'left', clickCount: 1 }]);
    check('dropping on the history area takes the chat out of its project', await waitFor(async () => (await projectOf(ids.c1)) === null), String(await projectOf(ids.c1)));
    check('...the toast says so', /Removed from its project/.test(await toastText()), await toastText());
    await settled();
    await pickUp(rowSel(ids.c2));
    await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-none'))"));
    await drop('.cp-pj-none');
    check('dropping on "Remove from project" works too', await waitFor(async () => (await projectOf(ids.c2)) === null), String(await projectOf(ids.c2)));
    check('the target goes away after the drop', await waitFor(async () => (await inPage("Boolean(document.querySelector('.cp-pj-none'))")) === false), '');
    await settled();

    // 6. The menu: Move to project, with Undo.
    await inPage(`(() => { const li = document.querySelector('#cp-items .chat-item[data-id="${ids.c5}"]'); li.querySelector('.chat-more').click(); })()`);
    await waitFor(() => inPage(`Boolean(document.querySelector('#cp-items .chat-item[data-id="${ids.c5}"] .chat-project'))`));
    check('a row\'s ⋯ menu has "Move to project"', (await inPage(`document.querySelector('#cp-items .chat-item[data-id="${ids.c5}"] .chat-project')?.getAttribute('aria-label')`)) === 'Move to project', '');
    await inPage(`document.querySelector('#cp-items .chat-item[data-id="${ids.c5}"] .chat-project').click()`);
    const items = await waitFor(() => inPage("[...document.querySelectorAll('.cp-pj-pick .cp-pj-pick-item')].map((b) => b.textContent)"));
    check('...it lists the projects and "New project…"', Array.isArray(items) && items.includes('Zoo') && items.includes('Art') && items.includes('New project…'), JSON.stringify(items));
    await inPage("[...document.querySelectorAll('.cp-pj-pick .cp-pj-pick-item')].find((b) => b.textContent === 'Art').click()");
    check('choosing a project moves the chat', await waitFor(async () => (await projectOf(ids.c5)) === art), String(await projectOf(ids.c5)));
    check('...with the same toast', /Moved to Art/.test(await waitFor(toastText) || ''), await toastText());

    // 7. Undo.
    await inPage("[...document.querySelectorAll('.chat-undo-toast button')].find((b) => b.textContent === 'Undo').click()");
    check('Undo puts the chat back where it was', await waitFor(async () => (await projectOf(ids.c5)) === null), String(await projectOf(ids.c5)));
    check('...and the rail and list follow', await waitFor(async () => (await inPage(`document.querySelector('.cp-pj-item[data-project="${art}"] .cp-pj-count')?.textContent`)) === '1'), await inPage("document.getElementById('cp-projects').textContent"));
    await dragTo(ids.c2, pjRow(zoo));
    await waitFor(async () => (await projectOf(ids.c2)) === zoo);
    await inPage("[...document.querySelectorAll('.chat-undo-toast button')].find((b) => b.textContent === 'Undo').click()");
    check('Undo works after a drag too', await waitFor(async () => (await projectOf(ids.c2)) === null), String(await projectOf(ids.c2)));
    check('...recency still untouched after all the moves', (await stamps()) === stampsBefore, await stamps());
    await settled();

    // 8. The other open list (the sidebar's) follows live.
    await ui.evaluate(() => document.getElementById('chat-history').click());
    const sideRow = (id) => ui.evaluate((i) => document.querySelector(`#chat-list .chat-item[data-id="${i}"] .chat-meta-text`)?.textContent || '', id);
    await waitFor(async () => (await sideRow(ids.c3)) !== '');
    check('the sidebar list says which project a chat is in', /Zoo/.test(await sideRow(ids.c3)) && !/Zoo|Art/.test(await sideRow(ids.c1)), `${await sideRow(ids.c3)} | ${await sideRow(ids.c1)}`);
    await dragTo(ids.c1, pjRow(art));
    check('a drop in the page shows in the sidebar list at once', await waitFor(async () => /Art/.test(await sideRow(ids.c1))), await sideRow(ids.c1));
    await settled();
    await inPage("[...document.querySelectorAll('.chat-undo-toast button')].find((b) => b.textContent === 'Undo')?.click()");
    check('...and Undo takes it off again', await waitFor(async () => !/Art/.test(await sideRow(ids.c1))), await sideRow(ids.c1));
    await ui.evaluate(() => document.getElementById('chat-history').click()); // (closed again)

    // 9. A running chat can be moved, and keeps running.
    await inPage(`document.querySelector('${rowSel(ids.c4)}').click()`);
    await waitFor(async () => /c4 answer/.test(await inPage("document.getElementById('messages').textContent")));
    await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'slow question'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    check('a chat is working (held reply)', await waitFor(() => app.evaluate(() => global.__tabChats.runs().some((r) => r.live))), '');
    const runningId = await app.evaluate(() => global.__tabChats.chatId());
    await sleep(700); // (the row has moved to the top of the list; let it settle)
    await pickUp(rowSel(runningId));
    check('a running chat row can be picked up', await waitFor(() => inPage("Boolean(document.querySelector('.cp-drag-ghost'))")), await inPage(`JSON.stringify({ row: document.querySelector('#cp-items .chat-item[data-id="${runningId}"]')?.className, items: document.querySelectorAll('#cp-items .chat-item').length })`));
    await drop(pjRow(zoo));
    check('a running chat moves into the project', await waitFor(async () => (await projectOf(runningId)) === zoo), String(await projectOf(runningId)));
    check('...and keeps running (still live, Stop still showing)', (await app.evaluate(() => global.__tabChats.runs().some((r) => r.live))) && (await inPage("document.getElementById('send').classList.contains('stop')")) === true, '');
    await app.evaluate(() => global.__fakeRelease());
    check('...its reply arrives after the move', await waitFor(async () => /Slow reply done/.test(await inPage("document.getElementById('messages').textContent"))), await inPage("document.getElementById('messages').textContent"));
    check('...and it is still in the project', (await projectOf(runningId)) === zoo, String(await projectOf(runningId)));

    check('no page errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
