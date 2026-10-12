// Downloads the AI starts and click_at without a screenshot, on local fixtures (hidden windows, a throwaway profile, no network, no key):
//  - click_at on a canvas page works with no earlier screenshot, and says what it left behind;
//  - a click that starts a download returns the file's path, name and size in the same result;
//  - wait_for {download:true} returns the path too, and list_files shows Lumen's own list without a disk search;
//  - a "click a button, then a download" flow with a fake model takes at most 3 tool calls, and the next turn reads the .docx text
//    from the path it was handed, with no search tool and no card.
// Run alone: node test/ai-downloads.js (LUMEN_TEST_BACKGROUND=1 keeps the windows hidden).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { makeDocx } = require('./fixtures/docx-fixture');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const docx = makeDocx(['Budget Memo', 'The launch is moved to March.']);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/memo.docx')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': 'attachment; filename="memo.docx"', 'Content-Length': docx.length });
      return res.end(docx);
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/canvas')) {
      return res.end('<!doctype html><title>Canvas</title><body style="margin:0"><textarea id="t" style="position:absolute;left:0;top:0;width:10px;height:10px"></textarea><canvas id="cv" width="400" height="300" style="position:absolute;left:100px;top:100px"></canvas><div id="out"></div><script>document.getElementById("cv").addEventListener("mousedown",()=>{document.getElementById("out").textContent="canvas-clicked";document.title="Canvas hit";});document.getElementById("cv").addEventListener("click",()=>document.getElementById("t").focus());</script></body>');
    }
    res.end('<!doctype html><title>Reports</title><body><h1>Reports</h1><a id="dl" href="/memo.docx" download="memo.docx">Download report</a></body>');
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aidl-profile-'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidl-files-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), dlDir);
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r).slice(0, 500); } catch (err) { return `ERROR: ${err.message}`; }
  }, [name, input]);
  const inPage = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);

  // ---- 1. click_at on a canvas, no screenshot first
  await run('navigate', { url: `${base}/canvas` });
  // (learn the ratio once, then forget the screenshot: the next click must not need one)
  await run('click_at', { x: 1, y: 1 });
  const ratio = await app.evaluate(() => global.__agent.screenshotScale.ratio);
  const zoom = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getZoomFactor());
  const centre = await inPage("(() => { const b = document.getElementById('cv').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()");
  await app.evaluate(() => { global.__agent.screenshotScale = null; });
  const out = await run('click_at', { x: centre.x * zoom / ratio, y: centre.y * zoom / ratio });
  check('click_at with no earlier screenshot is not refused', !/^ERROR/.test(out) && !/screenshot of this tab first/i.test(out), out);
  check('...and lands on the canvas', (await inPage("document.getElementById('out').textContent")) === 'canvas-clicked', await inPage("document.getElementById('out').textContent"));
  check('...and the result says what changed (title, focus) without a screenshot', /Title: .Canvas hit./.test(out) && /Focus: /.test(out), out);

  // ---- 2. a click that starts a download returns the file
  await run('navigate', { url: `${base}/` });
  const t0 = Date.now();
  const clicked = await run('click', { text: 'Download report' });
  const took = Date.now() - t0;
  const m = /Downloaded: memo\.docx \(([^)]+)\) at (.+)$/m.exec(clicked);
  check('the click result carries the downloaded file: name, size and full path', Boolean(m) && fs.existsSync(m[2]) && path.dirname(m[2]) === dlDir, clicked);
  check('...within a few seconds, with no search', took < 12000, String(took));
  check('...and the next tool result does not repeat it', !/Downloaded:/.test(await run('read_page', { mode: 'compact' })));

  // ---- 3. wait_for download, and the list
  await run('click', { text: 'Download report' }); // a second copy: memo (1).docx
  const waited = await run('wait_for', { download: true, seconds: 10 });
  check('wait_for {download:true} returns the newest download\'s path', /Downloaded: memo \(1\)\.docx .* at .*memo \(1\)\.docx/.test(waited), waited);
  const t1 = Date.now();
  const listed = await run('list_files', { folder: 'downloads' });
  check('list_files downloads lists Lumen\'s own downloads (instant, no disk search)', /Lumen download list|download list/.test(listed) && listed.includes('memo.docx') && Date.now() - t1 < 1500, listed);
  const read = await run('list_files', { read: 'memo.docx' });
  check('list_files read returns the .docx text', /# Budget Memo/.test(read) && /moved to March/.test(read), read);

  // ---- 4. a fake model: click, then read - at most 3 tool calls, and the text reaches the answer
  for (const f of fs.readdirSync(dlDir)) fs.unlinkSync(path.join(dlDir, f));
  await run('navigate', { url: `${base}/` });
  await app.evaluate(() => {
    const fake = global.__fake = { n: 0, tools: [], searched: false, final: '' };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const last = params.messages[params.messages.length - 1];
      const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
      const resultText = results.map((r) => (Array.isArray(r.content) ? r.content.map((c) => c.text || '').join('\n') : String(r.content))).join('\n');
      let content;
      let stop = 'tool_use';
      if (!results.length) {
        content = [{ type: 'tool_use', id: 'tu1', name: 'click', input: { text: 'Download report' } }];
        fake.tools.push('click');
      } else if (fake.tools.length === 1) {
        const at = /at (.+\.docx)/.exec(resultText);
        content = [{ type: 'tool_use', id: 'tu2', name: 'list_files', input: { read: at ? at[1] : 'missing' } }];
        fake.tools.push('list_files');
      } else {
        fake.final = `The memo says: ${resultText.includes('The launch is moved to March.') ? 'launch moved to March' : 'NOT READ'}`;
        content = [{ type: 'text', text: fake.final }];
        stop = 'end_turn';
      }
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 20 } };
      return {
        async *[Symbol.asyncIterator]() { for (const [index, b] of content.entries()) if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#prompt', { state: 'visible' });
  await ui.fill('#prompt', 'Download the report and tell me what it says');
  await ui.press('#prompt', 'Enter');
  const done = await waitFor(() => app.evaluate(() => global.__fake.final), 30000);
  const state = await app.evaluate(() => global.__fake);
  check('the flow took at most 3 tool calls (click with the file back, then one read)', state.tools.length <= 3 && state.tools.join(',') === 'click,list_files', JSON.stringify(state));
  check('the AI read the .docx text from the path it was given: no search, no card', /launch moved to March/.test(done || ''), JSON.stringify(state));
  const pending = await ui.evaluate(() => document.querySelectorAll('.approval, .approval-card, [data-approval]').length).catch(() => 0);
  check('no approval card was shown for its own download', pending === 0, String(pending));

  // ---- 5. a download the user started (finished before the next message) is in that message's browser_state with its path
  await app.evaluate(() => {
    const fake = global.__fake2 = { texts: [] };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const last = params.messages[params.messages.length - 1];
      fake.texts.push((Array.isArray(last?.content) ? last.content : [{ type: 'text', text: String(last?.content) }]).filter((b) => b.type === 'text').map((b) => b.text).join(String.fromCharCode(10)));
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }; }, finalMessage: async () => message };
    } } } });
  });
  const before = await app.evaluate(() => global.__downloads.list().length);
  await app.evaluate((_e, u) => global.__agent.browser.activeTab().webContents.downloadURL(u), `${base}/memo.docx`);
  await waitFor(() => app.evaluate((_e, n) => global.__downloads.list().length > n && global.__downloads.list()[0].state === 'completed', before));
  const mine = await app.evaluate(() => global.__downloads.list()[0].path);
  await ui.fill('#prompt', 'what did I just download?');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => app.evaluate(() => global.__fake2.texts.length > 0));
  const seen = await app.evaluate(() => global.__fake2.texts[0] || '');
  check('the next message tells the AI what finished downloading, with the full path', seen.includes('Downloaded: memo') && seen.includes(mine), seen.slice(0, 600));
  check('...and how to read it without searching the disk', /never search the disk/.test(seen), seen.slice(0, 600));

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
