// Downloads: pause, resume and cancel from the Downloads menu; a risky file is held until the user
// agrees and is not downloaded twice (a one-time link still works); two files with the same name
// at once get different names; everything goes to the folder chosen in Settings.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let toolRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/slow.bin')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 40 * 16384, 'Content-Disposition': 'attachment; filename="slow.bin"' });
      let sent = 0;
      const timer = setInterval(() => { res.write(Buffer.alloc(16384, 7)); if (++sent === 40) { clearInterval(timer); res.end(); } }, 100);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url.startsWith('/tool.exe')) {
      toolRequests += 1;
      if (toolRequests > 1) { res.writeHead(410); return res.end('gone: one-time link'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="lumen-tool.exe"' });
      return res.end(Buffer.alloc(30000, 1));
    }
    if (req.url.startsWith('/same')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="same.txt"' });
      setTimeout(() => res.end(`copy ${req.url}`), 400);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Downloads fixture</title>');
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dl-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), dlDir);
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}/`);
  const start = (url) => app.evaluate((_e, u) => global.__agent.browser.activeTab().webContents.downloadURL(u), url);
  const list = () => app.evaluate(() => global.__downloads.list());
  const click = (index, label) => app.evaluate((_e, [i, l]) => {
    const item = global.__downloads.menu()[i];
    const action = (item.submenu || []).find((s) => s.label === l);
    if (!action) return `no "${l}" in ${JSON.stringify(item)}`;
    action.click();
    return 'ok';
  }, [index, label]);
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

  // ---- pause, resume, cancel
  await start(`${base}/slow.bin`);
  await waitFor(async () => (await list())[0]?.received > 0);
  check('Pause is offered while downloading', (await click(0, 'Pause')) === 'ok', await click(0, 'Pause'));
  await waitFor(async () => (await list())[0]?.paused);
  const pausedAt = (await list())[0].received;
  await sleep(800);
  const still = (await list())[0];
  check('a paused download stops', still.paused && still.received === pausedAt, JSON.stringify(still));
  check('Resume continues it', (await click(0, 'Resume')) === 'ok', 'no resume');
  check('it finishes', await waitFor(async () => (await list())[0]?.state === 'completed', 15000), JSON.stringify((await list())[0]));
  check('it lands in the folder chosen in Settings', fs.existsSync(path.join(dlDir, 'slow.bin')) && fs.statSync(path.join(dlDir, 'slow.bin')).size === 40 * 16384, fs.readdirSync(dlDir).join(','));
  const count = (await list()).length;
  await start(`${base}/slow.bin?2`);
  await waitFor(async () => (await list()).length > count && (await list())[0].received > 0);
  check('Cancel is offered', (await click(0, 'Cancel')) === 'ok', 'no cancel');
  check('a cancelled download is marked cancelled', await waitFor(async () => (await list())[0]?.state === 'cancelled'), JSON.stringify((await list())[0]));
  check('a cancelled download leaves no file', !fs.existsSync(path.join(dlDir, 'slow (1).bin')), fs.readdirSync(dlDir).join(','));
  const retry = await app.evaluate(() => global.__downloads.menu()[0].submenu?.[0]?.label);
  check('a cancelled download offers Retry', retry === 'Retry', retry);

  // ---- a risky file waits for the user's OK and is fetched only once
  await start(`${base}/tool.exe`);
  const overlay = () => app.evaluate(() => global.__dialogs.currentId());
  check('a risky file asks first', await waitFor(async () => (await overlay()) !== null, 5000), 'no dialog');
  await sleep(500);
  check('nothing reaches the folder while unanswered', !fs.readdirSync(dlDir).some((f) => f.startsWith('lumen-tool')), fs.readdirSync(dlDir).join(','));
  await app.evaluate(() => global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 1 }));
  check('after Download it is saved', await waitFor(async () => fs.existsSync(path.join(dlDir, 'lumen-tool.exe')) && fs.statSync(path.join(dlDir, 'lumen-tool.exe')).size === 30000), fs.readdirSync(dlDir).join(',') + ' ' + JSON.stringify((await list())[0]));
  check('it was downloaded once (a one-time link still works)', toolRequests === 1, `${toolRequests} requests`);

  // ---- two files with the same name at once
  await start(`${base}/same?a`);
  await start(`${base}/same?b`);
  await waitFor(async () => (await list()).filter((d) => d.name.startsWith('same') && d.state === 'completed').length === 2);
  const same = fs.readdirSync(dlDir).filter((f) => f.startsWith('same')).sort();
  const texts = same.map((f) => fs.readFileSync(path.join(dlDir, f), 'utf8')).sort();
  check('same-named downloads at once get different names', same.length === 2 && same[0] !== same[1] && texts[0] === 'copy /same?a' && texts[1] === 'copy /same?b', `${same.join(',')} ${texts.join('|')}`);

  const open = await app.evaluate(() => global.__downloads.menu().some((m) => m.label === 'Open Downloads Folder'));
  check('the menu keeps Open Downloads Folder', open, 'missing');

  await app.close();
  server.close();
  fs.rmSync(dlDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
