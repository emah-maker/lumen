// Pasting and dropping images into the Claude sidebar, through to the request Claude receives.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Puts a solid-colour image on the real OS clipboard (through Electron, so it works on every platform).
const BGRA = { Red: [0, 0, 255, 255], White: [255, 255, 255, 255] };
function clipboardImage(app, size, color) {
  return app.evaluate(({ clipboard, ClipboardItem, nativeImage }, { size, pixel }) => {
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < buf.length; i += 4) buf.set(pixel, i);
    const png = nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG();
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  }, { size, pixel: BGRA[color] });
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-images-')); // a throwaway profile, never the real one
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } }); // a (fake) Claude key: the answers come from a fake client
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  // Fake Claude that records the user content it receives.
  await app.evaluate(() => {
    global.__requests = [];
    global.__agent.getClient = () => ({
      beta: { messages: { stream: (params) => {
        global.__requests.push(JSON.parse(JSON.stringify(params.messages)));
        const message = { role: 'assistant', content: [{ type: 'text', text: 'I see a red square.' }], stop_reason: 'end_turn' };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I see a red square.' } };
          },
          finalMessage: async () => message,
        };
      } } },
    });
  });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(300);

  // 1. Real clipboard paste: put an image on the OS clipboard, then paste into the prompt.
  await clipboardImage(app, 40, 'Red');
  await ui.focus('#prompt');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
  await ui.waitForSelector('.attachment img', { timeout: 5000 }).catch(() => {});
  check('pasting an image shows a preview', (await ui.locator('.attachment').count()) === 1, await ui.locator('.attachment').count());

  // 2. Text paste still pastes text.
  await app.evaluate(({ clipboard }) => clipboard.writeText('what is this?'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
  await ui.waitForTimeout(200);
  check('text paste still inserts text', (await ui.inputValue('#prompt')) === 'what is this?', await ui.inputValue('#prompt'));

  // 3. Drop a second image, remove it with ×.
  await ui.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 30; c.height = 30;
    c.getContext('2d').fillRect(0, 0, 30, 30);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'drop.png', { type: 'image/png' }));
    const sidebar = document.getElementById('sidebar');
    sidebar.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    sidebar.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await ui.waitForTimeout(500);
  check('dropping an image adds a second preview', (await ui.locator('.attachment').count()) === 2, await ui.locator('.attachment').count());
  await ui.locator('.attachment-remove').nth(1).click({ force: true });
  check('× removes an image', (await ui.locator('.attachment').count()) === 1, await ui.locator('.attachment').count());

  // 4. Large images are downscaled before sending.
  await ui.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
    c.getContext('2d').fillRect(0, 0, 4000, 3000);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'big.jpg', { type: 'image/jpeg' }));
    document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await ui.waitForTimeout(1500);
  check('large image is added', (await ui.locator('.attachment').count()) === 2, await ui.locator('.attachment').count());

  // 5. Send: the bubble shows images and Claude receives image blocks before the text.
  await ui.press('#prompt', 'Enter');
  await ui.waitForSelector('.msg.assistant', { timeout: 5000 }).catch(() => {});
  check('sent message shows the images', (await ui.locator('.msg.user .msg-images img').count()) === 2, await ui.locator('.msg.user .msg-images img').count());
  check('previews clear after sending', (await ui.locator('.attachment').count()) === 0, await ui.locator('.attachment').count());
  const sent = await app.evaluate(() => global.__requests[0]?.[0]?.content);
  const kinds = (sent || []).map((b) => b.type);
  check('Claude receives [image, image, text]', JSON.stringify(kinds) === '["image","image","text"]', JSON.stringify(kinds));
  check('text arrives with the images', sent?.[2]?.text.includes('what is this?'), sent?.[2]?.text);
  const big = await ui.evaluate(async (data) => {
    const img = new Image(); img.src = 'data:image/jpeg;base64,' + data; await img.decode();
    return Math.max(img.naturalWidth, img.naturalHeight);
  }, sent?.[1]?.source?.data || '');
  check('large image downscaled to 1568px long edge', big === 1568, big);
  check('reply renders', (await ui.locator('.msg.assistant').count()) === 1, 'no reply');

  // 6. Image-only message is allowed.
  await clipboardImage(app, 16, 'White');
  await ui.focus('#prompt');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
  await ui.waitForSelector('.attachment img', { timeout: 5000 }).catch(() => {});
  check('send button enabled with only an image', !(await ui.isDisabled('#send')), 'disabled');
  await ui.press('#prompt', 'Enter');
  await ui.waitForTimeout(800);
  const second = await app.evaluate(() => global.__requests[1]);
  const lastUser = second?.filter((m) => m.role === 'user').pop()?.content || [];
  check('image-only message reaches Claude', lastUser.some((b) => b.type === 'image') && lastUser.some((b) => b.type === 'text' && b.text.includes('attached the image')), JSON.stringify(lastUser.map((b) => b.type)));

  // 6b. The attach button: visible, named, with its limit in the tooltip, keyboard operable.
  const attachBtn = ui.locator('#attach');
  check('attach button is in the composer', (await attachBtn.count()) === 1 && await attachBtn.isVisible(), 'missing');
  check('attach button has an accessible name and a tooltip stating the limit', (await attachBtn.getAttribute('aria-label')) === 'Attach files' && /up to 10/.test((await attachBtn.getAttribute('title')) || ''), await attachBtn.getAttribute('title'));
  await attachBtn.focus();
  const chooser = ui.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
  await ui.keyboard.press('Enter');
  const picked = await chooser;
  check('Enter on the focused attach button opens the file picker', Boolean(picked), 'no file chooser');
  const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  if (picked) {
    check('the picker takes several files', picked.isMultiple(), 'single');
    await picked.setFiles([{ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL }]);
    await ui.waitForSelector('.attachment', { timeout: 4000 }).catch(() => {});
  }
  check('a picked image shows a preview with its name', (await ui.locator('.attachment').count()) === 1 && /pixel\.png/.test((await ui.locator('.attachment img').first().getAttribute('alt')) || ''), await ui.locator('.attachment').count());

  // Formats and failures: every one that can't be added is said in a note under the previews.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>';
  await ui.setInputFiles('#attach-input', [
    { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) },
    { name: 'photo.heic', mimeType: 'image/heic', buffer: Buffer.from('not really heic') },
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not a png') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'empty.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(0) },
  ]);
  await ui.waitForTimeout(800);
  const note = await ui.locator('#attachment-note').innerText().catch(() => '');
  check('an SVG is added (converted), and the other files become file chips', (await ui.locator('.attachment').count()) === 5 && (await ui.locator('.attachment img').count()) === 2, await ui.locator('.attachment').count());
  const fileChips = await ui.locator('.attachment-file').allInnerTexts();
  check('a HEIC photo, a corrupt image and a text file are kept as files (they can be uploaded to a page, the AI is not sent them)', fileChips.length === 3 && /photo\.heic/.test(fileChips[0]) && /broken\.png/.test(fileChips[1]) && /notes\.txt/.test(fileChips[2]), JSON.stringify(fileChips));
  check('an empty file is refused', /empty\.jpg.*empty/.test(note) && !/photo\.heic|notes\.txt/.test(note), note);
  check('the note is announced (status role)', (await ui.locator('#attachment-note').getAttribute('role')) === 'status', 'no role');
  const svgOut = await ui.evaluate(() => document.querySelectorAll('.attachment img')[1]?.src.slice(0, 22));
  check('the SVG became a PNG', svgOut === 'data:image/png;base64,', svgOut);

  // The limit of 10 attachments (5 of them pictures the AI sees): the rest are counted in the note and the button waits.
  const tiny = (n) => ({ name: `p${n}.png`, mimeType: 'image/png', buffer: PIXEL });
  await ui.setInputFiles('#attach-input', [tiny(1), tiny(2), tiny(3), tiny(4), tiny(5), tiny(6)]);
  await ui.waitForTimeout(1200);
  check('no more than 10 attachments, and no more than 5 of them pictures', (await ui.locator('.attachment').count()) === 10 && (await ui.locator('.attachment img').count()) === 5, `${await ui.locator('.attachment').count()} / ${await ui.locator('.attachment img').count()}`);
  check('the overflow is counted in the note', /up to 10 files; 1 not added/.test(await ui.locator('#attachment-note').innerText()), await ui.locator('#attachment-note').innerText());
  check('the attach button waits at the limit and says why', await ui.isDisabled('#attach') && /up to 10 files/.test((await attachBtn.getAttribute('title')) || ''), await attachBtn.getAttribute('title'));

  // A background task is saved as words only: with images the button waits and says so (instead of dropping them).
  await ui.fill('#prompt', 'check this later');
  await ui.waitForTimeout(150);
  const bgTitle = (await ui.locator('#send-bg').getAttribute('title')) || '';
  check('Run in the background is disabled while images or files are attached, with a reason', await ui.isDisabled('#send-bg') && /can.t include images/.test(bgTitle), bgTitle);
  await ui.fill('#prompt', '/background look at this');
  await ui.press('#prompt', 'Enter');
  await ui.waitForTimeout(300);
  check('/background with images keeps the message and says why', (await ui.inputValue('#prompt')) === '/background look at this' && /can.t include images/.test(await ui.locator('#attachment-note').innerText()), await ui.inputValue('#prompt'));
  await ui.fill('#prompt', '');

  // Remove them all; an image copied from a web page (picture + its HTML) pastes as one image, not as markup.
  while ((await ui.locator('.attachment-remove').count()) > 0) await ui.locator('.attachment-remove').first().click({ force: true });
  check('removing every image empties the strip', (await ui.locator('.attachment').count()) === 0 && !(await ui.isDisabled('#attach')), 'left');
  await app.evaluate(({ clipboard, ClipboardItem, nativeImage }) => {
    const buf = Buffer.alloc(20 * 20 * 4, 255);
    const png = nativeImage.createFromBitmap(buf, { width: 20, height: 20 }).toPNG();
    return clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }), 'text/html': new Blob(['<img src="https://example.com/a.png">'], { type: 'text/html' }) })]);
  });
  await ui.focus('#prompt');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
  await ui.waitForSelector('.attachment img', { timeout: 5000 }).catch(() => {});
  check('an image copied from a web page pastes as one image and no markup', (await ui.locator('.attachment').count()) === 1 && (await ui.inputValue('#prompt')) === '', `${await ui.locator('.attachment').count()} / ${await ui.inputValue('#prompt')}`);
  await ui.locator('.attachment-remove').first().click({ force: true });

  // The chat holds the images: saved with it and shown again after a reload.
  const snap = await app.evaluate(() => JSON.parse(JSON.stringify(global.__agent.snapshot())));
  const saved = snap.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
  check('the chat snapshot (what is saved, encrypted) keeps the sent images', saved.length === 2, saved.length);
  const items = await app.evaluate(() => global.__agent.transcript()); // (what the sidebar redraws a restored chat from)
  const shown = items.filter((i) => i.role === 'user' && i.images?.length);
  check('reopening the chat shows the images again', shown.length === 2 && shown[0].images.length === 2 && shown[0].images[0].startsWith('data:image/'), JSON.stringify(shown.map((i) => i.images?.length)));

  // 7. Main process rejects invalid image payloads (and says so).
  const rejected = await app.evaluate(({ ipcMain }) => new Promise((resolve) => {
    global.__requests = [];
    const notices = [];
    const fakeEvent = { sender: { isDestroyed: () => false, send: (_c, msg) => { if (msg.type === 'notice') notices.push(msg.text); if (msg.type === 'done') resolve({ request: global.__requests[0], notices }); } } };
    ipcMain.emit('agent:ask', fakeEvent, 'hi', 99, [{ media_type: 'image/svg+xml', data: 'PHN2Zz4=' }, { media_type: 'image/png', data: 'not base64!!' }]);
  }));
  check('the refused images are named in a notice', /Left out 2 images/.test(rejected?.notices?.[0] || ''), JSON.stringify(rejected?.notices));
  const rejectedUser = rejected?.request?.filter((m) => m.role === 'user').pop()?.content || [];
  check('invalid images (svg, bad base64) are dropped', !rejectedUser.some((b) => b.type === 'image'), JSON.stringify(rejectedUser.map((b) => b.type)));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
