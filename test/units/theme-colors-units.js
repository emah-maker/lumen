// Accent colours and new-tab backgrounds, pure logic: the OKLCH maths, the tokens every accent gives in light and dark (and the contrast
// rules they must pass, for the presets, for any custom colour and for a colour taken from a wallpaper), the background catalogue, and
// Shuffle daily (the same pick for a date, a new one each day). No Electron window, no network.
const fs = require('fs');
const path = require('path');
const TC = require('../../src/features/theme-colors');
const BG = require('../../src/features/backgrounds');
const SB = require('../../src/settings/settings-backend');
const accentCss = require('../../src/features/accent-css');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
const worst = (hex, bgs) => Math.min(...bgs.map((b) => TC.contrast(hex, b)));

// The rules, as the tests state them (features/theme-colors.js has the reasons).
function rulesBroken(hex, mode) {
  const t = TC.tokensFor(hex, mode);
  const S = TC.SURFACES[mode];
  const broken = [];
  const glyph = worst(t.accent, S); if (glyph < 3) broken.push(`accent ${t.accent} as a glyph ${glyph.toFixed(2)}`);
  const text = worst(t.accentText, S); if (text < 4.5) broken.push(`accent-text ${t.accentText} ${text.toFixed(2)}`);
  const tints = S.map((s) => TC.over(t.accent, TC.SOFT[mode], s));
  const chip = worst(t.accentText, tints); if (chip < 4.5) broken.push(`accent-text on its tint ${chip.toFixed(2)}`);
  const button = TC.contrast('#ffffff', t.accentDeep); if (button < 4.5) broken.push(`white on accent-deep ${t.accentDeep} ${button.toFixed(2)}`);
  if (t.onAccent !== '#ffffff') broken.push('on-accent is not white');
  return broken;
}

