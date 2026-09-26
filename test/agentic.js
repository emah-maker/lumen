// Agent tasks on real sites with the Claude sidebar open (the page is ~1080px wide), plus
// "never submit a partly filled form" and chat restore across a restart.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', ...(profile ? { CLAUDE_BROWSER_PROFILE: profile } : {}) },
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-agentic-'));

  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r).slice(0, 300); }
    catch (err) { return 'ERROR: ' + err.message; }
  }, [name, input]);
  const url = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());

  // Open the sidebar so the page is narrow, like real use.
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  let width = 0;
  for (let i = 0; i < 30 && !(width && width < 1150); i++) {
    await ui.waitForTimeout(100);
    width = await app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('innerWidth'));
  }
  check('sidebar open: page is narrower', width < 1150, `innerWidth=${width}`);

  // Wikipedia search via fill_form at this width.
  await run('navigate', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
  let r = await run('fill_form', { fields: [{ label: 'Search Wikipedia', value: 'Alan Turing' }], submit: true });
  await ui.waitForTimeout(1500);
  check('Wikipedia search with the sidebar open', (await url()).includes('Alan_Turing') || (await url()).includes('search=Alan'), `${r} | ${await url()}`);

  // Click by text on the result page.
  r = await run('click', { text: 'Turing machine' });
  await ui.waitForTimeout(1500);
  check('click by text follows a link', (await url()).includes('Turing_machine'), `${r} | ${await url()}`);

  // Web search for non-Claude models: real DuckDuckGo results, read without cookies.
  r = await run('web_search', { query: 'Alan Turing' });
  check('web_search returns real results with URLs', /1\. .+\n\s+https?:\/\//.test(r) && /wikipedia|turing/i.test(r), r.slice(0, 300));

  // httpbin: all fields incl. radio by legend, then submit.
  await run('navigate', { url: 'https://httpbin.org/forms/post' });
  r = await run('fill_form', {
    fields: [
      { label: 'Customer name', value: 'Ada' }, { label: 'Telephone', value: '555-0100' }, { label: 'E-mail address', value: 'ada@example.com' },
      { label: 'Pizza Size', value: 'Large' }, { label: 'Bacon', value: 'true' }, { label: 'Preferred delivery time', value: '18:30' },
      { label: 'Delivery instructions', value: 'Ring twice' },
    ],
    submit: true,
  });
  await ui.waitForTimeout(2000);
  const body = await app.evaluate(async () => global.__agent.browser.activeTab().webContents.executeJavaScript('document.body.innerText'));
  check('httpbin form: every field submitted', /"custname": "Ada"/.test(body) && /"size": "large"/.test(body) && /"topping": "bacon"/.test(body) && /"delivery": "18:30"/.test(body), `${r.slice(0, 200)} | ${body.slice(0, 300)}`);

  // A failed field must stop the submit.
  await run('navigate', { url: 'https://httpbin.org/forms/post' });
  r = await run('fill_form', { fields: [{ label: 'Customer name', value: 'Bob' }, { label: 'Favourite colour', value: 'blue' }], submit: true });
  await ui.waitForTimeout(1500);
  check('partly filled form is NOT submitted', r.startsWith('ERROR') && r.includes('NOT submitted') && (await url()).includes('/forms/post'), `${r.slice(0, 200)} | ${await url()}`);

  // Chat restore: run a (fake) conversation, restart with the same profile, see it again.
  await app.evaluate(() => {
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Remembered **reply**.' }] };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Remembered **reply**.' } }; }, finalMessage: async () => message };
    } } } });
  });
  await ui.fill('#prompt', 'remember this');
  await ui.press('#prompt', 'Enter');
  await ui.waitForSelector('.msg.assistant', { timeout: 5000 }).catch(() => {});
  await ui.waitForTimeout(500);
  await app.close();

  app = await launch(profile);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.waitForTimeout(1500);
  const restored = await ui.evaluate(() => ({
    user: [...document.querySelectorAll('.msg.user')].map((e) => e.textContent),
    assistant: [...document.querySelectorAll('.msg.assistant')].map((e) => e.innerHTML),
  }));
  check('previous chat is shown after restart', restored.user.some((t) => t.includes('remember this')) && restored.assistant.some((h) => h.includes('<strong>reply</strong>')), JSON.stringify(restored).slice(0, 300));
  const history = await app.evaluate(() => global.__agent.messages.length);
  check('Claude still has the chat history after restart', history === 2, history);
  const saved = fs.readFileSync(path.join(profile, 'chat.json'), 'utf8');
  check('saved chat is encrypted on disk', saved.includes('"enc"') && !saved.includes('remember this'), saved.slice(0, 80));
  await app.close();

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
