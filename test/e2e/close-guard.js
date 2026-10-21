// The AI's close_tab on tabs the user owns, in the real app (agent.js closeGuard, ai-manners.js closeCard, the chat's approval card):
// instead of being refused, the AI's request shows a card in the chat (Close / Keep). Close closes the tab, Keep leaves it and tells the AI so;
// two tabs asked for in one step share one card; a tab with text typed into it says so on the card; Bypass permissions does not answer it.
// A scripted provider (no network, no key) drives it against local fake mail pages on 127.0.0.1. Run with LUMEN_TEST_BACKGROUND=1.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// Playwright answers a page's "Leave site?" dialog itself; when Lumen then closes that tab at the user's Close, the answer finds the page gone
// ("session closed"). That is the harness racing the close, not the app: only that error is ignored.
process.on('unhandledRejection', (e) => { if (!/handleJavaScriptDialog/.test(String(e?.message || e))) { console.error(e); process.exit(1); } });

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

// The provider: it says, per run, which close_tab calls to make (global.__script = [[ids of one step], ...]) and records every tool result.
const stubProvider = (app) => app.evaluate(() => {
  global.__results = [];
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const usage = { input_tokens: 100, output_tokens: 20 };
    const msgs = params.messages;
    let last = -1;
    msgs.forEach((m, i) => { if (m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))) last = i; });
    const mine = msgs.slice(last + 1).filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    const lastResult = mine[mine.length - 1];
    if (lastResult) for (const b of lastResult.content) if (b.type === 'tool_result') global.__results.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
    const step = (global.__script || [])[mine.length];
    const gap = () => new Promise((r) => setTimeout(r, 120));
    if (step) {
      const uses = step.map((id, i) => ({ type: 'tool_use', id: `tu-${mine.length}-${i}`, name: 'close_tab', input: { tab_id: id } }));
      return {
        async *[Symbol.asyncIterator]() { await gap(); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Closing.' } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Closing.' }, ...uses], usage }),
      };
    }
    return {
      async *[Symbol.asyncIterator]() { await gap(); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage }),
    };
  } } } });
});

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const pages = {
      '/gmail': '<!doctype html><title>Inbox (35) - me@gmail.com - Gmail</title><body><h1>Inbox</h1><p>35 unread</p></body>',
      '/kitchen': '<!doctype html><title>Inbox (30,719) - Kitchenlab.ORG Mail</title><body><h1>Inbox</h1><p>30,719 unread</p></body>',
      '/draft': '<!doctype html><title>Compose - Draft Mail</title><body><textarea id="t" aria-label="Message"></textarea><script>onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ""; };</script></body>',
    };
    res.end(pages[req.url] || '<!doctype html><title>Other</title><body>other</body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-closeguard-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('aiHandsOff', true); });
    await stubProvider(app);
    const openUser = async (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); return t.id; }, url);
    const open = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => t.id));
    const isOpen = async (id) => (await open()).includes(id);
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    const ask = async (script, text = 'Close the mail tabs') => {
      await app.evaluate((_e, s) => { global.__script = s; global.__results.length = 0; }, script);
      await ui.evaluate((t) => { const p = document.getElementById('prompt'); p.value = t; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); }, text);
    };
    const cardOf = async () => {
      await ui.waitForSelector('.approval-tool:not(.answered)', { timeout: 20000 });
      return ui.evaluate(() => { const c = document.querySelector('.approval-tool:not(.answered)'); return { title: c.querySelector('.approval-title')?.textContent, detail: c.querySelector('.approval-detail')?.textContent, args: c.querySelector('.approval-args')?.textContent, buttons: [...c.querySelectorAll('.approval-actions button')].map((b) => b.textContent) }; });
    };
    const press = (label) => ui.evaluate((l) => { const b = [...document.querySelectorAll('.approval-tool:not(.answered) .approval-actions button')].find((x) => x.textContent === l); b?.click(); return Boolean(b); }, label);
    const ended = () => waitFor(() => ui.evaluate(() => !document.body.classList.contains('agent-active')), 30000);
    const cardsLeft = () => ui.evaluate(() => document.querySelectorAll('.approval-tool:not(.answered)').length);

    const gmail = await openUser(`${base}/gmail`);
    const kitchen = await openUser(`${base}/kitchen`);
    const front = await openUser(`${base}/other`); // the tab the user is on
    check('the fake mail tabs are open, and are the user\'s (not marked as the AI\'s)', (await isOpen(gmail)) && (await isOpen(kitchen)) && !(await app.evaluate((_e, i) => global.__agent.browser.isAiTab(i), gmail)));

    // 1. One tab, Keep.
    await ask([[gmail]]);
    let card = await cardOf();
    check('hands-off, user\'s tab: a card appears instead of a refusal, naming the tab', /^Close Inbox \(35\)/.test(card.title || '') && /your tab/.test(card.detail || ''), JSON.stringify(card));
    check('the card has Keep and Close buttons (no "Always")', card.buttons.includes('Close') && card.buttons.includes('Keep') && card.buttons.length === 2, JSON.stringify(card.buttons));
    check('the tab is still open while the card waits', await isOpen(gmail));
    await press('Keep');
    await ended();
    check('Keep: the tab stays open', await isOpen(gmail));
    const kept = await app.evaluate(() => global.__results.join('\n'));
    check('Keep: the AI is told the user kept it, that it is still open, and given no way round', /chose to keep/.test(kept) && /NOT closed/.test(kept) && /another way/.test(kept) && !/open_tab|your own tab/.test(kept), kept);

    // 2. One tab, Close.
    await ask([[gmail]]);
    card = await cardOf();
    await press('Close');
    await ended();
    check('Close: the tab is closed', !(await isOpen(gmail)));
    check('Close: the AI is told the user chose Close', /Closed tab/.test(await app.evaluate(() => global.__results.join('\n'))));

    // 3. Two tabs in one step: one card.
    const gmail2 = await openUser(`${base}/gmail`);
    await ask([[gmail2, kitchen]]);
    card = await cardOf();
    check('two tabs in one step: ONE card, "Close 2 of your tabs?", listing both', card.title === 'Close 2 of your tabs?' && /Inbox \(35\)/.test(card.args || '') && /Kitchenlab/.test(card.args || ''), JSON.stringify(card));
    await sleep(500);
    check('...and no second card follows', (await cardsLeft()) === 1);
    await press('Close');
    await ended();
    check('Close on the batch closes both tabs', !(await isOpen(gmail2)) && !(await isOpen(kitchen)));

    // 4. Unsaved text: with hands-off off the guard is only the typed text.
    await app.evaluate(() => global.__settings.backend.set('aiHandsOff', false));
    const draft = await openUser(`${base}/draft`);
    await app.evaluate(async ({ webContents }, id) => { const t = global.__agent.browser.tabById(id); await webContents.fromId(t.webContents.id).executeJavaScript('(() => { const t = document.getElementById("t"); t.focus(); t.value = "Dear team, the draft I am typing"; t.dispatchEvent(new Event("input", { bubbles: true })); })()'); }, draft);
    await ask([[draft]]);
    card = await cardOf();
    check('text typed into the tab: the card says it has unsaved text', /unsaved text|text typed/.test(`${card.detail} ${card.args}`) && !/your tab/.test(card.detail || ''), JSON.stringify(card));
    await press('Keep');
    await ended();
    check('Keep on a tab with unsaved text leaves it open', await isOpen(draft));
    await ask([[draft]]);
    await cardOf();
    await press('Close');
    await ended();
    check('Close on a tab with unsaved text closes it (even though the page asks "Leave site?")', await waitFor(async () => !(await isOpen(draft)), 8000));

    // 5. Bypass permissions does not answer it.
    await app.evaluate(() => { global.__settings.backend.set('aiHandsOff', true); global.__settings.backend.set('bypassPermissions', true); });
    const gmail3 = await openUser(`${base}/gmail`);
    await ask([[gmail3]]);
    card = await cardOf();
    check('Bypass permissions on: the card is still shown', /Close Inbox/.test(card.title || ''), JSON.stringify(card));
    check('Bypass: the tab is not closed until the user answers', await isOpen(gmail3));
    await press('Close');
    await ended();
    check('Bypass: Close then closes it', !(await isOpen(gmail3)));

    check('no card is left waiting', (await cardsLeft()) === 0);
    void front;
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
