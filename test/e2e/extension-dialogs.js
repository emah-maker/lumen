// An extension's content script calling alert()/confirm()/prompt() (1Password's "isn't linked to a login ... Click OK to
// paste" confirm) draws Lumen's own dialog, named after the extension, instead of a grey native box (browser/extension-dialogs.js).
// A page cannot ask in an extension's name: its own request without the extension's key is refused and shows nothing.
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ext-dialogs-'));
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Dialog Tester', version: '1.0',
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'], run_at: 'document_idle' }],
  }));
  // The page asks the content script by an event (dispatched synchronously, so the page's call waits for the answer too).
  fs.writeFileSync(path.join(ext, 'cs.js'), `document.addEventListener('ask', (e) => {
    const [kind, text] = JSON.parse(e.detail);
    const answer = kind === 'confirm' ? confirm(text) : kind === 'prompt' ? prompt(text, 'Ada') : alert(text);
    document.documentElement.dataset.answer = JSON.stringify({ answer: answer === undefined ? 'undefined' : answer });
  });`);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Site</title><p>site</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}/`;

  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const bail = setTimeout(() => { console.error('extension-dialogs: 3 min cap'); app.close().finally(() => process.exit(1)); }, 180000);
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(async ({ webContents }) => {
    for (let i = 0; i < 100 && !webContents.getAllWebContents().some((w) => w.getURL().includes('newtab.html')); i++) await new Promise((r) => setTimeout(r, 100));
  });
  const loaded = await app.evaluate(async ({ session }, dir) => { const e = await session.defaultSession.extensions.loadExtension(dir); return { id: e.id, name: e.name }; }, ext);
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.content_scripts[0].js, ['lumen-dialogs.js'], 'the shim is loaded first');
  assert.deepStrictEqual(manifest.content_scripts[0].matches, ['http://127.0.0.1/*'], 'on the sites its own script reaches, no more');
  assert.ok(fs.readFileSync(path.join(ext, 'lumen-dialogs.js'), 'utf8').includes('lumen-dialog://ask/'));

  await app.evaluate(async ({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'));
    await tab.loadURL(url).catch(() => {}); // (the new-tab page's own unload aborts the first load's promise: waited for below)
    for (let i = 0; i < 100 && !tab.getURL().startsWith(url); i++) await new Promise((r) => setTimeout(r, 100));
    if (!tab.getURL().startsWith(url)) throw new Error(`the site never loaded: ${tab.getURL().slice(0, 80)}`);
    global.__siteTab = tab;
  }, site);
  await ui.waitForTimeout(1000);

  const start = (kind, text) => app.evaluate((_e, [kind, text]) => {
    global.__dialogResult = undefined;
    global.__siteTab.executeJavaScript(`document.dispatchEvent(new CustomEvent('ask', { detail: ${JSON.stringify(JSON.stringify([kind, text]))} })); document.documentElement.dataset.answer`)
      .then((v) => { global.__dialogResult = { value: JSON.parse(v || 'null') }; }, (err) => { global.__dialogResult = { error: String(err) }; });
  }, [kind, text]);
  const overlay = (script) => app.evaluate(async ({ webContents }, script) => {
    for (let i = 0; i < 80; i++) {
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
  const click = (label) => overlay(`[...document.querySelectorAll('#buttons button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

  // confirm(): Lumen's card, titled with the extension; OK -> true, Cancel -> false.
  await start('confirm', "The website you're on isn't linked to a login. Click OK to paste your password.");
  const card = await overlay("document.getElementById('title').textContent + '|' + document.getElementById('message').textContent");
  assert.strictEqual(card, `${loaded.name} says|The website you're on isn't linked to a login. Click OK to paste your password.`);
  await click('OK');
  assert.deepStrictEqual(await result(), { value: { answer: true } }, 'OK answers true');
  console.log('PASS  confirm: Lumen card named after the extension, OK -> true');
  await start('confirm', 'Again?');
  await click('Cancel');
  assert.deepStrictEqual(await result(), { value: { answer: false } }, 'Cancel answers false');
  console.log('PASS  confirm: Cancel -> false');

  // prompt(): the default is filled in, the typed text comes back; alert() waits for OK.
  await start('prompt', 'Your name?');
  assert.strictEqual(await overlay("document.querySelector('#fields input').value"), 'Ada');
  await overlay("const i = document.querySelector('#fields input'); i.value = 'Grace'; document.querySelector('#buttons .primary').click()");
  assert.deepStrictEqual(await result(), { value: { answer: 'Grace' } });
  console.log('PASS  prompt: default shown, typed text returned');
  await start('alert', 'Saved.');
  await click('OK');
  assert.deepStrictEqual(await result(), { value: { answer: 'undefined' } });
  console.log('PASS  alert: Lumen card, returns once OK is pressed');

  // The page itself asking with no key (or a made-up one) is refused, and no card shows.
  const forged = await app.evaluate(async () => global.__siteTab.executeJavaScript(`(() => { const x = new XMLHttpRequest(); try { x.open('POST', 'lumen-dialog://ask/', false); x.send(JSON.stringify({ key: 'guess', kind: 'confirm', message: 'Enter your master password' })); return x.status; } catch (e) { return 'blocked: ' + e.name; } })()`));
  assert.notStrictEqual(forged, 200, `a page's own ask is refused (${forged})`);
  const shown = await app.evaluate(async ({ webContents }) => {
    const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
    return Boolean(view && await view.executeJavaScript("document.getElementById('backdrop').classList.contains('shown')"));
  });
  assert.strictEqual(shown, false, 'and nothing is shown');
  console.log(`PASS  a page's own ask without the key is refused (${forged})`);

  clearTimeout(bail);
  await app.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
  console.log('extension-dialogs: ok');
})().catch((err) => { console.error(err); process.exit(1); });
