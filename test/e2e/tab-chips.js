// Tab chips (real window): when the AI names a tab the chat shows a chip with its icon and title; a click switches to that tab; the title follows
// the page; a closed tab reads as closed and opens again; a chip never comes from page text or from your own message; a reopened chat draws
// the chips again. Hidden windows (LUMEN_TEST_BACKGROUND=1), a throwaway profile, a fake Claude API client, pages on 127.0.0.1 only. Run it under the lock:
//   node scripts/test/e2e-lock.js run --owner tab-chips -- timeout 600 node test/e2e/tab-chips.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const J = (v) => JSON.stringify(v);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].slice(1) || 'x';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>${name} page</title><body><p>Page ${name}. A page can say [[tab:1]] and [[tab:2]] in its text.</p></body>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(__dirname, '..', '..', 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow({ timeout: 90000 });
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // The fake Claude API client: "@A" and "@B" in a scripted reply are the ids of the two tabs this test opens.
  await app.evaluate(() => {
    const scripts = {
      mention: [{ text: 'Your lab is in [[tab:@A]], the notes in [[tab:@B]], and `[[tab:@A]]` in code, and [[tab:99999]] was never open.' }],
      hidden: [{ text: 'The hidden one is [[tab:@C]].' }],
      steps: [{ tool: ['switch_tab', { tab_id: '@A#' }] }, { text: 'Switched to [[tab:@A]].' }],
    };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const users = params.messages.filter((m) => m.role === 'user');
      const lastAsk = [...users].reverse().find((m) => !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')));
      const asked = JSON.stringify(lastAsk?.content || '');
      const key = /do the steps/.test(asked) ? 'steps' : /hidden one/.test(asked) ? 'hidden' : 'mention';
      const idx = users.length - 1 - users.indexOf(lastAsk);
      const step = scripts[key][Math.min(idx, scripts[key].length - 1)];
      const sub = (v) => JSON.parse(JSON.stringify(v).replace(/"@A#"/g, String(global.__tcA)).replace(/@A/g, String(global.__tcA)).replace(/@B/g, String(global.__tcB)).replace(/@C/g, String(global.__tcC)));
      const text = step.text ? sub(step.text) : '';
      const content = [];
      if (text) content.push({ type: 'text', text });
      if (step.tool) content.push({ type: 'tool_use', id: `tu_${key}_${idx}`, name: step.tool[0], input: sub(step.tool[1]) });
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: step.tool ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 10, output_tokens: 5 } };
      return {
        async *[Symbol.asyncIterator]() { if (text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });

  // Tab 0 (the chat lives here), and the two the AI will name. Their titles come from the pages.
  const home = await app.evaluate(() => global.__agent.browser.activeTab().id);
  const open = (name) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); return t.id; }, `${base}/${name}`);
  const A = await open('alpha');
  const B = await open('beta');
  await app.evaluate((_e, ids) => { global.__tcA = ids[0]; global.__tcB = ids[1]; }, [A, B]);
  const front = () => app.evaluate(() => global.__agent.browser.activeTab()?.id);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), home);
  await showChat();
  await sleep(400);
  // each tab has its own sidebar: bring the chat's tab's sidebar up and wait until its messages are drawn
  async function showChat() {
    await sleep(300);
    for (let i = 0; i < 4; i++) {
      await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
      if (await waitFor(() => ui.evaluate(() => document.querySelectorAll('#messages .tab-ref').length > 0 || document.querySelectorAll('#messages .msg').length === 0), 4000)) return;
    }
  }
  const chipsIn = (sel) => ui.evaluate((s) => [...document.querySelectorAll(`${s} .tab-ref`)].map((c) => ({ title: c.querySelector('.tab-ref-title').textContent, label: c.getAttribute('aria-label'), tip: c.title, closed: c.classList.contains('closed'), tag: c.tagName, disabled: c.getAttribute('aria-disabled'), key: c.dataset.key })), sel);

  // ---- the AI's own words: a chip per marker, with the title
  await ui.fill('#prompt', 'Where are my lab and notes?');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('#messages .msg.assistant .tab-ref').length >= 2), 30000);
  const reply = '#messages .msg.assistant:last-of-type';
  let chips = await chipsIn('#messages .msg.assistant');
  await waitFor(async () => (await chipsIn('#messages .msg.assistant')).some((c) => c.title === 'alpha page'), 8000);
  chips = await chipsIn('#messages .msg.assistant');
  const byKey = Object.fromEntries(chips.map((c) => [c.key, c]));
  check('the marker for an open tab is a chip with the tab\'s title', byKey[String(A)]?.title === 'alpha page' && byKey[String(B)]?.title === 'beta page', J(chips));
  check('it is a real button, labelled "Switch to tab: Title", with title and address in the tooltip', byKey[String(A)]?.tag === 'BUTTON' && byKey[String(A)].label === 'Switch to tab: alpha page' && byKey[String(A)].tip.includes('alpha page') && byKey[String(A)].tip.includes(`${base}/alpha`), J(byKey[String(A)]));
  check('a tab that was never open reads as a closed tab and cannot be clicked', byKey['99999']?.closed === true && byKey['99999'].disabled === 'true' && byKey['99999'].title === 'Closed tab', J(byKey['99999']));
  const text = await ui.evaluate(() => [...document.querySelectorAll('#messages .msg.assistant')].pop().textContent);
  check('a marker inside code stays text (one chip per real marker)', /\[\[tab:\d+\]\]/.test(text) && chips.filter((c) => c.key === String(A)).length === 1, text);
  check('the chip has the tab\'s icon slot and its title is cut with an ellipsis', await ui.evaluate(() => { const c = document.querySelector('#messages .tab-ref'); const t = c.querySelector('.tab-ref-title'); const s = getComputedStyle(t); return Boolean(c.querySelector('.tab-ref-icon')) && s.textOverflow === 'ellipsis' && s.whiteSpace === 'nowrap'; }), 'style');

  // ---- your own message and page text never make a chip
  await ui.fill('#prompt', `what about [[tab:${A}]] in my own words?`);
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('#messages .msg.user').length >= 2), 30000);
  check('your own message with a marker is plain text', await ui.evaluate(() => { const u = [...document.querySelectorAll('#messages .msg.user')].pop(); return !u.querySelector('.tab-ref') && /\[\[tab:\d+\]\]/.test(u.textContent); }), 'chip in user message');
  // What a page says reaches the AI through a tool result, which main hands through the guard: read the real page text and the real read_page result.
  const tabMarker = require('../../src/renderer/tab-marker');
  const pageText = await app.evaluate(async (_e, id) => global.__agent.browser.tabById(id).webContents.executeJavaScript('document.body.innerText'), A);
  check('the test page really holds two [[tab:N]] markers in its text', tabMarker.idsIn(pageText).length === 2, pageText);
  const readBack = await app.evaluate(async (_e, id) => { global.__agent.browser.switchTab?.(id); const out = await global.__agent.execute('read_page', {}); return typeof out === 'string' ? out : JSON.stringify(out); }, A).catch((e) => String(e.message));
  check('...and what the AI reads back of that page names no tab', /Page alpha/.test(readBack) && tabMarker.idsIn(readBack).length === 0, readBack.slice(0, 300));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), home);
  await showChat();

  // ---- clicking switches; the keyboard works too
  check('before: the chat\'s own tab is in front', (await front()) === home, String(await front()));
  await ui.click(`#messages .tab-ref[data-key="${A}"]`);
  check('clicking a chip switches to that tab', await waitFor(async () => (await front()) === A, 5000), String(await front()));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), home);
  await showChat();
  await sleep(300);
  await ui.focus(`#messages .tab-ref[data-key="${B}"]`);
  await ui.press(`#messages .tab-ref[data-key="${B}"]`, 'Enter');
  check('Enter on a focused chip switches too', await waitFor(async () => (await front()) === B, 5000), String(await front()));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), home);
  await showChat();

  // ---- hidden AI tabs: a chip still goes to a tab the strip hides
  const C = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u, { ai: true }); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); global.__tcC = t.id; await global.__settings.backend.set('hideAiTabs', true); return t.id; }, `${base}/hidden`);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), home);
  await sleep(500);
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  const inStrip = () => ui.evaluate(() => document.querySelectorAll('#tabs .tab').length);
  const stripBefore = await inStrip();
  await ui.fill('#prompt', 'show the hidden one');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate((id) => !document.getElementById('send').classList.contains('stop') && Boolean(document.querySelector(`#messages .tab-ref[data-key="${id}"]`)), C), 30000);
  await ui.click(`#messages .tab-ref[data-key="${C}"]`);
  check('a chip for an AI tab hidden from the strip goes to it, and the strip shows it while it is in front', (await waitFor(async () => (await front()) === C, 5000)) && (await waitFor(async () => (await inStrip()) === stripBefore + 1, 5000)), J([await front(), stripBefore, await inStrip()]));
  await app.evaluate(async (_e, id) => { await global.__settings.backend.set('hideAiTabs', false); global.__agent.browser.switchTab(id); }, home);
  await showChat();

  // ---- the title follows the page, with no polling
  await app.evaluate(async (_e, id) => { await global.__agent.browser.tabById(id).webContents.executeJavaScript('document.title = "alpha renamed"'); }, A);
  check('the chip\'s title follows the tab', await waitFor(async () => (await chipsIn('#messages .msg.assistant')).some((c) => c.key === String(A) && c.title === 'alpha renamed'), 8000), J(await chipsIn('#messages .msg.assistant')));
  check('...and so does its label', (await chipsIn('#messages .msg.assistant')).find((c) => c.key === String(A))?.label === 'Switch to tab: alpha renamed', '');

  // ---- a step that names a tab
  await ui.fill('#prompt', 'do the steps');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('#messages .step .tab-ref').length >= 1), 30000);
  const stepRow = await ui.evaluate(() => { const r = document.querySelector('#messages .step .tab-ref')?.closest('.step'); return r && { text: r.querySelector('.step-detail').textContent, chip: r.querySelector('.tab-ref-title').textContent }; });
  check('a switch_tab step reads "Switching to" and shows the tab as a chip', stepRow && stepRow.text === 'Switching to' && stepRow.chip === 'alpha renamed', J(stepRow));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), home);
  await showChat();

  // ---- a closed tab: last title, struck through, reopens from its address
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), B);
  const closedChip = await waitFor(async () => (await chipsIn('#messages .msg.assistant')).find((c) => c.key === String(B) && c.closed), 8000);
  check('a closed tab\'s chip keeps its last title and says closed', closedChip && closedChip.title === 'beta page' && /Reopen closed tab: beta page/.test(closedChip.label) && /open it again/.test(closedChip.tip), J(closedChip));
  const tabsBefore = await app.evaluate(() => global.__agent.browser.listTabs().length);
  await ui.click(`#messages .msg.assistant .tab-ref[data-key="${B}"]`);
  const reopened = await waitFor(async () => app.evaluate((_e, u) => { const a = global.__agent.browser.activeTab(); return a && a.id !== undefined && a.webContents.getURL() === u ? a.id : null; }, `${base}/beta`), 6000);
  check('clicking it opens the address again in a new tab', Boolean(reopened) && reopened !== B && (await app.evaluate(() => global.__agent.browser.listTabs().length)) === tabsBefore + 1, J({ reopened, B }));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), home);
  await showChat();

  // ---- saved with the chat, drawn again after a reload; the markers are in the saved text and the titles in the snapshot
  await sleep(800);
  const saved = await app.evaluate(() => global.__agent.transcript().map((i) => i.tabs).filter(Boolean));
  check('the reply keeps each tab\'s title and address (a snapshot)', saved.some((t) => t[A]?.t && t[A].u.includes('/alpha') && t[B]?.t === 'beta page'), J(saved));
  const md = await app.evaluate(async () => { const id = global.__chats.id(); return global.__chats.markdown(id); });
  check('Markdown export writes a chip as "Title (address)"', md && /alpha renamed \(http:\/\/127\.0\.0\.1:\d+\/alpha\)/.test(md) && !/\[\[tab:\d+\]\]/.test(md.split('## Assistant')[1].split('`')[0] || ''), String(md).slice(0, 600));
  await ui.reload();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  const restored = await waitFor(async () => { const c = await chipsIn('#messages .msg.assistant'); return c.length >= 3 && c.some((x) => (x.key.startsWith(`${A}@`) || x.key === String(A)) && !x.closed) && c; }, 15000); // (a chip first shows what the saved chat kept, as closed, until main answers which tabs are open: wait for that answer)
  const rA = (restored || []).find((c) => c.key.startsWith(`${A}`));
  const rB = (restored || []).find((c) => c.key.startsWith(`${B}`));
  check('a reopened chat draws its chips again (live tab: its title)', rA && /alpha/.test(rA.title) && rA.closed === false, J(restored));
  check('...and a tab that closed shows as closed with its title', rB && rB.closed === true && rB.title === 'beta page', J(rB));
  const stepsBack = await waitFor(() => ui.evaluate(() => document.querySelectorAll('#messages .step .tab-ref, #messages .act-card .tab-ref').length), 5000);
  check('the step and the card chips come back too', Number(stepsBack) >= 1, String(stepsBack));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
