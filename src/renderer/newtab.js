// New-tab page. The browser passes everything in the URL hash as JSON:
//   { favorites: [{ title, url, icon? }], frequent: [{ title, url, icon? }], blocked: number,
//     look: { background, image (a file: URL in the profile), effect, still, lite, accent: { light, dark }, clock, clockStyle, name, sections },
//     hidden: { favorites: [url], frequent: [host] } (tiles the user removed; the page leaves them out, see "Removing tiles" below),
//     widgets: [{ id, type, title, data, error, loading }] (features/widgets.js; newtab-widgets.js draws them) }
// (an older plain array means favorites only). Icons are favicons the browser cached locally as
// data: URLs; the page itself never touches the network.
const DEFAULTS = [
  ['Google', 'https://www.google.com'], ['YouTube', 'https://www.youtube.com'], ['Gmail', 'https://mail.google.com'],
  ['Wikipedia', 'https://www.wikipedia.org'], ['GitHub', 'https://github.com'], ['Reddit', 'https://www.reddit.com'],
  ['Amazon', 'https://www.amazon.com'], ['News', 'https://news.google.com'],
].map(([title, url]) => ({ title, url }));

const isWeb = (b) => b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url);
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const label = (b) => (typeof b.title === 'string' && b.title.trim() ? b.title.trim() : host(b.url));

function data() {
  try {
    const parsed = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (Array.isArray(parsed)) return { favorites: parsed.filter(isWeb), frequent: [], blocked: null, look: lookOf(null), hidden: hiddenOf(null) };
    return {
      search: parsed.search && typeof parsed.search.url === 'string' && /^https:\/\//.test(parsed.search.url) ? parsed.search : null,
      assistant: parsed.assistant && typeof parsed.assistant.name === 'string' ? { ...parsed.assistant, model: typeof parsed.assistant.model === 'string' ? parsed.assistant.model : '', label: typeof parsed.assistant.label === 'string' ? parsed.assistant.label : '' } : null,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter(isWeb) : DEFAULTS,
      frequent: Array.isArray(parsed.frequent) ? parsed.frequent.filter(isWeb) : [],
      blocked: Number.isFinite(parsed.blocked) ? parsed.blocked : null,
      look: lookOf(parsed.look),
      hidden: hiddenOf(parsed.hidden),
      widgets: Array.isArray(parsed.widgets) ? parsed.widgets : [],
    };
  } catch {
    return { favorites: DEFAULTS, frequent: [], blocked: null, look: lookOf(null), hidden: hiddenOf(null) };
  }
}

