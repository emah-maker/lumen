// In a dark theme, with and without "Dark mode for all websites" (forceDarkWebsites), a website's text stays readable: at least 4.5:1 (WCAG AA)
// against what is drawn behind it. The case: a shopping grid (The North Face) that sets no background of its own, relying on the browser's white
// canvas, with dark-gray product names (a CSS variable through a class), prices in rgba() and "+4" counts. Opened in a tab that had started as the
// New Tab page, it was drawn on Lumen's #1c1c1e and its text was nearly invisible: the tab's view kept the theme's background after it went to the
// site (browser/page-background.js now gives a web page white, as Chrome does). Also: text in rgba() over transparent containers, and a site with
// its own dark theme (prefers-color-scheme: dark), which must be drawn dark once, not inverted back to light by the force-dark setting.
// Pixels, not styles: what is behind a transparent page and Chromium's auto dark mode are only seen in the drawn page. Each text's ink is the drawn
// pixel farthest from its background (the most common pixel in its box); its computed colour is also checked when nothing re-colours the page.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const jacket = (c) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200"><rect width="240" height="200" fill="#eef2f5"/><rect x="70" y="30" width="100" height="150" rx="30" fill="${c}"/></svg>`)}`;
const card = (name, price, count, c) => `<li class="card"><div class="photo"><img src="${jacket(c)}" alt=""><span class="chip">TOP SELLER</span></div>
  <div class="swatches"><i></i><i></i><i></i><span class="count">+${count}</span></div><p class="name">${name}</p><p class="price">${price}</p></li>`;
