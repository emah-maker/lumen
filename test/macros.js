// Macros end to end: record on a local test page (real, trusted input), review the draft in Settings > Macros, save it,
// replay it (also on a page whose markup changed, to use the locator fallbacks), a pause that waits for Continue, a failing
// step (progress toast with "Edit macro"), Stop, a keyboard shortcut, the sidebar's /macro command, and the AI's run_macro tool
// with its approval cards. Hidden windows only (LUMEN_TEST_BACKGROUND: show:false, never focused), no dialogs, a throwaway
// profile. A screenshot of the Macros settings page goes to $MACROS_SHOT (default: the temp folder).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const PAGE = (variant) => `<!doctype html><meta charset="utf-8"><title>Shop ${variant}</title><body>
<h1>Shop</h1>
<label>Search products <input ${variant === 'v2' ? 'id="query-2" ' : 'id="q" data-testid="q" '}type="search" aria-label="Search products" autocomplete="off"></label>
<button type="button" ${variant === 'v2' ? '' : 'id="go-btn" '}onclick="document.getElementById('out').textContent='Searched: '+document.querySelector('input[type=search]').value">Find</button>
<input id="pw" type="password" aria-label="Password" autocomplete="current-password">
<form onsubmit="event.preventDefault();document.getElementById('out').textContent='ORDERED';"><button type="submit">Place order</button></form>
<p id="out" role="status"></p></body>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(PAGE(/v=2/.test(req.url) ? 'v2' : 'v1'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-macros-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  const watchdog = setTimeout(async () => { console.log('FAIL  watchdog: the test took longer than 4 minutes'); try { await app.close(); } catch { /* gone */ } process.exit(1); }, 240000);
  watchdog.unref();
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const tabId = await app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 6000); });
    return t.id;
  }, `${base}/`);
  const inWeb = (code) => app.evaluate((_e, { id, code }) => global.__agent.browser.tabById(id).webContents.executeJavaScript(code), { id: tabId, code });
  const out = () => inWeb("document.getElementById('out')?.textContent || ''");
  const load = async (url) => { await app.evaluate(async (_e, { id, url }) => { const wc = global.__agent.browser.tabById(id).webContents; await wc.loadURL(url); }, { id: tabId, url }); await waitFor(() => inWeb("document.readyState === 'complete'")); };
  const settingsId = await app.evaluate((_e, s) => global.__settings.open(s), 'macros');
  const inSettings = (code) => app.evaluate((_e, { id, code }) => { try { return global.__settings.contents(id).executeJavaScript(code, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, { id: settingsId, code });
  await waitFor(() => inSettings("Boolean(document.getElementById('macro-new'))"));
  // the settings tab is in front now: the web page is still where runs and recordings go (the last web tab)
  check('the Macros page is in Settings, with its toolbar and the Record button', await inSettings("['macro-new', 'macro-record', 'macro-describe-open', 'macros-import', 'macros-export'].every((id) => document.getElementById(id))"));

  // ---- 1. record, with real input
  const click = (selector) => app.evaluate(async (_e, { id, selector }) => {
    const wc = global.__agent.browser.tabById(id).webContents;
    const r = await wc.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`);
    wc.sendInputEvent({ type: 'mouseMove', x: r[0], y: r[1] });
    wc.sendInputEvent({ type: 'mouseDown', x: r[0], y: r[1], button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: r[0], y: r[1], button: 'left', clickCount: 1 });
  }, { id: tabId, selector });
  const typeInto = (selector, text) => app.evaluate(async (_e, { id, selector, text }) => {
    const wc = global.__agent.browser.tabById(id).webContents;
    await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await wc.insertText(text);
    await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).blur()`);
  }, { id: tabId, selector, text });

  await load(`${base}/`);
  const started = await app.evaluate(() => global.__macros.startRecording());
  check('recording starts on the web page (not on Settings)', started.ok && await app.evaluate(() => global.__macros.isRecording()), JSON.stringify(started));
  await sleep(700);
  await typeInto('#q', 'red shoes');
  await sleep(500);
  await click('#go-btn');
  await sleep(500);
  await typeInto('#pw', 's3cret-p4ss');
  await sleep(700);
  check('the page did what the user did (the search ran)', (await out()) === 'Searched: red shoes', await out());
  const stopped = await app.evaluate(() => global.__macros.stopRecording());
  check('stopping returns the steps and says what was masked', stopped.ok && stopped.steps >= 4 && stopped.masked >= 1, JSON.stringify(stopped));
  const editorOpen = await waitFor(() => inSettings("!document.getElementById('macros-editor').hidden && document.querySelectorAll('#macro-steps .macro-step').length"));
  check('the draft opens in the Macros editor, to review before saving', editorOpen >= 4, String(editorOpen));
  const summary = await inSettings("[...document.querySelectorAll('#macro-steps .macro-step')].map((s) => s.dataset.type + (s.classList.contains('masked') ? '*' : '')).join()");
  check('the steps are: open the page, type, click, and a pause for the password', /^open_url,type,click,pause\*/.test(summary), summary);
  const draftText = await inSettings("JSON.stringify([...document.querySelectorAll('#macro-steps input, #macro-steps textarea')].map((i) => i.value))");
  check('what was typed in the password field is nowhere in the draft', !/s3cret/.test(draftText) && /red shoes/.test(draftText), draftText);

  // name it, turn the typed text into a variable, and save
  await inSettings(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.getElementById('macro-name'), 'Find shoes');
    const typed = [...document.querySelectorAll('#macro-steps .macro-step[data-type=type] textarea')][0];
    set(typed, '{{query}}');
    return true;
  })()`);
  check('a {{variable}} in a step is noticed and listed', /\{\{query\}\}/.test(await inSettings("document.getElementById('macro-vars').textContent")));
  await inSettings("document.getElementById('macro-save').click()");
  const saved = await waitFor(() => inSettings("document.getElementById('macros-editor').hidden && document.querySelector('#macros-list [data-macro=\"Find shoes\"]') ? document.getElementById('macros-status').textContent : ''"));
  check('saving closes the editor, lists the macro and says how to run it', /Saved/.test(saved) && /\/macro Find shoes/.test(saved), saved);
  const stored = fs.readFileSync(path.join(profile, 'macros.json'), 'utf8');
  check('the macro is stored in the profile, with no secret', /Find shoes/.test(stored) && !/s3cret/.test(stored) && /\{\{query\}\}/.test(stored));

  // ---- 2. replay it
  await load(`${base}/`);
  const run = app.evaluate((_e, name) => global.__macros.runForUser(name, { values: { query: 'blue socks' } }).then((r) => ({ ok: r.ok, message: r.message, failed: r.result?.failed })), 'Find shoes');
  const paused = await waitFor(() => app.evaluate(() => [...global.__macros.runs.values()].some((r) => r.resume)), 20000);
  check('it replays the steps and stops at the pause for the password, waiting for the user', paused && (await out()) === 'Searched: blue socks', `${paused} ${await out()}`);
  const toast = await waitFor(() => ui.evaluate(() => document.querySelector('.macro-toast.paused')?.textContent || ''));
  check('the progress toast says it is waiting for the user, with Continue and Stop', /waiting for you/.test(toast) && /Continue/.test(toast) && /Stop/.test(toast), toast);
  await ui.evaluate(() => [...document.querySelectorAll('.macro-toast button')].find((b) => b.textContent === 'Continue').click());
  const ran = await run;
  check('Continue finishes the run', ran.ok === true, JSON.stringify(ran));
  await waitFor(() => ui.evaluate(() => /done/.test(document.querySelector('.macro-toast')?.textContent || '')));
  check('the toast ends with "done"', await ui.evaluate(() => /Find shoes: done/.test(document.querySelector('.macro-toast')?.textContent || '')));

  // ---- 3. a page that changed: the test id and id are gone, the name still matches
  await app.evaluate(() => {
    const m = global.__macros.store.list().find((x) => x.name === 'Find shoes');
    global.__macros.store.save({ ...m, name: 'Find shoes v2', steps: m.steps.filter((s) => s.type !== 'pause').map((s, i) => (i === 0 ? { ...s, url: `${s.url}?v=2` } : s)) });
  });
  await load(`${base}/`);
  const v2 = await app.evaluate((_e, name) => global.__macros.runForUser(name, { values: { query: 'green hats' } }).then((r) => ({ ok: r.ok, message: r.message })), 'Find shoes v2');
  check('on a page whose markup changed the macro still finds its elements (role + name, then text)', v2.ok && (await out()) === 'Searched: green hats', `${JSON.stringify(v2)} ${await out()}`);

  // ---- 4. a step that fails: which step, why, and "Edit macro"
  await app.evaluate((_e, b) => global.__macros.store.save({ name: 'Broken', steps: [{ type: 'open_url', url: `${b}/`, target: 'current' }, { type: 'click', locator: { name: 'No such button', text: 'No such button' } }, { type: 'scroll' }] }), base);
  const failed = await app.evaluate((_e, name) => global.__macros.runForUser(name).then((r) => ({ ok: r.ok, failed: r.result?.failed, text: r.result?.text })), 'Broken');
  check('a step that cannot find its element stops the run and names the step and the reason', failed.ok === false && failed.failed?.index === 2 && /No such button/.test(failed.failed.error), JSON.stringify(failed));
  const failToast = await waitFor(() => ui.evaluate(() => document.querySelector('.macro-toast.failed')?.textContent || ''));
  check('the toast shows "step 2" with the reason and an Edit macro button', /step 2\/3/.test(failToast) && /No such button/.test(failToast) && /Edit macro/.test(failToast), failToast);
  await ui.evaluate(() => [...document.querySelectorAll('.macro-toast button')].find((b) => b.textContent === 'Edit macro').click());
  const editing = await waitFor(() => inSettings("document.getElementById('macros-editor').hidden ? '' : document.getElementById('macro-name').value"));
  check('Edit macro opens that macro in the Settings editor', editing === 'Broken', String(editing));
  await inSettings("[...document.querySelectorAll('#macros-editor button')].find((b) => b.textContent === 'Cancel').click()");

  // ---- 5. Stop
  await app.evaluate(() => global.__macros.store.save({ name: 'Slow', steps: [{ type: 'wait', mode: 'seconds', seconds: 30 }, { type: 'scroll' }] }));
  const slow = app.evaluate(() => global.__macros.runForUser('Slow').then((r) => ({ ok: r.ok, stopped: r.result?.stopped, done: r.result?.done })));
  await waitFor(() => app.evaluate(() => global.__macros.runs.size === 1));
  await ui.evaluate(() => document.querySelector('.macro-toast .macro-toast-stop')?.click());
  const slowR = await slow;
  check('Stop in the toast ends a run in progress', slowR.stopped === true && slowR.done === 0 && (await app.evaluate(() => global.__macros.runs.size)) === 0, JSON.stringify(slowR));

  // ---- 6. a keyboard shortcut
  await app.evaluate((_e, b) => global.__macros.store.save({ name: 'Shortcut run', shortcut: 'mod+shift+1', steps: [{ type: 'open_url', url: `${b}/`, target: 'current' }, { type: 'type', locator: { name: 'Search products' }, text: 'by key' }, { type: 'click', locator: { name: 'Find' } }] }), base);
  await load(`${base}/?v=2`);
  await app.evaluate((_e, mac) => global.__pageTools.handleShortcut({ key: '!', code: 'Digit1', shift: true, ...(mac ? { meta: true } : { control: true }) }), process.platform === 'darwin');
  check('a macro\'s keyboard shortcut runs it', await waitFor(async () => (await out()) === 'Searched: by key', 15000), await out());
  const conflict = await inSettings("window.lumenSettings.macros.checkShortcut('ctrl+t', null)");
  const free = await inSettings("window.lumenSettings.macros.checkShortcut('ctrl+shift+7', null)");
  const dupe = await inSettings("window.lumenSettings.macros.checkShortcut('ctrl+shift+1', null)");
  check('the Settings page validates a shortcut: one Lumen uses, one a macro has, and a free one', conflict.ok === false && /already used by Lumen/.test(conflict.error) && dupe.ok === false && /Shortcut run/.test(dupe.error) && free.ok === true, JSON.stringify([conflict, dupe, free]));

  // ---- 7. /macro in the sidebar
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await waitFor(() => ui.evaluate(() => window.slashCommands?.list().length > 3));
  check('/macro is a slash command', await ui.evaluate(() => window.slashCommands.list().some((c) => c.name === 'macro')));
  await load(`${base}/`);
  await ui.fill('#prompt', '/macro shortcut');
  await ui.press('#prompt', 'Enter');
  check('/macro <name> runs the macro (a unique piece of the name is enough)', await waitFor(async () => (await out()) === 'Searched: by key', 15000), await out());
  // a macro that needs a value asks for it in a small form
  await app.evaluate((_e, b) => global.__macros.store.save({ name: 'Ask me', steps: [{ type: 'open_url', url: `${b}/`, target: 'current' }, { type: 'type', locator: { name: 'Search products' }, text: '{{item}}' }, { type: 'click', locator: { name: 'Find' } }] }), base);
  await ui.waitForFunction(() => window.macrosApi);
  await ui.evaluate(() => window.macrosApi.menu());
  await ui.fill('#prompt', '/macro ask me');
  await ui.press('#prompt', 'Enter');
  const form = await waitFor(() => ui.evaluate(() => document.querySelector('.macro-ask input[name=item]') ? 'form' : ''));
  check('a macro with a {{variable}} asks for it before running', form === 'form');
  await ui.fill('.macro-ask input[name=item]', 'asked item');
  await ui.press('.macro-ask input[name=item]', 'Enter');
  check('and runs with what was typed', await waitFor(async () => (await out()) === 'Searched: asked item', 15000), await out());

  // ---- 8. the AI's run_macro, with its approval cards
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), tabId);
  await app.evaluate((_e, b) => global.__macros.store.save({ name: 'Order it', steps: [{ type: 'open_url', url: `${b}/`, target: 'current' }, { type: 'type', locator: { name: 'Search products' }, text: 'for the AI' }, { type: 'click', locator: { name: 'Find' } }, { type: 'click', locator: { name: 'Place order' } }] }), base);
  const listing = await app.evaluate(() => global.__agent.execute('run_macro', { list: true }));
  check('the AI\'s run_macro lists the user\'s macros by name', /Order it/.test(listing) && /Find shoes/.test(listing) && /Ask me \(variables: item\)/.test(listing), listing);
  const cards = await app.evaluate(async (_e, id) => {
    const a = global.__agent;
    const prev = { auto: a.browser.autoApprove, ask: a.askApproval };
    a.browser.autoApprove = () => false;
    global.__cards = [];
    a.askApproval = async (host, emit, signal, opts) => { global.__cards.push({ host, action: opts?.action, title: opts?.title || '' }); return true; };
    try {
      const signal = new AbortController().signal;
      const text = await a.inTask(id, signal, async () => {
        await a.ensureAllowed('run_macro', () => {}, signal, { hosts: new Set(), who: 'Claude', external: false, input: {} });
        return a.execute('run_macro', { name: 'Order it' });
      });
      return { text, cards: global.__cards };
    } finally { a.browser.autoApprove = prev.auto; a.askApproval = prev.ask; }
  }, tabId);
  check('the AI ran it: the steps happened, ending with the order', /all 4 steps/.test(cards.text) && (await out()) === 'ORDERED', `${cards.text} ${await out()}`);
  check('the AI was asked about the site (typing on a new site) and about the Place order click, by name', cards.cards.some((c) => c.action === 'interact') && cards.cards.some((c) => /macro step/.test(c.title) && /Place order/.test(c.title)), JSON.stringify(cards.cards));
  const denied = await app.evaluate(async (_e, id) => {
    const a = global.__agent;
    const prev = { auto: a.browser.autoApprove, ask: a.askApproval };
    a.browser.autoApprove = () => false;
    a.askApproval = async (host, emit, signal, opts) => !/macro step/.test(opts?.title || '');
    try {
      const signal = new AbortController().signal;
      return await a.inTask(id, signal, async () => {
        await a.ensureAllowed('run_macro', () => {}, signal, { hosts: new Set(), who: 'Claude', external: false, input: {} });
        try { return await a.execute('run_macro', { name: 'Order it' }); } catch (err) { return `ERROR ${err.message}`; }
      });
    } finally { a.browser.autoApprove = prev.auto; a.askApproval = prev.ask; }
  }, tabId);
  check('when the user says no to the order step, the macro stops there and the AI is told', /^ERROR/.test(denied) && /did not allow/.test(denied) && /step 4 of 4/.test(denied), denied);
  await load(`${base}/`);
  const ordered = await out();
  check('and nothing was ordered', ordered !== 'ORDERED', ordered);
  await app.evaluate(() => global.__macros.store.save({ name: 'Talks', steps: [{ type: 'ask_ai', prompt: 'hi' }] }));
  check('the AI cannot run a macro with an Ask AI step', /Ask AI/.test(await app.evaluate(() => global.__agent.execute('run_macro', { name: 'Talks' }))));

  // ---- 9. nothing for web pages
  const exposed = await inWeb('({ api: typeof window.macrosApi, settings: typeof window.lumenSettings, require: typeof require })');
  check('a web page has no macros API, no settings API, no Node', exposed.api === 'undefined' && exposed.settings === 'undefined' && exposed.require === 'undefined', JSON.stringify(exposed));
  const gated = await app.evaluate(() => ['list', 'menu', 'save', 'delete', 'run', 'stop', 'resume', 'edit', 'record-start', 'record-stop', 'describe', 'export', 'import-pick', 'import-text', 'import-commit', 'take-draft', 'shortcut-check', 'validate'].map((c) => `macros:${c}`).filter((c) => !global.__ipcGate.gated(c)));
  check('every macros channel is gated to Lumen\'s own UI and settings page', gated.length === 0, gated.join());

  // ---- 10. describe it (a fake model) and import/export through the page
  await app.evaluate(() => { global.__macrosComplete = async () => ({ name: 'Find a thing', description: 'Searches', steps: [{ type: 'open_url', url: 'https://example.com/', target: 'current', element_text: '', text: '', enter: false, option: '', key: '', seconds: 0, direction: 'down', action: '', prompt: '', note: '' }, { type: 'type', url: '', target: 'new', element_text: 'Search', text: '{{thing}}', enter: true, option: '', key: '', seconds: 0, direction: 'down', action: '', prompt: '', note: '' }] }); });
  await inSettings("document.getElementById('macro-describe-open').click()");
  await inSettings("(() => { const t = document.getElementById('macros-describe-text'); t.value = 'Search example.com for a thing'; document.getElementById('macros-describe-go').click(); return true; })()");
  const drafted = await waitFor(() => inSettings("!document.getElementById('macros-editor').hidden ? document.getElementById('macro-name').value + '|' + document.querySelectorAll('#macro-steps .macro-step').length : ''"));
  check('Describe it drafts steps for review (nothing is saved until Save)', drafted === 'Find a thing|2' && !(await app.evaluate(() => global.__macros.store.list().some((m) => m.name === 'Find a thing'))), String(drafted));
  await inSettings("[...document.querySelectorAll('#macros-editor button')].find((b) => b.textContent === 'Cancel').click()");
  const exported = await inSettings("window.lumenSettings.macros.list().then((l) => l.length)");
  const review = await inSettings(`(async () => { const text = ${JSON.stringify(JSON.stringify({ format: 'lumen-macros', version: 1, macros: [{ name: 'Imported one', steps: [{ type: 'open_url', url: 'https://example.com/' }] }, { name: 'Bad one', steps: [{ type: 'type', locator: { name: 'Password', inputType: 'password' }, text: 'x' }] }] }))}; const r = await window.lumenSettings.macros.importText(text); return { ok: r.ok, n: r.candidates.length, rejected: r.rejected.length, token: r.token }; })()`);
  check('importing a file only reviews it first, and refuses a secret step', review.ok && review.n === 1 && review.rejected === 1 && exported >= 5 && !(await app.evaluate(() => global.__macros.store.list().some((m) => m.name === 'Imported one'))), JSON.stringify(review));
  const committed = await inSettings(`window.lumenSettings.macros.importCommit(${JSON.stringify(review.token)}, [0])`);
  check('and committing saves what was reviewed', committed.ok && committed.added === 1 && (await app.evaluate(() => global.__macros.store.list().some((m) => m.name === 'Imported one'))), JSON.stringify(committed));

  // ---- 11. the screenshot
  await inSettings("location.reload()"); // (the macros above were saved straight into the store: the page reads the list afresh)
  await sleep(500);
  await waitFor(() => inSettings("Boolean(document.getElementById('macros-list'))"));
  await waitFor(() => inSettings("document.querySelectorAll('#macros-list .macro-row').length >= 5"));
  check('a page opened later does not get a stale draft', await inSettings("document.getElementById('macros-editor').hidden"));
  await sleep(1200); // (the page fades in)
  const shot = process.env.MACROS_SHOT || path.join(os.tmpdir(), 'lumen-macros-settings.png');
  const shotList = await app.evaluate(async (_e, id) => {
    const wc = global.__settings.contents(id);
    const size = await wc.executeJavaScript('({ w: innerWidth, h: innerHeight })');
    const img = await wc.capturePage();
    return { png: img.toPNG().toString('base64'), size, shot: img.getSize() };
  }, settingsId);
  fs.writeFileSync(shot, Buffer.from(shotList.png, 'base64'));
  check('a screenshot of the Macros settings page was saved', fs.statSync(shot).size > 15000, `${shot} ${fs.statSync(shot).size} bytes ${JSON.stringify(shotList.size)}`);
  // the editor, with the recorded steps
  await inSettings("[...document.querySelectorAll('#macros-list button')].find((b) => b.getAttribute('aria-label') === 'Edit Find shoes v2').click()");
  await waitFor(() => inSettings("!document.getElementById('macros-editor').hidden"));
  await sleep(800);
  const shot2 = shot.replace(/\.png$/, '-editor.png');
  const editorShot = await app.evaluate(async (_e, id) => (await global.__settings.contents(id).capturePage()).toPNG().toString('base64'), settingsId);
  fs.writeFileSync(shot2, Buffer.from(editorShot, 'base64'));
  console.log(`screenshots: ${shot} ${shot2}`);

  check('no page errors in the window', errors.length === 0, errors.join(' | '));
  clearTimeout(watchdog);
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
