// REAL on-device translation, end to end, with the network (manual, not in `npm test`): downloads the
// French -> English pack from Mozilla into a throwaway profile, translates a French page with Bergamot in
// the utility process, and measures. `SHOTS=<dir>` saves screenshots (before, download, after).
// `SITE=<url>` also translates a real page (any language the packs cover) and reports its timings.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PARAS = [
  'Le gouvernement a annoncé hier de nouvelles mesures pour soutenir les petites entreprises touchées par la crise économique.',
  'Selon le ministre, ces aides seront versées dès le mois prochain et concerneront plus de cent mille entreprises à travers le pays.',
  'Les syndicats ont salué cette décision, tout en demandant que les salariés soient mieux protégés dans les mois à venir.',
  'La ville de Lyon accueillera cet été un grand festival de musique qui réunira des artistes venus de toute l’Europe.',
  'Les organisateurs espèrent attirer plus de deux cent mille visiteurs pendant les trois semaines que durera l’événement.',
  'Dans le sud de la France, la sécheresse inquiète les agriculteurs, qui craignent de perdre une grande partie de leurs récoltes.',
  'Les scientifiques rappellent que les températures records observées cette année sont directement liées au changement climatique.',
  'Le nouveau musée, construit au bord de la rivière, ouvrira ses portes au public le premier jour du printemps.',
];
const page = (n) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Actualités du jour</title><style>body{font:18px/1.6 Georgia,serif;max-width:720px;margin:24px auto;padding:0 16px}h1{font-size:34px}</style></head><body>
<h1>Les actualités du jour en France</h1>
${Array.from({ length: n }, (_, i) => `<p>${PARAS[i % PARAS.length]} <a href="/lien${i}">Lire la suite</a></p>`).join('\n')}
<pre>const bonjour = "monde";</pre></body></html>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 60000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(100); } return v; };
  const shots = process.env.SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(req.url.startsWith('/long') ? 120 : 24)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-translate-real-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: '' }, colorScheme: null });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  // The browser UI (address bar and infobar) and the page are separate views: save both, side by side in one PNG name each.
  let shotTab = null;
  const shot = async (name) => {
    if (!shots) return;
    await ui.screenshot({ path: path.join(shots, `translate-${name}-ui.png`) });
    if (shotTab !== null) {
      const buf = await app.evaluate(async (_e, i) => (await global.__translate.tab(i).view.webContents.capturePage()).toPNG().toString('base64'), shotTab);
      fs.writeFileSync(path.join(shots, `translate-${name}-page.png`), Buffer.from(buf, 'base64'));
    }
  };
  const stateOf = (id) => app.evaluate((_e, i) => global.__translate.api.stateOf(global.__translate.tab(i)), id);
  const open = (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-finish-load', r)); return t.id; }, url);
  const inTab = (id, js) => app.evaluate((_e, [i, code]) => global.__translate.tab(i).view.webContents.executeJavaScript(code), [id, js]);
  const act = (id, a, arg) => app.evaluate((_e, [i, x, y]) => global.__translate.api.act(global.__translate.tab(i), x, y), [id, a, arg]);
  const barText = () => ui.$eval('#translate-bar', (el) => (el.hidden ? '' : el.textContent));
  const barClick = (label) => ui.evaluate((l) => { const b = [...document.querySelectorAll('#translate-bar button')].find((x) => x.textContent === l); if (b) b.click(); return Boolean(b); }, label);
  const settingsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); } catch { return {}; } };

  // Slow the download a little so the progress bar can be seen (and screenshotted); the bytes are real.
  await app.evaluate(({ net }) => {
    global.__translateNetHook = async (url, options) => {
      const res = await net.fetch(url, { ...options, headers: { ...options?.headers, 'user-agent': 'Lumen' } });
      if (!url.includes('attachments')) return res;
      const reader = res.body.getReader();
      return new Response(new ReadableStream({ async pull(c) { const { done, value } = await reader.read(); if (done) { c.close(); return; } await new Promise((r) => setTimeout(r, 10)); c.enqueue(value); } }), { status: res.status, headers: res.headers });
    };
  });

  const fr = await open(`${base}/fr`);
  shotTab = fr;
  await waitFor(async () => (await stateOf(fr))?.phase === 'offer');
  check('a French page is offered', (await stateOf(fr))?.lang === 'fr', JSON.stringify(await stateOf(fr)));
  await waitFor(async () => (await barText()).includes('French'));
  await shot('1-before');

  const t0 = Date.now();
  await barClick('Translate');
  const ask = await waitFor(async () => (await barText()).includes('language pack') && (await barText()));
  check('the first translation asks before downloading, naming the pair and size', /French → English/.test(ask) && /\d+ MB/.test(ask), ask);
  await shot('2-download-ask');
  await barClick('Download and translate');
  const prog = await waitFor(async () => { const s = await stateOf(fr); return s?.phase === 'download' && s.progress > 10 && s.progress < 100; }, 8000);
  if (prog) await shot('3-download-progress');
  check('the download shows progress', Boolean(prog), JSON.stringify(await stateOf(fr)));
  const bad = await waitFor(async () => (await stateOf(fr))?.phase === 'error', 3000);
  if (bad) { console.log('  error:', JSON.stringify(await stateOf(fr)), await app.evaluate(() => 0)); await app.close(); process.exit(1); }
  const working = await waitFor(async () => (await stateOf(fr))?.phase === 'working', 60000);
  const tDownloaded = Date.now();
  const done = await waitFor(async () => (await stateOf(fr))?.phase === 'done', 60000);
  const tDone = Date.now();
  await sleep(300);
  check('the page is translated on this device', Boolean(done) && /government|Government/.test(await inTab(fr, "document.querySelector('p').textContent")), await inTab(fr, "document.querySelector('p').textContent"));
  console.log(`  heading: ${await inTab(fr, "document.querySelector('h1').textContent")}`);
  console.log(`  first paragraph: ${await inTab(fr, "document.querySelector('p').textContent")}`);
  await shot('4-after');
  check('code and links keep their structure', (await inTab(fr, "document.querySelector('pre').textContent")) === 'const bonjour = "monde";' && (await inTab(fr, "document.querySelectorAll('a[href^=\"/lien\"]').length")) === 24, '');
  const t1 = await app.evaluate((_e, i) => global.__translate.api.timings(global.__translate.tab(i)), fr);
  console.log(`  [measure] first translation (download included): click to done ${tDone - t0} ms; download ${t1?.downloadMs} ms; first text ${t1?.toFirstTextMs} ms after work began; work ${t1?.totalMs} ms for ${t1?.items} nodes / ${t1?.chars} chars`);
  const dirSize = (d) => fs.readdirSync(d).reduce((n, f) => { const p = path.join(d, f); return n + (fs.statSync(p).isDirectory() ? dirSize(p) : fs.statSync(p).size); }, 0);
  console.log(`  [measure] pack on disk: ${(dirSize(path.join(profile, 'translation-models')) / 1e6).toFixed(1)} MB; settings.translateConsent=${JSON.stringify(settingsFile().translateConsent)}`);
  check('no AI consent was involved', !(settingsFile().translateConsent || []).length, JSON.stringify(settingsFile().translateConsent));

  // Warm engine, then cold engine (process stopped), then a long page.
  const timing = async (id, label) => {
    await act(id, 'original');
    await waitFor(async () => (await inTab(id, "document.querySelector('h1').textContent")).startsWith('Les actualit'));
    const s = Date.now();
    await act(id, 'translate-local');
    await waitFor(async () => (await inTab(id, "document.querySelector('h1').textContent")).startsWith('Today'), 30000);
    const first = Date.now() - s;
    await waitFor(async () => (await stateOf(id))?.phase === 'done', 60000);
    const total = Date.now() - s;
    const t = await app.evaluate((_e, i) => global.__translate.api.timings(global.__translate.tab(i)), id);
    console.log(`  [measure] ${label}: click to first translated text ${first} ms, to done ${total} ms (work ${t.totalMs} ms, ${t.items} nodes, ${t.chars} chars)`);
    return { first, total };
  };
  await app.evaluate(() => global.__translate.api.clearCache());
  const warm = await timing(fr, 'warm engine, uncached');
  await app.evaluate(() => { global.__translateLocal().stop(); global.__translate.api.clearCache(); });
  const cold = await timing(fr, 'cold engine (process restarted), uncached');
  check('first text appears within 2 s with the pack on disk, even from a cold process', cold.first < 2000 && warm.first < 2000, `${warm.first} / ${cold.first}`);
  const long = await open(`${base}/long`);
  await waitFor(async () => (await stateOf(long))?.phase === 'offer');
  const lt = await timing(long, 'long page (120 paragraphs), engine warm');
  check('a long page finishes', lt.total < 60000, lt.total);

  // The engine runs in its own process, off the UI thread.
  const procs = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => `${m.type}:${m.name || ''}`));
  check('the translator runs in a separate utility process', procs.some((p) => /Lumen translation/.test(p)), procs.join(' | '));

  if (process.env.SITE) {
    const site = await open(process.env.SITE);
    const offered = await waitFor(async () => (await stateOf(site))?.phase === 'offer', 15000);
    console.log(`  [site] ${process.env.SITE}: detected ${(await stateOf(site))?.lang || '?'}, offered=${Boolean(offered)}`);
    if (offered) {
      const s = Date.now();
      await act(site, 'translate-local');
      await waitFor(async () => ['download-consent'].includes((await stateOf(site))?.phase) && (await barText()).includes('Download'), 20000).then(async (ask2) => { if (ask2) await barClick('Download and translate'); });
      const ok = await waitFor(async () => (await stateOf(site))?.phase === 'done', 120000);
      const t = await app.evaluate((_e, i) => global.__translate.api.timings(global.__translate.tab(i)), site);
      console.log(`  [site] done=${Boolean(ok)} in ${Date.now() - s} ms; ${JSON.stringify(t)}; title: ${await inTab(site, 'document.title')}`);
      await shot('5-site');
    }
  }
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