// [look] The page's design from Settings → Appearance, checked field by field.
const BACKGROUNDS = window.Backgrounds.IDS; // features/backgrounds.js: the presets, their text mode and (for the newer ones) their CSS art
const EFFECTS = window.Backgrounds.EFFECT_IDS.filter((id) => id !== 'none'); // newtab-effects.js
const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
function lookOf(l) {
  const look = l && typeof l === 'object' ? l : {};
  const image = typeof look.image === 'string' && /^file:\/\/\/[^"'()\\\s]+$/.test(look.image) ? look.image : null;
  const background = BACKGROUNDS.includes(look.background) && (look.background !== 'image' || image) ? look.background : 'plain';
  const sections = look.sections && typeof look.sections === 'object' ? look.sections : {};
  return {
    background, image,
    effect: EFFECTS.includes(look.effect) ? look.effect : 'none', still: look.still === true || look.softwareGfx === true, lite: look.lite === true, light: look.lightGfx === true || look.softwareGfx === true, soft: look.softwareGfx === true, // [igpu] Graphics: Light; software drawing: still too, no blur, no shadows (settings-backend.js [igpu])
    effectStyle: effectStyleOf(look.effectStyle),
    reduceMotion: look.still === true, // (the setting itself: `still` above also stands for software drawing)
    musicReactive: look.musicReactive === true, // [look] Music-reactive home screen: off unless switched on (newtab-music-react.js)
    accent: { light: hex(look.accent?.light), dark: hex(look.accent?.dark) },
    clock: look.clock !== false,
    clockSize: window.WidgetSystem.cleanClockSize(look.clockSize) || 'm',
    clockStyle: window.ClockStyles.clean(look.clockStyle), // [look] style, hours, seconds, date, card, shadow, greeting font
    searchWidth: window.WidgetSystem.cleanSearchWidth(look.searchWidth) || 640,
    name: typeof look.name === 'string' ? look.name.slice(0, 40) : '',
    sections: { header: sections.header !== false, favorites: sections.favorites !== false, frequent: sections.frequent !== false, privacy: sections.privacy !== false },
    glass: ['frosted', 'clear'].includes(look.widgetGlass) ? look.widgetGlass : 'solid', // [look] Widget cards
    packed: look.widgetsPacked === true, // off unless switched on: cards stay where they are put. [widgets] Keep widgets packed
    imageColors: Array.isArray(look.imageColors) ? look.imageColors.filter((c) => hex(c)).slice(0, 3) : [], // [widgets] Match screen colours
  };
}
function effectStyleOf(s) {
  const st = s && typeof s === 'object' ? s : {};
  const one = (v, allowed) => (allowed.includes(v) ? v : 'normal');
  return {
    color: ['auto', 'accent', 'rainbow'].includes(st.color) || hex(st.color) ? st.color : 'auto',
    amount: one(st.amount, ['few', 'many']), speed: one(st.speed, ['slow', 'fast']), size: one(st.size, ['small', 'large']),
    interact: st.interact !== false,
  };
}
const dark = matchMedia('(prefers-color-scheme: dark)');
let currentLook = lookOf(null);
window.newtabLook = () => currentLook; // the editor on the clock card (newtab-setup.js) starts from what is shown
function applyLook(look) {
  currentLook = look;
  const tone = window.Backgrounds.toneOf(look.background); // 'plain' (the page's own colours), 'dark' (white text) or 'light' (dark text)
  document.body.dataset.bg = look.background;
  document.body.classList.toggle('on-media', tone !== 'plain');
  document.body.classList.toggle('tone-light', tone === 'light');
  document.body.style.setProperty('--wallpaper', look.image ? `url("${look.image}")` : 'none');
  document.getElementById('backdrop').style.background = window.Backgrounds.byId(look.background)?.art || ''; // (the newer presets; the older ones are CSS below)
  applyAccent(look);
  document.getElementById('clock').hidden = !look.clock;
  applyClockStyle(look);
  window.newtabSize?.apply(look.clockSize, look.searchWidth); // [look] --clock-size / --search-w on <main>
  document.body.dataset.wpack = look.packed ? '1' : '0';
  document.body.dataset.wglass = look.glass;
  document.body.classList.toggle('gfx-soft', look.soft); // [igpu] software drawing: no blur at all, no heavy shadows, no motion (newtab.html)
  document.body.classList.toggle('gfx-light', look.light); // [igpu] no backdrop blur, no drifting layer (newtab.html), a cheaper effect (newtab-effects.js)
  document.body.classList.toggle('calm', look.still || look.lite); // [widgets] no sliding with Reduce motion or Performance mode
  document.body.classList.toggle('still', look.still); // [widgets] no sliding or other motion with Reduce motion
  applyEffect(look);
  applyMusicReactive(look);
  window.applyWidgetColors?.(); // [widgets] cards set to Match screen follow the accent, background and theme
}
// [look] The accent's tokens (features/theme-colors.js) in the shades the page is drawn in: the system's on Plain, light on a light
// background, dark on any other.
const modeOf = (look) => window.Backgrounds.modeOf(look.background, dark.matches); // (features/backgrounds.js: the Settings preview asks the same)
const ACCENT_VARS = ['--accent', '--accent-rgb', '--accent-bright', '--accent-deep', '--accent-text', '--accent-soft', '--ring', '--on-accent'];
function applyAccent(look) {
  const mode = modeOf(look);
  const hexOf = look.accent[mode];
  const root = document.documentElement.style;
  const vars = hexOf ? window.ThemeColors.varsOf(window.ThemeColors.tokensFor(hexOf, mode)) : null;
  for (const name of ACCENT_VARS) {
    if (vars) root.setProperty(name, vars[name]); else root.removeProperty(name);
  }
}
// The animated effect's script is loaded the first time one is on, never otherwise.
let effectScript = null;
function applyEffect(look) {
  document.body.classList.toggle('has-effect', look.effect !== 'none'); // the page's fields turn less see-through over one
  if (window.setBackdropEffect) { window.setBackdropEffect(look.effect, look); return; }
  if (look.effect === 'none' || effectScript) return;
  effectScript = document.createElement('script');
  effectScript.src = 'newtab-effects.js';
  effectScript.onload = () => window.setBackdropEffect?.(currentLook.effect, currentLook);
  document.head.append(effectScript);
}
// [look] Music-reactive home screen: its three scripts are loaded the first time the setting is on, never otherwise.
let musicScripts = 0;
function applyMusicReactive(look) {
  if (window.setMusicReactive) { window.setMusicReactive(look); return; }
  if (!(look.musicReactive || document.querySelector('.w-card[data-mreact="1"]')) || musicScripts) return; // (the home screen, or a music card that reacts: either starts it)
  musicScripts = 1;
  const load = (src, next) => { const s = document.createElement('script'); s.src = src; s.onload = next; document.head.append(s); };
  load('../features/music-react.js', () => load('music-field-canvas.js', () => load('newtab-music-react.js', () => window.setMusicReactive?.(currentLook))));
}
window.musicCardsChanged = () => applyMusicReactive(currentLook); // (newtab-widgets.js says when the cards change; the driver replaces this once loaded)
dark.addEventListener('change', () => applyLook(currentLook));
// [widgets] what newtab-widgets.js needs to tint cards from the page's own look
window.widgetLook = () => {
  const light = window.Backgrounds.toneOf(currentLook.background) === 'light'; // (a light background reads like Plain in the light theme: dark text)
  return {
    accent: currentLook.accent[modeOf(currentLook)] || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    background: light ? 'plain' : currentLook.background, dark: light ? false : dark.matches, imageColors: currentLook.imageColors,
  };
};
// [look] The clock's style (features/clock-styles.js; the looks are CSS in newtab.html): data attributes on <body>.
// The defaults (classic, no card, no extra shadow, classic greeting) set nothing the page didn't always have.
function applyClockStyle(look) {
  const cs = look.clockStyle;
  const b = document.body.dataset;
  b.clockStyle = cs.style;
  b.clockCard = cs.card;
  b.clockShadow = cs.shadow ? '1' : '0';
  b.greetingFont = window.ClockStyles.greetingFontFor(cs.greeting, cs.style);
  document.getElementById('date').hidden = !cs.date;
  document.getElementById('clock-card').hidden = !look.clock && !cs.date;
  lastClock = '';
  scheduleClock();
}
// The time as hours, separator and minutes (and small seconds), so a style can stack them; the text reads the same.
let lastClock = '';
function tickClock() {
  const el = document.getElementById('clock');
  if (el.hidden) return;
  const cs = currentLook.clockStyle || window.ClockStyles.DEFAULTS;
  const t = window.ClockStyles.clockParts(new Date(), { hours: cs.hours, seconds: cs.seconds });
  const h = cs.style === 'bold' && /^\d$/.test(t.h) ? `0${t.h}` : t.h; // stacked hours are two digits
  const key = `${cs.style}|${h}|${t.sep}|${t.m}|${t.s}`;
  if (key === lastClock) return;
  lastClock = key;
  const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
  el.replaceChildren(span('clock-h', h), span('clock-sep', t.sep), span('clock-m', t.m), ...(t.s ? [span('clock-s', `${t.ssep}${t.s}`)] : []));
  // 9:59 -> 10:00 (or proportional digits) can widen the clock past the column: fitted again when its width changes.
  clockRange.selectNodeContents(el);
  const w = Math.round(clockRange.getBoundingClientRect().width);
  if (lastClockW && w !== lastClockW) window.newtabSize?.fitNow?.();
  lastClockW = w;
}
const clockRange = document.createRange();
let lastClockW = 0;
document.fonts?.ready?.then(() => window.newtabSize?.fitNow?.()); // a clock font that loads late may be wider
// Minutes only: wake as each minute turns. With seconds: just after each second turns. A hidden page (a background tab, the spare) has no
// timer at all: the clock is drawn and the timer started again when the page is shown.
let clockTimer = 0;
function scheduleClock() {
  clearTimeout(clockTimer);
  clockTimer = 0;
  if (document.hidden || document.getElementById('clock-card')?.hidden) return; // (nothing on screen shows the time: no timer)
  const every = currentLook.clockStyle?.seconds ? 1000 : 60e3;
  clockTimer = setTimeout(() => { tickClock(); scheduleClock(); }, every - (Date.now() % every) + 15);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(clockTimer); clockTimer = 0; } else { tickClock(); scheduleClock(); } });

