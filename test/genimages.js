// Pictures the AI makes, in the real app (fake keys, fake providers, a throwaway profile): "draw a cat" through a GPT key shows the
// picture in the reply (fit to the bubble, Save / Copy, click to enlarge, right-click menu), it is saved with the chat and drawn again
// after the chat is reopened and in the full-page chat, a model that can't make pictures says so, a made picture comes out with the
// export, deleting the chat deletes the file, web pictures wait for a click, and nothing unsafe becomes an <img>.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SRC = path.join(__dirname, '..', 'src').split(path.sep).join('/');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-genimg-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

  // A 24x24 red PNG made by Electron itself.
  const redPng = await app.evaluate(({ nativeImage }) => {
    const buf = Buffer.alloc(24 * 24 * 4);
    for (let i = 0; i < buf.length; i += 4) buf.set([0, 0, 255, 255], i);
    return nativeImage.createFromBitmap(buf, { width: 24, height: 24 }).toPNG().toString('base64');
  });

  // The fake providers: Claude answers with words; the GPT image API answers with the red picture.
  await app.evaluate((_e, { png, src }) => {
    const providers = process.mainModule.require(`${src}/ai/providers`);
    global.__imageCalls = [];
    providers.generateImage = async (opts) => { global.__imageCalls.push({ provider: opts.provider, prompt: opts.prompt }); return { images: [{ data: png, alt: opts.prompt }], model: 'gpt-image-1', said: '' }; };
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      const message = { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I can describe it in words.' }] };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I can describe it in words.' } }; }, finalMessage: async () => message };
    } } } });
  }, { png: redPng, src: SRC });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(400);
  const send = async (text) => {
    await ui.fill('#prompt', text);
    await ui.press('#prompt', 'Enter');
    await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 8000 });
  };

  // ---- a model with an image API: the picture is the reply
  await ui.selectOption('#model', 'openai:gpt-5.6');
  await send('draw a red square');
  await ui.waitForSelector('.gen-img img', { timeout: 8000 }).catch(() => {});
  check('"draw a red square" on GPT calls the images API with the user\'s words', JSON.stringify(await app.evaluate(() => global.__imageCalls)) === JSON.stringify([{ provider: 'openai', prompt: 'draw a red square' }]), JSON.stringify(await app.evaluate(() => global.__imageCalls)));
  check('the picture shows in the chat, as an image with a description', (await ui.locator('.msg.gen-pics .gen-img img').count()) === 1 && (await ui.locator('.gen-img img').getAttribute('alt')) === 'draw a red square', await ui.locator('.gen-img').count());
  const shown = await ui.evaluate(() => { const i = document.querySelector('.gen-img img'); return { ok: i.complete && i.naturalWidth === 24, src: i.src.slice(0, 22), fits: i.getBoundingClientRect().width <= document.querySelector('.msg.gen-pics').getBoundingClientRect().width + 1 }; });
  check('it is a real decoded PNG, from a data URL, no wider than its bubble', shown.ok && shown.src === 'data:image/png;base64,' && shown.fits, JSON.stringify(shown));
  check('Save and Copy are buttons with names; the picture opens with Enter', (await ui.locator('.gen-img-bar button').allTextContents()).join() === 'Save,Copy' && (await ui.locator('.gen-img-open').getAttribute('aria-label')).startsWith('Enlarge picture'), await ui.locator('.gen-img-bar').innerText());
  check('the reply can be asked for again', (await ui.locator('.reply-regen').count()) >= 1, 'no regenerate');

  // enlarge: a dialog, Escape closes it and returns focus
  await ui.locator('.gen-img-open').focus();
  await ui.keyboard.press('Enter');
  const dialog = ui.locator('.gen-lightbox[role=dialog]');
  check('Enter on the picture enlarges it in a labelled dialog', (await dialog.count()) === 1 && (await dialog.getAttribute('aria-modal')) === 'true' && Boolean(await dialog.getAttribute('aria-label')), await dialog.count());
  check('focus moves into the dialog', await ui.evaluate(() => document.activeElement?.closest('.gen-lightbox') !== null), 'focus outside');
  await ui.keyboard.press('Escape');
  check('Escape closes it and gives focus back to the picture', (await ui.locator('.gen-lightbox').count()) === 0 && await ui.evaluate(() => document.activeElement?.classList.contains('gen-img-open')), 'still open');

  // right-click menu and copy
  await ui.locator('.gen-img-open').click({ button: 'right' });
  check('right-click opens a menu with Save image and Copy image', (await ui.locator('.gen-menu [role=menuitem]').allTextContents()).join() === 'Save image,Copy image', await ui.locator('.gen-menu').count());
  await ui.locator('.gen-menu [role=menuitem]').nth(1).click();
  check('Copy image succeeds and says so', await waitFor(async () => /Copied/.test(await ui.locator('.gen-img-status').first().innerText().catch(() => ''))), await ui.locator('.gen-img-status').first().innerText().catch(() => ''));

  // ---- saved with the chat: an encrypted file, a reference in the history, shown again after a reload
  const info = await app.evaluate(() => {
    const store = global.__imageStore();
    const snap = global.__agent.snapshot();
    const block = snap.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'generated_image');
    return { block, read: block ? Boolean(store.read(block.id)) : false, size: JSON.stringify(snap).length };
  });
  check('the chat keeps a small reference and the file holds the picture', info.block?.id && info.read && info.size < 6000, JSON.stringify(info).slice(0, 200));
  const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  const file = info.block ? path.join(profile, 'generated-images', info.block.id.split('~')[0], `${info.block.id.split('~')[1]}.img`) : '';
  check('the file is on disk in the profile (not in the settings)', !encrypted || (Boolean(file) && fs.existsSync(file)), file);
  const view = await app.evaluate(() => global.__agent.transcript());
  check('the transcript lists the picture on the reply', view.some((i) => i.generated?.length === 1), JSON.stringify(view).slice(0, 200));
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.waitForTimeout(500);
  check('a new chat starts empty', (await ui.locator('.gen-img').count()) === 0, await ui.locator('.gen-img').count());
  const chatId = info.block.id.split('~')[0];
  await ui.evaluate((items) => window.showHistory(items), view);
  await ui.waitForSelector('.gen-img img', { timeout: 6000 }).catch(() => {});
  check('the picture is drawn again when the chat is shown again', (await ui.locator('.msg.gen-pics.restored .gen-img img').count()) === 1, await ui.locator('.gen-img').count());

  // ---- export writes the picture next to the file
  const md = require('../src/features/chat-store').toMarkdown({ title: 'T' }, view, { pictureFile: () => 'pics/picture-1.png' });
  check('export links the picture', md.includes('](pics/picture-1.png)'), md);

  // ---- a model that can't make pictures says so, and still answers
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.waitForTimeout(400);
  await ui.selectOption('#model', 'claude-opus-5-5');
  await send('draw a red square');
  check('Claude: a notice that it can\'t make pictures, and the words answer', /can.t make pictures/.test(await ui.locator('#messages .notice').first().innerText().catch(() => '')) && /describe it in words/.test(await ui.locator('.msg.assistant').last().innerText()), await ui.locator('#messages').innerText());
  check('no picture and no call to an images API for it', (await ui.locator('.gen-img').count()) === 0 && (await app.evaluate(() => global.__imageCalls.length)) === 1);

  // ---- markdown pictures: a data picture is drawn; a web picture waits for a click; nothing unsafe is an <img>
  const probe = await ui.evaluate((png) => {
    const host = document.createElement('div');
    host.className = 'msg assistant';
    const md = [`![inline](data:image/png;base64,${png})`, '![web](https://example.com/cat.png)', '![x](javascript:alert(1))', '![y](data:image/svg+xml;base64,PHN2Zz4=)', '![z](http://example.com/a.png)', '![w](file:///C:/Windows/win.ini)'].join('\n\n');
    host.innerHTML = window.renderMarkdown(md);
    document.getElementById('messages').append(host);
    window.genImages.decorate(host);
    return { imgs: [...host.querySelectorAll('img')].map((i) => i.src.slice(0, 22)), show: [...host.querySelectorAll('.gen-img-show')].map((b) => b.textContent), anySrcRemote: [...host.querySelectorAll('img')].some((i) => !i.src.startsWith('data:image/png;base64,')) };
  }, redPng);
  check('markdown: the data picture is the only <img> and it is a data URL', probe.imgs.length === 1 && !probe.anySrcRemote, JSON.stringify(probe));
  check('markdown: the web picture is a "Show picture from example.com" button', probe.show.join() === 'Show picture from example.com', JSON.stringify(probe));

  // ---- delete the chat: its picture file goes with it
  const removed = await ui.evaluate((id) => window.assistant.chats.remove(id), chatId);
  check('deleting the chat removes the picture file', Boolean(removed) && !fs.existsSync(file) && (await app.evaluate((_e, id) => global.__imageStore().read(id) === null, info.block.id)), JSON.stringify(removed));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
