// Hidden run: Quick notes in the real window (profile in a temp folder, no network, no key). Everything here is a note the test wrote.
//   - the Notes panel is not loaded at startup; More → Notes loads and opens it
//   - New note, typing, autosave (a debounced, atomic write: notes.json holds the text, no .tmp file is left)
//   - the list shows it, search finds it by a word, Preview draws the Markdown
//   - "Add to notes" under an AI reply (text with a diagram) and on a generated picture; "Add to notes" on selected page text
//   - Ask AI sends the note to the chat
//   - after a restart (same profile) the notes are still there
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="40" height="20"><rect width="40" height="20" fill="#9cf"/><circle cx="10" cy="10" r="5" fill="#fc3"/></svg>';
const REPLY = `Photosynthesis turns light into sugar.\n\n\`\`\`svg\n${SVG}\n\`\`\`\n`;
// A 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-notes-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-notes-tmp-'));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', TEMP: temp, TMP: temp, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  let app = await launch();
  try {
    let ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    const notesFile = path.join(userData, 'notes.json');
    const onDisk = () => { try { return JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes; } catch { return []; } };

    check('notes.js is not loaded at startup', await ui.evaluate(() => !window.notesUi && !document.querySelector('link[href="notes.css"]')));
    await ui.evaluate(() => document.getElementById('notes-btn').click());
    await ui.waitForFunction(() => window.notesUi && !document.getElementById('notes-panel').hidden, null, { timeout: 15000 }).catch(() => {});
    check('More → Notes loads the panel and shows it', await ui.evaluate(() => Boolean(window.notesUi) && !document.getElementById('notes-panel').hidden && document.querySelector('.nt-new') !== null));
    check('with no notes the panel says how to start', await ui.evaluate(() => /No notes yet/.test(document.querySelector('#notes-panel .chat-list-empty')?.textContent || '')));

    // create, type, autosave
    await ui.click('.nt-new');
    await ui.waitForSelector('#nt-text');
    await ui.fill('#nt-text', '# Biology\n\nCells have **membranes**.\n\n- nucleus\n- cytoplasm');
    const saved = await waitFor(() => ui.evaluate(() => /Saved/.test(document.querySelector('.nt-status')?.textContent || '')));
    check('it saves by itself and says Saved', Boolean(saved));
    check('notes.json holds the text', onDisk().length === 1 && /Cells have \*\*membranes\*\*/.test(onDisk()[0].text), JSON.stringify(onDisk()));
    check('no temporary file is left in the profile', fs.readdirSync(userData).every((f) => !/^notes\.json\..*\.tmp$/.test(f)), fs.readdirSync(userData).join());

    // preview
    await ui.click('.nt-preview');
    const html = await ui.evaluate(() => document.querySelector('.nt-body')?.innerHTML || '');
    check('Preview draws the Markdown (heading, bold, list)', /<h1/.test(html) && /<strong>membranes<\/strong>/.test(html) && /<li>/.test(html), html.slice(0, 300));
    check('the editor is hidden while previewing', await ui.evaluate(() => document.getElementById('nt-text').hidden));
    await ui.click('.nt-write');

    // list and search
    await ui.click('.nt-back');
    await ui.waitForSelector('.nt-row');
    check('the list shows the note by its first line', (await ui.evaluate(() => document.querySelector('.nt-title')?.textContent)) === 'Biology');
    await ui.fill('#nt-search', 'cytoplasm');
    check('search finds it by a word inside', Boolean(await waitFor(() => ui.evaluate(() => document.querySelectorAll('.nt-row').length === 1))));
    await ui.fill('#nt-search', 'zebra');
    check('search with no match says so', Boolean(await waitFor(() => ui.evaluate(() => /No notes match/.test(document.querySelector('#notes-panel .chat-list-empty')?.textContent || '')))));
    await ui.fill('#nt-search', '');
    await ui.waitForSelector('.nt-row');
    await ui.click('.nt-open');
    await ui.waitForSelector('#nt-text');

    // Add to notes under a reply (with a diagram)
    await ui.evaluate((reply) => {
      const b = document.createElement('div');
      b.className = 'msg assistant';
      b.id = 'test-reply';
      b.innerHTML = '<p>Photosynthesis turns light into sugar.</p>';
      document.getElementById('messages').append(b);
      window.finishReply(b, reply);
    }, REPLY);
    check('a reply has an Add to notes button', await ui.evaluate(() => Boolean(document.querySelector('#test-reply .reply-note'))));
    await ui.evaluate(() => document.querySelector('#test-reply .reply-note').click());
    await waitFor(() => onDisk()[0] && /Photosynthesis/.test(onDisk()[0].text));
    const afterReply = onDisk();
    check('Add to notes puts the reply into the open note, after what was there', afterReply.length === 1 && /nucleus[\s\S]*\n\nPhotosynthesis turns light into sugar\.[\s\S]*```svg\n<svg/.test(afterReply[0].text), JSON.stringify(afterReply).slice(0, 500));
    check('the open editor takes what was added', await waitFor(() => ui.evaluate(() => /Photosynthesis/.test(document.getElementById('nt-text')?.value || ''))));
    await ui.click('.nt-preview');
    check('the diagram is drawn as a picture in the preview', Boolean(await waitFor(() => ui.evaluate(() => document.querySelector('.nt-body .svg-view img') !== null))));
    await ui.click('.nt-write');

    // a generated picture
    const pic = await app.evaluate((_e, b64) => global.__imageStore().save('1', Buffer.from(b64, 'base64'), { alt: 'A dot' }), PNG.toString('base64'));
    const gi = await ui.evaluate((id) => window.assistant.notes.act('add-image', { id, alt: 'A dot' }), pic.id);
    check('a generated picture can be added', gi.ok, JSON.stringify(gi));
    await waitFor(() => onDisk()[0] && /note-image:/.test(onDisk()[0].text));
    await ui.click('.nt-preview');
    check('the picture shows in the preview', Boolean(await waitFor(() => ui.evaluate(() => { const i = document.querySelector('.nt-body .nt-pic img'); return i && /^data:image\/png/.test(i.src); }))));
    await ui.click('.nt-write');

    // selected page text, from the page's right-click menu
    await app.evaluate(() => { global.__menu = null; global.__captureContextMenu = (items) => { global.__menu = items; }; });
    const labels = await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => /newtab/i.test(w.getURL()));
      if (!wc) return null;
      wc.emit('context-menu', { preventDefault() {} }, { x: 5, y: 5, selectionText: 'Chlorophyll absorbs red and blue light.', isEditable: false, mediaType: 'none', srcURL: '', linkURL: '', mediaFlags: {}, editFlags: {}, dictionarySuggestions: [], misspelledWord: '', frame: null });
      return (global.__menu || []).map((i) => i.label || i.role || i.type);
    });
    check('selected text has "Add to notes" in the right-click menu', Array.isArray(labels) && labels.includes('Add to notes'), JSON.stringify(labels));
    await app.evaluate(() => { global.__menu.find((i) => i.label === 'Add to notes').click(); global.__captureContextMenu = null; });
    check('clicking it adds the selection as a quotation', Boolean(await waitFor(() => onDisk()[0] && /> Chlorophyll absorbs red and blue light\./.test(onDisk()[0].text))), JSON.stringify(onDisk()).slice(0, 300));

    // Ask AI
    await ui.evaluate(() => { window.__asked = null; window.ask = (text) => { window.__asked = text; }; });
    await ui.fill('#nt-question', 'What is missing?');
    await ui.click('.nt-ask-btn');
    const asked = await waitFor(() => ui.evaluate(() => window.__asked));
    check('Ask AI sends the note and the question to the chat', typeof asked === 'string' && /Biology/.test(asked) && /Chlorophyll/.test(asked) && /What is missing\?/.test(asked), asked);
    check('the panel closes so the chat shows', await ui.evaluate(() => document.getElementById('notes-panel').hidden));

    // the AI's tool, through the real agent
    const tool = await app.evaluate(async () => {
      const a = global.__agent;
      const store = global.__notesStore();
      const before = store.count();
      const out = await a.notesTool.call({ browser: a.browser }, { action: 'list' }).catch((e) => ({ error: e.message }));
      return { before, out };
    });
    check('the notes tool refuses to run outside a chat', Boolean(tool.out?.error), JSON.stringify(tool));

    // a second note, then a restart
    await ui.evaluate(() => window.notesUi.open());
    await ui.evaluate(() => window.assistant.notes.act('new', { text: 'Second note about chemistry' }));
    check('there are two notes on disk', Boolean(await waitFor(() => onDisk().length === 2)), JSON.stringify(onDisk().map((n) => n.text.slice(0, 20))));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await app.close();
    app = await launch();
    ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('notes-btn').click());
    await ui.waitForSelector('.nt-row', { timeout: 15000 }).catch(() => {});
    const titles = await ui.evaluate(() => [...document.querySelectorAll('.nt-title')].map((n) => n.textContent));
    check('after a restart both notes are in the list', titles.includes('Biology') && titles.includes('Second note about chemistry'), JSON.stringify(titles));
    await ui.click('.nt-row:has(.nt-title:text-is("Biology")) .nt-open');
    await ui.waitForSelector('#nt-text');
    check('and the text is whole', await ui.evaluate(() => /Cells have \*\*membranes\*\*/.test(document.getElementById('nt-text').value) && /Chlorophyll/.test(document.getElementById('nt-text').value)));
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
