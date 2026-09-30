// New-tab page. The browser passes everything in the URL hash as JSON:
//   { favorites: [{ title, url, icon? }], frequent: [{ title, url, icon? }], blocked: number,
//     look: { background, image (a file: URL in the profile), effect, still, lite, accent: { light, dark }, clock, clockStyle, name, sections },
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
    if (Array.isArray(parsed)) return { favorites: parsed.filter(isWeb), frequent: [], blocked: null, look: lookOf(null) };
    return {
      search: parsed.search && typeof parsed.search.url === 'string' && /^https:\/\//.test(parsed.search.url) ? parsed.search : null,
      assistant: parsed.assistant && typeof parsed.assistant.name === 'string' ? parsed.assistant : null,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter(isWeb) : DEFAULTS,
      frequent: Array.isArray(parsed.frequent) ? parsed.frequent.filter(isWeb) : [],
      blocked: Number.isFinite(parsed.blocked) ? parsed.blocked : null,
      look: lookOf(parsed.look),
      widgets: Array.isArray(parsed.widgets) ? parsed.widgets : [],
    };
  } catch {
    return { favorites: DEFAULTS, frequent: [], blocked: null, look: lookOf(null) };
  }
}

// [look] The page's design from Settings → Appearance, checked field by field.
const BACKGROUNDS = ['plain', 'aurora', 'dusk', 'ocean', 'forest', 'sunset', 'graphite', 'image'];
const EFFECTS = ['particles', 'stars', 'bubbles', 'snow']; // newtab-effects.js
const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
function lookOf(l) {
  const look = l && typeof l === 'object' ? l : {};
  const image = typeof look.image === 'string' && /^file:\/\/\/[^"'()\\\s]+$/.test(look.image) ? look.image : null;
  const background = BACKGROUNDS.includes(look.background) && (look.background !== 'image' || image) ? look.background : 'plain';
  const sections = look.sections && typeof look.sections === 'object' ? look.sections : {};
  return {
    background, image,
    effect: EFFECTS.includes(look.effect) ? look.effect : 'none', still: look.still === true, lite: look.lite === true,
    effectStyle: effectStyleOf(look.effectStyle),
    accent: { light: hex(look.accent?.light), dark: hex(look.accent?.dark) },
    clock: look.clock !== false,
    clockSize: window.WidgetSystem.cleanClockSize(look.clockSize) || 'm',
    clockStyle: window.ClockStyles.clean(look.clockStyle), // [look] style, hours, seconds, date, card, shadow, greeting font
    searchWidth: window.WidgetSystem.cleanSearchWidth(look.searchWidth) || 640,
    name: typeof look.name === 'string' ? look.name.slice(0, 40) : '',
    sections: { header: sections.header !== false, favorites: sections.favorites !== false, frequent: sections.frequent !== false, privacy: sections.privacy !== false },
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
function applyLook(look) {
  currentLook = look;
  document.body.dataset.bg = look.background;
  document.body.classList.toggle('on-media', look.background !== 'plain');
  document.body.style.setProperty('--wallpaper', look.image ? `url("${look.image}")` : 'none');
  const accent = (dark.matches || look.background !== 'plain' ? look.accent.dark : look.accent.light) || null;
  const root = document.documentElement.style;
  if (accent) {
    root.setProperty('--accent', accent);
    const n = parseInt(accent.slice(1), 16);
    root.setProperty('--ring', `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, 0.3)`);
  } else { root.removeProperty('--accent'); root.removeProperty('--ring'); }
  document.getElementById('clock').hidden = !look.clock;
  applyClockStyle(look);
  window.newtabSize?.apply(look.clockSize, look.searchWidth); // [look] --clock-size / --search-w on <main>
  document.body.dataset.wpack = look.packed ? '1' : '0';
  document.body.classList.toggle('calm', look.still || look.lite); // [widgets] no wiggle or sliding with Reduce motion or Performance mode
  applyEffect(look);
  window.applyWidgetColors?.(); // [widgets] cards set to Match screen follow the accent, background and theme
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
dark.addEventListener('change', () => applyLook(currentLook));
// [widgets] what newtab-widgets.js needs to tint cards from the page's own look
window.widgetLook = () => ({
  accent: (dark.matches || currentLook.background !== 'plain' ? currentLook.accent.dark : currentLook.accent.light) || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  background: currentLook.background, dark: dark.matches, imageColors: currentLook.imageColors,
});
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
}
// Minutes only: wake every 10 s. With seconds: just after each second turns. Never draws while the tab is hidden.
let clockTimer = 0;
function scheduleClock() {
  clearTimeout(clockTimer);
  const every = currentLook.clockStyle?.seconds ? 1000 : 10000;
  clockTimer = setTimeout(() => { if (!document.hidden) tickClock(); scheduleClock(); }, every - (Date.now() % every) + 15);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickClock(); });

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
  const icon = typeof b.icon === 'string' && b.icon.startsWith('data:image/') ? b.icon : bundled;
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
  s.append(Object.assign(document.createElement('h2'), { textContent: title }), content);
  return s;
}

function favorites(list) {
  if (!list.length) {
    const p = Object.assign(document.createElement('p'), { className: 'empty' });
    p.append('Bookmark a page with ', Object.assign(document.createElement('kbd'), { textContent: 'Ctrl' }), '+', Object.assign(document.createElement('kbd'), { textContent: 'D' }), ' and it appears here.');
    return p;
  }
  const nav = Object.assign(document.createElement('nav'), { className: 'grid' });
  nav.setAttribute('aria-label', 'Favorites');
  for (const b of list.slice(0, 12)) {
    const a = document.createElement('a');
    a.href = b.url;
    a.title = `${label(b)} — ${host(b.url)}`;
    a.append(tile(b, 28), Object.assign(document.createElement('span'), { className: 'name', textContent: label(b) }));
    nav.append(a);
  }
  return nav;
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
    nav.append(a);
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

function greeting(now) {
  const h = now.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function render() {
  const { favorites: favs, frequent: freq, blocked, look, widgets } = data();
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
    favorites: part(look.sections.favorites, 'Favorites', () => favorites(favs)),
    frequent: part(look.sections.frequent && freq.length, 'Frequently Visited', () => frequent(freq)),
    privacy: part(look.sections.privacy && blocked !== null, 'Privacy', () => privacy(blocked)),
  }, { header: look.sections.header }, widgets);
  window.renderWidgets?.(widgets); // [widgets] newtab-widgets.js
}

// "/" jumps to the search field, like many sites; typing elsewhere is left alone.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    document.getElementById('q').focus();
  }
});

