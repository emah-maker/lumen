// Hidden run: a picture opened over one chat belongs to that chat. Opening a picture in the sidebar chat, then moving to another chat
// (New chat, which goes through clearChatView like opening a saved one) closes the viewer; it does not stay over the next chat.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const STUB = `(() => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#2a6fdb'; g.fillRect(0, 0, 200, 120);
  const host = document.getElementById('messages');
  document.getElementById('empty')?.setAttribute('hidden', '');
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  bubble.id = 'pc-stub';
  const row = document.createElement('div');
  row.className = 'msg-images';
  const im = document.createElement('img'); im.src = c.toDataURL('image/png'); im.alt = 'Picture 1'; window.genImages.zoomable(im); row.append(im);
  bubble.append(row);
  host.append(bubble);
  return true;
})()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-imgchat-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#messages', { state: 'attached' });
    await ui.evaluate(STUB);
    await ui.locator('#pc-stub img').first().click();
    await ui.locator('.civ[role=dialog]').waitFor({ timeout: 8000 });
    check('a click opens the viewer over this chat', (await ui.locator('.civ').count()) === 1, await ui.locator('.civ').count());
    await ui.evaluate(() => document.getElementById('new-chat').click());
    await ui.waitForFunction(() => !document.querySelector('.civ'), null, { timeout: 5000 }).catch(() => {});
    check('moving to another chat closes the viewer', (await ui.locator('.civ').count()) === 0, await ui.locator('.civ').count());
    check('no plain lightbox is left over either', (await ui.locator('.gen-lightbox').count()) === 0, await ui.locator('.gen-lightbox').count());
    // the plain layer (the fallback when the viewer cannot load) closes the same way
    await ui.evaluate(() => { document.getElementById('empty')?.setAttribute('hidden', ''); const d = document.createElement('div'); d.className = 'gen-lightbox'; const b = document.createElement('button'); b.className = 'gen-lightbox-close'; b.onclick = () => d.remove(); d.append(b); (document.querySelector('[data-chat-root]') || document.body).append(d); });
    await ui.evaluate(() => window.genImages.closeAll());
    check('closeAll also closes the plain layer', (await ui.locator('.gen-lightbox').count()) === 0, await ui.locator('.gen-lightbox').count());
  } catch (e) {
    failures++;
    console.log(`FAIL  ${e.stack || e}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})();
