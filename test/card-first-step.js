// The activity card starts at the FIRST step of a tool-using run (a web search, a page read in the background, a file step, any tool), compact (header,
// status line showing that step, step list; no empty preview box), and a reply with no tools never has one. Thinking is one row per stretch of thinking
// (times added, words in order), in the card's step list when the run uses tools; blank thinking gets no row; no empty bubble is left when the run ends.
// Hidden window (LUMEN_TEST_BACKGROUND=1), a throwaway profile, a fake Claude client (no network). Run under the lock:
//   node scripts/test/e2e-lock.js run --owner card-first-step -- timeout 400 node test/card-first-step.js
// $CARD_FIRST_STEP_SHOTS = a folder for screenshots.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const shots = process.env.CARD_FIRST_STEP_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const root = process.env.CARD_FIRST_STEP_ROOT || path.join(__dirname, '..');
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(root, 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-card-first-'));
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  const ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    const fake = global.__fake = { n: 0, gate: null };
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply ${++fake.n}.` }], usage: { input_tokens: 10, output_tokens: 5 } };
      return { async *[Symbol.asyncIterator]() { if (fake.gate) await fake.gate; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } }; }, finalMessage: async () => message };
    } } } });
  });
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(400);
  await ui.evaluate('loadStepUI()');
  await ui.waitForFunction(() => window.stepUI && window.stepLabels);
  const shot = async (name) => { if (shots) await ui.screenshot({ path: path.join(shots, `${name}.png`) }); };

  // ---- the card at the first step, whatever the step is (stepUI.add with a fresh turn, nothing else)
  const first = await ui.evaluate(() => {
    const out = {};
    const cases = {
      search: { name: 'web_search', id: 't1', input: { query: 'cats' }, label: 'Searching the web for ‘cats’' },
      readUrls: { name: 'read_urls', id: 't1', input: { urls: ['https://www.youtube.com/a', 'https://www.youtube.com/b'] }, label: 'Reading 2 pages on youtube.com in the background' },
      webSearchEngine: { name: 'WebSearch', id: 't1', input: { query: 'dogs' }, label: 'Searching the web for ‘dogs’' },
      anyTool: { name: 'ToolSearch', id: 't1', input: {}, label: 'Looking for a tool' },
      file: { name: 'Read', id: 't1', input: { file_path: 'C:/a/notes.md' }, label: 'Reading notes.md' },
      shell: { name: 'Bash', id: 't1', input: { command: 'dir' }, label: 'Listing files' },
      browser: { name: 'navigate', id: 't1', input: { url: 'https://example.com' }, label: 'Opening example.com' },
    };
    for (const [k, ev] of Object.entries(cases)) {
      const host = document.createElement('div');
      document.getElementById('messages').append(host);
      const turn = {};
      window.stepUI.add(turn, ev, { messages: host, append: (n) => host.append(n), task: 'Find videos', runId: 1 });
      const card = host.querySelector('.act-card');
      const shotBox = card?.querySelector('.act-shot');
      out[k] = { cards: host.querySelectorAll('.act-card').length, loose: host.querySelectorAll(':scope > .step, :scope > .step-group').length, status: card?.querySelector('.act-status-text')?.textContent || '', steps: card?.querySelectorAll('.act-list .step').length, shotShown: Boolean(shotBox && !shotBox.hidden && shotBox.offsetHeight > 0), shot2Shown: Boolean(card?.querySelector('.act-shot2') && !card.querySelector('.act-shot2').hidden), title: card?.querySelector('.act-title')?.textContent || '' };
      // a second step of another kind joins the same card (no second card)
      window.stepUI.add(turn, { name: 'web_search', id: 't2', input: { query: 'more' }, label: 'Searching the web for ‘more’' }, { messages: host, append: (n) => host.append(n), task: 'Find videos', runId: 1 });
      out[k].after = { cards: host.querySelectorAll('.act-card').length, loose: host.querySelectorAll(':scope > .step, :scope > .step-group').length, surface: card.dataset.surface };
    }
    return out;
  });
  for (const [k, v] of Object.entries(first)) {
    check(`${k}: the first step makes the card at once, with no loose step row`, v.cards === 1 && v.loose === 0 && v.steps >= 1, JSON.stringify(v));
    check(`${k}: the status line shows that step from the start`, v.status.length > 3 && !/Getting started/.test(v.status), v.status);
    check(`${k}: compact, no empty preview box`, !v.shotShown && !v.shot2Shown, JSON.stringify(v));
    check(`${k}: a later step goes in the same card`, v.after.cards === 1 && v.after.loose === 0, JSON.stringify(v.after));
  }
  check('a web search card is titled like the browser, a tool card "Working"', first.search.title === 'Browser' && first.anyTool.title === 'Working', `${first.search.title} / ${first.anyTool.title}`);
  check('a search card that goes on to a tab becomes a browser card (its surface follows)', await ui.evaluate(() => {
    const host = document.createElement('div'); document.getElementById('messages').append(host);
    const turn = {}; const o = { messages: host, append: (n) => host.append(n), task: 'x', runId: 1 };
    window.stepUI.add(turn, { name: 'web_search', id: 'a', input: { query: 'q' }, label: 'Searching the web for ‘q’' }, o);
    window.stepUI.add(turn, { name: 'open_tab', id: 'b', input: { url: 'https://example.com' }, label: 'Opening example.com in a new tab' }, o);
    return host.querySelector('.act-card').dataset.surface === 'browser' && host.querySelectorAll('.act-card').length === 1;
  }), 'surface');

  // ---- the Files card: every file the AI wrote opens from it
  const files = await ui.evaluate(async () => {
    const host = document.createElement('div'); for (const n of [...document.getElementById('messages').children]) if (n.id !== 'empty') n.remove(); document.getElementById('messages').append(host);
    const turn = {}; const o = { messages: host, append: (n) => host.append(n), task: 'Write a handoff', runId: 1 };
    const w = (p, label) => window.stepUI.add(turn, { name: 'Write', id: p, input: { file_path: p }, label }, o);
    w('Ai/HANDOFF.md', 'Writing HANDOFF.md'); w('tools/run.ps1', 'Writing run.ps1'); w('old.md', 'Writing old.md');
    for (let i = 1; i <= 4; i++) w(`more/${i}.txt`, `Writing ${i}.txt`);
    const calls = [];
    window.stepUI.opener = (id, how) => { calls.push([id, how]); return id === 'gone' ? { ok: false, reason: 'gone' } : { ok: true }; };
    const mk = (id, name, canTab, canSystem) => ({ id, name, path: `C:/x/${name}`, canTab, canSystem });
    window.stepUI.filesMade(turn, [mk('f1', 'HANDOFF.md', true, true), mk('f2', 'run.ps1', false, false), mk('gone', 'old.md', true, true), mk('f4', '1.txt', true, true), mk('f5', '2.txt', true, true), mk('f6', '3.txt', true, true), mk('f7', '4.txt', true, true)]);
    window.stepUI.finalize(turn, { reply: 'Created Ai/HANDOFF.md with the notes.' });
    const card = host.querySelector('.act-card');
    const q = (s) => [...card.querySelectorAll(s)];
    const out = { title: card.querySelector('.act-title').textContent, links: q('.act-files .act-filelink').map((b) => b.textContent), more: card.querySelector('.act-filemore')?.textContent || '', status: card.querySelector('.act-status-text').textContent, statusLink: card.querySelector('.act-status-text .act-filelink')?.textContent || '', stepLinks: q('.act-list .step .act-steplink').length };
    card.querySelector('.act-status-text .act-filelink').click(); await new Promise((r) => setTimeout(r, 50));
    q('.act-files .act-fileshow')[0].click(); await new Promise((r) => setTimeout(r, 50));
    q('.act-files .act-filelink')[1].click(); await new Promise((r) => setTimeout(r, 50));
    q('.act-files .act-filelink')[2].click(); await new Promise((r) => setTimeout(r, 80));
    out.calls = calls.slice(); out.note = card.querySelector('.act-filenote')?.textContent || '';
    window.stepUI.opener = null;
    return out;
  });
  await shot('5-files-card');
  check('a Files card lists up to 5 files and "+N more"', files.links.length === 5 && /\+2 more/.test(files.more), JSON.stringify(files));
  check('the status row names the file as a link', /Created Ai\/HANDOFF\.md/.test(files.status) && files.statusLink === 'Ai/HANDOFF.md', JSON.stringify(files));
  check('each file step has an Open link', files.stepLinks >= 3, files.stepLinks);
  check('clicking the file opens it in a tab (Lumen\'s viewers), Show in folder reveals it', JSON.stringify(files.calls.slice(0, 2)) === JSON.stringify([['f1', 'tab'], ['f1', 'reveal']]), JSON.stringify(files.calls));
  check('a script is only shown in its folder, never opened', JSON.stringify(files.calls[2]) === JSON.stringify(['f2', 'reveal']), JSON.stringify(files.calls));
  check('a file that is gone says so', /no longer there/.test(files.note), files.note);

  // ---- host dedupe
  const sl = require(path.join(root, 'src', 'renderer', 'step-labels.js'));
  check('read_urls: the same host twice is "Reading 2 pages on youtube.com in the background"', sl.readUrlsLabel(['www.youtube.com', 'www.youtube.com']) === 'Reading 2 pages on youtube.com in the background', sl.readUrlsLabel(['www.youtube.com', 'www.youtube.com']));
  check('read_urls: different hosts are each named once', sl.readUrlsLabel(['https://a.com/1', 'https://b.com/2', 'https://a.com/3']) === 'Reading a.com, b.com in the background', sl.readUrlsLabel(['https://a.com/1', 'https://b.com/2', 'https://a.com/3']));

  // ---- a live run: events as main sends them
  const emit = async (ev) => {
    const runId = await ui.evaluate(() => runId);
    await app.evaluate(({ BrowserWindow }, e) => { const w = BrowserWindow.getAllWindows().find((x) => /index\.html/.test(x.webContents.getURL())) || BrowserWindow.getAllWindows()[0]; w.webContents.send('agent:event', e); }, { ...ev, runId });
  };
  const start = async (text) => {
    await ui.evaluate(() => { for (const n of [...document.getElementById('messages').children]) if (n.id !== 'empty') n.remove(); }); // (the empty-chat block lives in #messages and stays)
    await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
    await ui.fill('#prompt', text);
    await ui.press('#prompt', 'Enter');
    const ok = await waitFor(() => ui.evaluate(() => document.getElementById('send').classList.contains('stop')));
    check(`a run starts: ${text}`, Boolean(ok), await ui.evaluate(() => JSON.stringify({ runId: window.eval('typeof runId') !== 'undefined' ? window.eval('runId') : null, msgs: document.getElementById('messages').children.length, prompt: document.getElementById('prompt').value })));
  };
  const finish = async () => {
    await emit({ type: 'done' });
    await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));
    await app.evaluate(() => global.__fake.release?.());
    await sleep(150);
  };
  const dom = () => ui.evaluate(() => {
    const m = document.getElementById('messages');
    const rows = [...m.querySelectorAll('.thinking')].map((d) => ({ inCard: Boolean(d.closest('.act-card')), text: d.querySelector('div').textContent, sum: d.firstChild.textContent }));
    const card = m.querySelector('.act-card');
    const kids = card ? [...card.querySelectorAll('.act-list > *')].map((n) => (n.classList.contains('thinking') ? 'T' : 'S')).join('') : '';
    const empty = [...m.querySelectorAll(':scope > .msg.assistant')].filter((b) => !b.textContent.trim() && !b.querySelector('img,svg,button')).length;
    return { rows, cards: m.querySelectorAll('.act-card').length, kids, empty, working: m.querySelectorAll('.working').length, loose: m.querySelectorAll(':scope > .step, :scope > .step-group').length, status: card?.querySelector('.act-status-text')?.textContent || '', bubbles: [...m.querySelectorAll(':scope > .msg.assistant')].map((b) => b.textContent.trim()) };
  });

  // a reply with no tools: no card, one "Thought for Ns" row above the answer; the blocks are one row, their times added
  await start('plain question');
  await emit({ type: 'thinking', text: 'one' }); await sleep(1100);
  await emit({ type: 'text_block' });
  await emit({ type: 'thinking', text: 'two' }); await sleep(1100);
  await emit({ type: 'text_block' });
  await emit({ type: 'thinking', text: 'three' }); await sleep(1100);
  await emit({ type: 'thinking', text: '' });
  await emit({ type: 'text', text: 'The answer.' });
  await sleep(200);
  let d = await dom();
  await shot('1-no-tools');
  check('a reply with no tools has no card', d.cards === 0 && d.loose === 0, JSON.stringify(d));
  check('three thinking blocks are one row, loose above the answer', d.rows.length === 1 && !d.rows[0].inCard, JSON.stringify(d.rows));
  check('its time is the blocks added up ("Thought for 3s")', /^Thought for 3s$/.test(d.rows[0]?.sum), d.rows[0]?.sum);
  check('opening it shows each block in order, apart', d.rows[0]?.text === 'one\n\ntwo\n\nthree', JSON.stringify(d.rows[0]?.text));
  await emit({ type: 'text', text: '   ' });
  await finish();

  // blank thinking: no row of its own
  await start('blank thinking');
  await emit({ type: 'thinking', text: '' });
  await emit({ type: 'thinking', text: '   ' });
  await emit({ type: 'text', text: 'Hello.' });
  await sleep(150);
  d = await dom();
  check('blank thinking under a second shows no row', d.rows.length === 0, JSON.stringify(d.rows));
  await finish();
  await start('blank thinking, with a row next to it');
  await emit({ type: 'thinking', text: '' }); await sleep(1100);
  await emit({ type: 'text_block' });
  await emit({ type: 'thinking', text: 'real words' }); await sleep(300);
  await emit({ type: 'text', text: 'Hello.' });
  await sleep(150);
  d = await dom();
  check('blank thinking only adds its time to the thinking row beside it', d.rows.length === 1 && /^Thought for 1s$/.test(d.rows[0].sum) && d.rows[0].text === 'real words', JSON.stringify(d.rows));
  await finish();

  // a run with tools: the card at the first step; thinking rows inside its step list in order; nothing loose after it
  await start('find videos');
  await emit({ type: 'thinking', text: 'I should search' }); await sleep(300);
  await emit({ type: 'thinking', text: ' first' });
  await emit({ type: 'tool', id: 'w1', name: 'web_search', input: { query: 'cats' }, label: 'Searching the web for ‘cats’' });
  await waitFor(async () => (await dom()).cards === 1, 4000);
  d = await dom();
  await shot('2-first-step-search');
  check('the first step (a web search) shows the card, no loose rows', d.cards === 1 && d.loose === 0, JSON.stringify(d));
  check('the status line shows the search', /Searching the web/.test(d.status), d.status);
  check('the thinking before the step moved into the card, before the step', d.rows.length === 1 && d.rows[0].inCard && d.kids === 'TS', JSON.stringify(d));
  await emit({ type: 'tool_done', id: 'w1', ok: true });
  await emit({ type: 'thinking', text: 'now read' }); await sleep(200);
  await emit({ type: 'thinking', text: ' pages' });
  await emit({ type: 'tool', id: 'r1', name: 'read_urls', input: { urls: ['https://www.youtube.com/a', 'https://www.youtube.com/b'] }, label: 'Reading 2 pages on youtube.com in the background' });
  await emit({ type: 'thinking', text: 'more' });
  await emit({ type: 'thinking', text: '' });
  await emit({ type: 'tool', id: 'f1', name: 'Read', input: { file_path: 'C:/a/notes.md' }, label: 'Reading notes.md' });
  await emit({ type: 'tool_done', id: 'r1', ok: true });
  await emit({ type: 'tool_done', id: 'f1', ok: true });
  await emit({ type: 'thinking', text: 'wrap up' });
  await emit({ type: 'text', text: 'Found them.' });
  await sleep(300);
  d = await dom();
  await shot('3-run-with-tools');
  check('still one card, nothing loose', d.cards === 1 && d.loose === 0, JSON.stringify(d));
  check('every thinking row is in the card, between the steps (thinking, step, thinking, step, ...)', d.rows.length === 4 && d.rows.every((r) => r.inCard) && /^TS+TS+TS+T$/.test(d.kids), JSON.stringify(d));
  await emit({ type: 'text', text: '  ' });
  await finish();
  d = await dom();
  await shot('4-run-ended');
  check('after the run: the working line is gone', d.working === 0, JSON.stringify(d));
  check('after the run: no empty message bubble is left', d.empty === 0 && d.bubbles.every(Boolean), JSON.stringify(d.bubbles));
  check('after the run: the card says Done', await ui.evaluate(() => /Done/.test(document.querySelector('#messages .act-card .act-status-text')?.textContent || '')), '');

  // a bubble that never got words
  await start('empty bubble');
  await emit({ type: 'text', text: '\n' });
  await emit({ type: 'tool', id: 'x1', name: 'ToolSearch', input: {}, label: 'Looking for a tool' });
  await emit({ type: 'tool_done', id: 'x1', ok: true });
  await emit({ type: 'text', text: ' ' });
  await finish();
  d = await dom();
  check('a blank text block leaves no empty bar behind', d.empty === 0, JSON.stringify(d.bubbles));

  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