// A stable hue per site for monogram tiles.
function hueOf(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Math.round((h * 137.508) % 360); // golden-angle spread keeps neighbours apart
}

function tile(b, size) {
  const el = document.createElement('span');
  el.className = 'tile';
  el.setAttribute('aria-hidden', 'true');
  const letter = label(b)[0]?.toUpperCase() || '?';
  const mono = () => {
    el.classList.add('mono');
    el.style.setProperty('--hue', String(hueOf(host(b.url))));
    el.textContent = letter;
  };
  // A locally cached favicon first, then the icon bundled for default favorites, then a letter.
  const bundled = (window.BUNDLED_ICONS || {})[host(b.url)];
  const icon = typeof b.icon === 'string' && (b.icon.startsWith('data:image/') || /^file:\/\/\/.+\/favicon-cache\/[0-9a-f]{20}\.[a-z0-9]+$/i.test(b.icon)) ? b.icon : bundled;
  if (icon) {
    const img = new Image(size, size);
    img.alt = '';
    img.onerror = () => { img.remove(); mono(); };
    img.src = icon;
    el.append(img);
  } else {
    mono();
  }
  return el;
}

function section(title, content) {
  const s = document.createElement('section');
  s.setAttribute('aria-label', title);
  const h2 = Object.assign(document.createElement('h2'), { textContent: title });
  if (title === 'Favorites') h2.title = `Your bookmarks. Press ${MAC ? 'Cmd' : 'Ctrl'}+D on any page to add it here.`;
  s.append(h2, content);
  return s;
}

