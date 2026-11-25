// [job dashboard look] renderer/chat-job-board.js and .css: the palette's fuzzy filter, WCAG AA contrast of every text colour on the
// panels and the page, light and dark, for every accent Lumen offers (it follows the browser's theme), the one card style,
// no glow or gradient on cards, Reduce motion for the lift, and the Ctrl+K wiring (the page claims the key only while the dashboard shows).
// Plain Node: the renderer file runs in a vm with a stub window.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// ---- the palette's filter
{
  const sandbox = { window: {}, navigator: { platform: 'Win32' }, document: { documentElement: { classList: { contains: () => false } } } };
  vm.runInNewContext(src('src/renderer/chat-job-board.js'), sandbox);
  const { fuzzy } = sandbox.window.chatJobBoard;
  check('fuzzy: letters in order match, spaces ignored, case ignored', fuzzy('add post', 'Add posting') && fuzzy('ADDP', 'Add posting') && fuzzy('xp', 'Export CSV'));
  check('fuzzy: letters out of order or missing do not', fuzzy('tsop', 'Add posting') === null && fuzzy('zz', 'Board') === null);
  check('fuzzy: an empty query matches everything with no marks', fuzzy('', 'Anything').hits.length === 0);
  const rank = (q, list) => list.map((t) => ({ t, m: fuzzy(q, t) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).map((x) => x.t);
  check('fuzzy: a word start beats letters scattered inside words', rank('bd', ['Show Board', 'Boston Dynamics · Co-op'])[0] === 'Boston Dynamics · Co-op', rank('bd', ['Show Board', 'Boston Dynamics · Co-op']));
  check('fuzzy: a run of letters beats the same letters spread out', rank('exp', ['Export CSV', 'Edit profile, x p'])[0] === 'Export CSV');
  check('fuzzy: the marks are on the matched letters', JSON.stringify(fuzzy('ins', 'Insulet').hits) === '[0,1,2]');
  check('fuzzy: a later word start is preferred to an earlier letter mid-word', JSON.stringify(fuzzy('c', 'Check email · Co-op').hits) === '[0]' && fuzzy('co', 'Dynamics · Co-op').hits[0] === 11, JSON.stringify(fuzzy('co', 'Dynamics · Co-op')));
}

// ---- contrast
const css = src('src/renderer/chat-job-board.css');
const block = (selector) => {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf('{', at + selector.length - 1);
  let depth = 0;
  for (let i = open; i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i); }
  return null;
};
const tokensOf = (text) => { const out = {}; for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim(); return out; };
const light = tokensOf(block('.pjp-job[data-view="jobs"], .jb-pal-scope {'));
const dark = tokensOf(block(':root[data-theme="dark"] :is(.pjp-job[data-view="jobs"], .jb-pal-scope) {'));
const darkMedia = tokensOf(block(':root:not([data-theme="light"]) :is(.pjp-job[data-view="jobs"], .jb-pal-scope) {'));
check('tokens: found', Object.keys(light).length > 30 && Object.keys(dark).length >= 2);
check('tokens: the dark theme is the same whether picked in Settings or by the system', JSON.stringify(dark) === JSON.stringify(darkMedia));
check('theme: every colour is one of the app\'s tokens (no colour of its own: it follows the browser\'s theme and accent)', !/#(?!000\b|fff\b)[0-9a-f]{3,8}\b/i.test(css.replace(/url\("data:[^"]*"\)/g, '')), (css.match(/#[0-9a-f]{3,8}\b/gi) || []).join(' ')); // (black and white: the hover shade and a fallback)

// colours: [r, g, b, a], 0-255 and 0-1
const parse = (v) => {
  v = String(v).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`colour? ${v}`);
};
const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
const mix = (a, p, b) => (b === 'transparent' ? [a[0], a[1], a[2], a[3] * p] : [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat(1)); // color-mix(in srgb, a p%, b)
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// The theme's values: tokens.css (page colours) and styles.css (status colours), light then dark; the accent from features/theme-colors.js,
// for every accent Lumen offers.
const nth = (text, name, i) => [...text.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))][i]?.[1].trim();
const tokensCss = src('src/renderer/tokens.css');
const stylesCss = src('src/renderer/styles.css');
const themeColors = require('../../src/features/theme-colors');
const pct = (k, t) => Number(new RegExp(`var\\(--surface\\) (\\d+)%`).exec(t[k])[1]) / 100;
for (const [mode, i, t] of [['light', 0, light], ['dark', 1, { ...light, ...dark }]]) {
  const base = { bg: parse(nth(tokensCss, '--bg', i)), surface: parse(nth(tokensCss, '--surface', i)), text: parse(nth(tokensCss, '--text', i)), muted: parse(nth(tokensCss, '--muted', i)) };
  const status = { '--s-interview': parse(nth(stylesCss, '--warning', i)), '--s-offer': parse(nth(stylesCss, '--success', i)), '--s-rejected': parse(nth(stylesCss, '--danger', i)) };
  const glassP = pct('--d-glass', t);
  const fails = [];
  for (const id of themeColors.ACCENT_IDS) {
    const tk = themeColors.tokensFor(themeColors.ACCENTS[id][i], mode);
    const accent = parse(tk.accent);
    const deep = parse(tk.accentDeep);
    const accentText = parse(tk.accentText);
    const onAccent = parse(tk.onAccent || '#ffffff');
    // the page: the background, plain and under the accent's wash (12% at its strongest)
    const walls = [base.bg, over(mix(accent, 0.12, 'transparent'), base.bg)];
    const glass = walls.map((w) => over(mix(base.surface, glassP, 'transparent'), w));
    const need = (label, fg, backs, min = 4.5) => { for (const b of backs) { const r = ratio(over(fg, b), b); if (r < min) { fails.push(`${id}: ${label} ${r.toFixed(2)}`); return; } } };
    need('text on a panel', base.text, glass);
    need('muted on a panel', base.muted, glass);
    need('text on the page (section headings)', base.text, walls);
    need('muted on the page (captions)', base.muted, walls);
    for (const [k, s] of Object.entries({ ...status, '--s-applied': accentText, '--s-saved': base.muted })) {
      need(`${k} pill text`, mix(s, 0.7, base.text), glass.map((g) => over(mix(s, 0.15, 'transparent'), g)));
      need(`${k} tile number (large)`, mix(s, 0.82, base.text), glass, 3);
    }
    need('the button text on the call to action', onAccent, [deep]);
    need('the button text on the call to action, hovered', onAccent, [mix(deep, 0.78, [0, 0, 0, 1])]);
    need('the focus ring against a panel (3:1)', accent, glass, 3);
    need('a posting\'s company (Find jobs)', accentText, glass);
    const shift = ratio(deep, mix(deep, 0.78, [0, 0, 0, 1]));
    if (shift < 1.25) fails.push(`${id}: the hover shift is only ${shift.toFixed(2)}:1`);
  }
  check(`contrast (${mode}, every accent): every text colour passes WCAG AA on the panels and the page, and hover is a clear shift`, fails.length === 0, fails.join('; '));
}

