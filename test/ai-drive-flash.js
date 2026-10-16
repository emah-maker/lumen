// While the AI drives a tab, the screen must not flash the accent colour (purple, with the Purple accent). A scripted provider (no network, no
// key) makes five tool calls on a local page: navigate, click, scroll, read_page, click. Every ~40 ms the window is captured (capturePage) and the
// share of the page area that shows the accent and is not covered by the page view is counted; in the page the indicator's state is sampled per frame.
//  - no frame shows the accent over more than a thin frame's worth of the page area (the old frame was the viewport's whole background, so any
//    moment the page view was hidden, resized or not yet painted showed a full purple screen);
//  - the "AI is working here" frame turns on once, stays on through all five actions and turns off once at the end (a single fade, no toggling);
//  - the viewport's own background is never the accent.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// The tab in front: click (a link, so a navigation), scroll, read, click again, scroll.
const FRONT_ACTIONS = [
  { name: 'click', input: { text: 'Next' } },
  { name: 'scroll', input: { direction: 'down' } },
  { name: 'read_page', input: {} },
  { name: 'click', input: { text: 'Next' } },
  { name: 'scroll', input: { direction: 'up' } },
];
// In a tab of its own: navigate (opens it), click, scroll, read, click.
const ACTIONS = [
  { name: 'navigate', input: { url: '__BASE__/b' } },
  { name: 'click', input: { text: 'Next' } },
  { name: 'scroll', input: { direction: 'down' } },
  { name: 'read_page', input: {} },
  { name: 'click', input: { text: 'Next' } },
];

const stubProvider = (app, base, actions) => app.evaluate((_e, { actions, base }) => {
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const usage = { input_tokens: 100, output_tokens: 20 };
    const done = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')).length;
    const next = actions[done];
    const gap = () => new Promise((r) => setTimeout(r, 450)); // time between actions, so frames are sampled in them
    if (next) {
      const input = JSON.parse(JSON.stringify(next.input).replace('__BASE__', base));
      return {
        async *[Symbol.asyncIterator]() { await gap(); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working.' } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: `tu-${done}`, name: next.name, input }], usage }),
      };
    }
    return {
      async *[Symbol.asyncIterator]() { await gap(); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All done.' } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All done.' }], usage }),
    };
  } } } });
}, { actions, base });

