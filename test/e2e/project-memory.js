// [project memory] A project's own memory in a real (invisible) window with a fake model:
//  - the AI's save in a project chat that nearly repeats a note updates that note (one entry, shown as an update);
//  - the next chat of the project gets the pinned note first, then the one that shares words with its first message, and the
//    note asking the AI to save the project's lasting facts; a chat outside the project gets neither;
//  - the project page's Memory card: Add a note, edit one in place, Pin / Unpin, Forget (two clicks), the filter once there are
//    many, Show all, and the "haven't changed in 6 months" line whose Forget them clears what is stale.
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
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('aiMemory', true); });
    await app.evaluate(() => {
      const fake = global.__fake = { requests: [] };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const last = params.messages[params.messages.length - 1];
        const blocks = Array.isArray(last?.content) ? last.content : [];
        const result = blocks.find((b) => b.type === 'tool_result');
        const typed = JSON.stringify(last?.content || '');
        fake.requests.push({ system: (params.system || []).map((s) => s.text).join('\n') });
        let content; let stop = 'end_turn';
        if (result) content = [{ type: 'text', text: 'Done.' }];
        else if (/SAVEAGAIN/.test(typed)) { content = [{ type: 'tool_use', id: 'toolu_m2', name: 'memory', input: { action: 'add', text: 'The robot arm budget is 4000 dollars, approved', kind: 'note' } }]; stop = 'tool_use'; }
        else if (/SAVEPLACE/.test(typed)) { content = [{ type: 'tool_use', id: 'toolu_p1', name: 'memory', input: { action: 'place', location: 'https://docs.google.com/spreadsheets/d/1PartsListSheet9/edit', text: 'Parts list' } }]; stop = 'tool_use'; }
        else if (/SAVEBUDGET/.test(typed)) { content = [{ type: 'tool_use', id: 'toolu_m1', name: 'memory', input: { action: 'add', text: 'The robot arm budget is 4000 dollars', kind: 'note' } }]; stop = 'tool_use'; }
        else content = [{ type: 'text', text: 'Plain reply.' }];
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 10, output_tokens: 5 } };
        return { async *[Symbol.asyncIterator]() { if (content[0].type === 'text') yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content[0].text } }; }, finalMessage: async () => message };
      } } } });
    });
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const api = (call, ...args) => inPage(`window.assistant.chats.${call}(...${JSON.stringify(args)})`);
    const send = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    const live = () => app.evaluate(() => global.__tabChats.runs().filter((r) => r.live).length);
    const settled = async () => { await waitFor(async () => (await live()) === 0, 15000); await sleep(300); };
    const lastRequest = () => app.evaluate(() => global.__fake.requests[global.__fake.requests.length - 1]);
    const entries = () => app.evaluate(() => global.__projectWorkspace.memoryEntries());
    const startIn = (pid) => inPage(`(async () => { document.querySelector('.cp-pj-item[data-project="${pid}"] .cp-pj-new').click(); await new Promise((r) => setTimeout(r, 900)); return true; })()`);

    const project = await api('saveProject', { name: 'Robot arm', folderMode: 'none' });
    await waitFor(() => inPage(`Boolean(document.querySelector('.cp-pj-item[data-project="${project.id}"]'))`));

    // ======== the AI saves, and a near-repeat updates the same note ========
    await startIn(project.id);
    await send('SAVEBUDGET please');
    await settled();
    await startIn(project.id);
    await send('SAVEAGAIN please');
    await settled();
    const saved = (await entries()).filter((e) => e.project === project.id);
    check('a near-repeat of a project note updates it: one entry, with the newer text', saved.length === 1 && /approved/.test(saved[0].text), JSON.stringify(saved));

    // ======== what the next chat gets ========
    const pin = await api('projectMemory', project.id, { add: 'Always answer in metric units' });
    await api('projectMemory', project.id, { add: 'The demo is in the Snell Library lobby' });
    await api('projectMemory', project.id, { add: 'Sam owns the gripper design work' });
    const pinId = pin.memory.find((e) => /metric/.test(e.text)).id;
    const pinned = await api('projectMemory', project.id, { pin: { id: pinId, on: true } });
    check('Pin through the page API marks the note and lists it first', pinned.ok && pinned.memory[0].id === pinId && pinned.memory[0].pinned === true, JSON.stringify(pinned));
    await startIn(project.id);
    await send('Where is the demo again?');
    await settled();
    const sys = (await lastRequest()).system;
    const at = ['Always answer in metric units', 'Snell Library', 'gripper'].map((t) => sys.indexOf(t));
    check('the next project chat: pinned first, then the note that matches the first message, then the rest', at.every((n, i) => n > 0 && (i === 0 || n > at[i - 1])), JSON.stringify(at));
    check('...and it is asked to save the project\'s lasting facts on its own', /This chat is in a project/.test(sys));
    await inPage("document.getElementById('new-chat').click()");
    await sleep(400);
    await send('plain question');
    await settled();
    const outside = (await lastRequest()).system;
    check('a chat outside the project gets neither', !/Snell Library/.test(outside) && !/This chat is in a project/.test(outside));

    // ======== the Memory card ========
    await inPage(`document.querySelector('.cp-pj-item[data-project="${project.id}"] .cp-pj').click()`);
    await waitFor(() => inPage("Boolean(document.querySelector('#cp-project-page .pjp-memory .pjp-row'))"), 15000);
    const card = (code) => inPage(`(() => { const c = document.querySelector('#cp-project-page .pjp-memory'); ${code} })()`);
    check('the card lists the project\'s notes, pinned first with a Pinned mark', (await card("return [...c.querySelectorAll('.pjp-row')].length")) === 4 && (await card("return c.querySelector('.pjp-row').classList.contains('pinned') && /Pinned/.test(c.querySelector('.pjp-row').textContent)")) === true);
    await card("[...c.querySelectorAll('.pjp-card-head button')].find((b) => b.textContent === 'Add').click()");
    await waitFor(() => card("return Boolean(c.querySelector('.pjp-memory-add .pjp-input'))"));
    await card("const i = c.querySelector('.pjp-memory-add .pjp-input'); i.value = 'Parts order goes out on Friday'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));");
    check('Add saves a note you write yourself', await waitFor(async () => (await entries()).some((e) => e.project === project.id && /Parts order goes out on Friday/.test(e.text) && e.source === 'you')), JSON.stringify(await entries()));
    check('...and the card shows it', await waitFor(() => card("return /Parts order/.test(c.textContent) && c.querySelector('.pjp-memory-add').hidden")));
    await card("[...c.querySelectorAll('.pjp-row-text')].find((t) => /Sam owns/.test(t.textContent)).click()");
    await waitFor(() => card("return Boolean(c.querySelector('.pjp-memory-edit .pjp-input'))"));
    await card("const i = c.querySelector('.pjp-memory-edit .pjp-input'); i.value = 'Priya owns the gripper design work'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));");
    check('clicking a note edits it in place; Enter saves', await waitFor(async () => (await entries()).some((e) => /Priya owns/.test(e.text)) && !(await entries()).some((e) => /Sam owns/.test(e.text))));
    await card("[...c.querySelectorAll('.pjp-row')].find((r) => /Snell/.test(r.textContent)).querySelector('.pjp-memory-pin').click()");
    check('Pin on a row pins it', await waitFor(async () => (await entries()).find((e) => /Snell/.test(e.text))?.pinned === true));
    await card("[...c.querySelectorAll('.pjp-row')].find((r) => /Snell/.test(r.textContent)).querySelector('.pjp-memory-pin').click()");
    check('...and Unpin takes it off', await waitFor(async () => !(await entries()).find((e) => /Snell/.test(e.text))?.pinned));
    await card("const b = [...c.querySelectorAll('.pjp-row')].find((r) => /Parts order/.test(r.textContent)).querySelector('button:last-child'); b.click();");
    check('Forget asks for a second click', (await entries()).some((e) => /Parts order/.test(e.text)) && (await card("return [...c.querySelectorAll('.pjp-row')].some((r) => /Click again/.test(r.textContent))")) === true);
    await card("[...c.querySelectorAll('.pjp-row')].find((r) => /Parts order/.test(r.textContent)).querySelector('button:last-child').click()");
    check('...then forgets the note', await waitFor(async () => !(await entries()).some((e) => /Parts order/.test(e.text))));

    // many notes: filter and Show all; old ones: the tidy line
    for (let i = 0; i < 9; i++) await api('projectMemory', project.id, { add: `Sensor ${i} calibrated on bench ${i * 7}` });
    await app.evaluate((_e, pid) => { // (two notes made old: as if untouched for 7 months)
      const list = global.__projectWorkspace.memoryEntries().filter((e) => e.project === pid && /Sensor [01] /.test(e.text));
      global.__projectMemoryAge?.(list.map((e) => e.id), 210);
    }, project.id);
    await inPage(`document.querySelector('.cp-pj-item[data-project="${project.id}"] .cp-pj').click()`);
    await waitFor(() => card("return c.querySelectorAll('.pjp-row').length === 8"), 15000);
    check('with many notes the card shows 8 and a Show all link with the count', (await card("return c.querySelectorAll('.pjp-row').length")) === 8 && (await card("return c.querySelector('.pjp-memory-more').textContent")) === 'Show all 13', await card("return c.querySelector('.pjp-memory-more').textContent"));
    check('...and a filter', (await card("return !c.querySelector('.pjp-memory-filter').hidden")) === true);
    await card("const f = c.querySelector('.pjp-memory-filter'); f.value = 'bench 14'; f.dispatchEvent(new Event('input'));");
    check('the filter narrows the list', (await card("return [...c.querySelectorAll('.pjp-row')].map((r) => r.textContent).join('|')")).includes('Sensor 2') && (await card("return c.querySelectorAll('.pjp-row').length")) === 1);
    await card("const f = c.querySelector('.pjp-memory-filter'); f.value = ''; f.dispatchEvent(new Event('input')); c.querySelector('.pjp-memory-more').click();");
    check('Show all lists every note', (await card("return c.querySelectorAll('.pjp-row').length")) === 13);
    check('notes untouched for 6 months get a tidy line', (await card("return !c.querySelector('.pjp-memory-tidy').hidden && /2 notes haven’t changed in 6 months/.test(c.querySelector('.pjp-memory-tidy').textContent)")) === true, await card("return c.querySelector('.pjp-memory-tidy').textContent"));
    await card("c.querySelector('.pjp-memory-tidy-btn').click(); c.querySelector('.pjp-memory-tidy-btn').click();");
    check('Forget them forgets just those', await waitFor(async () => { const mine = (await entries()).filter((e) => e.project === project.id); return mine.length === 11 && !mine.some((e) => /Sensor [01] /.test(e.text)); }), JSON.stringify((await entries()).map((e) => e.text)));
    check('...and the line goes away', await waitFor(() => card("return c.querySelector('.pjp-memory-tidy').hidden")));

    // ======== Key documents ========
    await startIn(project.id);
    await send('SAVEPLACE the parts list is in that sheet');
    await settled();
    const placesNow = () => app.evaluate((_e, pid) => global.__projectPlaces.store().list(pid), project.id);
    check("the memory tool's place keeps where the parts list is, named", (await placesNow()).some((p) => p.label === 'Parts list' && p.kind === 'drive'), JSON.stringify(await placesNow()));
    await app.evaluate((_e, pid) => { for (let i = 0; i < 3; i++) global.__projectPlaces.record(pid, { name: 'read_urls', input: { urls: ['https://wiki.example.edu/robotics/arm-specs', 'https://wiki.example.edu/robotics/wiring'] }, result: '' }); global.__projectPlaces.record(pid, { name: 'navigate', input: { url: 'https://www.google.com/search?q=arm' }, result: '' }); }, project.id);
    const kept = await placesNow();
    check('pages a project chat read are recorded, with their site under Where things are; a search is not', kept.some((p) => /arm-specs/.test(p.loc)) && kept.some((p) => p.kind === 'site' && p.label === 'wiki.example.edu') && !kept.some((p) => /google\.com\/search/.test(p.loc)), JSON.stringify(kept.map((p) => p.loc)));
    await app.evaluate((_e, pid) => global.__projectPlaces.record(pid, { name: 'read_urls', input: { urls: ['https://wiki.example.edu/robotics/wiring'] }, error: 'HTTP 404 Not Found' }), project.id);
    check('a link a call found dead is dropped', !(await placesNow()).some((p) => /wiring/.test(p.loc)));
    await startIn(project.id);
    await send('Where are the parts?');
    await settled();
    const withPlaces = (await lastRequest()).system;
    check('the next project chat gets the list, the matching document first', /<project_places>/.test(withPlaces) && withPlaces.indexOf('Parts list') < withPlaces.indexOf('arm-specs') && withPlaces.indexOf('Parts list') > withPlaces.indexOf('<project_places>'), withPlaces.slice(withPlaces.indexOf('<project_places>'), withPlaces.indexOf('<project_places>') + 600));
    await inPage("document.getElementById('new-chat').click()");
    await sleep(400);
    await send('unrelated');
    await settled();
    check('a chat outside the project does not', !/<project_places>/.test((await lastRequest()).system));
    await inPage(`document.querySelector('.cp-pj-item[data-project="${project.id}"] .cp-pj').click()`);
    await waitFor(() => inPage("Boolean(document.querySelector('#cp-project-page .pjp-places .pjp-place'))"), 15000);
    const docs = (code) => inPage(`(() => { const c = document.querySelector('#cp-project-page .pjp-places'); ${code} })()`);
    check('the Key documents card lists them, Where things are below', (await docs("return [...c.querySelectorAll('.pjp-places-docs .pjp-place-name')].map((n) => n.textContent).includes('Parts list') && /Where things are/.test(c.textContent) && /wiki\\.example\\.edu/.test(c.querySelector('.pjp-places-spots').textContent)")) === true, await docs('return c.innerText'));
    await docs("[...c.querySelectorAll('.pjp-place-name')].find((n) => n.textContent === 'Parts list').click()");
    await docs("const i = c.querySelector('.pjp-place .pjp-input'); i.value = 'Robot arm parts list'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));");
    check('clicking a name renames it', await waitFor(async () => (await placesNow()).some((p) => p.label === 'Robot arm parts list' && p.named)));
    await docs("[...c.querySelectorAll('.pjp-place')].find((r) => /arm-specs/.test(r.textContent)).querySelector('.pjp-place-pin').click()");
    check('Pin pins it and puts it first', await waitFor(async () => { const l = await placesNow(); return l[0]?.pinned && /arm-specs/.test(l[0].loc); }));
    await waitFor(() => docs("return /arm-specs/.test(c.querySelector('.pjp-place').textContent)"));
    await docs("[...c.querySelectorAll('.pjp-place')].find((r) => /Robot arm parts list/.test(r.textContent)).querySelector('.pjp-place-remove').click()");
    check('Remove takes it off the list', await waitFor(async () => !(await placesNow()).some((p) => /Parts list/i.test(p.label))));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