// ---- one card, no glow, no gradient fill on cards
{
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const radius = rules.filter((r) => /border-radius:\s*var\(--jb-r\)/.test(r.body)).map((r) => r.sel);
  check('one card: .jb-panel has the one radius, edge, padding, fill, blur and shadow', rules.some((r) => r.sel === '.jb-panel' && /border-radius: var\(--jb-r\)/.test(r.body) && /padding: var\(--jb-pad\)/.test(r.body) && /border: 1px solid var\(--d-edge\)/.test(r.body) && /background: var\(--d-glass\)/.test(r.body) && /backdrop-filter: blur/.test(r.body) && /box-shadow: var\(--d-shadow\)/.test(r.body)), radius.join(' | '));
  const js = src('src/renderer/chat-job-board.js');
  for (const cls of ['jb-tile', 'jb-card', 'jb-follow', 'jb-sug-box', 'jb-sources', 'jb-table-wrap', 'jb-find-offer', 'jb-find-list', 'jb-empty-state', 'jb-addform', 'jb-actions']) {
    check(`one card: .${cls} is a .jb-panel`, new RegExp(`jb-panel[^'\`]*\\b${cls}\\b`).test(js));
  }
  const cardRules = rules.filter((r) => /\.jb-(tile|card|follow|sug-box|sources|table-wrap|find-offer|find-list|empty-state|addform|actions|panel)\b/.test(r.sel) && !/:hover|\.flash|\.dragging/.test(r.sel));
  const own = cardRules.filter((r) => /(^|;)\s*(border-radius|box-shadow|background(-image)?|border)\s*:/.test(r.body) && r.sel !== '.jb-panel' && !/jb-actions|jb-card-|jb-tile-|jb-panel-head/.test(r.sel));
  check('one card: no card-like part sets its own radius, border, fill or shadow', own.length === 0, own.map((r) => r.sel).join(' | '));
  const gradients = rules.filter((r) => /gradient\(/.test(r.body) && !/^\.pjp-job\[data-view="jobs"\]$|tokens|:root/.test(r.sel) && !/--d-wall/.test(r.body));
  check('no gradient fill outside the wallpaper', gradients.length === 0, gradients.map((r) => r.sel).join(' | '));
  const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);|--d-[\w-]*shadow[\w-]*:\s*([^;]+);/g)].map((m) => m[1] || m[2]).filter((v) => !/^var\(|none/.test(v));
  const glow = shadows.flatMap((v) => v.split(/,(?![^(]*\))/)).filter((s) => /^\s*0(px)?\s+0(px)?\s+\d/.test(s.trim()) && !/inset/.test(s));
  check('no glow: every shadow drops (a y offset)', shadows.length > 3 && glow.length === 0, glow.join(' | '));
  check('the lift respects Reduce motion', /prefers-reduced-motion: reduce\)[\s\S]*\.btn\.primary:hover:not\(:disabled\), \.jb-cta:hover:not\(:disabled\) \{ transform: none; \}/.test(css));
  const t = /\.jb \.btn\.primary, \.jb-cta \{[^}]*transition: ([^;]+);/.exec(css);
  check('the call to action moves in 150–200 ms', t && [...t[1].matchAll(/(\d+)ms/g)].every((m) => +m[1] >= 150 && +m[1] <= 200), t?.[1]);
  check('the type scale: display, heading, subheading, body, caption', ['--jt-display', '--jt-heading', '--jt-sub', '--jt-body', '--jt-caption'].every((k) => k in light));
  const sizes = [...css.replace(/--jt-[\w-]+:[^;]+;/g, '').matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => +m[1]);
  check('the type scale: only a few sizes outside the tokens (tile numbers, small buttons)', sizes.every((s) => [20, 13, 12, 11].includes(s)), sizes.join(', '));
  check('the wallpaper: CSS only (gradients and SVG noise), no image file', /--d-grain: url\("data:image\/svg\+xml/.test(css) && !/url\(/.test(css.replace(/url\("data:[^"]*"\)/g, '')));
}