// Where Favorites come from: your bookmarks. Said on an empty list, and under a short one (the heading's tooltip says it too).
const MAC = /mac|iphone|ipad/i.test(String(navigator.userAgentData?.platform || navigator.platform || ''));
const hintLine = (lead) => {
  const kbd = (t) => Object.assign(document.createElement('kbd'), { textContent: t });
  return ['Favorites are your bookmarks. ' + lead, kbd(MAC ? 'Cmd' : 'Ctrl'), '+', kbd('D'), ' on any page to add it here.'];
};
// ---- Removing tiles (Chrome-like): a ⋮ button on hover or focus, right-click, or Delete on a focused tile. Removing only hides the tile on
// this page (a favorite stays a bookmark; a frequently-visited site is remembered by its host, so it does not come back). The list is
// saved by the browser (settings newTabHiddenTiles, via window.lumenNewtab.setHiddenTiles); an Undo toast and "Restore all" bring tiles back.
const hiddenOf = (h) => {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return { favorites: list(h?.favorites), frequent: list(h?.frequent) };
};
const keyOf = (kind, b) => (kind === 'favorites' ? b.url : host(b.url));
const isHidden = (hid, kind, b) => hid[kind].includes(keyOf(kind, b));
let hiddenState = null;
let removedCount = 0;
const hiddenNow = () => hiddenState || data().hidden;
function setHidden(next) {
  hiddenState = next;
  // The tab's own address carries the page data: keep its list current, so a reload of this tab does not bring a removed tile back.
  try {
    const p = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (p && typeof p === 'object' && !Array.isArray(p)) history.replaceState(null, '', location.pathname + location.search + '#' + encodeURIComponent(JSON.stringify({ ...p, hidden: next })));
  } catch {}
  window.lumenNewtab?.setHiddenTiles?.(next)?.catch?.(() => {});
}
// Where the keyboard goes after a tile is gone: the one that took its place (or the one before it), else the page's search box.
function refocus(kind, index) {
  const links = [...document.querySelectorAll(kind === 'favorites' ? 'nav.grid .cell > a' : 'nav.frequent .cell > a')];
  (links[Math.min(index, links.length - 1)] || document.getElementById('q'))?.focus();
}
const indexOfCell = (c) => [...c.parentElement.children].indexOf(c);
function removeTile(kind, b, index) {
  const before = hiddenNow();
  const key = keyOf(kind, b);
  if (before[kind].includes(key)) return;
  setHidden({ ...before, [kind]: [...before[kind], key] });
  render();
  refocus(kind, index);
  tilesToast('Removed ' + label(b) + '.', 'Undo', () => {
    const now = hiddenNow();
    setHidden({ ...now, [kind]: now[kind].filter((k) => k !== key) });
    render();
    [...document.querySelectorAll('.cell > a')].find((a) => a.href === b.url || a.getAttribute('href') === b.url)?.focus();
  });
}
function restoreAll() {
  const before = hiddenNow();
  if (!before.favorites.length && !before.frequent.length) return;
  setHidden({ favorites: [], frequent: [] });
  render();
  tilesToast('Removed tiles are back.', 'Undo', () => { setHidden(before); render(); });
}
window.newtabTiles = { restoreAll, count: () => removedCount };
let tilesToastTimer = 0;
function tilesToast(message, action, run) {
  document.querySelector('.tiles-toast')?.remove();
  clearTimeout(tilesToastTimer);
  const t = Object.assign(document.createElement('div'), { className: 'w-toast w-ui tiles-toast' });
  t.setAttribute('role', 'status');
  t.append(Object.assign(document.createElement('span'), { textContent: message }));
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'w-tb tiles-toast-undo', textContent: action });
  b.addEventListener('click', () => { t.remove(); clearTimeout(tilesToastTimer); run(); });
  t.append(b);
  document.body.append(t);
  tilesToastTimer = setTimeout(() => t.remove(), 8000);
}
// "n removed. Restore all" under Favorites while anything is removed (the clock panel has the same button).
function withRestore(content) {
  if (!removedCount) return content;
  const box = document.createElement('div');
  const row = Object.assign(document.createElement('p'), { className: 'section-hint tiles-restore' });
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'tiles-restore-btn', textContent: 'Restore all' });
  b.addEventListener('click', restoreAll);
  row.append(removedCount + ' removed. ', b);
  box.append(content, row);
  return box;
}
let tileMenu = null;
function closeTileMenu(refocusTo) {
  if (!tileMenu) return;
  const { el, from } = tileMenu;
  tileMenu = null;
  el.remove();
  if (refocusTo !== false) from?.focus();
}
function openTileMenu(c, kind, b, x, y, from) {
  closeTileMenu(false);
  const menu = Object.assign(document.createElement('div'), { className: 'w-stack-menu tile-menu' });
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label(b));
  const item = (text, run) => {
    const i = Object.assign(document.createElement('button'), { type: 'button', className: 'w-stack-menu-item', textContent: text });
    i.setAttribute('role', 'menuitem');
    i.addEventListener('click', () => { closeTileMenu(false); run(); });
    menu.append(i);
  };
  item(kind === 'favorites' ? 'Remove from this page' : 'Remove', () => removeTile(kind, b, indexOfCell(c)));
  if (removedCount) item('Restore all removed (' + removedCount + ')', () => { restoreAll(); });
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  tileMenu = { el: menu, from };
  menu.querySelector('button')?.focus();
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeTileMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') closeTileMenu(false);
  });
}
document.addEventListener('pointerdown', (e) => { if (tileMenu && !tileMenu.el.contains(e.target)) closeTileMenu(false); }, true);
window.addEventListener('blur', () => closeTileMenu(false));
// A tile and its ⋮ button side by side (a button can't sit inside the link).
function cell(a, b, kind) {
  const c = Object.assign(document.createElement('div'), { className: 'cell' });
  const more = Object.assign(document.createElement('button'), { type: 'button', className: 'tile-more', textContent: '⋮' });
  more.title = 'More';
  more.setAttribute('aria-label', 'More for ' + label(b));
  more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', (e) => {
    e.preventDefault();
    const r = more.getBoundingClientRect();
    openTileMenu(c, kind, b, r.left, r.bottom + 2, more);
  });
  c.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTileMenu(c, kind, b, e.clientX || c.getBoundingClientRect().left, e.clientY || c.getBoundingClientRect().bottom, a);
  });
  c.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || (e.key === 'Backspace' && e.shiftKey)) && (e.target === a || e.target === more) && !e.isComposing) { e.preventDefault(); removeTile(kind, b, indexOfCell(c)); }
  });
  c.append(a, more);
  return c;
}

