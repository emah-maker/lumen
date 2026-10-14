// [look] Accent colours: the choices, and the whole token set each one gives in light and dark.
// Pure functions, no DOM, no Electron. Used by settings-backend.js (validates the setting, hands every page its shades),
// features/accent-css.js (the CSS injected into Lumen's own pages), renderer/settings.js (the swatches), renderer/newtab.js
// and the unit tests (test/theme-colors-units.js, and test/ui-consistency.js on the running pages).
//
// One colour in, six tokens out, per mode, all computed in OKLCH (perceptual lightness L, chroma C, hue h), so a new colour,
// a custom one or one taken from the wallpaper cannot ship a pair that fails the contrast rules:
//   --accent        the colour as a fill, a focus ring, a switch or a selected mark: >= 3:1 against the page surfaces (WCAG 1.4.11)
//   --accent-deep   a button fill: white (--on-accent) on it is >= 4.5:1
//   --accent-text   the accent as text or a link: >= 4.5:1 on every surface, also on its own 14% tint (a chip)
//   --accent-soft   the tint behind a chip, --ring the focus halo, --accent-bright the hover shade
// A colour that already passes is left as it is (Blue is exactly #007aff); one that fails keeps its hue and chroma and moves
// only in lightness (and loses chroma only where the sRGB gamut ends), so Amber is still amber, just a deeper one on white.
(function () {
'use strict';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const toRgb = (hex) => { const n = parseInt(hex.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (rgb) => `#${rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;

// ---------- OKLCH (Björn Ottosson's OKLab, the sRGB matrices) ----------
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const gam = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function toOklch(hex) {
  const [r, g, b] = toRgb(hex).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}
// Linear sRGB of an OKLCH colour (may lie outside 0..1).
function rawRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);
// The colour at (L, C, h), or at the largest chroma not above C that fits in sRGB (the same lightness and hue).
function fromOklch(L, C, h) {
  L = clamp(L, 0, 1);
  let rgb = rawRgb(L, C, h);
  if (!inGamut(rgb)) {
    let lo = 0; let hi = C;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(rawRgb(L, mid, h))) lo = mid; else hi = mid; }
    rgb = rawRgb(L, lo, h);
  }
  return toHex(rgb.map((v) => gam(clamp(v, 0, 1))));
}

// ---------- WCAG ----------
const luminance = (hex) => { const [r, g, b] = toRgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const mix = (a, b, t) => { const x = toRgb(a); const y = toRgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const over = (fg, alpha, bg) => mix(bg, fg, alpha); // `fg` at `alpha` over an opaque `bg`

// The surfaces Lumen's pages draw on, per mode (styles.css, tokens.css, newtab.html): page background and raised card.
const SURFACES = { light: ['#ffffff', '#f5f5f7'], dark: ['#1c1c1e', '#2c2c2e'] };
const WHITE = '#ffffff';
const SOFT = { light: 0.14, dark: 0.2 }; // the --accent-soft tint

// `hex` moved in lightness (hue and chroma kept) until `ok(candidate)` holds: lighter or darker, whichever `dir` says.
// Returns hex itself when it already passes, null when no lightness does.
function fit(hex, dir, ok) {
  if (ok(hex)) return hex;
  const { L, C, h } = toOklch(hex);
  for (let i = 1; i <= 200; i++) {
    const c = fromOklch(L + dir * i * 0.005, C, h);
    if (ok(c)) return c;
  }
  return null;
}
const worst = (hex, bgs) => Math.min(...bgs.map((bg) => contrast(hex, bg)));

// Everything one accent sets, for 'light' or 'dark'.
function tokensFor(hex, mode) {
  const m = mode === 'dark' ? 'dark' : 'light';
  const surfaces = SURFACES[m];
  const dir = m === 'dark' ? 1 : -1; // text on a dark page gets lighter, on a light page darker
  const base = isHex(hex) ? hex.toLowerCase() : '#007aff';
  const accent = fit(base, dir, (c) => worst(c, surfaces) >= 3) || (m === 'dark' ? '#ffffff' : '#000000');
  const tints = surfaces.map((s) => over(accent, SOFT[m], s));
  const text = fit(accent, dir, (c) => worst(c, surfaces) >= 4.5 && worst(c, tints) >= 4.5) || (m === 'dark' ? '#ffffff' : '#000000');
  // The button fill starts where the app has always put it (18% toward black) and goes darker only as far as white text needs.
  const deep = fit(mix(accent, '#000000', 0.18), -1, (c) => contrast(WHITE, c) >= 4.5) || '#000000';
  const [r, g, b] = toRgb(accent);
  return {
    accent, accentRgb: `${r} ${g} ${b}`, accentBright: mix(accent, WHITE, 0.25), accentDeep: deep, accentText: text,
    accentSoft: `rgb(${r} ${g} ${b} / ${SOFT[m]})`, ring: `rgb(${r} ${g} ${b} / ${m === 'dark' ? 0.4 : 0.3})`, onAccent: WHITE,
  };
}

// The CSS custom properties of one token set.
const VARS = { accent: '--accent', accentRgb: '--accent-rgb', accentBright: '--accent-bright', accentDeep: '--accent-deep', accentText: '--accent-text', accentSoft: '--accent-soft', ring: '--ring', onAccent: '--on-accent' };
function varsOf(tokens) { const out = {}; for (const [k, name] of Object.entries(VARS)) out[name] = tokens[k]; return out; }
const declarations = (tokens) => Object.entries(varsOf(tokens)).map(([k, v]) => `${k}:${v}`).join(';');
// One stylesheet for light and dark (a page's own prefers-color-scheme decides). `:root:root` outranks a page's `:root` sets.
function cssFor(accent) {
  const light = tokensFor(accent.light, 'light'); const dark = tokensFor(accent.dark, 'dark');
  return `:root:root{${declarations(light)}}@media (prefers-color-scheme: dark){:root:root{${declarations(dark)}}}`;
}

// ---------- the choices ----------
// Apple's system colours (as Lumen has always offered them) and four more made in OKLCH at a common lightness and chroma, so the
// row reads as one family. [light, dark]
const oklchPair = (h, C) => [fromOklch(0.66, C, h), fromOklch(0.78, C, h)];
const ACCENTS = {
  blue: ['#007aff', '#0a84ff'], indigo: ['#5856d6', '#5e5ce6'], purple: ['#af52de', '#bf5af2'], pink: ['#ff2d55', '#ff375f'],
  rose: oklchPair(2, 0.2), red: ['#ff3b30', '#ff453a'], orange: ['#ff9500', '#ff9f0a'], amber: oklchPair(82, 0.17),
  lime: oklchPair(128, 0.2), green: ['#28a745', '#30d158'], teal: ['#30b0c7', '#40c8e0'], cyan: oklchPair(220, 0.13), graphite: ['#8e8e93', '#98989d'],
};
const ACCENT_LABELS = { blue: 'Blue', indigo: 'Indigo', purple: 'Purple', pink: 'Pink', rose: 'Rose', red: 'Red', orange: 'Orange', amber: 'Amber', lime: 'Lime', green: 'Green', teal: 'Teal', cyan: 'Cyan', graphite: 'Graphite' };
const ACCENT_IDS = Object.keys(ACCENTS);
const MATCH_WALLPAPER = 'wallpaper'; // the accent follows the background (wallpaperAccent)

// A colour taken from a picture or a gradient, made fit to be an accent: not grey (unless it was), not neon.
function wallpaperAccent(hex) {
  if (!isHex(hex)) return null;
  const { L, C, h } = toOklch(hex);
  if (C < 0.03) return fromOklch(clamp(L, 0.55, 0.75), 0, 0); // a grey picture: a grey accent
  return fromOklch(clamp(L, 0.55, 0.78), clamp(C, 0.09, 0.19), h);
}

// What the setting `value` ('blue', '#12ab34', 'wallpaper') means: { light, dark } hexes of the colour before the fit,
// `wallpaperHex` being the background's dominant colour (for 'wallpaper').
function accentOf(value, wallpaperHex) {
  let pair;
  if (ACCENTS[value]) pair = ACCENTS[value];
  else if (value === MATCH_WALLPAPER) { const w = wallpaperAccent(wallpaperHex); pair = w ? [w, w] : ACCENTS.blue; } // (no colour to go by, as on Plain: Blue)
  else if (isHex(value)) pair = [value.toLowerCase(), value.toLowerCase()];
  else pair = ACCENTS.blue;
  // What a page gets is the fitted colour: the one it will really draw.
  return { light: tokensFor(pair[0], 'light').accent, dark: tokensFor(pair[1], 'dark').accent };
}
const isAccentValue = (v) => ACCENTS[v] !== undefined || v === MATCH_WALLPAPER || isHex(v);

const api = {
  isHex, toOklch, fromOklch, contrast, mix, over, luminance, SURFACES, SOFT, tokensFor, varsOf, cssFor, fit,
  ACCENTS, ACCENT_LABELS, ACCENT_IDS, MATCH_WALLPAPER, wallpaperAccent, accentOf, isAccentValue,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.ThemeColors = api;
})();
