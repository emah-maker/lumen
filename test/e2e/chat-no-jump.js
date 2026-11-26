// [no jump] What is already in the chat stays where it is while a reply adds to it: new words, a step, thinking, another step, the answer.
// The way the user saw it go wrong (2026-11-25): each time the reply started a new block (its card, words after a step, the answer), the
// whole chat jumped down and back for a frame. A message that had just slipped out of the newest four was drawn with content-visibility's
// 160 px stand-in height (styles.css .messages > .msg): the user's two-line message drew 176 px tall, everything under it 122 px lower.
//  - every frame (animations off: only layout counts), each element that was in the chat the frame before is where it was: the user's
//    message, the card and its rows, the words already said. Only the working line (always last) moves as things are added above it.
//  - the run ends: the card says Done and keeps its height while on screen (step-ui.js keep), so the answer under it and the user's message
//    do not move either (inside the card, its rows settle; that is the card's own, live-card-steady.js)
//  - the input box keeps its height while the AI moves into a tab and out again ("Working in <tab>" floats above the box, styles.css
//    .working-in, in the room under the chat's last line, never over it); its height is watched every frame until the run ends
// Real Lumen with a model held open by the test; the reply's events are sent into the window (main's 'agent:event', with the run's id).
// Hidden: LUMEN_TEST_BACKGROUND=1, a temp profile. $LUMEN_ROOT runs another checkout (to see the check fail on the old code).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
  const root = process.env.LUMEN_ROOT || path.join(__dirname, '..', '..');
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(root, 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-nojump-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    // The model says nothing of its own and waits for the test (global.__release).
    await app.evaluate(() => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: () => ({
        async *[Symbol.asyncIterator]() { await new Promise((r) => { global.__release = r; setTimeout(r, 120000); }); },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 5 } }),
      }) } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    await ui.evaluate(() => loadStepUI()); // eslint-disable-line no-undef
    await waitFor(() => ui.evaluate(() => Boolean(window.stepUI)));
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = 'compare the three laptops and tell me which to buy'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); });
    const run = await waitFor(() => ui.evaluate(() => (typeof turn !== 'undefined' && turn && runId ? runId : 0))); // eslint-disable-line no-undef
    check('the reply runs (the model held open)', Boolean(run), String(run));
    const send = (...events) => app.evaluate(({ BrowserWindow }, [evs, id]) => { const wc = BrowserWindow.getAllWindows()[0].webContents; for (const ev of evs) wc.send('agent:event', { runId: id, ...ev }); }, [events, run]);
    const phase = (p) => ui.evaluate((x) => { window.__jump.phase = x; }, p);

    // Every frame: where each element is in the scrolled content (its top minus the list's, plus the scroll), animations off.
    await ui.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '#messages *, #messages *::before, #messages *::after { animation: none !important; transition: none !important; }';
      document.head.append(style);
      const box = document.getElementById('messages');
      const ids = new WeakMap(); let next = 1;
      const out = window.__jump = { phase: 'start', moves: [], box: [], frames: 0, done: false };
      let boxH = -1;
      let prev = new Map();
      const SEL = '.msg, .msg p, .msg li, .act-card, .act-head, .act-status, .step, details.thinking';
      const frame = () => {
        out.frames++;
        const top = box.getBoundingClientRect().top - box.scrollTop;
        const now = new Map();
        for (const e of box.querySelectorAll(SEL)) {
          if (e.closest('[hidden]')) continue;
          const shut = e.closest('details:not([open])'); // (rows folded in a closed group are not on screen; its summary is)
          if (shut && e.parentElement !== shut) continue;
          const r = e.getBoundingClientRect();
          if (!r.height) continue;
          let id = ids.get(e); if (!id) { id = next++; ids.set(e, id); }
          now.set(id, { inCard: Boolean(e.closest('.act-card')) && !e.matches('.act-card'), y: r.top - top, x: r.left, what: `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')} "${e.textContent.trim().slice(0, 30)}"` });
        }
        for (const [id, p] of prev) {
          const c = now.get(id);
          if (c && out.phase === 'the run ends' && p.inCard) continue; // (the card's own rows settle at the end)
          if (c && (Math.abs(c.y - p.y) > 1 || Math.abs(c.x - p.x) > 1)) out.moves.push(`${out.phase}: ${c.what} moved ${Math.round(c.x - p.x)},${Math.round(c.y - p.y)}`);
        }
        prev = now;
        const h = document.getElementById('composer').getBoundingClientRect().height;
        if (boxH >= 0 && Math.abs(h - boxH) > 0.5 && out.phase !== 'the run ends') out.box.push(`${out.phase}: the box ${Math.round(boxH)} -> ${Math.round(h)} px`);
        boxH = h;
        if (!out.done) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    const words = (s) => s.match(/\S+\s*/g);
    const stream = async (text) => { for (const w of words(text)) { await send({ type: 'text', text: w }); await sleep(20); } };
    await phase('words before a step'); await stream('Let me look up all three laptops and compare their specs, prices and reviews.');
    await sleep(200);
    await phase('the first step (the card)'); await send({ type: 'tool', id: 't1', name: 'web_search', label: 'Searching the web for ‘XPS 14 review’', input: { query: 'XPS 14 review' } });
    await sleep(400);
    await phase('the step ends'); await send({ type: 'tool_done', id: 't1', ok: true });
    await sleep(200);
    await phase('thinking'); for (const w of words('The XPS has the best screen but the battery is weaker. I should check the ThinkPad.')) { await send({ type: 'thinking', text: w }); await sleep(20); }
    await sleep(200);
    await phase('the AI moves to a tab');
    const target = (info) => app.evaluate(({ BrowserWindow }, x) => BrowserWindow.getAllWindows()[0].webContents.send('agent:target', x), info);
    await target({ id: 9001, title: 'XPS 14 review - Notebookcheck', host: 'notebookcheck.net', front: true });
    await sleep(300);
    const pill = await ui.evaluate(() => {
      const w = document.getElementById('working-in');
      const box = document.getElementById('composer').getBoundingClientRect();
      const r = w.getBoundingClientRect();
      const last = [...document.querySelectorAll('#messages > .msg, #messages > .act-card')].at(-1)?.getBoundingClientRect();
      return { shown: !w.hidden, text: w.textContent, above: r.bottom <= box.top + 0.5, gap: Math.round(box.top - r.bottom), sameWidth: Math.abs(r.width - box.width) < 1, clearOfChat: !last || r.top >= last.bottom - 0.5, pillTop: Math.round(r.top), lastBottom: last && Math.round(last.bottom) };
    });
    check('"Working in" shows above the box, as wide, clear of the chat’s last line', pill.shown && /notebookcheck|XPS/.test(pill.text) && pill.above && pill.gap <= 8 && pill.sameWidth && pill.clearOfChat, JSON.stringify(pill));
    await phase('the AI leaves the tab'); await target(null);
    await sleep(200);
    await phase('and goes back'); await target({ id: 9001, title: 'XPS 14 review - Notebookcheck', host: 'notebookcheck.net', front: false });
    await sleep(200);
    await phase('two more steps'); await send({ type: 'tool', id: 't2', name: 'read_urls', label: 'Reading 2 pages on notebookcheck.net', input: { urls: ['https://notebookcheck.net/a', 'https://notebookcheck.net/b'] } });
    await sleep(300);
    await send({ type: 'tool', id: 't3', name: 'web_search', label: 'Searching the web for ‘ThinkPad X1 battery’', input: { query: 'x' } });
    await sleep(300);
    await phase('they end, one failed'); await send({ type: 'tool_done', id: 't2', ok: true }, { type: 'tool_done', id: 't3', ok: false, error: 'Search failed: timeout' });
    await sleep(200);
    await phase('words after the steps'); await stream('That search failed, trying a simpler one.');
    await phase('another step'); await send({ type: 'tool', id: 't4', name: 'web_search', label: 'Searching the web for ‘X1 Carbon’', input: { query: 'x' } });
    await sleep(300);
    await send({ type: 'tool_done', id: 't4', ok: true });
    await sleep(200);
    await phase('the answer'); await stream('Here is how they compare:\n\n- **Dell XPS 14**: best screen, 9 hours, $1,699.\n- **ThinkPad X1 Carbon**: best keyboard, 13 hours, $1,549.\n\nI would get the **ThinkPad**.');
    await sleep(400);
    await phase('the run ends');
    await app.evaluate(() => global.__release?.());
    await waitFor(() => ui.evaluate(() => document.querySelector('#messages .act-card')?.dataset.state === 'completed'), 15000);
    await sleep(800);
    const r = await ui.evaluate(() => { window.__jump.done = true; return { box: window.__jump.box, moves: window.__jump.moves, frames: window.__jump.frames, users: document.querySelectorAll('#messages .msg.user').length, card: Boolean(document.querySelector('#messages .act-card')) }; });
    check('the run drew its card under the user\'s message (and the frames were watched)', r.card && r.users === 1 && r.frames > 60, JSON.stringify({ card: r.card, users: r.users, frames: r.frames }));
    check('the input box kept its height to the pixel while the reply ran (steps, thinking, the AI moving in and out of a tab)', r.box.length === 0, r.box.slice(0, 8).join(' | '));
    const moved = r.moves.filter((m) => !/^[^:]+: \S*\.working/.test(m));
    check('nothing already in the chat moved as the reply added words, steps and thinking, nor when it ended', moved.length === 0, `${moved.length} moves: ${moved.slice(0, 12).join(' | ')}`);
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* in use */ }
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
