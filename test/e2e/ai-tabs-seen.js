// [ai tabs] An AI tab the user has been to, or one the AI's reply names ([[tab:ID]]), stays in sight (main.js aiTabShown, app.js render):
//  1. after a run that opened three tabs and named one, the folded label of the chat's AI tabs ("AI · <chat>") shows the named tab beside it, and not the other two;
//  2. a tab the user switched to (a real click in the strip) stays beside the folded label after they switch away;
//  3. with "Hide tabs the AI opened" on, those two stay in the strip and the third is left out.
// Real Lumen, throwaway profile, a fake model (no network, no key), local pages, hidden windows (LUMEN_TEST_BACKGROUND=1).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(150); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${req.url}</title><h1>PAGE ${req.url}</h1>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ai-tabs-seen-'));
  const missing = path.join(profile, 'no-such-cli.exe');
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: missing, LUMEN_CODEX_BIN: missing, LUMEN_GROK_BIN: missing, LUMEN_AGY_BIN: missing },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__patchSettings({ sidebarNewChat: false, closeAiTabs: 'off', aiTabsTidy: false, hideAiTabs: false, groupAiTabs: true }));

    // The fake model: opens three tabs in the background, one per turn, then answers with a chip for the second one.
    await app.evaluate((_e, urls) => {
      const reply = (content, stop) => {
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 50, output_tokens: 10 } };
        return { async *[Symbol.asyncIterator]() { for (const [index, b] of content.entries()) if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; }, finalMessage: async () => message };
      };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const step = (params.messages || []).filter((m) => m.role === 'assistant').length;
        if (step < urls.length) return reply([{ type: 'tool_use', id: `open-${step}`, name: 'open_tab', input: { url: urls[step], background: true } }], 'tool_use');
        const named = global.__agent.browser.listTabs().find((t) => t.url === urls[1]);
        return reply([{ type: 'text', text: `The second one is here: [[tab:${named?.id}]]` }], 'end_turn');
      } } } });
    }, [`${base}/a`, `${base}/b`, `${base}/c`]);

    const list = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, url: t.url, group: t.group, active: t.active })));
    const strip = () => ui.evaluate(() => [...document.querySelectorAll('#tabs .tab:not(.tab-ghost), #tabs .group-label')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => (el.classList.contains('group-label') ? `G:${el.classList.contains('collapsed') ? 'folded' : 'open'}` : Number(el.dataset.id))));
    const first = (await list())[0].id;

    await ui.evaluate(() => window.browser?.openSidebar?.());
    await ui.fill('#prompt', 'Open three pages and tell me which one matters');
    await ui.press('#prompt', 'Enter');
    const opened = await waitFor(async () => { const l = await list(); return l.filter((t) => t.url.startsWith(base)).length === 3 && l; });
    const idOf = (l, p) => l.find((t) => t.url === `${base}${p}`)?.id;
    const [A, B, C] = ['/a', '/b', '/c'].map((p) => idOf(opened || [], p));
    check('the run opened three tabs in the chat group ("AI · Open three pages and…")', A && B && C && (opened || []).filter((t) => t.group === 'AI · Open three pages and…').length === 3, JSON.stringify(opened));
    await waitFor(() => ui.evaluate(() => /second one is here/.test(document.querySelector('#messages')?.textContent || '')));
    await sleep(800);
    // The user's own tab is in front (the run worked in the background).
    if ((await list()).find((t) => t.active)?.id !== first) await ui.click(`#tabs .tab[data-id="${first}"]`);
    await sleep(500);

    let s = await strip();
    check('(1) the folded AI tabs label shows the tab the reply named beside it', s.includes('G:folded') && s.includes(B), JSON.stringify(s));
    check('(1) and not the tabs it only opened', !s.includes(A) && !s.includes(C), JSON.stringify(s));

    // 2. The user opens the group, goes to A with a click, comes back to their own tab and folds the group again.
    await ui.click('#tabs .group-label');
    await waitFor(async () => (await strip()).includes(A));
    await ui.click(`#tabs .tab[data-id="${A}"]`);
    await waitFor(async () => (await list()).find((t) => t.active)?.id === A);
    await ui.click(`#tabs .tab[data-id="${first}"]`);
    await waitFor(async () => (await list()).find((t) => t.active)?.id === first);
    await ui.click('#tabs .group-label');
    await sleep(600);
    s = await strip();
    check('(2) a tab the user went to stays beside the folded label after they switch away', s.includes('G:folded') && s.includes(A) && s.includes(B) && !s.includes(C), JSON.stringify(s));

    // 3. Hide tabs the AI opened: the two in sight stay, the third is left out.
    await app.evaluate(() => global.__patchSettings({ hideAiTabs: true }));
    await waitFor(() => ui.evaluate(() => window.lumenHideAiTabs === true), 5000);
    await sleep(600);
    s = await strip();
    check('(3) with "Hide tabs the AI opened" on, the tabs you went to or the AI named stay in the strip', s.includes(A) && s.includes(B), JSON.stringify(s));
    check('(3) and the one it only opened is left out', !s.includes(C), JSON.stringify(s));
    const hiddenMain = await app.evaluate(() => global.__agent.browser.listTabs().length);
    check('(3) every tab is still open', hiddenMain >= 4, hiddenMain);

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite ran to its end  -> ${err && err.stack}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