function favorites(list) {
  if (!list.length) {
    const p = Object.assign(document.createElement('p'), { className: 'empty' });
    p.append(...hintLine('Press '));
    return p;
  }
  const nav = Object.assign(document.createElement('nav'), { className: 'grid' });
  nav.setAttribute('aria-label', 'Favorites');
  for (const b of list.slice(0, 12)) {
    const a = document.createElement('a');
    a.href = b.url;
    a.title = `${label(b)} — ${host(b.url)}`;
    a.append(tile(b, 28), Object.assign(document.createElement('span'), { className: 'name', textContent: label(b) }));
    nav.append(cell(a, b, 'favorites'));
  }
  if (list.length >= 4) return nav;
  const box = document.createElement('div');
  const hint = Object.assign(document.createElement('p'), { className: 'section-hint' });
  hint.append(...hintLine('Press '));
  box.append(nav, hint);
  return box;
}

function frequent(list) {
  const nav = Object.assign(document.createElement('nav'), { className: 'frequent' });
  nav.setAttribute('aria-label', 'Frequently visited');
  for (const b of list.slice(0, 6)) {
    const a = document.createElement('a');
    a.href = b.url;
    a.title = b.url;
    const text = Object.assign(document.createElement('span'), { className: 'text' });
    text.append(
      Object.assign(document.createElement('span'), { className: 'title', textContent: label(b) }),
      Object.assign(document.createElement('span'), { className: 'host', textContent: host(b.url) }),
    );
    a.append(tile(b, 18), text);
    nav.append(cell(a, b, 'frequent'));
  }
  return nav;
}

