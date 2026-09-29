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
    for (let i = 0; i < 20 && !((e = await fx()).canvas && (await page('window.setBackdropEffect?.info?.()?.name')) === name); i++) await sleep(100);
    let drawn = 0;
    for (let i = 0; i < 20 && !drawn; i++, await sleep(100)) drawn = await page("new Promise((res) => { const c = document.getElementById('effect'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; res(n); })");
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

  // ---- the effect's options: color, amount, speed, size, the pointer
  await app.evaluate(() => { global.__lookTab = global.__agent.browser.activeTab(); });
  const info = () => app.evaluate(() => global.__lookTab.webContents.executeJavaScript('window.setBackdropEffect?.info?.() || null'));
  const until = async (fn) => { let v; for (let i = 0; i < 20 && !(v = await fn()); i++) await sleep(100); return v; };
  check('an effect color must be a #rrggbb, auto, accent or rainbow', (await set('newTabEffectColor', 'red')).startsWith('ERROR') && (await set('newTabEffectColor', 'url(x)')).startsWith('ERROR'), 'accepted');
  await set('newTabEffectColor', '#FF3366');
  let fi = await until(async () => { const x = await info(); return x?.colors?.[0] === '255, 51, 102' && x; });
  check('a custom color colors the particles (and their lines)', fi && fi.colors.length === 1 && fi.line === '255, 51, 102', JSON.stringify(fi));
  await set('newTabEffectColor', 'rainbow');
  fi = await until(async () => { const x = await info(); return x?.colors?.length === 6 && x; });
  check('rainbow uses six colors', Boolean(fi), JSON.stringify(await info()));
  await set('newTabEffectColor', 'accent');
  fi = await until(async () => { const x = await info(); return x?.colors?.length === 1 && x; });
  const accentRgb = await page("(() => { const n = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().slice(1), 16); return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`; })()");
  check('accent follows the accent color', fi?.colors[0] === accentRgb, JSON.stringify({ fi, accentRgb }));
  const normalCount = (await info()).count;
  await set('newTabEffectAmount', 'few');
  const few = await until(async () => { const x = await info(); return x && x.count < normalCount && x; });
  await set('newTabEffectAmount', 'many');
  const many = await until(async () => { const x = await info(); return x && x.count > normalCount && x; });
  check('Amount changes how many (few < normal < many)', few && many && few.count < normalCount && normalCount < many.count, JSON.stringify({ few: few?.count, normalCount, many: many?.count }));
  check('…and stays capped', many.count <= 150, many.count);
  await set('newTabEffectSpeed', 'fast');
  await set('newTabEffectSize', 'large');
  await set('newTabEffectInteract', false);
  fi = await until(async () => { const x = await info(); return x?.speed > 1 && x.size > 1 && x.interact === false && x; });
  check('Speed, Size and React to the pointer apply', Boolean(fi), JSON.stringify(await info()));
  check('an unknown amount, speed or size is refused', (await set('newTabEffectAmount', 'tons')).startsWith('ERROR') && (await set('newTabEffectSpeed', 9)).startsWith('ERROR') && (await set('newTabEffectSize', 'huge')).startsWith('ERROR'), 'accepted');

  // ---- it never covers anything: clicks reach the fields, and typing works with it running
  await set('newTabFavorites', true);
  await sleep(300);
  const hits = await page(`(() => { const at = (el) => { const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === el || el.contains(e) ? 'ok' : (e?.id || e?.tagName); };
    return [document.getElementById('q'), document.getElementById('mode-ask'), ...document.querySelectorAll('#sections a')].filter(Boolean).slice(0, 6).map(at); })()`);
  check('the effect is under every field and link (they get the clicks)', hits.length >= 3 && hits.every((x) => x === 'ok'), JSON.stringify(hits));
  check('…and takes no pointer events itself', (await page("getComputedStyle(document.getElementById('effect')).pointerEvents")) === 'none', 'takes clicks');
  const q = await page("(() => { const r = document.getElementById('q').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()");
  await app.evaluate((_e, p) => { const wc = global.__agent.browser.activeTab().webContents; wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 }); for (const c of 'cats') wc.sendInputEvent({ type: 'char', keyCode: c }); }, q);
  await sleep(300);
  check('clicking the search box and typing works over an effect', (await page("document.activeElement.id + ':' + document.getElementById('q').value")) === 'q:cats', await page("document.activeElement.id + ':' + document.getElementById('q').value"));
  await page("document.getElementById('q').value = ''");

  // ---- Settings shows the options only with an effect on
  const sid = await app.evaluate(() => global.__settings.open('appearance'));
  const sp = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [sid, code]);
  for (let i = 0; i < 40 && !(await sp("Boolean(document.body.dataset.ready && document.getElementById('effect-options'))").catch(() => false)); i++) await sleep(150);
  const opts = await sp("({ hidden: document.getElementById('effect-options').hidden, colors: document.querySelectorAll('#effect-options [data-color]').length, checked: document.querySelector('#effect-options [aria-checked=true]')?.dataset.color, selects: ['newTabEffectAmount', 'newTabEffectSpeed', 'newTabEffectSize'].map((k) => document.getElementById('pref-' + k)?.value) })");
  check('Settings: the effect options show, with the current choices', !opts.hidden && opts.colors === 9 && opts.checked === 'accent' && opts.selects.join() === 'many,fast,large', JSON.stringify(opts));
  await sp("document.querySelector('#effect-options [data-color=\"#30d158\"]').click()");
  fi = await until(async () => { const x = await info(); return x?.colors?.[0] === '48, 209, 88' && x; });
  check('Settings: a swatch sets the color on an open new-tab page', Boolean(fi), JSON.stringify(await info()));
  await sp("(() => { const s = document.getElementById('pref-newTabEffect'); s.value = 'none'; s.dispatchEvent(new Event('change')); })()");
  await sleep(300);
  check('Settings: choosing None hides the options', await sp("document.getElementById('effect-options').hidden"), 'shown');
  await app.evaluate((_e, id) => { global.__agent.browser.closeTab(id); global.__agent.browser.switchTab(global.__lookTab.id); }, sid);
  for (const [k, v] of [['newTabEffectColor', 'auto'], ['newTabEffectAmount', 'normal'], ['newTabEffectSpeed', 'normal'], ['newTabEffectSize', 'normal'], ['newTabEffectInteract', true]]) await set(k, v);
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
