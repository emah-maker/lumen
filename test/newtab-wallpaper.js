// The new-tab page's wallpaper (gradient, picture) covers the whole page, top included: the top band is the wallpaper's colours,
// not a flat black or the page colour, in light and dark, and still so after the sidebar opens and the window is resized.
// Offline; a throwaway profile; LUMEN_TEST_BACKGROUND keeps the window off-screen. Screenshots go to LUMEN_SHOTS if set.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

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
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall new-tab wallpaper checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
