// New-tab page: the Search | Ask AI switch, asking the sidebar from the homepage, and new-tab focus.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // No API key, an empty `ant` CLI profile, and a Claude Code binary that doesn't exist (so this
  // machine's own install, if any, can't sneak in) — "is the agent usable" is decided by the test.
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-home-cli-')), LUMEN_CLAUDE_BIN: path.join(os.tmpdir(), 'lumen-home-no-such-claude-binary') };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // Open a fresh new tab and wait for it to render.
  const newTab = () => app.evaluate(async () => {
    const t = global.__agent.browser.openTab();
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    global.__homeTab = t;
    return t.webContents.getURL();
  });
  const inTab = (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js);
  const placeholder = () => inTab("document.getElementById('q').placeholder");
  const submit = (text) => inTab(`(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(text)}; q.form.requestSubmit(); })()`);

  await newTab();
  check('Search is the default mode', /^Search /.test(await placeholder()) && (await inTab("document.getElementById('mode-search').getAttribute('aria-checked')")) === 'true', await placeholder());
  await inTab("document.getElementById('mode-ask').click()");
  // No key and no CLI profile here (see env above): nothing is connected, so the assistant name is
  // the neutral 'AI', not Claude — no provider is privileged when there's nothing to back it.
  check('Ask AI switches the placeholder to the assistant', (await placeholder()) === 'Ask AI…', await placeholder());
  await newTab();
  check('the choice persists across new tabs', (await placeholder()) === 'Ask AI…', await placeholder());
  await inTab("document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))");
  check('Ctrl+/ toggles back to Search', /^Search /.test(await placeholder()), await placeholder());
  await inTab("document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true }))");
  check('Alt+A toggles to Ask AI', (await placeholder()) === 'Ask AI…', await placeholder());
  await inTab("document.getElementById('mode').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
  const arrowed = await placeholder();
  await inTab("document.getElementById('mode').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  check('arrow keys move between the two options', /^Search /.test(arrowed) && (await placeholder()) === 'Ask AI…', `${arrowed} / ${await placeholder()}`);

  // With a key, Ask AI hands the prompt to the agent in the sidebar; the tab stays on the homepage.
  await app.evaluate(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.__homePrompts = [];
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const last = params.messages[params.messages.length - 1];
      const text = typeof last.content === 'string' ? last.content : last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      global.__homePrompts.push(text);
      const content = [{ type: 'text', text: 'Here is an answer.' }];
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content };
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content[0].text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });
  // The sidebar caches "is anything connected" (see app.js's modelReady) so it can show the setup
  // card instead of erroring; setting the env var behind its back needs an explicit nudge, same as
  // main.js sends after a real key save.
  await ui.evaluate(() => window.loadModels());
  await newTab();
  await submit('What is a good pasta recipe?');
  let prompts = [];
  for (let i = 0; i < 30 && !prompts.length; i++) { await sleep(300); prompts = await app.evaluate(() => global.__homePrompts); }
  check('Ask AI delivers the prompt to the agent', prompts.some((p) => p.includes('What is a good pasta recipe?')), JSON.stringify(prompts));
  check('the sidebar opens', (await ui.getAttribute('#toggle-sidebar', 'aria-pressed')) === 'true', await ui.getAttribute('#toggle-sidebar', 'aria-pressed'));
  const url = await app.evaluate(() => global.__homeTab.webContents.getURL());
  check('the tab stays on the homepage', /newtab\.html/.test(url) && !/[?&]ask=/.test(url), url);
  await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 }).catch(() => {});

  // New-tab focus: Ctrl+T puts the cursor in the address bar (Search and Ask AI modes alike), typed
  // with real key events to whichever view has native focus, no click first.
  const typeNative = (text) => app.evaluate(async ({ webContents }, t) => {
    // A whole key press, as a real keyboard sends it: a lone 'char' right after a Ctrl shortcut is dropped.
    for (const ch of t) {
      const wc = webContents.getFocusedWebContents();
      for (const type of ['keyDown', 'char', 'keyUp']) wc?.sendInputEvent({ type, keyCode: ch });
      await new Promise((r) => setTimeout(r, 10));
    }
  }, text);
  const ctrlT = () => app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.focus();
    const before = global.__agent.browser.activeTab()?.id;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 't', modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 't', modifiers: ['control'] });
    for (let i = 0; i < 50; i++) {
      const t = global.__agent.browser.activeTab();
      if (t && t.id !== before && !t.webContents.isLoading() && t.webContents.getURL()) { global.__homeTab = t; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));
  });
  for (const mode of ['search', 'ask']) {
    await ctrlT();
    if (mode === 'ask') {
      await inTab("document.querySelector('[data-mode=ask]')?.click()");
      await ctrlT();
    }
    await typeNative('abc');
    await sleep(200);
    const value = await ui.evaluate(() => document.getElementById('address').value);
    check(`new tab (${mode} mode): typing without a click lands in the address bar`, value === 'abc', JSON.stringify(value));
    await ui.keyboard.press('Escape');
    await ui.keyboard.press('Escape');
  }
  await inTab("document.querySelector('[data-mode=search]')?.click()");
  // Yielding to the address bar when it is clicked while the tab loads: see the stress test in ui.js.

  check('no UI errors', errors.length === 0, errors.join('; '));
  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
