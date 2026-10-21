// Ctrl+Shift+T reopens the last closed tab (Chrome), from every place the keyboard can be, in the real app (hidden:
// LUMEN_TEST_BACKGROUND=1). Keys arrive as a user's do (webContents.sendInputEvent keyDown/keyUp with modifiers). A tab closed by
// Ctrl+W, its x or a middle click comes back where it was, with its URL and back/forward list; a file tab too; repeated presses
// go last-closed-first. (The tab-switching keys are in tab-cycle-keys.js.)
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

function makePdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reopen-tmp-'));
  const pdfFile = path.join(dir, 'doc.pdf');
  fs.writeFileSync(pdfFile, makePdf('Reopen me'));
  const server = http.createServer((req, res) => {
    if (req.url === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(makePdf('Served')); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Page ${req.url.slice(1)}</title><input id="a"><textarea id="t"></textarea><p>${req.url}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reopen-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: dir, TMP: dir },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  await sleep(1000);

  const list = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, url: t.url })));
  const switchTo = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
  const go = async (text) => { await app.evaluate(({ ipcMain }, t) => ipcMain.emit('nav:go', {}, t), text); await sleep(1500); };
  const tabJs = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  const press = (to, keyCode, modifiers) => app.evaluate(async ({ BrowserWindow }, [to, k, m]) => {
    const wc = to === 'page' ? (global.__agent.browser.activeTab()?.webContents || global.__chatPage.contents(global.__chatPage.activeId())) : [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
    await new Promise((r) => setTimeout(r, 300));
  }, [to, keyCode, modifiers]);
  const open = async (url) => { const n = (await list()).length; await app.evaluate((_e, u) => global.__agent.browser.openTab(u), url); await waitFor(async () => (await list()).length === n + 1); await sleep(900); return (await list()).pop().id; };
  const historyOf = (id) => app.evaluate((_e, i) => { const t = global.__agent.browser.tabById(i); const nav = t.webContents.navigationHistory; return { n: nav.getAllEntries().length, url: t.webContents.getURL() }; }, id);

  // closing: three ways
  const closers = {
    'Ctrl+W': async (id) => { await switchTo(id); await sleep(300); await press('page', 'W', ['control']); },
    'the tab\'s x': async (id) => { await ui.evaluate((i) => document.querySelector(`#tabs .tab[data-id="${i}"] .tab-close`).click(), id); },
    'a middle click': async (id) => { await ui.evaluate((i) => document.querySelector(`#tabs .tab[data-id="${i}"]`).dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })), id); },
  };
  const places = [
    ['a web page', 'page', async () => { await go(`${base}/p`); await tabJs('document.body.focus()'); }],
    ['a text field in a page', 'page', async () => { await go(`${base}/p`); await tabJs("document.getElementById('a').focus()"); }],
    ['the address bar', 'ui', async () => { await ui.evaluate(() => document.getElementById('address').focus()); }],
    ['the new-tab page', 'page', async () => { await go('lumen://newtab'); }],
    ['the PDF viewer', 'page', async () => { await go(`${base}/doc.pdf`); await sleep(1500); }],
    ['the sidebar chat composer', 'ui', async () => {
      if (await ui.evaluate(() => document.body.classList.contains('sidebar-hidden'))) await ui.evaluate(() => window.browser.toggleSidebar?.());
      await ui.evaluate(() => document.getElementById('prompt').focus());
    }],
    ['the full-page chat', 'page', async () => { await app.evaluate(() => global.__chatPage.open()); await sleep(2000); }],
  ];

  await go(`${base}/home`);
  await open(`${base}/anchor`); // a tab after the victim, so "where it was" is a middle position
  let n = 0;
  for (const [closer, close] of Object.entries(closers)) {
    for (const [place, to, setup] of places) {
      const url = `${base}/victim${++n}`;
      const id = await open(url);
      await go(`${url}-b`); // a second page: the back/forward list has two entries
      const wasAt = (await list()).findIndex((t) => t.id === id);
      await open(`${base}/after${n}`);
      await close(id);
      const closed = await waitFor(async () => !(await list()).some((t) => t.id === id));
      await switchTo((await list())[0].id);
      await setup();
      const before = await list();
      await press(to, 'T', ['control', 'shift']);
      const after = await waitFor(async () => { const l = await list(); return l.length === before.length + 1 ? l : null; }, 3000);
      const back = after?.find((t) => !before.some((b) => b.id === t.id));
      const h = back ? await historyOf(back.id) : null;
      const at = after ? after.findIndex((t) => t.id === back?.id) : -1;
      check(`closed by ${closer}, Ctrl+Shift+T from ${place}: the tab is back (URL, history, place)`,
        closed && Boolean(back) && h.url === `${url}-b` && h.n >= 2 && at === wasAt, JSON.stringify({ closed, back, h, at, wasAt }));
    }
  }

  // last-closed-first, three presses
  const a = await open(`${base}/r1`); const b = await open(`${base}/r2`); const c = await open(`${base}/r3`);
  for (const id of [a, b, c]) await closers['Ctrl+W'](id);
  await waitFor(async () => !(await list()).some((t) => [a, b, c].includes(t.id)));
  const got = [];
  for (let i = 0; i < 3; i++) {
    const before = await list();
    await press('page', 'T', ['control', 'shift']);
    const l = await waitFor(async () => { const x = await list(); return x.length === before.length + 1 ? x : null; }, 3000);
    got.push(l ? l.find((t) => !before.some((x) => x.id === t.id))?.url.split('/').pop() : null);
  }
  check('three presses reopen the tabs last-closed-first', got.join() === 'r3,r2,r1', got.join());

  // a file tab comes back (the viewer shows the file; the reopen address is the file's own)
  const fileUrl = pathToFileURL(pdfFile).href;
  const f = await open(fileUrl);
  await sleep(1200);
  await closers['Ctrl+W'](f);
  await waitFor(async () => !(await list()).some((t) => t.id === f));
  const beforeFile = await list();
  await press('page', 'T', ['control', 'shift']);
  const fileBack = await waitFor(async () => { const x = await list(); return x.length === beforeFile.length + 1 ? x.find((t) => !beforeFile.some((y) => y.id === t.id)) : null; }, 3000);
  check('a closed file tab (PDF) is reopened by Ctrl+Shift+T', Boolean(fileBack) && /doc\.pdf/.test(fileBack.url), JSON.stringify(fileBack));

  // nothing left to reopen: the key does nothing (no crash, no extra tab) once the closed-tab list is empty
  for (let i = 0; i < 60; i++) { const l = await list(); const k = l.length; await press('page', 'T', ['control', 'shift']); if ((await list()).length === k) break; }
  const settled = await list();
  await press('page', 'T', ['control', 'shift']);
  check('with no closed tab left Ctrl+Shift+T opens nothing in the same window', (await list()).length === settled.length, `${settled.length} -> ${(await list()).length}`);

  await app.close();
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