const SHIELD = '<svg viewBox="0 0 26 26" aria-hidden="true"><path d="M13 2.5 4.5 5.8v6.4c0 5.4 3.6 9.6 8.5 11.3 4.9-1.7 8.5-5.9 8.5-11.3V5.8Z" fill="var(--green)" opacity="0.16"/><path d="M13 2.5 4.5 5.8v6.4c0 5.4 3.6 9.6 8.5 11.3 4.9-1.7 8.5-5.9 8.5-11.3V5.8Z" fill="none" stroke="var(--green)" stroke-width="1.6" stroke-linejoin="round"/><path d="m9.2 13.2 2.6 2.6 5-5.4" fill="none" stroke="var(--green)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function privacy(blocked) {
  const card = Object.assign(document.createElement('div'), { className: 'privacy' });
  card.innerHTML = SHIELD;
  const text = document.createElement('div');
  const strong = document.createElement('strong');
  const detail = document.createElement('span');
  if (blocked > 0) {
    strong.textContent = blocked === 1 ? '1 ad or tracker blocked' : `${blocked.toLocaleString()} ads and trackers blocked`;
    detail.textContent = 'On the tabs you have open right now.';
  } else {
    strong.textContent = 'Ad and tracker blocking is on';
    detail.textContent = 'Blocked requests on your open tabs are counted here.';
  }
  text.append(strong, detail);
  card.append(text);
  return card;
}

const greeting = (now) => window.ClockStyles.greetingFor(now); // (features/clock-styles.js)

