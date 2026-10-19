// Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp / PageDown switch tabs from every place the keyboard can be, in the real app (hidden:
// LUMEN_TEST_BACKGROUND=1). Keys arrive the way a user's do: webContents.sendInputEvent keyDown/keyUp with modifiers and a
// keyCode, to the contents that has the focus (the browser UI for the address bar and the sidebar chat, the tab for a page, a text
// field, the new-tab page, the PDF viewer and the full-page chat). Three tabs, the middle one active: the previous / next one
// must come to the front, wrapping at the ends. Shift+Tab alone (no Ctrl) must still reach the page for focus navigation.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabkeys-tmp-'));
  const pdf = makePdf('Tab keys');
  const server = http.createServer((req, res) => {
    if (req.url === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Page ${req.url.slice(1)}</title><input id="a"><input id="b"><textarea id="t"></textarea><p>${req.url}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabkeys-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: dir, TMP: dir },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  await sleep(1000);

  const list = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => t.id));
  const active = () => app.evaluate(() => global.__chatPage.activeId());
  const switchTo = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
  const go = async (text) => { await app.evaluate(({ ipcMain }, t) => ipcMain.emit('nav:go', {}, t), text); await sleep(1500); };
  const tabJs = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  // A real key press, to the browser UI ('ui') or to the active tab ('page').
  const press = (to, keyCode, modifiers) => app.evaluate(async ({ BrowserWindow }, [to, k, m]) => {
    const wc = to === 'page' ? (global.__agent.browser.activeTab()?.webContents || global.__chatPage.contents(global.__chatPage.activeId())) : [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
    await new Promise((r) => setTimeout(r, 250));
  }, [to, keyCode, modifiers]);

  // three tabs in a row, the middle one active (the first tab is whatever the window opened with)
  await go(`${base}/one`);
  for (const n of ['two', 'three']) { await app.evaluate((_e, u) => global.__agent.browser.openTab(u), `${base}/${n}`); await sleep(1200); }
  const ids = (await list()).slice(-3);
  const middle = ids[1];

  const keys = [
    ['Ctrl+Shift+Tab', 'Tab', ['control', 'shift'], -1],
    ['Ctrl+Tab', 'Tab', ['control'], 1],
    ['Ctrl+PageUp', 'PageUp', ['control'], -1],
    ['Ctrl+PageDown', 'PageDown', ['control'], 1],
  ];
  const places = [
    ['a web page', 'page', async () => { await go(`${base}/p`); await tabJs('document.body.focus()'); }],
    ['a text field in a page', 'page', async () => { await go(`${base}/p`); await tabJs("document.getElementById('a').focus()"); }],
    ['a textarea in a page', 'page', async () => { await go(`${base}/p`); await tabJs("document.getElementById('t').focus()"); }],
    ['the address bar', 'ui', async () => { await ui.evaluate(() => document.getElementById('address').focus()); }],
    ['the new-tab page', 'page', async () => { await go('lumen://newtab'); }],
    ['the PDF viewer', 'page', async () => { await go(`${base}/doc.pdf`); await sleep(1500); }],
    ['the sidebar chat composer', 'ui', async () => {
      if (await ui.evaluate(() => document.body.classList.contains('sidebar-hidden'))) await ui.evaluate(() => window.browser.toggleSidebar?.());
      await ui.evaluate(() => document.getElementById('prompt').focus());
    }],
    ['the full-page chat', 'page', async () => { await go('lumen://chat'); await sleep(1500); }],
  ];
  for (const [place, to, setup] of places) {
    for (const [label, keyCode, modifiers, dir] of keys) {
      await switchTo(middle);
      await waitFor(async () => (await active()) === middle);
      await setup();
      const cur = await active(); // (the full-page chat opens as a tab of its own: the keys go from there)
      const all = await list();
      const at = all.indexOf(cur);
      const want = all[(at + dir + all.length) % all.length];
      await press(to, keyCode, modifiers);
      const got = await waitFor(async () => { const a = await active(); return a !== cur ? a : null; }, 2500);
      check(`${label} from ${place}: goes to the ${dir < 0 ? 'previous' : 'next'} tab`, got === want, JSON.stringify({ got, want, cur }));
    }
  }

  // wrapping: Ctrl+Shift+Tab on the first tab lands on the last, Ctrl+Tab on the last on the first
  await go(`${base}/p`);
  const all = await list();
  await switchTo(all[0]);
  await waitFor(async () => (await active()) === all[0]);
  await press('page', 'Tab', ['control', 'shift']);
  check('Ctrl+Shift+Tab on the first tab wraps to the last', await waitFor(async () => (await active()) === all[all.length - 1], 2500), await active());
  await press('page', 'Tab', ['control']);
  check('Ctrl+Tab on the last tab wraps to the first', await waitFor(async () => (await active()) === all[0], 2500), await active());

  // Shift+Tab alone is focus navigation: the page gets it, the tab stays
  await switchTo(middle);
  await waitFor(async () => (await active()) === middle);
  await go(`${base}/p`);
  await tabJs("document.getElementById('b').focus()");
  await press('page', 'Tab', ['shift']);
  await sleep(300);
  const focus = await tabJs('document.activeElement && document.activeElement.id');
  check('Shift+Tab alone still moves focus inside the page', (await active()) === middle && focus === 'a', `${await active()} ${focus}`);

  await app.close();
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
