// Files the AI makes, shown as cards (renderer/ai-files.js, features/ai-files.js, agent.js engineFiles), in a real hidden window.
// A fake engine run "writes" an .html file the way Claude Code's Write tool does and replies with its path:
//  - the sidebar shows the file card with a live sandboxed preview (opaque origin, no window.assistant, no network) and Open / Show in
//    folder / Copy path; the reply never needs "open it in a browser";
//  - a path in the reply text for a file the AI did not write gets a card with no preview, and Open asks first;
//  - the card comes back when the chat is restored, and on the full-page chat the page opens in the canvas on its own, a PDF in a new
//    background tab, and the card has "Open in canvas".
// Run: node test/ai-files.js (a throwaway profile, hidden windows).
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
  const server = http.createServer((req, res) => { hits.push(req.url); res.end('x'); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aifiles-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aifiles-work-'));
  const html = path.join(work, 'fcc diagonal.html');
  const notes = path.join(work, 'notes.txt');
  const svg = path.join(work, 'cube.svg');
  const pdf = path.join(work, 'handout.pdf');
  fs.writeFileSync(html, `<!doctype html><p id="hello">hello diagram</p><script>
    const out = { assistant: typeof window.assistant, fetch: 'pending' };
    fetch('${base}/fetch').then(() => { out.fetch = 'reached'; }, () => { out.fetch = 'blocked'; }).then(() => { const i = new Image(); i.src = '${base}/img'; setTimeout(() => parent.postMessage({ probe: out }, '*'), 500); });
  </script>`);
  fs.writeFileSync(notes, 'some notes');
  const hourAgo = (Date.now() - 3600000) / 1000;
  fs.utimesSync(notes, hourAgo, hourAgo); // (older than the run: a file the AI did not write)
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));

  // The fake engine run: its words, reply_complete, then what the real CLI path does after the run (agent.engineFiles), then done.
  await app.evaluate((_e, P) => {
    const agent = global.__agent;
    agent.run = async (text, emit) => {
      const engine = { freshRoots: () => [P.work] };
      const named = /named/.test(text);
      const files = named ? { text: `The notes are in \`${P.notes}\`.`, written: [] }
        : /canvas/.test(text) ? { text: `Drew it: ${P.svg}`, written: [P.svg] }
          : /pdf/.test(text) ? { text: `Handout: ${P.pdf}`, written: [P.pdf] }
            : { text: `Open ${P.html} in a browser to see the diagram.`, written: [P.html] };
      agent.messages.push({ role: 'user', content: text });
      emit({ type: 'turn_start' });
      emit({ type: 'text', text: files.text });
      emit({ type: 'reply_complete' });
      const blocks = await agent.engineFiles(files.text, engine, emit, { since: Date.now() - 60000, written: files.written });
      agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: files.text }, ...blocks] });
      emit({ type: 'done', model: 'claudecode:auto' });
    };
    global.__shellCalls = [];
    global.__aiFileShell = (how, p) => { global.__shellCalls.push([how, p]); return { ok: true }; };
  }, { work, html, notes, svg, pdf });

  // ---- the sidebar
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(300);
  await ui.fill('#prompt', 'draw the diagonal of a cube');
  await ui.press('#prompt', 'Enter');
  const card = await waitFor(() => ui.evaluate(() => { const c = document.querySelector('.ai-file'); return c ? { name: c.querySelector('.ai-file-name')?.textContent, dir: c.querySelector('.ai-file-dir')?.textContent, buttons: [...c.querySelectorAll('.ai-file-btn')].map((b) => b.textContent), frames: c.querySelectorAll('iframe').length } : null; }));
  check('the file card shows under the reply, with its name and folder', card?.name === 'fcc diagonal.html' && card.dir.includes('lumen-aifiles-work'), JSON.stringify(card));
  check('it offers Open in a tab, Show in folder and Copy path', card && ['Open in a tab', 'Show in folder', 'Copy path'].every((l) => card.buttons.includes(l)), JSON.stringify(card));
  check('the page is previewed live in the card (the sidebar has no canvas)', card?.frames === 1 && !card.buttons.includes('Open in canvas'), JSON.stringify(card));
  const sandbox = await ui.evaluate(() => { const f = document.querySelector('.ai-file iframe'); return { sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'), src: f.getAttribute('src') }; });
  check('the preview is sandbox="allow-scripts" only, in canvas-frame.html', sandbox.sandbox === 'allow-scripts' && sandbox.allow === '' && sandbox.src === 'canvas-frame.html', JSON.stringify(sandbox));
  const frame = await waitFor(() => ui.frames().find((f) => /canvas-frame\.html/.test(f.url())));
  const shown = await waitFor(async () => { try { return await frame.evaluate(() => document.getElementById('hello')?.textContent); } catch { return null; } });
  check('the page is drawn in the preview', shown === 'hello diagram', shown);
  await sleep(900);
  check('nothing reached the network from the preview', hits.length === 0, JSON.stringify(hits));
  const inFrame = await frame.evaluate(() => ({ assistant: typeof window.assistant, parent: (() => { try { return typeof parent.assistant; } catch { return 'blocked'; } })() })).catch(() => null);
  check('the preview has no window.assistant and cannot reach the sidebar', inFrame?.assistant === 'undefined' && inFrame?.parent === 'blocked', JSON.stringify(inFrame));
  check('it opened no tab by itself (a page is shown inline, never as an unsandboxed tab)', (await app.evaluate(() => global.__chatPage.tabs().length)) === 1, 'extra tab');

  await ui.click('.ai-file .ai-file-btn:has-text("Copy path")');
  check('Copy path copies the full path', await waitFor(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === html), 'clipboard');
  await ui.click('.ai-file .ai-file-btn:has-text("Show in folder")');
  check('Show in folder reveals the file', await waitFor(async () => JSON.stringify(await app.evaluate(() => global.__shellCalls)) === JSON.stringify([['reveal', html]])), JSON.stringify(await app.evaluate(() => global.__shellCalls)));
  const ids = await ui.evaluate(() => document.querySelector('.ai-file').dataset.id);
  check('a made-up id opens nothing, whatever a page claims', await ui.evaluate(async () => (await window.assistant.files.open('ffffffffffffffff', 'tab')).ok === false), '');
  check('and a path in place of an id opens nothing', await ui.evaluate(async (p) => (await window.assistant.files.open(p, 'tab')).ok === false, notes), '');

  const saved = await app.evaluate(() => global.__agent.transcript().map((i) => [i.role, (i.outFiles || []).map((f) => f.name)]));
  check('the saved chat holds the card', JSON.stringify(saved.filter((s) => s[1].length)) === JSON.stringify([['assistant', ['fcc diagonal.html']]]), JSON.stringify(saved));

  // ---- the chat page
  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  await waitFor(async () => (await inPage("document.querySelectorAll('.ai-file').length")) >= 1);
  const restored = await inPage("(() => { const c = document.querySelector('.ai-file'); return { n: document.querySelectorAll('.ai-file').length, name: c.querySelector('.ai-file-name').textContent, buttons: [...c.querySelectorAll('.ai-file-btn')].map((b) => b.textContent), frames: c.querySelectorAll('iframe').length }; })()");
  check('a restored chat brings the cards back, the page behind an Open in canvas button, no live frame until asked', restored.n === 1 && restored.name === 'fcc diagonal.html' && restored.buttons.includes('Open in canvas') && restored.frames === 0, JSON.stringify(restored));
  await inPage("document.querySelector('.ai-file .ai-file-btn').click()");
  check('Open in canvas shows the page in the canvas', await waitFor(async () => inPage("(() => { const c = document.getElementById('canvas'); return Boolean(c && !c.hidden && c.querySelector('iframe')); })()")), 'canvas closed');
  await inPage("document.querySelector('#canvas .cv-close').click()");
  // ---- a file the AI did not write: a card, no preview, Open asks first
  const submit = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await submit('where are my named notes');
  await waitFor(async () => (await inPage("document.querySelectorAll('.ai-file').length")) === 2);
  const named = await inPage("(() => { const c = [...document.querySelectorAll('.ai-file')].find((x) => x.querySelector('.ai-file-name').textContent === 'notes.txt'); return c ? { frames: c.querySelectorAll('iframe, img').length, preview: [...c.querySelectorAll('.ai-file-btn')].some((b) => /preview/i.test(b.textContent)) } : null; })()");
  check('a file only named in the reply text gets a card with no preview', named && named.frames === 0 && !named.preview, JSON.stringify(named));
  const tabs0 = await app.evaluate(() => global.__chatPage.tabs().length);
  await inPage("[...document.querySelectorAll('.ai-file')].find((x) => x.querySelector('.ai-file-name').textContent === 'notes.txt').querySelector('.ai-file-btn').click()");
  const asked = await waitFor(() => inPage("document.querySelector('.ai-file-ask')?.textContent || ''"));
  check('Open asks first for a file the AI did not make in this chat', /notes.txt/.test(asked) && (await app.evaluate(() => global.__chatPage.tabs().length)) === tabs0, asked);
  await inPage("document.querySelector('.ai-file-ask button').click()");
  check('after the user says yes, it opens in a tab', await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs().length)) === tabs0 + 1), 'no tab');
  await app.evaluate(() => { const c = global.__chatPage.tabs().find((t) => t.chat); global.__chatPage.switchTab(c.id); });


  // a live run on the page: the SVG the AI wrote opens in the canvas by itself, without taking focus from the message box
  await submit('draw it for the canvas');
  check('on the full-page chat the page the AI wrote opens in the canvas on its own', await waitFor(async () => inPage("(() => { const c = document.getElementById('canvas'); return Boolean(c && !c.hidden && c.querySelector('iframe')); })()"), 15000), 'canvas closed');
  const note = await inPage("[...document.querySelectorAll('.ai-file-status')].map((s) => s.textContent).join('|')");
  check('the card says so', /Showing in the canvas/.test(note), note);
  await inPage("document.querySelector('#canvas .cv-close').click()");

  const tabsBefore = await app.evaluate(() => global.__chatPage.tabs().length);
  await submit('make the pdf handout');
  check('a PDF the AI made opens in a new background tab, with a note', await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs().length)) === tabsBefore + 1 && /Opened in a new tab/.test(await inPage("[...document.querySelectorAll('.ai-file-status')].map((s) => s.textContent).join('|')")), 15000), 'no new tab');

  check('and the chat stayed in front', await app.evaluate(() => { const c = global.__chatPage.tabs().find((t) => t.chat); return global.__chatPage.activeId() === c.id; }), 'switched');

  check('no page errors', errors.length === 0, errors.join(' | '));
  void ids;
  await app.close();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); fs.rmSync(work, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch {}
  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
