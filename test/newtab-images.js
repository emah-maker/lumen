// Images in the new-tab page's Ask AI box (renderer/newtab-images.js, preload/newtab-preload.js, main.js newtab-ai:*): paste, drop and the attach
// button add pictures as small chips (each with a remove x; Backspace in the empty field removes the last); a picture added in Search mode
// switches the box to Ask AI; Ask opens the full-page chat and the first message carries the text and the pictures; nothing travels in an
// address; the calls are refused from a web page. Hidden window (LUMEN_TEST_BACKGROUND), a fresh profile, a fake model that records its requests.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// A small solid-colour PNG (each colour is a different picture).
function png(r, g, b, size = 8) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-'));
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-files-'));
  const picks = [0, 1, 2].map((n) => { const p = path.join(files, `pick-${n}.png`); fs.writeFileSync(p, png(40 * n, 90, 200 - 40 * n)); return p; });
  const notImage = path.join(files, 'notes.txt');
  fs.writeFileSync(notImage, 'hello');
  const b64 = (n) => png(10 * n, 200, 30 * n).toString('base64');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>web</title><body>web page</body>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const web = `http://127.0.0.1:${server.address().port}/`;

  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    global.__requests = [];
    global.__navs = [];
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      global.__requests.push(JSON.parse(JSON.stringify(params.messages)));
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I see them.' }] };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I see them.' } }; }, finalMessage: async () => message };
    } } } });
  });

  const tabs = () => app.evaluate(() => global.__chatPage.tabs());
  const activeId = () => app.evaluate(() => global.__chatPage.activeId());
  const chatTabs = async () => (await tabs()).filter((t) => t.chat && /chat-page\.html$/.test(t.url));
  const inTab = (id, code) => app.evaluate(async (_e, { i, c }) => { try { return await global.__chatPage.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, { i: id, c: code });
  const ready = async (id) => waitFor(async () => (await inTab(id, "document.getElementById('ni-attach') && window.lumenNewtab ? 'yes' : 'no'")) === 'yes');
  const newTab = async () => {
    const id = await app.evaluate(async () => {
      const t = global.__agent.browser.openTab();
      await new Promise((r) => { t.webContents.once('did-finish-load', r); setTimeout(r, 6000); });
      t.webContents.on('will-navigate', (_e, url) => global.__navs.push(url));
      t.webContents.on('did-start-navigation', (_e, url) => global.__navs.push(url));
      global.__chatPage.switchTab(t.id);
      return t.id;
    });
    await waitFor(async () => (await activeId()) === id);
    await ready(id);
    return id;
  };
  const mode = (id) => inTab(id, "document.querySelector('#mode [aria-checked=true]')?.dataset.mode");
  const chips = (id) => inTab(id, "document.querySelectorAll('#ni-strip .ni-chip').length");
  const hint = (id) => inTab(id, "document.getElementById('mode-hint').textContent");
  const filesIn = (list) => `(() => { const dt = new DataTransfer(); for (const [name, b64] of ${JSON.stringify(list)}) { const bin = atob(b64); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)); dt.items.add(new File([bytes], name, { type: 'image/png' })); } return dt; })()`;
  const paste = (id, list) => inTab(id, `(() => { const dt = ${filesIn(list)}; document.getElementById('q').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  const drop = (id, list) => inTab(id, `(() => { const dt = ${filesIn(list)}; const f = document.querySelector('form[role=search]'); f.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); window.__dropState = f.classList.contains('ni-drop'); f.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
  const pick = async (id, paths) => { await app.evaluate((_e, p) => { global.__newtabPick = async () => p; }, paths); await inTab(id, "document.getElementById('ni-attach').click()"); };

  // ---- the box before anything is added
  const home = await newTab();
  check('the old "Images cannot go in this box" note is gone', !/go in this box/i.test(await inTab(home, 'document.documentElement.outerHTML')), 'still there');
  check('Search is the mode, no chips, the strip is hidden', (await mode(home)) === 'search' && (await chips(home)) === 0 && (await inTab(home, "document.getElementById('ni-strip').hidden")) === true, await mode(home));
  const label = await inTab(home, "document.getElementById('ni-attach').getAttribute('aria-label')");
  check('the attach button has a label', label === 'Attach images', label);

  // ---- paste (in Search mode: switches to Ask AI and says so)
  await paste(home, [['a.png', b64(1)]]);
  check('paste: one chip', (await waitFor(async () => (await chips(home)) === 1)) === true, await chips(home));
  check('...and Search mode switched to Ask AI, with a short hint', (await mode(home)) === 'ask' && /Images go to Ask AI/.test(await hint(home)), `${await mode(home)} / ${await hint(home)}`);
  const attachShown = await inTab(home, "getComputedStyle(document.getElementById('ni-attach')).display !== 'none'");
  check('the attach button shows in Ask AI mode', attachShown === true, attachShown);
  const chipInfo = JSON.parse(await inTab(home, "JSON.stringify((() => { const c = document.querySelector('.ni-chip'); const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), label: c.querySelector('button').getAttribute('aria-label') }; })())"));
  check('a chip is a ~40 px thumbnail with a "Remove image" button', chipInfo.w === 40 && chipInfo.h === 40 && chipInfo.label === 'Remove image', JSON.stringify(chipInfo));
  check('the thumbnail shows the picture', (await waitFor(async () => (await inTab(home, "document.querySelector('.ni-chip img').src.startsWith('data:image/')")) === true)) === true, 'no src');

  // ---- drop (with the drag-over state)
  await drop(home, [['b.png', b64(2)]]);
  check('drop: a second chip', (await waitFor(async () => (await chips(home)) === 2)) === true, await chips(home));
  check('...and dragging over showed the drop state, which ends with the drop', (await inTab(home, 'window.__dropState')) === true && (await inTab(home, "!document.querySelector('form[role=search]').classList.contains('ni-drop')")) === true, 'state');

  // ---- the attach button (the picker is stubbed through the test hook)
  await pick(home, [picks[0]]);
  check('attach button: a third chip', (await waitFor(async () => (await chips(home)) === 3)) === true, await chips(home));
  await pick(home, [notImage]);
  check('a file that is not a picture is said, not added', (await waitFor(async () => /not a picture/.test(await hint(home)))) === true && (await chips(home)) === 3, `${await hint(home)} / ${await chips(home)}`);

  // ---- remove: the x, and Backspace in the empty field
  await inTab(home, "document.querySelectorAll('.ni-chip button')[0].click()");
  check('x removes that chip', (await chips(home)) === 2, await chips(home));
  await inTab(home, "(() => { const q = document.getElementById('q'); q.value = ''; q.focus(); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); })()");
  check('Backspace in the empty field removes the last chip', (await chips(home)) === 1, await chips(home));
  await inTab(home, "(() => { const q = document.getElementById('q'); q.value = 'abc'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); })()");
  check('...but not while there is text', (await chips(home)) === 1, await chips(home));
  await pick(home, [picks[1], picks[2]]);
  check('picking two more makes three chips', (await waitFor(async () => (await chips(home)) === 3)) === true, await chips(home));

  // ---- the limit
  await inTab(home, "document.getElementById('q').value = ''");
  await paste(home, Array.from({ length: 9 }, (_, n) => [`m${n}.png`, b64(3 + n)]));
  check('over the limit: ten chips at most, and a short message', (await waitFor(async () => (await chips(home)) === 10)) === true && /Up to 10 images/.test(await hint(home)), `${await chips(home)} / ${await hint(home)}`);
  for (let n = 0; n < 7; n++) await inTab(home, "document.querySelectorAll('.ni-chip button')[0].click()");
  check('(back to three)', (await chips(home)) === 3, await chips(home));

  // ---- Ask: the chat opens with the text and the three pictures in the first message
  await app.evaluate(() => { global.__navs.length = 0; });
  await inTab(home, "(() => { const q = document.getElementById('q'); q.value = 'what is in these pictures?'; q.form.requestSubmit(); })()");
  const chat = await waitFor(async () => (await chatTabs())[0]);
  check('Ask opens the full-page chat in this tab', Boolean(chat) && !(await tabs()).some((t) => t.id === home), JSON.stringify(await tabs()));
  const req = await waitFor(async () => { const r = await app.evaluate(() => global.__requests); return r.length ? r : null; });
  const last = req && req[0][req[0].length - 1];
  const blocks = Array.isArray(last?.content) ? last.content : [];
  check('the model got the text and three image blocks in that one message', req && req.length === 1 && blocks.filter((b) => b.type === 'image').length === 3 && blocks.some((b) => b.type === 'text' && b.text.includes('what is in these pictures?')), JSON.stringify(blocks).slice(0, 300));
  const shown = await waitFor(async () => { const n = await inTab(chat.id, "document.querySelectorAll('#messages .msg.user img').length"); return n || null; });
  check('the first user message in the chat holds the three pictures', shown === 3, shown);
  check('the composer is empty (nothing left as a draft)', (await inTab(chat.id, "document.getElementById('prompt').value")) === '', 'composer');
  const urls = [...(await app.evaluate(() => global.__navs)), ...(await tabs()).map((t) => t.url)];
  check('no draft, image data or chat parameter in any address', urls.every((u) => !/draft=|send=1|chat=|base64|data:image|what.is.in/i.test(u)), urls.join(' | '));
  await waitFor(async () => (await inTab(chat.id, "document.getElementById('send') && !document.getElementById('send').classList.contains('stop') ? 'idle' : 'busy'")) === 'idle', 10000);

  // ---- a picture alone (no text) still asks; Ctrl+click opens the chat in a new tab and the new-tab page stays
  await inTab(chat.id, "document.getElementById('cp-home').click()");
  const back = await waitFor(async () => { const all = await tabs(); return (await chatTabs()).length === 0 && all.find((t) => /newtab\.html/.test(t.url)); });
  await app.evaluate((_e, id) => global.__chatPage.switchTab(id), back.id);
  await ready(back.id);
  await paste(back.id, [['c.png', b64(5)]]);
  await waitFor(async () => (await chips(back.id)) === 1);
  await inTab(back.id, "document.getElementById('mode-ask').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))");
  const second = await waitFor(async () => (await chatTabs())[0]);
  check('Ctrl+click with a picture opens the chat in a new tab and the new-tab page stays', Boolean(second) && (await tabs()).some((t) => t.id === back.id), JSON.stringify(await tabs()));
  const req2 = await waitFor(async () => { const r = await app.evaluate(() => global.__requests); return r.length > 1 ? r : null; });
  const blocks2 = req2 ? req2[1][req2[1].length - 1].content : [];
  check('...and the picture was sent (no text needed)', Array.isArray(blocks2) && blocks2.filter((b) => b.type === 'image').length === 1, JSON.stringify(blocks2).slice(0, 200));
  check('the new-tab page lets go of the pictures it sent', (await waitFor(async () => (await chips(back.id)) === 0)) === true, await chips(back.id));

  // ---- the calls are refused from a web page (and from the browser UI)
  const refused = await app.evaluate(async ({ ipcMain, BrowserWindow }, address) => {
    const tab = global.__agent.browser.openTab(address);
    await new Promise((r) => { tab.webContents.once('did-finish-load', r); setTimeout(r, 6000); });
    const wc = tab.webContents;
    const uiWc = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents;
    const before = global.__chatPage.tabs().filter((t) => t.chat).length;
    const call = (channel, event, ...args) => ipcMain._invokeHandlers.get(channel)(event, ...args);
    const out = {
      bridge: await wc.executeJavaScript('typeof window.lumenNewtab'),
      ask: await call('newtab-ai:ask', { sender: wc, senderFrame: wc.mainFrame }, { text: 'hi', images: [] }),
      pick: await call('newtab-ai:pick', { sender: wc, senderFrame: wc.mainFrame }),
      uiAsk: await call('newtab-ai:ask', { sender: uiWc, senderFrame: uiWc.mainFrame }, { text: 'hi', images: [] }),
    };
    out.chatTabsOpened = global.__chatPage.tabs().filter((t) => t.chat).length - before;
    return out;
  }, web);
  check('a web page has no lumenNewtab, and its calls are refused (ask and pick), opening nothing', refused.bridge === 'undefined' && refused.ask === false && refused.pick === null && refused.uiAsk === false && refused.chatTabsOpened === 0, JSON.stringify(refused));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
