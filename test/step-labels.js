// What the AI is doing, in the chat (renderer/step-ui.js, step-labels.js, features/step-thumbs.js): readable one-line steps, details on demand,
// grouping, errors in plain words, a running timer, and the activity cards: a Browser card with a live thumbnail of the tab the AI works in,
// and a Computer card for shell work. Sidebar and full-page chat both. Hidden windows (LUMEN_TEST_BACKGROUND=1), a throwaway profile,
// a fake Claude API client and a fake `claude` CLI: no network beyond 127.0.0.1, never the real CLI. Run it under the lock:
//   node scripts/e2e-lock.js run -- node test/step-labels.js
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('graphicsMode', 'full'); }); // (Light, which an integrated GPU picks on its own, refreshes only on navigation: covered below)

  // ---- the fake Claude API client: scripted steps per request, narration first, a pause in the 'wait' tool
  await app.evaluate(() => {
    const scripts = {
      find: [{ text: 'Digging through the pages.', tool: ['navigate', { url: '@a' }] }, { tool: ['wait', { seconds: 3 }] }, { tool: ['navigate', { url: '@b' }] }, { tool: ['wait', { seconds: 3 }] }, { tool: ['open_tab', { url: '@c' }] }, { text: 'Found it on the second page.' }],
      two: [{ text: 'Checking the first page.', tool: ['open_tab', { url: '@a' }] }, { text: 'Now the second.', tool: ['navigate', { url: '@b' }] }, { text: 'All done.' }],
      page: [{ text: 'On it.', tool: ['navigate', { url: '@c' }] }, { tool: ['wait', { seconds: 2 }] }, { text: 'Done from the page.' }],
    };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const users = params.messages.filter((m) => m.role === 'user');
      const lastAsk = [...users].reverse().find((m) => !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')));
      const asked = JSON.stringify(lastAsk?.content || '');
      const key = /two/.test(asked) ? 'two' : /from the page/.test(asked) ? 'page' : 'find';
      const idx = users.length - 1 - users.indexOf(lastAsk);
      const step = scripts[key][Math.min(idx, scripts[key].length - 1)];
      const base = global.__slBase;
      const content = [];
      if (step.text) content.push({ type: 'text', text: step.text });
      if (step.tool) content.push({ type: 'tool_use', id: `tu_${key}_${idx}`, name: step.tool[0], input: JSON.parse(JSON.stringify(step.tool[1]).replace(/@(\w)/, `${base}/$1`)) });
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: step.tool ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 10, output_tokens: 5 } };
      return {
        async *[Symbol.asyncIterator]() { if (step.text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });
  await app.evaluate((_e, b) => { global.__slBase = b; }, base);
  await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/c`);
  await sleep(600);

  // ---- probes: a main-process setImmediate gap, and long tasks in the chat renderer
  await app.evaluate(() => {
    const probe = global.__slProbe = { max: 0, n: 0, on: true, big: [] };
    let last = performance.now();
    const tick = () => { const now = performance.now(); if (now - last > 10) probe.big.push([now, now - last]); probe.max = Math.max(probe.max, now - last); probe.n++; last = now; if (probe.on) setImmediate(tick); };
    setImmediate(tick);
  });
  const watchUi = () => ui.evaluate(() => {
    window.__long = []; window.__thumbs = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch { /* none */ }
    window.assistant.onEvent((e) => { if (e.type === 'thumb') window.__thumbs.push({ tabId: e.tabId, url: e.url, bytes: e.data.length, at: Math.round(performance.timeOrigin + performance.now()) }); });
  });
  await watchUi();

  // ---- A. the Browser card, in the sidebar
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(500);
  const card = (sel = '#messages') => `${sel} .act-card[data-surface="browser"]`;
  await app.evaluate(() => { global.__slProbe.max = 0; global.__slProbe.big = []; });
  await ui.evaluate(() => { window.__status = []; new MutationObserver(() => { const n = document.querySelector('#messages .act-card[data-surface="browser"] [role="status"]'); if (n && window.__status[window.__status.length - 1] !== n.textContent) window.__status.push(n.textContent); }).observe(document.getElementById('messages'), { subtree: true, childList: true, characterData: true }); });
  await ui.fill('#prompt', 'Can you find the lab TA on that site?');
  await ui.press('#prompt', 'Enter');
  const working = await waitFor(() => ui.evaluate((s) => document.querySelector(s)?.querySelector('.act-sub')?.textContent, card()));
  check('a Browser card appears: icon, "Browser", "Working · <task>"', working === 'Working · Find lab TA' && (await ui.evaluate((s) => document.querySelector(`${s} .act-title`)?.textContent === 'Browser' && Boolean(document.querySelector(`${s} .act-icon svg`)), card())), working);
  check('the narration stays outside the card, above it', await ui.evaluate(() => { const c = document.querySelector('#messages .act-card'); return /Digging through the pages/.test(c?.previousElementSibling?.textContent || ''); }), 'order');
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
  check('the thumbnail is not blank (a coloured page, about 420 px wide)', p1.a === 255 && Math.max(...p1.rgb) > 120 && Math.max(...p1.rgb) - Math.min(...p1.rgb) > 60 && p1.w >= 300 && p1.w <= 460, J(p1));
  const changed = await waitFor(() => ui.evaluate((s, was) => { const i = document.querySelector(`${s} .act-thumb`); return i && i.src !== was && i.src; }, card(), firstThumb), 14000).catch(() => null);
  const changedArg = await waitFor(async () => { const src = await ui.evaluate((s) => document.querySelector(`${s} .act-thumb`)?.src, card()); return src && src !== firstThumb; }, 14000);
  check('the thumbnail updates while the AI works (its src changes)', Boolean(changedArg) || Boolean(changed), 'same frame');
  const p2 = await pixel(card());
  check('…and follows the page (the second page has another colour)', Math.abs(p1.rgb[0] - p2.rgb[0]) + Math.abs(p1.rgb[2] - p2.rgb[2]) > 150, J([p1, p2]));
    await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 40000);
  const doneSub = await ui.evaluate((s) => document.querySelector(`${s} .act-sub`)?.textContent, card());
  const statusSeq = await ui.evaluate(() => window.__status);
  const liveShape = await ui.evaluate((s) => { const c = document.querySelector(s); return { aria: c.querySelectorAll('[aria-live]').length, status: c.querySelectorAll('[role="status"]').length }; }, card());
  check('the live region announces state changes only: Working, then Done (never a step)', J(statusSeq) === '["Browser: Working","Browser: Done"]' && liveShape.aria === 0 && liveShape.status === 1, J([statusSeq, liveShape]));
  check('when the run ends the card says "Done · <task>"', doneSub === 'Done · Find lab TA', doneSub);
  check('a closing narration line follows the card', await ui.evaluate(() => /Found it on the second page/.test([...document.querySelectorAll('#messages .msg.assistant')].pop()?.textContent || '')), 'no reply');
  const summary = await ui.evaluate((s) => document.querySelector(`${s} .act-steps > summary`)?.textContent, card());
  check('the steps are folded under "N steps"', /^5 steps$/.test(summary), summary);
  const lines = await ui.evaluate((s) => [...document.querySelectorAll(`${s} .act-list .step .step-detail`)].map((n) => n.textContent), card());
  check('each step is one readable line (the site, not the whole address)', lines.length === 5 && /^Opening 127\.0\.0\.1/.test(lines[0]) && lines.every((l) => !/https?:\/\//.test(l)), J(lines));
  const stoppedTimers = await ui.evaluate(() => document.querySelectorAll('#messages .step.running').length);
  check('no step is left running and the timer is gone', stoppedTimers === 0 && (await ui.evaluate(() => document.querySelectorAll('#messages .step[data-t0]').length)) === 0, String(stoppedTimers));

  // the probes: main thread and chat renderer stayed free while thumbnails refreshed
  const gap = await app.evaluate(() => {
    const w = global.__thumbsState.windows || [];
    const during = global.__slProbe.big.filter(([end, g]) => w.some(([s, e]) => end - g < e + 3 && end > s - 3)); // gaps that overlap a thumbnail capture
    return { max: Math.round(global.__slProbe.max), n: global.__slProbe.n, captures: w.length, overCaptures: Math.round(Math.max(0, ...during.map((d) => d[1]))), all: global.__slProbe.big.map(([t, g]) => [Math.round(t), Math.round(g)]) };
  });
  console.log('      main-process gaps over 10 ms:', J(gap.all), 'captures:', gap.captures);
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
  const runTab = thumbsSeen[thumbsSeen.length - 1];
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
  check('…and its steps are there, folded', await ui.evaluate((s) => /^5 steps$/.test(document.querySelector(`${s} .act-steps > summary`)?.textContent || ''), card()), 'summary');

  // ---- narration ends a card: the next steps start another one
  await ui.click('#new-chat');
  await sleep(400);
  await ui.fill('#prompt', 'Please check two pages');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('#messages .act-card').length >= 1), 40000);
  const twoCards = await ui.evaluate(() => [...document.querySelectorAll('#messages .act-card')].map((c) => [c.querySelector('.act-sub').textContent, c.querySelector('.act-steps > summary').textContent, c.previousElementSibling?.textContent.trim().slice(0, 20)]));
  check('a line of narration ends the card; the next steps start a new one', twoCards.length === 2 && twoCards.every((c) => /^Done · /.test(c[0]) && c[1] === '1 step') && /^Now the second/.test(twoCards[1][2]), J(twoCards));

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
  check('the narration line before it is kept as it was', await ui.evaluate(() => /PNGs rendered\. Viewing the report pages\./.test(document.querySelector('#messages .act-card')?.previousElementSibling?.textContent || '')), 'order');
  check('a running shell step shows its timer after a second, then it is gone', await waitFor(() => ui.evaluate(() => { const r = [...document.querySelectorAll('#messages .step.running')].find((n) => /Render the PDF/.test(n.textContent)); return Boolean(r && /\d/.test(r.querySelector('.step-time')?.textContent || '')); }), 8000), 'no timer');
  await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 30000);
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
