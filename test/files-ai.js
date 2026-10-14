// Files, backend end to end (hidden window, throwaway profile, a throwaway home folder, no network, no key):
//  - the AI's lookup (list_files find:) finds a pinned "Chapter 4 slides.pptx" in under a second with NO disk-wide search
//    (the slow scan is never called: its counters stay at zero);
//  - a file inside a pinned folder is found from the index, also without a scan;
//  - a file only the slow way can find (the home folder's Documents, with "Let the AI use files" on) is found by one bounded scan, and is
//    remembered: the next lookup is the quick kind and the scan counter does not move;
//  - with that setting off, a miss says so and scans nothing;
//  - a missing file is noticed (greyed out in the list) and the lookup skips it;
//  - "Remember files I open" off: nothing new is recorded; pins still work;
//  - the three bridges answer (UI, new-tab page, Settings are checked by their own suites) and a web page has none;
//  - the list on disk is encrypted and has no contents.
// Run alone: node test/files-ai.js (LUMEN_TEST_BACKGROUND=1 keeps the window hidden).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-ai-'));
  const home = path.join(root, 'home');
  const profile = path.join(root, 'profile');
  const put = (p, data = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
  const course = path.join(root, 'Course');
  const slides = put(path.join(root, 'Elsewhere', 'Chapter 4 slides.pptx'), 'pretend deck');
  put(path.join(root, 'Elsewhere', 'Chapter 4 notes.docx'));
  put(path.join(course, 'Week 1', 'Lab report.txt'), 'lab');
  put(path.join(course, 'Week 2', 'Quiz answers.txt'), 'SECRET CONTENTS');
  const thesis = put(path.join(home, 'Documents', 'Thesis Draft v2.docx'), 'thesis');
  put(path.join(home, 'Desktop', 'todo.txt'));
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>web</title>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const web = `http://127.0.0.1:${server.address().port}/`;

  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1', USERPROFILE: home, HOME: home },
    colorScheme: null,
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    const t0 = Date.now();
    try { const r = await global.__agent.execute(n, i); return { text: typeof r === 'string' ? r : JSON.stringify(r).slice(0, 500), ms: Date.now() - t0 }; } catch (err) { return { text: `ERROR: ${err.message}`, ms: Date.now() - t0 }; }
  }, [name, input]);
  const files = (code, arg) => app.evaluate(async (_e, [c, a]) => {
    const f = global.__files;
    return new Function('f', 'arg', `return (async () => { ${c} })()`)(f, a);
  }, [code, arg]);
  const scans = () => files('return { scans: f.stats.scans, worker: f.indexer.stats.scan };');

  // The OS's own programs and dialogs are not started: opens and "show in folder" are recorded here instead.
  await app.evaluate(() => { global.__shellCalls = []; global.__filesShell = (name, p) => { global.__shellCalls.push([name, p]); return ''; }; });

  // ---- pins
  const pinned = await files('return f.pin({ path: arg });', slides);
  check('pin: a file by path gives an entry with the contract shape', pinned && pinned.kind === 'file' && pinned.pinned === true && pinned.name === 'Chapter 4 slides.pptx' && pinned.size === 12 && pinned.missing === false, JSON.stringify(pinned));
  const folderEntry = await files('return f.pin({ path: arg });', course);
  check('pin: a folder', folderEntry && folderEntry.kind === 'folder', JSON.stringify(folderEntry));
  check('pin: a path that does not exist, or a relative one, pins nothing', (await files('return [await f.pin({ path: arg }), await f.pin({ path: "relative.txt" }), await f.pin({})];', path.join(root, 'nope.txt'))).every((x) => x === null), '');
  const picked = await app.evaluate(async () => { global.__filesPick = () => null; return global.__files.pin({ pick: 'file' }); });
  check('pin: a dialog the user closes pins nothing', picked === null, JSON.stringify(picked));

  // ---- the lookup: pinned file, no disk search
  const before = await scans();
  const quick = await run('list_files', { find: 'chapter 4 slides' });
  const after = await scans();
  check('find: "chapter 4 slides" resolves to the pinned deck', /Chapter 4 slides\.pptx/.test(quick.text) && !/ERROR/.test(quick.text), quick.text);
  check('find: ...in under a second', quick.ms < 1000, `${quick.ms} ms`);
  check('find: ...with no disk-wide search (the scan was not called)', after.scans === before.scans && after.worker === before.worker && after.worker === 0, JSON.stringify({ before, after }));
  check('find: a close description finds it too, and the notes file is not offered first', /Chapter 4 slides\.pptx/.test((await run('list_files', { find: 'ch 4 slides deck' })).text.split('\n')[0]), '');

  // ---- the lookup: a file inside a pinned folder (the index), still no scan
  await waitFor(async () => (await files('return (await f.search("lab report")).some((e) => /Lab report/.test(e.name));', null)), 15000);
  const inFolder = await run('list_files', { find: 'lab report' });
  check('find: a file inside a pinned folder comes from the index', /Lab report\.txt/.test(inFolder.text), inFolder.text);
  check('find: ...in under a second, with no scan', inFolder.ms < 1000 && (await scans()).worker === 0, `${inFolder.ms} ms ${JSON.stringify(await scans())}`);

  // ---- the slow way, and remembering it
  await app.evaluate(() => global.__patchSettings({ aiDeviceAccess: false }));
  const off = await run('list_files', { find: 'thesis draft' });
  check('find: with "Let the AI use files" off, a miss says so and searches nothing', /Settings > AI/.test(off.text) && (await scans()).worker === 0, off.text);
  await app.evaluate(() => global.__patchSettings({ aiDeviceAccess: true }));
  const slow = await run('list_files', { find: 'thesis draft' });
  const afterSlow = await scans();
  check('find: with it on, one bounded scan of Desktop, Documents and Downloads finds it', /Thesis Draft v2\.docx/.test(slow.text) && afterSlow.worker === 1 && afterSlow.scans === 1, `${slow.text} ${JSON.stringify(afterSlow)}`);
  const remembered = await files('return f.store.byPath(arg);', thesis);
  check('find: ...and the file is remembered (source "found")', remembered && remembered.source === 'found' && remembered.openedAt > 0, JSON.stringify(remembered));
  const again = await run('list_files', { find: 'thesis draft' });
  const afterAgain = await scans();
  check('find: the next lookup is instant and does not scan again', /Thesis Draft v2\.docx/.test(again.text) && again.ms < 1000 && afterAgain.worker === 1 && afterAgain.scans === 1, `${again.text} ${again.ms} ms ${JSON.stringify(afterAgain)}`);
  const none = await run('list_files', { find: 'zebra crossing manual' });
  check('find: nothing anywhere says so (and the scan ran once more)', /No pinned, recent or indexed file matches/.test(none.text) && (await scans()).worker === 2, none.text);
  const secret = put(path.join(home, 'Desktop', '.env'), 'KEY=1');
  check('find: a credentials file is never offered', !/\.env/.test((await run('list_files', { find: '.env' })).text) && fs.existsSync(secret), '');

  // ---- a missing file: noticed, greyed out, skipped by the lookup
  fs.unlinkSync(slides);
  const missing = await files('await new Promise((r) => setTimeout(r, 5200)); const l = await f.list(); return l.pinned.find((e) => e.name === "Chapter 4 slides.pptx");', null);
  check('missing: a deleted pinned file is marked missing in the list', missing && missing.missing === true, JSON.stringify(missing));
  check('missing: the lookup does not offer a deleted file', !/Chapter 4 slides\.pptx/.test((await run('list_files', { find: 'chapter 4 slides' })).text.split('\n')[0] || ''), '');
  const candidates = await files('return f.find(arg);', pinned.id);
  put(path.join(root, 'Elsewhere', 'Chapter 4 slides.pptx'), 'pretend deck'); // it comes back, where it was
  const back = await files('await new Promise((r) => setTimeout(r, 5200)); const l = await f.list(); return l.pinned.find((e) => e.name === "Chapter 4 slides.pptx");', null);
  check('missing: a file that comes back is no longer marked', back && back.missing === false, JSON.stringify(back));
  check('find it: a deleted file with nothing like it nearby offers nothing, and relocate refuses a path find() did not offer', Array.isArray(candidates.candidates) && (await files('return f.relocate(arg, "C:\\\\Windows\\\\win.ini");', pinned.id)) === null, JSON.stringify(candidates));

  // ---- the bridges
  const uiList = await ui.evaluate(() => window.lumenFiles.list());
  check('UI bridge: list() has pinned, recent and remember', Array.isArray(uiList.pinned) && Array.isArray(uiList.recent) && uiList.remember === true && uiList.pinned.length === 2, JSON.stringify(uiList));
  const toTab = await app.evaluate(() => global.__settings.tabs().length);
  const deck = uiList.pinned.find((e) => e.kind === 'file');
  // a .pptx opens in Lumen's own viewer (a new tab)
  put(path.join(root, 'Elsewhere', 'Chapter 4 slides.pptx'), 'pretend deck');
  const opened = await ui.evaluate((id) => window.lumenFiles.open(id), deck.id);
  check('UI bridge: open() opens a file in a new tab', opened === true && await waitFor(async () => (await app.evaluate(() => global.__settings.tabs().length)) === toTab + 1), `${opened}`);
  const folderId = uiList.pinned.find((e) => e.kind === 'folder').id;
  await ui.evaluate((id) => window.lumenFiles.open(id), folderId);
  await ui.evaluate((id) => window.lumenFiles.show(id), deck.id);
  const shellCalls = await app.evaluate(() => global.__shellCalls);
  check('UI bridge: a folder opens in Explorer and Show in folder reveals the file', shellCalls.some(([n, p]) => n === 'open' && p === course) && shellCalls.some(([n, p]) => n === 'show' && p === slides), JSON.stringify(shellCalls));
  const unsafe = await files('return f.pin({ path: arg });', put(path.join(root, 'tool.exe')));
  await ui.evaluate((id) => window.lumenFiles.open(id), unsafe.id);
  check('UI bridge: a program is shown in its folder, never run', (await app.evaluate(() => global.__shellCalls)).some(([n, p]) => n === 'show' && /tool\.exe$/.test(p)) && !(await app.evaluate(() => global.__shellCalls)).some(([n, p]) => n === 'open' && /tool\.exe$/.test(p)), '');
  const searched = await ui.evaluate(() => window.lumenFiles.search('quiz answers'));
  check('UI bridge: search finds a file inside a pinned folder, with the matched letters', searched.length === 1 && searched[0].name === 'Quiz answers.txt' && searched[0].positions.length >= 4 && !searched[0].pinned, JSON.stringify(searched));
  const tabsBeforeIx = await app.evaluate(() => global.__settings.tabs().length);
  await ui.evaluate((id) => window.lumenFiles.open(id), searched[0].id);
  check('UI bridge: a search result that is only indexed opens too, and joins Recent', await waitFor(async () => (await app.evaluate(() => global.__settings.tabs().length)) === tabsBeforeIx + 1) && await waitFor(async () => (await ui.evaluate(() => window.lumenFiles.list())).recent.some((e) => e.name === 'Quiz answers.txt')), '');
  const sent = await app.evaluate(async () => { const got = []; const ui0 = require('electron').BrowserWindow.getAllWindows()[0].webContents; const orig = ui0.send.bind(ui0); ui0.send = (ch, ...a) => { if (ch === 'files:attach-file') got.push({ name: a[0].name, bytes: a[0].data.length }); return orig(ch, ...a); }; const e = (await global.__files.search('lab report'))[0]; const r = await global.__files.attach(e.id); ui0.send = orig; return { r, got }; });
  check('attach: the file goes to the sidebar composer as bytes', sent.r.ok === true && sent.got.length === 1 && sent.got[0].name === 'Lab report.txt' && sent.got[0].bytes === 3, JSON.stringify(sent));
  const newtabHas = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /renderer\/newtab\.html/.test(w.getURL()));
    return wc ? wc.executeJavaScript('typeof window.lumenFiles?.list + "," + typeof window.lumenFiles?.onChanged') : 'no new-tab page';
  });
  check('new-tab bridge: window.lumenFiles has list and onChanged', newtabHas === 'function,function', newtabHas);
  await app.evaluate((_e, url) => global.__agent.browser.openTab(url), web);
  await sleep(800);
  const onWeb = await app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(url));
    return wc ? wc.executeJavaScript('typeof window.lumenFiles + "," + typeof window.browser') : 'no page';
  }, web);
  check('a web page has no Files bridge', onWeb === 'undefined,undefined', onWeb);

  // ---- remember off
  await app.evaluate(() => global.__patchSettings({ filesRemember: false }));
  const note = put(path.join(root, 'Elsewhere', 'private.pdf'));
  const noted = await files('return f.note(arg, { source: "tab" });', note);
  check('remember off: an open is not recorded', noted === null && (await files('return f.store.byPath(arg);', note)) === null, JSON.stringify(noted));
  check('remember off: the list says so, and a pin still works', (await ui.evaluate(() => window.lumenFiles.list())).remember === false && (await files('return f.pin({ path: arg });', note)).pinned === true, '');
  await app.evaluate(() => global.__patchSettings({ filesRemember: true }));
  check('remember on again: opens are recorded', (await files('return f.note(arg, { source: "download" });', put(path.join(root, 'Elsewhere', 'report.pdf')))).source === 'download', '');

  // ---- on disk: encrypted, no contents
  await files('return f.flush();', null);
  const keychain = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  const raw = fs.existsSync(path.join(profile, 'files.json')) ? fs.readFileSync(path.join(profile, 'files.json'), 'utf8') : '';
  check('disk: files.json is encrypted and holds no names, paths or contents (nothing is written where there is no OS keychain)', keychain ? /"enc"/.test(raw) && !/Chapter|Thesis|SECRET|pptx|Elsewhere/.test(raw) : raw === '', raw.slice(0, 120));
  check('clear: empties the list, and the index of pinned folders', (await ui.evaluate(() => window.lumenFiles.clear())) === true && (await ui.evaluate(() => window.lumenFiles.list())).pinned.length === 0 && (await ui.evaluate(() => window.lumenFiles.search('quiz answers'))).length === 0, '');

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