render();
window.addEventListener('hashchange', render);

// The field either searches with the engine chosen in settings (the hash carries { label, url
// with %s }) or asks the assistant. Asking reloads this page with ?ask=…; the browser cancels that
// navigation and hands the prompt to the sidebar, so the tab stays here.
(() => {
  const { search: engine, assistant } = data();
  const form = document.querySelector('form[role=search]');
  const input = document.getElementById('q');
  const radios = [...document.querySelectorAll('#mode [role=radio]')];
  const KEY = 'lumen.home.mode';
  const who = assistant?.name || 'Claude';
  let mode = 'search';
  try { if (localStorage.getItem(KEY) === 'ask') mode = 'ask'; } catch {}

  function apply(next, { save = true, focus = false } = {}) {
    mode = next === 'ask' ? 'ask' : 'search';
    for (const r of radios) {
      const on = r.dataset.mode === mode;
      r.setAttribute('aria-checked', String(on));
      r.tabIndex = on ? 0 : -1;
      if (on && focus) r.focus();
    }
    const text = mode === 'ask' ? `Ask ${who}…` : `Search ${engine?.label || 'Google'}`;
    input.placeholder = text;
    input.setAttribute('aria-label', text);
    if (save) try { localStorage.setItem(KEY, mode); } catch {}
  }
  apply(mode, { save: false });

  for (const r of radios) r.addEventListener('click', () => { apply(r.dataset.mode); input.focus(); });
  document.getElementById('mode').addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      apply(mode === 'ask' ? 'search' : 'ask', { focus: true });
    }
  });
  input.addEventListener('keydown', (e) => {
    const toggle = (e.ctrlKey && e.key === '/') || (e.altKey && !e.ctrlKey && (e.key === 'a' || e.key === 'A'));
    if (toggle) { e.preventDefault(); apply(mode === 'ask' ? 'search' : 'ask'); }
  });

  form.addEventListener('submit', (e) => {
    const q = input.value.trim();
    if (mode === 'ask') {
      e.preventDefault();
      if (q) location.href = `${location.pathname}?ask=${encodeURIComponent(q)}${location.hash}`;
      return;
    }
    if (!engine) return; // the form's own action (Google) handles it
    e.preventDefault();
    if (q) location.href = engine.url.replace('%s', encodeURIComponent(q));
  });
})();
