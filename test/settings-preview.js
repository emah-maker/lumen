// Settings > Appearance: the preview of the new-tab page shows everything chosen, and is readable.
//   - for every background, in the light and the dark theme: the preview is in the same text mode as the real new-tab page (the same white or dark
//     text), and its clock, greeting and date meet WCAG AA against the pixels behind them (the standard of test/newtab-wallpaper.js)
//   - accent green + the bubbles effect: the preview carries the accent and draws moving bubbles; pointing at a background tile swaps only the
//     background (the accent, in that background's shade, and the effect stay)
//   - clock style, greeting font, name, clock card, size, widget glass and the search width reach it at once
//   - every effect animates in the preview, stops with Reduce motion and when the preview is not on screen, and adds no long task
// Offline; a throwaway profile; LUMEN_TEST_BACKGROUND keeps the windows off-screen.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BG = require('../src/features/backgrounds');
const TC = require('../src/features/theme-colors');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ntpreview-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarNewChat: false, performanceMode: 'off' }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    // The real new-tab page, to compare with.
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__home = t; });
    const home = (js) => app.evaluate((_e, c) => global.__home.webContents.executeJavaScript(c), js);
    // Settings, in its own tab (opened last, so it is the one in front).
    const sid = await app.evaluate(() => global.__settings.open('home'));
    const sp = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [sid, code]);
    for (let i = 0; i < 60 && !(await sp("Boolean(document.body.dataset.ready && document.getElementById('bg-preview'))").catch(() => false)); i++) await sleep(150);
    await app.evaluate(({ webContents }, id) => { for (const wc of [global.__settings.contents(id), global.__home.webContents]) { try { wc.debugger.attach('1.3'); } catch { /* attached */ } } }, sid);
    const theme = async (t) => {
      await app.evaluate((_e, [id, v]) => Promise.all([global.__settings.contents(id), global.__home.webContents].map((wc) => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] }))), [sid, t]);
      await sleep(700);
    };
    const save = (key, value) => sp(`save(${JSON.stringify(key)}, ${JSON.stringify(value)}).then(() => true)`);
    const view = () => sp("(() => { const b = document.getElementById('bg-preview'); b.scrollIntoView({ block: 'center' }); return true; })()");
    const ready = await sp('Boolean(window.NewTabPreview && window.NewTabPreview.last)');
    check('the preview module is loaded in Settings and built', ready === true, ready);
    const pv = () => sp(`(() => { const b = document.getElementById('bg-preview'); const q = (s) => b.querySelector(s); const cs = (e) => getComputedStyle(e);
      return { bg: b.dataset.bg, tone: b.dataset.tone, effect: b.dataset.effect, glass: b.dataset.glass, clockStyle: b.dataset.clockStyle, greetingFont: b.dataset.greetingFont, clockCard: b.dataset.clockCard,
        accent: cs(b).getPropertyValue('--accent').trim(), hello: q('.ntp-hello').textContent, helloColor: cs(q('.ntp-hello')).color, helloFamily: cs(q('.ntp-hello')).fontFamily,
        clockFamily: cs(q('.ntp-clock')).fontFamily, clockSize: cs(q('.ntp-stage')).getPropertyValue('--clock-size').trim(), searchW: cs(q('.ntp-stage')).getPropertyValue('--search-w').trim(),
        canvasHidden: q('.ntp-fx').hidden, w: b.clientWidth, h: b.clientHeight }; })()`);
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const parse = (css) => { const m = /rgba?\(([^)]+)\)/.exec(css); const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };

    // Where the preview's text is, its colour, and the pixels behind it (the text hidden), in the Settings tab's own picture.
    const behind = async () => {
      const boxes = await sp(`(() => { const b = document.getElementById('bg-preview'); b.scrollIntoView({ block: 'center' }); const out = {};
        for (const [id, s] of [['clock', '.ntp-clock'], ['greeting', '.ntp-hello'], ['date', '.ntp-date']]) { const el = b.querySelector(s); if (!el || el.hidden || el.offsetParent === null) continue;
          const r = document.createRange(); r.selectNodeContents(el); const x = r.getBoundingClientRect(); const c = getComputedStyle(el);
          out[id] = { x: x.left, y: x.top, w: x.width, h: x.height, color: c.color, size: parseFloat(c.fontSize), weight: Number(c.fontWeight) || 400 }; el.style.visibility = 'hidden'; }
        return out; })()`);
      await sleep(250);
      const px = await app.evaluate(async (_e, [id, bx]) => {
        const wc = global.__settings.contents(id); const img = await wc.capturePage(); const { width } = img.getSize(); const bm = img.toBitmap();
        const k = width / (await wc.executeJavaScript('innerWidth')); const out = {};
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        for (const [name, b] of Object.entries(bx)) {
          const ls = []; let R = 0, G = 0, B = 0, n = 0;
          for (let y = Math.floor(b.y * k); y < Math.ceil((b.y + b.h) * k); y++) for (let x = Math.floor(b.x * k); x < Math.ceil((b.x + b.w) * k); x++) { const o = (y * width + x) * 4; if (o + 2 >= bm.length) continue; R += bm[o + 2]; G += bm[o + 1]; B += bm[o]; n++; ls.push(0.2126 * f(bm[o + 2]) + 0.7152 * f(bm[o + 1]) + 0.0722 * f(bm[o])); }
          ls.sort((a, c) => a - c);
          out[name] = n ? { r: R / n, g: G / n, b: B / n, lo: ls[Math.floor(ls.length * 0.05)], hi: ls[Math.floor(ls.length * 0.95)], n } : null;
        }
        return out;
      }, [sid, boxes]);
      await sp("document.querySelectorAll('#bg-preview .ntp-clock, #bg-preview .ntp-hello, #bg-preview .ntp-date').forEach((e) => { e.style.visibility = ''; }); true");
      return { boxes, px };
    };
    const contrast = async (tag) => {
      const { boxes, px } = await behind();
      const rows = [];
      for (const [k, v] of Object.entries(boxes)) {
        const bg = px[k]; if (!bg) { rows.push({ k, ok: false, mean: 0, worst: 0 }); continue; }
        const t = parse(v.color);
        const mix = { r: t.r * t.a + bg.r * (1 - t.a), g: t.g * t.a + bg.g * (1 - t.a), b: t.b * t.a + bg.b * (1 - t.a) };
        const Lt = lum(mix.r, mix.g, mix.b); const mean = ratio(Lt, lum(bg.r, bg.g, bg.b));
        const worst = Math.min(ratio(Lt, bg.lo), ratio(Lt, bg.hi));
        const large = v.size >= 24 || (v.size >= 18.66 && v.weight >= 700); // (the stage's own sizes: the box only scales them)
        rows.push({ k, mean: +mean.toFixed(2), worst: +worst.toFixed(2), ok: mean >= (large ? 3 : 4.5) && worst >= 3 });
      }
      check(`${tag}: the preview's clock, greeting and date meet AA (${rows.map((r) => `${r.k} ${r.mean}:1, worst ${r.worst}`).join('; ')})`, rows.length >= 3 && rows.every((r) => r.ok), JSON.stringify(rows));
    };
    const until = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(80); } return v; };

    // ---------- every background, both themes: the page's text mode, and AA ----------
    await save('newTabShuffle', false);
    await save('accentColor', 'blue');
    await save('newTabEffect', 'none');
    const ids = BG.BACKGROUNDS.map((b) => b.id);
    await view();
    for (const t of ['dark', 'light']) {
      await theme(t);
      for (const id of ids) {
        await save('newTabBackground', id);
        const real = await until(async () => { const r = await home("({ bg: document.body.dataset.bg, media: document.body.classList.contains('on-media'), light: document.body.classList.contains('tone-light'), color: getComputedStyle(document.getElementById('greeting')).color })"); return r.bg === id && r; }, 6000);
        const p = await until(async () => { const r = await pv(); return r.bg === id && r.w > 0 && r; });
        const realTone = real ? (real.light ? 'light' : real.media ? 'dark' : 'plain') : '?';
        const rl = real ? lum(...Object.values(parse(real.color)).slice(0, 3)) : -1; const pl = p ? lum(...Object.values(parse(p.helloColor)).slice(0, 3)) : -1;
        const sameColor = realTone === 'plain' ? (rl > 0.3) === (pl > 0.3) : real?.color === p?.helloColor;
        check(`${t}: ${id}: the preview is in the page's text mode (${p?.tone} / page ${realTone}) and text colour (${p?.helloColor} / ${real?.color})`, Boolean(p) && Boolean(real) && p.tone === realTone && sameColor && (realTone === 'light' ? pl < 0.1 : realTone === 'dark' ? pl > 0.8 : true), JSON.stringify({ p, real }));
        await sleep(150);
        await contrast(`${t}: ${id}`);
      }
    }
    // A picture (a measured, bright one): the page keeps white text over it under its scrim, so the preview does too.
    // (No picture is set in this profile: "Your picture" with none is Plain, on the page and here.)

    // ---------- the accent and the effect follow the settings ----------
    await theme('dark');
    await save('newTabBackground', 'nebula');
    await save('accentColor', 'green');
    await save('newTabEffect', 'bubbles');
    await save('newTabEffectSpeed', 'fast');
    await view();
    let p = await until(async () => { const r = await pv(); return r.effect === 'bubbles' && r.accent === TC.accentOf('green').dark && r; });
    check(`accent green: the preview's accent is green's dark shade (${p?.accent})`, Boolean(p), JSON.stringify(await pv()));
    const fx = () => sp('window.NewTabPreview.last.info()');
    let f = await until(async () => { const x = await fx(); return x?.fx?.name === 'bubbles' && x.fx.animating && x; });
    check('effect bubbles: the preview runs the bubbles effect, animating', Boolean(f), JSON.stringify(await fx()));
    const canvasHash = () => sp(`(() => { const c = document.querySelector('#bg-preview .ntp-fx'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0, on = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3]) { on++; h = (h * 31 + d[i + 3] + d[i]) | 0; } } return { on, h, w: c.width, hh: c.height }; })()`);
    const c1 = await canvasHash(); await sleep(900); const c2 = await canvasHash();
    check(`the preview's canvas has bubbles drawn (${c1.on} pixels) and they move (${c1.h} -> ${c2.h})`, c1.on > 50 && c1.h !== c2.h, JSON.stringify({ c1, c2 }));
    await save('accentColor', 'wallpaper');
    p = await until(async () => { const r = await pv(); return r.accent === TC.accentOf(TC.MATCH_WALLPAPER, BG.byId('nebula').seed).dark && r; });
    check(`Match wallpaper: the accent follows the background (${p?.accent})`, Boolean(p), JSON.stringify(await pv()));
    await save('accentColor', 'green');

    // Pointing at a background tile swaps only the background.
    await sp("document.querySelector('#pref-newTabBackground [data-value=\"peach\"]').dispatchEvent(new Event('pointerenter')); true");
    p = await until(async () => { const r = await pv(); return r.bg === 'peach' && r; });
    f = await fx();
    check(`hovering Peach: the preview shows Peach in dark text (${p?.tone}), the green accent in its light shade (${p?.accent}) and still the bubbles (${p?.effect})`,
      p?.tone === 'light' && p.accent === TC.accentOf('green').light && p.effect === 'bubbles' && f?.fx?.name === 'bubbles', JSON.stringify({ p, f }));
    await sp("document.querySelector('#pref-newTabBackground [data-value=\"peach\"]').dispatchEvent(new Event('pointerleave')); true");
    p = await until(async () => { const r = await pv(); return r.bg === 'nebula' && r; });
    check('leaving the tile puts the chosen background back', Boolean(p) && p.accent === TC.accentOf('green').dark, JSON.stringify(p));
    // Pointing at an effect tile swaps only the effect.
    await sp("document.querySelector('#pref-newTabEffect [data-value=\"snow\"]').dispatchEvent(new Event('pointerenter')); true");
    p = await until(async () => { const r = await pv(); return r.effect === 'snow' && r; });
    check(`hovering Snow: the preview draws snow over the chosen background and accent (${p?.bg}, ${p?.accent})`, Boolean(p) && p.bg === 'nebula' && p.accent === TC.accentOf('green').dark, JSON.stringify(p));
    await sp("document.querySelector('#pref-newTabEffect [data-value=\"snow\"]').dispatchEvent(new Event('pointerleave')); true");
    p = await until(async () => { const r = await pv(); return r.effect === 'bubbles' && r; });
    check('leaving the effect tile puts the chosen effect back', Boolean(p), JSON.stringify(p));

    // ---------- clock, greeting, name, card, size, search width, glass ----------
    await save('newTabClockStyle', 'serif');
    await save('newTabGreetingFont', 'mono');
    await save('newTabClockCard', 'glass');
    await save('newTabClockSize', 'xl');
    await save('newTabSearchWidth', 800);
    await save('newTabWidgetGlass', 'clear');
    p = await until(async () => { const r = await pv(); return r.clockStyle === 'serif' && r.greetingFont === 'mono' && r.glass === 'clear' && r; });
    check(`clock style Serif and greeting font Mono reach the preview (${p?.clockFamily} / ${p?.helloFamily})`, Boolean(p) && /serif|Cambria|Georgia|New York/i.test(p.clockFamily) && /mono|Consolas|Cascadia/i.test(p.helloFamily), JSON.stringify(p));
    check(`clock card, size (${p?.clockSize}), search width (${p?.searchW}) and widget glass (${p?.glass}) reach it`, p?.clockCard === 'glass' && p.clockSize === '160px' && p.searchW === '800px' && p.glass === 'clear', JSON.stringify(p));
    await sp("(() => { const i = document.getElementById('pref-newTabName'); i.value = 'Ada'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    p = await until(async () => { const r = await pv(); return /, Ada$/.test(r.hello) && r; });
    check(`the name typed shows in the greeting at once (${p?.hello})`, Boolean(p), JSON.stringify(await pv()));
    await save('newTabClockStyle', 'bold'); await save('newTabGreetingFont', 'match'); await save('newTabWidgetGlass', 'frosted');
    p = await until(async () => { const r = await pv(); return r.clockStyle === 'bold' && r; });
    check(`Match clock follows the clock's face, Frosted glass (${p?.greetingFont}, ${p?.glass})`, p?.greetingFont === 'classic' && p.glass === 'frosted', JSON.stringify(p));
    await save('newTabClockStyle', 'classic'); await save('newTabGreetingFont', 'classic'); await save('newTabClockCard', 'none'); await save('newTabClockSize', 'm'); await save('newTabSearchWidth', 640); await save('newTabWidgetGlass', 'solid');
    await contrast('after the clock, greeting and glass choices, over Nebula with bubbles');

    // ---------- Graphics: Light ----------
    await save('newTabWidgetGlass', 'frosted'); await save('newTabEffect', 'none'); await save('graphicsMode', 'full'); // (Automatic is Light on an integrated GPU)
    await until(async () => (await pv()).gfx === 'full');
    const blur = () => sp("getComputedStyle(document.querySelector('#bg-preview .ntp-card')).backdropFilter");
    check('Graphics: Full effects: the preview frosted cards blur what is behind them', (await blur()) !== 'none', await blur());
    await save('graphicsMode', 'light');
    await until(async () => (await pv()).gfx === 'light');
    check('Graphics: Light: the preview draws no blur behind its cards', (await blur()) === 'none', await blur());
    await save('newTabEffect', 'bubbles');
    f = await until(async () => { const x = await fx(); return x?.fx?.light && x.fx.name === 'bubbles' && x; });
    check('Graphics: Light: the effect runs in its lighter form in the preview', Boolean(f), JSON.stringify(await fx()));
    await save('graphicsMode', 'full');
    await save('newTabWidgetGlass', 'solid');

    // ---------- the effects: animating, still with Reduce motion, stopped when off screen, no long tasks ----------
    await sp(`window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch {} true`);
    const frames = async (ms) => { const a = (await fx())?.fx?.frames ?? -1; await sleep(ms); const b = (await fx())?.fx?.frames ?? -1; return b - a; };
    await save('newTabEffectSpeed', 'normal');
    for (const effect of BG.EFFECT_IDS.filter((x) => x !== 'none')) {
      await save('newTabEffect', effect);
      f = await until(async () => { const x = await fx(); return x?.fx?.name === effect && x; });
      await sleep(400);
      const moving = await frames(1500);
      const info = await fx();
      check(`effect ${effect}: it animates in the preview (${moving} frames in 1.5 s, slowest ${info?.fx?.maxMs?.toFixed?.(1)} ms)`, moving >= 2 && info.fx.maxMs < 50, JSON.stringify(info));
    }
    // Hidden: the pane is not on screen.
    await save('newTabEffect', 'particles'); await sleep(500);
    await sp("document.getElementById('bg-preview').closest('.pane').hidden = true; true"); await sleep(500);
    const offscreen = await frames(1200);
    check(`the preview draws nothing while Settings' page is hidden (${offscreen} frames)`, offscreen === 0, offscreen);
    await sp("document.getElementById('bg-preview').closest('.pane').hidden = false; true"); await sleep(600);
    check('...and runs again when it is shown', (await frames(1200)) >= 2, JSON.stringify(await fx()));
    // Reduce motion: a still frame.
    await save('reduceMotion', true); await sleep(500);
    const still = await frames(1200); f = await fx();
    check(`Reduce motion: one still frame, no loop (${still} frames, animating ${f?.fx?.animating})`, still === 0 && f.fx.animating === false, JSON.stringify(f));
    const stillPixels = await canvasHash();
    check(`...and the still frame is drawn (${stillPixels.on} pixels)`, stillPixels.on > 20, JSON.stringify(stillPixels));
    await save('reduceMotion', false); await sleep(600);
    check('turning Reduce motion off animates it again', (await frames(1200)) >= 2, JSON.stringify(await fx()));
    const long = await sp('window.__long');
    check(`the preview adds no long task over 50 ms (${JSON.stringify(long)})`, long.length === 0, JSON.stringify(long));
    await save('newTabEffect', 'none');
    p = await until(async () => { const r = await pv(); return r.canvasHidden && r; });
    check('with no effect the preview has no canvas showing', Boolean(p), JSON.stringify(await pv()));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall settings-preview checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
