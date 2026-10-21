// "What is the answer for number 4" with a PDF open in front of the user, in the real app (hidden: LUMEN_TEST_BACKGROUND=1). The page in front is the
// context: the message carries the text of the page on screen and the next one (not the first pages of a 13-page document, not all of it), with the
// screenshot, so the model answers with no tool call and no new tab. For an API model and for Claude Code (a fake `claude` CLI that records the
// message it is sent and the MCP config it is started with). Also: open_tab for the file already in front opens nothing, a summary still gets the
// document from its start, and a message that names an item with no page open stays a plain message.
// Offline: a temp folder with a hand-made 13-page PDF. The model is fake and records the request it gets, so the test sees exactly what would be sent.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// A valid PDF with one text per page (lines of text, one Tj each), built by hand so the test needs no fixture file.
function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((lines, i) => {
    const stream = `BT /F1 10 Tf 40 760 Td 12 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const filler = (tag, chars) => Array.from({ length: Math.ceil(chars / 100) }, (_, i) => `${tag} line ${i} ${'lorem ipsum dolor sit amet '.repeat(4)}`.slice(0, 99));
// Pages 1 and 2 are long (the first 12000 characters of the document end inside page 3); 3 and 4 are short and hold question 4, split over the break.
const PAGES = [
  ['DiffEq Midterm 1 practice test', ...filler('COVER', 5800)],
  ['Page two formulas', ...filler('FORMULAS', 5800)],
  ['Question 3 is on this page too.', 'Question 4. Solve y prime plus 2y equals e to the minus x with y of 0 equals 3. ZEBRA-Q4-START', ...filler('P3', 900)],
  ['The initial value problem of question 4 continues here. ZEBRA-Q4-END', 'Find y at x equals 1.', ...filler('P4', 900)],
  ...Array.from({ length: 9 }, (_, i) => [`Question ${i + 5} text. ${i + 5 === 9 ? 'PAGE9-MARKER' : ''}`, ...filler(`P${i + 5}`, 700)]),
];

// The fake `claude` CLI: records the message it gets (its text, how many pictures) and the MCP config it was started with, answers once.
const FAKE_CLAUDE = `
const fs = require('fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    const argv = process.argv.slice(2);
    let mcp = null; try { mcp = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')); } catch (e) { mcp = { error: String(e) }; }
    const parts = msg.message.content;
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ text: parts.map((c) => c.text || '').join('\\n'), images: parts.filter((c) => c.type === 'image').length, mcp }) + '\\n');
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'It is 7.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'It is 7.', session_id: 'sess-1', total_cost_usd: 0, usage: {} });
  }
});
`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-page-front-'));
  const pdfPath = path.join(root, 'DiffEq_Midterm1_Practice_Test.pdf');
  fs.writeFileSync(pdfPath, makePdf(PAGES));
  const fakeClaude = path.join(root, 'fake-claude.js');
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE);
  const ccLog = path.join(root, 'cc.log');
  const spawnModule = path.join(root, 'cli-spawn.js'); // what the engines call in place of child_process.spawn (features/ai-agents.js cliSpawn)
  fs.writeFileSync(spawnModule, "const cp = require('child_process'); exports.spawn = (bin, argv, opts) => cp.spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } });");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-page-front-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: root, TMP: root, ANTHROPIC_API_KEY: 'sk-ant-test', FAKE_LOG: ccLog, LUMEN_CLAUDE_BIN: fakeClaude, LUMEN_TEST_CLI_SPAWN: spawnModule }, // (the real CLI is never started: the fake is the only `claude` Lumen knows)
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  // The model is fake: it records the request it gets (the last user message), and for a message with OPENAGAIN calls open_tab on the PDF first.
  await app.evaluate((_e, pdf) => {
    const fake = global.__fake = { requests: [], toolCalls: [], toolResults: [], calls: 0 };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      fake.calls++;
      const last = [...params.messages].reverse().find((m) => m.role === 'user');
      const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
      let content;
      let stop = 'end_turn';
      if (results.length) {
        fake.toolResults.push(results.map((r) => (Array.isArray(r.content) ? r.content.map((c) => c.text || '').join('\n') : String(r.content))).join('\n'));
        content = [{ type: 'text', text: 'Done.' }];
      } else {
        fake.requests.push(JSON.stringify(last.content));
        if (/OPENAGAIN/.test(JSON.stringify(last.content))) { content = [{ type: 'tool_use', id: 'tu1', name: 'open_tab', input: { url: pdf } }]; stop = 'tool_use'; fake.toolCalls.push('open_tab'); }
        else content = [{ type: 'text', text: 'It is 7.' }];
      }
      const message = { role: 'assistant', model: params.model, stop_reason: stop, content, usage: { input_tokens: 10, output_tokens: 5 } };
      return { async *[Symbol.asyncIterator]() { for (const [index, b] of content.entries()) if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; }, finalMessage: async () => message };
    } } } });
    global.__bypass = global.__agent.browser.bypassPermissions;
    global.__agent.browser.bypassPermissions = () => true; // Bypass permissions on, as in the report: no card
    global.__agent.browser.fileShared = () => false;
  }, pdfPath);
  const requests = () => app.evaluate(() => global.__fake.requests.slice());
  const tabCount = () => app.evaluate(() => global.__agent.browser.listTabs().length);
  const openTab = (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); return t.id; }, url);
  const viewerPage = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('window.lumenPdf ? window.lumenPdf.state().page : 0'));
  await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });

  const send = async (text) => {
    await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));
    await ui.evaluate((t) => { const p = document.getElementById('prompt'); p.focus(); p.value = t; p.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }, text);
  };
  const idle = () => waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 30000);
  const done = async (before) => { await waitFor(async () => (await requests()).length > before, 20000); await sleep(300); await idle(); };
  const newChat = async () => { await ui.evaluate(() => window.assistant.reset()); await sleep(300); };
  const hasImage = (req) => /"type":"image"/.test(req);
  const textOf = (req) => JSON.parse(req).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  // ---- the PDF is open at page 3, question 4 on screen
  await openTab(`${pathToFileURL(pdfPath).href}#page=3`);
  check('the PDF is open in Lumen\'s viewer', Boolean(await waitFor(() => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL().startsWith('lumen-pdf://')), 8000)));
  check('the viewer is on page 3', Boolean(await waitFor(async () => (await viewerPage()) === 3, 12000)), String(await viewerPage()));
  const tabsBefore = await tabCount();

  // ---- an API model, the report's words
  let n = (await requests()).length;
  await send('what is the answer for number 4');
  await done(n);
  let req = (await requests()).at(-1);
  let text = textOf(req);
  check('API: the request carries question 4 where it starts (page 3) and where it ends (page 4)', /ZEBRA-Q4-START/.test(text) && /ZEBRA-Q4-END/.test(text), text.slice(0, 400));
  check('API: it says which page the user is on and that no tool is needed', /looking at page 3/.test(text) && /no tool call/i.test(text), text.slice(0, 500));
  check('API: the screenshot goes along too', hasImage(req));
  check('API: not the first pages of the document, and not all of it', !/COVER line/.test(text) && !/PAGE9-MARKER/.test(text), text.slice(0, 300));
  const pageChars = (text.match(/<untrusted_page_content[\s\S]*<\/untrusted_page_content>/) || [''])[0].length;
  check('API: the page text is small (under 6500 characters, about 1,600 tokens)', pageChars > 500 && pageChars < 6500, String(pageChars));
  check('API: one model call, no tool call', (await app.evaluate(() => global.__fake.calls)) === 1 && (await app.evaluate(() => global.__fake.toolCalls.length)) === 0);
  check('API: no tab was opened', (await tabCount()) === tabsBefore, `${tabsBefore} -> ${await tabCount()}`);

  // ---- other ways to point at the item
  for (const words of ['solve number 4', 'explain question 4', 'what does question 4 ask?']) {
    await newChat();
    n = (await requests()).length;
    await send(words);
    await done(n);
    req = (await requests()).at(-1);
    check(`"${words}": the page in front goes along (text and screenshot)`, /ZEBRA-Q4-START/.test(textOf(req)) && hasImage(req), textOf(req).slice(0, 300));
  }
  await newChat();

  // ---- a summary is about the whole document: it starts from its first pages as before
  n = (await requests()).length;
  await send('summarize this pdf');
  await done(n);
  text = textOf((await requests()).at(-1));
  check('a summary gets the document from its start', /COVER line/.test(text) && !/looking at page 3/.test(text), text.slice(0, 300));

  // ---- open_tab for the file already in front opens nothing
  await newChat();
  const calls0 = await app.evaluate(() => global.__fake.calls);
  n = (await requests()).length;
  await send('OPENAGAIN what is the answer for number 4');
  await waitFor(async () => (await app.evaluate(() => global.__fake.toolResults.length)) > 0, 20000);
  await idle();
  const results = await app.evaluate(() => global.__fake.toolResults);
  check('open_tab on the file in front: the answer says it is already open', /no new tab was opened/.test(results.join('\n')), JSON.stringify(results));
  check('open_tab on the file in front: no tab was opened', (await tabCount()) === tabsBefore, `${tabsBefore} -> ${await tabCount()}`);
  check('(the fake model did call open_tab)', (await app.evaluate(() => global.__fake.calls)) > calls0);

  // ---- the screenshot tool on the viewer tab (the report: 27 s): a picture, and soon
  const shotStart = Date.now();
  const shot = await app.evaluate(async () => { try { const r = await global.__agent.execute('screenshot', {}); return Array.isArray(r) ? r.map((b) => b.type).join(',') : String(r).slice(0, 200); } catch (err) { return `ERROR ${err.message}`; } });
  const shotMs = Date.now() - shotStart;
  console.log(`      screenshot tool on the PDF viewer tab: ${shotMs} ms`);
  check('the screenshot tool on a PDF in the viewer gives a picture in under 5 seconds', /image/.test(shot) && shotMs < 5000, `${shot} ${shotMs} ms`);

  // ---- Claude Code: the same text and picture reach the CLI, with no tool call and no tab, and Lumen's tools are loaded up front
  await newChat();
  let ids = [];
  for (let i = 0; i < 30 && !ids.includes('claudecode:default'); i++) { ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value)); if (!ids.includes('claudecode:default')) await sleep(300); }
  check('the picker offers Claude Code (the fake CLI is found)', ids.includes('claudecode:default'), JSON.stringify(ids));
  await ui.selectOption('#model', 'claudecode:default', { force: true });
  await send('what is the answer for number 4');
  const got = await waitFor(() => fs.existsSync(ccLog) && fs.readFileSync(ccLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1), 25000);
  await idle();
  const shown = await ui.evaluate(() => ({ model: document.getElementById('model').value, messages: document.getElementById('messages').innerText.slice(-500) }));
  check('Claude Code: the message carries question 4 (page 3 and the page after it)', Boolean(got) && /ZEBRA-Q4-START/.test(got.text) && /ZEBRA-Q4-END/.test(got.text), JSON.stringify(got || shown).slice(0, 700));
  check('Claude Code: and not the first pages or the whole document', Boolean(got) && !/COVER line/.test(got.text) && !/PAGE9-MARKER/.test(got.text), (got?.text || '').slice(0, 300));
  check('Claude Code: the screenshot is attached', got?.images === 1, JSON.stringify(got?.images));
  check("Claude Code: Lumen's MCP server is started with alwaysLoad (no ToolSearch step before its first tool)", got?.mcp?.mcpServers?.lumen?.alwaysLoad === true, JSON.stringify(got?.mcp));
  check('Claude Code: no tab was opened', (await tabCount()) === tabsBefore, `${tabsBefore} -> ${await tabCount()}`);

  await app.close().catch(() => {});
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
