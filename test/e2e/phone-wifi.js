// [phone wifi] Receive from Phone (Wi-Fi) in a real Lumen window (main.js openWifiUpload, features/wifi-upload.js), on 127.0.0.1
// (tests stand in for the Wi-Fi address): the QR sheet opens and the server answers only while it is open; a file sent to it
// lands in the phone inbox; closing the sheet stops the server and shows the strip's toast (from a menu) or puts the files
// and the note straight into the composer (from the composer's + menu). Throwaway profile and inbox.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const request = (url, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end(body || undefined);
});
const send = (url, name, data, note) => request(`${url}/upload`, { method: 'POST', body: data, headers: { 'x-lumen-upload': '1', 'x-file-name': encodeURIComponent(name), 'content-type': 'application/pdf', 'content-length': String(data.length), ...(note ? { 'x-caption': encodeURIComponent(note) } : {}) } });

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-phone-wifi-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-phone-wifi-dl-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };
    await app.evaluate((_e, dir) => { global.__phoneInboxDir = dir; global.__wifiLoopback = true; }, downloads);
    const sheetOpen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => global.__screenshot.overlay.currentFor(w)?.mode === 'qr'));

    // ---- from a menu: the toast afterwards
    const info = await app.evaluate(() => global.__phone.wifi());
    const url = await app.evaluate(() => global.__wifiUrl);
    check('the sheet opens with a QR for the one-time address', info && (await waitFor(sheetOpen)) && /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/.test(url), url);
    check('the phone page answers while it is open', (await request(url)).status === 200);
    const r = await send(url, 'Lease.pdf', Buffer.from('%PDF-1.4 lease'));
    check('a file sent from the page lands in Downloads/From phone', r.status === 200 && fs.readFileSync(path.join(downloads, 'From phone', 'Lease.pdf'), 'utf8') === '%PDF-1.4 lease', `${r.status} ${r.body}`);
    check('no toast while the sheet is still open', !(await app.evaluate(() => (global.__phoneNotes || []).length)));
    await app.evaluate(() => global.__phone.wifiClose());
    check('closing the sheet stops the server', !(await app.evaluate(() => global.__phone.wifiStatus().running)) && (await request(url).then(() => false, () => true)));
    const toast = await waitFor(() => ui.evaluate(() => { const n = document.querySelector('.organize-note'); return n && { text: n.querySelector('.organize-note-text')?.textContent, button: n.querySelector('button')?.textContent }; }));
    check('…and the strip says what came, with Attach to chat', toast && /Lease\.pdf came from your phone/.test(toast.text) && toast.button === 'Attach to chat', JSON.stringify(toast));

    // ---- from the composer's + menu: straight into the composer
    check('the composer\'s + menu has From your phone (Wi-Fi)', await ui.evaluate(() => Boolean(document.getElementById('from-phone'))));
    await ui.evaluate(() => window.browser.phoneWifi());
    await waitFor(sheetOpen);
    const url2 = await waitFor(async () => { const u = await app.evaluate(() => global.__wifiUrl); return u !== url ? u : null; });
    check('a new sheet has a new address', url2 && url2 !== url);
    check('the old address stays dead', await request(url).then(() => false, () => true));
    await send(url2, 'a.pdf', Buffer.from('%PDF a'), 'compare these');
    await send(url2, 'b.pdf', Buffer.from('%PDF b'));
    await app.evaluate(() => global.__phone.wifiClose());
    const composer = await waitFor(() => ui.evaluate(() => { const chips = document.querySelectorAll('#attachments .attachment').length; return chips >= 2 ? { chips, prompt: document.getElementById('prompt').value } : null; }));
    check('from the composer, both files go into the composer when it closes', composer?.chips === 2, JSON.stringify(composer));
    check('…with the note in the prompt, not sent', composer?.prompt === 'compare these', JSON.stringify(composer));
    const events = await app.evaluate(() => global.__wifiEvents.map((e) => `${e.type}${e.reason ? `:${e.reason}` : ''}`));
    check('each session was claimed by one device and stopped when closed', events.filter((e) => e === 'claimed').length === 2 && events.filter((e) => e === 'stopped:closed').length === 2, events.join(' '));

    // ---- the phone's page itself, in a real Chromium page (its own script under its strict CSP): pick a file, it uploads
    await app.evaluate(() => global.__phone.wifi());
    const url3 = await waitFor(async () => { const u = await app.evaluate(() => global.__wifiUrl); return u !== url2 ? u : null; });
    const pageRun = await app.evaluate(async ({ BrowserWindow }, u) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      const errors = [];
      w.webContents.on('console-message', (e) => { if (/Content Security Policy|Refused/i.test(e.message || '')) errors.push(e.message); });
      await w.loadURL(u);
      await w.webContents.executeJavaScript(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['from the page'], 'page-pick.txt', { type: 'text/plain' })); const input = document.getElementById('files'); input.files = dt.files; input.dispatchEvent(new Event('change')); })()`);
      let state = '';
      for (let i = 0; i < 50 && !/Sent|Didn/.test(state); i++) { await new Promise((r) => setTimeout(r, 100)); state = await w.webContents.executeJavaScript(`document.querySelector('#list li .state')?.textContent || ''`); }
      w.destroy();
      return { state, errors };
    }, url3);
    check('the phone page uploads a picked file with its own script (no CSP errors)', pageRun.state === 'Sent' && !pageRun.errors.length && fs.readFileSync(path.join(downloads, 'From phone', 'page-pick.txt'), 'utf8') === 'from the page', JSON.stringify(pageRun));
    await app.evaluate(() => global.__phone.wifiClose());
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(downloads, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
