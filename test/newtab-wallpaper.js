// The new-tab page's wallpaper (gradient, picture) covers the whole page, top included: the top band is the wallpaper's colours,
// not a flat black or the page colour, in light and dark, and still so after the sidebar opens and the window is resized.
// Every background of features/backgrounds.js is applied in turn, in the light and the dark theme: the top band shows it (what a probe
// layer of the same art paints over the page is what the page paints), the page is in the text mode the catalogue says (white text over a
// dark one, dark text over a light one), and the clock, the greeting and the date meet AA against the pixels behind them, with and without
// a soft animated effect over it. The animated effects stop when the page is hidden and with Reduce motion.
// Offline; a throwaway profile; LUMEN_TEST_BACKGROUND keeps the window off-screen. Screenshots go to LUMEN_SHOTS if set.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const BG = require('../src/features/backgrounds');
const TC = require('../src/features/theme-colors');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ntwall-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarNewChat: false, performanceMode: 'off',
    homeWidgets: [{ id: 'wwall001', type: 'notes', x: 0, y: 0, w: 3, h: 3 }] }));
  const shots = process.env.LUMEN_SHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    // A bright orange picture fixture (a local file).
    const fixture = path.join(profile, 'wall-fixture.jpg');
    const jpg = await app.evaluate(({ nativeImage }) => {
      const w = 64, h = 64, buf = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) { buf[i * 4] = 0; buf[i * 4 + 1] = 140; buf[i * 4 + 2] = 255; buf[i * 4 + 3] = 255; } // BGRA: orange
      return nativeImage.createFromBitmap(buf, { width: w, height: h }).toJPEG(95).toString("base64");
    });
    fs.writeFileSync(fixture, Buffer.from(jpg, 'base64'));
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__home = t; });
    const home = (js) => app.evaluate((_e, c) => global.__home.webContents.executeJavaScript(c), js);
    for (let i = 0; i < 60 && !(await home('document.querySelectorAll(".w-card").length >= 1').catch(() => false)); i++) await sleep(100);
    await app.evaluate(() => { try { global.__home.webContents.debugger.attach('1.3'); } catch { /* attached */ } });
    // The page's colour scheme, emulated in the page (the window's own theme does not reach an off-screen page).
    const theme = async (t) => { await app.evaluate((_e, v) => global.__home.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] }), t); await sleep(1000); };
    const look = async (bg, image) => { // applied twice: the page's own first apply (settings read) must not land after ours
      for (let i = 0; i < 2; i++) { await home(`applyLook({ ...currentLook, background: ${JSON.stringify(bg)}, image: ${JSON.stringify(image || null)}, effect: 'none' }); true`); await sleep(600); }
    };
    // Average colour of the left margin (x 0-4%, where no content sits) over y 0-40% of the page.
    const band = async (name) => {
      await sleep(700);
      const r = await app.evaluate(async () => {
        const img = await global.__home.webContents.capturePage();
        const { width, height } = img.getSize(); const bm = img.toBitmap(); // BGRA
        let R = 0, G = 0, B = 0, n = 0, dark = 0;
        for (let y = 0; y < Math.floor(height * 0.4); y += 2) for (let x = 0; x < Math.max(2, Math.floor(width * 0.04)); x += 2) { const o = (y * width + x) * 4; R += bm[o + 2]; G += bm[o + 1]; B += bm[o]; n++; if (bm[o] + bm[o + 1] + bm[o + 2] < 12) dark++; }
        return { w: width, h: height, r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n), black: dark / n, png: img.toPNG().toString('base64') };
      });
      if (shots) fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.png, 'base64'));
      r.png = 0;
      return r;
    };
    const notBlack = (b) => b.black < 0.05 && b.r + b.g + b.b > 60;
    const orange = (b) => notBlack(b) && b.r > 90 && b.r > b.b + 60;
    const grad = (b) => notBlack(b) && b.r > b.g + 15;
    const resize = (w, h) => app.evaluate(({ BrowserWindow }, [a, c]) => BrowserWindow.getAllWindows()[0].setContentSize(a, c), [w, h]);
    const toggle = () => ui.evaluate(() => document.getElementById('toggle-sidebar').click());

    await sleep(1500);
    for (const t of ['dark', 'light']) {
      await theme(t);
      await look('sunset');
      let b = await band(`gradient-${t}`);
      const page = await home('getComputedStyle(document.documentElement).backgroundColor');
      check(`${t}: gradient wallpaper, top band is the gradient (${b.r},${b.g},${b.b}), not black`, grad(b), JSON.stringify(b));
      check(`${t}: gradient wallpaper, top band is not the page colour ${page}`, page !== `rgb(${b.r}, ${b.g}, ${b.b})`, page);
      await look('image', pathToFileURL(fixture).href);
      b = await band(`image-${t}`);
      check(`${t}: picture wallpaper, top band is orange (${b.r},${b.g},${b.b}), not black`, orange(b), JSON.stringify(b));
    }
    // After the sidebar opens, and at another size.
    await theme('dark');
    await look('sunset');
    await toggle(); await sleep(900);
    let b = await band('gradient-sidebar-open');
    check(`sidebar open: gradient top band is the gradient (${b.r},${b.g},${b.b})`, grad(b), JSON.stringify(b));
    await resize(900, 600); await sleep(700);
    b = await band('gradient-sidebar-open-resized');
    check(`sidebar open and resized: gradient top band is the gradient (${b.r},${b.g},${b.b})`, grad(b), JSON.stringify(b));
    await look('image', pathToFileURL(fixture).href);
    b = await band('image-sidebar-open-resized');
    check(`sidebar open and resized: picture top band is orange (${b.r},${b.g},${b.b})`, orange(b), JSON.stringify(b));
    await toggle(); await sleep(900);
    b = await band('image-sidebar-closed');
    check(`sidebar closed again: picture top band is orange (${b.r},${b.g},${b.b})`, orange(b), JSON.stringify(b));
    // Plain: the page's own colour, no black.
    await look('plain');
    b = await band('plain-dark');
    check(`plain dark: top band is the page colour (${b.r},${b.g},${b.b}), not black`, notBlack(b), JSON.stringify(b));
    await theme('light');
    b = await band('plain-light');
    check(`plain light: top band is light (${b.r},${b.g},${b.b})`, b.r > 200 && b.g > 200, JSON.stringify(b));

    // ---------- every background: the band, the text mode, the text's contrast ----------
    await resize(1280, 800); await sleep(500);
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const parse = (css) => { const m = /rgba?\(([^)]+)\)/.exec(css); const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    // Through the real setting (the page follows it as it does for a user), not applyLook: the page re-reads its settings now and then.
    const set = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v).then(() => 'ok', (err) => `ERROR ${err.message}`), [key, value]);
    const applyBg = async (id, extra = {}) => {
      await set('newTabBackground', id); await set('newTabEffect', extra.effect || 'none'); await set('reduceMotion', Boolean(extra.still));
      await sleep(600);
    };
    // Where the text is (its glyph box) and what colour it is, then the pixels behind it with the text hidden.
    const textBoxes = () => home(`(() => { const out = {}; for (const id of ['clock', 'greeting', 'date']) { const el = document.getElementById(id); if (!el || el.hidden) continue; const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); out[id] = { x: b.left, y: b.top, w: b.width, h: b.height, color: getComputedStyle(el).color, size: parseFloat(getComputedStyle(el).fontSize), weight: Number(getComputedStyle(el).fontWeight) || 400 }; } return out; })()`);
    const behind = async (boxes, shot) => { // per box: mean colour and the 5th/95th percentile luminance of the pixels
      await home("document.querySelector('header').style.visibility = 'hidden'; true"); await sleep(250);
      const r = await app.evaluate(async (_e, [bx, name]) => {
        const wc = global.__home.webContents; const img = await wc.capturePage(); const { width } = img.getSize(); const bm = img.toBitmap();
        const k = width / (await wc.executeJavaScript('innerWidth')); const out = {};
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        for (const [id, b] of Object.entries(bx)) {
          const ls = []; let R = 0, G = 0, B = 0, n = 0;
          for (let y = Math.floor(b.y * k); y < Math.ceil((b.y + b.h) * k); y += 2) for (let x = Math.floor(b.x * k); x < Math.ceil((b.x + b.w) * k); x += 2) { const o = (y * width + x) * 4; if (o + 2 >= bm.length) continue; R += bm[o + 2]; G += bm[o + 1]; B += bm[o]; n++; ls.push(0.2126 * f(bm[o + 2]) + 0.7152 * f(bm[o + 1]) + 0.0722 * f(bm[o])); }
          ls.sort((a, c) => a - c);
          out[id] = { r: R / n, g: G / n, b: B / n, lo: ls[Math.floor(ls.length * 0.05)], hi: ls[Math.floor(ls.length * 0.95)] };
        }
        return out;
      }, [boxes, shot]);
      await home("document.querySelector('header').style.visibility = ''; true");
      return r;
    };
    const textContrast = async (tag, id) => { // every piece of header text >= 4.5 (3 for large text) on the mean pixel behind it, and >= 3 on the worst 5%
      const boxes = await textBoxes();
      const px = await behind(Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, { x: v.x, y: v.y, w: v.w, h: v.h }])));
      const rows = [];
      for (const [k, v] of Object.entries(boxes)) {
        const bg = px[k]; const t = parse(v.color);
        const mix = { r: t.r * t.a + bg.r * (1 - t.a), g: t.g * t.a + bg.g * (1 - t.a), b: t.b * t.a + bg.b * (1 - t.a) };
        const Lt = lum(mix.r, mix.g, mix.b); const mean = ratio(Lt, lum(bg.r, bg.g, bg.b));
        const worst = Math.min(ratio(Lt, bg.lo), ratio(Lt, bg.hi));
        const large = v.size >= 24 || (v.size >= 18.66 && v.weight >= 700);
        rows.push({ k, mean: +mean.toFixed(2), worst: +worst.toFixed(2), ok: mean >= (large ? 3 : 4.5) && worst >= 3 });
      }
      check(`${tag}: the clock, greeting and date are readable on ${id} (${rows.map((r) => `${r.k} ${r.mean}:1, worst ${r.worst}`).join('; ')})`, rows.length >= 2 && rows.every((r) => r.ok), JSON.stringify(rows));
    };
    // What a layer of the same art over the page paints at the left margin: the page must paint the same, whatever the theme.
    const probeBand = async (art) => {
      await home(`(() => { const p = document.createElement('div'); p.id = 'probe'; p.style.cssText = 'position:fixed;inset:0;z-index:99999;background:' + ${JSON.stringify(art)}; document.body.append(p); return true; })()`);
      const b = await band('probe'); await home("document.getElementById('probe').remove(); true"); return b;
    };
    const near = (a, b, d) => Math.abs(a.r - b.r) <= d && Math.abs(a.g - b.g) <= d && Math.abs(a.b - b.b) <= d;
    const ids = BG.BACKGROUNDS.map((b) => b.id).filter((id) => id !== 'plain');
    for (const t of ['dark', 'light']) {
      await theme(t);
      for (const id of ids) {
        const item = BG.byId(id);
        await applyBg(id);
        const state = await home("({ bg: document.body.dataset.bg, media: document.body.classList.contains('on-media'), light: document.body.classList.contains('tone-light'), text: getComputedStyle(document.getElementById('greeting')).color, display: getComputedStyle(document.getElementById('backdrop')).display })");
        const tl = lum(...Object.values(parse(state.text)).slice(0, 3));
        const modeOk = state.bg === id && state.media && state.light === (item.tone === 'light') && (item.tone === 'light' ? tl < 0.1 : tl > 0.8) && state.display !== 'none';
        check(`${t}: ${id} sets the page to ${item.tone} text mode (${state.text})`, modeOk, JSON.stringify(state));
        const b = await band(`bg-${id}-${t}`);
        const page = await home('getComputedStyle(document.documentElement).backgroundColor');
        if (item.art) { // (the older ones are CSS in newtab.html: they are checked above, and by their text and band below)
          const want = await probeBand(item.art);
          check(`${t}: ${id}: the top band shows the background (${b.r},${b.g},${b.b}), as its art paints it (${want.r},${want.g},${want.b}), not black or the page's ${page}`, near(b, want, 18) && page !== `rgb(${b.r}, ${b.g}, ${b.b})`, JSON.stringify({ b, want }));
        } else {
          check(`${t}: ${id}: the top band shows the background (${b.r},${b.g},${b.b}), not black`, b.black < 0.05 && b.r + b.g + b.b > 60, JSON.stringify(b));
        }
        await textContrast(t, id);
      }
    }
    // The accent follows the background's tone: light shades over a light background, dark ones over a dark one.
    await theme('dark');
    await applyBg('peach'); const pl = await home("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
    await applyBg('nebula'); const nd = await home("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
    check(`the accent is the light shade over a light background (${pl}) and the dark shade over a dark one (${nd})`, pl === TC.accentOf('blue').light && nd === TC.accentOf('blue').dark, JSON.stringify({ pl, nd }));

    // ---------- the animated effects over a dark and a light background ----------
    await theme('dark');
    const drawn = (ms) => home(`new Promise((res) => { const c = document.getElementById('effect'); if (!c) return res(-1); const ctx = c.getContext('2d'); let n = 0; const orig = ctx.clearRect.bind(ctx); ctx.clearRect = (...a) => { n++; return orig(...a); }; setTimeout(() => { ctx.clearRect = orig; res(n); }, ${ms}); })`);
    // A test window cannot hide a tab for real (every tab of a test window counts as visible: features/tab-ready.js), so "the tab is not in front" is
    // what the page is told then: document.hidden turns true and visibilitychange fires. The effects' loop only ever reads that.
    const setHidden = (h) => home(`(() => { if (${h}) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); else delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); return document.hidden; })()`);
    for (const fx of BG.EFFECT_IDS.filter((x) => x !== 'none')) {
      await applyBg('nebula', { effect: fx }); await sleep(500);
      const moving = await drawn(1200);
      check(`effect ${fx}: it draws frames while the page is in front (${moving} in 1.2 s)`, moving >= 1, moving);
      await applyBg('nebula', { effect: fx, still: true }); await sleep(500);
      const still = await drawn(1000);
      check(`effect ${fx}: Reduce motion draws nothing more (${still})`, still === 0, still);
      await applyBg('nebula', { effect: fx }); await sleep(500);
      await setHidden(true); await sleep(500);
      const hidden = await drawn(1500);
      check(`effect ${fx}: it stops while the page is hidden (${hidden})`, hidden === 0, hidden);
      await setHidden(false); await sleep(300);
      // Still frames (deterministic) over a dark and a light background: the text stays readable
      for (const bg of ['nebula', 'peach']) {
        await applyBg(bg, { effect: fx, still: true }); await sleep(500);
        await textContrast(`effect ${fx}`, bg);
        if (shots && bg === 'nebula') await band(`effect-${fx}`);
      }
    }
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall new-tab wallpaper checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
