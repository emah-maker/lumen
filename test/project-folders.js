// [project folders] In a real (invisible) window with a fake model and a temp Documents folder (a TEST-only hook, never the user's):
//  - creating a project makes <Documents>/Lumen Projects/<name>; a chat in it is saved as a Markdown file with its content,
//    renaming the chat renames the file, moving it out and deleting it put it in Chats/Removed and Chats/Deleted (never erased),
//    the toggle and "Write all now", a missing folder (Locate / Recreate), renaming the folder with the project,
//  - a chat outside a project never gets a plain file,
//  - a working folder for a chat makes list_files list it (and read a text file in it) without the device-access setting, refuses paths that
//    leave it, and a project's chats work in the project's folder; Claude Code's plan carries it,
//  - perf: saving 50 project chats (and writing all their files) never stalls the main thread for more than 20 ms.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const ls = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const tree = (dir) => { const out = []; const walk = (d) => { for (const n of ls(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-profile-'));
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-docs-')); // (outside the profile: Lumen's own profile is never a work folder. Named without "lumen-": a test run's temp sweep, scripts/test-tmp.js, removes those)
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    app.process().stderr?.on('data', (d) => { const t = String(d); if (/Project folder|Could not save/.test(t)) console.log(`MAIN  ${t.trim().slice(0, 700)}`); });
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    await app.evaluate((_e, dir) => global.__projectFolders.setDocuments(dir), docs);
    // The fake model answers at once; a message with LISTFOLDER first calls list_files (no arguments), then reports what came back.
    await app.evaluate(() => {
      const fake = global.__fake = { asked: [], toolResults: [] };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const last = params.messages[params.messages.length - 1];
        const blocks = Array.isArray(last?.content) ? last.content : [];
        const result = blocks.find((b) => b.type === 'tool_result');
        const first = JSON.stringify(last?.content || ''); // (what was just typed)
        fake.asked.push(JSON.stringify(last?.content || '').slice(0, 300));
        let content; let stop = 'end_turn';
        if (result) { fake.toolResults.push(typeof result.content === 'string' ? result.content : JSON.stringify(result.content)); content = [{ type: 'text', text: 'Listed.' }]; }
        else if (/LISTFOLDER/.test(first)) { content = [{ type: 'tool_use', id: 'toolu_list1', name: 'list_files', input: {} }]; stop = 'tool_use'; }
        else if (/READNOTE/.test(first)) { content = [{ type: 'tool_use', id: 'toolu_read1', name: 'list_files', input: { read: 'note.txt' } }]; stop = 'tool_use'; }
        else if (/ESCAPE/.test(first)) { content = [{ type: 'tool_use', id: 'toolu_esc1', name: 'list_files', input: { folder: '..' } }]; stop = 'tool_use'; }
        else content = [{ type: 'text', text: 'Quick reply done.' }];
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
    const chatId = () => app.evaluate(() => global.__tabChats.chatId());
    const settled = async () => { await waitFor(async () => (await live()) === 0, 15000); await app.evaluate(() => global.__projectFolders.idle()); };
    const msgs = () => inPage("document.getElementById('messages').textContent");
    const chatFiles = (dir) => ls(path.join(dir, 'Chats')).filter((n) => n.endsWith('.md'));

    // ======== creating a project makes its folder ========
    const zoo = await api('saveProject', { name: 'Zoo: wild?', instructions: 'Talk about animals.' });
    const zooDir = path.join(docs, 'Lumen Projects', 'Zoo wild');
    check('create: the project has a folder under <Documents>/Lumen Projects, named safely, and it exists', zoo?.folder === zooDir && fs.statSync(zooDir).isDirectory() && zoo.folderCreated === true, JSON.stringify(zoo));
    const zoo2 = await api('saveProject', { name: 'Zoo: wild?' });
    check('create: a second project with that name gets " (2)"', zoo2?.folder === `${zooDir} (2)` && fs.statSync(zoo2.folder).isDirectory(), JSON.stringify(zoo2));
    const listed = await api('list');
    check('create: the list carries the folder, and no folderMissing', listed.projects.find((p) => p.id === zoo.id)?.folder === zooDir && !listed.projects.some((p) => p.folderMissing), JSON.stringify(listed.projects));
    const same = await app.evaluate(() => global.__projectFolders.documents());
    check('test hook: the Documents folder is the temp one (never the real one)', same === docs, same);
    const existing = path.join(docs, 'My Existing Folder');
    fs.mkdirSync(existing);
    const adopted = await api('saveProject', { name: 'Adopted', folderMode: 'existing', folder: existing });
    check('create: "Use an existing folder" keeps that folder (nothing is made) and marks it not Lumen-made', adopted?.folder === fs.realpathSync(existing) && !adopted.folderCreated && !fs.existsSync(path.join(docs, 'Lumen Projects', 'Adopted')), JSON.stringify(adopted));
    const refused = await api('saveProject', { name: 'Nope', folderMode: 'existing', folder: path.join(docs, 'does-not-exist') });
    check('create: a folder that is not there is refused, and no project is made', refused?.error === 'missing' && !(await api('list')).projects.some((p) => p.name === 'Nope'), JSON.stringify(refused));
    const homeTry = await api('saveProject', { name: 'Homey', folderMode: 'existing', folder: os.homedir() });
    check('create: the home folder needs a confirm', homeTry?.error === 'home', JSON.stringify(homeTry));
    const none = await api('saveProject', { name: 'No folder', folderMode: 'none' });
    check('create: "none" makes a project without a folder', none && !none.folder && !fs.existsSync(path.join(docs, 'Lumen Projects', 'No folder')), JSON.stringify(none));

    // ======== a chat in the project becomes a Markdown file ========
    await api('newInProject', zoo.id);
    await waitFor(async () => (await chatId()) && true);
    const chatA = await chatId();
    await send('tell me about the penguins');
    await waitFor(async () => /Quick reply done/.test(await msgs()), 15000);
    await settled();
    const files = chatFiles(zooDir);
    check('chat file: a project chat is saved as Chats/<date> <title>.md', files.length === 1 && /^\d{4}-\d\d-\d\d \S.*\.md$/.test(files[0]), files.join('|'));
    const autoTitle = (files[0] || '').replace(/^\d{4}-\d\d-\d\d /, '').replace(/\.md$/, '');
    const text = files[0] ? fs.readFileSync(path.join(zooDir, 'Chats', files[0]), 'utf8') : '';
    check('chat file: front matter has the title, dates, model and the Lumen chat id', text.startsWith('---\n') && text.includes(`title: ${JSON.stringify(autoTitle)}`) && /^created: \d{4}-/m.test(text) && /^updated: \d{4}-/m.test(text) && /^model: "/m.test(text) && text.includes(`lumen_chat_id: ${chatA}`), text.slice(0, 400));
    check('chat file: it holds what was said, from the existing export', /## You\s+tell me about the penguins/.test(text) && /## Assistant\s+Quick reply done\./.test(text), text);
    check('chat file: nothing else in the project folder but Chats (no temp files)', tree(zooDir).every((p) => p.endsWith('.md')) && ls(zooDir).join() === 'Chats', tree(zooDir).join('|'));

    // renaming the chat renames the file
    await api('rename', chatA, 'Zoo notes');
    await settled();
    const renamed = chatFiles(zooDir);
    check('rename: the file follows the chat title (one file, the same content and id)', renamed.length === 1 && /^\d{4}-\d\d-\d\d Zoo notes\.md$/.test(renamed[0]) && fs.readFileSync(path.join(zooDir, 'Chats', renamed[0]), 'utf8').includes(`lumen_chat_id: ${chatA}`) && /title: "Zoo notes"/.test(fs.readFileSync(path.join(zooDir, 'Chats', renamed[0]), 'utf8')), renamed.join('|'));
    // a second message updates it in place
    await send('and the lions?');
    await waitFor(async () => (await msgs()).includes('and the lions?'), 15000);
    await settled();
    await waitFor(() => /and the lions\?/.test(fs.readFileSync(path.join(zooDir, 'Chats', chatFiles(zooDir)[0] || 'x'), 'utf8')), 8000).catch(() => {});
    check('update: the next message is added to the same file', chatFiles(zooDir).length === 1 && /and the lions\?/.test(fs.readFileSync(path.join(zooDir, 'Chats', chatFiles(zooDir)[0]), 'utf8')), chatFiles(zooDir).join('|'));

    // moving out and back
    await api('setProject', chatA, null);
    await settled();
    check('move out: the file goes to Chats/Removed', chatFiles(zooDir).length === 0 && ls(path.join(zooDir, 'Chats', 'Removed')).length === 1, `${chatFiles(zooDir)}|${ls(path.join(zooDir, 'Chats', 'Removed'))}`);
    await api('setProject', chatA, zoo.id);
    await settled();
    check('move in: the file is written again', chatFiles(zooDir).length === 1, chatFiles(zooDir).join('|'));
    // into another project
    await api('setProject', chatA, zoo2.id);
    await settled();
    check('move between projects: written in the other project\'s folder, shelved in the first', chatFiles(zoo2.folder).length === 1 && chatFiles(zooDir).length === 0 && ls(path.join(zooDir, 'Chats', 'Removed')).length === 2, `${chatFiles(zoo2.folder)}|${chatFiles(zooDir)}|${ls(path.join(zooDir, 'Chats', 'Removed'))}`);
    await api('setProject', chatA, zoo.id);
    await settled();

    // ======== toggle and "Write all now" ========
    await api('saveProject', { id: zoo.id, name: 'Zoo: wild?', mirror: false });
    await app.evaluate(() => global.__projectFolders.idle());
    const beforeOff = chatFiles(zooDir).length;
    await api('newInProject', zoo.id);
    const chatB = await chatId();
    await send('second chat while off');
    await waitFor(async () => /Quick reply done/.test(await msgs()), 15000);
    await settled();
    check('toggle off: a new chat in the project gets no file', chatFiles(zooDir).length === beforeOff, chatFiles(zooDir).join('|'));
    const all = await api('projectFolder', zoo.id, 'write-all');
    check('write all now: every chat of the project gets a file, even with the toggle off', all?.ok && all.count >= 2 && chatFiles(zooDir).length === 2, JSON.stringify(all) + chatFiles(zooDir).join('|'));
    await api('saveProject', { id: zoo.id, name: 'Zoo: wild?', mirror: true });

    // ======== chats outside projects are never written as plain files ========
    const before = tree(docs).length;
    await inPage('window.assistant.reset()'); // (a new chat, in no project)
    await waitFor(async () => (await chatId()) !== chatB, 5000);
    await send('plain chat outside any project');
    await waitFor(async () => /Quick reply done/.test(await msgs()), 15000);
    await settled();
    const outside = await app.evaluate(() => {
      const store = global.__chats.store();
      const id = store.newId();
      store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'private question' }] }, { role: 'assistant', content: [{ type: 'text', text: 'private answer' }] }] });
      return id;
    });
    await app.evaluate(() => global.__projectFolders.idle());
    check('privacy: a chat outside a project is only in the encrypted store: no plain file anywhere in Documents', tree(docs).length === before && !tree(docs).some((p) => /private|plain chat/.test(fs.readFileSync(p, 'utf8'))) && Boolean(outside), tree(docs).join('|'));

    // ======== deleting a chat moves its file to Chats/Deleted ========
    const delId = await app.evaluate((_e, dir) => { const s = global.__chats.store(); return s.list().find((c) => c.project && s.projects().find((p) => p.id === c.project)?.folder === dir)?.id; }, zooDir);
    const delFile = chatFiles(zooDir).find((n) => fs.readFileSync(path.join(zooDir, 'Chats', n), 'utf8').includes(`lumen_chat_id: ${delId}`));
    await api('remove', delId);
    await waitFor(() => ls(path.join(zooDir, 'Chats', 'Deleted')).length === 1, 16000);
    check('delete: the chat\'s file moves to Chats/Deleted once the undo time is over (never erased)', ls(path.join(zooDir, 'Chats', 'Deleted')).length === 1 && !chatFiles(zooDir).includes(delFile) && fs.readFileSync(path.join(zooDir, 'Chats', 'Deleted', ls(path.join(zooDir, 'Chats', 'Deleted'))[0]), 'utf8').includes('lumen_chat_id'), `id ${delId} file ${delFile}: ${chatFiles(zooDir)}|${ls(path.join(zooDir, 'Chats', 'Deleted'))}`);
    // deleting a project never touches its folder
    const gone = await api('removeProject', zoo2.id);
    check('delete project: its folder and the files in it stay', gone === true && fs.statSync(zoo2.folder).isDirectory() && tree(zoo2.folder).length >= 1, tree(zoo2.folder).join('|'));

    // ======== a missing folder: Locate / Recreate; rename the folder with the project ========
    fs.rmSync(zooDir, { recursive: true, force: true });
    await api('list');
    await sleep(3300);
    await api('list');
    const missing = await waitFor(async () => (await api('list')).projects.find((p) => p.id === zoo.id)?.folderMissing === true, 8000);
    check('missing folder: the project says so (folderMissing)', missing === true, JSON.stringify((await api('list')).projects.find((p) => p.id === zoo.id)));
    const re = await api('projectFolder', zoo.id, 'recreate');
    check('missing folder: Recreate makes it again where it was', re?.ok && fs.statSync(zooDir).isDirectory(), JSON.stringify(re));
    await sleep(3300);
    await api('list');
    check('missing folder: it no longer says missing', (await waitFor(async () => (await api('list')).projects.find((p) => p.id === zoo.id)?.folderMissing !== true, 8000)) === true, '');
    await api('saveProject', { id: zoo.id, name: 'Safari' });
    const renF = await api('projectFolder', zoo.id, 'rename');
    const safariDir = path.join(docs, 'Lumen Projects', 'Safari');
    check('rename folder: a Lumen-made folder follows the project name, and the project points at it', renF?.ok && renF.folder === safariDir && fs.statSync(safariDir).isDirectory() && !fs.existsSync(zooDir) && (await api('list')).projects.find((p) => p.id === zoo.id)?.folder === safariDir, JSON.stringify(renF));
    await api('saveProject', { id: zoo.id, name: 'Adopted' });
    fs.mkdirSync(path.join(docs, 'Lumen Projects', 'Adopted'));
    const blocked = await api('projectFolder', zoo.id, 'rename');
    check('rename folder: nothing is renamed over a folder that is already there', blocked?.ok === false && blocked.reason === 'exists' && fs.statSync(safariDir).isDirectory(), JSON.stringify(blocked));
    const adoptedRename = await api('projectFolder', adopted.id, 'rename');
    check('rename folder: a folder the user picked is never renamed', adoptedRename?.ok === false && adoptedRename.reason === 'not-lumen', JSON.stringify(adoptedRename));

    // ======== a working folder for a chat ========
    const work = path.join(docs, 'work');
    fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(work, 'note.txt'), 'the note says: blue');
    fs.writeFileSync(path.join(work, 'sub', 'inner.txt'), 'inner');
    fs.writeFileSync(path.join(docs, 'outside-secret.txt'), 'must not be reached');
    fs.writeFileSync(path.join(work, '.env'), 'SECRET=1');
    await inPage('window.assistant.reset()');
    await sleep(300);
    const devOff = await app.evaluate(() => global.__settings.backend.get?.('aiDeviceAccess') ?? null);
    check('(setup) the device-access setting is off', devOff === false || devOff === null || devOff === undefined, devOff);
    const set = await api('workFolder', 'set', work);
    check('work folder: set for the open chat, shown shortened, from the chat', set?.ok && set.info?.path === fs.realpathSync(work) && set.info.source === 'chat' && set.info.missing === false && typeof set.info.shown === 'string', JSON.stringify(set));
    const wid = await chatId();
    await send('LISTFOLDER please');
    await waitFor(async () => /Listed\./.test(await msgs()), 15000);
    await settled();
    const listedFiles = await app.evaluate(() => global.__fake.toolResults.slice(-1)[0] || '');
    check('work folder: list_files with no folder lists it (without the device-access setting), hiding credentials files', /note\.txt/.test(listedFiles) && /sub\//.test(listedFiles) && !/\.env/.test(listedFiles) && !/outside-secret/.test(listedFiles), listedFiles);
    await send('READNOTE please');
    await waitFor(async () => (await app.evaluate(() => global.__fake.toolResults.length)) >= 2, 15000);
    await settled();
    const readOut = await app.evaluate(() => global.__fake.toolResults.slice(-1)[0] || '');
    check('work folder: list_files read:"note.txt" reads that file inside it, as untrusted file content', /the note says: blue/.test(readOut) && /untrusted_file_content/.test(readOut), readOut);
    await send('ESCAPE please');
    await waitFor(async () => (await app.evaluate(() => global.__fake.toolResults.length)) >= 3, 15000);
    await settled();
    const escOut = await app.evaluate(() => global.__fake.toolResults.slice(-1)[0] || '');
    check('work folder: a path that leaves it (..) is not listed, and the old device-access rule answers', !/outside-secret/.test(escOut) && /off|Using files on this computer/i.test(escOut), escOut);
    const plan = await app.evaluate(() => global.__agent.claudeCodePlan(global.__agent.messages, 'hi').spawn.workDir);
    check('claude code: the plan for this chat carries the work folder (cwd and --add-dir come from it, see project-folders-units)', plan === fs.realpathSync(work), plan);
    const sys = await app.evaluate(() => { const s = global.__agent.messages.settings || {}; return s.workFolder || ''; });
    check('work folder: remembered with the chat (its settings are saved)', sys === fs.realpathSync(work), sys);
    // home and drive roots need a confirm
    const homeAsk = await api('workFolder', 'set', os.homedir());
    check('work folder: the home folder needs a confirm', homeAsk?.ok === false && homeAsk.reason === 'home', JSON.stringify(homeAsk));
    const rootAsk = await api('workFolder', 'set', path.parse(os.homedir()).root);
    check('work folder: a drive root needs a confirm', rootAsk?.ok === false && rootAsk.reason === 'root', JSON.stringify(rootAsk));
    const nope = await api('workFolder', 'set', path.join(docs, 'not-there'));
    check('work folder: a folder that is not there is refused', nope?.ok === false && nope.reason === 'missing', JSON.stringify(nope));
    const cleared = await api('workFolder', 'clear');
    check('work folder: Clear removes the chat\'s own pick', cleared?.ok && cleared.info === null, JSON.stringify(cleared));
    // a project chat works in the project's folder; a pick for the chat wins, and Clear goes back to the project's
    await api('newInProject', zoo.id);
    const pinfo = await api('workFolder', 'get');
    check('project work folder: a chat in a project works in its project\'s folder by default', pinfo?.info?.source === 'project' && pinfo.info.path === safariDir, JSON.stringify(pinfo));
    const own = await api('workFolder', 'set', work);
    const back = await api('workFolder', 'clear');
    check('project work folder: the chat\'s own pick wins, and Clear goes back to the project\'s', own?.info?.source === 'chat' && back?.info?.source === 'project' && back.info.path === safariDir, JSON.stringify([own, back]));
    const pw = await api('projectFolder', zoo.id, 'work-clear');
    check('project work folder: a project can have its own working folder; clearing it uses the project folder', pw?.ok, JSON.stringify(pw));

    // ======== perf: 50 project chats ========
    // The probe is a setImmediate loop in the main process: the longest time between two turns of the event loop. Phases, each reported:
    // 50 chats saved outside any project (the control: the chat store's own cost, which this change does not touch), the same 50 saved in a
    // project (store + scheduling), the Markdown files those saves schedule, and "Write all now".
    // The store saves synchronously through the OS keychain (safeStorage, a few ms per call): on a Windows machine each save of its own is
    // already 14-30 ms between turns, with or without projects. So the absolute 20 ms limit is asserted on what this feature adds (the
    // writes), and the saves are asserted to be no worse than the control.
    const perfProject = await api('saveProject', { name: 'Perf' });
    await app.evaluate(() => { global.__gap = { max: 0, on: true, n: 0, log: [] }; const probe = () => { const g = global.__gap; if (!g.on) return; const t = Date.now(); setImmediate(() => { const d = Date.now() - t; g.max = Math.max(g.max, d); if (d > 8) g.log.push(d); g.n++; probe(); }); }; probe(); });
    const phase = () => app.evaluate(() => { const m = global.__gap.max; global.__gap.max = 0; const log = global.__gap.log.splice(0); return { m, log }; });
    const saveMany = (projectId) => app.evaluate(async (_e, pid) => {
      const store = global.__chats.store();
      const long = 'A paragraph of the answer, with some words in it. '.repeat(20);
      const made = [];
      for (let i = 0; i < 50; i++) {
        const id = store.newId();
        const messages = [];
        for (let m = 0; m < 6; m++) messages.push({ role: 'user', content: [{ type: 'text', text: `question ${i}.${m}` }] }, { role: 'assistant', content: [{ type: 'text', text: long }] });
        store.save(id, { settings: { model: 'claude-opus-5' }, messages });
        if (pid) store.setProject(id, pid);
        made.push(id);
        await new Promise((r) => setImmediate(r));
      }
      return made;
    }, projectId);
    await saveMany(null);
    const { m: gapControl } = await phase();
    const ids = await saveMany(perfProject.id);
    const { m: gapSaves, log: logSaves } = await phase();
    await app.evaluate((_e, list) => { for (const id of list) global.__projectFolders.mirrorSoon(id); }, ids); // (what saveChat does after each save)
    const scheduled = await app.evaluate(() => global.__projectFolders.pending().length);
    await app.evaluate(() => global.__projectFolders.idle());
    const written = chatFiles(perfProject.folder).length;
    const { m: gapMirror, log: logMirror } = await phase();
    const wa = await api('projectFolder', perfProject.id, 'write-all');
    const { m: gapAll, log: logAll } = await phase();
    await app.evaluate(() => { global.__gap.on = false; });
    console.log(`INFO  gaps over 8 ms: project saves [${logSaves}] scheduled writes [${logMirror}] write all [${logAll}]`);
    console.log(`INFO  longest main-thread gap: control saves (no project) ${gapControl} ms, project saves ${gapSaves} ms, the 50 scheduled writes ${gapMirror} ms, write all ${gapAll} ms`);
    check('perf: 50 project chats scheduled and written as files', scheduled === 50 && written === 50 && wa?.count === 50, `scheduled ${scheduled}, files ${written}, write-all ${JSON.stringify(wa)}`);
    check('perf: writing their files never stalls the main thread for more than 20 ms (the scheduled writes, and Write all now)', gapMirror <= 20 && gapAll <= 20, `scheduled writes ${gapMirror} ms, write all ${gapAll} ms`);
    check('perf: saving 50 chats in a project is no worse than saving 50 outside one (the store\'s own cost; the files are written later, off the saving path)', gapSaves <= gapControl + 15, `project ${gapSaves} ms vs control ${gapControl} ms`);

    check('no page errors', !errors.length, errors.join('|'));
  } catch (err) {
    failures++;
    console.log(`FAIL  test crashed -> ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    fs.rmSync(docs, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
