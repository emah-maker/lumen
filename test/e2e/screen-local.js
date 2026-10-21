// "What does this say?" with a file in front of the user, in the real app (hidden: LUMEN_TEST_BACKGROUND=1): the sidebar's screenshot and text of a
// local PDF in Lumen's viewer go to the model only after one card ("Share <file> with the AI?"), a web PDF in the viewer is captured as its site with no
// card, Lumen's own pages are never captured (the new tab says so plainly), and "Turn off AI here" for local files gets its own message. The model
// is a fake client that records the request, so the test sees exactly what would have been sent. Offline: a temp folder with a hand-made PDF.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// A valid one-page PDF, built by hand so the test needs no fixture file.
function makePdf(text) {
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
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
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 800)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-screen-local-'));
  const folder = path.join(dir, 'Private Folder');
  fs.mkdirSync(folder);
  const localPdf = path.join(folder, 'Syllabus.pdf');
  fs.writeFileSync(localPdf, makePdf('The midterm exam is on Tuesday at noon in room 214.'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(makePdf('The web paper says the library closes at nine.')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const webPdf = `http://127.0.0.1:${server.address().port}/paper.pdf`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-screen-local-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: dir, TMP: dir, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  // The model is fake: it records the request it gets (the last user message) and answers.
  await app.evaluate(() => {
    const fake = global.__fake = { requests: [] };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const last = [...params.messages].reverse().find((m) => m.role === 'user');
      fake.requests.push(JSON.stringify(last.content));
      const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Okay.' }], usage: { input_tokens: 10, output_tokens: 5 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Okay.' } }; }, finalMessage: async () => message };
    } } } });
  });
  const requests = () => app.evaluate(() => global.__fake.requests.slice());
  const openTab = (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); return t.id; }, url);
  const tabUrl = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });

  const send = async (text) => {
    await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));
    await ui.evaluate((t) => { const p = document.getElementById('prompt'); p.focus(); p.value = t; p.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }, text);
  };
  const done = async (before) => { await waitFor(async () => (await requests()).length > before); await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop'))); };
  const cardText = () => ui.evaluate(() => document.querySelector('.approval-file:not(.answered)')?.innerText || '');
  const notices = () => ui.evaluate(() => [...document.querySelectorAll('.notice')].map((n) => n.textContent));
  const click = (label) => ui.evaluate((l) => { const b = [...document.querySelectorAll('.approval-file:not(.answered) button')].find((x) => x.textContent === l); if (b) b.click(); return Boolean(b); }, label);
  const newChat = async () => { await ui.evaluate(() => window.assistant.reset()); await sleep(300); };
  const hasImage = (req) => /"type":"image"/.test(req);

  // ---- a local PDF in Lumen's viewer
  await openTab(pathToFileURL(localPdf).href);
  check('the PDF opened in Lumen\'s viewer', (await tabUrl()).startsWith('lumen-pdf://'), await tabUrl());
  await sleep(1200); // the viewer draws the page
  let n = (await requests()).length;
  await send('what ab what it says here');
  const card = await waitFor(cardText, 12000);
  check('a card asks before anything of the file is shared, naming the file', /Share Syllabus\.pdf with the AI\?/.test(card) && /see this file/.test(card), card);
  check('the card offers Allow for this chat, Allow always for this file and Don\'t allow', await ui.evaluate(() => [...document.querySelectorAll('.approval-file:not(.answered) button')].map((b) => b.textContent).join('|')) === 'Don’t allow|Allow always for this file|Allow for this chat');
  check('nothing was sent to the model while the card was open', (await requests()).length === n);
  await click('Allow for this chat');
  await done(n);
  let req = (await requests()).at(-1);
  check('after Allow: the request has the screenshot', hasImage(req), req.slice(0, 300));
  check('after Allow: the request has the PDF\'s text', /midterm exam is on Tuesday/i.test(req), req.slice(0, 600));
  check('the request names the file but not its folder or the viewer address', /Syllabus\.pdf/.test(req) && !/Private Folder|lumen-pdf|lumen-screen-local/.test(req), req.slice(0, 600));
  check('no refusal was shown', !(await notices()).some((t) => /left out|not shared|Nothing from/.test(t)), JSON.stringify(await notices()));

  n = (await requests()).length;
  await send('and what is this page about?');
  await done(n);
  check('the same file in the same chat is not asked again', (await cardText()) === '' && hasImage((await requests()).at(-1)));

  // ---- Don't allow sends nothing
  await newChat();
  n = (await requests()).length;
  await send('what does this say');
  check('a new chat asks again', /Share Syllabus\.pdf/.test(await waitFor(cardText, 12000)));
  await click('Don’t allow');
  await done(n);
  req = (await requests()).at(-1);
  check('Don\'t allow: no screenshot, no PDF text, no file name in the request', !hasImage(req) && !/midterm|Syllabus/i.test(req), req.slice(0, 500));
  check('Don\'t allow: the user is told what was left out', (await notices()).some((t) => /chose not to share Syllabus\.pdf/.test(t)), JSON.stringify(await notices()));

  // ---- the camera button asks the same way
  await newChat();
  n = (await requests()).length;
  await ui.evaluate(() => { const b = document.getElementById('screen-btn'); if (b.dataset.state !== 'on') b.click(); });
  await send('hello');
  check('the camera button on a local file: the same card', /Share Syllabus\.pdf/.test(await waitFor(cardText, 12000)));
  await click('Allow always for this file');
  await done(n);
  req = (await requests()).at(-1);
  check('camera button + Allow always: screenshot and text go along', hasImage(req) && /midterm exam/i.test(req), req.slice(0, 400));
  const saved = await ui.evaluate(() => window.lumenExtras?.sharedFiles?.() ?? null);
  const stored = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).aiSharedFiles;
  check('Allow always: the file is kept in the settings (its own address)', Array.isArray(stored) && stored.length === 1 && /Syllabus\.pdf$/.test(stored[0]), JSON.stringify([stored, saved]));

  await newChat();
  n = (await requests()).length;
  await send('what does this say');
  await done(n);
  check('a file allowed always is not asked about again, even in a new chat', (await cardText()) === '' && hasImage((await requests()).at(-1)) && /midterm exam/i.test((await requests()).at(-1)));

  // ---- "Turn off AI here" for local files: its own message
  await ui.evaluate(() => window.lumenExtras.setAiSite('local files', true));
  await newChat();
  n = (await requests()).length;
  await send('what does this say');
  await done(n);
  req = (await requests()).at(-1);
  check('AI off for local files: no card, nothing of the file sent', (await cardText()) === '' && !hasImage(req) && !/midterm|Syllabus/i.test(req), req.slice(0, 400));
  const off = (await notices()).find((t) => /turned off AI for local files/.test(t)) || '';
  check('AI off for local files: the message says exactly that and how to turn it back on', /Turn on AI/.test(off) && /Settings/.test(off) && !/does not share its own pages/.test(off), JSON.stringify(await notices()));
  await ui.evaluate(() => window.lumenExtras.setAiSite('local files', false));

  // ---- Bypass permissions: no card, the file goes, a step says so; the local-files switch still wins; Auto-allow still asks
  await app.evaluate(() => { global.__bypass = global.__agent.browser.bypassPermissions; global.__agent.browser.bypassPermissions = () => true; global.__agent.browser.fileShared = () => false; });
  await ui.evaluate(() => window.lumenExtras.setAiSite('local files', true));
  await newChat();
  n = (await requests()).length;
  await send('what does this say');
  await done(n);
  check('Bypass + AI off for local files: still refused, with the specific message', !hasImage((await requests()).at(-1)) && (await notices()).some((t) => /turned off AI for local files/.test(t)), JSON.stringify(await notices()));
  await ui.evaluate(() => window.lumenExtras.setAiSite('local files', false));
  await app.evaluate(() => { global.__agent.browser.fileShared = () => false; });
  await newChat();
  n = (await requests()).length;
  await send('what does this say');
  await done(n);
  req = (await requests()).at(-1);
  const stepSeen = await ui.evaluate(() => document.body.innerText.includes('Allowed automatically: shared Syllabus.pdf'));
  check('Bypass on: no card, the file is sent, and "Allowed automatically: shared Syllabus.pdf" shows', (await cardText()) === '' && hasImage(req) && /midterm exam/i.test(req) && stepSeen, req.slice(0, 200));
  await app.evaluate(() => { global.__agent.browser.bypassPermissions = global.__bypass; });
  await newChat();
  n = (await requests()).length;
  await send('what does this say');
  check('Auto-allow (not Bypass): the card still appears', /Share Syllabus.pdf/.test(await waitFor(cardText, 12000)));
  await click('Don’t allow');
  await done(n);

  // ---- a web PDF in the viewer counts as its site: captured, with its text, no card
  await openTab(webPdf);
  check('the web PDF opened in Lumen\'s viewer', (await tabUrl()).startsWith('lumen-pdf://'), await tabUrl());
  await sleep(1500);
  await newChat();
  n = (await requests()).length;
  await send('what does this say');
  await done(n);
  req = (await requests()).at(-1);
  check('a web PDF: no card, the screenshot and its text go along', (await cardText()) === '' && hasImage(req) && /library closes at nine/i.test(req), req.slice(0, 500));

  // ---- Lumen's own pages are never captured; the new tab says so plainly
  await openTab(undefined);
  check('the new tab page is in front', /newtab.html/.test(await tabUrl()), await tabUrl());
  await newChat();
  n = (await requests()).length;
  await send('what is this?');
  await done(n);
  req = (await requests()).at(-1);
  check('the new tab: nothing captured and no card', !hasImage(req) && (await cardText()) === '', req.slice(0, 300));
  check('the new tab: it says so plainly', (await notices()).some((t) => t === "That's Lumen's new tab page, so there's nothing on it to read."), JSON.stringify(await notices()));

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
