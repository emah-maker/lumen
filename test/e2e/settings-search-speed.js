// Settings search typed right after the page opens (hidden app, throwaway profile). The page used to wait for every section to be built, AI providers (which
// probes the command-line AIs) last, about 0.8 s after the first screen. Now:
//   - a search shows what is built at once and the rest as it finishes, and the AI providers rows are built without waiting for the probes (their Status rows say
//     "Checking…" until the answer comes)
//   - "proxy" (a row in a page that is not built when the first screen paints) is the one result within SEARCH_MS of the first screen
//   - while sections are still being built a search that finds nothing yet does not say "Nothing matches"
//   - every section is built soon after, and the Status rows end up filled in
// Usage: node scripts/test/e2e-lock.js run -- node test/e2e/settings-search-speed.js (set LUMEN_TEST_BACKGROUND=1, CLAUDE_BROWSER_TEST=1 and a temp CLAUDE_BROWSER_PROFILE)
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { tmpProfile, env, root, sleep } = require('../helpers/_settings-open-rig');

const SEARCH_MS = 150; // from the first screen being complete to the search's answer being on screen
const RUNS = 3;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const app = await electron.launch({ args: [root], env: env(tmpProfile()) });
  const swallowDialogs = (p) => p.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  app.on('window', swallowDialogs);
  for (const p of app.windows()) swallowDialogs(p);
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(6000); // (the browser's own startup work first: the first open is cold for Settings, not for the browser)
    const run = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [id, code]);
    const timings = [];
    for (let n = 0; n < RUNS; n++) {
      await app.evaluate(() => { for (const t of global.__settings.tabs().filter((t) => t.settings)) global.__closeTabInteractive(t.id); });
      await sleep(1500);
      const id = await app.evaluate(() => global.__settings.open('general'));
      // as soon as the first screen is complete: type, then watch for the answer
      const code = `(async () => {
        while (!(window.__settingsPerf && window.__settingsPerf.visibleDone)) await new Promise((r) => setTimeout(r, 5));
        const readyAtType = document.body.dataset.ready === '1';
        const s = document.getElementById('search');
        const t = performance.now();
        s.focus(); s.value = 'proxy'; s.dispatchEvent(new Event('input', { bubbles: true }));
        const shown = () => [...document.querySelectorAll('#sections .row')].filter((r) => r.offsetParent !== null && !r.classList.contains('filtered'));
        let ms = null; let falseEmpty = false; let labels = [];
        for (let i = 0; i < 600 && ms === null; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          if (!document.getElementById('no-results').hidden && document.body.dataset.ready !== '1') falseEmpty = true;
          const rows = shown();
          if (rows.some((r) => /^Proxy/.test(r.querySelector('.label')?.textContent || ''))) { ms = Math.round(performance.now() - t); labels = rows.map((r) => r.querySelector('.label')?.textContent); }
        }
        return JSON.stringify({ ms, falseEmpty, readyAtType, labels: labels.slice(0, 5) });
      })()`;
      const r = JSON.parse(await run(id, code));
      timings.push(r.ms);
      console.log(`run ${n + 1}: proxy on screen ${r.ms} ms after the first screen (every section already built when typed: ${r.readyAtType}); rows ${JSON.stringify(r.labels)}`);
      check(`run ${n + 1}: search shown within ${SEARCH_MS} ms of the first screen`, r.ms !== null && r.ms <= SEARCH_MS, r.ms);
      check(`run ${n + 1}: no "Nothing matches" while sections are still being built`, !r.falseEmpty);
      // the rest of the page still finishes, and the provider Status rows get their answer
      let done = false;
      for (let i = 0; i < 100 && !done; i++) { done = (await run(id, "document.body.dataset.ready === '1'")) === true; if (!done) await sleep(100); }
      check(`run ${n + 1}: every section is built`, done);
      let states = [];
      for (let i = 0; i < 100; i++) {
        states = JSON.parse(await run(id, "JSON.stringify([...document.querySelectorAll('#sec-ai-providers [id^=provider-state-]')].map((e) => e.textContent))"));
        if (states.length && states.every((s) => !/^Checking/.test(s))) break;
        await sleep(100);
      }
      check(`run ${n + 1}: the provider Status rows are filled in`, states.length > 0 && states.every((s) => !/^Checking/.test(s)), JSON.stringify(states));
    }
    // relevance on the real page (the rows the audit found too many or none of)
    const id = (await app.evaluate(() => global.__settings.tabs().filter((t) => t.settings).map((t) => t.id)))[0];
    const found = async (q) => JSON.parse(await run(id, `(async () => {
      const s = document.getElementById('search'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return JSON.stringify([...document.querySelectorAll('#sections .row')].filter((r) => r.offsetParent !== null && !r.classList.contains('filtered')).map((r) => r.querySelector('.label')?.textContent));
    })()`));
    const R = {};
    for (const q of ['agents', 'claude', 'grok', 'autofill', 'mute', 'energy', 'developer', 'notification']) { R[q] = await found(q); console.log(`  ${q}: ${R[q].length} rows: ${R[q].slice(0, 4).join(' | ')}`); }
    check("'agents' no longer lists every row of the AI page", R.agents.length > 0 && R.agents.length < 60, R.agents.length);
    check("'claude' and 'grok' are each a handful of rows and not the same ones", R.claude.length > 0 && R.claude.length < 40 && R.grok.length > 0 && R.grok.length < 40 && R.claude.join() !== R.grok.join(), `${R.claude.length} / ${R.grok.length}`);
    for (const q of ['autofill', 'mute', 'energy', 'developer', 'notification']) check(`'${q}' finds a setting`, R[q].length > 0 && R[q].length < 15, R[q].length);
    await run(id, "(() => { const s = document.getElementById('search'); s.value = 'zebra crossing'; s.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await sleep(300);
    check('a search with no answer shows the empty state with the query', (await run(id, "!document.getElementById('no-results').hidden && /zebra crossing/.test(document.getElementById('no-results-query').textContent)")) === true);
    await run(id, "(() => { const s = document.getElementById('search'); s.value = 'dark zebra'; s.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await sleep(300);
    check('...and offers the words that do match on their own', (await run(id, "[...document.querySelectorAll('#no-results-suggest button')].map((b) => b.textContent).join() === 'dark'")) === true);
    const mean = Math.round(timings.reduce((a, b) => a + (b ?? 0), 0) / timings.length);
    console.log(`mean ${mean} ms`);
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
