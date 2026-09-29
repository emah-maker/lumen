// New-tab page. The browser passes everything in the URL hash as JSON:
//   { favorites: [{ title, url, icon? }], frequent: [{ title, url, icon? }], blocked: number,
//     look: { background, image (a file: URL in the profile), accent: { light, dark }, clock, name, sections },
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
const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
function lookOf(l) {
  const look = l && typeof l === 'object' ? l : {};
  const image = typeof look.image === 'string' && /^file:\/\/\/[^"'()\\\s]+$/.test(look.image) ? look.image : null;
  const background = BACKGROUNDS.includes(look.background) && (look.background !== 'image' || image) ? look.background : 'plain';
  const sections = look.sections && typeof look.sections === 'object' ? look.sections : {};
  return {
    background, image,
    accent: { light: hex(look.accent?.light), dark: hex(look.accent?.dark) },
    clock: look.clock !== false,
    name: typeof look.name === 'string' ? look.name.slice(0, 40) : '',
    sections: { favorites: sections.favorites !== false, frequent: sections.frequent !== false, privacy: sections.privacy !== false },
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
}
dark.addEventListener('change', () => applyLook(currentLook));
function tickClock() {
  const el = document.getElementById('clock');
  if (!el.hidden) el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}
setInterval(() => { if (!document.hidden) tickClock(); }, 10000); // shows minutes only: no need to wake every second, or while hidden
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
  window.renderWidgets?.(widgets); // [widgets] newtab-widgets.js
  const box = document.getElementById('sections');
  box.replaceChildren();
  if (look.sections.favorites) box.append(section('Favorites', favorites(favs)));
  if (look.sections.frequent && freq.length) box.append(section('Frequently Visited', frequent(freq)));
  if (look.sections.privacy && blocked !== null) box.append(section('Privacy', privacy(blocked)));
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
