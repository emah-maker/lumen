// upload_file in the real app (features/upload-files.js, agent.js uploadFile, the composer and the approval cards in
// renderer/chat-core.js), with a temp profile and a local page: attaching files of any kind in the composer, the AI putting
// them into a plain file input, a hidden input behind a label or a button, a drop zone whose click opens the page's file
// chooser, `accept` and `multiple`, the "Upload?" card and the "Choose file…" card (the OS picker stubbed), and every refusal
// (AI off on the site, a tab kept off, hands-off mode, a path the model typed). No network; run with LUMEN_TEST_BACKGROUND=1
// (set here) so no window shows. SHOTS=<dir> saves screenshots of the attachment chips and the cards.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'upload-page.html'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const host = `127.0.0.1:${server.address().port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-uploads-files-'));
  const file = (name, data) => { const p = path.join(work, name); fs.writeFileSync(p, data); return p; };
  const pdf = file('resume.pdf', '%PDF-1.4 my resume, private');
  const txt = file('cover.txt', 'Dear hiring manager');
  const png = file('photo.png', PNG);
  const chosen = file('chosen.pdf', '%PDF-1.4 picked by the user');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-uploads-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const shot = async (locator, name) => { if (!process.env.SHOTS) return; fs.mkdirSync(process.env.SHOTS, { recursive: true }); await locator.screenshot({ path: path.join(process.env.SHOTS, name) }); };

  // ---- the page, and ids from a read
  // (the first tab may still be loading the new-tab page: wait for it, and try again if that load was cut short)
  for (let attempt = 0; attempt < 4; attempt++) {
    const loaded = await app.evaluate(async (_e, u) => {
      const wc = global.__agent.browser.activeTab().webContents;
      for (let i = 0; i < 100 && wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 50));
      try { await wc.loadURL(u); return true; } catch { return false; }
    }, base);
    if (loaded) break;
  }
  const tabId = await app.evaluate(() => global.__agent.browser.activeTab().id);
  const outline = () => app.evaluate(async () => global.__agent.execute('read_page', { mode: 'compact' }));
  const idOf = async (re) => { const m = new RegExp(`\\[(\\d+)\\] ${re}`).exec(await outline()); if (!m) throw new Error(`no element ${re} in ${await outline()}`); return Number(m[1]); };
  const ids = { plain: await idOf('file "Cover letter"'), photoLabel: await idOf('control "Upload photo"'), browse: await idOf('button "Browse resume"'), pdfonly: await idOf('file "Transcript'), multi: await idOf('file "Supporting documents"'), zone: await idOf('button "Drop files here') };
  const pageLog = () => app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('document.getElementById("log").textContent'));

  // ---- the store and a way to call the tool the way the sidebar's loop and the MCP bridge do
  const CHAT = await app.evaluate(() => global.__chats.id());
  await app.evaluate(() => { global.__agent.browser.autoApprove = () => true; }); // (test mode's default: no site card)
  const attachRef = (name, bytes, chat = null) => app.evaluate((_e, a) => {
    const store = global.__uploads();
    const kept = store.stash({ name: a.name, data: Buffer.from(a.bytes, 'base64') });
    return store.adopt(a.chat || global.__chats.id(), [kept.ref])[0];
  }, { name, bytes: bytes.toString('base64'), chat });
  const refs = { pdf: await attachRef('resume.pdf', fs.readFileSync(pdf)), txt: await attachRef('cover.txt', fs.readFileSync(txt)), png: await attachRef('photo.png', fs.readFileSync(png)) };
  const call = (input, { name = 'upload_file', id = tabId } = {}) => app.evaluate(async (_e, a) => {
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
      return { ok: true, out, cards: events.filter((e) => e.type === 'approval').length };
    } catch (e) { return { ok: false, error: e.message, cards: events.filter((x) => x.type === 'approval').length }; }
  }, { name, id, input });

  // ---- 1. a plain file input
  let r = await call({ element_id: ids.plain, files: [refs.pdf.ref] });
  let log = await pageLog();
  check('a plain input takes the attached file, and the page got input then change, once each', r.ok && /plain: resume\.pdf \[input\+change\]/.test(log), `${JSON.stringify(r)} | ${log}`);
  check('the answer says the page shows the name and that nothing was submitted', /The page shows the file name/.test(r.out) && /Nothing was submitted/.test(r.out) && /Cover letter/.test(r.out), r.out);
  const content = await app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('document.getElementById("plain").files[0].text()'));
  check('the page reads the real bytes of the file', content === '%PDF-1.4 my resume, private', content);
  check('the marker the tool used on the input is gone', await app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('!document.querySelector("[data-lumen-upload]")')));

  // ---- 2. a hidden input behind a styled label, and behind a button
  r = await call({ element_id: ids.photoLabel, files: [refs.png.ref] });
  log = await pageLog();
  check('a label whose input is hidden: the photo goes into the input it controls', r.ok && /hid3: photo\.png \[input\+change\]/.test(log), `${JSON.stringify(r)} | ${log}`);
  r = await call({ element_id: ids.browse, files: [refs.pdf.ref] });
  log = await pageLog();
  check('a "Browse" button with a hidden input beside it: the input in the same form is used (no click needed)', r.ok && /hid2: resume\.pdf/.test(log), `${JSON.stringify(r)} | ${log}`);
  r = await call({ element_id: ids.browse, files: [refs.png.ref] });
  check('accept=.pdf: a PNG is refused with what the field accepts, and nothing was set', !r.ok && /isn't a type this field accepts \(PDF\)/.test(r.error) && !/hid2: photo/.test(await pageLog()), JSON.stringify(r));

  // ---- 3. a drop zone with no input in the page: its click opens the page's own chooser, answered with the file
  r = await call({ element_id: ids.zone, files: [refs.txt.ref] });
  log = await pageLog();
  check('a drop zone whose click opens a file chooser: the chooser is answered with the file', r.ok && /zone: cover\.txt/.test(log), `${JSON.stringify(r)} | ${log}`);
  r = await call({ element_id: ids.zone, files: [refs.png.ref] });
  check('the chooser\'s accept (.pdf,.txt) refuses a PNG, and says so', !r.ok && /isn't a type this field accepts/.test(r.error) && !/zone: photo/.test(await pageLog()), JSON.stringify(r));
  r = await call({ element_id: ids.zone, files: [refs.pdf.ref, refs.txt.ref] });
  check('the chooser allows several files (multiple)', r.ok && /zone: resume\.pdf, cover\.txt/.test(await pageLog()), JSON.stringify(r));
  await app.evaluate(async () => { global.__agent.browser.activeTab().webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {}); });
  check('the file-chooser interception is switched off again afterwards', await app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    return wc.debugger.isAttached();
  }));

  // ---- 4. accept and multiple on plain inputs
  r = await call({ element_id: ids.pdfonly, files: [refs.txt.ref] });
  check('accept=.pdf on a plain input: a text file is refused', !r.ok && /isn't a type this field accepts \(PDF\)/.test(r.error), JSON.stringify(r));
  r = await call({ element_id: ids.multi, files: [refs.pdf.ref, refs.txt.ref] });
  check('multiple: two files go into one field', r.ok && /multi: resume\.pdf, cover\.txt/.test(await pageLog()), JSON.stringify(r));
  r = await call({ element_id: ids.plain, files: [refs.pdf.ref, refs.txt.ref] });
  check('two files into a single-file input are refused with a clear message', !r.ok && /single file, and 2 were given/.test(r.error), JSON.stringify(r));

  // ---- 5. the model can only name attached files
  const before = await pageLog();
  for (const bad of [pdf, `file:///${pdf.replace(/\\/g, '/')}`, 'C:\\Windows\\win.ini', '/etc/passwd', 'f_ffffffffffffffffffffffff']) {
    r = await call({ element_id: ids.plain, files: [bad] });
    check(`a typed path or unknown ref is refused (${bad.slice(0, 26)}…)`, !r.ok && (/not a file ref/.test(r.error) || /No attached file has the ref/.test(r.error)) && r.cards === 0, JSON.stringify(r));
  }
  check('nothing reached the page from those', (await pageLog()) === before);
  const other = await app.evaluate((_e, a) => { const store = global.__uploads(); const k = store.stash({ name: 'secret.txt', data: Buffer.from('x') }); return store.adopt('0123456789abcdef', [k.ref])[0]; }, {});
  r = await call({ element_id: ids.plain, files: [other.ref] });
  check('another chat\'s attached file cannot be used', !r.ok && /No attached file has the ref/.test(r.error) && (await pageLog()) === before, JSON.stringify(r));

  // ---- 6. the user's own blocks
  await app.evaluate((_e, h) => global.__aiSites.set(h.split(':')[0], true), host);
  r = await call({ element_id: ids.plain, files: [refs.pdf.ref] });
  check('a site with AI off refuses the upload', !r.ok && /turned off AI on/.test(r.error) && (await pageLog()) === before, JSON.stringify(r));
  await app.evaluate((_e, h) => global.__aiSites.set(h.split(':')[0], false), host);
  await app.evaluate((_e, id) => global.__manners.keepOff(global.__aiTabs.tab(id)), tabId);
  r = await call({ element_id: ids.plain, files: [refs.pdf.ref] });
  check('a tab kept off (the shield) refuses the upload', !r.ok && /keeps the AI from acting on this tab/.test(r.error) && (await pageLog()) === before, JSON.stringify(r));
  await app.evaluate((_e, id) => global.__manners.keepOff(global.__aiTabs.tab(id), false), tabId);
  await app.evaluate(() => global.__patchSettings({ aiHandsOff: true }));
  r = await call({ element_id: ids.plain, files: [refs.pdf.ref] });
  check('hands-off mode refuses the upload on the user\'s tab', !r.ok && /Hands-off mode is on/.test(r.error) && (await pageLog()) === before, JSON.stringify(r));
  await app.evaluate(() => global.__patchSettings({ aiHandsOff: false }));
  r = await call({ element_id: ids.plain, files: [refs.pdf.ref] });
  check('with those blocks off again the upload works', r.ok, JSON.stringify(r));

  // ---- 7. the composer: any kind of file, chips, and what Lumen keeps
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(300);
  const pendingDir = path.join(profile, 'uploads', 'pending');
  const pending = () => (fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).length : 0);
  const pendingBefore = pending();
  await ui.setInputFiles('#attach-input', [pdf, txt, png]);
  await waitFor(async () => (await ui.locator('.attachment').count()) === 3);
  check('the paperclip takes any file: a PDF and a text file become chips, the picture a thumbnail', (await ui.locator('.attachment').count()) === 3 && (await ui.locator('.attachment-file').count()) === 2 && (await ui.locator('.attachment img').count()) === 1, `${await ui.locator('.attachment').count()}`);
  const chipText = await ui.locator('.attachment-file').first().innerText();
  check('a file chip shows its type, name and size', /PDF/.test(chipText) && /resume\.pdf/.test(chipText) && /\d+ B|KB/.test(chipText), chipText);
  check('the attach button names files, not only images', (await ui.getAttribute('#attach', 'aria-label')) === 'Attach files' && /up to 10/.test((await ui.getAttribute('#attach', 'title')) || ''), await ui.getAttribute('#attach', 'title'));
  check('every attached file, the picture too, is kept by Lumen until the message is sent', pending() - pendingBefore === 3, `${pending() - pendingBefore}`);
  await shot(ui.locator('#composer'), 'attachments.png');
  await ui.locator('.attachment-remove').nth(1).click({ force: true }); // ×  on cover.txt
  await waitFor(async () => (await ui.locator('.attachment').count()) === 2);
  check('× removes the chip and the file Lumen kept for it', (await ui.locator('.attachment').count()) === 2 && pending() - pendingBefore === 2, `${await ui.locator('.attachment').count()} ${pending() - pendingBefore}`);
  // dropping a PDF on the chat and pasting a file also attach
  await ui.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped'], 'dropped.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const sidebar = document.getElementById('sidebar');
    sidebar.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    sidebar.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitFor(async () => (await ui.locator('.attachment').count()) === 3);
  check('a file of any type dropped on the chat joins the message', (await ui.locator('.attachment-file').count()) === 2 && /dropped\.docx/.test(await ui.locator('.attachment-file').last().innerText()), await ui.locator('.attachment').count());
  await ui.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['zipped'], 'bundle.zip', { type: 'application/zip' }));
    document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await waitFor(async () => (await ui.locator('.attachment').count()) === 4);
  check('a file pasted into the message joins it too', /bundle\.zip/.test(await ui.locator('.attachment-file').last().innerText()), await ui.locator('.attachment').count());
  for (let i = 0; i < 2; i++) await ui.locator('.attachment-remove').last().click({ force: true }); // keep resume.pdf and the picture

  // ---- 8. a real message: the AI is told the names and refs (never the bytes), asks, and uploads
  await app.evaluate(async () => {
    const agent = global.__agent;
    agent.browser.autoApprove = () => false; // the sidebar's cards are what this part is about
    global.__reqs = [];
    global.__next = [];
    agent.getClient = () => ({ beta: { messages: { stream: (req) => {
      global.__reqs.push(JSON.parse(JSON.stringify(req.messages)));
      const last = req.messages[req.messages.length - 1];
      const answering = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
      let message;
      if (!answering && global.__next.length) {
        const step = global.__next.shift();
        const known = {};
        for (const m of req.messages) for (const b of Array.isArray(m.content) ? m.content : []) for (const line of String(b.text || '').split('\n')) { const hit = /^- (\{"ref".*\})$/.exec(line); if (hit) { const f = JSON.parse(hit[1]); known[f.name] = f.ref; } }
        const input = { element_id: step.element_id };
        if (step.names) input.files = step.names.map((n) => known[n] || n);
        message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${global.__reqs.length}`, name: 'upload_file', input }] };
      } else message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
    } } } });
  });
  const plan = (step) => app.evaluate((_e, s) => { global.__next.push(s); }, step);
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const logBefore = await pageLog();
  await plan({ element_id: ids.plain, names: ['resume.pdf'] });
  await send('upload my resume to this job form');
  const siteCard = await waitFor(() => ui.locator('.approval:not(.resolved):not(.approval-upload)').count().then((n) => n > 0));
  check('the site approval comes first, as for a click', siteCard);
  await waitFor(() => ui.locator('.msg.user .msg-file').count().then((n) => n === 1));
  check('the sent message shows the file as a chip under the words', (await ui.locator('.msg.user .msg-file').count()) === 1 && /resume\.pdf/.test(await ui.locator('.msg.user .msg-file').first().innerText()), `${await ui.locator('.msg.user').count()} user bubbles; chat: ${(await ui.locator('#messages').innerText()).slice(0, 400)}`);
  await ui.locator('.approval:not(.resolved):not(.approval-upload) .btn.primary').click();
  const uploadCard = await waitFor(() => ui.locator('.approval-upload:not(.resolved)').count().then((n) => n > 0));
  check('then the upload card: the file names and the site, with Upload / Don\'t upload', uploadCard && /resume\.pdf/.test(await ui.locator('.approval-upload .approval-files').innerText()) && new RegExp(`upload resume\\.pdf to ${host.replace('.', '\\.')}`).test(await ui.locator('.approval-upload .approval-title').innerText()) && (await ui.locator('.approval-upload .btn').allInnerTexts()).join('|') === 'Don’t upload|Upload', uploadCard ? await ui.locator('.approval-upload').innerText() : 'no card');
  await shot(ui.locator('.approval-upload'), 'upload-card.png');
  const req0 = await app.evaluate(() => JSON.stringify(global.__reqs[0]));
  check('the model was told the file\'s name and ref, with the instruction to use upload_file', /<attached_files>/.test(req0) && /resume\.pdf/.test(req0) && /f_[0-9a-f]{24}/.test(req0) && /upload_file/.test(req0), req0.slice(-700));
  check('the model was sent no file contents and no path (only the picture, which goes as a picture as before; the auto screen capture of the page, since "this job form" refers to the screen, is not a file)', !/my resume, private/.test(req0) && (req0.replace(/<\/screen_capture>"},{"type":"image"/, '').match(/"type":"image"/g) || []).length === 1 && !req0.includes(work.replace(/\\/g, '\\\\')) && !req0.includes('"path"'), req0.slice(-500));
  await ui.locator('.approval-upload .btn.primary').click();
  await waitFor(async () => /plain: resume\.pdf/.test(await pageLog()) && (await pageLog()) !== logBefore);
  check('allowing it puts the file in the page\'s field', (await pageLog()).replace(logBefore, '').includes('plain: resume.pdf'), await pageLog());
  await waitFor(() => ui.locator('.msg.assistant').count().then((n) => n > 0));
  check('the card collapses to a line saying uploads are allowed on the site', /Uploads allowed on/.test(await ui.locator('.approval.resolved').last().innerText()), await ui.locator('.approval.resolved').last().innerText());
  check('the files moved into this chat\'s store when the message was sent', await app.evaluate(() => global.__uploads().list(global.__chats.id()).some((f) => f.name === 'resume.pdf')));

  // the same site again in this chat: a step, no new card (a file attached earlier in the chat is named again by its ref)
  await plan({ element_id: ids.multi, names: ['resume.pdf'] });
  await send('upload my resume to this job form as a supporting document too');
  await waitFor(async () => /multi: resume\.pdf/.test(await pageLog()), 10000);
  check('later uploads to the same site in this chat need no new card', /multi: resume\.pdf/.test(await pageLog()) && (await ui.locator('.approval:not(.resolved)').count()) === 0 && (await ui.locator('.approval.resolved').count()) === 2, `${await pageLog()} open=${await ui.locator('.approval:not(.resolved)').count()} resolved=${await ui.locator('.approval.resolved').count()}`);
  await waitFor(() => ui.locator('.msg.assistant').count().then((n) => n >= 2));

  // ---- 9. no file attached: the "Choose file…" card (the OS picker stubbed)
  await app.evaluate((_e, a) => { global.__uploadPick = async () => [a.png]; }, { png });
  await plan({ element_id: ids.pdfonly });
  await send('upload my transcript to this job form');
  const pickCard = await waitFor(() => ui.locator('.approval-upload:not(.resolved)').count().then((n) => n > 0), 10000);
  if (!pickCard) console.log('--- chat:', (await ui.locator('#messages').innerText()).slice(-600));
  const pickText = pickCard ? await ui.locator('.approval-upload:not(.resolved)').innerText() : '';
  check('without an attached file the card asks the user to choose one: the site, the field\'s label and what it accepts', pickCard && new RegExp(`needs a file for ${host.replace('.', '\\.')}`).test(pickText) && /Transcript/.test(pickText) && /Accepts PDF/.test(pickText) && /Choose file…/.test(pickText) && /Cancel/.test(pickText), pickText);
  await shot(ui.locator('.approval-upload:not(.resolved)'), 'choose-file-card.png');
  await ui.locator('.approval-upload:not(.resolved) .btn.primary').click();
  const problem = await waitFor(() => ui.locator('.approval-problem:not([hidden])').count().then((n) => n > 0));
  check('a pick that does not match the field is refused on the card, which stays open', problem && /isn't a type this field accepts/.test(await ui.locator('.approval-problem').innerText()) && (await ui.locator('.approval-upload:not(.resolved)').count()) === 1, problem ? await ui.locator('.approval-problem').innerText() : 'no message');
  await app.evaluate((_e, a) => { global.__uploadPick = async () => [a.chosen]; }, { chosen });
  await ui.locator('.approval-upload:not(.resolved) .btn.primary').click();
  await waitFor(async () => /pdfonly: chosen\.pdf/.test(await pageLog()));
  check('the user\'s pick goes into the field', /pdfonly: chosen\.pdf \[input\+change\]/.test(await pageLog()), await pageLog());
  await waitFor(() => ui.locator('.approval.resolved').last().innerText().then((t) => /Chose chosen\.pdf/.test(t)));
  check('the card collapses to the name chosen', /Chose chosen\.pdf for/.test(await ui.locator('.approval.resolved').last().innerText()), await ui.locator('.approval.resolved').last().innerText());
  const afterTool = (needle) => waitFor(() => app.evaluate((_e, n) => { // the request the model got with the tool's answer
    const hit = global.__reqs.find((r) => { const l = r.at(-1); return Array.isArray(l.content) && l.content.some((b) => b.type === 'tool_result' && JSON.stringify(b).includes(n)); });
    return hit ? JSON.stringify(hit) : null;
  }, needle), 10000);
  const afterPick = await afterTool('chosen.pdf');
  check('the model learned the name of the file, not its path or contents', /chosen\.pdf/.test(afterPick) && !/picked by the user/.test(afterPick) && !afterPick.includes(work.replace(/\\/g, '\\\\')), afterPick.slice(-400));
  await waitFor(() => ui.locator('.msg.assistant').count().then((n) => n >= 3));

  // Cancel on the card: the model is told the user declined
  await plan({ element_id: ids.pdfonly });
  await send('upload my transcript to this job form again');
  await waitFor(() => ui.locator('.approval-upload:not(.resolved)').count().then((n) => n > 0), 10000);
  await ui.locator('.approval-upload:not(.resolved) .btn:not(.primary)').click();
  const afterCancel = await afterTool('declined');
  check('Cancel: the tool answers that the user declined, and nothing was uploaded', /user declined to choose a file/.test(afterCancel || '') && ((await pageLog()).match(/pdfonly:/g) || []).length === 1, (await pageLog()));

  // ---- 10. the chat's files go with the chat
  const chatDir = path.join(profile, 'uploads', 'chats', CHAT);
  check('the chat\'s attached files are kept in its own folder', fs.existsSync(chatDir) && fs.readdirSync(chatDir).length >= 3, fs.existsSync(chatDir) ? fs.readdirSync(chatDir).join(',') : 'none');
  await app.evaluate(() => { global.__agent.browser.autoApprove = () => true; });
  await ui.evaluate((id) => window.assistant.chats.remove(id), CHAT);
  await waitFor(() => !fs.existsSync(chatDir));
  check('deleting the chat removes them', !fs.existsSync(chatDir));

  check('no page errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
