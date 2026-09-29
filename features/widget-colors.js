// Widget colours: "Match screen" derives a card's tint, header, event bars and today highlight from
// the new-tab page's own look (the accent colour and the chosen background), keeping text readable.
// Pure functions, no DOM, no Electron: the page (renderer/newtab-widgets.js) and the tests use it,
// and so does the main process (dominant colours of a wallpaper, computed once per picture).
//
// A widget's Colors setting is one of MODES: 'calendar' (what the feed says, today's behaviour),
// 'match' (from the screen), 'accent' (only the Lumen accent), 'mono' (greys).
(function () {
'use strict';

const MODES = ['calendar', 'match', 'accent', 'mono'];
const cleanMode = (v) => (MODES.includes(v) ? v : 'calendar');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hexToRgb = (hex) => { const n = parseInt(String(hex).slice(1, 7), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; };
const rgbToHex = ({ r, g, b }) => `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
function rgbToHsl({ r, g, b }) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
// WCAG relative luminance and contrast ratio.
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}
// `fg` moved lighter or darker (whichever way the background needs) until it reaches `min` against
// `bg`; null when no lightness gets there.
function ensureContrast(fg, bg, min = 4.5) {
  if (contrast(fg, bg) >= min) return fg;
  const hsl = rgbToHsl(hexToRgb(fg));
  const dir = luminance(bg) > 0.4 ? -1 : 1;
  for (let l = hsl.l; l >= 0 && l <= 1; l += dir * 0.02) {
    const c = rgbToHex(hslToRgb({ ...hsl, l }));
    if (contrast(c, bg) >= min) return c;
  }
  return null;
}
const pickText = (surface) => (contrast('#ffffff', surface) >= contrast('#1d1d1f', surface) ? '#ffffff' : '#1d1d1f');
// Two more colours that sit well with `hex`: neighbours on the colour wheel.
function harmonies(hex) {
  const hsl = rgbToHsl(hexToRgb(hex));
  const at = (dh) => rgbToHex(hslToRgb({ h: (hsl.h + dh + 360) % 360, s: Math.max(0.45, hsl.s), l: clamp(hsl.l, 0.4, 0.62) }));
  return [hex, at(32), at(-32)];
}

// Roughly what the built-in backgrounds look like (newtab.html): the colours to draw from, and the
// average tone the frosted cards sit over.
const BACKGROUND_INFO = {
  plain: { colors: [], avg: null },
  graphite: { colors: [], avg: '#2a2a2c' },
  aurora: { colors: ['#2ed5aa', '#5e5ce6', '#bf5af2'], avg: '#0b1f33' },
  dusk: { colors: ['#d9577b', '#f7a26a', '#5b2a86'], avg: '#5b3a80' },
  ocean: { colors: ['#0e8fa8', '#6fd6c8', '#0a4a7a'], avg: '#0a4a6a' },
  forest: { colors: ['#2f7d4f', '#9fcf7a', '#164430'], avg: '#164430' },
  sunset: { colors: ['#f0584a', '#ffc26b', '#8a1f4b'], avg: '#7a2a4a' },
};

// The most prominent, distinct, reasonably colourful colours of a picture: pixels is RGBA (canvas
// getImageData, or a bitmap from main), n colours at most. Deterministic.
function dominantColors(pixels, n = 3) {
  const bins = new Map();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const key = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4);
    const bin = bins.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bin.r += pixels[i]; bin.g += pixels[i + 1]; bin.b += pixels[i + 2]; bin.n++;
    bins.set(key, bin);
  }
  const scored = [...bins.entries()].map(([key, b]) => {
    const rgb = { r: b.r / b.n, g: b.g / b.n, b: b.b / b.n };
    const hsl = rgbToHsl(rgb);
    // Count, favouring colourful, mid-tone bins over greys, near-black and near-white.
    return { key, hex: rgbToHex(rgb), hsl, score: b.n * (0.25 + hsl.s) * (1 - Math.abs(hsl.l - 0.5)) };
  }).sort((a, b) => b.score - a.score || a.key - b.key);
  const out = [];
  for (const c of scored) {
    if (out.length >= n) break;
    if (out.every((o) => { const d = Math.abs(o.hsl.h - c.hsl.h); return Math.min(d, 360 - d) >= 30 || Math.abs(o.hsl.l - c.hsl.l) >= 0.3; })) out.push(c);
  }
  return out.map((c) => c.hex);
}

// The palette for a look: { accent, background ('plain' | 'aurora' | … | 'image'), dark, imageColors?,
// surface? (the card colour as drawn, when the caller knows it) }.
//   surface  the card's tinted surface      text   what is written on it (always >= 4.5:1)
//   head     the title colour (>= 4.5:1, or the text colour)      bars   three colours for event bars (>= 3:1 or neutral)
//   today    a highlight for today          hues   the colours everything came from
function paletteFor({ accent, background = 'plain', dark = false, imageColors = null, surface = null } = {}) {
  const acc = isHex(accent) ? accent : '#007aff';
  const onMedia = background !== 'plain';
  const info = BACKGROUND_INFO[background];
  const picked = background === 'image' ? (Array.isArray(imageColors) ? imageColors.filter(isHex) : []) : (info?.colors || []);
  const hues = picked.length >= 2 ? picked.slice(0, 3) : harmonies(picked[0] || acc);
  while (hues.length < 3) hues.push(hues[hues.length - 1]);
  const avg = background === 'image' && hues[0] ? mix('#20202a', hues[hues.length - 1], 0.3) : info?.avg;
  const base = surface && isHex(surface) ? surface : onMedia ? mix(avg || '#2a2a2c', '#ffffff', 0.12) : dark ? '#2c2c2e' : '#f5f5f7';
  const tinted = mix(base, hues[0], onMedia ? 0.18 : dark ? 0.12 : 0.06);
  const text = pickText(tinted);
  // The tint must not cost the text its contrast: back to the plain surface if it did.
  const flat = contrast(text, tinted) >= 4.5 ? tinted : base;
  const neutral = contrast(text, flat) >= 4.5 ? mix(text, flat, 0.35) : text;
  return {
    hues, surface: flat, text,
    head: ensureContrast(hues[0], flat, 4.5) || text,
    bars: hues.map((h) => ensureContrast(h, flat, 3) || neutral),
    today: mix(flat, hues[0], 0.22),
    neutral,
  };
}
// The palette a mode uses (or null for 'calendar', which leaves the card alone).
function paletteForMode(mode, look) {
  if (mode === 'match') return paletteFor(look);
  const base = paletteFor({ ...look, background: look.background === 'plain' ? 'plain' : 'graphite', imageColors: null });
  if (mode === 'accent') {
    const c = ensureContrast(isHex(look.accent) ? look.accent : '#007aff', base.surface, 3) || base.neutral;
    return { ...base, bars: [c, c, c], head: ensureContrast(c, base.surface, 4.5) || base.text };
  }
  if (mode === 'mono') return { ...base, bars: [base.neutral, base.neutral, base.neutral], head: base.text, today: mix(base.surface, base.text, 0.08) };
  return null;
}

const api = {
  MODES, cleanMode, isHex, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, luminance, contrast, mix, ensureContrast, pickText, harmonies,
  BACKGROUND_INFO, dominantColors, paletteFor, paletteForMode,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetColors = api;
})();
