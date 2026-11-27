// [look] The new-tab page's backgrounds and animated effects: the catalogue (ids, names, groups, text mode, a dominant colour),
// the CSS art of the newer ones, and "Shuffle daily". Pure functions, no DOM, no Electron: used by settings-backend.js (validates
// the settings, picks the day's background), renderer/newtab.js (draws the page), renderer/settings.js (the picker, its previews)
// and the unit tests.
//
// The art is CSS (gradients, no pictures), so nothing is bundled, nothing is fetched and a background costs no more than a plain one:
// one static paint, no animation. The older presets (aurora, dusk, ocean, forest, sunset, graphite) are CSS in newtab.html and
// settings.css; the newer ones carry their `art` here, and both pages set it as the element's background.
//   tone  'dark': white text and frosted-dark cards (every background has always been this)   'light': dark text and white cards
//         'auto' (the Studio group): follows the system's light or dark theme, with a light `art` and a dark `dark`; toneOf/artOf take
//         the system's mode and give 'light' or 'dark' and the matching art, so the page, the preview and the tests never ask the item itself
//   seed  the colour "Match wallpaper" takes the accent from (a picture gives its own)
// The text colour over each is checked on the running page (test/e2e/newtab-wallpaper.js), not assumed.
(function () {
'use strict';

// Studio textures: very fine, low-contrast patterns tiled over the base (a 1px dot grid, a hairline grid, a woven hatch). They stay crisp at
// any size and zoom, cost one static paint, and are faint enough that the text over them is measured against the base, not the pattern.
const dotGrid = (color, step) => `radial-gradient(circle at 1px 1px, ${color} 0 1px, transparent 1.5px) 0 0 / ${step}px ${step}px`;
const hairGrid = (color, step) => `linear-gradient(${color} 1px, transparent 1px) 0 0 / ${step}px ${step}px, linear-gradient(90deg, ${color} 1px, transparent 1px) 0 0 / ${step}px ${step}px`;
const weave = (color) => `repeating-linear-gradient(45deg, ${color} 0 1px, transparent 1px 7px), repeating-linear-gradient(-45deg, ${color} 0 1px, transparent 1px 7px)`;
const glow = (size, at, color) => `radial-gradient(${size} at ${at}, ${color}, transparent 70%)`;

const mesh = (base, ...glows) => `${glows.map(([size, at, color]) => `radial-gradient(${size} at ${at}, ${color}, transparent 70%)`).join(', ')}, ${base}`;

const BACKGROUNDS = [
  // Studio: calm, low-saturation themes for work. Each has a light and a dark version and follows the system theme (tone 'auto').
  { id: 'mist', label: 'Mist', group: 'studio', tone: 'auto', seed: '#5f7189',
    art: `${glow('70% 60%', '15% 0%', 'rgba(255, 255, 255, 0.95)')}, ${glow('60% 60%', '95% 100%', 'rgba(190, 201, 216, 0.6)')}, #edf0f4`,
    dark: `${glow('70% 60%', '15% 0%', 'rgba(78, 90, 110, 0.42)')}, ${glow('60% 60%', '95% 100%', 'rgba(38, 46, 60, 0.7)')}, #111419` },
  { id: 'harbor', label: 'Harbor', group: 'studio', tone: 'auto', seed: '#3a6797',
    art: `${glow('60% 50%', '85% 0%', 'rgba(255, 255, 255, 0.85)')}, linear-gradient(180deg, #eaf0f7 0%, #dbe5f0 100%), #e3ebf4`,
    dark: `${glow('60% 50%', '85% 0%', 'rgba(84, 124, 184, 0.24)')}, linear-gradient(165deg, #0a1320 0%, #0f2036 60%, #142c48 100%), #0f2036` },
  { id: 'horizon', label: 'Horizon', group: 'studio', tone: 'auto', seed: '#b5774a',
    art: `${glow('90% 45%', '50% 100%', 'rgba(255, 216, 178, 0.45)')}, linear-gradient(180deg, #f6f4f1 0%, #eef0f3 55%, #e4e9ef 100%), #eef0f3`,
    dark: `${glow('90% 40%', '50% 100%', 'rgba(196, 128, 80, 0.16)')}, linear-gradient(180deg, #0a0d13 0%, #111725 60%, #1a2031 100%), #111725` },
  { id: 'eucalyptus', label: 'Eucalyptus', group: 'studio', tone: 'auto', seed: '#4a8570',
    art: `${glow('70% 60%', '10% 10%', 'rgba(255, 255, 255, 0.8)')}, linear-gradient(160deg, #eef3ef 0%, #dfe8e2 100%), #e6eee8`,
    dark: `${glow('70% 60%', '10% 10%', 'rgba(74, 133, 112, 0.2)')}, linear-gradient(160deg, #0c1512 0%, #12201b 100%), #0f1a16` },
  { id: 'velvet', label: 'Velvet', group: 'studio', tone: 'auto', seed: '#7b5893',
    art: `${glow('70% 60%', '85% 15%', 'rgba(255, 255, 255, 0.8)')}, linear-gradient(160deg, #f3f0f5 0%, #e7e0eb 100%), #ede8f0`,
    dark: `${glow('70% 60%', '85% 15%', 'rgba(130, 92, 160, 0.22)')}, linear-gradient(160deg, #130f17 0%, #1f1726 100%), #19131f` },
  { id: 'linen', label: 'Linen', group: 'studio', tone: 'auto', seed: '#9a7f5c',
    art: `${glow('80% 60%', '20% 0%', 'rgba(255, 255, 255, 0.7)')}, ${weave('rgba(120, 98, 66, 0.045)')}, #f3efe7`,
    dark: `${glow('80% 60%', '20% 0%', 'rgba(150, 124, 90, 0.14)')}, ${weave('rgba(255, 238, 214, 0.035)')}, #191612` },
  { id: 'blueprint', label: 'Blueprint', group: 'studio', tone: 'auto', seed: '#3563ad',
    art: `${hairGrid('rgba(38, 72, 128, 0.06)', 32)}, ${glow('80% 70%', '50% 0%', 'rgba(255, 255, 255, 0.7)')}, #f1f4f8`,
    dark: `${hairGrid('rgba(150, 180, 230, 0.06)', 32)}, ${glow('80% 70%', '50% 0%', 'rgba(70, 110, 180, 0.18)')}, #0c121d` },
  { id: 'carbon', label: 'Carbon', group: 'studio', tone: 'auto', seed: '#687079',
    art: `${dotGrid('rgba(0, 0, 0, 0.09)', 18)}, ${glow('90% 70%', '50% 0%', 'rgba(255, 255, 255, 0.75)')}, #eceef0`,
    dark: `${dotGrid('rgba(255, 255, 255, 0.075)', 18)}, ${glow('90% 70%', '50% 0%', 'rgba(255, 255, 255, 0.05)')}, #0e0f11` },
  // Gradients, made for white text.
  { id: 'aurora', label: 'Aurora', group: 'gradients', tone: 'dark', seed: '#2ed5aa', art: null },
  { id: 'dusk', label: 'Dusk', group: 'gradients', tone: 'dark', seed: '#d9577b', art: null },
  { id: 'ocean', label: 'Ocean', group: 'gradients', tone: 'dark', seed: '#0e8fa8', art: null },
  { id: 'forest', label: 'Forest', group: 'gradients', tone: 'dark', seed: '#2f7d4f', art: null },
  { id: 'sunset', label: 'Sunset', group: 'gradients', tone: 'dark', seed: '#f0584a', art: null },
  { id: 'nebula', label: 'Nebula', group: 'gradients', tone: 'dark', seed: '#7c3aed', art: mesh('#0b0a1f', ['60% 50%', '15% 20%', 'rgba(124, 58, 237, 0.55)'], ['50% 60%', '85% 30%', 'rgba(236, 72, 153, 0.35)'], ['60% 60%', '60% 100%', 'rgba(56, 189, 248, 0.3)']) },
  { id: 'midnight', label: 'Midnight', group: 'gradients', tone: 'dark', seed: '#2f4fc4', art: mesh('#050b1a', ['70% 60%', '50% 0%', 'rgba(30, 64, 175, 0.55)'], ['50% 50%', '90% 90%', 'rgba(14, 116, 144, 0.4)']) },
  { id: 'ember', label: 'Ember', group: 'gradients', tone: 'dark', seed: '#ea580c', art: mesh('#1a0a08', ['60% 55%', '20% 100%', 'rgba(234, 88, 12, 0.55)'], ['50% 50%', '85% 85%', 'rgba(220, 38, 38, 0.45)'], ['40% 40%', '70% 10%', 'rgba(120, 53, 15, 0.35)']) },
  { id: 'deepsea', label: 'Deep sea', group: 'gradients', tone: 'dark', seed: '#0e7490', art: `radial-gradient(60% 50% at 80% 100%, rgba(45, 212, 191, 0.3), transparent 70%), linear-gradient(180deg, #02121f 0%, #053248 60%, #0b5d6b 100%)` },
  { id: 'northern', label: 'Northern lights', group: 'gradients', tone: 'dark', seed: '#34d399', art: mesh('#04141a', ['80% 40%', '30% 10%', 'rgba(52, 211, 153, 0.35)'], ['60% 40%', '80% 20%', 'rgba(99, 102, 241, 0.4)'], ['70% 40%', '50% 100%', 'rgba(14, 165, 233, 0.2)']) },
  { id: 'plum', label: 'Plum', group: 'gradients', tone: 'dark', seed: '#a23a94', art: `radial-gradient(50% 50% at 85% 85%, rgba(244, 114, 182, 0.3), transparent 70%), linear-gradient(150deg, #1a0b2e 0%, #3b0f4f 55%, #6b1f5e 100%)` },
  { id: 'moss', label: 'Moss', group: 'gradients', tone: 'dark', seed: '#3f8f4f', art: mesh('#0b140d', ['60% 60%', '25% 30%', 'rgba(132, 204, 22, 0.22)'], ['60% 70%', '80% 80%', 'rgba(21, 128, 61, 0.45)']) },
  { id: 'cobalt', label: 'Cobalt', group: 'gradients', tone: 'dark', seed: '#2f55c8', art: `linear-gradient(135deg, #0a1a4a 0%, #1d3a9e 55%, #3b6df0 100%)` },
  // Gradients, made for dark text.
  { id: 'peach', label: 'Peach', group: 'gradients', tone: 'light', seed: '#f59e7a', art: mesh('#fff1e6', ['60% 60%', '15% 15%', '#ffd6c0'], ['50% 60%', '90% 20%', 'rgba(255, 194, 212, 0.8)'], ['60% 60%', '60% 100%', '#ffe8a3']) },
  { id: 'lavender', label: 'Lavender', group: 'gradients', tone: 'light', seed: '#8b7be0', art: mesh('#f3efff', ['60% 60%', '20% 10%', '#d9ccff'], ['50% 50%', '85% 35%', '#ffd1ec'], ['60% 50%', '50% 100%', '#c9e4ff']) },
  { id: 'mint', label: 'Mint', group: 'gradients', tone: 'light', seed: '#34c28a', art: mesh('#ecfbf4', ['60% 60%', '10% 20%', '#bff0d8'], ['60% 50%', '90% 15%', '#c9efff'], ['50% 50%', '60% 100%', '#fdf3c8']) },
  { id: 'skylight', label: 'Skylight', group: 'gradients', tone: 'light', seed: '#4aa3f0', art: `radial-gradient(60% 40% at 70% 0%, #bfe0ff, transparent 70%), linear-gradient(180deg, #dff0ff 0%, #f1f8ff 100%)` },
  { id: 'sand', label: 'Sand', group: 'gradients', tone: 'light', seed: '#c9a37a', art: mesh('#f7f1e8', ['60% 50%', '80% 10%', '#f1dcc0'], ['60% 60%', '10% 100%', '#e8d3c3']) },
  { id: 'blush', label: 'Blush', group: 'gradients', tone: 'light', seed: '#ec7fa6', art: `linear-gradient(160deg, #fff0f3 0%, #ffe1ea 60%, #f9d7f0 100%)` },
  { id: 'citrus', label: 'Citrus', group: 'gradients', tone: 'light', seed: '#f0b429', art: mesh('#fffbe8', ['55% 55%', '15% 20%', '#fff0a8'], ['55% 55%', '90% 80%', '#ffd9a8']) },
  { id: 'fog', label: 'Fog', group: 'gradients', tone: 'light', seed: '#7a8aa0', art: `radial-gradient(50% 40% at 20% 0%, #ffffff, transparent 70%), linear-gradient(180deg, #eef2f7 0%, #dfe6ee 100%)` },
  // Solid tones.
  { id: 'plain', label: 'Plain', group: 'solids', tone: 'plain', seed: null, art: null },
  { id: 'graphite', label: 'Graphite', group: 'solids', tone: 'dark', seed: null, art: null },
  { id: 'ink', label: 'Ink', group: 'solids', tone: 'dark', seed: '#6b7bd6', art: '#0b0b10' },
  { id: 'slate', label: 'Slate', group: 'solids', tone: 'dark', seed: '#5f7d9c', art: '#1e2733' },
  { id: 'navy', label: 'Navy', group: 'solids', tone: 'dark', seed: '#3b6fd0', art: '#0d1b34' },
  { id: 'pine', label: 'Pine', group: 'solids', tone: 'dark', seed: '#2f9a73', art: '#0f2a22' },
  { id: 'wine', label: 'Wine', group: 'solids', tone: 'dark', seed: '#b8456f', art: '#2a0f1b' },
  { id: 'paper', label: 'Paper', group: 'solids', tone: 'light', seed: '#b99560', art: '#f5f0e6' },
  { id: 'cloud', label: 'Cloud', group: 'solids', tone: 'light', seed: '#5f86b5', art: '#e9eef4' },
  { id: 'sage', label: 'Sage', group: 'solids', tone: 'light', seed: '#6f9a6f', art: '#e7efe6' },
];
const IMAGE = { id: 'image', label: 'Your picture', group: 'image', tone: 'dark', seed: null, art: null };
const GROUPS = [{ id: 'studio', label: 'Studio' }, { id: 'gradients', label: 'Gradients' }, { id: 'solids', label: 'Solids' }, { id: 'image', label: 'Your picture' }];
const IDS = [...BACKGROUNDS.map((b) => b.id), IMAGE.id];
const byId = (id) => (id === IMAGE.id ? IMAGE : BACKGROUNDS.find((b) => b.id === id) || null);
const isBackground = (id) => IDS.includes(id);
// Text and cards: 'light' is the only background that turns the page's text dark; a picture is darkened under a scrim, so it is dark.
// A Studio one ('auto') is 'light' in the light theme and 'dark' in the dark theme (systemDark: the system's, as the page sees it).
// Your picture is 'dark' unless it was measured light (picture: widget-colors.js pictureTone, sampled once per picture in settings-backend.js).
const toneOf = (id, systemDark = false, picture = 'dark') => {
  const tone = byId(id)?.tone || 'plain';
  if (id === IMAGE.id) return picture === 'light' ? 'light' : 'dark';
  return tone === 'auto' ? (systemDark ? 'dark' : 'light') : tone;
};
// The CSS art drawn for a background in the system's theme (null for Plain, Your picture and the older ones, which are CSS of their own).
const artOf = (id, systemDark = false) => { const item = byId(id); return (item?.tone === 'auto' && systemDark ? item.dark : item?.art) || null; };
// The shades the page is drawn in over a background ('light' or 'dark'): the system's on Plain, light over a light background, dark over any other.
// The new-tab page (accent, text) and the picker's preview in Settings both ask this, so the two can never disagree.
const modeOf = (id, systemDark, picture) => { const tone = toneOf(id, systemDark, picture); return tone === 'plain' ? (systemDark ? 'dark' : 'light') : tone === 'light' ? 'light' : 'dark'; };

// The animated effects drawn over a background (renderer/newtab-effects.js), with a still preview each for the picker.
// `fps` is how often it redraws (the particles and snow move at 30; the soft ones need far fewer); `soft` ones are drawn small and scaled up.
const dots = (color, ...at) => at.map(([x, y, r]) => `radial-gradient(circle at ${x}% ${y}%, ${color} 0 ${r}px, transparent ${r + 1}px)`).join(', ');
const EFFECTS = [
  { id: 'none', label: 'None', art: null },
  { id: 'particles', label: 'Particles', art: `${dots('#fff', [15, 30, 2], [40, 70, 2], [62, 25, 2], [85, 60, 2], [75, 85, 1.5])}, linear-gradient(60deg, transparent 38%, rgba(255, 255, 255, 0.3) 39% 40%, transparent 41%), #1c2540` },
  { id: 'stars', label: 'Stars', art: `${dots('#fff', [12, 20, 1], [30, 60, 1.5], [48, 30, 1], [66, 75, 1], [80, 25, 1.5], [90, 70, 1], [55, 50, 1])}, #0b1226` },
  { id: 'bubbles', label: 'Bubbles', art: `radial-gradient(circle at 25% 65%, transparent 9px, rgba(255, 255, 255, 0.55) 10px 11px, transparent 12px), radial-gradient(circle at 60% 35%, transparent 14px, rgba(255, 255, 255, 0.55) 15px 16px, transparent 17px), radial-gradient(circle at 82% 72%, transparent 6px, rgba(255, 255, 255, 0.55) 7px 8px, transparent 9px), #123a55` },
  { id: 'snow', label: 'Snow', art: `${dots('#fff', [10, 20, 1.5], [28, 55, 2], [45, 15, 1.5], [60, 70, 2], [78, 35, 1.5], [90, 80, 2], [35, 85, 1])}, #2a3a4d` },
  { id: 'aurora', label: 'Aurora drift', art: `radial-gradient(80% 40% at 25% 40%, rgba(52, 211, 153, 0.65), transparent 70%), radial-gradient(70% 40% at 75% 55%, rgba(129, 140, 248, 0.6), transparent 70%), #08131f` },
  { id: 'blobs', label: 'Soft blobs', art: `radial-gradient(circle at 25% 35%, rgba(244, 114, 182, 0.7) 0 14px, transparent 30px), radial-gradient(circle at 70% 60%, rgba(96, 165, 250, 0.7) 0 18px, transparent 36px), radial-gradient(circle at 50% 20%, rgba(250, 204, 21, 0.45) 0 10px, transparent 26px), #1b1b2f` },
  { id: 'grain', label: 'Film grain', art: `repeating-conic-gradient(rgba(255, 255, 255, 0.22) 0 25%, rgba(0, 0, 0, 0.22) 0 50%) 0 0 / 3px 3px, #3a3a3e` },
];
const EFFECT_IDS = EFFECTS.map((e) => e.id);
const isEffect = (id) => EFFECT_IDS.includes(id);

// ---------- Shuffle daily ----------
// A new gradient each day, the same one all day and on every computer for that date: the day number steps through a fixed
// shuffle of the gradients, so no gradient shows twice in a row and each appears once before any repeats.
const POOL = BACKGROUNDS.filter((b) => b.group === 'gradients').map((b) => b.id);
function shuffled(ids) { // a seeded Fisher-Yates (a small fixed LCG: the same order everywhere, always)
  const out = [...ids]; let s = 2463534242;
  for (let i = out.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
const ORDER = shuffled(POOL);
// "YYYY-MM-DD" of a Date in local time.
const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function dailyPick(key = dayKey()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) return ORDER[0];
  const day = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  return ORDER[((day % ORDER.length) + ORDER.length) % ORDER.length];
}

const api = { BACKGROUNDS, IMAGE, GROUPS, IDS, byId, isBackground, toneOf, artOf, modeOf, EFFECTS, EFFECT_IDS, isEffect, POOL, ORDER, dayKey, dailyPick };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.Backgrounds = api;
})();
