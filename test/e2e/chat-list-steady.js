// [list steady] The chat list holds still when New chat is clicked while one chat is working and another has just finished (the user
// saw it, 2026-11-26: "it just flashed a bunch and jumped around"). lumen://chat's rail and the sidebar's history panel both redraw on
// every chats:changed (and New chat, the hover release, ...): each redraw used to rebuild every row, so a burst of them flashed the
// rows (the spinner, the green Done row) and a slower answer could land after a newer one.
//  - every frame from the click until the list settles: each row that was there keeps its place (within 1 px), and the order holds
//  - the rows that did not change are the same elements (not rebuilt): at most one rebuild of the list for the whole burst
//  - the same for the sidebar's history panel on a burst of list changes
// A fake model held open by the test, invisible windows (LUMEN_TEST_BACKGROUND=1), a temp profile, no network.
// $LUMEN_ROOT runs another checkout (to see the checks fail on the old code).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
  const root = process.env.LUMEN_ROOT || path.join(__dirname, '..', '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-list-steady-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    await app.evaluate(() => {
      const fake = global.__fake = { gates: new Map() };
      global.__fakeRelease = (word) => { for (const [k, g] of fake.gates) if (k.includes(word)) { fake.gates.delete(k); g(); } };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => {
        const asked = JSON.stringify(params.messages.filter((m) => m.role === 'user').at(-1)?.content || '');
        const slow = /slow/.test(asked);
        const text = slow ? 'Slow reply done.' : 'Quick reply done.';
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 5) } };
            if (slow) await Promise.race([new Promise((r) => fake.gates.set(asked + Math.random(), r)), new Promise((_, rej) => opts?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }))))]);
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(5) } };
          },
          finalMessage: async () => message,
        };
      } } } });
    });
    // two older chats, from yesterday
    await app.evaluate(() => {
      const store = global.__chats.store();
      for (const [i, title] of ['for a1 what do I use for the u and v', 'set up the about you section'].entries()) {
        const id = store.newId();
        store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: title }] }, { role: 'assistant', content: [{ type: 'text', text: `${title} answer` }] }] });
        store.list().find((c) => c.id === id).updated = Date.now() - 864e5 - i * 60000;
      }
      const any = store.list()[0]; store.setPinned(any.id, true); store.setPinned(any.id, false); // (writes the index)
    });

    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    await waitFor(() => app.evaluate(() => global.__chatPage.tabs().find((t) => t.chat)?.id));
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage("document.body.classList.contains('cp-booting')")) === false && (await inPage("document.querySelectorAll('#cp-items .chat-item').length")) === 2, 20000);
    const send = async (text) => { await inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`); };
    const gates = () => app.evaluate(() => global.__fake.gates.size);
    // one chat that will finish unseen, then another that keeps working
    await send('slow: add to todoist to take notes');
    await waitFor(async () => (await gates()) === 1);
    await inPage("document.getElementById('new-chat').click()");
    await sleep(500);
    await send('slow: generate a picture of a cat');
    await waitFor(async () => (await gates()) === 2);
    await app.evaluate(() => global.__fakeRelease('todoist'));
    const badges = () => inPage("[...document.querySelectorAll('#cp-items .chat-item')].map((r) => (r.classList.contains('has-unread') ? 'done' : r.querySelector('.chat-badge.running') ? 'running' : '-')).join()");
    check('set up: one chat working and one just done in the rail', await waitFor(async () => /running/.test(await badges()) && /done/.test(await badges()), 15000), await badges());
    await sleep(800);

    // record every frame from the click on New chat
    // A row that looks the same at the end as at the start must still be the same element (rebuilding it is the flash); a row that
    // changed (its mark, the current highlight) may be drawn again once, not once per redraw.
    const verdict = (process.env.STEADY_DEBUG ? 'const process = { env: { STEADY_DEBUG: 1 } }; ' : 'const process = { env: {} }; ') + "const rebuilt = []; for (const [id, set] of r.nodes) { const row = [...set].pop(); const same = row.isConnected && row.outerHTML === r.html.get(id); if ((same && set.size > 1) || set.size > 2) rebuilt.push(id.slice(0, 6) + (same ? ':unchanged x' : ':changed x') + set.size + ' ' + [...set].map((n) => n.className + '|' + n.textContent.trim().slice(0, 60)).join(' / ') + (process.env.STEADY_DEBUG ? ' SIGS ' + [...set].map((n) => n.__sig).join(' ## ') + ' HTMLSAME ' + ([...set].length > 2 && [...set][1].outerHTML === [...set][2].outerHTML) : '')); }";
    const startRecording = (host) => inPage(`(() => {
      const host = document.querySelector(${JSON.stringify(host)});
      const rows = () => [...host.querySelectorAll('.chat-item[data-id]')];
      const first = rows();
      const rec = window.__steady = { start: first.map((r) => [r.dataset.id, Math.round(r.getBoundingClientRect().top)]), nodes: new Map(first.map((r) => [r.dataset.id, new Set([r])])), html: new Map(first.map((r) => [r.dataset.id, r.outerHTML])), frames: 0, moved: [], order: [], done: false };
      const sample = () => {
        if (rec.done) return;
        rec.frames++;
        const now = rows();
        rec.order.push(now.map((r) => r.dataset.id).filter((id) => rec.nodes.has(id)).join());
        for (const r of now) {
          const at = rec.start.find((s) => s[0] === r.dataset.id);
          if (!at) continue;
          rec.nodes.get(r.dataset.id).add(r);
          const top = Math.round(r.getBoundingClientRect().top);
          if (Math.abs(top - at[1]) > 1) rec.moved.push(r.dataset.id.slice(0, 6) + ':' + (top - at[1]) + '@' + rec.frames);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return rec.start.length;
    })()`);
    const stopRecording = () => inPage(`(() => { const r = window.__steady; r.done = true; ${verdict} return { frames: r.frames, moved: r.moved.slice(0, 20), rebuilt, orders: [...new Set(r.order)] }; })()`);

    const startRows = await startRecording('#cp-items');
    check('recording the rail rows', startRows >= 4, startRows);
    await inPage("document.getElementById('new-chat').click()");
    await sleep(1800);
    const rail = await stopRecording();
    if (process.env.STEADY_DEBUG) console.log('DEBUG', JSON.stringify(rail.rebuilt));
    check('rail: frames were recorded', rail.frames > 10, JSON.stringify(rail));
    check('rail: no row moved in any frame after New chat', rail.moved.length === 0, JSON.stringify(rail.moved));
    check('rail: the order held', rail.orders.length === 1, JSON.stringify(rail.orders));
    check('rail: rows that did not change were not rebuilt, a changed row drawn again once (no flash)', rail.rebuilt.length === 0, JSON.stringify(rail.rebuilt));

    // the sidebar's history panel: a burst of list changes (what a finished run, a new chat and a title sends) leaves its rows still
    await ui.evaluate(() => document.getElementById('chat-history').click());
    await waitFor(() => ui.evaluate(() => document.querySelectorAll('#chat-list .chat-items .chat-item').length >= 3));
    await sleep(400);
    const sideStart = await ui.evaluate(() => {
      const host = document.querySelector('#chat-list');
      const rows = () => [...host.querySelectorAll('.chat-items .chat-item[data-id]')];
      const first = rows();
      const rec = window.__steady = { start: new Map(first.map((r) => [r.dataset.id, Math.round(r.getBoundingClientRect().top)])), nodes: new Map(first.map((r) => [r.dataset.id, new Set([r])])), html: new Map(first.map((r) => [r.dataset.id, r.outerHTML])), frames: 0, moved: [], done: false };
      const sample = () => {
        if (rec.done) return;
        rec.frames++;
        for (const r of rows()) {
          if (!rec.start.has(r.dataset.id)) continue;
          rec.nodes.get(r.dataset.id).add(r);
          const d = Math.round(r.getBoundingClientRect().top) - rec.start.get(r.dataset.id);
          if (Math.abs(d) > 1) rec.moved.push(`${r.dataset.id.slice(0, 6)}:${d}@${rec.frames}`);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return first.length;
    });
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) for (let i = 0; i < 4; i++) setTimeout(() => { try { w.webContents.send('chats:changed', null); } catch { /* gone */ } }, i * 40); });
    await sleep(1500);
    const side = await ui.evaluate(`(() => { const r = window.__steady; r.done = true; ${verdict} return { frames: r.frames, moved: r.moved.slice(0, 20), rebuilt }; })()`);
    check('sidebar: rows recorded', sideStart >= 3 && side.frames > 10, JSON.stringify({ sideStart, ...side }));
    check('sidebar: no row moved on a burst of list changes', side.moved.length === 0, JSON.stringify(side.moved));
    check('sidebar: rows that did not change were not rebuilt (no flash)', side.rebuilt.length === 0, JSON.stringify(side.rebuilt));

    await app.evaluate(() => global.__fakeRelease('cat'));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failures++;
    console.log('FAIL  crashed:', e?.stack || e);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* left for the tmp sweep */ }
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll list-steady checks passed');
  process.exit(failures ? 1 : 0);
})();
