// Pasting and dropping images into the Claude sidebar, through to the request Claude receives.
const { _electron: electron } = require('playwright-core');
const path = require('path');
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
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } }); // a (fake) Claude key: the answers come from a fake client
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

  // 7. Main process rejects invalid image payloads.
  const rejected = await app.evaluate(({ ipcMain }) => new Promise((resolve) => {
    global.__requests = [];
    const fakeEvent = { sender: { isDestroyed: () => false, send: (_c, msg) => { if (msg.type === 'done') resolve(global.__requests[0]); } } };
    ipcMain.emit('agent:ask', fakeEvent, 'hi', 99, [{ media_type: 'image/svg+xml', data: 'PHN2Zz4=' }, { media_type: 'image/png', data: 'not base64!!' }]);
  }));
  const rejectedUser = rejected?.filter((m) => m.role === 'user').pop()?.content || [];
  check('invalid images (svg, bad base64) are dropped', !rejectedUser.some((b) => b.type === 'image'), JSON.stringify(rejectedUser.map((b) => b.type)));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
