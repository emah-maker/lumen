// The AI's edit shortcuts in the real app (ai/agent.js editShortcut, features/edit-keys.js), hidden windows, temp profile, no network.
// The fixture editor only accepts TRUSTED paste and cut events, as Google Docs does (its Edit > Paste needs the Clipboard permission and
// opens an "install the extension" prompt instead), and its caret lives in a frame in one case, as in Docs. So the test moves a block of text
// by keyboard: select with Shift+arrows, press_key Ctrl+X, click the target, Ctrl+V, and checks the order changed. Also: the user's clipboard
// (text, html, image) is back after the run, an outside agent's cut and paste use its private buffer and leave the system clipboard alone,
// and the shield (kept-off tab) and hands-off mode refuse.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };

// The editor: three lines. It ignores script-made paste/cut (isTrusted false) and does the paste/cut itself for trusted ones.
const EDITOR = `
<div id="doc" contenteditable="true" style="min-height:120px;border:1px solid #888;white-space:pre-wrap">alpha
beta
gamma</div>
<script>
  window.__ev = { paste: 0, cut: 0, untrusted: 0 };
  const doc = document.getElementById('doc');
  doc.addEventListener('paste', (e) => {
    if (!e.isTrusted) { window.__ev.untrusted++; e.preventDefault(); return; }
    e.preventDefault(); window.__ev.paste++;
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  doc.addEventListener('cut', (e) => {
    if (!e.isTrusted) { window.__ev.untrusted++; e.preventDefault(); return; }
    window.__ev.cut++;
    e.clipboardData.setData('text/plain', getSelection().toString()); e.preventDefault();
    document.execCommand('delete');
  });
</script>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/top') || req.url.startsWith('/mcpdoc')) return res.end(`<!doctype html><title>Top</title><body>${EDITOR}</body>`);
    if (req.url.startsWith('/inner')) return res.end(`<!doctype html><title>Inner</title><body>${EDITOR}</body>`);
    // The caret in a frame, as in Google Docs: the page itself holds only an iframe.
    if (req.url.startsWith('/frame')) return res.end('<!doctype html><title>Frame</title><body><iframe id="f" src="/inner" style="width:600px;height:300px"></iframe></body>');
    res.end('<!doctype html><title>Home</title><body>home</body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-editkeys-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: path.join(tmp, 'profile'), ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const tabId = await app.evaluate(() => global.__windows.list()[0].activeId);
  const goto = async (url) => { await app.evaluate(({ webContents }, u) => { webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).loadURL(u); }, url); await waitFor(() => app.evaluate((_e, u) => global.__windows.list()[0].tabs[0].url === u, url)); await sleep(500); };
  // Runs the steps as one sidebar run (its scope ends the run, which puts the user's clipboard back) or as an outside agent's.
  // An outside agent goes through the MCP entry point (its own session, with a private clipboard), in the user's window as the test hook allows.
  const steps = (list, { mcp = false, session = 'a' } = {}) => app.evaluate(async (_e, a) => {
    const signal = new AbortController().signal;
    const m = []; m.settings = { model: 'claude-opus-5' };
    const out = [];
    const text = (r) => (typeof r === 'string' ? r : (Array.isArray(r) ? r : r?.content || [r]).map((b) => b?.text || '').join(' '));
    global.__editSessions ||= {};
    const sess = (global.__editSessions[a.session] ||= { approvedHosts: new Set(), clientName: 'EditCheck', controller: new AbortController() });
    if (a.mcp) {
      for (const [name, input] of a.list) {
        try { const r = await global.__mcpCallTool(name, input, sess); out.push((r?.isError ? 'ERROR: ' : '') + text(r)); } catch (e) { out.push('ERROR: ' + e.message); }
      }
      return out;
    }
    try {
      await global.__agent.inTask(a.id, signal, async () => {
        for (const [name, input] of a.list) {
          try { out.push(await global.__agent.execute(name, input)); } catch (e) { out.push('ERROR: ' + e.message); }
        }
      }, m);
    } catch (e) { out.push('ERROR: ' + e.message); }
    return out;
  }, { id: tabId, list, mcp, session });
  // This Electron's clipboard is the async web one (ClipboardItem), so the helpers read and write that way.
  const sys = {
    set: (o) => app.evaluate(async ({ clipboard, ClipboardItem }, v) => {
      const parts = { 'text/plain': new Blob([v.text], { type: 'text/plain' }) };
      if (v.html) parts['text/html'] = new Blob([v.html], { type: 'text/html' });
      if (v.png) parts['image/png'] = new Blob([Buffer.from(v.png, 'base64')], { type: 'image/png' });
      await clipboard.write([new ClipboardItem(parts)]);
    }, o),
    get: () => app.evaluate(async ({ clipboard }) => {
      const out = { text: await clipboard.readText(), html: '', image: false };
      for (const item of await clipboard.read()) {
        if (item.types.includes('text/html')) out.html = await (await item.getType('text/html')).text();
        if (item.types.includes('image/png')) out.image = (await (await item.getType('image/png')).arrayBuffer()).byteLength > 0;
      }
      return out;
    }),
  };
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // Runs js in the frame that holds the editor (the page itself, or the iframe in it).
  let docPath = /\/(top|frame)$/; // which page holds the editor right now: the user's tab, or the outside agent's own window
  const inDoc = (js) => app.evaluate(async ({ webContents }, [code, source]) => {
    const wc = webContents.getAllWebContents().find((w) => new RegExp(source).test(w.getURL()));
    for (const f of wc.mainFrame.framesInSubtree) {
      const found = await f.executeJavaScript("Boolean(document.getElementById('doc'))").catch(() => false);
      if (found) return f.executeJavaScript(code);
    }
    return null;
  }, [js, docPath.source]);
  const docText = () => inDoc("document.getElementById('doc').innerText");
  const events = () => inDoc('window.__ev');
  const focusDoc = () => inDoc("document.getElementById('doc').focus()");
  const key = (k, modifiers) => ['press_key', { key: k, ...(modifiers ? { modifiers } : {}) }];

  for (const where of ['top', 'frame']) {
    await goto(`${base}/${where}`);
    await focusDoc();
    // Reading a page leaves a DevTools session on the tab, and then keys typed into a frame go through it (not sendInputEvent), as in a real Docs run.
    await app.evaluate(({ webContents }) => { const wc = webContents.getAllWebContents().find((w) => /\/(top|frame)$/.test(w.getURL())); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); });
    await sys.set({ text: 'USER TEXT', html: '<b>user html</b>', png: PNG });
    const before = await docText();
    check(`${where}: fixture starts as alpha, beta, gamma`, /alpha\s+beta\s+gamma/.test(before || ''), before);

    // Select the first line with the keyboard (Ctrl+Home, Shift+End), cut it, go to the end, paste it back after gamma.
    const out = await steps([key('Home', ['control']), key('End', ['shift']), key('x', ['control']), key('End', ['control']), key('Enter'), key('v', ['control'])]);
    const after = await waitFor(async () => { const t = await docText(); return /beta\s+gamma\s+alpha/.test(t || '') && t; });
    check(`${where}: select by Shift+arrows, Ctrl+X, Ctrl+V moves the text (beta, gamma, alpha)`, Boolean(after), JSON.stringify({ out, after: await docText() }));
    const ev = await events();
    check(`${where}: the page saw one trusted cut and one trusted paste, no script-made ones`, ev && ev.cut === 1 && ev.paste === 1 && ev.untrusted === 0, JSON.stringify(ev));
    const clip = await sys.get();
    check(`${where}: the user's clipboard (text, html and image) is back after the run`, clip.text === 'USER TEXT' && /user html/.test(clip.html) && clip.image === true, JSON.stringify(clip));

    // undo / redo / select all go through the same native commands
    await steps([key('z', ['control'])]);
    const undone = await waitFor(async () => { const t = await docText(); return !/gamma\s+alpha/.test(t || '') && t; });
    check(`${where}: Ctrl+Z undoes the paste`, Boolean(undone), await docText());
    await steps([key('z', ['control', 'shift'])]);
    check(`${where}: Ctrl+Shift+Z redoes it`, Boolean(await waitFor(async () => /gamma\s+alpha/.test((await docText()) || ''))), await docText());
  }

  // An outside agent (MCP): its own buffer, the system clipboard stays the user's.
  await goto(`${base}/home`);
  const opened = await steps([['navigate', { url: `${base}/mcpdoc` }]], { mcp: true });
  docPath = /\/mcpdoc$/;
  await waitFor(async () => /alpha/.test((await docText()) || ''));
  await focusDoc();
  await sys.set({ text: 'USER TEXT', html: '<b>user html</b>', png: PNG });
  const mcp = await steps([key('Home', ['control']), key('End', ['shift']), key('x', ['control']), key('End', ['control']), key('Enter'), key('v', ['control'])], { mcp: true });
  const moved = await waitFor(async () => { const t = await docText(); return /beta\s+gamma\s+alpha/.test(t || '') && t; });
  check('an outside agent moves text with cut and paste from its private buffer', Boolean(moved), JSON.stringify({ opened, mcp, after: await docText() }));
  const clip2 = await sys.get();
  check('...and the system clipboard is exactly the user\'s (text, html, image)', clip2.text === 'USER TEXT' && /user html/.test(clip2.html) && clip2.image === true, JSON.stringify(clip2));
  check('...its copy went to the buffer, so it can paste it again', /own clipboard/.test(mcp[2] || '') && /pasted 5 characters/.test(mcp[5] || ''), JSON.stringify(mcp));
  docPath = /\/(top|frame)$/;

  // The shield and hands-off mode refuse, as for typing; nothing on the clipboard changes.
  await goto(`${base}/top`);
  await focusDoc();
  await sys.set({ text: 'USER TEXT' });
  await app.evaluate(() => { global.__agent.browser.tabOff = () => true; });
  const shield = await steps([key('Home', ['control']), key('End', ['shift']), key('x', ['control']), key('v', ['control'])]);
  check('a tab kept off the AI refuses the edit shortcuts', shield.every((s) => /keeps the AI from acting on this tab/.test(s)), JSON.stringify(shield));
  await app.evaluate(() => { global.__agent.browser.tabOff = () => false; global.__agent.browser.handsOff = () => true; global.__agent.browser.isAiTab = () => false; });
  const hands = await steps([key('x', ['control']), key('v', ['control']), key('a', ['control'])]);
  check('hands-off mode refuses them on a tab the AI did not open', hands.every((s) => /^ERROR/.test(s)), JSON.stringify(hands));
  await app.evaluate(() => { global.__agent.browser.handsOff = () => false; });
  const ev2 = await events();
  check('the page saw no cut or paste from the refused calls', ev2 && ev2.cut === 0 && ev2.paste === 0, JSON.stringify(ev2));
  check('the clipboard is still the user\'s after the refusals', (await sys.get()).text === 'USER TEXT');

  // An explicit clipboard write by the AI (the user asked for text on their clipboard) is kept.
  const wrote = await steps([['clipboard', { action: 'write', text: 'FOR THE USER' }], key('a', ['control'])]);
  check('the clipboard tool\'s write is not rolled back at the end of the run', (await sys.get()).text === 'FOR THE USER', JSON.stringify(wrote));

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
