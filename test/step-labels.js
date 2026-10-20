// What the AI is doing, in the chat (renderer/step-ui.js, step-labels.js, features/step-thumbs.js): readable one-line steps, details on demand,
// grouping, errors in plain words, a running timer, and the activity cards: ONE Browser card per AI turn (it keeps updating: a live
// thumbnail of the exact tab the last step acted on, however many tabs and narration lines come between, and a status bar saying what it does;
// ONE card for the whole turn whatever the surfaces (browser, commands, files, programs): its title, preview and status follow the step, the
// narration is its live line, the approvals are small rows in it, and only the final answer is a bubble, under it)
// and a Computer card for shell work. Sidebar and full-page chat both. Hidden windows (LUMEN_TEST_BACKGROUND=1), a throwaway profile,
// a fake Claude API client and a fake `claude` CLI: no network beyond 127.0.0.1, never the real CLI. Run it under the lock:
//   node scripts/e2e-lock.js run -- node test/step-labels.js
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const F = require('./_pptx-fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const J = (v) => JSON.stringify(v);

// The fake CLI: a Node child speaking stream-json, scripted like the screenshot that asked for this (a PDF turned to PNGs and read back).
const FAKE_CLI = `
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const use = (id, name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const done = (id, content, is_error = false) => out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
let buf = '';
process.stdin.on('data', async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PNGs rendered. Viewing the report pages.' } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'PNGs rendered. Viewing the report pages.' }] } });
    await wait(300);
    use('r1', 'Read', { file_path: 'C:\\\\Users\\\\emah\\\\AppData\\\\Local\\\\Temp\\\\p1.png' });
    use('r2', 'Read', { file_path: 'C:\\\\Users\\\\emah\\\\AppData\\\\Local\\\\Temp\\\\p2.png' });
    await wait(200);
    done('r1', 'ok');
    done('r2', 'Image file is empty: C:\\\\Users\\\\emah\\\\AppData\\\\Local\\\\Temp\\\\p2.png', true);
    use('b1', 'Bash', { command: 'cd "C:/Users/emah/AppData/Local/Temp" && powershell -NoProfile -File pdf2png.ps1', description: 'Render the PDF pages to PNG' });
    await wait(2600); // long enough for the timer to show
    done('b1', 'rendered 4 pages');
    use('p1', 'PowerShell', { command: 'Get-Content C:\\\\x\\\\notes.txt' });
    await wait(150);
    done('p1', 'line one\\nline two');
    use('b2', 'Bash', { command: 'cat > "C:/Users/emah/AppData/Local/Temp/fmt.ps1" <<\\'EOF\\'\\n$path=1\\nEOF' });
    await wait(150);
    done('b2', '');
    use('b3', 'Bash', { command: 'deploy.sh --password hunter2 --token=abcd1234efgh5678' });
    await wait(150);
    done('b3', 'deployed');
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Everything is in place.' } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Everything is in place.' }], stop_reason: 'end_turn' } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Everything is in place.', session_id: 'sess-1', total_cost_usd: 0, usage: {} });
  }
});
`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

  const PAGES = { '/a': '#d22', '/b': '#22d', '/c': '#2a2' };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/still')) { res.end('<!doctype html><title>Still page</title><body style="margin:0;background:#d22;color:#fff"><h1 style="font-size:90px;margin:40px">Still</h1></body>'); return; } // (nothing on it moves: the other pages tick a counter, which is a changing page)
    if (req.url.startsWith('/redir')) { res.end('<!doctype html><title>Red page</title><body style="margin:0;background:#d22;color:#fff"><h1 style="font-size:90px;margin:40px">Red</h1><script>setTimeout(() => { location.href = "/blue"; }, 500);</script></body>'); return; }
    if (req.url.startsWith('/blue')) { setTimeout(() => res.end('<!doctype html><title>Blue page</title><body style="margin:0;background:#22d;color:#fff"><h1 style="font-size:90px;margin:40px">Blue</h1></body>'), 2500); return; } // (slow: the run is over before it has loaded)
    if (req.url.startsWith('/live')) { res.end('<!doctype html><title>Page /live</title><body style="margin:0;background:#2a2;color:#fff"><h1 style="font-size:60px;margin:30px">Live</h1><script>let n = 0; setInterval(() => { const d = document.createElement("div"); d.textContent = "row " + (++n); d.style.cssText = "font-size:30px;margin:4px 30px;background:#" + (n % 2 ? "163" : "361"); document.body.append(d); }, 200); const bar = document.createElement("div"); bar.style.cssText = "position:fixed;top:0;left:0;width:60px;height:60px;background:#fff"; document.body.append(bar); (function f() { bar.style.transform = "translateX(" + (Date.now() / 4 % 250) + "px)"; requestAnimationFrame(f); })();</script></body>'); return; }
    const color = PAGES[req.url.split('?')[0]] || '#888';
    res.end(`<!doctype html><title>Page ${req.url}</title><body style="margin:0;background:${color};color:#fff"><h1 style="font-size:90px;margin:40px">Page ${req.url}</h1><p id="n" style="font-size:60px;margin:40px"></p><script>setInterval(() => { document.getElementById('n').textContent = Date.now(); }, 150);</script></body>`); // (a counter: every frame differs)
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const fake = path.join(root, 'fake-claude.js'); fs.writeFileSync(fake, FAKE_CLI);
  const spawnModule = path.join(root, 'cli-spawn.js'); // what the engines call in place of child_process.spawn (features/ai-agents.js cliSpawn)
  fs.writeFileSync(spawnModule, `const cp = require('child_process'); exports.spawn = (bin, argv, opts) => cp.spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } });`);

  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(__dirname, '..', 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: fake, LUMEN_TEST_CLI_SPAWN: spawnModule },
  });
  const ui = await app.firstWindow({ timeout: 90000 });
  const errors = [];
  const stderr = []; // (what the app said, shown when its window goes away mid-run)
  app.process().stderr?.on('data', (d) => stderr.push(String(d)));
  ui.on('crash', () => console.log('UI CRASHED'));
  const consoleErrors = []; ui.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleErrors.push(m.type() + ': ' + m.text().slice(0, 300)); });
  ui.on('close', () => console.log('UI CLOSED', stderr.join('').slice(-1500)));
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('graphicsMode', 'full'); global.__settings.backend.set('closeAiTabs', 'off'); }); // (closeAiTabs off: the card's hide/show switch below needs the AI's tab still open; the close itself is close-ai-tabs.js) (Light, which an integrated GPU picks on its own, refreshes only on navigation: covered below)

  // ---- the fake Claude API client: scripted steps per request, narration first, a pause in the 'wait' tool
  await app.evaluate(() => {
    const scripts = {
      find: [{ text: 'Digging through the pages.', tool: ['navigate', { url: '@a' }] }, { tool: ['wait', { seconds: 3 }] }, { tool: ['navigate', { url: '@b' }] }, { tool: ['wait', { seconds: 3 }] }, { tool: ['open_tab', { url: '@c' }] }, { text: 'Found it on the second page.' }],
      two: [{ text: 'Checking the first page.', tool: ['open_tab', { url: '@a' }] }, { text: 'Now the second.', tool: ['navigate', { url: '@b' }] }, { text: 'All done.' }],
      page: [{ text: 'On it.', tool: ['navigate', { url: '@c' }] }, { tool: ['wait', { seconds: 2 }] }, { text: 'Done from the page.' }],
      // one turn, four browser calls with a line of narration before each: ONE card; the last call acts on tab B (#B) while the user looks at tab A
      four: [{ text: 'One.', tool: ['navigate', { url: '@a' }] }, { text: 'Two.', tool: ['navigate', { url: '@b' }] }, { text: 'Three.', tool: ['navigate', { url: '@c' }] }, { text: 'Four.', tool: ['get_console', { tab_id: '#B' }] }, { text: 'All four done.', delay: 1500 }],
      // the AI acts on tab B, thinks for a while, then on tab A (the tab the user is looking at the whole time)
      tabs: [{ text: 'Peeking at the other tab.', tool: ['get_console', { tab_id: '#B' }] }, { text: 'Back here.', delay: 3000, tool: ['get_console', { tab_id: '#A' }] }, { text: 'Finished.', delay: 1500 }],
      // the AI uses tab B, then tab A, then closes tab B
      closing: [{ text: 'Looking at the other tab.', tool: ['get_console', { tab_id: '#B' }] }, { text: 'And this one.', tool: ['get_console', { tab_id: '#A' }] }, { text: 'Closing the other one.', tool: ['close_tab', { tab_id: '#B' }] }, { text: 'Closed it.', delay: 1500 }],
      // a slides-viewer tab, then a PDF-viewer tab, both read in the background
      viewers: [{ text: 'Looking at the deck.', tool: ['get_console', { tab_id: '#S' }] }, { text: 'And the PDF.', delay: 3500, tool: ['get_console', { tab_id: '#P' }] }, { text: 'Seen both.', delay: 1500 }],
      // browser, files and browser again, with a line of narration before each, and a pause in the middle
      mixed: [{ text: 'Opening the page.', tool: ['navigate', { url: '@a' }] }, { text: 'Checking my downloads.', tool: ['list_files', { folder: 'downloads' }] }, { text: 'Back to the site.', delay: 2500, tool: ['navigate', { url: '@b' }] }, { text: 'All done with both.', delay: 1000 }],
      // an address read with no tab
      reading: [{ text: 'Reading quietly.', tool: ['read_urls', { urls: ['@a'] }] }, { text: 'Read it.', delay: 1500 }],
      // the last step navigates to a page that loads slowly: the run ends while it is still loading
      endnav: [{ tool: ['navigate', { url: '@redir' }] }, { text: 'Opened the page.', delay: 1500 }],
      // a page that keeps changing, then one that stands still
      moving: [{ tool: ['navigate', { url: '@live' }] }, { tool: ['wait', { seconds: 3 }] }, { text: 'Watched it.' }],
      movingA: [{ tool: ['navigate', { url: '@live', tab_id: '#A' }] }, { tool: ['wait', { seconds: 3, tab_id: '#A' }] }, { text: 'Watched it in this tab.' }],
      still: [{ tool: ['navigate', { url: '@still' }] }, { tool: ['wait', { seconds: 6 }] }, { text: 'Watched it still.' }],
    };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const users = params.messages.filter((m) => m.role === 'user');
      const lastAsk = [...users].reverse().find((m) => !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')));
      const asked = JSON.stringify(lastAsk?.content || '');
      const key = /final frame/.test(asked) ? 'endnav' : /four things/.test(asked) ? 'four' : /between tabs/.test(asked) ? 'tabs' : /mix the surfaces/.test(asked) ? 'mixed' : /the viewers/.test(asked) ? 'viewers' : /close the other tab/.test(asked) ? 'closing' : /read the site/.test(asked) ? 'reading' : /moving page in this tab/.test(asked) ? 'movingA' : /moving page/.test(asked) ? 'moving' : /still page/.test(asked) ? 'still' : /two/.test(asked) ? 'two' : /from the page/.test(asked) ? 'page' : 'find';
      const idx = users.length - 1 - users.indexOf(lastAsk);
      const step = scripts[key][Math.min(idx, scripts[key].length - 1)];
      const base = global.__slBase;
      const content = [];
      if (step.text) content.push({ type: 'text', text: step.text });
      if (step.tool) content.push({ type: 'tool_use', id: `tu_${key}_${idx}`, name: step.tool[0], input: JSON.parse(JSON.stringify(step.tool[1]).replace(/@(\w)/, `${base}/$1`).replace(/"#([ABSP])"/, (_m, k) => String((global.__slTabs || {})[k]))) });
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: step.tool ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 10, output_tokens: 5 } };
      return {
        async *[Symbol.asyncIterator]() { if (step.delay) await new Promise((r) => setTimeout(r, step.delay)); if (step.text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });
  await app.evaluate((_e, b) => { global.__slBase = b; }, base);
  await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/c`);
  await sleep(600);

  // ---- let the app finish starting before anything is measured: Lumen loads some modules a few seconds after its window is up (the GPU health
  // module, main.js: its first read of the GPU info blocks the main process for 20-40 ms). That is start-up, not the chat's cost, and it
  // used to land inside the 50 ms main-process check at random.
  await waitFor(() => app.evaluate(() => Boolean(global.__gpuHealth)), 30000);
  await sleep(500);

  // ---- probes: a main-process setImmediate gap, and long tasks in the chat renderer
  await app.evaluate(() => {
    const probe = global.__slProbe = { max: 0, n: 0, on: true, big: [] };
    let last = performance.now();
    const tick = () => { const now = performance.now(); if (now - last > 10) probe.big.push([now, now - last]); probe.max = Math.max(probe.max, now - last); probe.n++; last = now; if (probe.on) setImmediate(tick); };
    setImmediate(tick);
  });
  const watchUi = () => ui.evaluate(() => {
    window.__long = []; window.__thumbs = []; window.__evlog = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch { /* none */ }
    window.assistant.onEvent((e) => { { const c0 = document.querySelector('#messages .act-card'); window.__evlog.push(e.type + (e.name ? ':' + e.name : '') + (e.id ? '#' + e.id : '') + '[c' + document.querySelectorAll('#messages .act-card').length + 'r' + (c0 ? c0.querySelectorAll('.act-list .step').length : 0) + ']'); } if (e.type === 'thumb' && e.data) window.__thumbs.push({ tabId: e.tabId, url: e.url, bytes: e.data.length, at: Math.round(performance.timeOrigin + performance.now()) }); });
  });
  await watchUi();

  // ---- A. the Browser card, in the sidebar
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(500);
  const card = (sel = '#messages') => `${sel} .act-card[data-surface="browser"]`;
  await app.evaluate(() => { global.__slProbe.max = 0; global.__slProbe.big = []; });
  await ui.evaluate(() => { window.__status = []; window.__bar = []; window.__states = []; new MutationObserver(() => { const c = document.querySelector('#messages .act-card[data-surface="browser"]'); const n = c?.querySelector('[role="status"]'); if (n && n.textContent && window.__status[window.__status.length - 1]?.t !== n.textContent) window.__status.push({ t: n.textContent, at: performance.now() }); const b = c?.querySelector('.act-status-text')?.textContent; if (b && window.__bar[window.__bar.length - 1] !== b) window.__bar.push(b); const st = c?.dataset.state; if (st && window.__states[window.__states.length - 1] !== st) window.__states.push(st); }).observe(document.getElementById('messages'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-state'] }); });
  await ui.fill('#prompt', 'Can you find the lab TA on that site?');
  await ui.press('#prompt', 'Enter');
  const working = await waitFor(() => ui.evaluate((s) => document.querySelector(s)?.querySelector('.act-sub')?.textContent, card()));
  check('a Browser card appears: icon, "Browser", "Working · <task>"', working === 'Working · Find lab TA' && (await ui.evaluate((s) => document.querySelector(`${s} .act-title`)?.textContent === 'Browser' && Boolean(document.querySelector(`${s} .act-icon svg`)), card())), working);
  check('the narration before a step is the card\'s live line, not a bubble of its own', await ui.evaluate(() => { const c = document.querySelector('#messages .act-card'); return /Digging through the pages/.test(c?.querySelector('.act-say')?.textContent || '') && ![...document.querySelectorAll('#messages .msg.assistant')].some((n) => /Digging through the pages/.test(n.textContent)); }), 'live line');
  check('the card is a labelled group', await ui.evaluate((s) => /Browser\./.test(document.querySelector(s)?.getAttribute('aria-label') || '') && document.querySelector(s).getAttribute('role') === 'group', card()), 'aria');
  check('a step row has a spinner and a ticking timer while it runs', await waitFor(() => ui.evaluate(() => { const r = document.querySelector('#messages .step.running[data-t0]'); return Boolean(r && /\d/.test(r.querySelector('.step-time')?.textContent || '')); }), 9000), 'no timer');
  console.log('      visibility:', await ui.evaluate(() => document.visibilityState + ' hidden=' + document.hidden));
  const firstThumb = await waitFor(() => ui.evaluate((s) => document.querySelector(`${s} .act-thumb`)?.getAttribute('src')?.startsWith('data:image/jpeg') && document.querySelector(`${s} .act-thumb`).src, card()), 12000);
  check('the live thumbnail shows (a JPEG of the tab)', Boolean(firstThumb), firstThumb);
  const pixel = (s) => ui.evaluate(async (sel) => {
    const img = document.querySelector(`${sel} .act-thumb`);
    await img.decode().catch(() => {});
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(Math.floor(c.width * 0.9), Math.floor(c.height * 0.9), 1, 1).data; // (the page's plain background, away from the big heading)
    return { w: img.naturalWidth, h: img.naturalHeight, rgb: [d[0], d[1], d[2]], a: d[3] };
  }, s);
  console.log('      card rect:', J(await ui.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width, vh: innerHeight, vw: innerWidth, vis: document.visibilityState, io: typeof IntersectionObserver }; }, card())));
  console.log('      thumbs state:', J(await app.evaluate(() => ({ v: global.__thumbsState.visible(), by: global.__thumbsState.by() }))));
  const p1 = await pixel(card());
  const dpr = await ui.evaluate(() => window.devicePixelRatio);
  check('the thumbnail is not blank (a coloured page)', p1.a === 255 && Math.max(...p1.rgb) > 120 && Math.max(...p1.rgb) - Math.min(...p1.rgb) > 60, J(p1));
  check('the thumbnail is pixel-sharp: its displayed width (340 CSS px) times the display scale, the whole viewport of the page scaled by the compositor (the card crops it to 16:10 at the top: object-fit cover), never wider than 16:10', Math.abs(p1.w - Math.round(340 * dpr)) <= 3 && p1.w / p1.h <= 1.65, J({ p1, dpr }));
  const changed = await waitFor(async () => { const src = await ui.evaluate((s) => document.querySelector(`${s} .act-thumb`)?.src, card()); return src && src !== firstThumb; }, 14000);
  check('the thumbnail updates while the AI works (its src changes)', Boolean(changed), 'same frame');
  // (the first frame can still show the page that was open before the AI navigated, or already the new one: wait for the card to follow the AI to
  // another page, whichever came first, instead of reading one frame at a moment that depends on the timing)
  const colourGap = (a, b) => Math.abs(a.rgb[0] - b.rgb[0]) + Math.abs(a.rgb[2] - b.rgb[2]);
  let p2 = await pixel(card());
  const followed = await waitFor(async () => { p2 = await pixel(card()); return colourGap(p1, p2) > 150; }, 14000);
  check('…and follows the page (the second page has another colour)', Boolean(followed), J([p1, p2]));
    await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 40000);
  // The run's final frame (a capture under way when the run ended) lands after "done" and is saved with the reply: a nativeImage decode, resize
  // and encode on the main process, 15-30 ms, once. Let it land inside the whole-run check below (50 ms, which still includes it), so that the
  // "15 captures in a row" check (20 ms) measures captures and not whatever the run was finishing at the time (it landed in the burst at random).
  for (let last = -1, since = Date.now(); Date.now() - since < 900;) { const n = await app.evaluate(() => global.__thumbsState.captures || 0); if (n !== last) { last = n; since = Date.now(); } await sleep(100); }
  const doneSub = await ui.evaluate((s) => document.querySelector(`${s} .act-sub`)?.textContent, card());
  const statusSeq = await ui.evaluate(() => window.__status);
  const liveShape = await ui.evaluate((s) => { const c = document.querySelector(s); return { aria: c.querySelectorAll('[aria-live]').length, status: c.querySelectorAll('[role="status"]').length }; }, card());
  const barSeq = await ui.evaluate(() => window.__bar);
  const stateSeq = await ui.evaluate(() => window.__states);
  const gaps = statusSeq.slice(1, -1).map((x, i) => Math.round(x.at - statusSeq[i].at)); // (between announcements, the last one being the Done, which is not held back)
  check('the status bar follows the current step and ends as "Done: <result>"', barSeq.length >= 3 && barSeq.some((t) => /^Opening 127\.0\.0\.1/.test(t)) && barSeq.slice(0, -1).every((t) => !/^Done/.test(t)) && /^Done: Found it on the second page$/.test(barSeq[barSeq.length - 1]) && !/^Done: (Opening|Waiting|Clicking)/.test(barSeq[barSeq.length - 1]), J(barSeq));
  check('the card is "working" for the whole turn and "completed" only at its end', J(stateSeq) === '["working","completed"]', J(stateSeq));
  check('one polite live region announces the bar, throttled (≥ 1.4 s apart), and Done at the end', liveShape.aria === 1 && liveShape.status === 1 && statusSeq.length >= 2 && /^Done: /.test(statusSeq[statusSeq.length - 1].t) && gaps.every((g) => g >= 1400), J([statusSeq, liveShape, gaps]));
  check('when the run ends the card says "Done · <task>"', doneSub === 'Done · Find lab TA', doneSub);
  check('a closing narration line follows the card', await ui.evaluate(() => /Found it on the second page/.test([...document.querySelectorAll('#messages .msg.assistant')].pop()?.textContent || '')), 'no reply');
  const summary = await ui.evaluate((s) => document.querySelector(`${s} .act-steps > summary`)?.textContent, card());
  check('the steps are folded under "N steps"', /^5 steps$/.test(summary), summary + ' ' + J(consoleErrors.slice(0, 6)) + ' ' + J(await ui.evaluate(() => window.__evlog)));
  const lines = await ui.evaluate((s) => [...document.querySelectorAll(`${s} .act-list .step .step-detail`)].map((n) => n.textContent), card());
  check('each step is one readable line (the site, not the whole address)', lines.length === 5 && /^Opening 127\.0\.0\.1/.test(lines[0]) && lines.every((l) => !/https?:\/\//.test(l)), J(lines));
  const stoppedTimers = await ui.evaluate(() => document.querySelectorAll('#messages .step.running').length);
  check('no step is left running and the timer is gone', stoppedTimers === 0 && (await ui.evaluate(() => document.querySelectorAll('#messages .step[data-t0]').length)) === 0, String(stoppedTimers));

  // the probes: main thread and chat renderer stayed free while thumbnails refreshed
  const gap = await app.evaluate(() => {
    const w = global.__thumbsState.windows || [];
    const during = global.__slProbe.big.filter(([end, g]) => w.some(([s, e]) => end - g < e + 3 && end > s - 3)); // gaps that overlap a thumbnail capture
    return { max: Math.round(global.__slProbe.max), n: global.__slProbe.n, captures: w.length + (global.__thumbsState.frames || 0), avgCaptureMs: Math.round(w.reduce((n, [s, e]) => n + (e - s), 0) / Math.max(1, w.length)), overCaptures: Math.round(Math.max(0, ...during.map((d) => d[1]))), all: global.__slProbe.big.map(([t, g]) => [Math.round(t), Math.round(g)]) };
  });
  console.log('      main-process gaps over 10 ms:', J(gap.all), 'captures:', gap.captures, 'average wall time per capture (ms):', gap.avgCaptureMs);
  const longTasks = await ui.evaluate(() => window.__long);
  const thumbsSeen = await ui.evaluate(() => window.__thumbs);
  check('thumbnails were refreshed several times, each a small JPEG (≤ 60 KB)', thumbsSeen.length >= 3 && thumbsSeen.every((t) => t.bytes <= 60000), J(thumbsSeen));
  check('over the whole run the main process never stalled more than 50 ms (page loads and tab changes included)', gap.n > 100 && gap.captures >= 3 && gap.max <= 50, J(gap));
  await app.evaluate(() => { global.__slProbe.max = 0; global.__slProbe.big = []; });
  const burstBytes = await app.evaluate(() => global.__thumbsState.burst(15));
  const burst = await app.evaluate(() => ({ max: Math.round(global.__slProbe.max), big: global.__slProbe.big.map(([t, g]) => Math.round(g)) }));
  check('15 captures in a row (encode and send included): the main process never stalls more than 20 ms (setImmediate gap)', burstBytes > 15 * 500 && burst.max <= 20, J({ burstBytes, burst }));
  check('no long task over 50 ms in the chat renderer', longTasks.length === 0, J(longTasks));

  // ---- the card's switch for the tabs the AI opened: hide / show them in the strip, in step with the sidebar's own toggle
  const aiTabsInStrip = () => ui.evaluate(() => document.querySelectorAll('#tabs .tab.ai-opened').length);
  const toggleText = () => ui.evaluate((s) => { const b = document.querySelector(`${s} .act-toggle`); return b && !b.hidden ? b.textContent : null; }, card());
  await waitFor(async () => (await toggleText()) !== null, 8000);
  check('the card offers "Hide tabs the AI opened (N)" next to "Open preview"', (await toggleText()) === 'Hide tabs the AI opened (1)' && (await ui.evaluate((s) => document.querySelector(`${s} .act-toggle`).parentElement === document.querySelector(`${s} .act-btn`).parentElement, card())), String(await toggleText()));
  check('before: the AI\'s tab is in the strip, the sidebar toggle is off', (await aiTabsInStrip()) === 1 && (await ui.evaluate(() => document.getElementById('hide-ai-tabs').getAttribute('aria-pressed'))) === 'false', J([await aiTabsInStrip()]));
  await ui.click(`${card()} .act-toggle`);
  check('clicking it hides the AI\'s tabs from the strip, the sidebar toggle follows, and the card now says "Show…"', await waitFor(async () => (await aiTabsInStrip()) === 0 && (await ui.evaluate(() => document.getElementById('hide-ai-tabs').getAttribute('aria-pressed'))) === 'true' && (await toggleText()) === 'Show tabs the AI opened (1)', 6000), J([await aiTabsInStrip(), await toggleText()]));
  check('the setting is the same one the sidebar toggle uses (hideAiTabs)', (await app.evaluate(() => global.__settings.backend.prefs?.().hideAiTabs ?? null)) !== false, 'setting');
  await ui.click(`${card()} .act-toggle`);
  check('clicking again shows them again', await waitFor(async () => (await aiTabsInStrip()) === 1 && (await ui.evaluate(() => document.getElementById('hide-ai-tabs').getAttribute('aria-pressed'))) === 'false' && (await toggleText()) === 'Hide tabs the AI opened (1)', 6000), J([await aiTabsInStrip(), await toggleText()]));
  await ui.evaluate(() => document.getElementById('hide-ai-tabs').click());
  check('the sidebar\'s own toggle moves the card\'s too', await waitFor(async () => (await toggleText()) === 'Show tabs the AI opened (1)' && (await aiTabsInStrip()) === 0, 6000), String(await toggleText()));
  await ui.evaluate(() => document.getElementById('hide-ai-tabs').click());
  check('…and back', await waitFor(async () => (await toggleText()) === 'Hide tabs the AI opened (1)' && (await aiTabsInStrip()) === 1, 6000), String(await toggleText()));

  // ---- Open preview: a tab still open is switched to; a closed one is reopened from its URL
  const runTab = (await ui.evaluate(() => window.__thumbs)).pop(); // (the last frame the chat was sent, read now: one that landed after the run's end counts, and the card shows it)
  const other = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 4000); }); return t.id; }, `${base}/c?other`);
  await app.evaluate((_e, id) => global.__tabChats.setSidebar(id, true), other); // (the sidebar is per tab: this one shows it too)
  await sleep(500);
  check('another tab is in front before the click', (await app.evaluate(() => global.__agent.browser.activeTab()?.id)) === other, 'front');
  await ui.click(`${card()} .act-btn`);
  check('"Open preview" switches to the tab the AI worked in', await waitFor(async () => (await app.evaluate(() => global.__agent.browser.activeTab()?.id)) === runTab.tabId, 5000), `want ${runTab.tabId}`);
  const tabsBefore = await app.evaluate(() => global.__chatPage.tabs().length);
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), runTab.tabId);
  await sleep(600);
  await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); }); // (each tab has its own sidebar)
  await sleep(500);
  await ui.click(`${card()} .act-btn`);
  const reopened = await waitFor(async () => app.evaluate((_e, u) => { const a = global.__agent.browser.activeTab(); return a && a.id !== undefined && a.webContents.getURL() === u ? a.id : null; }, runTab.url), 6000);
  check('a closed tab is reopened from its URL', Boolean(reopened) && reopened !== runTab.tabId && tabsBefore >= 1, J({ reopened, runTab }));
  check('the button explains itself (tooltip) and the picture opens it too', await ui.evaluate((s) => /Switch to this tab/.test(document.querySelector(`${s} .act-btn`).title) && typeof document.querySelector(`${s} .act-shot`).onclick === 'function', card()), 'title');

  // ---- steps open on demand (the browser card's rows), keyboard too
  await ui.evaluate((s) => { document.querySelector(`${s} .act-steps > summary`).click(); }, card());
  await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); }); // (the reopened tab has its own sidebar)
  await sleep(500);
  const row = `${card()} .act-list .step[data-more]`;
  check('a step is collapsed by default and reachable by keyboard', await ui.evaluate((r) => { const n = document.querySelector(r); return n.getAttribute('aria-expanded') === 'false' && n.tabIndex === 0 && !n.querySelector('.step-more'); }, row), 'state');
  await ui.focus(row);
  await ui.press(row, 'Enter');
  await sleep(200);
  console.log('      after Enter:', J(await ui.evaluate((r) => { const n = document.querySelector(r); return { exp: n.getAttribute('aria-expanded'), focus: document.activeElement === n, active: document.activeElement?.className, more: Boolean(n.querySelector('.step-more')) }; }, row)));
  check('Enter opens it: the input of the call', await ui.evaluate((r) => { const n = document.querySelector(r); return n.getAttribute('aria-expanded') === 'true' && /"url": "http:\/\/127\.0\.0\.1:\d+\/a"/.test(n.querySelector('.step-more')?.textContent || ''); }, row), await ui.evaluate((r) => document.querySelector(r).textContent, row));

  // ---- history: the final frame is there after a reload
  await sleep(1200);
  await ui.reload();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  const restored = await waitFor(() => ui.evaluate((s) => { const c = document.querySelector(s); const i = c?.querySelector('.act-thumb'); return c && i && i.src.startsWith('data:image/jpeg') && { sub: c.querySelector('.act-sub').textContent, btn: !c.querySelector('.act-btn').hidden }; }, card()), 15000);
  check('a reopened chat shows the card with its final frame and "Done · <task>"', restored && restored.sub === 'Done · Find lab TA' && restored.btn, J(restored));
  const p3 = await pixel(card());
  check('the saved frame is not blank', p3.a === 255 && Math.max(...p3.rgb) > 120, J(p3));
  check('…and it is the small one (≤ 60 KB as text): the sharp live frame is scaled down when the reply is saved', (await ui.evaluate((sel) => document.querySelector(`${sel} .act-thumb`).src.length, card())) <= 60000 && p3.w <= 420, J(p3));
  check('…and its steps are there, folded', await ui.evaluate((s) => /^5 steps$/.test(document.querySelector(`${s} .act-steps > summary`)?.textContent || ''), card()), 'summary');

  // ---- narration does not split a card: one turn is one card (two steps with a line of narration between them)
  await ui.click('#new-chat');
  await sleep(400);
  await ui.fill('#prompt', 'Please check two pages');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('#messages .act-card').length >= 1), 40000);
  const oneCard = await ui.evaluate(() => [...document.querySelectorAll('#messages .act-card')].map((c) => [c.querySelector('.act-sub').textContent, c.querySelector('.act-steps > summary').textContent]));
  check('a line of narration between steps does not start a new card: one card, 2 steps, Done', oneCard.length === 1 && /^Done · /.test(oneCard[0][0]) && oneCard[0][1] === '2 steps', J(oneCard));

  // ---- the exact tab: tabs A (the user looks at it) and B (the AI acts on it)
  const openAndWait = (u) => app.evaluate(async (_e, url) => { const t = global.__agent.browser.openTab(url); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 4000); }); return t.id; }, u);
  const tabA = await openAndWait(`${base}/a?A`);
  const tabB = await openAndWait(`${base}/b?B`);
  await app.evaluate((_e, ids) => { global.__slTabs = ids; global.__agent.browser.switchTab(ids.A); global.__tabChats.setSidebar(ids.A, true); }, { A: tabA, B: tabB });
  await sleep(600);
  const front = () => app.evaluate(() => global.__agent.browser.activeTab()?.id);
  const fresh = async (prompt) => {
    await ui.click('#new-chat');
    await sleep(400);
    await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
    await ui.evaluate(() => { window.__bar = []; window.__states = []; window.__chips = []; window.__tools = []; window.__thumbEv = []; if (window.__evHooked) return; window.__evHooked = true; new MutationObserver(() => { const c = document.querySelector('#messages .act-card[data-surface="browser"]'); const ch = c?.querySelector('.act-tabref .tab-ref-title')?.textContent; if (ch && window.__chips[window.__chips.length - 1] !== ch) window.__chips.push(ch); const b = c?.querySelector('.act-status-text')?.textContent; if (b && window.__bar[window.__bar.length - 1] !== b) window.__bar.push(b); const st = c?.dataset.state; if (st && window.__states[window.__states.length - 1] !== st) window.__states.push(st); }).observe(document.getElementById('messages'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-state'] }); window.assistant.onEvent((e) => { if (e.type === 'tool') window.__tools.push({ name: e.name, at: Date.now() }); if (e.type === 'thumb') window.__thumbEv.push({ kind: e.kind || 'frame', tabId: e.tabId, hasData: Boolean(e.data), at: Date.now() }); }); });
    await ui.fill('#prompt', prompt);
    await ui.press('#prompt', 'Enter');
  };
  const running = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
  const finished = () => waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('#messages .act-card').length >= 1), 60000);
  const chipTitle = () => ui.evaluate((s) => document.querySelector(`${s} .act-tabref .tab-ref-title`)?.textContent || '', card());
  const isBlue = (p) => p.a === 255 && p.rgb[2] > 150 && p.rgb[0] < 110;
  const isRed = (p) => p.a === 255 && p.rgb[0] > 150 && p.rgb[2] < 110;
  await fresh('Hop between tabs please');
  const onB = await waitFor(async () => (await chipTitle()) === 'Page /b?B', 20000);
  check('the AI acts on tab B while the user looks at tab A: the chip names tab B', Boolean(onB) && (await front()) === tabA && (await running()), J([await chipTitle(), await front(), tabA, tabB]));
  const bluePx = await waitFor(async () => { const p = await pixel(card()); return isBlue(p) && p; }, 12000);
  check('…and the preview pixels are tab B\'s (blue), not the page in front (red)', Boolean(bluePx) && (await front()) === tabA, J(await pixel(card())));
  const backOnA = await waitFor(async () => (await chipTitle()) === 'Page /a?A', 25000);
  const redPx = await waitFor(async () => { const p = await pixel(card()); return isRed(p) && p; }, 12000);
  check('after a call on tab A the chip and the preview switch to A (red)', Boolean(backOnA) && Boolean(redPx), J([await chipTitle(), await pixel(card())]));
  await finished();
  const tabsEv = await ui.evaluate(() => ({ chips: window.__chips, thumbs: window.__thumbEv }));
  check('the chip went B then A, one card the whole time, and the picture never lagged behind the chip', J(tabsEv.chips) === '["Page /b?B","Page /a?A"]' && (await ui.evaluate(() => document.querySelectorAll('#messages .act-card').length)) === 1, J(tabsEv));
  check('every frame was of the tab named by the chip at that moment (tab ids B then A)', (() => { const ids = tabsEv.thumbs.filter((t) => t.hasData).map((t) => t.tabId); const firstA = ids.indexOf(tabA); return ids.includes(tabB) && firstA > ids.indexOf(tabB) && ids.slice(0, firstA).every((i) => i === tabB) && ids.slice(firstA).every((i) => i === tabA); })(), J(tabsEv.thumbs));

  await fresh('Look at four things please');
  // The card must visibly update during the run (a report: "the cards are not updating"): its steps, status bar, preview and chip all change,
  // in the same card, with the thumbnail gate (the chat reports a card on screen) open the whole time. With a card per narration line the
  // first card stopped at its step and only the last one was live.
  await waitFor(() => running(), 10000);
  const samples = [];
  for (let i = 0; i < 400 && (samples.length < 3 || (await running())); i++) {
    samples.push({ ...(await ui.evaluate(() => { const cs = [...document.querySelectorAll('#messages .act-card')]; const c = cs[0]; if (!c) return { n: 0 }; const src = c.querySelector('.act-thumb').getAttribute('src') || ''; return { n: cs.length, steps: c.querySelector('.act-steps > summary').textContent, src: src.length + ':' + src.slice(-24), say: c.querySelector('.act-say').hidden ? '' : c.querySelector('.act-say').textContent, bar: c.querySelector('.act-status-text').textContent, chip: c.querySelector('.act-tabref .tab-ref-title')?.textContent || '', state: c.dataset.state }; })), gate: await app.evaluate(() => global.__thumbsState.visible()) });
    await sleep(120);
  }
  const live = samples.filter((x) => x.n > 0);
  const distinct = (k) => new Set(live.map((x) => x[k])).size;
  check('while the AI works, ONE card updates: its steps count 1 to 4, the status bar changing (the three openings of one site read alike), new pictures, the chip following', live.every((x) => x.n === 1) && distinct('steps') >= 4 && distinct('bar') >= 2 && distinct('src') >= 3 && distinct('chip') >= 2, J({ n: samples.length, cards: [...new Set(live.map((x) => x.n))], steps: [...new Set(live.map((x) => x.steps))], bars: distinct('bar'), pics: distinct('src'), chips: [...new Set(live.map((x) => x.chip))] }));
  check('…and the preview gate (a card on screen) stayed open the whole run', samples.length >= 5 && samples.filter((x) => x.state === 'working').every((x) => x.gate === true), J(samples.map((x) => [x.state, x.gate])));
  await finished();
  const four = await ui.evaluate(() => {
    const cards = [...document.querySelectorAll('#messages .act-card')];
    const c = cards[0];
    return { cards: cards.length, steps: c.querySelector('.act-steps > summary').textContent, rows: [...c.querySelectorAll('.act-list .step')].filter((n) => n.tagName !== 'SUMMARY').length, sub: c.querySelector('.act-sub').textContent, bar: c.querySelector('.act-status-text').textContent, used: [...document.querySelectorAll('#messages .step, #messages summary')].filter((n) => /^Used \d+ browser action/.test(n.textContent)).length, said: [...document.querySelectorAll('#messages .msg.assistant')].map((n) => n.textContent.trim()).join('|'), outside: cards.every((x) => !x.querySelector('.msg')), after: Boolean(cards[0].nextElementSibling && [...document.querySelectorAll('#messages .msg.assistant')].every((b) => cards[0].compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)), states: window.__states };
  });
  check('one turn with 4 browser calls and narration between them: exactly 1 card with 4 steps', four.cards === 1 && four.steps === '4 steps' && four.rows === 4 && // (the three page openings share one group; its summary line is not a step)
     four.used === 0 && four.outside, J(four));
  check('…its narration lines were its live line (each shown in turn) and only the final answer is a bubble, under the card', ['One.', 'Two.', 'Three.', 'Four.'].every((t) => live.some((x) => x.say === t)) && four.said.startsWith('All four done.') && ['One.', 'Two.', 'Three.', 'Four.'].every((t) => !four.said.includes(t)) && four.after, J({ says: [...new Set(live.map((x) => x.say))], said: four.said, after: four.after }));
  check('…it said Done only when the whole turn ended, and the bar ends as Done', J(four.states) === '["working","completed"]' && /^Done · /.test(four.sub) && /^Done: /.test(four.bar), J(four));
  check('…its chip and preview are the tab of the last call (tab B), while tab A was in front', (await chipTitle()) === 'Page /b?B' && isBlue(await pixel(card())) && (await front()) === tabA, J([await chipTitle(), await pixel(card()), await front()]));
  await ui.reload();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  const restoredFour = await waitFor(() => ui.evaluate((s) => { const n = document.querySelectorAll('#messages .act-card'); const i = document.querySelector(`${s} .act-thumb`); return n.length === 1 && i && i.src.startsWith('data:image/jpeg') && { steps: n[0].querySelector('.act-steps > summary').textContent, bar: n[0].querySelector('.act-status-text').textContent }; }, card()), 15000);
  check('a reopened chat renders the same single card (4 steps, Done, the last frame)', restoredFour && restoredFour.steps === '4 steps' && /^Done: /.test(restoredFour.bar), J(restoredFour));

  // ---- the card's Tabs list: every tab the turn used, in order, open or closed; a closed one reopens from its chip
  const tabB2 = await openAndWait(`${base}/b?B2`);
  await app.evaluate((_e, ids) => { global.__slTabs = ids; global.__agent.browser.switchTab(ids.A); global.__tabChats.setSidebar(ids.A, true); }, { A: tabA, B: tabB2 });
  await sleep(600);
  await fresh('Please close the other tab');
  await finished();
  const tabsOf = () => ui.evaluate((s) => { const c = document.querySelector(s); const box = c.querySelector('.act-tabs'); return { shown: !box.hidden, open: box.open, head: box.querySelector('.act-tabs-head').textContent, tabs: [...c.querySelectorAll('.act-tab')].map((w) => [w.querySelector('.tab-ref-title').textContent, w.dataset.state, w.querySelector('.act-tab-state').textContent]) }; }, card());
  const closedList = await waitFor(async () => { const t = await tabsOf(); return t.tabs.length === 2 && t.tabs[0][1] === 'closed' && t; }, 15000);
  check('under the card: "Tabs · 2 opened, 1 closed", in the order the tabs were first touched', closedList && closedList.shown && closedList.head === 'Tabs · 2 opened, 1 closed' && closedList.tabs[0][0] === 'Page /b?B2' && closedList.tabs[1][0] === 'Page /a?A', J(closedList || await tabsOf()));
  check('the tab the AI used and left open is marked open; the one it closed is marked closed', closedList && closedList.tabs[0][2] === 'closed' && closedList.tabs[1][1] === 'open' && closedList.tabs[1][2] === 'open' && !(await app.evaluate((_e, id) => Boolean(global.__agent.browser.tabById?.(id)), tabB2)), J(closedList));
  check('the "Hide tabs / Close them" actions are still next to it', await ui.evaluate((s) => { const c = document.querySelector(s); return c.querySelector('.act-tabs').nextElementSibling === c.querySelector('.act-actions') && Boolean(c.querySelector('.act-actions .act-btn')); }, card()), 'order');
  const nowTabs = await app.evaluate(() => global.__chatPage.tabs().length);
  check('the Tabs list starts folded, even with only a few tabs', closedList && closedList.open === false, J(closedList && closedList.open));
  await ui.click(`${card()} .act-tabs-head`); // the user opens it
  await ui.click(`${card()} .act-tab[data-state="closed"] .tab-ref`);
  const reopenedB = await waitFor(() => app.evaluate((_e, u) => { const a = global.__agent.browser.activeTab(); return a && a.webContents.getURL() === u ? a.id : null; }, `${base}/b?B2`), 8000);
  check('clicking the closed chip reopens that page in a tab', Boolean(reopenedB) && reopenedB !== tabB2 && nowTabs >= 1, J({ reopenedB, tabB2 }));
  await ui.reload();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  const restoredTabs = await waitFor(async () => { const t = await tabsOf().catch(() => null); return t && t.tabs.length === 2 && t; }, 15000);
  check('a reopened chat keeps the Tabs list (both tabs, in order, with the closed one marked)', restoredTabs && restoredTabs.tabs[0][0] !== undefined && /^Tabs · 2 opened/.test(restoredTabs.head), J(restoredTabs));
  const folded = await ui.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    const turn = { cards: [], card: null, plain: null, working: null };
    for (let i = 1; i <= 5; i++) window.stepUI.add(turn, { name: 'get_console', input: { tab_id: 9000 + i }, id: 'x' + i, label: 'Reading the page console' }, { messages: host, append: (n) => host.append(n), task: '' });
    const d = host.querySelector('.act-tabs');
    const r = { open: d.open, head: d.querySelector('summary').textContent, n: host.querySelectorAll('.act-tab').length };
    host.remove();
    return r;
  });
  check('more than 4 tabs: the list is folded by default and says how many', folded.open === false && folded.n === 5 && folded.head === 'Tabs · 5 opened', J(folded));

  // ---- a blank frame is never shown: the tab's name instead (or the last good picture of the same tab)
  const blankCase = await ui.evaluate(async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const turn = { cards: [], card: null, plain: null, working: null };
    window.stepUI.add(turn, { name: 'get_console', input: { tab_id: 77 }, id: 'b1', label: 'Reading the page console' }, { messages: host, append: (n) => host.append(n), task: '' });
    const c = host.querySelector('.act-card');
    const state = () => { const sh = c.querySelector('.act-shot'); return { hidden: sh.hidden, mode: sh.dataset.mode || '', text: c.querySelector('.act-site-name').textContent, src: c.querySelector('.act-thumb').hasAttribute('src') }; };
    const out = {};
    window.stepUI.thumb(turn, { type: 'thumb', kind: 'blank', data: '', tabId: 77, url: 'file:///x/Chapter%205%20Final.pptx', title: 'Chapter 5 Final.pptx', favicon: null });
    out.first = state();
    const cv = document.createElement('canvas'); cv.width = 20; cv.height = 12; const x = cv.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 10, 12); x.fillStyle = '#33c'; x.fillRect(10, 0, 10, 12);
    window.stepUI.thumb(turn, { type: 'thumb', data: cv.toDataURL('image/jpeg').split(',')[1], tabId: 77, url: 'file:///x/a', title: 'A' });
    out.frame = state();
    window.stepUI.thumb(turn, { type: 'thumb', kind: 'blank', data: '', tabId: 77, url: 'file:///x/a', title: 'A' });
    out.sameTab = state();
    window.stepUI.thumb(turn, { type: 'thumb', kind: 'blank', data: '', tabId: 78, url: 'lumen-pdf://app/viewer.html', title: 'Report.pdf' });
    out.otherTab = state();
    host.remove();
    return out;
  });
  check('a blank frame shows "Reading <name>" instead of a rectangle', blankCase.first.mode === 'site' && blankCase.first.text === 'Reading Chapter 5 Final.pptx' && !blankCase.first.src && !blankCase.first.hidden, J(blankCase.first));
  check('…a real frame replaces it; a blank one of the same tab then leaves that picture; one of another tab shows its name', blankCase.frame.mode === 'frame' && blankCase.frame.src && blankCase.sameTab.mode === 'frame' && blankCase.sameTab.src && blankCase.otherTab.mode === 'site' && blankCase.otherTab.text === 'Reading Report.pdf' && !blankCase.otherTab.src, J(blankCase));

  // ---- the slides viewer and the PDF viewer, read in the background: a real picture or the name, never a solid black rectangle
  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const deckFile = path.join(docsDir, 'Chapter 5 Final.pptx');
  fs.writeFileSync(deckFile, F.deck({ slides: [{ shapes: F.rect({ id: 2, box: { x: 100, y: 100, w: 500, h: 150 }, color: 'FFFFFF', text: 'Explain last two bullet' }) }] }));
  const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>'];
  const pdfStream = '0 0 0 rg 72 560 300 120 re f BT /F1 36 Tf 72 500 Td (Page 1 of 1) Tj ET';
  pdfObjects.push(`<< /Length ${pdfStream.length} >>\nstream\n${pdfStream}\nendstream`);
  let pdfText = '%PDF-1.4\n';
  const pdfOffsets = pdfObjects.map((body, i) => { const at = pdfText.length; pdfText += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const pdfXref = pdfText.length;
  pdfText += `xref\n0 ${pdfObjects.length + 1}\n0000000000 65535 f \n${pdfOffsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${pdfObjects.length + 1} /Root 1 0 R >>\nstartxref\n${pdfXref}\n%%EOF\n`;
  const pdfFile = path.join(docsDir, 'Report.pdf');
  fs.writeFileSync(pdfFile, Buffer.from(pdfText, 'latin1'));
  const openFile = async (file, hint) => {
    const id = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, pathToFileURL(file).href);
    await waitFor(() => app.evaluate((_e, [i, h]) => { const t = global.__agent.browser.tabById?.(i); return Boolean(t) && h.test(t.webContents.getURL()); }, [id, hint]).catch(() => false), 20000);
    return id;
  };
  const tabS = await openFile(deckFile, /slides\.html/);
  const tabP = await openFile(pdfFile, /lumen-pdf|\.pdf/i);
  await sleep(1500);
  await app.evaluate((_e, ids) => { global.__slTabs = ids; global.__agent.browser.switchTab(ids.A); global.__tabChats.setSidebar(ids.A, true); }, { A: tabA, B: tabB2, S: tabS, P: tabP });
  await sleep(600);
  const shotState = () => ui.evaluate(async (s) => {
    const c = document.querySelector(s);
    const sh = c.querySelector('.act-shot');
    const mode = sh.hidden ? 'hidden' : sh.dataset.mode;
    const out = { mode, site: sh.querySelector('.act-site-name').textContent, chip: c.querySelector('.act-tabref .tab-ref-title')?.textContent || '' };
    const img = c.querySelector('.act-thumb');
    if (mode === 'frame' && img.getAttribute('src')) {
      await img.decode().catch(() => {});
      const cv = document.createElement('canvas'); cv.width = 40; cv.height = 25;
      const x = cv.getContext('2d'); x.drawImage(img, 0, 0, 40, 25);
      const d = x.getImageData(0, 0, 40, 25).data;
      const lo = [255, 255, 255]; const hi = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d[i + k]); hi[k] = Math.max(hi[k], d[i + k]); }
      out.range = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      out.max = Math.max(...hi);
    }
    return out;
  }, card());
  const okShot = (st) => (st.mode === 'frame' && st.range > 12 && st.max > 30) || (st.mode === 'site' && /^Reading .{3,}/.test(st.site));
  await fresh('Look at the viewers please');
  const settled = () => waitFor(async () => { const st = await shotState().catch(() => null); return st && (st.mode === 'frame' || st.mode === 'site') && st; }, 15000);
  const slidesShot = await settled();
  console.log('      viewer preview (slides):', J(slidesShot));
  check('the AI reads a slides-viewer tab: the preview is a real picture or "Reading <name>", never a solid black rectangle', Boolean(slidesShot) && okShot(slidesShot), J(slidesShot));
  await waitFor(() => ui.evaluate(() => window.__tools.length >= 2), 20000);
  await sleep(1500);
  const pdfShot = await settled();
  console.log('      viewer preview (pdf):', J(pdfShot));
  check('…and for a PDF-viewer tab', Boolean(pdfShot) && okShot(pdfShot) && pdfShot.chip !== slidesShot?.chip, J({ slidesShot, pdfShot }));
  await finished();

  // ---- ONE card for the whole turn, whatever the surfaces: a browser step, a files step, a browser step again
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), tabA);
  await fresh('Please mix the surfaces');
  await ui.evaluate(() => { window.__titles = []; const f = () => { const c = document.querySelector('#messages .act-card'); const t = c?.querySelector('.act-title')?.textContent; if (t && window.__titles[window.__titles.length - 1] !== t) window.__titles.push(t); }; new MutationObserver(f).observe(document.getElementById('messages'), { subtree: true, childList: true, characterData: true }); });
  await waitFor(() => ui.evaluate(() => window.__tools.length >= 2), 20000);
  await sleep(700);
  const midFiles = await ui.evaluate(() => { const c = document.querySelector('#messages .act-card'); return { n: document.querySelectorAll('#messages .act-card').length, title: c.querySelector('.act-title').textContent, surface: c.dataset.surface, shot: getComputedStyle(c.querySelector('.act-shot')).display, bar: c.querySelector('.act-status-text').textContent, say: c.querySelector('.act-say').textContent, state: c.dataset.state }; });
  check('mid-turn on a files step: still ONE card, now "Computer", the tab preview is out of the way and the status says what it does', midFiles.n === 1 && midFiles.title === 'Computer' && midFiles.surface === 'shell' && midFiles.shot === 'none' && midFiles.state === 'working' && /^(Listing|Looking|Reading|Checking|Using)/i.test(midFiles.bar) && /^Checking my downloads\./.test(midFiles.say), J(midFiles));
  await finished();
  const mixed = await ui.evaluate(() => {
    const cards = [...document.querySelectorAll('#messages .act-card')];
    const c = cards[0];
    const bubbles = [...document.querySelectorAll('#messages .msg.assistant')];
    return { n: cards.length, title: c.querySelector('.act-title').textContent, steps: c.querySelector('.act-steps > summary').textContent, surfs: [...c.querySelectorAll('.act-list .step[data-surf]')].filter((r) => r.tagName !== 'SUMMARY').map((r) => r.dataset.surf + ':' + r.dataset.surfLabel), titles: window.__titles, bar: c.querySelector('.act-status-text').textContent, shot: getComputedStyle(c.querySelector('.act-shot')).display, bubbles: bubbles.map((b) => b.textContent.trim().slice(0, 40)), after: bubbles.length === 1 && Boolean(c.compareDocumentPosition(bubbles[0]) & Node.DOCUMENT_POSITION_FOLLOWING), state: c.dataset.state };
  });
  check('one turn mixing browser, files and browser steps with narration between them renders exactly 1 card (3 steps, Done at the end)', mixed.n === 1 && mixed.steps === '3 steps' && mixed.state === 'completed' && /^Done: /.test(mixed.bar), J(mixed));
  check('its title followed the step (Browser, Computer, Browser) and each step is marked with its surface', J(mixed.titles) === '["Browser","Computer","Browser"]' && mixed.title === 'Browser' && mixed.surfs.length === 3 && mixed.surfs[0] === 'browser:Browser' && mixed.surfs[1] === 'terminal:Computer' && mixed.surfs[2] === 'browser:Browser', J(mixed));
  check('the preview came back with the browser step, and the final answer is the only bubble, under the card', mixed.shot !== 'none' && mixed.after && /^All done with both/.test(mixed.bubbles[0]), J(mixed));
  await ui.reload();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  const mixedBack = await waitFor(() => ui.evaluate(() => { const cards = [...document.querySelectorAll('#messages .act-card')]; if (!cards.length) return null; const bubbles = [...document.querySelectorAll('#messages .msg.assistant')]; return { n: cards.length, steps: cards[0].querySelector('.act-steps > summary').textContent, bubbles: bubbles.map((b) => b.textContent.trim().slice(0, 20)), after: bubbles.length === 1 && Boolean(cards[0].compareDocumentPosition(bubbles[0]) & Node.DOCUMENT_POSITION_FOLLOWING) }; }), 15000);
  check('a reopened chat renders the same: one card with 3 steps, the final answer under it, no bubbles for the narration', mixedBack && mixedBack.n === 1 && mixedBack.steps === '3 steps' && mixedBack.after && /^All done with both/.test(mixedBack.bubbles[0]), J(mixedBack));

  // ---- other programs and approvals use the same card
  const synth = await ui.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    const opts = { messages: host, append: (n) => host.append(n), task: '' };
    const turn = { cards: [], card: null, plain: null, working: null };
    const cv = document.createElement('canvas'); cv.width = 32; cv.height = 20; const x = cv.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 16, 20); x.fillStyle = '#39c'; x.fillRect(16, 0, 16, 20);
    window.stepUI.add(turn, { name: 'auto_allowed', input: null, id: 'n0', label: 'Allowed automatically: reading example.com' }, opts); // (before any step: waits for the card)
    window.stepUI.add(turn, { name: 'navigate', input: { url: 'https://example.com/' }, id: 's1', label: 'Opening example.com' }, opts);
    window.stepUI.add(turn, { name: 'auto_allowed', input: null, id: 'n1', label: 'Allowed automatically: running a script on example.com' }, opts); // (after: a row in the list)
    const sawApp = window.stepUI.desktop(turn, { type: 'desktop_card', id: 'w1', app: 'Word', status: 'working', task: 'Typing the heading', thumbnail: cv.toDataURL('image/png') }, opts);
    const c = host.querySelector('.act-card');
    const out = { cards: host.querySelectorAll('.act-card').length, sawApp, notes: [...c.querySelectorAll('.act-list .step-note')].map((n) => n.textContent.slice(0, 30)), loose: [...host.children].filter((n) => !n.classList.contains('act-card')).length, title: c.querySelector('.act-title').textContent, surface: c.dataset.surface, bar: c.querySelector('.act-status-text').textContent, shot2: getComputedStyle(c.querySelector('.act-shot2')).display, shot: getComputedStyle(c.querySelector('.act-shot')).display, src2: c.querySelector('.act-thumb2').src.startsWith('data:image/png'), stop: !c.querySelector('.act-stop').hidden, open: c.querySelector('.act-btn').textContent };
    window.stepUI.desktop(turn, { type: 'desktop_card', id: 'w1', app: 'Word', status: 'paused', task: 'Typing the heading', thumbnail: null }, opts);
    out.paused = c.querySelector('.act-status-text').textContent;
    window.stepUI.finalize(turn, { type: 'done' });
    out.done = c.querySelector('.act-status-text').textContent;
    host.remove();
    return out;
  });
  check('another program on the PC joins the same card: its window is the preview, its task and name are the status, Stop and Open are there', synth.cards === 1 && synth.sawApp === true && synth.title === 'Computer' && synth.surface === 'app' && synth.shot2 !== 'none' && synth.shot === 'none' && synth.src2 && /^Typing the heading · Word$/.test(synth.bar) && synth.stop && synth.open === 'Open', J(synth));
  check('"Allowed automatically" rows are small rows in the card\'s step list (the one before the first step moved in), not lines between cards', synth.notes.length === 2 && /^Allowed automatically: reading/.test(synth.notes[0]) && synth.loose === 0, J(synth));
  check('a paused program says so in the status bar, and the card says Done when the turn ends', /^Paused/.test(synth.paused) && /^Done/.test(synth.done), J([synth.paused, synth.done]));

  // ---- Word work: the same card, with the document as its preview (Word's window, or a page of the paragraphs around the change when the window cannot be shown),
  // the document's name as the chip, the step in words, "Done" at the end. (A fake capture: a drawn picture stands in for Word's window.)
  await app.evaluate(({ ipcMain }) => { global.__wordOpened = []; ipcMain.removeHandler('desktop:open'); ipcMain.handle('desktop:open', (_e, id) => { global.__wordOpened.push(id); return true; }); }); // (the chip asks main to show Word: main's answer is recorded)
  const wordRun = await ui.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'word-host';
    host.style.cssText = 'display:flex;flex-direction:column;gap:16px;padding:16px;width:420px;background:var(--bg)';
    document.body.append(host);
    const mk = () => { const h = document.createElement('div'); host.append(h); return { h, opts: { messages: h, append: (n) => h.append(n), task: '' }, turn: { cards: [], card: null, plain: null, working: null } }; };
    const label = 'Writing in Report.docx: adding a table of 3 rows after \u201cResults\u201d';
    const lines = [
      { k: 'h1', t: 'Report', hl: false }, { k: 'p', t: 'This report covers the spring results.', hl: false }, { k: 'h2', t: 'Results', hl: false },
      { k: 'tr', t: 'Name  |  Score', hl: true }, { k: 'tr', t: 'Ann  |  9', hl: true }, { k: 'li', t: 'Scores are out of ten', hl: false }, { k: 'p', t: '<img src=x onerror="window.__xss=1"> and <b>text</b>', hl: false },
    ];
    // 1. the page preview (Word hidden, or the file route)
    const a = mk();
    window.stepUI.add(a.turn, { name: 'word', input: { action: 'table', rows: [['a'], ['b'], ['c']], at: 'after', heading: 'Results' }, id: 'ws1', label }, a.opts);
    const sawA = window.stepUI.desktop(a.turn, { type: 'desktop_card', surface: 'app', word: true, id: 'word-1', app: 'Word', doc: 'Report.docx', title: 'Report.docx', status: 'working', task: label, thumbnail: null, page: { doc: 'Report.docx', lines } }, a.opts);
    const ca = a.h.querySelector('.act-card');
    const out = {
      sawA, cards: a.h.querySelectorAll('.act-card').length, surface: ca.dataset.surface, title: ca.querySelector('.act-title').textContent, iconKind: ca.querySelector('.act-icon').dataset.k,
      chip: ca.querySelector('.act-tabref .act-wordchip')?.textContent || '', chipTag: ca.querySelector('.act-tabref .act-wordchip')?.tagName || '', chipVisible: !ca.querySelector('.act-tabref').hidden,
      status: ca.querySelector('.act-status-text').textContent, step: ca.querySelector('.act-list .step .step-detail')?.textContent || '',
      pageShown: !ca.querySelector('.act-page').hidden && !ca.querySelector('.act-shot2').hidden, imgShown: !ca.querySelector('.act-thumb2').hidden,
      pageRows: [...ca.querySelectorAll('.act-page .act-pg')].map((r) => r.className.replace('act-pg ', '') + ':' + r.textContent.slice(0, 14)), hl: ca.querySelectorAll('.act-page .act-pg.hl').length,
      pageImgs: ca.querySelectorAll('.act-page img').length, xss: window.__xss === 1, pageAlt: ca.querySelector('.act-page').getAttribute('aria-label'),
      open: ca.querySelector('.act-btn').hidden ? '' : ca.querySelector('.act-btn').textContent,
    };
    ca.querySelector('.act-wordchip').click();
    // 2. Word's window as the live picture (a drawn stand-in): the page gives way, frames only change the picture
    const cv = document.createElement('canvas'); cv.width = 340; cv.height = 212; const x = cv.getContext('2d');
    x.fillStyle = '#2b579a'; x.fillRect(0, 0, 340, 22); x.fillStyle = '#f3f3f3'; x.fillRect(0, 22, 340, 190); x.fillStyle = '#fff'; x.fillRect(60, 34, 220, 178);
    x.fillStyle = '#222'; x.font = 'bold 13px sans-serif'; x.fillText('Report', 74, 56); x.font = '10px sans-serif'; x.fillText('This report covers the spring results.', 74, 74);
    x.strokeStyle = '#999'; for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) x.strokeRect(74 + c * 90, 96 + r * 18, 90, 18);
    const b = mk();
    window.stepUI.add(b.turn, { name: 'word', input: { action: 'insert', text: 'x' }, id: 'wb1', label: 'Writing in Report.docx: adding 1 paragraph at the end' }, b.opts);
    window.stepUI.desktop(b.turn, { type: 'desktop_card', surface: 'app', word: true, id: 'word-2', app: 'Word', doc: 'Report.docx', title: 'Report.docx', status: 'working', task: 'Writing in Report.docx: adding 1 paragraph at the end', thumbnail: cv.toDataURL('image/png'), page: null }, b.opts);
    const cb = b.h.querySelector('.act-card');
    out.live = { imgShown: !cb.querySelector('.act-thumb2').hidden, pageHidden: cb.querySelector('.act-page').hidden, src: Boolean(cb.querySelector('.act-thumb2').getAttribute('src')), alt: cb.querySelector('.act-thumb2').alt };
    const before = cb.querySelector('.act-thumb2').getAttribute('src');
    x.fillStyle = '#c00'; x.fillRect(74, 150, 120, 10);
    window.stepUI.desktop(b.turn, { type: 'desktop_card', surface: 'app', word: true, frame: true, id: 'word-2', thumbnail: cv.toDataURL('image/png') }, b.opts);
    out.live.changed = cb.querySelector('.act-thumb2').getAttribute('src') !== before;
    // 3. the end: Done, and the last frame stays
    const c = mk();
    window.stepUI.add(c.turn, { name: 'word', input: { action: 'save' }, id: 'wc1', label: 'Saving Report.docx' }, c.opts);
    window.stepUI.desktop(c.turn, { type: 'desktop_card', surface: 'app', word: true, id: 'word-3', app: 'Word', doc: 'Report.docx', title: 'Report.docx', status: 'working', task: 'Saving Report.docx', thumbnail: cv.toDataURL('image/png'), page: null }, c.opts);
    window.stepUI.desktop(c.turn, { type: 'desktop_card', surface: 'app', word: true, id: 'word-3', app: 'Word', doc: 'Report.docx', title: 'Report.docx', status: 'completed', task: 'Saving Report.docx', thumbnail: cv.toDataURL('image/png'), page: null }, c.opts);
    window.stepUI.finalize(c.turn, { type: 'done', reply: 'Added the results table to Report.docx.' });
    const cc = c.h.querySelector('.act-card');
    out.done = { status: cc.querySelector('.act-status-text').textContent, state: cc.dataset.state, imgShown: !cc.querySelector('.act-thumb2').hidden, chip: cc.querySelector('.act-wordchip')?.textContent || '' };
    // a turn that used Word and another program is a Computer card, not a Word one
    const d = mk();
    window.stepUI.add(d.turn, { name: 'word', input: { action: 'list' }, id: 'wd1', label: 'Looking at the open Word documents' }, d.opts);
    window.stepUI.add(d.turn, { name: 'desktop', input: { action: 'list_apps' }, id: 'wd2', label: 'Looking at the open apps' }, d.opts);
    out.mixed = d.h.querySelector('.act-title').textContent;
    return out;
  });
  wordRun.opened = await waitFor(() => app.evaluate(() => (global.__wordOpened.length ? global.__wordOpened.slice() : null)));
  const shotDir = process.env.LUMEN_SHOT_DIR;
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    const cards = await ui.$$('#word-host .act-card');
    const names = ['word-card-page.png', 'word-card-live.png', 'word-card-done.png'];
    for (let i = 0; i < names.length && i < cards.length; i++) await cards[i].screenshot({ path: path.join(shotDir, names[i]) });
    await ui.locator('#word-host').screenshot({ path: path.join(shotDir, 'word-cards-all.png') });
  }
  await ui.evaluate(() => document.getElementById('word-host')?.remove());
  check('Word card: the same one card, titled Word with the document icon, the document name as its chip (a button), the step in words in the status bar and the step row', wordRun.sawA === true && wordRun.cards === 1 && wordRun.surface === 'app' && wordRun.title === 'Word' && wordRun.iconKind === 'word' && wordRun.chip === 'Report.docx' && wordRun.chipTag === 'BUTTON' && wordRun.chipVisible && /^Writing in Report.docx: adding a table of 3 rows after/.test(wordRun.status) && /^Writing in Report.docx: adding a table/.test(wordRun.step), J(wordRun));
  check('Word card: with no window picture it draws the page around the change (headings, a bullet, table rows, the changed lines marked), as text only', wordRun.pageShown && !wordRun.imgShown && wordRun.pageRows.length === 7 && wordRun.pageRows[0].startsWith('act-pg-h1:Report') && wordRun.pageRows[3].startsWith('act-pg-tr hl') && wordRun.hl === 2 && wordRun.pageImgs === 0 && !wordRun.xss && /Preview of Report.docx/.test(wordRun.pageAlt), J(wordRun));
  check('Word card: the chip brings Word forward (it asks main for this card\'s id), and the card offers Open', J(wordRun.opened) === '["word-1"]' && wordRun.open === 'Open', J([wordRun.opened, wordRun.open]));
  check('Word card: with Word\'s window as the picture the page gives way, and a live frame only changes the picture', wordRun.live.imgShown && wordRun.live.pageHidden && wordRun.live.src && /Report.docx/.test(wordRun.live.alt) && wordRun.live.changed, J(wordRun.live));
  check('Word card: at the end it says Done with the answer, keeps the last frame and the chip; Word mixed with another program is a Computer card', /^Done: Added the results table/.test(wordRun.done.status) && wordRun.done.state === 'completed' && wordRun.done.imgShown && wordRun.done.chip === 'Report.docx' && wordRun.mixed === 'Computer', J(wordRun.done) + wordRun.mixed);
  const wordBack = await ui.evaluate(() => {
    const nodes = window.stepUI.restoreNodes({ cards: true, tools: [{ name: 'word', input: { action: 'read', path: 'C:/x/Report.docx' }, label: 'Reading Report.docx', ok: true }, { name: 'word', input: { action: 'insert', text: 'a' }, label: 'Writing in Report.docx: adding 1 paragraph at the end', ok: true }] });
    const c = nodes.find((n) => n.classList?.contains('act-card'));
    return { n: nodes.length, title: c?.querySelector('.act-title').textContent, steps: c?.querySelector('.act-steps > summary').textContent };
  });
  check('a reopened chat shows its Word steps in one Word card', wordBack.n === 1 && wordBack.title === 'Word' && wordBack.steps === '2 steps', J(wordBack));

  // ---- steps after the card's text, and steps on no surface, stay in the turn's ONE card (never "Used 1 browser action" rows under it)
  const trailing = await ui.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    const opts = { messages: host, append: (n) => host.append(n), task: '' };
    const turn = { cards: [], card: null, plain: null, working: null };
    const out = {};
    const step = (name, input, id) => window.stepUI.add(turn, { name, input, id, label: name + ' step' }, opts);
    const finish = (row) => { row.classList.remove('running'); row.classList.add('done'); window.stepUI.done(turn, row, { ok: true }); };
    const rows = [];
    // eight steps (browser ones and a web search, a tool on no surface, among them), then the assistant says something, then three more
    rows.push(step('web_search', { query: 'first' }, 'w0')); // (before any card: it moves into the card when the card appears)
    for (let i = 1; i <= 7; i++) rows.push(i % 3 === 0 ? step('TodoWrite', {}, 't' + i) : step('read_page', {}, 'p' + i));
    for (const r of rows) finish(r);
    window.stepUI.endCard(turn); // (text between)
    out.afterText = host.querySelector('.act-card').dataset.state;
    const more = [step('read_page', {}, 'q1'), step('clipboard', {}, 'q2'), step('read_page', {}, 'q3')];
    out.working = host.querySelector('.act-card').dataset.state;
    for (const r of more) finish(r);
    const c = host.querySelector('.act-card');
    out.live = { cards: host.querySelectorAll('.act-card').length, steps: c.querySelector('.act-steps > summary').textContent, loose: [...host.children].filter((n) => !n.classList.contains('act-card')).length, used: (host.textContent.match(/Used \d+ browser action/g) || []).length };
    window.stepUI.finalize(turn, { type: 'done' });
    out.done = c.dataset.state;
    // a step that arrives after Done (a follow-up burst) reopens the card, which says Done again at the end
    const late = step('read_page', {}, 'z1');
    out.reopened = c.dataset.state;
    finish(late);
    window.stepUI.finalize(turn, { type: 'done' });
    out.doneAgain = { state: c.dataset.state, steps: c.querySelector('.act-steps > summary').textContent, cards: host.querySelectorAll('.act-card').length };
    host.textContent = '';
    // the same turn drawn again from a saved chat: 11 steps, 1 card, no folded "Used N" group
    const names = ['web_search', 'read_page', 'read_page', 'TodoWrite', 'read_page', 'read_page', 'TodoWrite', 'read_page', 'read_page', 'clipboard', 'read_page'];
    const nodes = window.stepUI.restoreNodes({ cards: true, tools: names.map((name, i) => ({ name, input: name === 'web_search' ? { query: 'q' + i } : {}, label: name + ' ' + i, ok: true })) });
    for (const n of nodes) host.append(n);
    const rc = host.querySelector('.act-card');
    out.restored = { cards: host.querySelectorAll('.act-card').length, steps: rc.querySelector('.act-steps > summary').textContent, folded: host.querySelectorAll('details.step-group.restored').length, loose: [...host.children].filter((n) => !n.classList.contains('act-card')).length, used: (host.textContent.match(/Used \d+ browser action/g) || []).length, state: rc.dataset.state };
    host.textContent = '';
    // three steps on no surface (and no card at all): ONE row, "Used 3 browser actions", with every step inside
    const three = window.stepUI.restoreNodes({ cards: true, tools: ['TodoWrite', 'clipboard', 'TodoWrite'].map((name, i) => ({ name, input: {}, label: name + ' ' + i, ok: true })) });
    for (const n of three) host.append(n);
    out.outside = { rows: host.querySelectorAll('details.step-group.restored').length, label: host.querySelector('details.step-group.restored > summary')?.textContent || '', members: host.querySelectorAll('details.step-group.restored .step-items .step').length, cards: host.querySelectorAll('.act-card').length };
    host.textContent = '';
    const one = window.stepUI.restoreNodes({ cards: true, tools: [{ name: 'TodoWrite', input: {}, label: 'a', ok: true }] });
    for (const n of one) host.append(n);
    out.singular = host.querySelector('details.step-group.restored > summary')?.textContent || '';
    host.textContent = '';
    // the older saved form (no cards): the same single folded row
    for (const n of window.chatActions.details({ steps: 3, tools: ['TodoWrite', 'clipboard', 'TodoWrite'].map((name, i) => ({ name, input: {}, label: name + ' ' + i, ok: true })) })) host.append(n);
    out.older = { rows: host.querySelectorAll('details.step-group.restored').length, label: host.querySelector('details.step-group.restored > summary')?.textContent || '' };
    host.remove();
    return out;
  });
  check('8 steps, then text, then 3 more: ONE card with 11 steps (working until the turn ends) and no "Used 1 browser action" rows', trailing.afterText === 'working' && trailing.working === 'working' && trailing.live.cards === 1 && /^11 steps/.test(trailing.live.steps) && trailing.live.loose === 0 && trailing.live.used === 0 && trailing.done === 'completed', J(trailing));
  check('a step after Done reopens the same card (Working) and it says Done again at the end, with the new step counted', trailing.reopened === 'working' && trailing.doneAgain.state === 'completed' && trailing.doneAgain.steps === '12 steps' && trailing.doneAgain.cards === 1, J(trailing.doneAgain));
  check('the same turn from a saved chat: one card, 11 steps, no folded "Used N browser actions" rows under it', trailing.restored.cards === 1 && trailing.restored.steps === '11 steps' && trailing.restored.folded === 0 && trailing.restored.loose === 0 && trailing.restored.used === 0 && trailing.restored.state === 'completed', J(trailing.restored));
  check('three separate out-of-card actions are ONE row: "Used 3 browser actions" with all three inside (and "Used 1 browser action" for one)', trailing.outside.rows === 1 && trailing.outside.label.trim() === 'Used 3 browser actions' && trailing.outside.members === 3 && trailing.outside.cards === 0 && trailing.singular.trim() === 'Used 1 browser action', J([trailing.outside, trailing.singular]));
  check('the older saved form (no cards) is one folded row as well', trailing.older.rows === 1 && trailing.older.label.trim() === 'Used 3 browser actions', J(trailing.older));

  // ---- searches in a burst are one row, in the chat (plain rows) and inside a card; the queries and times are in it; restored the same
  const grouped = await ui.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    const opts = { messages: host, append: (n) => host.append(n), task: '' };
    const mkTurn = () => ({ cards: [], card: null, plain: null, working: null });
    const search = (turn, id, q) => window.stepUI.add(turn, { name: 'web_search', input: { query: q }, id, label: 'Searching the web for "' + q + '"' }, opts);
    const finish = (turn, row, ms) => { // (what chat-core does when a step ends: its state, its start and end, then stepUI.done)
      const t0 = Number(row.dataset.t0);
      row.classList.remove('running'); row.classList.add('done');
      row.dataset.start = String(t0); row.dataset.t1 = String(t0 + ms); delete row.dataset.t0;
      row.querySelector('.step-time').textContent = ms + 'ms';
      window.stepUI.done(turn, row, { ok: true });
    };
    const sum = (g) => g.querySelector(':scope > summary');
    const out = {};
    // two at once, then a third
    const t1 = mkTurn();
    const a = search(t1, 'a', 'Dunlosky 2013 improving students learning');
    const b = search(t1, 'b', 'evidence-based study strategies retrieval');
    const g1 = host.querySelector('details.step-group.live');
    out.running2 = { label: sum(g1).firstChild.textContent, cls: sum(g1).className, loose: [...host.children].filter((n) => n.matches('.step')).length };
    finish(t1, a, 1100);
    out.partway = sum(g1).firstChild.textContent;
    finish(t1, b, 1300);
    out.done2 = { label: sum(g1).firstChild.textContent, cls: sum(g1).className, time: sum(g1).querySelector('.step-time').textContent, members: [...g1.querySelectorAll('.step-items > .step')].map((r) => r.firstChild.textContent + '|' + r.querySelector('.step-time').textContent) };
    const c = search(t1, 'c', 'spaced repetition meta-analysis');
    out.running3 = sum(g1).firstChild.textContent;
    finish(t1, c, 900);
    out.done3 = sum(g1).firstChild.textContent;
    out.members3 = [...g1.querySelectorAll('.step-items > .step')].map((r) => r.firstChild.textContent);
    out.groups = host.querySelectorAll('details.step-group.live').length;
    // a different step in between splits the group
    host.textContent = '';
    const t2 = mkTurn();
    const s1 = search(t2, 'p', 'one'); const s2 = search(t2, 'q', 'two');
    window.stepUI.add(t2, { name: 'TodoWrite', input: {}, id: 'td', label: 'Planning' }, opts);
    const s3 = search(t2, 'r', 'three'); const s4 = search(t2, 'u', 'four');
    out.split = [...host.children].map((n) => (n.matches('details.step-group') ? 'group:' + sum(n).firstChild.textContent : 'row:' + n.firstChild.textContent));
    // one search alone keeps its own label
    host.textContent = '';
    const t3 = mkTurn();
    search(t3, 'z', 'alone');
    out.single = [...host.children].map((n) => n.matches('.step') ? n.firstChild.textContent : 'group');
    // inside a card's step list (pages read in a burst)
    host.textContent = '';
    const t4 = mkTurn();
    window.stepUI.add(t4, { name: 'read_urls', input: { urls: ['https://a.example/'] }, id: 'r1', label: 'Reading a.example' }, opts);
    window.stepUI.add(t4, { name: 'read_urls', input: { urls: ['https://b.example/'] }, id: 'r2', label: 'Reading b.example' }, opts);
    window.stepUI.add(t4, { name: 'navigate', input: { url: 'https://c.example/' }, id: 'n1', label: 'Opening c.example' }, opts);
    const card = host.querySelector('.act-card');
    out.inCard = { cards: host.querySelectorAll('.act-card').length, groups: [...card.querySelectorAll('.act-list details.step-group')].map((g) => sum(g).firstChild.textContent), rows: [...card.querySelectorAll('.act-list > .step')].length };
    // a reopened chat
    host.textContent = '';
    const nodes = window.stepUI.restoreNodes({ cards: true, tools: ['one', 'two', 'three'].map((q) => ({ name: 'web_search', input: { query: q }, label: 'Searching the web for "' + q + '"', ok: true })) });
    for (const n of nodes) host.append(n);
    const outer = host.querySelector('details.step-group');
    const inner = outer && outer.querySelector('details.step-group.live');
    out.restored = { outer: Boolean(outer), label: inner ? sum(inner).firstChild.textContent : '', members: inner ? [...inner.querySelectorAll('.step-items > .step')].map((r) => r.firstChild.textContent) : [] };
    host.remove();
    return out;
  });
  check('two searches at once are ONE row while they run: "Searching the web · 2 searches", no loose rows', grouped.running2.label === 'Searching the web · 2 searches' && /running/.test(grouped.running2.cls) && grouped.running2.loose === 0, J(grouped.running2));
  check('…it stays "Searching" until the last one is done, then "Searched the web · 2 searches" with the total time (first start to last end)', grouped.partway === 'Searching the web · 2 searches' && grouped.done2.label === 'Searched the web · 2 searches' && /done/.test(grouped.done2.cls) && grouped.done2.time !== '', J(grouped.done2));
  check('…expanding shows each query with its own time', grouped.done2.members.length === 2 && /Dunlosky 2013/.test(grouped.done2.members[0]) && /1100ms/.test(grouped.done2.members[0]) && /evidence-based/.test(grouped.done2.members[1]) && /1300ms/.test(grouped.done2.members[1]), J(grouped.done2.members));
  check('a third search joins the same row: 3 searches (running, then done), still one group, all three queries inside', grouped.running3 === 'Searching the web · 3 searches' && grouped.done3 === 'Searched the web · 3 searches' && grouped.groups === 1 && grouped.members3.length === 3, J([grouped.running3, grouped.done3, grouped.groups, grouped.members3]));
  check('a different step between two searches splits the group (two groups and the step in the middle)', J(grouped.split) === '["group:Searching the web · 2 searches","row:Updating the plan","group:Searching the web · 2 searches"]', J(grouped.split));
  check('one search alone keeps its own line', grouped.single.length === 1 && /^Searching the web for/.test(grouped.single[0]), J(grouped.single));
  check('inside the activity card pages read in a burst are one row too; a different step after them is a row of its own', grouped.inCard.cards === 1 && J(grouped.inCard.groups) === '["Reading pages · 2 pages"]' && grouped.inCard.rows === 1, J(grouped.inCard));
  check('a reopened chat renders the same: one row "Searched the web · 3 searches" with the three queries', grouped.restored.outer && grouped.restored.label === 'Searched the web · 3 searches' && grouped.restored.members.length === 3, J(grouped.restored));

  // ---- an address read with no tab: "Reading <site>" with its icon, never a picture of another tab
  await fresh('Please read the site quietly');
  const siteMode = await waitFor(() => ui.evaluate((s) => { const sh = document.querySelector(`${s} .act-shot`); return sh && !sh.hidden && sh.dataset.mode === 'site' && { text: sh.querySelector('.act-site-name').textContent, src: sh.querySelector('.act-thumb').hasAttribute('src'), chip: !document.querySelector(`${s} .act-tabref`).hidden }; }, card()), 20000);
  check('a read with no tab shows "Reading <site>" and no screenshot of another tab', siteMode && /^Reading 127\.0\.0\.1:\d+$/.test(siteMode.text) && siteMode.src === false && siteMode.chip === false, J(siteMode));
  await finished();

  // ---- live: a stream while the page changes (about 15 frames a second in the tab the user looks at, fewer in a tab behind it, which the engine does not
  // draw to the screen and which is read back one picture after another), none while it stands still
  const FPS = Number(process.env.LUMEN_THUMB_FPS) || 15; // (main.js THUMB_FPS)
  const POLL_FPS = 8; // (tab-capture.js streamThumb: a view that is not drawn)
  const watch = async (prompt) => {
    await fresh(prompt);
    await waitFor(() => ui.evaluate(() => window.__tools.some((t) => /wait$/.test(t.name))), 20000);
    await sleep(300); // (the first frames of the page, which was loading, are over)
    await app.evaluate(() => { global.__slProbe.max = 0; global.__slProbe.big = []; const st = global.__thumbsState; st.frames = 0; st.frameMs = 0; st.frameBytes = 0; st.frameMax = 0; });
    await ui.evaluate(() => { window.__long = []; });
    const t0 = Date.now();
    await sleep(2700);
    const cost = await app.evaluate(() => { const st = global.__thumbsState; return { frames: st.frames || 0, avgMs: Math.round((st.frameMs || 0) / Math.max(1, st.frames || 0) * 100) / 100, maxMs: Math.round((st.frameMax || 0) * 100) / 100, bytes: st.frameBytes || 0, mainGapMax: Math.round(global.__slProbe.max), mainGaps: global.__slProbe.big.map(([, g]) => Math.round(g)) }; });
    const long = await ui.evaluate(() => window.__long);
    await finished();
    const ev = await ui.evaluate(() => ({ tools: window.__tools, frames: window.__thumbEv.filter((t) => t.hasData).map((t) => t.at) }));
    const w0 = ev.tools.find((t) => /wait$/.test(t.name))?.at || 0;
    const during = ev.frames.filter((t) => t >= w0 && t <= w0 + 3000);
    return { cost, long, during, w0, spaced: during.slice(1).map((t, i) => t - during[i]), t0, bytesPerSec: Math.round(cost.bytes * 0.75 / 2.7), kbPerFrame: Math.round(cost.bytes * 0.75 / Math.max(1, cost.frames) / 1024 * 10) / 10 };
  };
  // the tab the user looks at (tab A): the engine draws it, so its screencast streams at the full rate
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), tabA);
  const seen = await watch('Watch the moving page in this tab');
  console.log('      visible tab, stream cost:', J({ ...seen.cost, mainGaps: seen.cost.mainGaps.length, bytesPerSec: seen.bytesPerSec, kbPerFrame: seen.kbPerFrame, frames: seen.during.length }));
  check('a page that keeps changing is live: about ' + FPS + ' frames a second (≥ ' + FPS * 2 + ' in the 3 s wait, never more than the rate allows)', seen.during.length >= FPS * 2 && seen.during.length <= FPS * 3 + 4, J({ n: seen.during.length, frames: seen.during.map((t) => t - seen.w0) }));
  check('…frames are paced (never a flood: none closer than ' + Math.round(1000 / FPS * 0.72) + ' ms, most about ' + Math.round(1000 / FPS) + ' ms apart)', seen.spaced.every((g) => g >= 1000 / FPS * 0.72) && seen.spaced.filter((g) => g >= 1000 / FPS * 0.84).length >= seen.spaced.length * 0.7, J(seen.spaced));
  check('while streaming at that rate no main-process task runs over 20 ms (setImmediate gap), each frame costs the main process under 2 ms, and the chat has no long task', seen.cost.frames >= 20 && seen.cost.mainGapMax <= 20 && seen.cost.maxMs < 2 && seen.long.length === 0, J({ cost: seen.cost, long: seen.long }));
  // the tab the AI opened behind it: read back one picture after another, still live, at the lower rate
  const hidden = await watch('Watch the moving page');
  console.log('      hidden tab, poll cost:', J({ ...hidden.cost, mainGaps: hidden.cost.mainGaps.length, bytesPerSec: hidden.bytesPerSec, kbPerFrame: hidden.kbPerFrame, frames: hidden.during.length }));
  check('a tab the user does not look at is live too: ≥ ' + Math.round(POLL_FPS * 3 * 0.55) + ' frames in the 3 s wait, never more than ' + POLL_FPS + ' a second', hidden.during.length >= Math.round(POLL_FPS * 3 * 0.55) && hidden.during.length <= POLL_FPS * 3 + 4, J({ n: hidden.during.length, frames: hidden.during.map((t) => t - hidden.w0) }));
  check('…paced (none closer than ' + Math.round(1000 / POLL_FPS * 0.7) + ' ms) and the chat has no long task', hidden.spaced.every((g) => g >= 1000 / POLL_FPS * 0.7) && hidden.long.length === 0, J({ spaced: hidden.spaced, long: hidden.long }));
  check('…and no main-process task over 25 ms while it streams', hidden.cost.frames >= 10 && hidden.cost.mainGapMax <= 25, J(hidden.cost));
  await fresh('Watch the still page');
  await finished();
  const still = await ui.evaluate(() => ({ tools: window.__tools, frames: window.__thumbEv.filter((t) => t.hasData).map((t) => t.at) }));
  const wait2 = still.tools.find((t) => /wait$/.test(t.name))?.at || 0;
  const tail = still.frames.filter((t) => t >= wait2 + 2600 && t <= wait2 + 5600); // (the step finishing at 6 s still gets its one frame)
  check('a page that stands still is not captured again (no frame between 2.6 s and 5.6 s of a 6 s wait)', wait2 > 0 && tail.length === 0, J({ wait2, frames: still.frames.map((t) => t - wait2) }));

  // ---- the last frame is of the page the run ended on, after it settled (not the page it was on a moment before)
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), tabA);
  await fresh('Show me the final frame of this');
  await finished();
  const endBar = await ui.evaluate((s) => document.querySelector(`${s} .act-status-text`)?.textContent, card());
  const endBlue = await waitFor(async () => { const p = await pixel(card()); return isBlue(p) && p; }, 12000);
  const endUrl = await ui.evaluate((s) => document.querySelector(`${s} .act-tabref .tab-ref-title`)?.textContent || '', card());
  check('the final frame shows the page the run ended on once it had loaded (blue), not the page before it (red)', Boolean(endBlue), J([await pixel(card()), endUrl]));
  check('the final status says what came of it, not the last step ("Done: Opened the page")', endBar === 'Done: Opened the page', endBar);
  const widths = await ui.evaluate((s) => { const c = document.querySelector(s); const sh = c.querySelector('.act-shot'); const cr = c.getBoundingClientRect(); const sr = sh.getBoundingClientRect(); const msgs = document.getElementById('messages').getBoundingClientRect(); return { card: Math.round(cr.width), shot: Math.round(sr.width), msgs: Math.round(msgs.width), left: Math.round(cr.left - msgs.left), over: c.scrollWidth - c.clientWidth, kids: [...c.children].map((k) => Math.round(k.getBoundingClientRect().right - cr.right)).filter((d) => d > 0) }; }, card());
  check('the whole card is as wide as its preview (plus its padding), left-aligned, with nothing sticking out', widths.shot > 100 && Math.abs(widths.card - widths.shot - 26) <= 4 && widths.card < widths.msgs && widths.left <= 24 && widths.over <= 0 && widths.kids.length === 0, J(widths));

  // ---- Graphics on Light: the thumbnail refreshes on navigation only (a frame when the work starts, one per page change), never on the clock
  await app.evaluate(() => global.__settings.backend.set('graphicsMode', 'light'));
  await ui.click('#new-chat');
  await sleep(400);
  await watchUi();
  await ui.fill('#prompt', 'Can you find the lab TA on that site?');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => document.querySelectorAll('#messages .act-card').length >= 1), 10000);
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 40000);
  const lightFrames = await ui.evaluate(() => window.__thumbs.map((t) => new URL(t.url).pathname));
  check('Light graphics: frames only for the first step and each page change (not every 1.5 s)', lightFrames.length >= 2 && lightFrames.length <= 4 && lightFrames.includes('/a') && lightFrames.includes('/b'), J(lightFrames));
  await app.evaluate(() => global.__settings.backend.set('graphicsMode', 'full'));

  // ---- "Close them": the tabs the AI opened close (with Undo), from the finished card
  const closeBtn = `${card()} .act-closeall`;
  const shownClose = await waitFor(() => ui.evaluate((sel) => { const b = document.querySelector(sel); return b && !b.hidden && b.textContent; }, closeBtn), 8000);
  check('a finished card offers "Close them"', shownClose === 'Close them', String(shownClose));
  const inStripBefore = await aiTabsInStrip();
  await ui.click(closeBtn);
  const closedNote = await waitFor(() => ui.evaluate((s) => { const n = document.querySelector(`${s} .act-tabs-note`); return n && !n.hidden && n.textContent; }, card()), 8000);
  check('it closes them: "Closed 1 tab the AI opened." with Undo', /^Closed 1 tab the AI opened\. ?Undo$/.test(String(closedNote)) && inStripBefore >= 1 && await waitFor(async () => (await aiTabsInStrip()) === inStripBefore - 1, 6000), J([closedNote, inStripBefore, await aiTabsInStrip()]));
  await ui.click(`${card()} .act-undo`);
  check('Undo brings the tab back', await waitFor(() => ui.evaluate((s) => /^Reopened 1 tab\./.test(document.querySelector(`${s} .act-tabs-note`).textContent), card()), 8000), 'note');

  // ---- the full-page chat: the same cards, live and from history
  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  const chat = await waitFor(() => app.evaluate(() => global.__chatPage.tabs().find((t) => t.chat && /chat-page\.html$/.test(t.url)) || null), 20000);
  const inPage = (code) => app.evaluate(async (_e, c) => { const t = global.__chatPage.tabs().find((x) => x.chat); if (!t) return 'NO CHAT TAB'; try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, code);
  check('the full page opens', Boolean(chat), 'no chat tab');
  const pageHistory = await waitFor(async () => { const r = await inPage(`document.querySelectorAll('#messages .act-card[data-surface="browser"]').length`); return r >= 1 && r; }, 15000);
  check('the full-page chat shows the saved card (a reply keeps one card for its steps)', pageHistory >= 1 && /^Done · /.test(String(await inPage(`document.querySelector('#messages .act-card .act-sub').textContent`))), J(await inPage(`[...document.querySelectorAll('#messages .act-card')].map((c) => c.querySelector('.act-sub').textContent)`)));
  await inPage(`(() => { window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch (e) {} const p = document.getElementById('prompt'); p.value = 'Ask from the page please'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  const livePage = await waitFor(async () => inPage(`(() => { const c = [...document.querySelectorAll('#messages .act-card[data-surface="browser"]')].pop(); return c && /^Working · /.test(c.querySelector('.act-sub').textContent) && c.querySelectorAll('.act-list .step').length >= 1 ? c.querySelector('.act-sub').textContent : null; })()`), 20000);
  check('a run from the full page draws a live Browser card too', Boolean(livePage), String(livePage));
  const pageThumb = await waitFor(() => inPage(`(() => { const c = [...document.querySelectorAll('#messages .act-card[data-surface="browser"]')].pop(); const i = c && c.querySelector('.act-thumb'); return i && i.src.startsWith('data:image/jpeg') ? i.src.length : 0; })()`), 15000);
  check('…with its thumbnail', pageThumb > 500, String(pageThumb));
  const cap = await inPage(`(() => { const c = [...document.querySelectorAll('#messages .act-card[data-surface="browser"]')].pop(); const sh = c.querySelector('.act-shot'); const i = c.querySelector('.act-thumb'); const sr = sh.getBoundingClientRect(); const cr = c.getBoundingClientRect(); return { shot: sr.width, card: cr.width, nat: i.naturalWidth, dpr: devicePixelRatio, left: sr.left - cr.left, ratio: sr.width / sr.height }; })()`);
  check('the preview is small: at most 360 px wide and never above its own pixels (width / devicePixelRatio), left-aligned, 16:10, and the card is only as wide as it (plus padding)', cap.shot <= 360 && cap.shot <= cap.nat / cap.dpr + 1 && Math.abs(cap.card - cap.shot - 26) <= 4 && cap.left < 24 && Math.abs(cap.ratio - 1.6) < 0.1, J(cap));
  await waitFor(async () => (await inPage(`document.getElementById('send').classList.contains('stop')`)) === false, 40000);
  const pageDone = await inPage(`(() => { const c = [...document.querySelectorAll('#messages .act-card[data-surface="browser"]')].pop(); return c && c.querySelector('.act-sub').textContent; })()`);
  check('…and "Done" at the end', /^Done · /.test(String(pageDone)), String(pageDone));
  check('no long task over 50 ms in the full-page chat', J(await inPage('window.__long')) === '[]', J(await inPage('window.__long')));

  // ---- B. Claude Code (full access) steps: plain words, grouping, errors, details, secrets, a Computer card
  // back from the full page to the sidebar (the chat tab closes; the sidebar is per tab, so it opens again)
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), chat.id);
  await sleep(800);
  await app.evaluate(() => { global.__settings.backend.set('claudeCodeFullAccess', true); });
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  await ui.click('#new-chat');
  await sleep(400);
  await watchUi();
  let ids = [];
  for (let i = 0; i < 20 && !ids.includes('claudecode:default'); i++) { await sleep(300); ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value)); }
  await ui.selectOption('#model', 'claudecode:default');
  await ui.fill('#prompt', 'Render the report PDF and read it back');
  await ui.press('#prompt', 'Enter');
  const shell = '#messages .act-card[data-surface="shell"]';
  const first = await waitFor(() => ui.evaluate((s) => document.querySelector(`${s} .act-sub`)?.textContent, shell), 20000);
  if (!first) console.log('      B debug:', J(await ui.evaluate(() => ({ text: document.getElementById('messages').innerText.slice(0, 700), model: document.getElementById('model').value, sent: document.getElementById('send').className }))));
  check('a shell run gets a "Computer" card: "Working · <first step>"', first === 'Working · Reading p1.png' && (await ui.evaluate((s) => document.querySelector(`${s} .act-title`).textContent, shell)) === 'Computer', first);
  check('a running shell step shows its timer after a second, then it is gone', await waitFor(() => ui.evaluate(() => { const r = [...document.querySelectorAll('#messages .step.running')].find((n) => /Render the PDF/.test(n.textContent)); return Boolean(r && /\d/.test(r.querySelector('.step-time')?.textContent || '')); }), 8000), 'no timer');
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 30000);
  const narr = await ui.evaluate(() => { const c = document.querySelector('#messages .act-card'); const bubbles = [...document.querySelectorAll('#messages .msg.assistant')].map((n) => n.textContent); return { ok: !bubbles.some((b) => /PNGs rendered/.test(b)) && bubbles.some((b) => /Everything is in place/.test(b)) && [...document.querySelectorAll('#messages .msg.assistant')].every((b) => c.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), bubbles, kids: [...document.getElementById('messages').children].map((n) => n.className.split(' ')[0] + ':' + n.textContent.slice(0, 25)) }; });
  check('the narration line before it was the card\'s live line: no bubble of its own, the final answer is the one bubble, under the card', narr.ok === true, J(narr));
  await ui.evaluate((s) => { document.querySelector(`${s} .act-steps > summary`).click(); }, shell);
  const sub = await ui.evaluate((s) => document.querySelector(`${s} .act-sub`).textContent, shell);
  check('finished: "Done · <task>"', sub === 'Done · Reading p1.png', sub);
  const main = await ui.evaluate((s) => [...document.querySelectorAll(`${s} .act-list > .step > .step-detail, ${s} .act-list > details > summary .step-detail, ${s} .act-list > .step-group > summary .step-detail`)].map((n) => n.textContent), shell);
  check('two reads in a folder are one row: "Read 2 pages"', main[0] === 'Read 2 pages', J(main));
  check('the model\'s own description is the line', main.includes('Render the PDF pages to PNG'), J(main));
  check('a PowerShell command reads as what it does', main.includes('Reading notes.txt'), J(main));
  check('a heredoc is "Writing <file>"', main.includes('Writing fmt.ps1'), J(main));
  check('no line shows a raw command, a path or an operator', main.every((l) => !/&&|<<|[A-Za-z]:[\\/]|\.ps1"/.test(l)), J(main));
  const members = await ui.evaluate((s) => [...document.querySelectorAll(`${s} details.step-group .step-items .step`)].map((n) => [n.className.replace(/\s+/g, ' '), n.firstChild.textContent]), shell);
  check('an error reads plainly: "Couldn\'t read p2.png: the file was empty"', members.some((m) => /failed/.test(m[0]) && m[1] === "Couldn't read p2.png: the file was empty"), J(members));
  check('only the icon and the short reason are red, not the line', await ui.evaluate((s) => { const r = document.querySelector(`${s} .step.failed`); const why = r.querySelector('.step-why'); return Boolean(why) && getComputedStyle(r).color !== getComputedStyle(why).color; }, shell), 'colours');
  // details: the exact command and the output, copyable
  const writeRow = await ui.evaluate((s) => [...document.querySelectorAll(`${s} .act-list .step[data-more]`)].findIndex((n) => n.firstChild.textContent === 'Writing fmt.ps1'), shell);
  await ui.evaluate(([s, i]) => [...document.querySelectorAll(`${s} .act-list .step[data-more]`)][i].click(), [shell, writeRow]);
  const more = await ui.evaluate(([s, i]) => [...document.querySelectorAll(`${s} .act-list .step[data-more]`)][i].querySelector('.step-more')?.textContent || '', [shell, writeRow]);
  check('clicking a step shows the exact command, in a copyable box', /cat > "C:\/Users\/emah\/AppData\/Local\/Temp\/fmt\.ps1" <<'EOF'/.test(more) && /Copy/.test(more), more);
  const secretRow = await ui.evaluate((s) => [...document.querySelectorAll(`${s} .act-list .step[data-more]`)].findIndex((n) => /deploy\.sh/.test(n.firstChild.textContent)), shell);
  await ui.evaluate(([s, i]) => [...document.querySelectorAll(`${s} .act-list .step[data-more]`)][i].click(), [shell, secretRow]);
  const secret = await ui.evaluate(([s, i]) => [...document.querySelectorAll(`${s} .act-list .step[data-more]`)][i].querySelector('.step-more')?.textContent || '', [shell, secretRow]);
  check('a password or token in a command is masked where it is shown', /deploy\.sh/.test(secret) && !/hunter2|abcd1234efgh5678/.test(secret) && /••••/.test(secret), secret);
  const bash0 = await ui.evaluate((s) => { const r = [...document.querySelectorAll(`${s} .act-list .step[data-more]`)].find((n) => /Render the PDF/.test(n.firstChild.textContent)); r.click(); return r.querySelector('.step-more')?.textContent || ''; }, shell);
  check('…and its output is there', /rendered 4 pages/.test(bash0) && /powershell -NoProfile -File pdf2png\.ps1/.test(bash0), bash0);
  await sleep(1000);
  const saved = await app.evaluate(async () => { const m = global.__agent.messages; return JSON.stringify(m).includes('hunter2'); });
  check('the saved chat never holds the secret', saved === false, 'secret saved');
  // history: it all renders again, in the full page too
  await ui.reload();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  const hist = await waitFor(() => ui.evaluate((s) => { const c = document.querySelector(s); return c && { sub: c.querySelector('.act-sub').textContent, title: c.querySelector('.act-title').textContent, steps: c.querySelector('.act-steps > summary').textContent }; }, shell), 15000);
  check('a reopened chat shows the Computer card with its steps', hist && hist.title === 'Computer' && hist.sub === 'Done · Reading p1.png' && /^5 steps$|^6 steps$/.test(hist.steps), J(hist));
  const gone = await ui.evaluate((s) => { const c = document.querySelector(s); c.querySelector('.act-steps > summary').click(); return [...c.querySelectorAll('.step-detail')].map((n) => n.textContent).join('|'); }, shell);
  check('saved steps are re-labelled the same way', /Read 2 pages/.test(gone) && /Writing fmt\.ps1/.test(gone) && !/&&|<<EOF/.test(gone), gone);

  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  const chat2 = await waitFor(() => app.evaluate(() => global.__chatPage.tabs().find((t) => t.chat && /chat-page.html$/.test(t.url)) || null), 20000);
  const pageShell = await waitFor(() => (chat2 ? inPage(`(() => { const c = document.querySelector('#messages .act-card[data-surface="shell"]'); return c && [c.querySelector('.act-title').textContent, c.querySelector('.act-sub').textContent, c.querySelector('.act-steps > summary').textContent].join(' | '); })()`) : null), 15000);
  check('the full-page chat shows the Computer card from history', /^Computer | Done · Reading p1.png | d+ steps$/.test(String(pageShell)), String(pageShell));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.evaluate(() => { global.__slProbe.on = false; }).catch(() => {});
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
