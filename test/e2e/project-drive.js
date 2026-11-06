// [project drive] Save to Drive in a real (invisible) window, with a fake Google Drive in the main process (no network, no sign-in):
//  - without Drive connected, Save to Drive says to connect it first and saves nothing;
//  - a project's Settings view: Save to Drive writes Lumen/Projects/<name> (Memory.md with its notes, project.json, ...), says when, and a
//    change (a new note) is saved again a moment later; Stop saving to Drive stops it;
//  - a temporary project can't be saved until it is kept;
//  - All projects: a Drive badge on the saved project, Save to Drive in a card's menu, and Import from Drive bringing a saved project back
//    (its instructions and notes) as a new project.
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
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('aiMemory', true); global.__projectDriveFastMs = 300; });
    const fakeOn = () => app.evaluate(() => {
      let n = 0;
      const items = global.__fakeDrive = new Map();
      const id = () => `d${++n}`;
      global.__projectDrive.fake({
        async findFolder(name, parent) { return [...items.values()].find((x) => x.folder && x.name === name && x.parent === (parent || 'root'))?.id || null; },
        async makeFolder(name, parent) { const x = { id: id(), name, parent: parent || 'root', folder: true, modified: Date.now() }; items.set(x.id, x); return x.id; },
        async listFolders(parent) { return [...items.values()].filter((x) => x.folder && x.parent === (parent || 'root')).map((x) => ({ id: x.id, name: x.name, modified: x.modified })); },
        async listFiles(parent) { return [...items.values()].filter((x) => !x.folder && x.parent === parent).map((x) => ({ id: x.id, name: x.name })); },
        async rename(fid, name) { items.get(fid).name = name; },
        async writeFile({ id: fid, parent, name, text }) { const x = fid && items.get(fid) ? items.get(fid) : { id: id(), parent, folder: false }; Object.assign(x, { name, text, modified: Date.now() }); items.set(x.id, x); return x.id; },
        async readFile(fid) { return items.get(fid).text; },
      });
    });
    const driveFile = (project, name) => app.evaluate((_e, [p, f]) => { const items = global.__fakeDrive; if (!items) return null; const folder = [...items.values()].find((x) => x.folder && x.name === p); const file = folder && [...items.values()].find((x) => !x.folder && x.parent === folder.id && x.name === f); return file ? file.text : null; }, [project, name]);
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const api = (call, ...args) => inPage(`window.assistant.chats.${call}(...${JSON.stringify(args)})`);
    const project = await api('saveProject', { name: 'Robot arm', instructions: 'Answer in metric units.', folderMode: 'none' });
    await api('projectMemory', project.id, { add: 'The demo is on Friday in the lab' });
    await waitFor(() => inPage(`Boolean(document.querySelector('.cp-pj-item[data-project="${project.id}"]'))`));
    const settings = async (pid) => {
      await inPage(`document.querySelector('.cp-pj-item[data-project="${pid}"] .cp-pj').click()`);
      await waitFor(async () => (await inPage('window.chatProjectPage?.id()')) === pid, 15000);
      await inPage("document.querySelector('#cp-project-page .pjp-tab[data-view=\"settings\"]').click()");
      return waitFor(() => inPage("Boolean(document.querySelector('#cp-project-page .pjp-view .pjp-drive'))"));
    };
    const driveSays = () => inPage("document.querySelector('#cp-project-page .pjp-view .pjp-drive-say')?.textContent || ''");

    // ======== not connected ========
    check('Settings has a Save to Drive line, off', (await settings(project.id)) && (await inPage("document.querySelector('#cp-project-page .pjp-drive-toggle').textContent")) === 'Save to Drive' && /Save this project to Google Drive/.test(await driveSays()));
    await inPage("document.querySelector('#cp-project-page .pjp-drive-toggle').click()");
    check('without Google Drive connected it says to connect it, and stays off', await waitFor(async () => /Connect Google Drive first/.test(await driveSays())) && !(await app.evaluate((_e, id) => global.__projectDrive.state()[id]?.on, project.id)), await driveSays());

    // ======== save ========
    await fakeOn();
    await inPage("document.querySelector('#cp-project-page .pjp-drive-toggle').click()");
    check('Save to Drive writes Lumen/Projects/<name>', await waitFor(async () => /The demo is on Friday/.test((await driveFile('Robot arm', 'Memory.md')) || '')), await app.evaluate(() => [...(global.__fakeDrive || new Map()).values()].map((x) => x.name)));
    check('...with the instructions and settings, and no Sources', /metric units/.test((await driveFile('Robot arm', 'INSTRUCTIONS.md')) || '') && /"name": "Robot arm"/.test((await driveFile('Robot arm', 'project.json')) || '') && (await app.evaluate(() => ![...global.__fakeDrive.values()].some((x) => x.name === 'Sources'))));
    check('...and says when it was saved; the button now stops it', await waitFor(async () => /Saved to Google Drive \(Lumen\/Projects\)/.test(await driveSays()) && (await inPage("document.querySelector('#cp-project-page .pjp-drive-toggle').textContent")) === 'Stop saving to Drive'), await driveSays());
    await api('projectMemory', project.id, { add: 'Parts order goes out Monday' });
    check('a change is saved again a moment later', await waitFor(async () => /Parts order goes out Monday/.test((await driveFile('Robot arm', 'Memory.md')) || ''), 10000));

    // ======== temporary ========
    const temp = await api('newTempProject');
    await waitFor(() => inPage(`Boolean(document.querySelector('.cp-pj-item[data-project="${temp.id}"]'))`));
    await settings(temp.id);
    await inPage("document.querySelector('#cp-project-page .pjp-drive-toggle').click()");
    check('a temporary project can\'t be saved until it is kept', await waitFor(async () => /Keep it as a project first/.test(await driveSays())) && !(await app.evaluate((_e, id) => global.__projectDrive.state()[id]?.on, temp.id)), await driveSays());

    // ======== All projects ========
    await inPage("document.querySelector('#cp-projects .cp-pj-allbtn').click()");
    const all = (code) => inPage(`(() => { const r = document.getElementById('cp-projects-all'); ${code} })()`);
    check('All projects: a Drive badge on the saved project', await waitFor(() => all(`return Boolean(r && r.querySelector('.pja-card[data-project="${project.id}"] .pja-drive'))`), 15000));
    await all(`r.querySelector('.pja-card[data-project="${project.id}"] .pja-more').click()`);
    const items = await waitFor(() => inPage("document.querySelector('.cp-pj-actions') ? [...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].map((b) => b.textContent) : null"));
    check('a card\'s menu has Stop saving to Drive', items?.includes('Stop saving to Drive'), JSON.stringify(items));
    await inPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await all('r.querySelector(".pja-import-btn").click()');
    check('Import from Drive lists the saved projects', await waitFor(() => all('return [...r.querySelectorAll(".pja-import-name")].map((n) => n.textContent).includes("Robot arm")')));
    await all('[...r.querySelectorAll(".pja-import-row")].find((x) => /Robot arm/.test(x.textContent)).querySelector(".pja-import-go").click()');
    const imported = await waitFor(async () => (await app.evaluate(() => global.__chats.store().projects())).find((p) => p.name === 'Robot arm (2)'), 15000);
    check('Import brings it back as a new project with its instructions', imported && imported.instructions === 'Answer in metric units.', JSON.stringify(imported));
    check('...and its notes', imported && (await app.evaluate((_e, id) => global.__projectWorkspace.memoryEntries().filter((e) => e.project === id).map((e) => e.text), imported.id)).some((t) => /demo is on Friday/.test(t)));
    check('...and opens it', await waitFor(async () => (await inPage('window.chatProjectPage?.id()')) === imported?.id, 15000));

    // ======== stop ========
    await settings(project.id);
    await inPage("document.querySelector('#cp-project-page .pjp-drive-toggle').click()");
    check('Stop saving to Drive turns it off', await waitFor(async () => (await app.evaluate((_e, id) => global.__projectDrive.state()[id]?.on, project.id)) === false));
    await api('projectMemory', project.id, { add: 'This note stays on this computer only' });
    await sleep(1500);
    check('...and later changes are not sent', !/stays on this computer/.test((await driveFile('Robot arm', 'Memory.md')) || ''));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
