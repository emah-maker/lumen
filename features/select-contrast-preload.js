// Readable <select> menus on dark-styled sites. A form styled for a dark page often gives its
// dropdown light text on a transparent background; when the list opens, Chromium fills a
// transparent menu with white, so the options are white on white (a billing form's State list
// showed nothing). Just before a menu can open (press, key, focus), each option that would be hard
// to read gets the page's own background behind the select and a readable text color. Options a
// site styled with its own background are only touched if their text is unreadable on it.
const fixed = new WeakSet();

// "rgb(r, g, b)" / "rgba(r, g, b, a)" -> { r, g, b, a }; anything else (color(), etc.) -> null.
function rgb(value) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(value || '');
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a };
}
const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (x, y) => { const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
const css = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;
const opaque = (c) => c && c.a >= 0.5;

// The color actually behind the select: the nearest ancestor with a solid background, else the
// page canvas (white unless the page opted into a dark color scheme).
function behind(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const bg = rgb(getComputedStyle(node).backgroundColor);
    if (opaque(bg)) return bg;
  }
  return matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme)
    ? { r: 18, g: 18, b: 18, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };
}

function fix(select) {
  if (fixed.has(select) || select.multiple || select.size > 1) return; // list boxes draw in the page
  fixed.add(select);
  const own = rgb(getComputedStyle(select).backgroundColor);
  const menu = opaque(own) ? own : null; // Chromium uses the select's own solid background for the menu
  const page = menu || behind(select);
  for (const option of select.options) {
    const style = getComputedStyle(option);
    const fg = rgb(style.color);
    const bg = rgb(style.backgroundColor);
    if (!fg) continue;
    const under = opaque(bg) ? bg : page;
    if (!opaque(bg) && !menu) option.style.setProperty('background-color', css(under), 'important');
    if (contrast(fg, under) < 3) option.style.setProperty('color', luminance(under) > 0.4 ? '#111' : '#f2f2f2', 'important');
  }
}

// This preload runs in every frame of every page (main.js registerPreloadScript), most of which have
// no <select> at all — these listeners must stay near-free there. The instanceof check below is the
// entire cost per event; there's no reliable "no selects in this frame" check at document-start (the
// DOM isn't parsed yet, and pages add selects dynamically), so this is as lazy as it gets without risk.
const onEvent = (e) => { const t = e.target; if (t instanceof HTMLSelectElement) fix(t); };
for (const type of ['pointerdown', 'keydown', 'focusin']) window.addEventListener(type, onEvent, true);
// A select whose options change (a country picked, then states loaded) is checked again. 'change'
// bubbles from any form control, so bail before the DOM scan unless it was actually a select — a page
// full of checkboxes/inputs would otherwise re-scan for <select> on every unrelated change.
window.addEventListener('change', (e) => {
  if (!(e.target instanceof HTMLSelectElement)) return;
  for (const select of document.querySelectorAll('select')) if (select !== e.target) fixed.delete(select);
}, true);