function render() {
  // A redraw (the browser sending the page again after a save, a setting change) replaces the tiles: the keyboard stays on the same spot.
  const was = document.activeElement?.closest?.('nav.grid .cell, nav.frequent .cell');
  const kept = was ? { kind: was.closest('nav.grid') ? 'favorites' : 'frequent', index: indexOfCell(was) } : null;
  const d = data();
  const { blocked, look, widgets } = d;
  const hid = hiddenState || d.hidden; // (what the user just removed or restored here, until the browser sends the page again)
  const favs = d.favorites.filter((b) => !isHidden(hid, 'favorites', b));
  const allFreq = d.frequent.filter((b) => !isHidden(hid, 'frequent', b));
  const freq = allFreq.slice(0, 6);
  removedCount = d.favorites.length - favs.length + d.frequent.length - allFreq.length;
  applyLook(look);
  tickClock();
  const now = new Date();
  document.getElementById('date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  document.getElementById('greeting').textContent = look.name ? `${greeting(now)}, ${look.name}` : greeting(now);
  // The sections are cards on the widget grid once moved or while Edit layout is on (newtab-system.js);
  // until then they are in the centre column as they always were. They are placed first: the grid needs them.
  const part = (shown, title, build) => {
    if (!shown) return null;
    const content = build();
    return { title, content, section: section(title, content) };
  };
  window.newtabSystem.fill({
    favorites: part(look.sections.favorites, 'Favorites', () => withRestore(favorites(favs))),
    frequent: part(look.sections.frequent && freq.length, 'Frequently Visited', () => frequent(freq)),
    privacy: part(look.sections.privacy && blocked !== null, 'Privacy', () => privacy(blocked)),
  }, { header: look.sections.header }, widgets);
  window.newtabSize?.fit?.(); // before the cards are drawn: the search box's height and sizes that fit (against the cards as they were)
  window.renderWidgets?.(widgets); // [widgets] newtab-widgets.js
  window.newtabSize?.fit?.(); // and once more with the cards as they are now
  if (kept && !document.activeElement?.closest?.('nav.grid .cell, nav.frequent .cell')) refocus(kept.kind, kept.index);
}

// "/" jumps to the search field, like many sites; typing in any field, textarea, select or editable area (or composing with an IME) is left alone.
document.addEventListener('keydown', (e) => {
  if (window.WidgetEdit.isSlashShortcut(e, document.activeElement)) {
    e.preventDefault();
    document.getElementById('q').focus();
  }
});

try { render(); } finally { document.documentElement.classList.add('booted'); } // (html.booted: newtab.html shows the page now that its cards, clock and sections are in place)
window.addEventListener('hashchange', () => { hiddenState = null; render(); }); // (the new page data carries the saved list)

// The field either searches with the engine chosen in settings (the hash carries { label, url
// with %s }) or asks the assistant. Asking hands the question (and any pictures in the box) to the browser through
// window.lumenNewtab.askAi (preload/newtab-preload.js; nothing goes in this page's address), which turns this tab into the
// full-page chat; the chat asks it in a new chat. Ask AI is the one way into the chat from here: with an empty box it just
// opens it (the same tab, Ctrl/Cmd+click: a new tab).
(() => {
  const form = document.querySelector('form[role=search]');
  const input = document.getElementById('q');
  const radios = [...document.querySelectorAll('#mode [role=radio]')];
  const KEY = 'lumen.home.mode';
  let mode = 'search';
  try { if (localStorage.getItem(KEY) === 'ask') mode = 'ask'; } catch {}
  // Who the box asks and which engine it searches are read from the hash each time (the browser rewrites it when
  // the user picks another model or search engine), so the label never shows what was true when the page loaded.
  const current = () => { const d = data(); return { engine: d.search, who: d.assistant?.name || 'AI', connected: !d.assistant || d.assistant.agentUsable !== false, model: d.assistant?.model || '', modelLabel: d.assistant?.label || '' }; };

  let hintTimer = null;
  const goConnect = () => { location.href = `${location.pathname}?connect-ai=1${location.hash}`; }; // the browser opens Settings > API keys and sign-ins and keeps this tab here
  document.getElementById('mode-connect')?.addEventListener('click', goConnect);
  function apply(next, { save = true, focus = false } = {}) {
    mode = next === 'ask' ? 'ask' : 'search';
    const { engine, who, connected, model, modelLabel } = current();
    const askRadio = document.getElementById('mode-ask');
    form.classList.toggle('ni-ask', mode === 'ask'); // (the attach button shows in Ask AI only)
    askRadio.dataset.model = model; // exactly which model an ask goes to
    askRadio.title = `Open chat (${MAC ? 'Shift+Cmd+L' : 'Ctrl+Shift+L'})${modelLabel ? `. Answers with ${modelLabel}.` : ''}`;
    for (const r of radios) {
      const on = r.dataset.mode === mode;
      r.setAttribute('aria-checked', String(on));
      r.tabIndex = on ? 0 : -1;
      if (on && focus) r.focus();
    }
    // Ask AI with no AI connected yet: a setup prompt, not a box that would ask nobody.
    const text = mode === 'ask' ? (connected ? `Ask ${who}…` : 'Connect an AI to ask questions') : `Search ${engine?.label || 'Google'}`;
    const setup = mode === 'ask' && !connected;
    const connect = document.getElementById('mode-connect');
    if (connect) connect.hidden = !setup;
    const hintEl = document.getElementById('mode-hint');
    if (hintEl && hintEl.dataset.base === undefined) hintEl.dataset.base = hintEl.textContent.replace('Ctrl+Enter', /^Mac/.test(navigator.platform || '') ? '⌘↩' : 'Ctrl+Enter'); // (Cmd+Enter on a Mac; Ctrl+/ really is Control there)
    if (hintEl && !hintTimer) hintEl.textContent = setup ? 'No AI is connected yet.' : hintEl.dataset.base;
    input.placeholder = text;
    input.setAttribute('aria-label', text);
    if (save) try { localStorage.setItem(KEY, mode); } catch {}
  }
  apply(mode, { save: false });
  window.addEventListener('hashchange', () => apply(mode, { save: false })); // a model or search engine was picked: the box follows at once

  // Search | Ask AI: a click picks the mode. Ask AI, when it is already the mode (or with Ctrl/Cmd held), is the chat button: it sends
  // what is typed to the full-page chat, or opens that chat when the box is empty.
  // Short notes in the hint line (images go to Ask AI, a picture that was left out), put back after a few seconds.
  const hint = document.getElementById('mode-hint');
  const say = (message, ms = 7000) => {
    if (!hint) return;
    hint.textContent = message;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintTimer = null; apply(mode, { save: false }); }, ms);
  };
  const images = window.NewtabImages.create({
    form, input, strip: document.getElementById('ni-strip'), attach: document.getElementById('ni-attach'), dropNote: document.getElementById('ni-dropnote'),
    bridge: window.lumenNewtab, say,
    toAsk: () => { if (mode === 'ask') return false; apply('ask'); return true; }, // a picture added in Search mode switches the box to Ask AI
  });
  const openChat = async (inNewTab) => {
    const q = input.value.trim().slice(0, 20000);
    if ((q || images.count()) && !current().connected) { goConnect(); return; }
    if (!window.lumenNewtab) return;
    const pictures = await images.take();
    const ok = await window.lumenNewtab.askAi({ text: q, images: pictures, inNewTab });
    if (ok && inNewTab) images.clear(); // (the pictures went with the question; this page stays, as the text does)
  };
  for (const r of radios) {
    r.addEventListener('click', (e) => {
      if (r.dataset.mode === 'ask' && (mode === 'ask' || e.ctrlKey || e.metaKey)) { openChat(e.ctrlKey || e.metaKey); return; }
      apply(r.dataset.mode); input.focus();
    });
  }
  document.getElementById('mode').addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      apply(mode === 'ask' ? 'search' : 'ask', { focus: true });
    }
  });
  input.addEventListener('keydown', (e) => {
    const toggle = (e.ctrlKey && e.key === '/') || (e.altKey && !e.ctrlKey && (e.key === 'a' || e.key === 'A'));
    if (toggle) { e.preventDefault(); apply(mode === 'ask' ? 'search' : 'ask'); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !isImeEnter(e)) { e.preventDefault(); openChat(false); } // Ctrl/Cmd+Enter asks the AI whichever mode is picked
  });

  form.addEventListener('submit', (e) => {
    const q = input.value.trim();
    if (mode === 'ask' || images.count()) { // (pictures only go to Ask AI)
      e.preventDefault();
      if (!current().connected) { goConnect(); return; }
      openChat(false); // (an empty box opens the chat itself)
      return;
    }
    const { engine } = current();
    if (!engine) return; // the form's own action (Google) handles it
    e.preventDefault();
    if (q) location.href = engine.url.replace('%s', encodeURIComponent(q));
  });
})();
