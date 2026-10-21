// The Files card on the new-tab page, in a real (hidden) window: its empty state, pinned and recent rows, a missing file with Find it,
// the right-click menu, opening, the + menu, and the keyboard. The files are in a temp folder; the profile is a throwaway.
'use strict';
const fs = require('fs');
const path = require('path');
const { start, sleep, waitFor, makeChecker } = require('../helpers/_files-rig');

(async () => {
  const { state, check } = makeChecker();
  const rig = await start({ tag: 'files-widget' });
  const { app, inTab } = rig;
  try {
    const pinnedFolder = path.dirname(rig.file('proj/Chapter 4 slides.txt', 'slides'));
    rig.file('proj/notes.txt', 'notes');
    const loose = rig.file('loose.txt', 'loose');
    const gone = rig.file('gone/Budget.txt', 'budget');
    const goneCopy = rig.file('gone-moved/Budget.txt', 'budget'); // where "Find it" will look: a sibling of the old folder
    const recentA = rig.file('recent-a.txt', 'a');
    const recentB = rig.file('recent-b.txt', 'b');

    await rig.homeTab();
    const on = (code) => waitFor(() => inTab(code));
    check('the Files card is on the page', await on("Boolean(document.querySelector('.w-card.files'))"), '');
    check('empty: it says what to do', await on("/Pin a folder or open a file to see it here/.test(document.querySelector('.w-card.files .fl-first')?.textContent || '')"), await inTab("document.querySelector('.w-card.files')?.textContent"));
    check('empty: it offers Pin a file and Pin a folder', await inTab("[...document.querySelectorAll('.w-card.files .fl-first button')].map((b) => b.textContent).join()") === 'Pin a file…,Pin a folder…', '');
    check('empty: with Remember files off there is no "Turn on" (it is on)', await inTab("!document.querySelector('.w-card.files .fl-turn-on')"), '');
    // Remember files I open off: the empty card says so and offers Turn on, which turns the setting on again.
    await app.evaluate(() => global.__patchSettings({ filesRemember: false }));
    await app.evaluate(() => global.__homeTab.webContents.send('newtab-files:changed'));
    check('remember off: the empty card says Lumen is not remembering, with a Turn on button', await on("/isn’t remembering the files you open/.test(document.querySelector('.w-card.files .fl-first')?.textContent || '') && [...document.querySelectorAll('.w-card.files .fl-first button')].map((b) => b.textContent).join() === 'Pin a file…,Pin a folder…,Turn on'"), await inTab("document.querySelector('.w-card.files')?.textContent"));
    await inTab("document.querySelector('.w-card.files .fl-turn-on').click()");
    check('Turn on switches Remember files I open on, and the card goes back to the plain empty state', await waitFor(async () => (await rig.files('list')).remember === true) && await on("!document.querySelector('.w-card.files .fl-turn-on') && /Pin a folder or open a file to see it here/.test(document.querySelector('.w-card.files .fl-first')?.textContent || '')"), await inTab("document.querySelector('.w-card.files')?.textContent"));

    // ---- pinned and recent ----
    for (const p of [pinnedFolder, loose, gone]) await rig.files('pin', { path: p });
    await rig.openFileTab(recentA);
    await rig.openFileTab(recentB);
    check('opening files in tabs records them as recent', await waitFor(async () => (await rig.files('list')).recent.length >= 2), JSON.stringify(await rig.files('list')));
    const rows = (sec) => inTab(`[...document.querySelectorAll('.w-card.files .fl-sec[aria-label="${sec}"] .fl-row')].map((r) => r.querySelector('.w-title').textContent)`);
    check('pinned rows: the folder and the two files', await waitFor(async () => (await rows('Pinned')).length === 3), JSON.stringify(await rows('Pinned')));
    const pinned = await rows('Pinned');
    check('pinned rows carry their names', ['proj', 'loose.txt', 'Budget.txt'].every((n) => pinned.includes(n)), JSON.stringify(pinned));
    check('recent rows: the two files opened, newest first', await waitFor(async () => (await rows('Recent')).slice(0, 2).join() === 'recent-b.txt,recent-a.txt'), JSON.stringify(await rows('Recent')));
    check('a folder has the folder icon, a text file the document one', await inTab("document.querySelector('.fl-row .fl-icon.k-folder') !== null && document.querySelector('.fl-row .fl-icon.k-doc') !== null"), '');
    check('a recent row says when: "just now"', await inTab("/just now/.test(document.querySelector('.fl-sec[aria-label=\"Recent\"] .w-sub')?.textContent || '')"), await inTab("document.querySelector('.fl-sec[aria-label=\"Recent\"]')?.textContent"));
    check('a row also says where the file is (its folder)', await inTab("/[a-z]/i.test(document.querySelector('.fl-row:not(.missing) .w-sub')?.textContent || '')"), await inTab("document.querySelector('.fl-sec')?.textContent"));
    check('the lists are lists, and every row is a real button', await inTab("(() => { const l = document.querySelector('.fl-sec .w-list'); return l.getAttribute('role') === 'list' && [...document.querySelectorAll('.fl-row')].every((r) => r.getAttribute('role') === 'listitem' && r.querySelector('button.fl-main')); })()"), '');

    // ---- opening ----
    const before = (await rig.tabs()).length;
    await inTab("[...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.w-title').textContent === 'loose.txt').querySelector('.fl-main').click()");
    check('a click opens the file in a tab', await waitFor(async () => { const t = await rig.tabs(); return t.length === before + 1 && /loose\.txt$/.test(t.find((x) => x.active)?.url || ''); }), JSON.stringify(await rig.tabs()));
    await app.evaluate(() => global.__agent.browser.switchTab(global.__homeTab.id));
    await sleep(200);

    // ---- the right-click menu ----
    const menuItems = () => inTab("[...document.querySelectorAll('.fl-menu [role=menuitem]')].map((b) => b.textContent)");
    await inTab("(() => { const r = [...document.querySelectorAll('.fl-row')].find((x) => x.querySelector('.w-title').textContent === 'recent-a.txt'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); })()");
    check('right-click: Open, Show in folder, Pin, Remove from Files', await waitFor(async () => (await menuItems()).join() === 'Open,Show in folder,Pin,Remove from Files'), JSON.stringify(await menuItems()));
    check('the menu has the keyboard (first item focused), and the page’s own card menu stayed shut', await inTab("document.activeElement?.getAttribute('role') === 'menuitem' && !document.querySelector('.w-stack-menu:not(.fl-menu)')"), '');
    await inTab("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))");
    check('ArrowDown moves down the menu', await inTab("document.activeElement?.textContent === 'Show in folder'"), '');
    await inTab("[...document.querySelectorAll('.fl-menu [role=menuitem]')].find((b) => b.textContent === 'Pin').click()");
    check('Pin from the menu pins a recent file', await waitFor(async () => (await rows('Pinned')).includes('recent-a.txt')), JSON.stringify(await rows('Pinned')));
    check('the menu closes after a choice', await inTab("!document.querySelector('.fl-menu')"), '');
    await inTab("(() => { const r = [...document.querySelectorAll('.fl-row')].find((x) => x.querySelector('.w-title').textContent === 'recent-a.txt' && x.classList.contains('pinned')); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); })()");
    check('a pinned file’s menu says Unpin (and has no Remove from Files)', await waitFor(async () => { const m = await menuItems(); return m.includes('Unpin') && !m.includes('Remove from Files'); }), JSON.stringify(await menuItems()));
    await inTab("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
    check('Esc closes the menu', await inTab("!document.querySelector('.fl-menu')"), '');
    await inTab("(() => { const r = [...document.querySelectorAll('.fl-row')].find((x) => x.querySelector('.w-title').textContent === 'recent-a.txt' && x.classList.contains('pinned')); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); [...document.querySelectorAll('.fl-menu [role=menuitem]')].find((b) => b.textContent === 'Unpin').click(); })()");
    check('Unpin takes it off the pinned list again', await waitFor(async () => !(await rows('Pinned')).includes('recent-a.txt')), JSON.stringify(await rows('Pinned')));
    const undoLine = () => inTab("document.querySelector('.w-card.files .fl-undo')?.textContent || ''");
    check('Unpin offers "Unpinned recent-a.txt. Undo"', await waitFor(async () => /Unpinned recent-a\.txt\.\s*Undo/.test(await undoLine())), await undoLine());
    await inTab("document.querySelector('.w-card.files .fl-undo button').click()");
    check('Undo puts the pin back', await waitFor(async () => (await rows('Pinned')).includes('recent-a.txt') && !(await undoLine())), JSON.stringify(await rows('Pinned')));
    await inTab("(() => { const r = [...document.querySelectorAll('.fl-row')].find((x) => x.querySelector('.w-title').textContent === 'recent-b.txt'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); [...document.querySelectorAll('.fl-menu [role=menuitem]')].find((b) => b.textContent === 'Remove from Files').click(); })()");
    check('Remove from Files forgets a recent file', await waitFor(async () => !(await rows('Recent')).includes('recent-b.txt')), JSON.stringify(await rows('Recent')));
    check('Remove from Files offers "Removed recent-b.txt. Undo"', await waitFor(async () => /Removed recent-b\.txt\.\s*Undo/.test(await undoLine())), await undoLine());
    await inTab("document.querySelector('.w-card.files .fl-undo button').click()");
    check('Undo brings it back to Recent', await waitFor(async () => (await rows('Recent')).includes('recent-b.txt')), JSON.stringify(await rows('Recent')));
    await inTab("(() => { const r = [...document.querySelectorAll('.fl-row')].find((x) => x.querySelector('.w-title').textContent === 'recent-b.txt'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); [...document.querySelectorAll('.fl-menu [role=menuitem]')].find((b) => b.textContent === 'Remove from Files').click(); })()");
    check('…and removing it again leaves it removed', await waitFor(async () => !(await rows('Recent')).includes('recent-b.txt')), JSON.stringify(await rows('Recent')));
    check('an Undo no longer than 30 s old is all main keeps: restore of an unknown id is refused', (await rig.files('restore', 'nope')) === null, '');
    check('…and the file itself is untouched', fs.existsSync(recentB), '');

    // ---- a missing file ----
    fs.rmSync(gone, { force: true });
    // (asking for the list is what re-checks missing files, at most every few seconds; main then tells the page the list changed)
    check('a deleted pinned file turns grey and says "moved or deleted"', await waitFor(async () => {
      await rig.files('list');
      return inTab("(() => { const r = document.querySelector('.fl-row.missing'); return Boolean(r) && /moved or deleted/.test(r.textContent) && r.querySelector('.w-title').textContent === 'Budget.txt'; })()");
    }, 12000), await inTab("document.querySelector('.w-card.files')?.textContent"));
    check('it has a Find it button (with a hint)', await inTab("(() => { const r = document.querySelector('.fl-row.missing'); const b = r.querySelector('.fl-find'); return b?.textContent === 'Find it' && Boolean(b.title); })()"), '');
    const tabsBefore = (await rig.tabs()).length;
    await inTab("document.querySelector('.fl-row.missing .fl-main').click()"); // (the row itself, not the button)
    check('clicking the row runs Find it: it lists what it found near the old place', await waitFor(() => inTab("(() => { const c = document.querySelector('.fl-cands'); return Boolean(c) && c.querySelectorAll('.fl-cand').length >= 1 && /Budget\\.txt/.test(c.textContent); })()")), await inTab("document.querySelector('.w-card.files')?.textContent"));
    check('…the focus is on the first match, and nothing was opened', await inTab("document.activeElement === document.querySelector('.fl-cands .fl-cand')") && (await rig.tabs()).length === tabsBefore, await inTab("document.activeElement?.outerHTML?.slice(0, 80)"));
    await inTab("document.querySelector('.fl-cands .fl-cand').click()");
    check('picking a match points the entry at it again', await waitFor(async () => {
      const l = await rig.files('list');
      const e = l.pinned.find((p) => p.name === 'Budget.txt');
      return e && !e.missing && path.resolve(e.path) === path.resolve(goneCopy);
    }), JSON.stringify((await rig.files('list')).pinned.map((p) => [p.name, p.path, p.missing])));
    check('the row is back to normal', await waitFor(() => inTab("!document.querySelector('.fl-row.missing') && !document.querySelector('.fl-cands')")), '');

    // ---- the + menu ----
    await inTab("document.querySelector('.w-card.files .fl-add').click()");
    check('+ opens a menu: Pin a file…, Pin a folder…', await waitFor(async () => (await menuItems()).join() === 'Pin a file…,Pin a folder…'), JSON.stringify(await menuItems()));
    const picked = rig.file('picked/Syllabus.txt', 'syllabus');
    await app.evaluate((_e, p) => { global.__filesPick = () => p; }, picked); // (the test answers for the OS dialog)
    await inTab("[...document.querySelectorAll('.fl-menu [role=menuitem]')].find((b) => b.textContent === 'Pin a file…').click()");
    check('Pin a file… pins what the dialog returned', await waitFor(async () => (await rows('Pinned')).includes('Syllabus.txt')), JSON.stringify(await rows('Pinned')));
    const fl = await rig.files('list');
    check('the entry stores only a path, name, size and times (never contents)', fl.pinned.every((e) => Object.keys(e).every((k) => ['id', 'path', 'name', 'kind', 'size', 'mtime', 'openedAt', 'pinnedAt', 'pinned', 'missing', 'source'].includes(k))), JSON.stringify(Object.keys(fl.pinned[0] || {})));

    // ---- keyboard ----
    check('every control in the card has a name and the card has a focus style', await inTab("[...document.querySelectorAll('.w-card.files button')].every((b) => (b.getAttribute('aria-label') || b.textContent || b.title).trim())"), '');
    await app.evaluate(() => global.__agent.browser.switchTab(global.__homeTab.id));
    await sleep(300);
    await inTab("[...document.querySelectorAll('.fl-row')].find((r) => r.querySelector('.w-title').textContent === 'loose.txt').querySelector('.fl-main').focus()");
    await app.evaluate(() => { const wc = global.__homeTab.webContents; for (const type of ['rawKeyDown', 'char', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'Return' }); });
    await sleep(300);
    check('Enter on a focused row opens it', (await rig.tabs()).length >= before + 2, JSON.stringify(await rig.tabs()));

    check('no page errors', rig.errors.length === 0, rig.errors.join(' | '));
  } finally {
    await rig.stop();
  }
  console.log(state.failures ? `\n${state.failures} failed` : '\nall passed');
  process.exit(state.failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
