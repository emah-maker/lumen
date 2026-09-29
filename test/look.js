// The look (Settings → Appearance): the accent color reaches the browser UI and the new-tab page,
// and the new-tab page takes its background (presets or a picture kept in the profile), clock,
// greeting name and sections from Settings, live, without reloading. Offline.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const set = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v).then(() => 'ok', (err) => `ERROR ${err.message}`), [key, value]);
  const dark = await ui.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

  // ---- accent color
  check('an accent preset is accepted', (await set('accentColor', 'orange')) === 'ok', 'refused');
  await sleep(300);
  const uiAccent = await ui.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check('the browser UI takes the accent (light or dark shade)', uiAccent === (dark ? '#ff9f0a' : '#ff9500'), uiAccent);
  check('a custom #rrggbb accent is accepted', (await set('accentColor', '#12AB34')) === 'ok', 'refused');
  await sleep(300);
  check('…and applied', (await ui.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#12ab34', 'not applied');
  check('anything else is refused', (await set('accentColor', 'red; background:url(x)')).startsWith('ERROR') && (await set('accentColor', '#fff')).startsWith('ERROR'), 'accepted');

  // ---- the new-tab page
  await set('newTabName', 'Ada');
  await set('newTabBackground', 'aurora');
  await app.evaluate(() => new Promise((r) => { const t = global.__agent.browser.openTab(); t.webContents.once('did-finish-load', r); }));
  const page = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  const look = () => page("({ bg: document.body.dataset.bg, media: document.body.classList.contains('on-media'), clock: !document.getElementById('clock').hidden && document.getElementById('clock').textContent, greeting: document.getElementById('greeting').textContent, sections: [...document.querySelectorAll('#sections h2')].map((h) => h.textContent), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), marker: window.__marker || null })");
  let l = await look();
  check('the new-tab page shows the chosen background', l.bg === 'aurora' && l.media, JSON.stringify(l));
  check('the clock shows the time', /^\d{1,2}:\d{2}$/.test(l.clock || ''), l.clock);
  check('the greeting has the name', /, Ada$/.test(l.greeting), l.greeting);
  check('the page takes the accent too', l.accent === '#12ab34', l.accent);

  // Changes reach an open new-tab page at once, without reloading it.
  await page('window.__marker = 1');
  await set('newTabBackground', 'ocean');
  await set('newTabFavorites', false);
  await set('newTabClock', false);
  await sleep(500);
  l = await look();
  check('an open new-tab page follows a new background without reloading', l.bg === 'ocean' && l.marker === 1, JSON.stringify(l));
  check('sections can be hidden', !l.sections.includes('Favorites'), JSON.stringify(l.sections));
  check('the clock can be hidden', l.clock === false, JSON.stringify(l.clock));
  await set('newTabBackground', 'plain');
  await sleep(400);
  l = await look();
  check('Plain has no backdrop and normal text', l.bg === 'plain' && !l.media, JSON.stringify(l));

  // ---- animated effects: loaded only when on, drawn at a capped rate, gone when off
  const fx = () => page("({ script: [...document.scripts].some((x) => /newtab-effects\\.js$/.test(x.src)), canvas: document.querySelectorAll('#effect').length, w: document.getElementById('effect')?.width || 0, api: typeof window.setBackdropEffect })");
  let e = await fx();
  check('with no effect, its script is never loaded', !e.script && !e.canvas && e.api === 'undefined', JSON.stringify(e));
  check('an unknown effect is refused', (await set('newTabEffect', 'fireworks')).startsWith('ERROR'), 'accepted');
  for (const name of ['particles', 'stars', 'bubbles', 'snow']) {
    await set('newTabEffect', name);
    for (let i = 0; i < 20 && !(e = await fx()).canvas; i++) await sleep(100);
    const drawn = await page("new Promise((res) => { const c = document.getElementById('effect'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; res(n); })");
    check(`${name}: one canvas that draws something`, e.script && e.canvas === 1 && e.w > 0 && drawn > 0, JSON.stringify({ e, drawn }));
  }
  // The frame rate stays capped (rAF can still run 60 times a second; the effect draws at most 30).
  const fps = await page(`new Promise((res) => { const c = document.getElementById('effect'); const ctx = c.getContext('2d'); let n = 0; const orig = ctx.clearRect.bind(ctx); ctx.clearRect = (...a) => { n++; return orig(...a); }; setTimeout(() => { ctx.clearRect = orig; res(n); }, 1000); })`);
  check('an effect draws at most ~30 frames a second', fps <= 32, fps);
  await set('newTabEffect', 'none');
  await sleep(400);
  e = await fx();
  check('turning it off removes the canvas and stops drawing', e.canvas === 0, JSON.stringify(e));
  await set('newTabEffect', 'particles');
  await set('reduceMotion', true);
  await sleep(400);
  const still = await page("new Promise((res) => { const ctx = document.getElementById('effect').getContext('2d'); let n = 0; const orig = ctx.clearRect.bind(ctx); ctx.clearRect = (...a) => { n++; return orig(...a); }; setTimeout(() => res(n), 500); })");
  check('Reduce motion leaves one still frame (nothing animates)', still === 0 && (await fx()).canvas === 1, still);
  await set('reduceMotion', false);
  await set('newTabEffect', 'none');

  // ---- a picture kept in the profile
  const profile = await app.evaluate(({ app }) => app.getPath('userData'));
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(40 * 30 * 4, 200), { width: 40, height: 30 }).toJPEG(80).toString('base64'));
  fs.writeFileSync(path.join(profile, 'newtab-wallpaper.jpg'), Buffer.from(png, 'base64'));
  await set('newTabImage', Date.now());
  await set('newTabBackground', 'image');
  await sleep(500);
  l = await look();
  const wallpaper = await page("document.body.style.getPropertyValue('--wallpaper')");
  check('a picture from the profile is the background', l.bg === 'image' && /^url\("file:\/\/\/.*newtab-wallpaper\.jpg\?v=\d+"\)$/.test(wallpaper), `${l.bg} ${wallpaper}`);

  // The page only ever shows a picture from a file: URL (never one a site could have put there).
  await page(`(() => { const d = JSON.parse(decodeURIComponent(location.hash.slice(1))); d.look.image = 'https://example.com/x.jpg'; history.replaceState(null, '', location.pathname + '#' + encodeURIComponent(JSON.stringify(d))); dispatchEvent(new HashChangeEvent('hashchange')); })()`);
  l = await look();
  check('a web address as the picture is ignored', l.bg === 'plain', JSON.stringify(l));

  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