// ---- the maths ----
{
  const samples = ['#000000', '#ffffff', '#007aff', '#ff3b30', '#30d158', '#af52de', '#8e8e93', '#ffcc00'];
  const off = samples.map((hex) => { const { L, C, h } = TC.toOklch(hex); const back = TC.fromOklch(L, C, h); return [hex, back]; }).filter(([a, b]) => a.toLowerCase() !== b.toLowerCase());
  check('OKLCH: a colour goes to OKLCH and back unchanged', off.length === 0, JSON.stringify(off));
  const w = TC.toOklch('#ffffff'); const k = TC.toOklch('#000000'); const blue = TC.toOklch('#0000ff');
  check('OKLCH: white is lightness 1, black 0 (no chroma), blue is near hue 264', Math.abs(w.L - 1) < 0.001 && k.L < 0.001 && w.C < 0.001 && Math.abs(blue.h - 264) < 1, JSON.stringify({ w, k, blue }));
  check('OKLCH: a chroma the screen cannot show is brought back into the gamut (same lightness and hue)', /^#[0-9a-f]{6}$/.test(TC.fromOklch(0.6, 0.5, 140)) && Math.abs(TC.toOklch(TC.fromOklch(0.6, 0.5, 140)).L - 0.6) < 0.02, TC.fromOklch(0.6, 0.5, 140));
  check('WCAG: black on white is 21:1 and a colour on itself 1:1', Math.abs(TC.contrast('#000000', '#ffffff') - 21) < 0.01 && Math.abs(TC.contrast('#336699', '#336699') - 1) < 0.001);
}

// ---- every accent, light and dark ----
{
  check('thirteen accent choices (plus Match wallpaper and any colour)', TC.ACCENT_IDS.length === 13 && TC.ACCENT_IDS.every((id) => TC.ACCENT_LABELS[id]), TC.ACCENT_IDS.join());
  check('the colours the app has always offered are unchanged', TC.ACCENTS.blue.join() === '#007aff,#0a84ff' && TC.ACCENTS.red.join() === '#ff3b30,#ff453a' && TC.ACCENTS.teal.join() === '#30b0c7,#40c8e0');
  for (const id of TC.ACCENT_IDS) {
    for (const [i, mode] of ['light', 'dark'].entries()) {
      const broken = rulesBroken(TC.ACCENTS[id][i], mode);
      check(`${id} (${mode}): accent >= 3:1, accent text >= 4.5:1 (also on its tint), white on the button >= 4.5:1`, broken.length === 0, broken.join('; '));
    }
  }
  check('a colour that already passes is kept as it is (Blue, light and dark)', TC.tokensFor('#007aff', 'light').accent === '#007aff' && TC.tokensFor('#0a84ff', 'dark').accent === '#0a84ff');
  const orange = TC.tokensFor('#ff9500', 'light');
  check('a colour that fails keeps its hue and only changes lightness (Orange on white goes deeper, still orange)', orange.accent !== '#ff9500' && Math.abs(TC.toOklch(orange.accent).h - TC.toOklch('#ff9500').h) < 6 && TC.toOklch(orange.accent).L < TC.toOklch('#ff9500').L, orange.accent);
  check('each token set names every property a page uses', Object.keys(TC.varsOf(TC.tokensFor('#12ab34', 'dark'))).join() === '--accent,--accent-rgb,--accent-bright,--accent-deep,--accent-text,--accent-soft,--ring,--on-accent');
}

// ---- any colour at all, 600 of them ----
{
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const bad = [];
  const extreme = ['#000000', '#ffffff', '#ffff00', '#00ff00', '#0000ff', '#ff00ff', '#00ffff', '#808080', '#fafafa', '#050505'];
  const hexes = [...extreme, ...Array.from({ length: 300 }, () => `#${Math.floor(rnd() * 0x1000000).toString(16).padStart(6, '0')}`)];
  for (const hex of hexes) for (const mode of ['light', 'dark']) { const b = rulesBroken(hex, mode); if (b.length) bad.push(`${hex} ${mode}: ${b.join('; ')}`); }
  check(`any custom colour (${hexes.length} of them, light and dark) passes every rule`, bad.length === 0, `${bad.length}: ${bad.slice(0, 3).join(' | ')}`);
}

// ---- Match wallpaper ----
{
  const seeds = ['#2ed5aa', '#f0584a', '#f5f5f5', '#101010', '#ffffff', '#c9a37a', '#ff00ff', '#00ff66', '#7a8aa0'];
  const bad = [];
  for (const hex of seeds) {
    const pair = TC.accentOf(TC.MATCH_WALLPAPER, hex);
    for (const [mode, c] of [['light', pair.light], ['dark', pair.dark]]) { const b = rulesBroken(c, mode); if (b.length) bad.push(`${hex} ${mode}: ${b.join('; ')}`); }
  }
  check('Match wallpaper: every wallpaper colour gives an accent that passes the rules', bad.length === 0, bad.join(' | '));
  const neon = TC.toOklch(TC.wallpaperAccent('#00ff66')); const dull = TC.toOklch(TC.wallpaperAccent('#6a8099'));
  check('Match wallpaper: chroma is clamped (neon is toned down, a dull colour gets some life) and lightness is mid', neon.C <= 0.2 && dull.C >= 0.05 && neon.L >= 0.5 && neon.L <= 0.82, JSON.stringify({ neon, dull }));
  check('Match wallpaper: a grey picture gives a grey accent, a colourful one a colourful accent', TC.toOklch(TC.wallpaperAccent('#888888')).C < 0.02 && TC.toOklch(TC.wallpaperAccent('#d9577b')).C > 0.1);
  check('Match wallpaper: no colour to go by (Plain) falls back to Blue; the same colour always gives the same accent', TC.accentOf('wallpaper', null).light === TC.accentOf('blue').light && TC.accentOf('wallpaper', null).dark === TC.accentOf('blue').dark && TC.accentOf('wallpaper', '#2ed5aa').dark === TC.accentOf('wallpaper', '#2ed5aa').dark);
  check('accentOf: a preset, a custom colour and nonsense', TC.accentOf('red').dark === '#ff453a' && TC.accentOf('#2060C0').light === '#2060c0' && TC.accentOf('#12AB34').dark === '#12ab34' && TC.accentOf('#12AB34').light === '#00a42d' && TC.accentOf('nonsense').light === '#007aff');
}

// ---- the settings accept exactly these ----
{
  const ok = (key, v) => { const r = SB.validate(key, v); return r !== null && String(r) === String(v).toLowerCase(); }; // (validate returns null for what it refuses)
  const refused = (key, v) => SB.validate(key, v) === null;
  check('settings: every accent choice, Match wallpaper and a #rrggbb are accepted; other text is refused', TC.ACCENT_IDS.every((id) => ok('accentColor', id)) && ok('accentColor', 'wallpaper') && ok('accentColor', '#12ab34') && refused('accentColor', 'red; background:url(x)') && refused('accentColor', '#fff') && refused('accentColor', 'magenta'));
  check('settings: every background and effect of the catalogue is accepted, others refused', BG.IDS.every((id) => ok('newTabBackground', id)) && BG.EFFECT_IDS.every((id) => ok('newTabEffect', id)) && refused('newTabBackground', 'url(x)') && refused('newTabEffect', 'fireworks'));
  check('settings: Shuffle daily is a boolean, off by default', ok('newTabShuffle', true) && ok('newTabShuffle', false) && refused('newTabShuffle', 'yes') && SB.DEFAULTS.newTabShuffle === false);
}

// ---- the background catalogue ----
{
  const ids = BG.BACKGROUNDS.map((b) => b.id);
  check('backgrounds: ids are unique and simple', new Set(ids).size === ids.length && ids.every((id) => /^[a-z]+$/.test(id)), ids.join());
  const gradients = BG.BACKGROUNDS.filter((b) => b.group === 'gradients'); const solids = BG.BACKGROUNDS.filter((b) => b.group === 'solids');
  const legacy = ['plain', 'aurora', 'dusk', 'ocean', 'forest', 'sunset', 'graphite'];
  check('backgrounds: 16 new gradients, 8 or more of each text mode, and 7 new solid tones', gradients.filter((b) => b.art).length === 16 && gradients.filter((b) => b.art && b.tone === 'dark').length >= 8 && gradients.filter((b) => b.art && b.tone === 'light').length >= 8 && solids.filter((b) => !legacy.includes(b.id)).length === 8, `${gradients.length} ${solids.length}`);
  check('backgrounds: every one has a text mode (plain, dark text over light art, white over dark) and the older ones stay as they were', BG.BACKGROUNDS.every((b) => ['plain', 'dark', 'light'].includes(b.tone)) && legacy.every((id) => ids.includes(id)) && BG.toneOf('plain') === 'plain' && BG.toneOf('aurora') === 'dark' && BG.toneOf('peach') === 'light' && BG.toneOf('image') === 'dark');
  const newtab = read('src/renderer/newtab.html'); const settingsCss = read('src/renderer/settings.css');
  const missing = legacy.filter((id) => id !== 'plain' && (!newtab.includes(`body[data-bg="${id}"] #backdrop`) || !settingsCss.includes(`.bg-${id} {`)));
  check('backgrounds: the older ones still have their CSS on the page and in Settings', missing.length === 0, missing.join());
  const artBad = BG.BACKGROUNDS.filter((b) => b.art && !/^(#[0-9a-f]{6}|((radial|linear)-gradient\([^;]*\)(, )?)+(, #[0-9a-f]{6})?)$/i.test(b.art));
  check('backgrounds: the art is only gradients over a colour, or a plain colour (nothing a page could abuse)', artBad.length === 0, artBad.map((b) => b.id).join());
  const seedBad = BG.BACKGROUNDS.filter((b) => b.tone !== 'plain' && b.id !== 'graphite' && !TC.isHex(b.seed));
  check('backgrounds: each has a colour for Match wallpaper (Plain and Graphite use the default)', seedBad.length === 0, seedBad.map((b) => b.id).join());
  check('effects: none, the four that were there, and aurora, blobs and grain', BG.EFFECT_IDS.join() === 'none,particles,stars,bubbles,snow,aurora,blobs,grain');
}

// ---- Shuffle daily ----
{
  const key = (y, m, d) => BG.dayKey(new Date(y, m - 1, d, 13, 5));
  check('shuffle: the day key is the local date', key(2026, 10, 14) === '2026-10-14' && BG.dayKey(new Date(2026, 0, 3, 23, 59)) === '2026-01-03' && BG.dayKey(new Date(2026, 0, 3, 0, 0)) === '2026-01-03');
  check('shuffle: the same date always gives the same background, whatever the time or the computer', BG.dailyPick('2026-10-14') === BG.dailyPick(BG.dayKey(new Date(2026, 9, 14, 0, 1))) && BG.dailyPick('2026-10-14') === BG.dailyPick(BG.dayKey(new Date(2026, 9, 14, 23, 59))));
  let repeats = 0; const seen = new Set();
  for (let i = 0; i < 400; i++) { const a = BG.dailyPick(BG.dayKey(new Date(2026, 0, 1 + i))); const b = BG.dailyPick(BG.dayKey(new Date(2026, 0, 2 + i))); if (a === b) repeats++; seen.add(a); }
  check('shuffle: a new background every day (never the same twice running)', repeats === 0, `${repeats} repeats`);
  const cycle = new Set(Array.from({ length: BG.POOL.length }, (_, i) => BG.dailyPick(BG.dayKey(new Date(2026, 5, 1 + i)))));
  check('shuffle: every gradient comes round once before any repeats', cycle.size === BG.POOL.length, `${cycle.size} of ${BG.POOL.length}`);
  check('shuffle: it picks only gradients (never Plain, a solid or your picture)', [...seen].every((id) => BG.byId(id).group === 'gradients'), [...seen].join());
  check('shuffle: the order is the same one every time (deterministic, not random per run)', BG.shuffledOrderCheck === undefined && BG.ORDER.join() === require('../../src/features/backgrounds').ORDER.join() && BG.dailyPick('2026-10-14') === BG.ORDER[Math.floor(Date.UTC(2026, 9, 14) / 86400000) % BG.ORDER.length]);
  check('shuffle: a malformed date falls back to the first in the order', BG.dailyPick('yesterday') === BG.ORDER[0]);
}

// ---- the sheet injected into Lumen's own pages ----
{
  const css = TC.cssFor(TC.accentOf('green'));
  check('accent sheet: light shades, then the dark ones under prefers-color-scheme, each outranking a page\'s own :root', /^:root:root\{--accent:#[0-9a-f]{6};/.test(css) && css.includes('@media (prefers-color-scheme: dark){:root:root{--accent:#30d158') && css.includes('--accent-text:') && css.includes('--accent-deep:'), css.slice(0, 160));
  const root = path.join(__dirname, '..', '..', 'src', 'renderer');
  const inj = accentCss.create({ rendererDir: root, accent: () => null, all: () => [] });
  const { pathToFileURL } = require('url');
  check('accent sheet: only Lumen\'s own pages (renderer/*.html, the PDF viewer) are touched, never a website or another file', inj.isOwnPage(pathToFileURL(path.join(root, 'settings.html')).href) && inj.isOwnPage('lumen-pdf://app/viewer.html?u=x') && !inj.isOwnPage('https://example.com/') && !inj.isOwnPage(pathToFileURL(path.join(root, '..', 'main.js')).href) && !inj.isOwnPage('file:///C:/Users/me/notes.html') && !inj.isOwnPage('lumen-pdf://evil/viewer.html'));
  const calls = [];
  const fake = (url) => ({ isDestroyed: () => false, getURL: () => url, insertCSS: async (c) => { calls.push(['insert', c]); return 'k1'; }, removeInsertedCSS: async (k) => { calls.push(['remove', k]); } });
  let accent = { light: '#007aff', dark: '#0a84ff' };
  const live = accentCss.create({ rendererDir: root, accent: () => accent, all: () => [] });
  const page = fake(pathToFileURL(path.join(root, 'history.html')).href);
  (async () => {
    await live.apply(page);
    check('accent sheet: Blue, the default, injects nothing', calls.length === 0);
    accent = TC.accentOf('red'); await live.apply(page);
    check('accent sheet: another accent injects its sheet', calls.length === 1 && calls[0][0] === 'insert' && calls[0][1].includes('#ff3b30'));
    await live.apply(page);
    check('accent sheet: the same accent twice injects once', calls.length === 1);
    accent = TC.accentOf('green'); await live.apply(page);
    check('accent sheet: a new accent swaps the old sheet for the new', calls.length === 3 && calls[1][0] === 'remove' && calls[2][0] === 'insert');
    if (failed) { console.error(`${failed} failed`); process.exit(1); }
    console.log('theme-colors units passed');
  })();
}
