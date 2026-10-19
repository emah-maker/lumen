// lumen://tasks in a real window (features/mission-control.js, renderer/mission.html), with a fake model: no API tokens.
// The sidebar's More menu opens the page; a background task waiting for an OK shows under Needs you and is answered there with
// the Tasks panel's own Allow once; a running task shows under Running now with its step, and Stop on the page stops it;
// finished runs land under Recent; and a web page has no bridge to the page's calls.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const hits = {};
  const server = http.createServer((req, res) => { hits[req.url] = (hits[req.url] || 0) + 1; res.setHeader('Content-Type', 'text/html'); res.end(`<title>Page ${req.url}</title><p>Text for ${req.url}</p>`); }).listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mission-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' }, colorScheme: null });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');

    // The fake model (as test/bgtasks.js): each task's turns by its TASK-x marker; a turn may hold until released.
    await app.evaluate(() => {
      global.__scripts = {};
      global.__holds = {};
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const marker = /TASK-[A-Z0-9]+/.exec(JSON.stringify(params.messages[0].content))?.[0];
        const turn = params.messages.filter((m) => m.role === 'assistant').length;
        const step = (global.__scripts[marker] || [])[turn] || { content: [{ type: 'text', text: 'No script.' }] };
        const content = step.content.map((b, i) => (b.type === 'tool_use' ? { ...b, id: `tu_${marker}_${turn}_${i}` } : b));
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 1000, output_tokens: 100 } };
        return {
          async *[Symbol.asyncIterator]() {
            if (step.hold) await new Promise((r) => { global.__holds[step.hold] = r; });
            for (const b of content) if (b.type === 'text') yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: b.text } };
          },
          finalMessage: async () => message,
        };
      } } } });
    });
    const script = (marker, turns) => app.evaluate((_e, [m, t]) => { global.__scripts[m] = t; }, [marker, turns]);
    const tool = (name, input) => ({ content: [{ type: 'tool_use', name, input }] });
    const say = (text, hold) => ({ content: [{ type: 'text', text }], ...(hold ? { hold } : {}) });
    const statusOf = (m) => app.evaluate((_e, mk) => global.__bg.tasks().find((x) => x.prompt.includes(mk))?.status || null, m);
    const create = (spec) => ui.evaluate((s) => window.assistant.tasks.create({ confirmed: true, ...s }), spec);

    // ---- 1. The sidebar's More menu opens lumen://tasks, once per window.
    await ui.evaluate(() => document.getElementById('mission-btn').click());
    const pageWc = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => !w.isDestroyed() && w.getURL().endsWith('/renderer/mission.html')));
    check('the More menu item opens the page', await waitFor(pageWc), '');
    const inPage = (js) => app.evaluate(async ({ webContents }, code) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().endsWith('/renderer/mission.html'));
      return wc ? wc.executeJavaScript(code, true) : '__nopage';
    }, js);
    check('its address shows as lumen://tasks', await waitFor(() => ui.evaluate(() => document.getElementById('address')?.value === 'lumen://tasks')), await ui.evaluate(() => document.getElementById('address')?.value));
    check('the four sections are there, empty, with Needs you announced politely', await waitFor(() => inPage("document.querySelectorAll('#needs-list .empty, #running-list .empty, #scheduled-list .empty, #recent-list .empty').length === 4 && document.getElementById('needs-list').getAttribute('aria-live') === 'polite'")), await inPage("document.body.innerText"));
    await ui.evaluate(() => window.assistant.tasks.openFull());
    await sleep(300);
    check('opening it again switches to the same tab', (await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().endsWith('/renderer/mission.html')).length)) === 1, '');

    // ---- 2. Needs you: a task waiting for an OK, answered in place with Allow once (the Tasks panel's own answer).
    await script('TASK-B', [tool('navigate', { url: `${other}/b` }), say('RESULT-B reached the other host')]);
    await create({ prompt: `TASK-B open 127.0.0.1:${port}/a then go on`, schedule: { type: 'now' } });
    check('the card shows under Needs you with Allow once', await waitFor(() => inPage("[...document.querySelectorAll('#needs-list .card')].some((c) => c.textContent.includes('TASK-B') && [...c.querySelectorAll('button')].some((b) => b.textContent === 'Allow once'))")), await inPage("document.getElementById('needs-list').innerText"));
    check('the page title counts what waits', await inPage('document.title.startsWith("(1)")'), await inPage('document.title'));
    await inPage("[...document.querySelectorAll('#needs-list .card button')].find((b) => b.textContent === 'Allow once').click()");
    check('the task goes on and finishes', await waitFor(async () => (await statusOf('TASK-B')) === 'done'), await statusOf('TASK-B'));
    check('the page was really opened after the answer', (hits['/b'] || 0) >= 1, JSON.stringify(hits));
    check('Needs you is empty again', await waitFor(() => inPage("Boolean(document.querySelector('#needs-list .empty'))")), '');
    check('the finished run is under Recent', await waitFor(() => inPage("[...document.querySelectorAll('#recent-list .row')].some((r) => r.textContent.includes('TASK-B') && r.textContent.includes('Done'))")), await inPage("document.getElementById('recent-list').innerText"));

    // ---- 3. Running now: a running task with its step; Stop on the page stops it.
    await script('TASK-S', [tool('navigate', { url: `${base}/s` }), { ...say('never', 'S') }]);
    await create({ prompt: `TASK-S read 127.0.0.1:${port}/s`, schedule: { type: 'now' } });
    check('the task is running', await waitFor(async () => (await statusOf('TASK-S')) === 'running'), await statusOf('TASK-S'));
    check('it shows under Running now with a Stop button', await waitFor(() => inPage("[...document.querySelectorAll('#running-list .row')].some((r) => r.textContent.includes('TASK-S') && [...r.querySelectorAll('button')].some((b) => b.textContent === 'Stop'))")), await inPage("document.getElementById('running-list').innerText"));
    const focusable = await inPage("(() => { const b = [...document.querySelectorAll('#running-list button')].find((x) => x.textContent === 'Stop'); b.focus(); return document.activeElement === b && b.tagName === 'BUTTON' && b.getAttribute('aria-label').includes('TASK-S'); })()");
    check('Stop is a real, focusable button with a name', focusable === true, focusable);
    await inPage("[...document.querySelectorAll('#running-list .row')].find((r) => r.textContent.includes('TASK-S')).querySelector('button').click()");
    await waitFor(() => app.evaluate(() => Boolean(global.__holds.S)), 3000);
    await app.evaluate(() => global.__holds.S?.()); // the fake stream ignores the abort signal; a real one ends at once
    check('Stop on the page stops the task', await waitFor(async () => (await statusOf('TASK-S')) === 'stopped'), await statusOf('TASK-S'));
    check('it leaves Running now', await waitFor(() => inPage("![...document.querySelectorAll('#running-list .row')].some((r) => r.textContent.includes('TASK-S'))")), await inPage("document.getElementById('running-list').innerText"));

    // ---- 4. The page's bridge is only the page's: a web tab has none.
    await app.evaluate((_e, u) => global.__agent.browser.openTab(u), `${base}/web`);
    await sleep(800);
    const fromWeb = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().endsWith('/web'));
      return wc ? wc.executeJavaScript('typeof window.lumenMission') : 'no tab';
    });
    check('a web page has no lumenMission bridge', fromWeb === 'undefined', fromWeb);
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite threw  -> ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})();
