// Times the AI's browser tools (navigate, scroll, hover, read_urls) in a real Lumen window on a throwaway profile,
// and how much of a page read_page sees straight after navigate (a late-hydrating page: youtube, github, react.dev).
//   node scripts/measure-tool-waits.js [--runs=5] [--app=<folder>]   (--app: measure another checkout)
// Needs network. No sign-in, no account actions.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => a.startsWith('--runs='))?.slice(7)) || 5;
const APP = path.resolve(args.find((a) => a.startsWith('--app='))?.slice(6) || path.join(__dirname, '..'));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-wait-measure-'));
  const app = await electron.launch({ args: [APP], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
      const t = Date.now();
      try { const r = await global.__agent.execute(n, i); return { ms: Date.now() - t, out: typeof r === 'string' ? r : JSON.stringify(r) }; } catch (err) { return { ms: Date.now() - t, out: `ERROR: ${err.message}` }; }
    }, [name, input]);
    const rows = [];
    const row = (label, ms, extra = '') => { rows.push({ label, ms: median(ms), all: ms, extra }); console.log(`${label.padEnd(34)} median ${String(median(ms)).padStart(5)} ms  [${ms.join(', ')}] ${extra}`); };
    for (const [label, url] of [['navigate example.com', 'https://example.com'], ['navigate wikipedia', 'https://en.wikipedia.org/wiki/Electron_(software_framework)'], ['navigate youtube.com', 'https://www.youtube.com'], ['navigate github.com/electron', 'https://github.com/electron/electron'], ['navigate react.dev', 'https://react.dev']]) {
      const ms = [];
      let read = 0;
      for (let i = 0; i < RUNS; i++) {
        await run('navigate', { url: 'about:blank'.replace('about:blank', 'https://example.org') });
        const r = await run('navigate', { url });
        ms.push(r.ms);
        read = (await run('read_page', {})).out.length;
      }
      row(label, ms, `read_page chars after navigate: ${read}`);
    }
    await run('navigate', { url: 'https://en.wikipedia.org/wiki/Electron_(software_framework)' });
    let ms = [];
    for (let i = 0; i < RUNS; i++) ms.push((await run('scroll', { direction: i % 2 ? 'up' : 'down', screens: 1 })).ms);
    row('scroll (wikipedia)', ms);
    ms = [];
    for (let i = 0; i < RUNS; i++) ms.push((await run('read_urls', { urls: ['https://example.com'] })).ms);
    row('read_urls (example.com)', ms);
    ms = [];
    for (let i = 0; i < RUNS; i++) ms.push((await run('go_back', {})).ms, (await run('go_forward', {})).ms);
    row('go_back/go_forward (wikipedia)', ms);
    ms = [];
    for (let i = 0; i < RUNS; i++) ms.push((await run('reload', {})).ms);
    row('reload', ms);
    await run('navigate', { url: 'https://example.com' });
    const id = JSON.parse((await run('read_page', {})).out.split('\n')[1]).elements[0]?.id;
    ms = [];
    for (let i = 0; i < RUNS && id; i++) ms.push((await run('hover', { element_id: id })).ms);
    if (id) row('hover (example.com link)', ms);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
