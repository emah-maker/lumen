// upload_file against a local page that behaves like Google Drive (test/fixtures/drive-like.html): a "New" button that opens its menu only
// for a real (trusted) mouse press, a "File upload" item that makes a hidden <input type=file multiple> on demand and click()s it
// (a native chooser in a normal browser), and a drop target. Proves the files arrive (names and sizes read back in the page) by the
// menu route (open: ["New", "File upload"], the chooser intercepted), by a hidden field already in the page with no click, and by a
// drop when the page has no field at all; and that the device-access rules still hold. No network, no Google. Temp profile, hidden window.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'drive-like.html'), 'utf8');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-drive-files-'));
  const files = [];
  for (let i = 1; i <= 18; i++) { const p = path.join(work, `Resume ${i} - Tailored.pdf`); fs.writeFileSync(p, Buffer.alloc(100 + i * 7, i)); files.push(p); }
  const expected = (list) => list.map((p) => `${path.basename(p)}:${fs.statSync(p).size}`).join(', ');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-drive-profile-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const load = async (query) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ok = await app.evaluate(async (_e, u) => {
        const wc = global.__agent.browser.activeTab().webContents;
        for (let i = 0; i < 100 && wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 50));
        try { await wc.loadURL(u); return true; } catch { return false; }
      }, base + query);
      if (ok) break;
    }
    await sleep(300);
  };
  const tabId = () => app.evaluate(() => global.__agent.browser.activeTab().id);
  const pageLog = () => app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('document.getElementById("log").textContent'));
  const menuOpen = () => app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('document.getElementById("menu").classList.contains("open")'));
  await app.evaluate(() => { global.__agent.browser.autoApprove = () => true; global.__agent.browser.deviceAccess = () => true; });
  const call = async (input, name = 'upload_file') => {
    const id = await tabId();
    return app.evaluate(async (_e, a) => {
      const agent = global.__agent;
      const signal = new AbortController().signal;
      const m = []; m.settings = { model: 'claude-opus-5' };
      const hosts = new Set();
      const events = [];
      try {
        const out = await agent.inTask(a.id, signal, async () => {
          await agent.ensureAllowed(a.name, (e) => events.push(e), signal, { hosts, who: 'Claude', input: a.input });
          return agent.execute(a.name, a.input);
        }, m, null, { chatId: global.__chats.id(), hosts });
        return { ok: true, out };
      } catch (e) { return { ok: false, error: e.message }; }
    }, { name, id, input });
  };

  // ---- 1. the click tool opens a menu that needs trusted input
  await load('');
  await app.evaluate(async () => global.__agent.execute('read_page', { mode: 'compact' }));
  let r = await call({ text: 'New' }, 'click');
  check('click on a custom "New" button that ignores script clicks opens its menu (real mouse input)', r.ok && (await menuOpen()), JSON.stringify(r));

  // ---- 2. New -> File upload, the chooser intercepted: 18 files arrive in one go
  await load('');
  r = await call({ paths: files, open: ['New', 'File upload'] });
  let log = await pageLog();
  check('open ["New","File upload"] + paths: all 18 files reach the page with their sizes, through the intercepted chooser', r.ok && log.includes(`picker: ${expected(files)}`), `${JSON.stringify(r)} | ${log.slice(0, 300)}`);
  check('the answer says how many files and by which route', r.ok && /Gave 18 files/.test(r.out) && /file chooser/.test(r.out), r.out);

  // ---- 3. a hidden field already in the page, no click at all
  await load('?latent');
  r = await call({ paths: files.slice(0, 3) });
  log = await pageLog();
  check('no element_id and no open: a hidden multiple <input type=file> is found and given the files', r.ok && log.includes(`latent: ${expected(files.slice(0, 3))}`) && /file field found in the page/.test(r.out), `${JSON.stringify(r)} | ${log}`);

  // ---- 4. no field, no chooser: the drop
  await load('?noclick');
  r = await call({ paths: files.slice(0, 4), open: ['New', 'File upload'] });
  log = await pageLog();
  check('the menu item opens nothing and the page has no field: the files are dropped on the list', r.ok && log.includes(`drop: ${expected(files.slice(0, 4))}`) && /dropping them/.test(r.out), `${JSON.stringify(r)} | ${log}`);
  await load('?noclick');
  r = await call({ paths: files.slice(4, 6) });
  log = await pageLog();
  check('nothing named at all and no field: the drop is tried on the main area', r.ok && log.includes(`drop: ${expected(files.slice(4, 6))}`), `${JSON.stringify(r)} | ${log}`);
  check('the page is still on its own address after the drop (not navigated to the file)', (await app.evaluate(async () => global.__agent.browser.activeTab().webContents.getURL())).startsWith(base));

  // the same drop when this build's DevTools has no file drags: the page builds the files from their bytes
  await load('?noclick');
  await app.evaluate(() => { const d = global.__agent.browser.activeTab().webContents.debugger; const send = d.sendCommand.bind(d); d.sendCommand = (m, p) => (m === 'Input.dispatchDragEvent' ? Promise.reject(new Error('no drags')) : send(m, p)); });
  r = await call({ paths: files.slice(6, 9) });
  log = await pageLog();
  check('without file drags in DevTools, a drop built in the page from the bytes still delivers names and sizes', r.ok && log.includes(`drop: ${expected(files.slice(6, 9))}`) && /bytes/.test(r.out), `${JSON.stringify(r)} | ${log}`);

  // ---- 5. a menu step that is not there is reported, nothing is uploaded
  await load('');
  r = await call({ paths: files.slice(0, 1), open: ['New', 'Folder upload'] });
  check('a menu step that does not exist is named in the error and nothing was uploaded', !r.ok && /Folder upload/.test(r.error) && !/picker:/.test(await pageLog()), JSON.stringify(r));

  // ---- 5b. pages whose handler gets in the way of the chooser (each fixture mode in test/fixtures/drive-like.html)
  await load('?trustedmenu');
  r = await call({ paths: files.slice(0, 3), open: ['New', 'File upload'] });
  log = await pageLog();
  check('a menu item that acts on a real mouseup only still opens the chooser: the click is a real mouse press', r.ok && log.includes(`picker: ${expected(files.slice(0, 3))}`), `${JSON.stringify(r)} | ${log}`);
  await load('?detached');
  r = await call({ paths: files.slice(0, 5), open: ['New', 'File upload'] });
  log = await pageLog();
  check('an input the page makes, never adds to its document and click()s still gets the files', r.ok && log.includes(`picker: ${expected(files.slice(0, 5))}`), `${JSON.stringify(r)} | ${log}`);
  await load('?covered');
  r = await call({ paths: files.slice(0, 2), open: ['New', 'File upload'] });
  log = await pageLog();
  check('a menu item an overlay covers is clicked with a user gesture, so the chooser still opens', r.ok && log.includes(`picker: ${expected(files.slice(0, 2))}`), `${JSON.stringify(r)} | ${log}`);
  await load('?lateclick');
  r = await call({ paths: files.slice(0, 4), open: ['New', 'File upload'] });
  log = await pageLog();
  check('a page that click()s a detached input with no user activation left: the hook gives that input the files', r.ok && log.includes(`picker: ${expected(files.slice(0, 4))}`) && /never put in its document/.test(r.out), `${JSON.stringify(r)} | ${log}`);
  const stillHooked = await app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('Boolean(window[Symbol.for("lumen.fileHook")])'));
  check('the hook is gone from the page afterwards', stillHooked === false, stillHooked);

  // ---- 6. the device-access rules still hold
  await load('?latent');
  const secret = path.join(os.homedir(), '.ssh', 'id_rsa');
  r = await call({ paths: [secret] });
  check('a credentials path is refused whatever the route', !r.ok && !/latent:/.test(await pageLog()), JSON.stringify(r));
  await app.evaluate(() => { global.__agent.browser.deviceAccess = () => false; });
  r = await call({ paths: files.slice(0, 1), open: ['New', 'File upload'] });
  check('with "use files on this computer" off, paths are refused', !r.ok && !/latent:|picker:|drop:/.test(await pageLog()), JSON.stringify(r));
  await app.evaluate(() => { global.__agent.browser.deviceAccess = () => true; });
  r = await call({ paths: [path.join(work, 'missing.pdf')] });
  check('a file that does not exist is refused by name', !r.ok && /missing\.pdf/.test(r.error), JSON.stringify(r));

  check('no page errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
