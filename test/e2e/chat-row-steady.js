// A working chat's row in the chat lists keeps the height and place of an idle row (renderer/chat-items.js, chats.css,
// chat-page.css): its Stop is a small square on the title's line, not a second line under it. Real windows, invisible
// (LUMEN_TEST_BACKGROUND=1), a fake gated model. For the full-page list (lumen://chat) and the sidebar's list: every row's
// top and height (within 0.5 px) before the run, while it runs, with the mouse on the working row, with keyboard focus on
// its Stop, and after a real click on that Stop has stopped the run. The Stop names the chat ("Stop <title>") and has a tooltip.
// And the Browser card of a working reply (renderer/step-ui.js, step-ui.css "steady"): from its first step to the end of the run, the card's
// height and every part's top and height stay put while a tab opens, two steps run at once (a chip each) and the status line changes.
// LUMEN_SHOT_DIR=<folder> also saves a picture of each list with the working row, and of the card (working, and done).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// Each row as drawn: its chat id, top and height.
const ROWS = (list) => `[...document.querySelectorAll(${JSON.stringify(`${list} .chat-item`)})].map((li) => { const r = li.getBoundingClientRect(); return { id: li.dataset.id, top: r.top, h: r.height }; })`;
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.length > 0 && a.every((r, i) => r.id === b[i].id && Math.abs(r.top - b[i].top) <= 0.5 && Math.abs(r.h - b[i].h) <= 0.5);
const show = (rows) => JSON.stringify((rows || []).map((r) => [String(r.id).slice(-4), Math.round(r.top * 10) / 10, Math.round(r.h * 10) / 10]));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-rowsteady-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    if (process.env.ROW_DEBUG) app.process().stderr.on('data', (d) => process.stderr.write(d));
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    // Every reply waits at a gate that only an abort (Stop) gets past.
    await app.evaluate(() => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => {
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reply.' }], usage: { input_tokens: 10, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Re' } };
            await new Promise((r, j) => { const s = opts?.signal; if (s?.aborted) j(new Error('aborted')); s?.addEventListener?.('abort', () => j(Object.assign(new Error('aborted'), { name: 'AbortError' }))); setTimeout(r, 60000); });
          },
          finalMessage: async () => message,
        };
      } } } });
    });
    // Four saved chats; the newest ("four") is the one that runs, so the list's order does not change.
    const ids = {};
    for (const n of ['one', 'two', 'three', 'four']) {
      ids[n] = await app.evaluate((_e, name) => {
        const store = global.__chats.store();
        const id = store.newId();
        store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: `${name} topic with a long title that truncates at the end of the row` }] }, { role: 'assistant', content: [{ type: 'text', text: `${name} answer` }] }] });
        return id;
      }, n);
      await sleep(25);
    }
    const live = () => app.evaluate(() => global.__tabChats.runs().some((r) => r.live));
    const idle = () => waitFor(async () => !(await live()), 15000);
    const shotDir = process.env.LUMEN_SHOT_DIR;

    // ---- 1. The full-page list (lumen://chat).
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    const pageInput = (events) => app.evaluate((_e, evs) => { const c = global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id); for (const ev of evs) c.sendInputEvent(ev); }, events);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 4, 20000);
    await inPage(`document.querySelector('#cp-items .chat-item[data-id="${ids.four}"] .chat-open').click()`);
    await waitFor(async () => /four answer/.test(await inPage("document.getElementById('messages').textContent")), 10000);
    await inPage('document.activeElement?.blur?.()');
    await pageInput([{ type: 'mouseMove', x: 2000, y: 2000 }]);
    await sleep(400);
    const pageRows = () => inPage(ROWS('#cp-items'));
    const before = await pageRows();
    await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'keep going on four'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    const runningRow = `#cp-items .chat-item.has-running[data-id="${ids.four}"]`;
    check('page: the chat runs and its row shows it', Boolean(await waitFor(() => inPage(`Boolean(document.querySelector('${runningRow} .chat-stop-wait'))`))), 'no running row');
    await inPage('document.activeElement?.blur?.()');
    await sleep(400);
    check('page: every row keeps its height and place when a chat starts running', same(before, await pageRows()), `${show(before)} vs ${show(await pageRows())}`);
    const stopInfo = await inPage(`(() => { const b = document.querySelector('${runningRow} .chat-stop-wait'); const r = b.getBoundingClientRect(); const t = document.querySelector('${runningRow} .chat-title').getBoundingClientRect(); const row = b.closest('.chat-item').getBoundingClientRect(); return { label: b.getAttribute('aria-label'), tip: b.title, x: r.left + r.width / 2, y: r.top + r.height / 2, inRow: r.top >= row.top - 0.5 && r.bottom <= row.bottom + 0.5, titleLine: r.top < t.bottom && r.bottom > t.top, ellipsis: getComputedStyle(document.querySelector('${runningRow} .chat-title')).textOverflow }; })()`);
    check('page: the Stop sits on the title\'s line, inside the row', stopInfo?.inRow && stopInfo.titleLine, JSON.stringify(stopInfo));
    check('page: the Stop is named for its chat and has a tooltip', /^Stop four topic/.test(stopInfo?.label || '') && stopInfo.tip === 'Stop', JSON.stringify(stopInfo));
    check('page: the title still ends in an ellipsis', stopInfo?.ellipsis === 'ellipsis', JSON.stringify(stopInfo));
    await pageInput([{ type: 'mouseMove', x: Math.round(stopInfo.x) - 60, y: Math.round(stopInfo.y) }]);
    await sleep(400);
    check('page: ...and on hover', same(before, await pageRows()), `${show(before)} vs ${show(await pageRows())}`);
    if (shotDir) {
      const png = await app.evaluate(async () => (await global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id).capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shotDir, 'chat-page-running-row.png'), Buffer.from(png, 'base64'));
    }
    await pageInput([{ type: 'mouseMove', x: 2000, y: 2000 }]);
    const focused = await waitFor(() => inPage(`(() => { const b = document.querySelector('${runningRow} .chat-stop-wait'); b?.focus({ focusVisible: true }); return document.activeElement === b && Boolean(b); })()`), 3000); // (the list can redraw the row under it: focus the one drawn now)
    await sleep(300);
    check('page: ...and with keyboard focus on its Stop', focused === true && same(before, await pageRows()), `${show(before)} vs ${show(await pageRows())}`);
    // A real click on the Stop (mouse down and up where it is drawn).
    const at = { x: Math.round(stopInfo.x), y: Math.round(stopInfo.y) };
    await pageInput([{ type: 'mouseMove', ...at }, { type: 'mouseDown', ...at, button: 'left', clickCount: 1 }, { type: 'mouseUp', ...at, button: 'left', clickCount: 1 }]);
    check('page: clicking the inline Stop stops the run', Boolean(await idle()), 'still running');
    await waitFor(() => inPage("!document.querySelector('#cp-items .chat-item.has-running')"));
    await inPage('document.activeElement?.blur?.()');
    await pageInput([{ type: 'mouseMove', x: 2000, y: 2000 }]);
    await sleep(400);
    check('page: ...and every row is back where it was', same(before, await pageRows()), `${show(before)} vs ${show(await pageRows())}`);

    // ---- 2. The sidebar's list, in the window itself.
    const away = await app.evaluate(() => global.__chatPage.tabs().find((x) => !x.chat)?.id);
    if (away != null) await app.evaluate((_e, id) => global.__chatPage.switchTab(id), away);
    else await app.evaluate(() => global.__agent.browser.openTab?.('about:blank'));
    await sleep(500);
    if (!(await ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true'))) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await waitFor(() => ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true' && !document.body.classList.contains('sidebar-moving')));
    const openList = async () => { await ui.evaluate(() => document.getElementById('chat-history').click()); return waitFor(() => ui.evaluate(() => !document.getElementById('chat-list').hidden && document.querySelectorAll('#chat-list .chat-item').length >= 4)); };
    // The sidebar shows "four", then its list is opened over it.
    await openList();
    await ui.evaluate((id) => document.querySelector(`#chat-list .chat-item[data-id="${id}"] .chat-open`).click(), ids.four);
    await waitFor(() => ui.evaluate(() => /four answer/.test(document.getElementById('messages').textContent)));
    if (await ui.evaluate(() => !document.getElementById('chat-list').hidden)) await ui.evaluate(() => document.getElementById('chat-history').click());
    await sleep(300);
    await openList();
    await ui.mouse.move(1, 1);
    await ui.evaluate(() => document.activeElement?.blur?.());
    await sleep(400);
    const sideRows = () => ui.evaluate(ROWS('#chat-list'));
    const sBefore = await sideRows();
    // The newest chat runs again, sent from the sidebar's composer (under its list).
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = 'once more on four'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); });
    if (await ui.evaluate(() => document.getElementById('chat-list').hidden)) await openList();
    const sRunning = `#chat-list .chat-item.has-running[data-id="${ids.four}"]`;
    check('sidebar: the list shows the chat working', Boolean(await waitFor(() => ui.evaluate((s) => Boolean(document.querySelector(`${s} .chat-stop-wait`)), sRunning))), 'no running row');
    await sleep(400);
    check('sidebar: every row keeps its height and place when a chat starts running', same(sBefore, await sideRows()), `${show(sBefore)} vs ${show(await sideRows())}`);
    const sStop = await ui.evaluate((s) => { const b = document.querySelector(`${s} .chat-stop-wait`); if (!b) return null; const r = b.getBoundingClientRect(); const t = document.querySelector(`${s} .chat-title`).getBoundingClientRect(); return { label: b.getAttribute('aria-label'), tip: b.title, x: r.left + r.width / 2, y: r.top + r.height / 2, titleLine: r.top < t.bottom && r.bottom > t.top }; }, sRunning);
    check('sidebar: the Stop sits on the title\'s line, named for its chat, with a tooltip', sStop?.titleLine && /^Stop four topic/.test(sStop.label || '') && sStop.tip === 'Stop', JSON.stringify(sStop));
    await ui.mouse.move((sStop?.x ?? 100) - 80, sStop?.y ?? 1);
    await sleep(400);
    check('sidebar: ...and on hover', same(sBefore, await sideRows()), `${show(sBefore)} vs ${show(await sideRows())}`);
    if (shotDir) {
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shotDir, 'sidebar-running-row.png'), Buffer.from(png, 'base64'));
    }
    await ui.mouse.move(1, 1);
    await ui.evaluate((s) => document.querySelector(`${s} .chat-stop-wait`)?.focus({ focusVisible: true }), sRunning);
    await sleep(300);
    check('sidebar: ...and with keyboard focus on its Stop', same(sBefore, await sideRows()), `${show(sBefore)} vs ${show(await sideRows())}`);
    await ui.mouse.click(sStop?.x ?? 1, sStop?.y ?? 1);
    check('sidebar: clicking the inline Stop stops the run', Boolean(await idle()), 'still running');
    await waitFor(() => ui.evaluate(() => !document.querySelector('#chat-list .chat-item.has-running')));
    await ui.mouse.move(1, 1);
    await ui.evaluate(() => document.activeElement?.blur?.());
    await sleep(400);
    check('sidebar: ...and every row is back where it was', same(sBefore, await sideRows()), `${show(sBefore)} vs ${show(await sideRows())}`);

    // ---- 3. The progress card in a working reply (renderer/step-ui.js): from the run's first step to its end, the card's height and every
    // part's place stay put while the AI opens a tab (the site line, Tabs and "Go to tab" arrive), does two things at once (the count in the
    // status line, a chip each), goes back to one, and its status text changes. A scripted model; the tools are slowed down by the test.
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>Today – Todoist</title><body><h1>Today</h1><p>Buy milk</p></body>'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${server.address().port}`;
    await app.evaluate((_e, url) => {
      const a = global.__agent;
      const slow = { read_page: [1500, 900], list_tabs: [2600] }; // per call, in order (ms)
      const execute = a.execute.bind(a);
      a.execute = async (name, input) => { const ms = slow[name]?.shift(); if (ms) await new Promise((r) => setTimeout(r, ms)); return execute(name, input); };
      const usage = { input_tokens: 10, output_tokens: 5 };
      const say = (content, stop) => ({ async *[Symbol.asyncIterator]() { const t = content.find((b) => b.type === 'text'); if (t) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t.text } }; }, finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage }) });
      a.getClient = () => ({ beta: { messages: { stream: (params) => {
        const n = params.messages.filter((m) => m.role === 'assistant').length;
        if (n === 0) return say([{ type: 'text', text: 'Opening your list.' }, { type: 'tool_use', id: 'tu-open', name: 'open_tab', input: { url: `${url}/today` } }], 'tool_use');
        if (n === 1) return say([{ type: 'text', text: 'Reading it two ways at once to be sure nothing is missed, which takes a moment.' }, { type: 'tool_use', id: 'tu-read', name: 'read_page', input: {} }, { type: 'tool_use', id: 'tu-tabs', name: 'list_tabs', input: {} }], 'tool_use');
        if (n === 2) return say([{ type: 'tool_use', id: 'tu-read2', name: 'read_page', input: {} }], 'tool_use');
        return say([{ type: 'text', text: 'Your list has one thing on it: buy milk.' }], 'end_turn');
      } } } });
    }, site);
    if (await ui.evaluate(() => !document.getElementById('chat-list').hidden)) await ui.evaluate(() => document.getElementById('chat-history').click());
    await ui.evaluate(() => document.getElementById('new-chat').click());
    await sleep(400);
    // Sampled in the window every 20 ms from the moment the card is there: its height, each part's top and height, and what it showed.
    await ui.evaluate(() => {
      const out = window.__cardSamples = [];
      const tick = () => {
        const card = [...document.querySelectorAll('#messages .act-card')].at(-1);
        if (card) {
          card.style.animation = 'none'; // (its rise-in is a transform: it moves nothing in the layout, but it would scale every rect measured here)
          const c = card.getBoundingClientRect();
          const parts = [...card.children].map((k) => { const r = k.getBoundingClientRect(); const drawn = r.width > 0 || r.height > 0; return [k.className.split(' ')[0], drawn ? Math.round((r.top - c.top) * 100) / 100 : null, Math.round(r.height * 100) / 100]; }); // (a part not drawn has no place)
          out.push({ state: card.dataset.state, h: c.height, parts, anims: card.getAnimations().map((a) => a.animationName || a.transitionProperty || '?'), status: card.querySelector('.act-status-text')?.textContent || '', pills: card.querySelectorAll('.act-many:not([hidden]) .act-pill:not([aria-hidden]):not([hidden])').length, btn: !card.querySelector('.act-btn').hidden });
        }
        if (out.length < 3000 && !(out.length && out.at(-1).state !== 'working')) setTimeout(tick, 20);
      };
      tick();
    });
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = 'add what i have'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); });
    if (shotDir && await waitFor(() => ui.evaluate(() => window.__cardSamples.some((s) => s.pills >= 2)), 15000)) { // (the working card, two things at once)
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shotDir, 'progress-card-running.png'), Buffer.from(png, 'base64'));
    }
    const ended = await waitFor(() => ui.evaluate(() => { const s = window.__cardSamples; return s.length && s.at(-1).state !== 'working' ? s.length : 0; }), 30000);
    const samples = await ui.evaluate(() => window.__cardSamples);
    if (shotDir) fs.writeFileSync(path.join(shotDir, 'progress-card-samples.json'), JSON.stringify(samples));
    const run = samples.filter((s) => s.state === 'working');
    check('card: the run went through its states (two at once with a chip each, Go to tab, a changing status line)', Boolean(ended) && run.some((s) => s.pills >= 2 && /2 things at once/.test(s.status)) && run.some((s) => s.btn) && new Set(run.map((s) => s.status)).size >= 3, JSON.stringify({ n: run.length, statuses: [...new Set(run.map((s) => s.status))], pills: Math.max(0, ...run.map((s) => s.pills)), btn: run.some((s) => s.btn) }));
    const first = run[0];
    const moved = run.find((s) => Math.abs(s.h - first.h) > 0.5 || s.parts.length !== first.parts.length || s.parts.some((p, i) => p[0] !== first.parts[i][0] || Math.abs(p[1] - first.parts[i][1]) > 0.5 || Math.abs(p[2] - first.parts[i][2]) > 0.5));
    check('card: from the first step to the end, the card keeps its height and every part keeps its place and height', run.length > 20 && !moved, moved ? JSON.stringify({ first: { h: first.h, parts: first.parts }, then: { h: moved.h, status: moved.status, parts: moved.parts } }) : `${run.length} samples`);
    if (shotDir) {
      await waitFor(() => ui.evaluate(() => document.querySelector('#messages .act-card[data-state="completed"]')));
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shotDir, 'progress-card-done.png'), Buffer.from(png, 'base64'));
    }
    server.close();

    check('no page errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