// In main: capture the window every ~40 ms; count pixels near the accent in the page area (the viewport) that no visible child view covers.
const startSampler = (app, accent) => app.evaluate(async ({ BrowserWindow }, accent) => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index'));
  const ui = win.webContents;
  global.__flash = { frames: [], stop: false, busy: true };
  const [ar, ag, ab] = accent;
  (async () => {
    while (!global.__flash.stop) {
      try {
        const r = await ui.executeJavaScript('(() => { const v = document.querySelector(".viewport").getBoundingClientRect(); return { x: Math.round(v.left), y: Math.round(v.top), w: Math.round(v.width), h: Math.round(v.height) }; })()');
        const covers = win.contentView.children.filter((c) => c.getVisible?.() !== false).map((c) => c.getBounds());
        const img = await ui.capturePage(r);
        const { width, height } = img.getSize();
        const k = width / r.w; // device pixels per DIP
        const px = img.toBitmap(); // BGRA
        let hit = 0;
        for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
          const dx = r.x + x / k; const dy = r.y + y / k;
          if (covers.some((b) => dx >= b.x && dx < b.x + b.width && dy >= b.y && dy < b.y + b.height)) continue; // a page view is painted there
          const i = (y * width + x) * 4;
          if (Math.abs(px[i + 2] - ar) < 24 && Math.abs(px[i + 1] - ag) < 24 && Math.abs(px[i] - ab) < 24) hit++;
        }
        const sampled = Math.max(1, Math.ceil(width / 2) * Math.ceil(height / 2));
        global.__flash.frames.push({ t: Date.now(), share: hit / sampled, views: covers.length });
      } catch { /* a capture can fail mid-navigation */ }
      await new Promise((res) => setTimeout(res, 20));
    }
    global.__flash.busy = false;
  })();
}, accent);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Fixture ${req.url}</title><body style="margin:0;background:#fff"><a href="/c">Next</a><p>fixture ${req.url}</p><div style="height:3000px">tall</div></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-flash-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('accent', 'purple'); });
    await stubProvider(app, base);
    await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); }, `${base}/a`);
    await sleep(800);
    const accent = await ui.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); });
    check('setup: the accent is a real colour', accent.some((v) => v > 0), accent);

    // One run of five AI actions, sampled. `prompt` decides where the AI works: "on this page" keeps it in the tab in front; otherwise it opens its own tab behind
    // the user's (navigate), so the user is looking at another tab than the AI's.
    const scenario = async (name, prompt, actions, { inFront }) => {
      const nm = (t) => `${name}: ${t}`;
      await stubProvider(app, base, actions);
      // Per-frame state of the indicator, in the UI page.
      await ui.evaluate(() => {
        window.__ind = []; window.__indStop = false;
        const norm = (s) => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = s; return c.fillStyle; };
        const want = norm(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
        const vp = document.querySelector('.viewport');
        const tick = () => {
          if (window.__indStop) return;
          const after = getComputedStyle(vp, '::after');
          const has = after.content !== 'none' && after.content !== 'normal';
          window.__ind.push({ t: performance.now(), active: document.body.classList.contains('agent-active'), away: document.body.classList.contains('agent-away'), ring: has ? Number(after.opacity) : 0, bgIsAccent: norm(getComputedStyle(vp).backgroundColor) === want });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await startSampler(app, accent);
      await sleep(300);
      // ---- the run: five AI actions
      await ui.evaluate((text) => { const p = document.getElementById('prompt'); p.value = text; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); }, prompt);
      check(nm('the run starts'), await waitFor(() => ui.evaluate(() => document.body.classList.contains('agent-active')), 10000), 'no agent-active');
      const finished = await waitFor(() => ui.evaluate(() => !document.body.classList.contains('agent-active')), 90000);
      check(nm('the run ends'), Boolean(finished), 'still running');
      await sleep(900); // the fade-out
      await ui.evaluate(() => { window.__indStop = true; });
      await app.evaluate(() => { global.__flash.stop = true; });
      await waitFor(() => app.evaluate(() => !global.__flash.busy), 5000);

      const frames = await app.evaluate(() => global.__flash.frames);
      const ind = await ui.evaluate(() => window.__ind);
      check(nm('frames were sampled during the run'), frames.length >= 10 && ind.length >= 50, `${frames.length} captures, ${ind.length} rAF samples`);
      const worst = frames.reduce((m, f) => Math.max(m, f.share), 0);
      // A thin frame (2 px) round the page is about 1 % of its area; a flash is most of it.
      check(nm('no frame shows the accent over more than 5% of the page area'), worst < 0.05, `worst ${(worst * 100).toFixed(1)}% of ${frames.length} frames; shares ${frames.map((f) => Math.round(f.share * 100)).join(',')}`);
      check(nm('the viewport background is never the accent'), !ind.some((s) => s.bgIsAccent), `${ind.filter((s) => s.bgIsAccent).length} samples`);

      // The indicator: its opacity goes up once and down once, and stays fully on in between.
      const on = ind.filter((s) => s.active);
      const away = on.filter((s) => s.away).length;
      let rises = 0; let falls = 0; let was = false; // crossings of half opacity
      for (const s of ind) { const now = s.ring >= 0.5; if (now && !was) rises++; if (!now && was) falls++; was = now; }
      const settledOn = on.slice(Math.floor(on.length * 0.2)).map((s) => s.ring); // (after the fade-in)
      check(nm('the indicator is steady while the run is active (fully on to the end)'), !inFront || (on.length > 20 && Math.min(...settledOn) >= 0.99), `min ${Math.min(...settledOn)} over ${on.length} samples`);
      check(nm('the indicator turns on once and off once (no toggling per action)'), inFront ? rises === 1 && falls === 1 : rises <= 1 && falls <= 1, `rises ${rises}, falls ${falls}`);
      check(nm('the indicator is off again after the run'), ind.length > 0 && ind[ind.length - 1].ring === 0, ind[ind.length - 1]?.ring);
      check(nm('in front: the AI never counted as being in another tab during the run'), !inFront || away === 0, away);

    };
    await scenario('in the tab in front', 'On this page, do the five things', FRONT_ACTIONS, { inFront: true });
    await scenario('in a tab of its own', 'Do the five things', ACTIONS, { inFront: false });
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
