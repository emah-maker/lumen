// New-tab page: the Search | Ask AI switch, and asking the sidebar from the homepage.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // No API key and an empty CLI profile, so "is the agent usable" is decided by the test.
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-home-cli-')) };
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
  check('Ask AI switches the placeholder to the assistant', (await placeholder()) === 'Ask Claude…', await placeholder());
  await newTab();
  check('the choice persists across new tabs', (await placeholder()) === 'Ask Claude…', await placeholder());
  await inTab("document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))");
  check('Ctrl+/ toggles back to Search', /^Search /.test(await placeholder()), await placeholder());
  await inTab("document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true }))");
  check('Alt+A toggles to Ask AI', (await placeholder()) === 'Ask Claude…', await placeholder());
  await inTab("document.getElementById('mode').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
  const arrowed = await placeholder();
  await inTab("document.getElementById('mode').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  check('arrow keys move between the two options', /^Search /.test(arrowed) && (await placeholder()) === 'Ask Claude…', `${arrowed} / ${await placeholder()}`);

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
  await newTab();
  await submit('What is a good pasta recipe?');
  let prompts = [];
  for (let i = 0; i < 30 && !prompts.length; i++) { await sleep(300); prompts = await app.evaluate(() => global.__homePrompts); }
  check('Ask AI delivers the prompt to the agent', prompts.some((p) => p.includes('What is a good pasta recipe?')), JSON.stringify(prompts));
  check('the sidebar opens', (await ui.getAttribute('#toggle-sidebar', 'aria-pressed')) === 'true', await ui.getAttribute('#toggle-sidebar', 'aria-pressed'));
  const url = await app.evaluate(() => global.__homeTab.webContents.getURL());
  check('the tab stays on the homepage', /newtab\.html/.test(url) && !/[?&]ask=/.test(url), url);
  await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 }).catch(() => {});

  // A web panel and no key: the prompt goes on the clipboard, nothing is typed into the site.
  await app.evaluate(({ clipboard }) => { delete process.env.ANTHROPIC_API_KEY; global.__homePrompts = []; clipboard.writeText(''); });
  await ui.click('#ai-switch [data-mode="claude"]');
  await sleep(600);
  await newTab();
  await submit('Plan a weekend in Boston');
  let clip = '';
  for (let i = 0; i < 20 && !clip; i++) { await sleep(250); clip = await app.evaluate(({ clipboard }) => clipboard.readText()); }
  check('web panel without a key: prompt lands on the clipboard', clip === 'Plan a weekend in Boston', clip);
  const toast = await ui.evaluate(() => { const t = document.getElementById('webai-toast'); return t.hidden ? '' : t.textContent; });
  check('toast asks the user to paste it', toast === 'Prompt copied: paste it into Claude', toast);
  check('nothing was sent to the agent', (await app.evaluate(() => global.__homePrompts)).length === 0, 'agent called');
  check('web panel stays selected', await ui.evaluate(() => document.body.classList.contains('webai-mode')), 'left web mode');

  await ui.click('#ai-switch [data-mode="agent"]');
  check('no UI errors', errors.length === 0, errors.join('; '));
  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
