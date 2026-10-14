// The quick file picker (Ctrl+Shift+F), in a real (hidden) window: the key opens it from a page and from the browser UI, an empty query
// lists pinned and recent files, a query finds a file inside a pinned folder (matching letters marked), Enter opens it in a tab,
// Ctrl+Enter shows it in its folder, Alt+Enter attaches it to the sidebar chat, Esc closes. "Show in folder" is stubbed in main so no
// Explorer window opens; the files are in a temp folder and the profile is a throwaway.
'use strict';
const fs = require('fs');
const path = require('path');
const { start, waitFor, makeChecker } = require('./_files-rig');

(async () => {
  const { state, check } = makeChecker();
  const rig = await start({ widget: false, tag: 'files-picker' });
  const { app, ui } = rig;
  try {
    const dir = path.dirname(rig.file('docs/Chapter 4 slides.txt', 'chapter four'));
    rig.file('docs/Budget 2026.txt', 'budget');
    for (let i = 0; i < 60; i++) rig.file(`docs/reports/report-${String(i).padStart(2, '0')}.txt`, 'r');
    const loose = rig.file('Loose Notes.txt', 'loose');
    const recent = rig.file('recent-thing.txt', 'recent');
    await app.evaluate(() => { global.__shown = []; global.__filesShell = (name, p) => { global.__shown.push(p); return name === 'open' ? '' : undefined; }; }); // (no Explorer window and no program starts in a test)

    await rig.files('pin', { path: dir });
    await rig.files('pin', { path: loose });
    await rig.openFileTab(recent);
    check('the folder is searchable once indexed (off the main thread)', await waitFor(async () => (await rig.files('search', 'chapter slides')).some((e) => e.name === 'Chapter 4 slides.txt'), 20000), JSON.stringify(await rig.files('search', 'chapter slides')));

    const panelOpen = () => ui.evaluate(() => { const p = document.getElementById('files-picker'); return Boolean(p && !p.hidden); });
    const names = () => ui.evaluate(() => [...document.querySelectorAll('#files-picker-results .files-picker-item .files-picker-name')].map((n) => n.textContent));
    const heads = () => ui.evaluate(() => [...document.querySelectorAll('#files-picker-results .files-picker-section')].map((n) => n.textContent));
    const selectedName = () => ui.evaluate(() => document.querySelector('#files-picker-results .files-picker-item.selected .files-picker-name')?.textContent || '');

    // ---- opening ----
    await rig.key('page', 'F', ['control', 'shift']);
    check('Ctrl+Shift+F in a page opens the picker', await waitFor(panelOpen), 'not open');
    check('the search box has the keyboard', await waitFor(() => ui.evaluate(() => document.activeElement?.id === 'files-picker-input')), 'focus elsewhere');
    check('with nothing typed it lists pinned, then recent files', await waitFor(async () => { const h = await heads(); return h[0] === 'Pinned' && h.includes('Recent'); }), JSON.stringify(await heads()));
    const first = await names();
    check('…the pinned folder and file, and the file opened lately', ['docs', 'Loose Notes.txt', 'recent-thing.txt'].every((n) => first.includes(n)), JSON.stringify(first));
    check('the picker is a dialog with a listbox the search box controls', await ui.evaluate(() => document.querySelector('#files-picker [role=dialog]') !== null && document.getElementById('files-picker-results').getAttribute('role') === 'listbox' && document.getElementById('files-picker-input').getAttribute('aria-controls') === 'files-picker-results'), '');
    await ui.keyboard.press('Escape');
    check('Esc closes it', await waitFor(async () => !(await panelOpen())), 'still open');
    await rig.key('ui', 'F', ['control', 'shift']);
    check('Ctrl+Shift+F in the browser UI opens it too', await waitFor(panelOpen), 'not open');
    check('and it did not open Find in page', await ui.evaluate(() => !document.querySelector('#find-bar:not([hidden])')), '');

    // ---- searching ----
    await ui.type('#files-picker-input', 'chap slide', { delay: 20 });
    check('a query finds a file inside a pinned folder', await waitFor(async () => (await names()).includes('Chapter 4 slides.txt')), JSON.stringify(await names()));
    check('it is listed under "In pinned folders"', (await heads()).includes('In pinned folders'), JSON.stringify(await heads()));
    check('the matching letters are marked', await ui.evaluate(() => [...document.querySelectorAll('#files-picker-results mark')].map((m) => m.textContent).join('').toLowerCase().includes('chap')), await ui.evaluate(() => document.getElementById('files-picker-results').innerHTML.slice(0, 300)));
    check('the best match is selected first', (await selectedName()) === 'Chapter 4 slides.txt', await selectedName());
    await ui.fill('#files-picker-input', 'report');
    check('at most 30 rows are drawn', await waitFor(async () => (await names()).length > 0) && (await names()).length <= 30, String((await names()).length));
    check('there were more than 30 matches to choose from', (await rig.files('search', 'report')).length >= 30, '');
    await ui.fill('#files-picker-input', 'zzqqxx');
    check('no match says so', await waitFor(() => ui.evaluate(() => /No matching files/.test(document.querySelector('.files-picker-empty')?.textContent || ''))), '');
    await ui.fill('#files-picker-input', 'budget');
    check('ArrowDown and ArrowUp move the selection and wrap', await waitFor(async () => (await names()).includes('Budget 2026.txt')) && await (async () => {
      const n = (await names()).length;
      await ui.keyboard.press('ArrowUp');
      const wrapped = n > 1 ? (await selectedName()) === (await names())[n - 1] : true;
      await ui.keyboard.press('ArrowDown');
      return wrapped && (await selectedName()) === (await names())[0];
    })(), '');

    // ---- Enter, Ctrl+Enter, Alt+Enter ----
    await ui.fill('#files-picker-input', 'chapter slides');
    await waitFor(async () => (await selectedName()) === 'Chapter 4 slides.txt');
    const before = (await rig.tabs()).length;
    await ui.keyboard.press('Enter');
    check('Enter opens the file in a tab', await waitFor(async () => { const t = await rig.tabs(); return t.length === before + 1 && /Chapter%204%20slides\.txt$|Chapter 4 slides\.txt$/.test(t.find((x) => x.active)?.url || ''); }), JSON.stringify(await rig.tabs()));
    check('…and the picker closes', !(await panelOpen()), '');

    await rig.key('ui', 'F', ['control', 'shift']);
    await waitFor(panelOpen);
    await ui.fill('#files-picker-input', 'budget');
    await waitFor(async () => (await selectedName()) === 'Budget 2026.txt');
    await ui.keyboard.press('Control+Enter');
    check('Ctrl+Enter shows the file in its folder (and opens no tab)', await waitFor(async () => (await app.evaluate(() => global.__shown)).some((p) => /Budget 2026\.txt$/.test(p))) && (await rig.tabs()).length === before + 1, JSON.stringify(await app.evaluate(() => global.__shown)));
    check('…and the picker closes', await waitFor(async () => !(await panelOpen())), '');

    await rig.key('ui', 'F', ['control', 'shift']);
    await waitFor(panelOpen);
    await ui.fill('#files-picker-input', 'loose notes');
    await waitFor(async () => (await selectedName()) === 'Loose Notes.txt');
    await ui.keyboard.press('Alt+Enter');
    check('Alt+Enter attaches the file to the sidebar chat', await waitFor(() => ui.evaluate(() => /Loose Notes\.txt/.test(document.getElementById('attachments')?.textContent || '')), 10000), await ui.evaluate(() => document.getElementById('attachments')?.outerHTML.slice(0, 200)));
    check('…and the sidebar is showing', await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden'))), '');

    // ---- a missing file, and clicking ----
    fs.rmSync(loose, { force: true });
    await waitFor(async () => { const l = await rig.files('list'); return l.pinned.some((e) => e.name === 'Loose Notes.txt' && e.missing); }, 12000);
    await rig.key('ui', 'F', ['control', 'shift']);
    await waitFor(panelOpen);
    check('a missing file is greyed out in the picker and says why', await waitFor(() => ui.evaluate(() => { const r = [...document.querySelectorAll('.files-picker-item.missing')][0]; return Boolean(r) && /moved or deleted/.test(r.textContent); })), await ui.evaluate(() => document.getElementById('files-picker-results').textContent));
    await ui.evaluate(() => [...document.querySelectorAll('#files-picker-results .files-picker-item')].find((r) => r.querySelector('.files-picker-name').textContent === 'recent-thing.txt').click());
    check('a click on a row opens it', await waitFor(async () => (await rig.tabs()).length >= before + 2), JSON.stringify(await rig.tabs()));
    check('the click closes the picker', await waitFor(async () => !(await panelOpen())), '');
    await rig.key('ui', 'F', ['control', 'shift']);
    await waitFor(panelOpen);
    await ui.mouse.click(5, 5);
    check('a click outside the panel closes it', await waitFor(async () => !(await panelOpen())), '');
    check('no page errors', rig.errors.length === 0, rig.errors.join(' | '));
  } finally {
    await rig.stop();
  }
  console.log(state.failures ? `\n${state.failures} failed` : '\nall passed');
  process.exit(state.failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
