// [card tabs] A busy run's card shows its agents by item (renderer/agents-card.js paintTabs, card-items.js, step-ui.css "card tabs"): real Lumen,
// a model held open by the test, the card's events streamed into the window (main's 'agent:event', with the run's id):
//  - one agent: the plain list, no tabs
//  - agents on 4.2 (a builder, and a reviewer that scored 8.6), 4.3 (at work) and 4.4 (failed): a tab strip (role=tablist) with Overview, then
//    "4.2 · 8.6", "4.3", "4.4" with a badge (it needs the user); Overview is picked: a row per item (state, score, clock), no agent rows, no
//    tool calls; the card's own score track is not drawn twice
//  - a click on 4.2: only its two agents and its rounds (R1 8.6)
//  - arrow keys, End and Home move the pick and the focus
//  - going through every tab, the card's height and its place in the chat do not move (getBoundingClientRect)
//  - the pick stays picked as the agents go on
// LUMEN_SHOT_DIR=<folder> also saves a picture of the card on Overview, and on an item's tab.
// Hidden: LUMEN_TEST_BACKGROUND=1 (run it through scripts/test/e2e-lock.js).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cardtabs-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
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
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = 'build the 4.x decks and review them'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); });
    const run = await waitFor(() => ui.evaluate(() => (typeof turn !== 'undefined' && turn && runId ? runId : 0)), 20000); // eslint-disable-line no-undef
    check('the reply runs (the model held open)', Boolean(run), String(run));
    const send = (...events) => app.evaluate(({ BrowserWindow }, [evs, id]) => { const wc = BrowserWindow.getAllWindows()[0].webContents; for (const ev of evs) wc.send('agent:event', { runId: id, ...ev }); }, [events, run]);
    const t0 = Date.now() - 30000;
    const agent = (id, desc, patch) => ({ type: 'agent', id, desc, background: true, state: 'working', startedAt: t0, tools: 3, last: 'Reading the PDF', ...patch });

    await ui.evaluate(() => loadStepUI()); // eslint-disable-line no-undef
    await waitFor(() => ui.evaluate(() => Boolean(window.stepUI && window.agentsCard && window.cardItems)));
    await send({ type: 'tool', id: 's1', name: 'Write', label: 'Writing cp34.js', input: { file_path: 'cp34.js' } });
    await waitFor(() => ui.evaluate(() => document.querySelector('#messages .act-card')), 10000);
    const state = () => ui.evaluate(() => {
      const c = [...document.querySelectorAll('#messages .act-card')].at(-1);
      const ag = c?.querySelector('.agents-card');
      if (!ag) return null;
      const strip = ag.querySelector('.ag-tabs');
      const seen = (n) => Boolean(n) && !n.hidden && n.getClientRects().length > 0;
      const r = c.getBoundingClientRect();
      return {
        strip: seen(strip) ? strip.getAttribute('role') : '',
        tabs: seen(strip) ? [...strip.querySelectorAll('.ag-tab')].map((b) => ({ text: b.querySelector('.ag-tab-text').textContent, role: b.getAttribute('role'), sel: b.getAttribute('aria-selected'), badge: seen(b.querySelector('.ag-tab-badge')), focus: document.activeElement === b, tabIndex: b.tabIndex })) : [],
        items: [...ag.querySelectorAll('.ag-item')].filter(seen).map((li) => `${li.querySelector('.ag-item-name').textContent}=${li.dataset.state}:${li.querySelector('.ag-item-score').textContent}:${li.querySelector('.ag-item-time').textContent ? 'clock' : ''}`),
        rows: [...ag.querySelectorAll('.ag-row')].filter(seen).map((row) => row.querySelector('.ag-name').textContent),
        rv: seen(ag.querySelector('.ag-rv')) ? ag.querySelector('.ag-rv .rv-track').textContent : '',
        cardTrack: seen(c.querySelector(':scope > .act-review')),
        panel: ag.querySelector('.ag-panel')?.getAttribute('role') || '',
        h: Math.round(r.height * 100) / 100, top: Math.round(r.top * 100) / 100,
      };
    });

    // ---- 1. one agent: the plain list
    await send(agent('a1', 'Build 4.2 Gaussian elimination deck'));
    let v = await waitFor(async () => { const x = await state(); return x?.rows.length === 1 ? x : null; }, 8000);
    check('one agent: the plain list, no tabs', Boolean(v) && v.strip === '' && v.rows.length === 1, JSON.stringify(v));

    // ---- 2. three items: tabs, Overview picked
    await send(
      agent('r1', 'Review 4.2 deck round 1', { state: 'done', endedAt: Date.now() - 5000, summary: 'Score: 8.6/10. Tighten the pivoting example.' }),
      agent('a2', 'Build 4.3 RREF and rank deck'),
      agent('a3', 'Build 4.4 LU factorization deck', { state: 'failed', endedAt: Date.now() - 2000, summary: 'Could not open the template.' }),
      { type: 'review', round: 1, score: 8.6, bar: 9, title: '4.2 deck', fixes: ['Tighten the pivoting example'] },
    );
    v = await waitFor(async () => { const x = await state(); return x?.tabs.length === 4 ? x : null; }, 8000);
    check('three items: a tab strip (role=tablist) and a tabpanel', Boolean(v) && v.strip === 'tablist' && v.panel === 'tabpanel' && v.tabs.every((t) => t.role === 'tab'), JSON.stringify(v));
    check('...Overview, then "4.2 · 8.6", "4.3", "4.4"', Boolean(v) && v.tabs.map((t) => t.text).join('|') === 'Overview|4.2 · 8.6|4.3|4.4', JSON.stringify(v?.tabs));
    check('...the failed item\'s tab has a badge, no other does', Boolean(v) && v.tabs.map((t) => t.badge).join() === 'false,false,false,true', JSON.stringify(v?.tabs));
    check('...Overview is picked: a row per item with its state, score and clock', Boolean(v) && v.tabs[0].sel === 'true' && v.items.join('|') === '4.2=working:8.6/10:clock|4.3=working::clock|4.4=failed::clock', JSON.stringify(v?.items));
    check('...no agent rows (no tool calls) on Overview, and the card\'s own score track is not drawn twice', Boolean(v) && v.rows.length === 0 && !v.cardTrack, JSON.stringify(v));
    const shotDir = process.env.LUMEN_SHOT_DIR;
    const shot = async (name) => { if (!shotDir) return; const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); fs.writeFileSync(path.join(shotDir, name), Buffer.from(png, 'base64')); };
    await sleep(400);
    await shot('live-card-tabs-overview.png');
    const base = await state();

    // ---- 3. a click on 4.2: its agents and its rounds
    await ui.evaluate(() => [...document.querySelectorAll('#messages .ag-tab')].find((b) => b.dataset.key === '4.2').click());
    v = await state();
    check('4.2\'s tab: only its two agents, and its rounds', v.tabs[1].sel === 'true' && v.rows.join('|') === 'Build 4.2 Gaussian elimination deck|Review 4.2 deck round 1' && v.items.length === 0 && /R1\s*8\.6/.test(v.rv), JSON.stringify(v));
    check('...the card keeps its height and its place in the chat', Math.abs(v.h - base.h) < 0.5 && Math.abs(v.top - base.top) < 0.5, JSON.stringify({ base: [base.h, base.top], now: [v.h, v.top] }));
    await shot('live-card-tabs-item.png');

    // ---- 4. the keyboard
    await ui.evaluate(() => document.querySelector('#messages .ag-tab[aria-selected="true"]').focus());
    await ui.keyboard.press('ArrowRight');
    v = await state();
    check('ArrowRight: 4.3 picked and focused (one tab stop: the picked tab)', v.tabs[2].sel === 'true' && v.tabs[2].focus && v.tabs.filter((t) => t.tabIndex === 0).length === 1 && v.rows.join() === 'Build 4.3 RREF and rank deck', JSON.stringify(v));
    await ui.keyboard.press('End');
    v = await state();
    check('End: the last tab', v.tabs[3].sel === 'true' && v.tabs[3].focus, JSON.stringify(v.tabs));
    await ui.keyboard.press('ArrowRight');
    v = await state();
    check('ArrowRight on the last tab wraps to Overview', v.tabs[0].sel === 'true' && v.tabs[0].focus, JSON.stringify(v.tabs));
    await ui.keyboard.press('ArrowLeft');
    await ui.keyboard.press('Home');
    v = await state();
    check('ArrowLeft, then Home: back on Overview', v.tabs[0].sel === 'true' && v.tabs[0].focus, JSON.stringify(v.tabs));

    // ---- 5. every tab: nothing moves
    const hs = [];
    for (const key of ['4.2', '4.4', 'main', '4.3', '4.2', 'main']) {
      await ui.evaluate((k) => [...document.querySelectorAll('#messages .ag-tab')].find((b) => b.dataset.key === k).click(), key);
      hs.push(await state());
    }
    check('through every tab, the card\'s height and place do not move', hs.every((x) => Math.abs(x.h - base.h) < 0.5 && Math.abs(x.top - base.top) < 0.5), JSON.stringify(hs.map((x) => [x.h, x.top])));

    // ---- 6. the pick stays as the agents go on
    await ui.evaluate(() => [...document.querySelectorAll('#messages .ag-tab')].find((b) => b.dataset.key === '4.3').click());
    for (let i = 0; i < 6; i++) { await send(agent('a2', 'Build 4.3 RREF and rank deck', { tools: 4 + i * 9, last: `Writing slide ${i + 1}` })); await sleep(60); }
    v = await state();
    check('the picked tab stays picked as its agent goes on', v.tabs[2].sel === 'true' && v.rows.join() === 'Build 4.3 RREF and rank deck', JSON.stringify(v));
    await send(agent('r2', 'Review 4.3 deck round 1', { state: 'done', endedAt: Date.now(), summary: 'Score: 9.1/10' }));
    v = await waitFor(async () => { const x = await state(); return x?.tabs[2]?.text === '4.3 · 9.1' ? x : null; }, 5000);
    check('...and when a new round scores it, its label says so ("4.3 · 9.1") and it stays picked', Boolean(v) && v.tabs[2].sel === 'true', JSON.stringify(v?.tabs));

    // ---- 7. the run ends
    await send({ type: 'tool_done', id: 's1', ok: true }, agent('a1', 'Build 4.2 Gaussian elimination deck', { state: 'done', endedAt: Date.now(), summary: 'Built.' }), agent('a2', 'Build 4.3 RREF and rank deck', { state: 'done', endedAt: Date.now(), summary: 'Built.' }));
    await app.evaluate(() => global.__release?.());
    v = await waitFor(async () => { const x = await ui.evaluate(() => [...document.querySelectorAll('#messages .act-card')].at(-1)?.dataset.state); return x === 'completed' ? x : null; }, 15000);
    check('the run ends: the card says Done, its tabs stay', v === 'completed' && (await state()).tabs.length === 4, String(v));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall live-card-tabs checks passed');
  process.exit(failures ? 1 : 0);
})();
