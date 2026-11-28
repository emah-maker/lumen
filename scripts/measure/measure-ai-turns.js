// Times the sidebar AI's tool calls end to end with a scripted fake model (no network, no key) on local pages, in a hidden window on a
// throwaway profile. Each scenario is a list of model turns, each turn a list of tool calls; the script prints every call's time
// (LUMEN_TOOL_TIMING=1: "[lumen] tool navigate 180 ms", and navigate's phases) and each scenario's whole run time.
//   node scripts/measure/measure-ai-turns.js [--runs=5] [--app=<folder>] [--only=navigate]
// Run it under the e2e lock: node scripts/test/e2e-lock.js run --owner measure -- node scripts/measure/measure-ai-turns.js
// Pages: /plain/N (a small page), /redirect/N (302 to /plain/N), /jsredirect/N (location.replace at parse), /spa/N (an app shell that
// draws its text 150 ms after load and pushes a route), /slow/N (answers after 300 ms), /heavy/N (text and an image that takes 400 ms: wait "interactive" is meant to return before the image, but Electron's executeJavaScript* run only once the page stops loading, so it can't yet), /shell/N (little text and an image that takes 400 ms: dom-ready long before load).
require('../../test/helpers/_tmp-cleanup');
/* global document */ // (the ui.evaluate callbacks run in the browser window)
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => a.startsWith('--runs='))?.slice(7)) || 5;
const APP = path.resolve(args.find((a) => a.startsWith('--app='))?.slice(6) || path.join(__dirname, '..', '..'));
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) || '').split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const waitFor = async (fn, ms = 30000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(50); } return v; };

const page = (title, body, head = '') => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const filler = '<p>' + 'Some ordinary words on a small local page. '.repeat(12) + '</p>';
const server = (label) => new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const [, kind, n] = req.url.split('/');
    const html = (text) => { res.setHeader('Content-Type', 'text/html'); res.end(text); };
    if (kind === 'redirect') { res.statusCode = 302; res.setHeader('Location', `/plain/${n}`); return res.end(); }
    if (kind === 'jsredirect') return html(page('Moving', '<p>Moving…</p>', `<script>location.replace('/plain/${n}r')</script>`));
    if (kind === 'spa') return html(page(`App ${n}`, '<div id="app"></div><script>addEventListener("load", () => setTimeout(() => { history.pushState(null, "", "/spa/' + n + '/home"); document.getElementById("app").innerHTML = "<h1>App home ' + n + '</h1>' + filler.replace(/"/g, '\\"') + '<button>Go</button>"; }, 150));</script>'));
    if (kind === 'img') { setTimeout(() => { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'); }, 400); return; }
    if (kind === 'heavy') return html(page(`Heavy ${n}`, `<h1>Heavy ${n}</h1>${filler}<img src="/img/h${n}"><button>Go</button>`));
    if (kind === 'shell') return html(page(`Shell ${n}`, `<h1>Shell ${n}</h1><img src="/img/${n}"><button>Go</button>`));
    if (kind === 'slow') { setTimeout(() => html(page(`Slow ${n}`, `<h1>Slow ${n}</h1>${filler}<button>Press</button>`)), 300); return; }
    return html(page(`Plain ${label} ${n}`, `<h1>Plain ${label} ${n}</h1>${filler}<button onclick="document.title='Pressed'">Press</button>`));
  });
  s.listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
});

(async () => {
  const A = await server('A');
  const B = await server('B');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ai-turns-'));
  const app = await electron.launch({
    args: [APP],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1', LUMEN_TOOL_TIMING: '1' },
    colorScheme: null,
  });
  const lines = [];
  app.process().stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.includes('[lumen] ')) lines.push(l.slice(l.indexOf('[lumen] ') + 8).trim()); });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    // The fake model: global.__fake.turns is the script (an array of turns, each an array of { name, input }); each model call answers
    // with the next turn's calls, and with "Done." once the script is over. A turn's calls are told apart by their ids.
    await app.evaluate(() => {
      const fake = global.__fake = { turns: [], at: 0, done: 0 };
      global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
        const turn = fake.turns[fake.at++];
        const content = turn ? turn.map((c, i) => ({ type: 'tool_use', id: `t${fake.at}-${i}-${Date.now()}`, name: c.name, input: c.input })) : [{ type: 'text', text: 'Done.' }];
        if (!turn) fake.done++;
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: turn ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 50, output_tokens: 10 } };
        return { async *[Symbol.asyncIterator]() { for (const [index, b] of content.entries()) if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; }, finalMessage: async () => message };
      } } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#prompt', { state: 'visible' });
    const running = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
    const runScript = async (turns, text) => {
      await ui.click('#new-chat').catch(() => {});
      await app.evaluate((_e, t) => { global.__fake.turns = t; global.__fake.at = 0; }, turns);
      const before = await app.evaluate(() => global.__fake.done);
      const from = lines.length;
      const t0 = Date.now();
      await ui.fill('#prompt', text);
      await ui.press('#prompt', 'Enter');
      await waitFor(async () => (await app.evaluate(() => global.__fake.done)) > before && !(await running()), 60000);
      return { ms: Date.now() - t0, lines: lines.slice(from) };
    };
    const toolMs = (ls, name) => ls.map((l) => new RegExp(`^tool ${name} (\\d+) ms`).exec(l)).filter(Boolean).map((m) => Number(m[1]));
    const report = (label, xs) => console.log(`${label.padEnd(44)} median ${String(median(xs)).padStart(5)} ms  [${xs.join(', ')}]`);

    if (!ONLY.length || ONLY.includes('navigate')) {
      const cases = { first: [], plain: [], redirect: [], jsredirect: [], spa: [], slow: [], shell: [], heavy: [] };
      const phases = [];
      for (let r = 0; r < RUNS; r++) {
        const n = `${r}`;
        const turns = [
          [{ name: 'navigate', input: { url: `${A.url}/plain/${n}a` } }], // the chat's first navigate: opens the AI's own tab
          [{ name: 'navigate', input: { url: `${A.url}/plain/${n}b` } }],
          [{ name: 'navigate', input: { url: `${A.url}/redirect/${n}c` } }],
          [{ name: 'navigate', input: { url: `${A.url}/jsredirect/${n}d` } }],
          [{ name: 'navigate', input: { url: `${A.url}/spa/${n}e` } }],
          [{ name: 'navigate', input: { url: `${A.url}/slow/${n}f` } }],
          [{ name: 'navigate', input: { url: `${A.url}/shell/${n}g` } }],
          [{ name: 'navigate', input: { url: `${A.url}/heavy/${n}h` } }],
        ];
        const out = await runScript(turns, `Open the pages ${r}`);
        const ms = toolMs(out.lines, 'navigate');
        ['first', 'plain', 'redirect', 'jsredirect', 'spa', 'slow', 'shell', 'heavy'].forEach((k, i) => { if (Number.isFinite(ms[i])) cases[k].push(ms[i]); });
        phases.push(...out.lines.filter((l) => l.startsWith('navigate phases')));
        // What the AI saw: the redirect, JS redirect and SPA pages must report where they landed and what they show.
        const urls = await app.evaluate(() => global.__agent.browser.listTabs().map((t) => t.url));
        if (r === 0) console.log(`  tabs after run 1: ${urls.join(' | ')}`);
      }
      for (const [k, xs] of Object.entries(cases)) report(`navigate ${k}`, xs);
      console.log('  phases (first run):');
      for (const p of phases.slice(0, 8)) console.log(`    ${p}`);
    }

  } finally {
    await app.close().catch(() => {});
    A.server.close(); B.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
