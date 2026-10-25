// The AI's close_tab never asks and never pauses the run (agent.js closeDecisionFor, ai-manners.js closeDecision): the user's tab under hands-off mode is
// refused in plain words, a tab with typed text or a "Leave site?" page is left open and the AI is told, a clean tab closes; no approval card, ever.
// A scripted provider (no network, no key) drives it against local fake pages on 127.0.0.1. Run with LUMEN_TEST_BACKGROUND=1.
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
      '/guarded': '<!doctype html><title>Guarded Page</title><body>nothing typed<script>onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ""; };</script></body>',
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

    const noCard = () => ui.evaluate(() => document.querySelectorAll('.approval-tool').length === 0);
    const gmail = await openUser(`${base}/gmail`);
    const front = await openUser(`${base}/other`); // the tab the user is on
    check('the fake mail tab is open, and is the user\'s (not marked as the AI\'s)', (await isOpen(gmail)) && !(await app.evaluate((_e, i) => global.__agent.browser.isAiTab(i), gmail)));

    // 1. Hands-off mode, the user's tab: refused in plain words, no card, the run carries on and ends by itself.
    await ask([[gmail]]);
    check('hands-off, user tab: the run ends on its own (it is never waiting on the user)', await ended());
    check('hands-off, user tab: no approval card was shown', await noCard());
    check('hands-off, user tab: the tab is still open and the AI was told so', (await isOpen(gmail)) && /still open/.test(await app.evaluate(() => global.__results.join('\n'))));

    // 2. Unsaved text (and the page asks "Leave site?"): left open, no card, no dialog, the run ends on its own.
    await app.evaluate(() => global.__settings.backend.set('aiHandsOff', false));
    const draft = await openUser(`${base}/draft`);
    await app.evaluate(async ({ webContents }, id) => { const t = global.__agent.browser.tabById(id); await webContents.fromId(t.webContents.id).executeJavaScript('(() => { const t = document.getElementById("t"); t.focus(); t.value = "Dear team, the draft I am typing"; t.dispatchEvent(new Event("input", { bubbles: true })); })()'); }, draft);
    await ask([[draft], [gmail]]);
    check('unsaved text: the run does not stop for an approval, it goes on to the next step and ends', await ended());
    check('unsaved text: no approval card', await noCard());
    check('unsaved text: the tab is still open', await isOpen(draft));
    const results = await app.evaluate(() => global.__results.join('\n'));
    check('unsaved text: the AI is told "Left <title> open: it has unsaved text" and the next close (a clean tab) went ahead', /Left "Compose - Draft Mail" open: it has unsaved text/.test(results) && /Closed tab/.test(results) && !(await isOpen(gmail)), results);

    // 3. A page that asks "Leave site?" with nothing typed: kept open too, never asked.
    const guarded = await openUser(`${base}/guarded`);
    await ask([[guarded]]);
    check('"Leave site?" page: the run ends on its own, no card, the tab stays open', (await ended()) && (await noCard()) && (await isOpen(guarded)));
    check('"Leave site?" page: the AI is told it was left open', /Left .* open/.test(await app.evaluate(() => global.__results.join('\n'))), await app.evaluate(() => global.__results.join('\n')));

    // 4. A tab the AI opened with nothing in it closes as before.
    const mine = await app.evaluate(async () => { const t = global.__agent.browser.openTab('about:blank', { background: true }); return t.id; });
    await ask([[mine]]);
    check('a blank tab closes with no card', (await ended()) && (await noCard()) && !(await isOpen(mine)));

    check('no card is left waiting', (await cardsLeft()) === 0);
    void front;
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
