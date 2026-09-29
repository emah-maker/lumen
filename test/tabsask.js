// Ask across open tabs: "@" in the composer opens a picker of this window's tabs, the picks become
// chips, and on send each tab's text goes with the message (labelled, read where the tab is, without
// switching to it). The AI's read_tabs tool reads several tabs in one call. Private-window tabs are
// never offered. A fake provider captures what the model is sent; no API tokens, hidden windows.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const name = req.url.slice(1) || 'root';
    if (name === 'long') return res.end(`<title>Long read</title><body>${'<p>marker-long filler sentence for the cap. </p>'.repeat(1200)}</body>`);
    res.end(`<title>Page ${name}</title><h1>${name}</h1><p>marker-${name} is what this page says.</p>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabsask-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // Fake Claude: records the last user turn.
  await app.evaluate(() => {
    global.__sent = [];
    global.__agent.browser.effectiveModel = (m) => m;
    global.__agent.getClient = () => ({
      beta: { messages: { stream: (params) => {
        const last = params.messages[params.messages.length - 1];
        global.__sent.push(last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
        const message = { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' };
        return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
      } } },
    });
    global.__agent.reset();
    global.__agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
  });
  const openTab = (name) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => (t.webContents.isLoading() ? t.webContents.once('did-finish-load', r) : r()));
    return t.id;
  }, `${base}/${name}`);
  const active = () => app.evaluate(() => global.__agent.browser.listTabs().find((t) => t.active)?.id);
  const lastSent = () => app.evaluate(() => global.__sent[global.__sent.length - 1] || '');
  const runEnded = () => ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('.msg.user').length > 0, null, { timeout: 10000 });
  const pickerOpen = () => ui.waitForSelector('#tabs-picker:not([hidden]) .tabs-opt', { timeout: 5000 });
  const rowsNow = () => ui.evaluate(() => [...document.querySelectorAll('#tabs-picker .tabs-opt')].map((r) => r.textContent));
  const chipsNow = () => ui.evaluate(() => [...document.querySelectorAll('#tab-chips .tab-chip-name')].map((c) => c.textContent));

  const first = await app.evaluate(() => global.__agent.browser.listTabs()[0].id);
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}/alpha`);
  const beta = await openTab('beta');
  const gamma = await openTab('gamma');
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(900);

  // A private window with a tab: never offered.
  await app.evaluate((_e, u) => global.__private.open(u), `${base}/secret`);
  await sleep(1200);
  const offered = await ui.evaluate(() => window.assistant.askTabs());
  check('the picker\'s list has this window\'s three tabs, with title and host', offered.length === 3 && offered.every((t) => t.title && t.host === '127.0.0.1'), JSON.stringify(offered));
  check('a private-window tab is not offered', !offered.some((t) => /secret/.test(t.title)), JSON.stringify(offered));

  // "@" opens the picker; typing filters; keyboard picks.
  await ui.click('#prompt');
  await ui.keyboard.type('@');
  await pickerOpen();
  let rows = await rowsNow();
  check('@ lists this tab, all tabs and each tab', rows.length >= 5 && /this tab/i.test(rows[0]) && /all tabs/i.test(rows[1]) && rows.some((r) => /Page alpha/.test(r)) && rows.some((r) => /Page beta/.test(r)) && rows.some((r) => /Page gamma/.test(r)), JSON.stringify(rows));
  const a11y = await ui.evaluate(() => ({ role: document.getElementById('prompt').getAttribute('role'), list: document.getElementById('tabs-picker').getAttribute('role'), opt: document.querySelector('.tabs-opt').getAttribute('role'), active: document.getElementById('prompt').getAttribute('aria-activedescendant'), sel: document.querySelectorAll('.tabs-opt[aria-selected="true"]').length }));
  check('the picker is a listbox with aria-activedescendant on the composer', a11y.role === 'combobox' && a11y.list === 'listbox' && a11y.opt === 'option' && a11y.active === 'tabs-opt-0' && a11y.sel === 1, JSON.stringify(a11y));
  await ui.keyboard.type('bet');
  await sleep(300);
  rows = await rowsNow();
  check('typing filters the list', rows.length === 1 && /Page beta/.test(rows[0]), JSON.stringify(rows));
  await ui.keyboard.press('Enter');
  await sleep(200);
  check('Enter picks the tab as a chip (and does not send)', JSON.stringify(await chipsNow()) === '["@Page beta"]' && (await ui.evaluate(() => document.querySelectorAll('.msg.user').length)) === 0 && (await ui.inputValue('#prompt')) === '', `${JSON.stringify(await chipsNow())} ${await ui.inputValue('#prompt')}`);
  check('the picker closed', await ui.evaluate(() => document.getElementById('tabs-picker').hidden && document.getElementById('prompt').getAttribute('aria-expanded') !== 'true'), '');

  // Send with the chip: the tab's text arrives labelled, and the active tab does not change.
  const before = await active();
  await ui.keyboard.type('what does it say?');
  await ui.keyboard.press('Enter');
  await runEnded();
  let sent = await lastSent();
  check('the chosen tab\'s text is attached with its label', /\[Tab: Page beta — 127\.0\.0\.1:\d+\]/.test(sent) && sent.includes('marker-beta'), sent.slice(0, 400));
  check('other tabs are not attached', !sent.includes('marker-alpha') && !sent.includes('marker-secret'), sent.slice(0, 600));
  check('the block is wrapped as untrusted page content and the question follows', /<untrusted_page_content tabs="1">/.test(sent) && sent.trim().endsWith('what does it say?'), sent.slice(-200));
  check('reading it did not switch tabs', (await active()) === before && before === gamma, `${before} ${await active()}`);
  const bubble = await ui.evaluate(() => document.querySelector('.msg.user .msg-tabs')?.textContent);
  check('the bubble says what was attached', /1 tab attached: Page beta/.test(bubble || ''), bubble);
  check('the chip is gone after sending', (await chipsNow()).length === 0, '');

  // @all tabs attaches every tab of this window, not the private one.
  await ui.click('#prompt');
  await ui.keyboard.type('@all');
  await pickerOpen();
  await ui.keyboard.press('Enter');
  await sleep(200);
  check('all tabs becomes one chip', JSON.stringify(await chipsNow()) === '["@all tabs"]', JSON.stringify(await chipsNow()));
  await ui.keyboard.type('compare');
  await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.querySelectorAll('.msg.user').length === 2 && !document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 });
  sent = await lastSent();
  check('@all tabs attaches alpha, beta and gamma with labels', ['alpha', 'beta', 'gamma'].every((n) => sent.includes(`marker-${n}`) && sent.includes(`[Tab: Page ${n} — `)) && /tabs="3"/.test(sent), sent.slice(0, 300));
  check('and never the private window\'s tab', !sent.includes('marker-secret'), '');
  check('the bubble counts them', /3 tabs attached/.test(await ui.evaluate(() => [...document.querySelectorAll('.msg.user .msg-tabs')].pop()?.textContent || '')), '');

  // A chip comes off with Backspace in the empty composer.
  await ui.click('#prompt');
  await ui.keyboard.type('@this');
  await pickerOpen();
  await ui.keyboard.press('Enter');
  await sleep(150);
  check('this tab makes a chip', JSON.stringify(await chipsNow()) === '["@this tab"]', JSON.stringify(await chipsNow()));
  await ui.keyboard.press('Backspace');
  check('Backspace in the empty composer removes the last chip', (await chipsNow()).length === 0, JSON.stringify(await chipsNow()));

  // A sleeping tab is sent by address only, and says so.
  await app.evaluate((_e, id) => global.__tabSleep.sleep(id), beta);
  await sleep(300);
  const asleep = await ui.evaluate(() => window.assistant.askTabs());
  check('a sleeping tab is still offered, marked asleep', asleep.find((t) => /beta/.test(t.title || t.host))?.sleeping === true || asleep.some((t) => t.sleeping), JSON.stringify(asleep));
  await ui.click('#prompt');
  await ui.keyboard.type('@beta');
  await pickerOpen();
  await ui.keyboard.press('Enter');
  await ui.keyboard.type('and this one?');
  await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.querySelectorAll('.msg.user').length === 3 && !document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 });
  sent = await lastSent();
  check('a sleeping tab: only its address, and the model is told it is asleep', /asleep/.test(sent) && !sent.includes('marker-beta') && /127\.0\.0\.1:\d+\/beta/.test(sent), sent.slice(0, 400));
  const bubble3 = await ui.evaluate(() => [...document.querySelectorAll('.msg.user .msg-tabs')].pop()?.textContent || '');
  check('and the bubble does not count it as read', /0 tabs attached/.test(bubble3) && /1 not read/.test(bubble3), bubble3);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), gamma); // wakes nothing else; beta wakes when used
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), beta);
  await sleep(1200);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), gamma);

  // Long pages are cut to the per-tab cap and say so.
  const long = await openTab('long');
  await ui.click('#prompt');
  await ui.keyboard.type('@long');
  await pickerOpen();
  await ui.keyboard.press('Enter');
  await ui.keyboard.type('summarize');
  await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => document.querySelectorAll('.msg.user').length === 4 && !document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 });
  sent = await lastSent();
  const longBlock = sent.slice(sent.indexOf('[Tab: Long read'));
  check('a long tab is cut, with the note', /\[cut: showing the first 6000 of \d+ characters/.test(sent), sent.slice(0, 200));
  check('the cut keeps the message small', longBlock.length < 6000 + 2500, String(longBlock.length));

  // read_tabs: several tabs in one call, compact, same window only.
  const frontBefore = await active();
  const result = await app.evaluate(async (_e, ids) => {
    const agent = global.__agent;
    const signal = new AbortController().signal;
    const chat = [];
    const text = await agent.inTask(ids[0], signal, async () => {
      await agent.ensureAllowed('read_tabs', () => {}, signal, { input: { ids: ids.slice(0, 3) }, run: chat });
      return agent.execute('read_tabs', { ids: [...ids, 424242] });
    }, chat);
    return { text, tainted: chat.tainted === true, active: agent.browser.listTabs().find((t) => t.active)?.id };
  }, [first, beta, gamma]);
  check('read_tabs returns each tab under its label', ['alpha', 'beta', 'gamma'].every((n) => result.text.includes(`[Tab: Page ${n} — `)), result.text.slice(0, 300));
  check('read_tabs: text of the readable tabs, compact', result.text.includes('marker-alpha') && result.text.includes('marker-gamma') && result.text.length < 3000, String(result.text.length));
  check('read_tabs: a tab id of no tab in this window is named, not read', /no open tab of this window has that id/.test(result.text), result.text.slice(-200));
  check('read_tabs: wrapped as untrusted content and taints the run', result.text.startsWith('<untrusted_page_content>') && result.tainted, JSON.stringify({ tainted: result.tainted, head: result.text.slice(0, 40) }));
  check('read_tabs does not switch tabs', result.active === frontBefore && frontBefore === long, `${result.active} ${frontBefore} ${long}`);
  const privateId = await app.evaluate(() => global.__private.list()[0].tabs[0].id);
  const priv = await app.evaluate(async (_e, ids) => {
    const agent = global.__agent;
    return agent.inTask(ids[0], new AbortController().signal, () => agent.execute('read_tabs', { ids: [ids[1]] }));
  }, [first, privateId]);
  check('read_tabs: never a private window\'s tab', !priv.includes('marker-secret'), priv.slice(0, 300));

  // More than 8 tabs: "@all tabs" asks once per chat.
  for (let i = 0; i < 7; i++) await openTab(`extra${i}`);
  await sleep(400);
  await ui.click('#prompt');
  await ui.keyboard.type('@all');
  await pickerOpen();
  await ui.keyboard.press('Enter');
  await sleep(200);
  const confirmShown = await ui.evaluate(() => ({ hidden: document.getElementById('tabs-confirm').hidden, text: document.getElementById('tabs-confirm').textContent }));
  check('@all tabs over 8 tabs asks first, with the count', !confirmShown.hidden && /\d+ open tabs/.test(confirmShown.text) && (await chipsNow()).length === 0, JSON.stringify(confirmShown));
  await ui.click('#tabs-confirm .btn.primary');
  await sleep(200);
  check('confirming adds the chip', JSON.stringify(await chipsNow()) === '["@all tabs"]', JSON.stringify(await chipsNow()));
  await ui.click('#tab-chips .tab-chip-remove');
  await ui.click('#prompt');
  await ui.keyboard.type('@all');
  await pickerOpen();
  await ui.keyboard.press('Enter');
  await sleep(200);
  check('it asks only once per chat', (await ui.evaluate(() => document.getElementById('tabs-confirm').hidden)) && JSON.stringify(await chipsNow()) === '["@all tabs"]', JSON.stringify(await chipsNow()));
  await ui.click('#tab-chips .tab-chip-remove');

  // The empty sidebar's quick actions attach all tabs (New chat brings the empty state back, and the confirm again).
  await ui.click('#new-chat');
  await sleep(300);
  const quick = await ui.evaluate(() => [...document.querySelectorAll('.chip[data-all-tabs]')].map((c) => c.textContent));
  check('the empty sidebar offers "Summarize my open tabs" and "Compare these tabs"', quick.includes('Summarize my open tabs') && quick.includes('Compare these tabs'), JSON.stringify(quick));
  await app.evaluate(() => { global.__closeExtras = true; });
  for (const id of await app.evaluate(() => global.__agent.browser.listTabs().filter((t) => /extra\d/.test(t.url)).map((t) => t.id))) await app.evaluate((_e, i) => global.__agent.browser.closeTab(i), id);
  await sleep(400);
  await ui.click('.chip[data-all-tabs] >> nth=0');
  await ui.waitForFunction(() => document.querySelectorAll('.msg.user').length === 1 && !document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 });
  sent = await lastSent();
  check('the quick action sends every open tab with the request', /Summarize my open tabs\.\s*$/.test(sent.trim()) && /tabs="\d+"/.test(sent) && sent.includes('marker-alpha') && sent.includes('marker-gamma'), sent.slice(0, 300));

  // The full-page chat shares the composer: the picker's tabs are there too, without its own tab.
  await app.evaluate(() => global.__chatPage.open());
  await sleep(1500);
  const page = await app.evaluate(async () => {
    const info = global.__chatPage.tabs().find((t) => t.chat);
    const wc = info && global.__chatPage.contents(info.id);
    if (!wc) return null;
    return wc.executeJavaScript(`(async () => ({ has: Boolean(window.tabsAsk), list: (await window.assistant.askTabs()).map((t) => t.title), chip: Boolean(document.querySelector('.chip[data-all-tabs]')) }))()`);
  });
  check('the full-page chat has the picker and the quick actions, listing web tabs only', page?.has === true && page.chip === true && page.list.length >= 3 && page.list.every((t) => !/chat/i.test(t)), JSON.stringify(page));

  check('no UI errors', errors.length === 0, errors.join('; '));
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