// ---- Ctrl+K: the page claims it only while the dashboard shows
{
  const js = src('src/renderer/chat-job-board.js');
  const main = src('src/main.js');
  const page = src('src/features/chat-page.js');
  const host = src('src/renderer/chat-project-page.js');
  check('keys: the dashboard claims Ctrl+K when drawn and gives it back when it goes', /api\.paletteKey\?\.\(true\)/.test(js) && /api\.paletteKey\?\.\(false\)/.test(js) && /page\.board\?\.dispose\?\.\(\)/.test(host) && (host.match(/page\.board\?\.dispose\?\.\(\)/g) || []).length === 2);
  check('keys: the preload sends it, chat-page.js allows and keeps it per page', /paletteKey: \(on\) => ipcRenderer\.send\('chatpage:palette-key', Boolean\(on\)\)/.test(src('src/features/chat-preload.js')) && /'chatpage:palette-key'/.test(page) && /paletteKeys = new WeakSet\(\)/.test(page) && /if \(!isChatSender\(event\)\) return;/.test(page));
  check('keys: main hands the key to the page only when claimed, from the tab (the address bar keeps the command bar)', /shortcutKey\(input\) === 'k' && chatPageRt\?\.claimsPaletteKey\?\.\(wc\)\) \{ wc\.executeJavaScript\("document\.dispatchEvent\(new CustomEvent\('cp:shortcut', \{ detail: 'palette' \}\)\)"\)/.test(main));
  check('palette: arrows, Enter, Esc, Home and End; a dialog with a listbox', ['ArrowDown', 'ArrowUp', "'Enter'", "'Escape'", "'Home'", "'End'"].every((k) => js.includes(k)) && /role', 'dialog'/.test(js) && /'role', 'listbox'/.test(js) && /aria-activedescendant/.test(js));
  check('palette: still loaded only with the dashboard (not part of the page\'s start)', !/chat-job-board/.test(src('src/renderer/chat-page.html')));
}

console.log(failures ? `\n${failures} failed` : '\nAll job dashboard checks passed.');
process.exit(failures ? 1 : 0);
