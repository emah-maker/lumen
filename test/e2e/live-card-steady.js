// [steady] A working card in the sidebar chat holds its height while what it says keeps changing (renderer/step-ui.js steady, agents-card.js,
// step-ui.css "card-steady"), the way the user saw it go wrong: a Files card "3 things at once · Writing cp34.js" with a pill saying the same again,
// two background agents whose activity lines, clocks and tool counts change, Tabs and a step count under them. Real Lumen, a model held open by
// the test; the card's events are streamed into the window by the test (main's 'agent:event', with the run's id):
//  - one step of the reply's own and two agents: the status line names the step, no pill says it again; the status text and each agent's
//    activity line are one line with all of it in the tooltip
//  - once every part has shown, the card's height does not change by a pixel (getBoundingClientRect every frame) while the status text, the
//    pills (two steps at once, then one), the agents' lines (short and very long), their clocks and tool counts (1 to 128) change and an agent
//    finishes (its row stays, a line high)
//  - a second agent's row opens smoothly (an animation), not in one jump
//  - the run ends: the card says Done, and its height changes once, gliding (an animation on the card)
// LUMEN_SHOT_DIR=<folder> also saves a picture of the sidebar with the card at work, and done.
// Hidden: LUMEN_TEST_BACKGROUND=1 (run it through scripts/test/e2e-lock.js).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };
const LONG = 'Reading the second half of the PDF on Gaussian elimination with partial pivoting, then the worked examples on pages 14 to 19';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cardsteady-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    // The model says a word, then waits for the test (global.__release) or Stop.
    await app.evaluate(() => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'On it.' } };
          await new Promise((r, j) => { global.__release = r; const s = opts?.signal; s?.addEventListener?.('abort', () => j(Object.assign(new Error('aborted'), { name: 'AbortError' }))); setTimeout(r, 120000); });
        },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'On it.' }], usage: { input_tokens: 10, output_tokens: 5 } }),
      }) } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = 'build the 4.x decks'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); });
    const run = await waitFor(() => ui.evaluate(() => (typeof turn !== 'undefined' && turn && runId ? runId : 0)), 20000); // eslint-disable-line no-undef
    check('the reply runs (the model held open)', Boolean(run), String(run));
    const send = (...events) => app.evaluate(({ BrowserWindow }, [evs, id]) => { const wc = BrowserWindow.getAllWindows()[0].webContents; for (const ev of evs) wc.send('agent:event', { runId: id, ...ev }); }, [events, run]);
    const t0 = Date.now() - 16000;
    const agent = (id, patch) => ({ type: 'agent', id, background: true, state: 'working', startedAt: id === 'a1' ? t0 : t0 + 8000, ...patch });
    const A1 = 'Build 4.2 Gaussian elimination deck';
    const A2 = 'Build 4.3 RREF and rank deck';

    // ---- 1. the card as the user saw it: one step of the reply's own, two agents at work
    await ui.evaluate(() => loadStepUI()); // eslint-disable-line no-undef
    await waitFor(() => ui.evaluate(() => Boolean(window.stepUI && window.agentsCard))); // (the card code loads with a reply's first step; a real reply's steps come slower than the test's)
    await send({ type: 'tool', id: 's1', name: 'Write', label: 'Writing cp34.js', input: { file_path: 'cp34.js' } });
    check("the reply's first step makes its card", Boolean(await waitFor(() => ui.evaluate(() => document.querySelector('#messages .act-card')), 10000)), '');
    await send(agent('a1', { desc: A1, tools: 4, last: 'Reading the PDF' }));
    await send(agent('a2', { desc: A2, tools: 2, last: 'Using open tab' }));
    const card = () => ui.evaluate(() => {
      const c = [...document.querySelectorAll('#messages .act-card')].at(-1);
      if (!c) return null;
      const st = c.querySelector('.act-status-text');
      return { state: c.dataset.state, steady: c.classList.contains('card-steady'), status: st.textContent, statusTip: st.title, pills: [...c.querySelectorAll('.act-many:not([hidden]) .act-pill:not([aria-hidden]):not([hidden])')].map((p) => p.textContent), rows: [...c.querySelectorAll('.ag-row')].map((r) => ({ state: r.dataset.state, now: r.querySelector('.ag-now').textContent, tip: r.querySelector('.ag-now').title, h: Math.round(r.getBoundingClientRect().height * 100) / 100, anims: r.getAnimations().length })) };
    });
    let v = await waitFor(async () => { const x = await card(); return x && x.rows.length === 2 ? x : null; }, 8000);
    check('one card: 3 things at once, the status line names the step', Boolean(v) && /^3 things at once · Writing cp34\.js$/.test(v.status) && v.steady && v.state === 'working', JSON.stringify(v));
    check('...no pill repeating the status line', Boolean(v) && v.pills.length === 0, JSON.stringify(v?.pills));
    check('...the second agent\'s row opened smoothly (an animation), not in one jump', Boolean(v) && v.rows[1].anims > 0, JSON.stringify(v?.rows));

    // Every frame from here: the card's height (its rise-in is a transform, so it is turned off: it moves nothing, but would scale the rect).
    await ui.evaluate(() => {
      const out = window.__steady = { phase: 'warm', samples: [], done: false };
      const frame = () => {
        const c = [...document.querySelectorAll('#messages .act-card')].at(-1);
        if (c) { c.style.animation = 'none'; out.samples.push({ phase: out.phase, state: c.dataset.state, h: c.getBoundingClientRect().height, status: c.querySelector('.act-status-text').textContent, cardAnims: c.getAnimations().filter((a) => a.effect?.getKeyframes?.().some((k) => k.height)).length }); }
        if (!out.done && out.samples.length < 20000) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    // ---- 2. warm up: every part the run will use shows once (two steps at once: the pills; an agent's long line; a big tool count)
    await send({ type: 'tool', id: 's2', name: 'Read', label: 'Reading notes/chapter-4-gaussian-elimination-and-row-reduction.md', input: { file_path: 'notes.md' } });
    await send(agent('a1', { tools: 128, last: LONG }));
    await sleep(600); // (the parts that opened have finished opening)
    v = await card();
    check('two steps of its own at once: a pill each', Boolean(v) && v.pills.length >= 1 && /4 things at once/.test(v.status), JSON.stringify(v));
    check('a long activity line is one line, all of it in the tooltip', Boolean(v) && v.rows[0].now === LONG && v.rows[0].tip === LONG && v.rows[0].h === v.rows[1].h, JSON.stringify(v?.rows));
    check('the status line has all of it in the tooltip', Boolean(v) && v.statusTip === v.status, JSON.stringify(v));

    // ---- 3. churn: the card keeps its height through every change
    await ui.evaluate(() => { window.__steady.phase = 'churn'; });
    const lines = ['Reading the PDF', LONG, 'Using open tab', 'Writing slides/4.2/gaussian-elimination-with-partial-pivoting-worked-example.pptx', 'Thinking', `${LONG} ${LONG}`];
    const open = new Set(['s1', 's2']); // (the reply's own steps still running)
    const start = (id, label, file) => { open.add(id); return { type: 'tool', id, name: file.endsWith('.js') ? 'Write' : 'Read', label, input: { file_path: file } }; };
    const finish = (id) => { open.delete(id); return { type: 'tool_done', id, ok: true }; };
    for (let i = 0; i < 24; i++) {
      const evs = [agent('a2', { tools: 2 + i * 5, last: lines[i % lines.length] })];
      if (i < 16) evs.push(agent('a1', { tools: 128 - i * 7, last: lines[(i + 3) % lines.length] }));
      if (i === 16) evs.push(agent('a1', { state: 'done', endedAt: Date.now(), tools: 140, summary: `Built the 4.2 deck: 18 slides. ${LONG}. Saved to slides/4.2.` }));
      if (i % 4 === 1) { const id = [...open].find((x) => x !== 's1' && x !== 's3'); if (id) evs.push(finish(id)); } // (two steps at once, then one)
      if (i % 4 === 3) evs.push(start(`x${i}`, i % 8 === 3 ? 'Reading a.md' : `Reading ${lines[i % lines.length]}`, 'a.md'));
      if (i === 10) evs.push(finish('s1'), start('s3', 'Writing cp35-with-a-much-longer-name-for-the-rank-section.js', 'cp35.js'));
      await send(...evs);
      await sleep(i % 3 ? 70 : 160);
    }
    await sleep(1200); // (the clocks tick on)
    const shotDir = process.env.LUMEN_SHOT_DIR;
    const shot = async (name) => { if (!shotDir) return; const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); fs.writeFileSync(path.join(shotDir, name), Buffer.from(png, 'base64')); };
    await shot('live-card-working.png');
    await ui.evaluate(() => { window.__steady.phase = 'end'; });
    v = await card();
    check('a finished agent keeps its row, a line high like the working one', Boolean(v) && v.rows[0].state === 'done' && v.rows[0].h === v.rows[1].h, JSON.stringify(v?.rows));
    const churn = await ui.evaluate(() => window.__steady.samples.filter((s) => s.phase === 'churn'));
    const statuses = new Set(churn.map((s) => s.status));
    const hs = churn.map((s) => s.h);
    const lo = Math.min(...hs);
    const hi = Math.max(...hs);
    check('the churn went through many status lines while working', churn.length > 30 && statuses.size >= 4 && churn.every((s) => s.state === 'working'), JSON.stringify({ n: churn.length, statuses: [...statuses] }));
    check('...and the card kept its height to the pixel all the while', churn.length > 30 && hi - lo < 0.5, JSON.stringify({ lo, hi, jumps: churn.filter((s, i) => i && Math.abs(s.h - churn[i - 1].h) >= 0.5).slice(0, 6) }));

    // ---- 4. the run ends: Done, the height changes once, gliding
    await send(...[...open].map(finish), agent('a2', { state: 'done', endedAt: Date.now(), tools: 120, summary: 'Built the 4.3 deck.' }));
    await app.evaluate(() => global.__release?.());
    v = await waitFor(async () => { const x = await card(); return x?.state === 'completed' ? x : null; }, 15000);
    check('the run ends: the card says Done and lets go', Boolean(v) && !v.steady, JSON.stringify(v));
    await sleep(500);
    await shot('live-card-done.png');
    const after = await ui.evaluate(() => { window.__steady.done = true; return window.__steady.samples.filter((s) => s.phase === 'end'); });
    const done = after.filter((s) => s.state === 'completed');
    const first = done[0];
    check('...its height glides to the new one (an animation on the card), it does not snap', Boolean(first) && (Math.abs(first.h - after.filter((s) => s.state !== 'completed').at(-1).h) < 0.5 || done.some((s) => s.cardAnims > 0)), JSON.stringify(after.slice(-8)));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall live-card-steady checks passed');
  process.exit(failures ? 1 : 0);
})();
