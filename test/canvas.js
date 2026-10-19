// lumen://chat canvas (renderer/chat-canvas.js, canvas-frame.html) in a real hidden window. A fake Claude replies with an HTML
// page whose script probes what it can reach; the page opens it in the canvas and the probe reports back. Covers: the
// "Open in canvas" button on an HTML reply (and not on a short snippet), Code and Preview tabs, the preview running its
// script inside a sandboxed iframe with an opaque origin, no reach to the chat page, its preload (window.assistant) or
// storage, no network (fetch, image and form requests never arrive at a local server), Copy, Download, Close, resizing.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('x'); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-canvas-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));

  const probe = `<script>
    const out = {};
    out.assistant = typeof window.assistant; out.require = typeof require; out.process = typeof process;
    try { out.parentAssistant = typeof parent.assistant; } catch (e) { out.parentAssistant = 'blocked'; }
    try { out.parentDoc = parent.document.title; } catch (e) { out.parentDoc = 'blocked'; }
    try { out.storage = typeof localStorage.length; } catch (e) { out.storage = 'blocked'; }
    try { out.origin = String(location.origin); } catch (e) { out.origin = 'err'; }
    fetch('${base}/fetch').then(() => { out.fetch = 'reached'; }, () => { out.fetch = 'blocked'; }).then(() => {
      const img = new Image(); img.src = '${base}/img';
      const form = document.createElement('form'); form.action = '${base}/form'; form.method = 'post'; document.body.append(form);
      try { form.submit(); } catch (e) { /* refused */ }
      try { open('${base}/popup'); } catch (e) { /* refused */ }
      setTimeout(() => parent.postMessage({ canvasProbe: out }, '*'), 700);
    });
  </script><p id="hello">hello canvas</p>`;
  const html = `<!doctype html><html><body>${probe}</body></html>`;
  const longPy = Array.from({ length: 30 }, (_, i) => `print(${i})`).join('\n');
  const reply = `Here you go.\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n\`\`\`html\n${html}\n\`\`\`\n\n\`\`\`python\n${longPy}\n\`\`\`\n`;
  await app.evaluate((_e, text) => {
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => message };
    } } } });
  }, reply);
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.fill('#prompt', 'make a page');
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => /Here you go/.test(await ui.evaluate(() => document.getElementById('messages').textContent)));
  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  await waitFor(async () => (await inPage("document.querySelectorAll('.code-block').length")) >= 3);
  check('the sidebar has no canvas button', (await ui.evaluate(() => document.querySelectorAll('.code-canvas').length)) === 0, 'present');
  const buttons = await inPage("[...document.querySelectorAll('.code-block')].map((b) => [b.querySelector('.code-lang').textContent, Boolean(b.querySelector('.code-canvas'))])");
  check('buttons: html and the long python block, not the short js', JSON.stringify(buttons) === JSON.stringify([['js', false], ['html', true], ['python', true]]), JSON.stringify(buttons));
  await inPage(`window.__probe = null; addEventListener('message', (e) => { if (e.data && e.data.canvasProbe) window.__probe = e.data.canvasProbe; })`);

  // HTML opens on Preview
  await inPage("document.querySelectorAll('.code-block')[1].querySelector('.code-canvas').click()");
  check('the panel opens, on Preview for HTML', await waitFor(async () => inPage("(() => { const c = document.getElementById('canvas'); return c && !c.hidden && c.querySelector('.cv-tab.active').textContent === 'Preview' && Boolean(c.querySelector('iframe')); })()")), 'panel');
  const attrs = await inPage("(() => { const f = document.querySelector('#canvas iframe'); return { sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'), src: f.getAttribute('src') }; })()");
  check('the iframe is sandbox="allow-scripts" only, with no features', attrs.sandbox === 'allow-scripts' && attrs.allow === '' && attrs.src === 'canvas-frame.html', JSON.stringify(attrs));
  const result = await waitFor(() => inPage('window.__probe'), 15000);
  check('the previewed page ran its script and reported back', Boolean(result), 'no probe message');
  check('it has no window.assistant, require or process', result?.assistant === 'undefined' && result?.require === 'undefined' && result?.process === 'undefined', JSON.stringify(result));
  check('it cannot reach the chat page, its API or its storage', result?.parentAssistant === 'blocked' && result?.parentDoc === 'blocked' && result?.storage === 'blocked', JSON.stringify(result));
  check('its origin is opaque (a file: origin, but storage and the parent are blocked above)', ['null', 'file://'].includes(result?.origin), JSON.stringify(result));
  check('fetch is blocked', result?.fetch === 'blocked', JSON.stringify(result));
  await sleep(500);
  check('nothing reached the network (fetch, image, form, popup)', hits.length === 0, JSON.stringify(hits));
  const stillChat = await app.evaluate(() => global.__chatPage.tabs().filter((t) => t.chat).length);
  check('the chat tab is still the only chat tab (no popup, no navigation)', stillChat === 1, stillChat);

  // Tabs, copy, download, close, resize
  await inPage("[...document.querySelectorAll('#canvas .cv-tab')].find((b) => b.textContent === 'Code').click()");
  check('the Code tab shows the source and ends the preview', await inPage("(() => { const c = document.getElementById('canvas'); return !c.querySelector('.cv-code').hidden && c.querySelector('.cv-code').textContent.includes('hello canvas') && !c.querySelector('iframe'); })()"), 'code tab');
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await inPage("[...document.querySelectorAll('#canvas .cv-btn')].find((b) => b.textContent === 'Copy').click()");
  check('Copy puts the source on the clipboard', await waitFor(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).includes('hello canvas')), 'clipboard');
  const dl = await inPage("(() => { let name = null; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { name = this.download; }; [...document.querySelectorAll('#canvas .cv-btn')].find((b) => b.textContent === 'Download').click(); HTMLAnchorElement.prototype.click = orig; return name; })()");
  check('Download names the file canvas.html', dl === 'canvas.html', dl);
  const before = await inPage("document.getElementById('canvas').getBoundingClientRect().width");
  await inPage("document.querySelector('#canvas .cv-grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
  const after = await inPage("document.getElementById('canvas').getBoundingClientRect().width");
  check('the grip resizes with the arrow keys', after > before, `${before} -> ${after}`);
  await inPage("document.querySelector('#canvas .cv-close').click()");
  check('Close hides the panel', await inPage("document.getElementById('canvas').hidden && !document.body.classList.contains('canvas-open')"), 'still open');

  // A non-previewable block: Code only
  await inPage("document.querySelectorAll('.code-block')[2].querySelector('.code-canvas').click()");
  check('a long Python block opens on Code with no tabs', await inPage("(() => { const c = document.getElementById('canvas'); return !c.hidden && c.querySelector('.cv-tabs').hidden && c.querySelector('.cv-code').textContent.includes('print(29)'); })()"), 'python');

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
