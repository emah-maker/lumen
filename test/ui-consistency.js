// UI consistency (hidden run): the design scale and the accessibility floor, on the surfaces a user sees most.
//   1. Lint-style checks on the stylesheets (no Electron): the scale tokens exist in tokens.css and every page links it,
//      the refactored files use only the radius scale and whole-pixel type sizes, and have no hard-coded hex colours
//      outside a custom-property definition (or a decorative palette: the settings icon tiles and wallpapers).
//   2. In the running app, light and dark, at 1280 and 900 px: text contrast >= 4.5, glyph contrast >= 3, hit targets
//      >= 24 px, and a visible ring on keyboard focus, for key controls of the browser chrome (tabs, toolbar, address
//      bar, find bar, sidebar frame), Settings, the new-tab page and the PDF viewer.
//   3. Every accent colour (the thirteen, Match wallpaper and three custom ones) in light and dark, applied live on those four surfaces: the accent
//      as text >= 4.5:1, white on the accent button >= 4.5:1, the accent as a glyph or focus ring >= 3:1, and the page really wearing the colour.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/ui-consistency.js (a throwaway profile, no window shows).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const TC = require('../src/features/theme-colors');

const root = path.join(__dirname, '..');
const R = path.join(root, 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
// The Settings, new-tab and PDF viewer sections (the second PR of the UI polish).
const PAGE_SURFACES = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// ---------- 1. lint ----------
// Files whose look was brought onto the scale. (Chat-page internals, the TradingView card and the generated bundle are left out.)
const SCALED = ['styles.css', 'extras.css', 'managers.css', 'picker.css', 'slash.css', 'tab-search.css', 'tasks.css', 'research.css', 'macros.css', 'translate.css', 'prefs.css', 'routines.css', 'settings.css', 'settings-skills.css', 'settings-macros.css', 'settings-routines.css', 'pdfviewer.css', 'eml.css', 'private.css'];
// The popups (suggestions, downloads panel, dialogs, print preview, drag card, tool overlay) can't link tokens.css under their CSP, so they
// keep a small palette of their own, but their radii and type sizes sit on the same scale.
const POPUPS = ['newtab.html', 'error.html', 'unloaded.html', 'suggest.html', 'downloads-panel.html', 'dialog.html', 'print-preview.html', 'drag-card.html', 'tool-overlay.html'];
const PAGES = { 'index.src.html': 'tokens.css', 'chat-page.html': 'tokens.css', 'settings.src.html': 'tokens.css', 'bookmarks.html': 'tokens.css', 'readinglist.html': 'tokens.css', 'downloads.html': 'tokens.css', 'history.html': 'tokens.css', 'private.html': 'tokens.css', 'error.html': 'tokens.css', 'unloaded.html': 'tokens.css', 'pdfviewer.html': '/tokens.css', 'eml.html': 'tokens.css' };
const SCALE_PX = new Set([0, 1, 2, 4, 6, 8, 10, 12, 16, 20, 24]); // tiny hairline radii, the scale, and the two large ones for tiles
// A line that only defines a custom property, or draws one of the decorative palettes.
const DECORATIVE = /^\s*(\.(bg|wi|ic|accent|swatch)[\w-]*[\s,{.:]|\.effect-options)/;
const lines = (f) => read(f).split('\n').map((text, i) => ({ text, n: i + 1 }));

{
  const tokens = read('tokens.css');
  const need = ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl', '--r-2xl', '--r-pill', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--hit', '--hit-min', '--paper', '--warning-fill', '--focus-ring', '--t-fast', '--t-base'];
  const missing = need.filter((n) => !new RegExp(`${n}:`).test(tokens));
  check('tokens.css defines the radius, type, hit-target, surface and motion scales', missing.length === 0, missing.join());
  const unlinked = Object.entries(PAGES).filter(([page, css]) => !new RegExp(`href="${css.replace('/', '\\/')}"`).test(read(page))).map(([page]) => page);
  check('every page that uses the scale links tokens.css', unlinked.length === 0, unlinked.join());
  const stylesRoot = read('styles.css');
  check('styles.css does not redefine the motion steps or the focus ring', !/^\s*--t-press:/m.test(stylesRoot) && !/^\s*--focus-ring:/m.test(stylesRoot), 'duplicate token');

  const hex = []; const radii = []; const halves = []; const faintText = [];
  for (const f of [...SCALED, ...POPUPS]) {
    for (const { text, n } of lines(f)) {
      if (/tradingview|\btv-/i.test(text)) continue; // the TradingView card is edited elsewhere
      const code = text.replace(/\/\*.*?\*\//g, '');
      if (/^\s*--[\w-]+:/.test(code) || /--[\w-]+:\s*#/.test(code)) { /* a token definition */ } else if (!f.endsWith(".html") && !DECORATIVE.test(code) && /#[0-9a-fA-F]{3,8}\b/.test(code)) hex.push(`${f}:${n} ${code.trim().slice(0, 70)}`);
      for (const m of code.matchAll(/border-radius:\s*([^;}]+)/g)) {
        const v = m[1].trim();
        if (v === '999px') { /* a pill */ } else if (/^(\d+)px$/.test(v)) { if (!SCALE_PX.has(parseInt(v, 10))) radii.push(`${f}:${n} ${v}`); }
      }
      for (const m of code.matchAll(/font-size:\s*(\d+\.\d+)px/g)) halves.push(`${f}:${n} ${m[1]}px`);
      if (/(^|[;{\s])color:\s*var\(--faint\)/.test(code) && !/glyph|icon|dot|globe|chevron|grip|resize|:disabled/i.test(code)) faintText.push(`${f}:${n} ${code.trim().slice(0, 60)}`);
    }
  }
  check('no hard-coded hex colours in the refactored stylesheets (tokens and decorative palettes aside)', hex.length === 0, `${hex.length}: ${hex.slice(0, 6).join(' | ')}`);
  check('border-radius values sit on the radius scale', radii.length === 0, radii.slice(0, 8).join(' | '));
  check('no half-pixel font sizes in the refactored stylesheets', halves.length === 0, `${halves.length}: ${halves.slice(0, 6).join(' | ')}`);
  check('--faint (3:1) is never used as a text colour in the refactored stylesheets', faintText.length === 0, faintText.slice(0, 6).join(' | '));
  const usesTokens = SCALED.filter((f) => /var\(--r-/.test(read(f)));
  check('radius tokens are used across the app (chrome, menus, settings, viewers)', ['styles.css', 'extras.css', 'picker.css', 'managers.css', 'settings.css', 'pdfviewer.css'].every((f) => usesTokens.includes(f)), usesTokens.join());
}

// ---------- 2. the running app ----------
// In-page helpers: composited background, WCAG ratio, hit-target size, and whether keyboard focus draws a ring.
const HELPERS = `(() => {
  const px = (c) => { const g = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (acc, c) => { const k = c[3] * (1 - acc[3]); return [acc[0] + c[0] * k, acc[1] + c[1] * k, acc[2] + c[2] * k, acc[3] + k]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const behind = (el) => { let acc = [0, 0, 0, 0]; for (let n = el; n && acc[3] < 0.999; n = n.parentElement) acc = over(acc, px(getComputedStyle(n).backgroundColor)); if (acc[3] < 0.999) acc = over(acc, [255, 255, 255, 1]); return acc; };
  const ratio = (fg, bg) => { const t = px(fg); const m = [t[0] * t[3] + bg[0] * (1 - t[3]), t[1] * t[3] + bg[1] * (1 - t[3]), t[2] * t[3] + bg[2] * (1 - t[3])]; const a = lum(m) + 0.05; const b = lum(bg) + 0.05; return Math.round((Math.max(a, b) / Math.min(a, b)) * 100) / 100; };
  const q = (s) => document.querySelector(s);
  window.__ui = {
    // text: the element's own colour; glyph: its svg's (or its colour when it has none). The background is whatever paints behind it.
    text: (s) => { const el = q(s); return el && el.getClientRects().length ? ratio(getComputedStyle(el).color, behind(el)) : null; },
    glyph: (s) => { const el = q(s); if (!el || !el.getClientRects().length) return null; const g = el.querySelector('svg') || el; const cs = getComputedStyle(g); const stroke = cs.stroke && cs.stroke !== 'none' ? cs.stroke : cs.color; return ratio(stroke, behind(el)); },
    size: (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; },
    ring: (s, ringSel) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.offsetParent && !e.disabled); if (!el) return null; const ringEl = ringSel ? q(ringSel) : el; ringEl.style.transition = 'none'; el.style.transition = 'none';
      const snap = () => { const c = getComputedStyle(ringEl); return [c.outlineStyle, c.outlineWidth, c.boxShadow, c.borderColor, c.backgroundColor].join('|'); };
      if (document.activeElement) document.activeElement.blur();
      const before = snap(); el.focus(); void ringEl.offsetWidth; const focused = el.matches(':focus-visible') || ringEl.matches(':focus-within'); const after = snap(); el.blur();
      const c = getComputedStyle(ringEl);
      return { focused, changed: before !== after };
    },
    // every visible interactive control under a root that is smaller than 24 px in either direction
    small: (rootSel, min) => [...document.querySelectorAll((rootSel || 'body') + ' :is(button, a[href], [role=button], [role=tab], [role=menuitem], input:not([type=hidden]), select, summary)')].filter((el) => {
      if (el.closest('[hidden], [aria-hidden="true"], .sr-only')) return false;
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || el.disabled) return false;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false;
      if (el.matches('input[type=checkbox], input[type=radio]') && !el.classList.contains('switch')) { const l = el.closest('label, .item, .row'); if (l && l.getBoundingClientRect().height >= min) return false; } // the label row is the target
      return r.width < min - 0.05 || r.height < min - 0.05;
    }).slice(0, 12).map((el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)),
  };
  return true;
})()`;

(async () => {
  const { _electron: electron } = require('playwright-core');
  const PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const server = http.createServer((req, res) => {
    if (req.url === '/a.pdf') { res.setHeader('Content-Type', 'application/pdf'); return res.end(PDF); }
    res.setHeader('Content-Type', 'text/html'); res.end(`<title>Page ${req.url.slice(1)}</title><p>${req.url}</p>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-uicons-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-uicons-tmp-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', TEMP: temp, TMP: temp, ANTHROPIC_API_KEY: 'sk-ant-test' }, colorScheme: null });
  try {
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    const theme = (t) => app.evaluate(({ nativeTheme }, x) => { nativeTheme.themeSource = x; }, t);
    const size = (w, h) => app.evaluate(({ BrowserWindow }, [a, b]) => { [...BrowserWindow.getAllWindows()].sort((x, y) => x.id - y.id)[0].setSize(a, b); }, [w, h]);
    const open = async (u) => { const id = await app.evaluate((_e, x) => global.__agent.browser.openTab(x).id, u); await sleep(500); return id; };
    const inTab = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [id, code]);
    const pageReady = async (id, sel) => waitFor(() => inTab(id, `Boolean(document.querySelector(${JSON.stringify(sel)}))`));

    const a = await open(`${base}/one`); const b = await open(`${base}/two`);
    await app.evaluate((_e, i) => global.__pinTab(i, true), a);
    await app.evaluate((_e, i) => global.__agent.execute('group_tabs', { name: 'Reading', tab_ids: i }), [b]);
    await ui.evaluate(HELPERS);
    // Show the controls that only appear in some states, so their size and colour can be measured.
    await ui.evaluate(() => { for (const s of ['#findbar', '#organize-tabs', '#downloads', '#bookmark', '#reader', '#zoom', '#security']) { const el = document.querySelector(s); if (el) el.hidden = false; } });
    
    const settingsId = await app.evaluate(() => global.__settings.open(''));
    await waitFor(() => app.evaluate((_e, i) => global.__settings.contents(i)?.executeJavaScript('document.body?.dataset.ready === "1"', true).catch(() => false), settingsId));
    const pdfId = await open(`${base}/a.pdf`);
    await pageReady(pdfId, '#bar');
    const homeId = await open(); // the new-tab page (a tab with no address)

    for (const scheme of ['light', 'dark']) {
      await theme(scheme);
      for (const w of [1280, 900]) {
        await size(w, 800); await sleep(400);
        const tag = `${scheme} ${w}px`;
        await ui.evaluate(() => { document.activeElement?.blur(); }); await sleep(300); // (a focused address field scales its end buttons down)
        await ui.evaluate(HELPERS);

        // Browser chrome: glyphs 3:1, text 4.5:1
        const glyphs = ['#new-tab', '#tab-search', '#app-menu', '#toggle-sidebar', '#reload', '#find-prev', '#find-next', '#find-close', '#downloads', '#bookmark'];
        const lowGlyph = [];
        for (const s of glyphs) { const v = await ui.evaluate((x) => window.__ui.glyph(x), s); if (v !== null && v < 3) lowGlyph.push(`${s} ${v}`); }
        check(`${tag}: chrome icon glyphs reach 3:1`, lowGlyph.length === 0, lowGlyph.join(', '));
        const lowText = [];
        for (const s of ['.tab:not(.active):not(.pinned) .tab-title', '.tab.active .tab-title', '#address', '#organize-tabs', '.group-name', '#find-input', '#find-count']) { const v = await ui.evaluate((x) => window.__ui.text(x), s); if (v !== null && v < 4.5) lowText.push(`${s} ${v}`); }
        check(`${tag}: chrome text reaches 4.5:1`, lowText.length === 0, lowText.join(', '));

        // Hit targets
        const smallChrome = await ui.evaluate(() => window.__ui.small('.chrome', 24));
        check(`${tag}: chrome controls are at least 24 px`, smallChrome.length === 0, smallChrome.join(', '));
        const smallSidebar = await ui.evaluate(() => window.__ui.small('#sidebar', 24));
        check(`${tag}: sidebar frame controls are at least 24 px`, smallSidebar.length === 0, smallSidebar.join(', '));
        if (PAGE_SURFACES) {
        const smallSettings = await inTab(settingsId, `(${HELPERS}, window.__ui.small('body', 24))`);
        check(`${tag}: Settings controls are at least 24 px`, Array.isArray(smallSettings) && smallSettings.length === 0, JSON.stringify(smallSettings));
        const smallPdf = await inTab(pdfId, `(${HELPERS}, window.__ui.small('#bar', 24))`);
        check(`${tag}: PDF viewer toolbar controls are at least 24 px`, Array.isArray(smallPdf) && smallPdf.length === 0, JSON.stringify(smallPdf));
        if (homeId) {
          const smallHome = await inTab(homeId, `(${HELPERS}, window.__ui.small('body', 24))`);
          check(`${tag}: new-tab page controls are at least 24 px`, Array.isArray(smallHome) && smallHome.length === 0, JSON.stringify(smallHome));
        }
        }

        if (w === 1280) {
          // Keyboard focus draws a ring
          const noRing = [];
          const ringTargets = [['#back'], ['#reload'], ['#new-tab'], ['#tab-search'], ['#app-menu'], ['#toggle-sidebar'], ['.tab'], ['#find-prev'], ['#find-close'], ['#address', '#omnibox']];
          for (const [s, ringSel] of ringTargets) {
            const v = await ui.evaluate(([x, y]) => window.__ui.ring(x, y), [s, ringSel || null]);
            if (v && !(v.focused && v.changed)) noRing.push(`${s} ${JSON.stringify(v)}`);
          }
          check(`${tag}: keyboard focus shows a ring on chrome controls`, noRing.length === 0, noRing.join(', '));
        if (PAGE_SURFACES) {
          const sRing = await inTab(settingsId, `(${HELPERS}, ['#search', '#nav a', '.item button:not(:disabled)', '.item select:not(:disabled)', 'input.switch:not(:disabled)'].map((s) => [s, window.__ui.ring(s, null)]).filter(([, v]) => v && !(v.focused && v.changed)).map(([s, v]) => s + ' ' + JSON.stringify(v)))`);
          check(`${tag}: keyboard focus shows a ring in Settings`, Array.isArray(sRing) && sRing.length === 0, JSON.stringify(sRing));
          const pRing = await inTab(pdfId, `(${HELPERS}, ['#pageNumber', '#zoomIn', '#findButton', '#print'].map((s) => [s, window.__ui.ring(s)]).filter(([, v]) => v && !(v.focused && v.changed)).map(([s, v]) => s + ' ' + JSON.stringify(v)))`);
          check(`${tag}: keyboard focus shows a ring in the PDF viewer`, Array.isArray(pRing) && pRing.length === 0, JSON.stringify(pRing));
        }
        }
        if (PAGE_SURFACES) {
        // Settings and the PDF viewer: text and glyph contrast
        const sText = await inTab(settingsId, `(${HELPERS}, ['h1', '.item .desc', '#nav a', '#search'].map((s) => [s, window.__ui.text(s)]).filter(([, v]) => v !== null && v < 4.5).map(([s, v]) => s + ' ' + v))`);
        check(`${tag}: Settings text reaches 4.5:1`, Array.isArray(sText) && sText.length === 0, JSON.stringify(sText));
        const pText = await inTab(pdfId, `(${HELPERS}, ['#name', '#pageCount', 'button.primary'].map((s) => [s, window.__ui.text(s)]).filter(([, v]) => v !== null && v < 4.5).map(([s, v]) => s + ' ' + v))`);
        check(`${tag}: PDF viewer text reaches 4.5:1`, Array.isArray(pText) && pText.length === 0, JSON.stringify(pText));
        }
      }
    }
    // ---------- 3. every accent, light and dark, live, on the four surfaces ----------
    // A probe on each page: a link-coloured word, a primary button and an accent glyph, built with the page's own tokens (no inline style attribute: the
    // pages' CSP forbids it, so the colours are set through the CSSOM).
    const probeIn = (sel) => `(() => { let d = document.getElementById('accent-probe'); if (!d) { d = document.createElement('div'); d.id = 'accent-probe'; d.style.position = 'fixed'; d.style.left = '0'; d.style.top = '0'; d.style.zIndex = '99999'; d.style.pointerEvents = 'none';
      const t = document.createElement('span'); t.id = 'ap-text'; t.textContent = 'Link'; t.style.color = 'var(--accent-text)';
      const b = document.createElement('button'); b.id = 'ap-btn'; b.textContent = 'Go'; b.style.background = 'var(--accent-deep)'; b.style.color = 'var(--on-accent)'; b.style.border = '0';
      const g = document.createElement('i'); g.id = 'ap-glyph'; g.textContent = 'o'; g.style.color = 'var(--accent)'; g.style.stroke = 'var(--accent)';
      d.append(t, b, g); (document.querySelector(${JSON.stringify(sel)}) || document.body).append(d); }
      return [window.__ui.text('#ap-text'), window.__ui.text('#ap-btn'), window.__ui.glyph('#ap-glyph'), getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()]; })()`;
    const setAccent = (v) => app.evaluate((_e, x) => global.__settings.backend.set('accentColor', x).then(() => 'ok', (err) => 'ERROR ' + err.message), v);
    const surfaces = {
      'browser chrome': () => ui.evaluate(HELPERS).then(() => ui.evaluate(probeIn('body'))),
      Settings: () => inTab(settingsId, `(${HELPERS}, ${probeIn('body')})`),
      'new-tab page': () => (homeId ? inTab(homeId, `(${HELPERS}, ${probeIn('body')})`) : null),
      // (on the toolbar: the grey stage behind the pages is darker, and holds none of the accent's marks)
      'PDF viewer': () => inTab(pdfId, `(${HELPERS}, ${probeIn('#bar')})`),
    };
    const accents = [...TC.ACCENT_IDS, TC.MATCH_WALLPAPER, '#12ab34', '#ffff00', '#1a1a1a'];
    for (const scheme of ['light', 'dark']) {
      await theme(scheme); await size(1280, 800); await sleep(500);
      const bad = []; let n = 0;
      for (const accent of accents) {
        check(`accent ${accent} is accepted`, (await setAccent(accent)) === 'ok', 'refused');
        const want = TC.accentOf(accent === TC.MATCH_WALLPAPER ? 'blue' : accent)[scheme]; // (Plain has no colour to match: Match wallpaper is Blue there)
        for (const [name, probe] of Object.entries(surfaces)) {
          let v = null;
          for (let i = 0; i < 25 && !(Array.isArray(v) && v[3] === want); i++) { await sleep(120); v = await probe().catch((e) => String(e)); } // (live: the page follows within a moment)
          n++;
          if (!Array.isArray(v)) { bad.push(`${accent} ${name}: ${v}`); continue; }
          const [text, button, glyph, shade] = v;
          if (shade !== want) bad.push(`${accent} ${name}: wears ${shade}, wanted ${want}`);
          else if (text < 4.5 || button < 4.5 || glyph < 3) bad.push(`${accent} ${name}: text ${text}, button ${button}, glyph ${glyph}`);
        }
      }
      check(`${scheme}: ${accents.length} accents on 4 surfaces (${n} pages): each page wears the colour live; text >= 4.5:1, white on the button >= 4.5:1, glyph >= 3:1`, bad.length === 0, `${bad.length}: ${bad.slice(0, 6).join(' | ')}`);
    }
    await setAccent('blue');
    check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  } finally {
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; }).catch(() => {});
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll UI consistency checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
