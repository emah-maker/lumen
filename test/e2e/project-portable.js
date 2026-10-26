// [portable projects] A project is just a folder (docs/projects.md), in a real (invisible) window:
//  - a new project with a folder keeps INSTRUCTIONS.md, AGENTS.md, CLAUDE.md, sources.md, project.json there as plain files; an edit made in an editor
//    is picked up when the project is opened; a file dropped in Sources/ becomes a source; a file uploaded in Lumen is also the real file there;
//  - a project that already existed keeps nothing until the user turns it on (and is told the files are not encrypted); turning it off leaves the files;
//  - Export project: a zip with the plain files, the sources and the chats; Open folder as project: a folder made by hand, a folder that is already a
//    project, a plain folder of files (nothing written to it); Save project to a folder for a project with none;
//  - the project page's Folder card says all of it. With PROJECT_PAGE_SHOTS=<dir> it saves screenshots of the Folder card in dark and light.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zipWrite = require('../../src/features/zip-write');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const SHOTS = process.env.PROJECT_PAGE_SHOTS || '';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-profile-'));
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-docs-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-outside-'));
  const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }, dir) => { global.__settings.backend.set('sidebarNewChat', false); global.__projectFolders.setDocuments(dir); }, docs);
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const api = (call, ...args) => inPage(`window.assistant.chats.${call}(...${JSON.stringify(args)})`);
    const sync = (id) => app.evaluate((_e, i) => global.__projectPortable.sync(i), id);
    const stubDialog = (kind, value) => app.evaluate(({ dialog }, [k, v]) => { if (k === 'open') dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [v] }); else dialog.showSaveDialog = async () => ({ canceled: false, filePath: v }); }, [kind, value]);
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      const png = await app.evaluate(async () => { const t = global.__chatPage.tabs().find((x) => x.chat); const img = await global.__chatPage.contents(t.id).capturePage(); return img.toPNG().toString('base64'); });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'));
    };
    const theme = async (mode) => { await app.evaluate(async (_e, m) => { const t = global.__chatPage.tabs().find((x) => x.chat); const dbg = global.__chatPage.contents(t.id).debugger; if (!dbg.isAttached()) dbg.attach('1.3'); await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: m }] }); }, mode); await sleep(300); };

    // ======== a new project with a folder: the plain files ========
    const made = await api('saveProject', { name: 'Thesis notes', instructions: 'Answer in a formal tone.\nCite the sources.', description: 'My thesis', folderMode: 'new' });
    check('a new project gets a folder and keeps plain files by default', made?.id && made.portable === true && made.folder && made.folder.startsWith(docs), JSON.stringify(made));
    await sync(made.id);
    const dir = made.folder;
    check('INSTRUCTIONS.md and AGENTS.md hold the instructions; CLAUDE.md imports AGENTS.md', read(dir, 'INSTRUCTIONS.md') === 'Answer in a formal tone.\nCite the sources.\n' && read(dir, 'AGENTS.md') === read(dir, 'INSTRUCTIONS.md') && read(dir, 'CLAUDE.md') === '@AGENTS.md\n', fs.readdirSync(dir).join());
    check('sources.md and project.json are there too (the goal line is in project.json)', /# Sources/.test(read(dir, 'sources.md')) && JSON.parse(read(dir, 'project.json')).description === 'My thesis');

    // an edit made in an editor
    await sleep(60);
    fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), 'Answer in a casual tone.\r\n');
    fs.writeFileSync(path.join(dir, 'sources.md'), `${read(dir, 'sources.md')}- [Python docs](https://docs.python.org/3/) — whole site\n- [A paper](https://example.com/paper)\n`);
    fs.mkdirSync(path.join(dir, 'Sources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Sources', 'Reading list.txt'), 'Chapter 1: The cell. Chapter 2: Energy.');
    const got = await api('project', made.id);
    check('opening the project picks up INSTRUCTIONS.md, sources.md and a file dropped in Sources/', got.project.instructions === 'Answer in a casual tone.' && got.project.links.length === 2 && got.project.links.some((l) => l.site && l.url === 'https://docs.python.org/3/') && got.files.length === 1 && got.files[0].name === 'Reading list.txt', JSON.stringify([got.project.instructions, got.project.links, got.files.map((f) => f.name)]));
    check('...and AGENTS.md follows the new instructions', read(dir, 'AGENTS.md') === 'Answer in a casual tone.\n');
    const again = await api('project', made.id);
    check('opening it again changes nothing (no loop)', again.files.length === 1 && again.project.updated === got.project.updated, JSON.stringify([again.project.updated, got.project.updated]));
    // the AI is told about them like any other source
    const block = await app.evaluate((_e, id) => global.__projectWorkspace.blockFor(id), (await app.evaluate(() => { const s = global.__chats.store(); const cid = s.newId(); s.save(cid, { settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }); return cid; })));
    check('(a chat outside the project does not get them)', block === '');
    // an upload made in Lumen is the real file too
    await app.evaluate((_e, id) => { const s = global.__chats.store(); const cid = s.newId(); s.save(cid, { settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }); s.setProject(cid, id); global.__lastChat = cid; }, made.id);
    const upload = await inPage(`window.assistant.chats.projectFilesAdd(${JSON.stringify(made.id)}, [{ name: 'Budget.md', bytes: new TextEncoder().encode('# Budget\\n\\nThe lab has 4,000 dollars.').buffer }])`);
    check('a file added in Lumen is kept as the real file in Sources/', upload?.results?.[0]?.ok === true && read(dir, 'Sources', 'Budget.md') === '# Budget\n\nThe lab has 4,000 dollars.', JSON.stringify(upload));
    const afterUpload = await sync(made.id);
    check('...and the next pass does not read it again', !afterUpload.files.added.length && !afterUpload.files.updated.length, JSON.stringify(afterUpload));
    const chatBlock = await app.evaluate((_e) => global.__projectWorkspace.blockFor(global.__lastChat));
    check('the AI\'s index lists the files, pages and websites from the folder', /Reading list\.txt/.test(chatBlock) && /Budget\.md/.test(chatBlock) && /Websites:/.test(chatBlock) && /A paper/.test(chatBlock), chatBlock.slice(0, 500));
    const settings = await app.evaluate((_e) => global.__projectWorkspace.settingsFor(global.__lastChat));
    check('a command-line engine started in the project works in its folder (the chat\'s work folder is the project folder)', settings.projectWorkFolder === dir, JSON.stringify(settings).slice(0, 300));
    // removing in Lumen keeps the file
    const removed = await inPage(`window.assistant.chats.projectFileRemove(${JSON.stringify(made.id)}, ${JSON.stringify((await api('project', made.id)).files.find((f) => f.name === 'Budget.md').id)})`);
    check('a file removed in Lumen moves to Sources/Removed/ (not deleted) and does not come back', removed?.files?.length === 1 && fs.existsSync(path.join(dir, 'Sources', 'Removed', 'Budget.md')) && !fs.existsSync(path.join(dir, 'Sources', 'Budget.md')) && (await api('project', made.id)).files.length === 1);
    // both sides changed
    await sleep(60);
    await api('saveProject', { id: made.id, name: 'Thesis notes', instructions: 'Lumen says this.' });
    await sleep(60);
    fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), 'The editor says this.\n');
    const conflict = await api('project', made.id);
    const aside = fs.readdirSync(dir).filter((n) => /^INSTRUCTIONS\.conflict-/.test(n));
    check('both changed: the newer wins and the other text is kept as INSTRUCTIONS.conflict-<date>.md', conflict.project.instructions === 'The editor says this.' && aside.length === 1 && /Lumen says this/.test(read(dir, aside[0])), JSON.stringify([conflict.project.instructions, aside]));

    // ======== the Folder card and the editor tell the user ========
    await inPage("document.getElementById('open-chat-page') && 0"); // (the page is already open)
    await inPage(`document.querySelector('.cp-pj-item[data-project="${made.id}"] .cp-pj')?.click()`);
    await waitFor(async () => (await inPage("document.querySelector('.pjp-title')?.value")) === 'Thesis notes', 15000);
    check('the Folder card says the files are plain and offers Check the folder', /INSTRUCTIONS\.md, AGENTS\.md, sources\.md and Sources\//.test(await inPage("document.querySelector('.pjp-folder').innerText")) && (await inPage("[...document.querySelectorAll('.pjp-folder button')].map((b) => b.textContent).join('|')")).includes('Check the folder'), await inPage("document.querySelector('.pjp-folder').innerText"));
    await inPage("document.activeElement.blur()");
    await theme('dark');
    await shot('20-folder-plain-dark');
    await theme('light');
    await shot('21-folder-plain-light');
    await theme('dark');
    await inPage("[...document.querySelectorAll('.pjp-folder button')].find((b) => b.textContent === 'Check the folder').click()");
    check('Check the folder says nothing changed', await waitFor(() => inPage("/No changes/.test(document.querySelector('.pjp-folder .pjp-status').textContent)")), await inPage("document.querySelector('.pjp-folder').innerText"));
    fs.appendFileSync(path.join(dir, 'sources.md'), '- https://example.net/new-page\n');
    await inPage("[...document.querySelectorAll('.pjp-folder button')].find((b) => b.textContent === 'Check the folder').click()");
    check('...and after an edit outside it says it picked it up, and the Sources card shows it', await waitFor(() => inPage("/Picked up changes/.test(document.querySelector('.pjp-folder .pjp-status')?.textContent || '')")) && await waitFor(() => inPage("[...document.querySelectorAll('.pjp-sources .pjp-src')].some((r) => /example\\.net/.test(r.textContent))")), await inPage("document.querySelector('.pjp-sources').innerText"));
    await inPage("document.querySelector('.pjp-more-btn').click()");
    await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-actions'))"));
    check('the project\'s ⋯ menu has Export project…', (await inPage("[...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].map((b) => b.textContent)")).includes('Export project…'));
    // Export
    const zipPath = path.join(outside, 'thesis.zip');
    await stubDialog('save', zipPath);
    await inPage("[...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].find((b) => b.textContent === 'Export project…').click()");
    check('Export project… writes a zip', await waitFor(() => fs.existsSync(zipPath), 15000));
    const entries = zipWrite.list(fs.readFileSync(zipPath)).map((e) => e.name);
    const zip = fs.readFileSync(zipPath);
    check('the zip has instructions, AGENTS.md, sources.md, project.json, the sources and a README', ['INSTRUCTIONS.md', 'AGENTS.md', 'sources.md', 'project.json', 'Sources/Reading list.txt', 'README.md'].every((n) => entries.includes(n)), entries.join());
    check('...in plain formats: the instructions text, a sources.md with the website, a project.json with the name', zipWrite.read(zip, 'INSTRUCTIONS.md').toString() === 'The editor says this.\n' && /\[Python docs\]\(https:\/\/docs\.python\.org\/3\/\) — whole site/.test(zipWrite.read(zip, 'sources.md').toString()) && JSON.parse(zipWrite.read(zip, 'project.json').toString()).name === 'Thesis notes' && zipWrite.read(zip, 'Sources/Reading list.txt').toString().startsWith('Chapter 1'));
    check('...and the project\'s chat as Markdown', entries.some((n) => /^Chats\/.+\.md$/.test(n)), entries.join());

    // ======== a project that already existed: off until it is turned on ========
    const old = await api('saveProject', { name: 'Old project', instructions: 'Old instructions.', folderMode: 'existing', folder: outside, portable: false });
    check('a project given an existing folder with the switch off keeps nothing there', old?.id && !old.portable && !fs.existsSync(path.join(outside, 'INSTRUCTIONS.md')), JSON.stringify(old));
    await api('project', old.id);
    check('...and opening it writes nothing', !fs.existsSync(path.join(outside, 'INSTRUCTIONS.md')) && !fs.existsSync(path.join(outside, 'sources.md')));
    await inPage("document.querySelector('.pjp-back').click()");
    await inPage(`document.querySelector('.cp-pj-item[data-project="${old.id}"] .cp-pj').click()`);
    await waitFor(async () => (await inPage("document.querySelector('.pjp-title')?.value")) === 'Old project', 15000);
    check('its Folder card offers Keep as plain files…', (await inPage("[...document.querySelectorAll('.pjp-folder button')].map((b) => b.textContent).join('|')")).includes('Keep as plain files…'));
    await inPage("[...document.querySelectorAll('.pjp-folder button')].find((b) => b.textContent === 'Keep as plain files…').click()");
    check('...and says what is written, that it is not encrypted, and that earlier files are not copied out, before it does anything', /not encrypted/.test(await inPage("document.querySelector('.pjp-folder').innerText")) && /not copied out/.test(await inPage("document.querySelector('.pjp-folder').innerText")) && !fs.existsSync(path.join(outside, 'INSTRUCTIONS.md')), await inPage("document.querySelector('.pjp-folder').innerText"));
    await sleep(300);
    await shot('22-folder-turn-on-dark');
    await inPage("[...document.querySelectorAll('.pjp-folder button')].find((b) => b.textContent === 'Write the files').click()");
    check('Write the files then writes them', await waitFor(() => fs.existsSync(path.join(outside, 'INSTRUCTIONS.md'))) && read(outside, 'INSTRUCTIONS.md') === 'Old instructions.\n' && fs.existsSync(path.join(outside, 'AGENTS.md')) && fs.existsSync(path.join(outside, 'sources.md')), fs.readdirSync(outside).join());
    const oldNow = (await api('project', old.id)).project;
    check('...and the project is marked as keeping plain files', oldNow.portable === true);
    const off = await api('projectFolder', old.id, 'portable', false);
    fs.writeFileSync(path.join(outside, 'INSTRUCTIONS.md'), 'Edited after it was turned off.\n');
    check('turning it off leaves the files and stops reading them', off?.ok && off.project.portable !== true && (await api('project', old.id)).project.instructions === 'Old instructions.' && fs.existsSync(path.join(outside, 'AGENTS.md')));
    const turnedOn = await api('projectFolder', old.id, 'portable', true);
    check('turning it on again picks up what was edited meanwhile (Lumen\'s text had not changed, so nothing is lost)', turnedOn?.ok && (await api('project', old.id)).project.instructions === 'Edited after it was turned off.' && !fs.readdirSync(outside).some((n) => /^INSTRUCTIONS\.conflict-/.test(n)), fs.readdirSync(outside).join());
    const over = path.join(outside, 'over-existing');
    fs.mkdirSync(over);
    fs.writeFileSync(path.join(over, 'INSTRUCTIONS.md'), 'The folder had these.\n');
    const clash = await api('saveProject', { name: 'Over existing', instructions: 'Lumen had these.', folderMode: 'existing', folder: over, portable: false });
    const clashOn = await api('projectFolder', clash.id, 'portable', true);
    check('turning it on over an INSTRUCTIONS.md that differs uses the folder\'s text and keeps Lumen\'s beside it', clashOn?.ok && clashOn.conflicts.length === 1 && (await api('project', clash.id)).project.instructions === 'The folder had these.' && /Lumen had these/.test(read(over, clashOn.conflicts[0])), JSON.stringify(clashOn));

    // ======== a project with no folder: Save project to a folder ========
    const bare = await api('saveProject', { name: 'No folder yet', instructions: 'Keep it short.', folderMode: 'none' });
    await api('projectLink', bare.id, { add: { url: 'https://example.com/a', title: 'A page' } });
    check('a project made without a folder has none', bare?.id && !bare.folder);
    const saved = await api('projectFolder', bare.id, 'save-folder');
    check('Save project to a folder makes the folder, keeps the plain files there and turns the switch on', saved?.ok && saved.folder.startsWith(docs) && saved.project.portable === true && read(saved.folder, 'INSTRUCTIONS.md') === 'Keep it short.\n' && /A page/.test(read(saved.folder, 'sources.md')), JSON.stringify(saved));

    // ======== Open folder as project ========
    const hand = path.join(outside, 'made-by-hand');
    fs.mkdirSync(path.join(hand, 'Sources'), { recursive: true });
    fs.writeFileSync(path.join(hand, 'AGENTS.md'), 'Use the house style.\n');
    fs.writeFileSync(path.join(hand, 'sources.md'), '# my links\n\n- https://docs.python.org/3/library/\n- [Course](https://course.example.edu/cs101/) — whole site\n');
    fs.writeFileSync(path.join(hand, 'project.json'), JSON.stringify({ name: 'Hand made', description: 'By hand', defaults: { plan: true } }));
    fs.writeFileSync(path.join(hand, 'Sources', 'Syllabus.txt'), 'Week 1: Introduction to the course.');
    await stubDialog('open', hand);
    const imported = await api('projectImport');
    check('Open folder as project: a folder made by hand gives the project its name, instructions, sources, files and settings', imported?.ok && imported.plain && imported.project.name === 'Hand made' && imported.project.instructions === 'Use the house style.' && imported.project.links.length === 2 && imported.project.links[1].site === true && imported.project.description === 'By hand' && imported.project.defaults.plan === true && imported.files === 1 && imported.project.portable === true, JSON.stringify(imported));
    check('...and it keeps working as plain files (INSTRUCTIONS.md is written next to AGENTS.md)', await waitFor(() => fs.existsSync(path.join(hand, 'INSTRUCTIONS.md'))) && (await api('project', imported.project.id)).files[0].name === 'Syllabus.txt');
    const reopened = await api('projectImport');
    check('opening a folder that is already a project opens that project', reopened?.ok && reopened.existing === true && reopened.project.id === imported.project.id);
    const loose = path.join(outside, 'just-files');
    fs.mkdirSync(loose);
    fs.writeFileSync(path.join(loose, 'notes.txt'), 'Lecture notes on enzymes.');
    fs.writeFileSync(path.join(loose, 'paper.txt'), 'A paper about membranes.');
    fs.writeFileSync(path.join(loose, 'tool.exe'), 'MZ');
    await stubDialog('open', loose);
    const plainOpen = await api('projectImport');
    check('a plain folder of files: its files are the sources and nothing is written to it', plainOpen?.ok && plainOpen.plain === false && plainOpen.files === 2 && plainOpen.project.name === 'just-files' && !plainOpen.project.portable && fs.readdirSync(loose).sort().join() === 'notes.txt,paper.txt,tool.exe', JSON.stringify([plainOpen, fs.readdirSync(loose)]));
    await stubDialog('open', os.homedir());
    const home = await api('projectImport');
    check('the home folder (or a whole drive) is refused', home?.ok === false && ['home', 'root'].includes(home.reason), JSON.stringify(home));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    for (const d of [profile, docs, outside]) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
