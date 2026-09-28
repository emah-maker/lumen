// Page alert()/confirm()/prompt(), the permission prompt and message boxes all draw Lumen's own
// dialog overlay (features/dialogs.js) instead of a native OS box.
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SHOT_DIR = process.env.LUMEN_SHOT_DIR;

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  // The first tab's page can take over a second to exist on a cold start (macOS especially).
  await app.evaluate(async ({ webContents }) => {
    for (let i = 0; i < 100 && !webContents.getAllWebContents().some((w) => w.getURL().includes('newtab.html')); i++) await new Promise((r) => setTimeout(r, 100));
  });
  await ui.waitForTimeout(800);

  // Runs `script` in the active tab without waiting (the page blocks until the dialog is answered).
  const start = (script) => app.evaluate(({ webContents }, script) => {
    const tab = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'));
    global.__dialogResult = undefined;
    tab.executeJavaScript(script).then((v) => { global.__dialogResult = { value: v }; });
  }, script);
  const overlay = (script) => app.evaluate(async ({ webContents }, script) => {
    for (let i = 0; i < 50; i++) {
      const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
      if (view && await view.executeJavaScript("document.getElementById('backdrop').classList.contains('shown')")) return view.executeJavaScript(script);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('dialog overlay never appeared');
  }, script);
  const result = () => app.evaluate(async () => {
    for (let i = 0; i < 50 && !global.__dialogResult; i++) await new Promise((r) => setTimeout(r, 100));
    return global.__dialogResult;
  });
  const shot = async (name) => {
    if (!SHOT_DIR) return;
    await ui.waitForTimeout(400); // entrance animation
    // The window's own capturePage leaves out child views, so capture the overlay itself.
    const png = await app.evaluate(async ({ webContents }) => (await webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html')).capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(SHOT_DIR, `dialog-${name}.png`), Buffer.from(png, 'base64'));
  };
  const click = (label) => overlay(`[...document.querySelectorAll('#buttons button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

  // confirm(): OK -> true, Cancel -> false; the card names the page.
  await start('confirm("Delete this draft?")');
  const text = await overlay("document.getElementById('message').textContent + '|' + document.getElementById('title').textContent");
  assert.ok(text.startsWith('Delete this draft?|'), text);
  await shot('confirm');
  await click('OK');
  assert.deepStrictEqual(await result(), { value: true });
  await start('confirm("Again?")');
  // From the second dialog on, the page can be muted.
  assert.strictEqual(await overlay("document.getElementById('checkbox-row').hidden"), false);
  await click('Cancel');
  assert.deepStrictEqual(await result(), { value: false });

  // prompt(): typed text comes back; Escape returns null.
  await start('prompt("Your name?", "Ada")');
  await overlay("const i = document.querySelector('#fields input'); i.value = 'Grace'; document.querySelector('#buttons .primary').click()");
  assert.deepStrictEqual(await result(), { value: 'Grace' });
  await start('prompt("Your name?")');
  await shot('prompt');
  await overlay("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  assert.deepStrictEqual(await result(), { value: null });

  // alert(), muted: ticking the box silences the rest of this page's dialogs.
  await start('alert("Saved")');
  await overlay("document.getElementById('checkbox').checked = true; document.querySelector('#buttons button').click()");
  await result();
  await start('confirm("Should not show")');
  assert.deepStrictEqual(await result(), { value: false });

  // The site permission prompt (a browser message box) uses the same overlay.
  await app.evaluate(async ({ webContents }) => {
    const tab = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'));
    await tab.loadURL('https://example.com/');
    tab.executeJavaScript('navigator.geolocation.getCurrentPosition(() => {}, () => {})');
  });
  assert.match(await overlay("document.getElementById('message').textContent"), /Allow example\.com to know your location\?/);
  await shot('permission');
  await click("Don't Allow");

  console.log('dialogs: ok');
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