const PAGES = {
  // no background on html or body: the browser's white canvas. Text colours through a variable and a class, rgba(), and a mid gray.
  grid: `<!doctype html><title>grid</title><style>
    :root{--text-primary:#2b2b2b;--text-muted:#6b6b6b}
    body{margin:0;font:18px Arial,sans-serif}
    ul{display:flex;gap:8px;list-style:none;margin:0;padding:16px}
    .card{width:240px}.photo{position:relative}.photo img{display:block;border-radius:6px}
    .chip{position:absolute;left:8px;bottom:8px;background:#fff;color:#111;font:14px monospace;padding:2px 6px}
    .swatches{display:flex;gap:6px;align-items:center;margin:8px 0}.swatches i{width:22px;height:12px;border:1px solid #ccc}
    .name{color:var(--text-primary);margin:6px 0}.price{color:rgba(0,0,0,.72);margin:6px 0}.count{color:var(--text-muted)}
  </style><ul>${card("Men's 1996 Retro Nuptse Jacket", '$380.00', 4, '#8a1c2b')}${card("Men's Aconcagua Hooded Jacket", '$230.00', 1, '#111')}${card("Men's Hydrenalite Down Hoodie", '$260.00', 5, '#1a1a1a')}</ul>`,
  // white body, text in rgba() inside containers that draw nothing
  rgba: `<!doctype html><title>rgba</title><style>body{margin:0;background:#fff;font:18px Arial,sans-serif}
    .wrap{background:transparent;padding:16px}.wrap div{background:rgba(0,0,0,0)}.soft{color:rgba(17,17,17,.75)}
  </style><div class="wrap"><div><p class="soft">Free shipping on orders over $50 and free returns.</p></div></div>`,
  // a site with a dark theme of its own
  dark: `<!doctype html><title>dark</title><meta name="color-scheme" content="light dark"><style>body{margin:0;background:#fff;color:#222;font:18px Arial,sans-serif;padding:16px}
    @media (prefers-color-scheme: dark){body{background:#121212;color:#e8e8e8}}</style><p class="own">This site draws its own dark theme.</p>`,
};
const TARGETS = { grid: ['.name', '.price', '.count'], rgba: ['.soft'], dark: ['.own'] };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGES[req.url.slice(1)] || ''); }).listen(0);
  const port = server.address().port;
  const url = (k) => `http://127.0.0.1:${port}/${k}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dark-contrast-'));

  const run = async (forceDark) => {
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', forceDarkWebsites: forceDark }));
    const app = await electron.launch({
      args: [path.join(__dirname, '..', '..')],
      env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile }, timeout: 30000,
    });
    const freed = new Set();
    const tag = forceDark ? '[force dark on]' : '[force dark off]';
    try {
      const ui = await app.firstWindow();
      await ui.waitForSelector('.tab');
      check(`${tag} Lumen is in its dark theme`, await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors), 'light');
      for (const kind of Object.keys(PAGES)) {
        // The way the user got there: a New Tab page (drawn on the theme's colour), then the site typed into it.
        await app.evaluate(async () => {
          const t = global.__agent.browser.openTab();
          await new Promise((r) => t.webContents.once('did-finish-load', r));
        });
        // (Playwright tells every page it attaches to that the system is light, its own default: dropped, so the page sees Lumen's dark theme)
        const load = () => app.evaluate(async (_e, u) => {
          const wc = global.__agent.browser.activeTab().webContents;
          const done = new Promise((r) => wc.once('did-finish-load', r));
          wc.loadURL(u);
          await done;
        }, url(kind));
        await load();
        for (const p of app.context().pages()) if (p.url().includes(`:${port}/`) && !freed.has(p)) { freed.add(p); await p.emulateMedia({ colorScheme: null }).catch(() => {}); }
        await app.evaluate(async () => { const wc = global.__agent.browser.activeTab().webContents; wc.reload(); await new Promise((r) => wc.once('did-finish-load', r)); });
        const measured = await app.evaluate(async (_e, sels) => {
          const wc = global.__agent.browser.activeTab().webContents;
          await new Promise((r) => setTimeout(r, 900)); // (a frame drawn with the page's background and any dark override)
          const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
          const parse = (s) => { const m = String(s).match(/[\d.]+/g) || []; return m.map(Number); };
          const out = [];
          for (const sel of sels) {
            const info = await wc.executeJavaScript(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((el) => {
              const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect();
              return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height), color: getComputedStyle(el).color, text: el.textContent.trim() };
            })`);
            for (const box of info) {
              const img = await wc.capturePage({ x: box.x, y: box.y, width: Math.max(1, box.width), height: Math.max(1, box.height) });
              const bmp = img.toBitmap(); // BGRA
              const counts = new Map();
              const px = [];
              for (let i = 0; i < bmp.length; i += 4) { const c = [bmp[i + 2], bmp[i + 1], bmp[i]]; px.push(c); const k = c.join(','); counts.set(k, (counts.get(k) || 0) + 1); }
              const bg = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
              let ink = bg; let best = 1;
              for (const c of px) { const q = ratio(c, bg); if (q > best) { best = q; ink = c; } }
              // The computed colour over the drawn background (an alpha colour blended onto it first).
              const [r, g, b, a = 1] = parse(box.color);
              const comp = [r, g, b].map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
              out.push({ sel, text: box.text, bg, ink, drawn: Math.round(best * 100) / 100, computed: Math.round(ratio(comp, bg) * 100) / 100, bgLum: Math.round(lum(bg) * 1000) / 1000 });
            }
          }
          return out;
        }, TARGETS[kind]);
        check(`${tag} ${kind}: every text was found and measured`, measured.length >= TARGETS[kind].length, JSON.stringify(measured));
        for (const m of measured) {
          check(`${tag} ${kind} ${m.sel} "${m.text}": drawn at 4.5:1 or more`, m.drawn >= 4.5, JSON.stringify(m));
          if (!forceDark) check(`${tag} ${kind} ${m.sel}: its computed colour reads at 4.5:1 or more on what is drawn behind it`, m.computed >= 4.5, JSON.stringify(m));
        }
        if (kind === 'grid' && !forceDark) check(`${tag} a site with no background of its own is drawn on white, as in Chrome (not Lumen's #1c1c1e)`, measured.every((m) => m.bg.every((v) => v >= 250)), JSON.stringify(measured.map((m) => m.bg)));
        if (kind === 'grid' && forceDark) check(`${tag} the same site is drawn dark by the setting`, measured.every((m) => m.bgLum < 0.1), JSON.stringify(measured.map((m) => m.bg)));
        if (kind === 'dark') check(`${tag} a site with its own dark theme is drawn dark, not inverted twice`, measured.every((m) => m.bgLum < 0.1 && m.ink.every((v) => v > 180)), JSON.stringify(measured));
      }
    } finally { await app.close().catch(() => {}); }
  };

  await run(false);
  await run(true);
  server.close();
  console.log(failures ? `\n${failures} dark-page-contrast check(s) failed.` : '\nAll dark-page-contrast checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
