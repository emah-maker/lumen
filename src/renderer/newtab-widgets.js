// [widgets] The new-tab page's widget cards (features/widgets.js fetches their data in the browser;
// it arrives in the page's hash). Every value from the network is set with textContent, links must
// be https, and each field is checked before use. Buttons act by loading this page with
// ?widget=<id>&do=… (the browser cancels that navigation and does it), like the Ask AI box.
// Cards whose data didn't change are kept as they are, so a web page in a frame never reloads (and
// no card is ever moved in the page's DOM: newtab-widgets-grid.js places them with transforms).
// Each card is a size container: what it shows depends on the room it has (see the @container rules
// in newtab.html), so a small card shows the essentials and a big one everything.

// The marks the AI status card draws: the same set the toolbar button uses (renderer/chat-core.js), drawn here as SVG, so there are no files and nothing is fetched.
// [tint, path, rotations (the OpenAI mark is one petal turned five times), filled]
const AI_LOGOS = {
  claude: ['#d97757', 'M8 2.5v11M2.5 8h11M4.1 4.1l7.8 7.8M11.9 4.1l-7.8 7.8'],
  openai: ['', 'M8 2.4a2.8 2.8 0 0 1 2.8 2.8v3.4', [60, 120, 180, 240, 300]],
  grok: ['', 'M3.2 13.4 12.8 2.6M3.4 2.6 6.9 6.8M9.1 9.2 12.6 13.4'],
  gemini: ['#7b8cff', 'M8 1.6C8.5 5 11 7.5 14.4 8 11 8.5 8.5 11 8 14.4 7.5 11 5 8.5 1.6 8 5 7.5 7.5 5 8 1.6Z', null, true],
  antigravity: ['', 'M3 13.2 8 3.4l5 9.8M5.6 9.6h4.8M8 1.8h.01'],
  openrouter: ['', 'M2.5 8h4.5M7 8c2 0 2.5-4 5-4M7 8c2 0 2.5 4 5 4M7 8h5M13 4h.01M13 8h.01M13 12h.01'],
};
function aiLogo(brand) {
  const NS = 'http://www.w3.org/2000/svg';
  const [tint, d, turns, filled] = AI_LOGOS[brand] || ['', 'M8 2.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 8 2.8Z']; // (an unknown one: a plain ring)
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `ai-logo${filled ? ' filled' : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  if (tint) svg.style.color = tint;
  for (const deg of [0, ...(turns || [])]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    if (deg) path.setAttribute('transform', `rotate(${deg} 8 8)`);
    svg.append(path);
  }
  return svg;
}

const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};
const skyOf = (code) => (code <= 1 ? 'clear' : code === 2 ? 'partly' : code === 3 ? 'cloud' : code <= 48 ? 'fog' : code <= 57 ? 'drizzle'
  : code <= 67 || (code >= 80 && code <= 82) ? 'rain' : code <= 86 ? 'snow' : 'storm');
// Inline icons (constant markup; nothing from the network goes in them).
const CLOUD_HIGH = '<path class="cloud" d="M9.5 21h13.8a5.2 5.2 0 0 0 .6-10.4A7.2 7.2 0 0 0 10 11.6 4.7 4.7 0 0 0 9.5 21z"/>';
const SKY_ICONS = {
  clear: '<circle class="sun" cx="16" cy="16" r="6"/><path class="ray" d="M16 3.5v2.6M16 25.9v2.6M3.5 16h2.6M25.9 16h2.6M7.2 7.2l1.8 1.8M23 23l1.8 1.8M7.2 24.8 9 23M23 9l1.8-1.8"/>',
  night: '<path class="moon" d="M20.5 22.8A9 9 0 0 1 13.6 6a10 10 0 1 0 12.3 12.4 9 9 0 0 1-5.4 4.4z"/>',
  partly: '<circle class="sun" cx="12" cy="12" r="5"/><path class="ray" d="M12 2.8v1.9M2.8 12h1.9M5.5 5.5l1.3 1.3M18.5 5.5l-1.3 1.3"/><path class="cloud" d="M12.5 27h11.4a5 5 0 0 0 .6-9.96A6.6 6.6 0 0 0 12.3 18a4.5 4.5 0 0 0 .2 9z"/>',
  partlyNight: '<path class="moon" d="M15 13.8A6.5 6.5 0 0 1 10 4a7.3 7.3 0 1 0 8.9 9 6.5 6.5 0 0 1-3.9.8z"/><path class="cloud" d="M12.5 27h11.4a5 5 0 0 0 .6-9.96A6.6 6.6 0 0 0 12.3 18a4.5 4.5 0 0 0 .2 9z"/>',
  cloud: '<path class="cloud" d="M9 25h14.5a5.8 5.8 0 0 0 .7-11.6A8 8 0 0 0 9.3 14.6 5.2 5.2 0 0 0 9 25z"/>',
  fog: `${CLOUD_HIGH}<path class="fog" d="M7 24.5h18M10 28.5h13"/>`,
  drizzle: `${CLOUD_HIGH}<path class="drop" d="M12 25v1.5M17 25v1.5M22 25v1.5"/>`,
  rain: `${CLOUD_HIGH}<path class="drop" d="m12 24.5-1.2 4M17 24.5l-1.2 4M22 24.5l-1.2 4"/>`,
  snow: `${CLOUD_HIGH}<circle class="flake" cx="11.5" cy="26" r="1.3"/><circle class="flake" cx="16.5" cy="28.5" r="1.3"/><circle class="flake" cx="21.5" cy="26" r="1.3"/>`,
  storm: `${CLOUD_HIGH}<path class="bolt" d="m17.5 21.5-4.2 5.6h3.2l-1.3 4.4 4.9-6.3h-3.3l1.6-3.7z"/>`,
};
function skyIcon(code, day = true) {
  let sky = skyOf(Number.isInteger(code) ? code : 3);
  if (!day && sky === 'clear') sky = 'night';
  if (!day && sky === 'partly') sky = 'partlyNight';
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="wx-icon" viewBox="0 0 32 32" aria-hidden="true">${SKY_ICONS[sky]}</svg>`;
  return wrap.firstChild;
}
const ICON_OPEN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.6 2.2l2.2 2.2L4.2 10H2v-2.2z"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M10 6a4 4 0 1 1-1.2-2.85M9.6 1.6v2.2H7.4"/></svg>';
const ICON_LOCATE = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="2.2"/><path d="M6 .8v1.8M6 9.4v1.8M.8 6h1.8M9.4 6h1.8"/></svg>';
const ICON_REPEAT = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 5.5V5a2 2 0 0 1 2-2h5M9 1.5 10.5 3 9 4.5M10 6.5V7a2 2 0 0 1-2 2H3M3 10.5 1.5 9 3 7.5"/></svg>';

const SP_ICONS = { // Spotify card buttons (constant markup)
  prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3h1.7v10H3.5zM13 3.4v9.2L6.2 8z"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 3h1.7v10h-1.7zM3 3.4v9.2L9.8 8z"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h2.6v10H4zM9.4 3H12v10H9.4z"/></svg>',
};
const spClock = (millis) => {
  const s = Math.floor(Math.max(0, millis) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};
// Only the TradingView embed pages features/tradingview-view.js builds (a watchlist's hash is long: 8000).
const tvUrl = (u) => { if (typeof u !== 'string' || u.length >= 8000 || !/^https:\/\/[^\s"'<>\\]+$/i.test(u)) return null; try { const p = new URL(u); return p.hostname === 's.tradingview.com' && !p.port && !p.username && ['/widgetembed/', '/embed-widget/mini-symbol-overview/', '/embed-widget/market-overview/'].includes(p.pathname) ? u : null; } catch { return null; } };
const safeUrl = (u) => (typeof u === 'string' && u.length < 2000 && /^https:\/\/[^\s"'<>\\]+$/i.test(u) ? u : null);
// A github.com address (an issue, a pull request or one of its list pages), or null.
const githubUrl = (u) => (typeof u === 'string' && u.length < 300 && /^https:\/\/github\.com\/[A-Za-z0-9_./#-]{0,250}$/.test(u) ? u : null);
const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const pct = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const widgetId = (id) => (typeof id === 'string' && /^w[0-9a-z]{4,20}$/.test(id) ? id : null);
const hex6 = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);

// Ask the browser to do something for a widget (see features/widgets.js actionFrom).
function widgetAct(id, action, extra = {}) {
  const params = new URLSearchParams({ widget: id, do: action, ...extra });
  location.href = `${location.pathname}?${params}${location.hash}`;
}
window.widgetAct = widgetAct;
// Screen readers: what just happened ("Weather moved to column 9, row 2").
function announce(message) {
  let live = document.getElementById('w-live');
  if (!live) {
    live = el('div');
    live.id = 'w-live';
    live.className = 'w-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    document.body.append(live);
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = message; }, 30);
}
window.widgetAnnounce = announce;

function link(url, label, cls = 'w-link') {
  const a = el('a', cls);
  a.href = url;
  a.target = '_blank'; // opens a new tab
  a.rel = 'noopener noreferrer';
  a.append(label);
  return a;
}
function openLink(url, label, name) {
  const a = link(url, label);
  a.insertAdjacentHTML('beforeend', ICON_OPEN);
  a.setAttribute('aria-label', `${label} (opens a new tab)`);
  if (name) a.title = name;
  return a;
}
// Kinds the page can edit itself get a pencil (renderer/newtab-setup.js); the rest are edited in Settings.
// It comes from w.setup, so a card that failed to load has it too.
function openEditor(w) { const t = window.widgetSetupTarget?.(w.id); if (t) window.widgetSetup.open(t); }
function editPencil(w, title, card, always) {
  if (w.setup && window.widgetSetup?.can(w.type)) {
    const b = iconButton(ICON_EDIT, `Edit ${title}`, () => openEditor(w));
    if (always) b.classList.add('always'); // a card that failed keeps its pencil visible: that is where editing matters
    card.head.append(b);
  }
}
function iconButton(svg, label, onclick) {
  const b = el('button', 'w-icon-btn');
  b.type = 'button';
  b.innerHTML = svg;
  b.setAttribute('aria-label', label);
  b.title = label.replace(/ .*$/, '');
  b.addEventListener('click', onclick);
  return b;
}
const refreshButton = (w) => iconButton(ICON_REFRESH, `Refresh ${w.title}`, () => widgetAct(w.id, 'refresh'));

// "2:00 PM" or "14:00" from an hour (the widget's clock setting, else the system's).
function clockText(hour, minute, d) {
  const opts = { hour: 'numeric', ...(minute !== undefined ? { minute: '2-digit' } : {}) };
  if (d.clock === '12') opts.hour12 = true;
  if (d.clock === '24') { opts.hour12 = false; opts.hour = '2-digit'; }
  return new Date(2000, 0, 1, hour, minute || 0).toLocaleTimeString([], opts);
}
const hhmm = (v, d) => { const m = /^(\d{2}):(\d{2})$/.exec(v || ''); return m ? clockText(Number(m[1]), Number(m[2]), d) : ''; };
function dayName(date, i) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return '';
  if (i === 0) return 'Today';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString([], { weekday: 'short' });
}
function agoText(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60e3));
  if (min >= 1440) return `${Math.round(min / 1440)} d ago`;
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

// ---- the renderers, one per connector type ----
// A now-playing card (Spotify's Now playing mode, Apple Music's Status mode): artwork, title, artist, album, the buttons and the progress
// bar. Everything is a checked string or number set with textContent; the picture is a data: URL that main made from bytes it
// sniffed itself; the buttons ask main to press them. o: { name, openUrl(d) (a checked address or null), idleHint(d), playLabel }.
function nowPlayingCard(w, card, o) {
  const d = w.data;
    card.head.append(refreshButton(w));
    const open = o.openUrl(d);
    if (open) card.head.append(openLink(open, `Open in ${o.name}`));
    const state = d.state === 'playing' || d.state === 'paused' ? d.state : 'idle';
    card.el.classList.toggle('sp-card-idle', state === 'idle');
    if (typeof d.notice === 'string' && d.notice) card.body.append(el('p', 'w-note', d.notice.slice(0, 200)));
    const title = text(d.title, 200);
    const wrap = el('div', 'sp-wrap');
    const art = typeof d.art === 'string' && d.art.length < 200000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(d.art) ? d.art : '';
    if (art) {
      const img = document.createElement('img');
      img.className = 'sp-art';
      img.alt = '';
      img.src = art;
      wrap.append(img);
    }
    const info = el('div', 'sp-text');
    if (state === 'idle') {
      info.append(el('span', 'sp-title', 'Nothing is playing'), el('span', 'sp-artist', o.idleHint(d)));
    } else {
      info.append(el('span', 'sp-title', title), el('span', 'sp-artist', text(d.artist, 200)));
      if (text(d.album, 120)) info.append(el('span', 'sp-album', text(d.album, 120)));
    }
    wrap.append(info);
    card.body.append(wrap);
    const button = (name, label, act, cls = 'sp-btn') => {
      const b = el('button', cls);
      b.type = 'button';
      b.innerHTML = SP_ICONS[name]; // constant markup
      b.setAttribute('aria-label', label);
      b.title = label;
      b.addEventListener('click', () => widgetAct(w.id, act));
      return b;
    };
    const controls = el('div', 'sp-controls');
    if (state === 'idle') { // nothing to skip: Play resumes (Spotify on the last device, and says if there is none)
      controls.append(button('play', o.playLabel, 'play', 'sp-btn main'));
      card.body.append(controls);
      return;
    }
    const prev = button('prev', 'Previous track', 'previous');
    const next = button('next', 'Next track', 'next');
    if (d.kind === 'ad') { // Spotify refuses skipping during an ad
      for (const b of [prev, next]) { b.disabled = true; b.title = 'Not during an ad'; b.setAttribute('aria-label', `${b.getAttribute('aria-label')} (not during an ad)`); }
    }
    controls.append(prev, state === 'playing' ? button('pause', 'Pause', 'pause', 'sp-btn main') : button('play', 'Play', 'play', 'sp-btn main'), next);
    card.body.append(controls);
    if (d.kind === 'ad' && state === 'playing') setTimeout(() => { if (controls.isConnected) widgetAct(w.id, 'refresh'); }, 16000); // an ad has no length: look again when it is likely over
    // Progress: main sends where the playhead was and when; this page moves it on once a second.
    const duration = Number.isFinite(d.durationMs) && d.durationMs > 0 ? d.durationMs : 0;
    if (duration) {
      const at = Number.isFinite(d.at) ? d.at : Date.now();
      const from = Number.isFinite(d.progressMs) ? d.progressMs : 0;
      const bar = el('div', 'sp-bar');
      const fill = document.createElement('i');
      bar.append(fill);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', `${title} progress`);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const elapsed = el('span', 'sp-elapsed');
      const total = el('span', 'sp-total', spClock(duration));
      const progress = el('div', 'sp-progress');
      progress.append(elapsed, bar, total);
      card.body.append(progress);
      const draw = () => {
        const now = Math.min(duration, Math.max(0, from + (state === 'playing' ? Math.max(0, Date.now() - at) : 0)));
        elapsed.textContent = spClock(now);
        fill.style.width = `${(now / duration) * 100}%`;
        bar.setAttribute('aria-valuenow', String(Math.round((now / duration) * 100)));
        return now;
      };
      draw();
      if (state === 'playing') {
        const timer = setInterval(() => {
          if (!progress.isConnected) { clearInterval(timer); return; } // the card was redrawn or removed
          if (!document.hidden && draw() >= duration) {
            clearInterval(timer);
            // The track is over: Spotify has moved on to the next one (or stopped). Without this the card sat at the end
            // of the old song until its next scheduled refresh, up to two minutes. The later asks cover Spotify still
            // answering with the old song, or the first coming too soon after the last fetch (a Spotify card is fetched at most every 4 s).
            for (const wait of [1500, 6000, 15000]) setTimeout(() => { if (progress.isConnected) widgetAct(w.id, 'refresh'); }, wait);
          }
        }, 1000);
      }
    }
}

// A music site's own web player in the card (Spotify's Web player, Apple Music): main.js lays a native view over
// the .sp-web-slot placeholder (features/web-player.js). The page only draws the header buttons, the slot and what main
// says about the view; `name` and `site` are constants of ours.
function webPlayerCard(w, card, name, site) {
  const d = w.data;
  card.el.classList.add('sp-web');
  card.head.append(openLink(site, `Open in ${name}`));
  if (d.signedIn === false) { // the site's sign-in page can be cramped at card size: a full tab shares the same session
    const signIn = link(site, 'Open in a tab to sign in', 'w-btn primary');
    signIn.classList.add('sp-web-signin');
    card.head.append(signIn);
  }
  // What main knows about the view: it can't load (offline, the site down), or this Lumen has no Widevine, so the site
  // can't play. Say so instead of leaving a blank frame.
  const v = d.view && typeof d.view === 'object' ? d.view : {};
  const down = v.state === 'offline' || v.state === 'failed';
  if (v.drm === 'missing' && !down) {
    const note = el('p', 'w-note sp-drm', `${name} can’t play sound here yet: Lumen’s Widevine component, which protected audio needs, isn’t available. It may still be installing; if this stays, restart Lumen. You can still browse ${name}.`);
    note.setAttribute('role', 'status');
    card.body.append(note);
  }
  const slot = el('div', 'sp-web-slot', down ? '' : `Loading ${name}…`);
  slot.setAttribute('role', 'status');
  if (down) {
    slot.classList.add('sp-web-down');
    slot.append(el('span', 'sp-web-msg', v.state === 'offline' ? `Can’t reach ${name}. Check your internet connection.` : `${name} didn’t load.`));
    const retry = el('button', 'w-btn', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => widgetAct(w.id, 'reload'));
    slot.append(retry);
  }
  card.body.append(slot);
}

const WIDGET_RENDERERS = {
  weather(w, card) {
    const d = w.data;
    const show = d.show && typeof d.show === 'object' ? d.show : {};
    for (const k of ['now', 'hourly', 'daily', 'details']) if (show[k] === false) card.el.classList.add(`no-${k}`);
    card.head.append(refreshButton(w));
    const unit = d.units === 'c' ? '°C' : '°F';
    const deg = (v) => (int(v) === null ? '–' : `${int(v)}°`);
    const places = (Array.isArray(d.places) ? d.places : []).filter((p) => p && typeof p === 'object').slice(0, 6);
    if (d.ask) card.body.append(askBox(w, d));
    if (!places.length && !d.ask) card.body.append(el('p', 'w-note', text(d.hereNote, 200) || 'No place to show. Add one in Settings.'));
    const wrap = el('div', 'wx-places');
    wrap.dataset.view = d.view === 'list' || d.view === 'cycle' ? d.view : 'auto';
    const cycle = el('div', 'wx-cycle');
    const rows = el('div', 'wx-list');
    const detail = (p, i) => {
      const sec = el('div', `wx-place${i === 0 ? ' active' : ''}`);
      const label = text(p.label, 80) || 'Weather';
      sec.setAttribute('role', 'group');
      sec.setAttribute('aria-label', label);
      // One place: the card's title already says where, so the name isn't repeated inside (several places keep theirs).
      const name = el('div', 'wx-name');
      if (places.length > 1) name.append(el('span', 'wx-city', label));
      if (p.here) {
        name.append(el('span', 'wx-approx', 'approximate'));
        name.append(iconButton(ICON_LOCATE, `Update my location for ${label}`, () => widgetAct(w.id, 'locate')));
      }
      if (name.children.length) sec.append(name);
      if (typeof p.error === 'string') { sec.append(el('p', 'w-note', text(p.error, 200))); return sec; }
      const now = el('div', 'wx-now');
      const cond = WMO[p.code] || 'Weather';
      const textBox = el('div', 'wx-text');
      textBox.append(el('span', 'wx-label', cond), el('span', 'wx-range', `H ${deg(p.hi)}  L ${deg(p.lo)}`));
      const temp = el('span', 'wx-temp', deg(p.temp));
      temp.setAttribute('aria-label', `${int(p.temp)} ${unit}, ${cond}`);
      now.append(skyIcon(p.code, p.day !== false), temp, textBox);
      sec.append(now);
      // Details: only what the service gave.
      const facts = [['Feels like', int(p.feels) === null ? null : deg(p.feels)], ['Wind', int(p.wind) === null ? null : `${int(p.wind)} ${text(d.windLabel, 8)}`],
        ['Humidity', pct(p.humidity) === null ? null : `${pct(p.humidity)}%`], ['UV', Number.isFinite(p.uv) ? String(Math.round(p.uv)) : null],
        ['Rain chance', pct(p.pop) === null ? null : `${pct(p.pop)}%`], ['Sunrise', hhmm(p.sunrise, d) || null], ['Sunset', hhmm(p.sunset, d) || null]].filter((f) => f[1]);
      if (facts.length) {
        const dl = el('dl', 'wx-details');
        for (const [k, v] of facts) { const cell = el('div'); cell.append(el('dt', null, k), el('dd', null, v)); dl.append(cell); }
        sec.append(dl);
      }
      const hourly = (Array.isArray(p.hourly) ? p.hourly : []).filter((h) => h && Number.isInteger(h.hour) && h.hour >= 0 && h.hour < 24).slice(0, 24);
      if (hourly.length) {
        const strip = el('div', 'wx-hours');
        strip.setAttribute('aria-label', 'Next hours');
        for (const h of hourly) {
          const cell = el('div');
          const at = clockText(h.hour, undefined, d);
          const bar = el('i', 'wx-pop');
          if (pct(h.pop) !== null) bar.style.setProperty('--p', `${pct(h.pop)}%`);
          cell.append(el('span', null, at), skyIcon(h.code, h.day !== false), el('span', null, deg(h.temp)), bar);
          cell.setAttribute('aria-label', `${at}: ${deg(h.temp)}, ${WMO[h.code] || ''}${pct(h.pop) ? `, ${pct(h.pop)}% chance of rain` : ''}`);
          strip.append(cell);
        }
        sec.append(strip);
      }
      const days = (Array.isArray(p.daily) ? p.daily : []).filter((x) => x && typeof x.date === 'string').slice(0, 10);
      if (days.length) {
        const list = el('div', 'wx-days');
        days.forEach((x, k) => {
          const btn = el('button', 'wx-day');
          btn.type = 'button';
          btn.setAttribute('aria-expanded', 'false');
          const bar = el('span', 'wx-bar');
          const fill = el('i');
          const bx = x.bar && typeof x.bar === 'object' ? x.bar : {};
          fill.style.left = `${pct(bx.from) ?? 0}%`;
          fill.style.width = `${Math.max(4, (pct(bx.to) ?? 100) - (pct(bx.from) ?? 0))}%`;
          bar.append(fill);
          btn.append(el('span', 'wx-dn', dayName(x.date, k)), skyIcon(x.code, true), el('span', 'wx-dp', pct(x.pop) ? `${pct(x.pop)}%` : ''), el('span', 'wx-dl', deg(x.lo)), bar, el('span', 'wx-dh', deg(x.hi)));
          btn.setAttribute('aria-label', `${dayName(x.date, k)}: high ${deg(x.hi)}, low ${deg(x.lo)}, ${WMO[x.code] || ''}. Show details`);
          const more = el('div', 'wx-more');
          more.hidden = true;
          const bits = [hhmm(x.sunrise, d) && `Sunrise ${hhmm(x.sunrise, d)}`, hhmm(x.sunset, d) && `Sunset ${hhmm(x.sunset, d)}`, int(x.wind) !== null && `Wind up to ${int(x.wind)} ${text(d.windLabel, 8)}`,
            Number.isFinite(x.precip) && x.precip > 0 && `Rain ${Math.round(x.precip * 10) / 10} ${text(d.precipUnit, 4)}`].filter(Boolean);
          if (bits.length) more.append(el('p', null, bits.join(' · ')));
          const hs = el('div', 'wx-3h');
          for (const h of (Array.isArray(x.hours) ? x.hours : []).filter((y) => y && Number.isInteger(y.hour)).slice(0, 8)) {
            const c = el('div');
            c.append(el('span', null, clockText(h.hour, undefined, d)), skyIcon(h.code, h.hour >= 6 && h.hour < 20), el('span', null, deg(h.temp)));
            hs.append(c);
          }
          if (hs.children.length) more.append(hs);
          btn.addEventListener('click', () => { const open = btn.getAttribute('aria-expanded') !== 'true'; btn.setAttribute('aria-expanded', String(open)); more.hidden = !open; requestAnimationFrame(() => settleCard(btn.closest('.w-card'))); });
          list.append(btn, more);
        });
        sec.append(list);
      }
      return sec;
    };
    places.forEach((p, i) => {
      cycle.append(detail(p, i));
      const row = el('div', 'wx-row');
      const hi = el('span', 'wx-rl', `H ${deg(p.hi)}  L ${deg(p.lo)}`);
      row.append(el('span', 'wx-rc', text(p.label, 80)), typeof p.error === 'string' ? el('span', 'wx-rl', 'Unavailable') : skyIcon(p.code, p.day !== false), el('span', 'wx-rt', typeof p.error === 'string' ? '' : deg(p.temp)), hi);
      rows.append(row);
    });
    wrap.append(cycle, rows);
    if (places.length > 1) {
      // Several places: dots (and Left/Right, or a swipe) step through them when the card is small.
      const dots = el('div', 'wx-dots');
      dots.setAttribute('role', 'tablist');
      dots.setAttribute('aria-label', 'Places');
      const show = (i) => {
        const n = (i + places.length) % places.length;
        [...cycle.children].forEach((c, k) => c.classList.toggle('active', k === n));
        [...dots.children].forEach((b, k) => { b.setAttribute('aria-selected', String(k === n)); b.tabIndex = k === n ? 0 : -1; });
        wrap.dataset.i = String(n);
      };
      places.forEach((p, i) => {
        const b = el('button', 'wx-dot');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-label', text(p.label, 80) || `Place ${i + 1}`);
        b.addEventListener('click', () => show(i));
        dots.append(b);
      });
      wrap.addEventListener('keydown', (e) => {
        if (e.target.closest('.wx-days') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        show(Number(wrap.dataset.i || 0) + (e.key === 'ArrowLeft' ? -1 : 1));
        dots.children[Number(wrap.dataset.i)]?.focus();
      });
      let x0 = null;
      cycle.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
      cycle.addEventListener('pointerup', (e) => { if (x0 !== null && Math.abs(e.clientX - x0) > 48) show(Number(wrap.dataset.i || 0) + (e.clientX < x0 ? 1 : -1)); x0 = null; });
      wrap.append(dots);
      show(0);
    }
    card.body.append(wrap);
    if (typeof d.hereNote === 'string' && d.hereNote && places.length) card.body.append(el('p', 'w-note small', text(d.hereNote, 200)));
  },

  // Apple Music: music.apple.com in the card, the same kind of view as Spotify's Web player (features/apple-music-web.js).
  applemusic(w, card) {
    const d = w.data;
    if (d.mode === 'web') { webPlayerCard(w, card, 'Apple Music', 'https://music.apple.com/'); return; }
    if (d.state === 'unavailable') { // no Apple Music app to read (not installed, not allowed, not this system): say why, offer the way on
      card.head.append(refreshButton(w));
      card.el.classList.add('sp-card-idle');
      const reasons = {
        'not-installed': 'The Apple Music app isn’t installed on this computer. You can use the web player instead.',
        denied: 'Lumen isn’t allowed to control Music. Allow it in System Settings > Privacy & Security > Automation, then press refresh.',
        unsupported: 'The Apple Music status card works on Windows and macOS. Use the web player mode instead.',
      };
      const msg = el('p', 'w-note', reasons[d.reason] || 'Lumen couldn’t read what Apple Music is playing. Press refresh to try again.');
      msg.setAttribute('role', 'status');
      card.body.append(msg);
      card.body.append(link('https://music.apple.com/', 'Open the web player', 'w-btn'));
      return;
    }
    const idle = d.state !== 'playing' && d.state !== 'paused';
    nowPlayingCard(w, card, {
      name: 'Apple Music', playLabel: 'Play in Apple Music', openUrl: () => null,
      idleHint: () => (text(d.reason, 20) === 'not-running' ? 'Open Apple Music and press play' : 'Press play in Apple Music'),
    });
    if (idle) { // nothing playing: a way to start the app
      const open = el('button', 'w-btn sp-open', 'Open Apple Music');
      open.type = 'button';
      open.addEventListener('click', () => widgetAct(w.id, 'open'));
      card.body.append(open);
    }
  },

  // Now playing. Everything is a checked string or number set with textContent; the album picture is a
  // data: URL that main made from bytes it sniffed itself; the buttons ask main to call Spotify.
  spotify(w, card) {
    const d = w.data;
    if (d.mode === 'web') { webPlayerCard(w, card, 'Spotify', 'https://open.spotify.com/'); return; } // Spotify's own site: main.js lays a view over .sp-web-slot (features/spotify-web.js)
    nowPlayingCard(w, card, {
      name: 'Spotify', playLabel: 'Play on Spotify',
      openUrl: (x) => (typeof x.url === 'string' && /^https:\/\/open\.spotify\.com\/[\w/?=&.-]{1,200}$/.test(x.url) ? x.url : null),
      idleHint: (x) => (text(x.device, 60) ? `${text(x.device, 60)} is ready` : 'Start Spotify on any device'),
    });
  },

  // GitHub: unread notifications and review requests as numbers on a small card; the lists on a bigger one.
  // Everything comes from features/github-view.js already checked, and is checked again here.
  github(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const open = githubUrl(d.open);
    if (open) card.head.append(openLink(open, 'Open GitHub'));
    const listOf = (v) => {
      if (!v || typeof v !== 'object') return null;
      if (typeof v.error === 'string' && v.error) return { error: text(v.error, 200) };
      const items = (Array.isArray(v.items) ? v.items : []).filter((it) => it && typeof it.title === 'string' && githubUrl(it.url)).slice(0, 20);
      return { items, total: Math.max(items.length, int(v.total) || 0), partial: v.partial === true };
    };
    const reviews = listOf(d.reviews);
    const assigned = listOf(d.assigned);
    const notif = d.notifications && typeof d.notifications === 'object' ? d.notifications : null;
    const unread = notif && !notif.error && int(notif.count) !== null ? { n: int(notif.count), label: /^\d{1,4}\+?$/.test(notif.label) ? notif.label : String(int(notif.count)) } : null;
    const stat = (n, label, href) => {
      const box = href ? link(href, '', 'gh-stat') : el('span', 'gh-stat');
      box.append(el('span', 'gh-num', n), el('span', 'gh-of', label));
      return box;
    };
    // Small: the numbers.
    const small = el('div', 'gh-summary');
    if (unread) small.append(stat(unread.label, unread.n === 1 ? 'unread notification' : 'unread notifications', githubUrl(d.openNotifications)));
    if (reviews && !reviews.error) small.append(stat(String(reviews.total), reviews.total === 1 ? 'review requested' : 'reviews requested', githubUrl(d.openReviews)));
    if (assigned && !assigned.error) small.append(stat(String(assigned.total), 'assigned to you', githubUrl(d.openAssigned)));
    if (!small.children.length) small.append(el('span', 'gh-of', 'Nothing to show.'));
    card.body.append(small);
    // Bigger: the counts in one line and the lists.
    const full = el('div', 'gh-full');
    if (notif) {
      const line = el('p', 'gh-unread');
      if (unread) {
        const a = link(githubUrl(d.openNotifications) || 'https://github.com/notifications', `${unread.label} unread notification${unread.n === 1 ? '' : 's'}`, 'w-link');
        line.append(a);
      } else {
        line.classList.add('w-note');
        line.append(text(notif.error, 200) || 'Notifications aren’t available.');
      }
      full.append(line);
    }
    const now = Date.now();
    const since = (ms) => {
      if (!Number.isFinite(ms) || ms > now) return '';
      const min = Math.round((now - ms) / 60e3);
      return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
    };
    const section = (heading, data, moreUrl, empty) => {
      if (!data) return;
      const wrap = el('div', 'gh-section');
      wrap.append(el('div', 'w-day', data.error ? heading : `${heading} · ${data.total}`));
      if (data.error) { wrap.append(el('p', 'w-note', data.error)); full.append(wrap); return; }
      if (!data.items.length) wrap.append(el('p', 'w-empty', empty));
      const list = el('div', 'w-list');
      for (const it of data.items) {
        const row = el('div', 'w-row');
        const pr = it.kind === 'pr';
        const mark = el('span', `gh-kind ${pr ? 'pr' : 'issue'}${it.draft ? ' draft' : ''}`, pr ? (it.draft ? 'Draft' : 'PR') : 'Issue');
        const main = el('div', 'w-main');
        main.append(link(githubUrl(it.url), text(it.title) || 'Untitled', ''));
        const meta = el('div', 'gh-meta');
        meta.append(el('span', 'gh-repo', `${text(it.repo, 120)}#${int(it.number) ?? ''}`));
        if (typeof it.author === 'string' && it.author) meta.append(el('span', null, text(it.author, 40)));
        const ago = since(it.updated);
        if (ago) meta.append(el('span', null, ago));
        main.append(meta);
        row.append(mark, main);
        list.append(row);
      }
      wrap.append(list);
      if (data.total > data.items.length) {
        const more = el('p', 'w-more');
        const href = githubUrl(moreUrl);
        if (href) more.append(link(href, `${data.total - data.items.length} more on GitHub`, 'w-link')); else more.append(`${data.total - data.items.length} more`);
        wrap.append(more);
      }
      full.append(wrap);
    };
    section('Review requests', reviews, d.openReviews, 'No reviews waiting on you.');
    section('Assigned to you', assigned, d.openAssigned, 'Nothing assigned to you.');
    card.body.append(full);
  },

  worldclock(w, card) {
    const d = w.data;
    const WCK = window.WorldClock;
    card.head.append(refreshButton(w));
    const show = d.show && typeof d.show === 'object' ? d.show : {};
    const opts = { clock: ['12', '24'].includes(d.clock) ? d.clock : 'auto', seconds: d.seconds === true };
    const places = (Array.isArray(d.places) ? d.places : []).map((p) => (p && typeof p === 'object' ? { label: text(p.label, 40), name: text(p.name, 80), tz: WCK?.cleanTz(p.tz), days: Array.isArray(p.days) ? p.days.slice(0, 3) : [] } : null)).filter((p) => p && p.tz).slice(0, 8);
    if (!places.length) { card.body.append(el('p', 'w-note', 'No places to show. Add one in Settings.')); return; }
    const list = el('div', 'wc-list');
    for (const p of places) {
      const row = el('div', 'wc-row');
      row.title = p.name;
      const icon = el('span', 'wc-icon');
      const main = el('div', 'wc-main');
      main.append(el('span', 'wc-city', p.label || p.name));
      const sub = el('span', 'wc-sub');
      if (show.date !== false) sub.append(el('span', 'wc-date'));
      if (show.offset !== false) sub.append(el('span', 'wc-off'));
      main.append(sub);
      const sun = el('span', 'wc-sun');
      const time = el('span', 'wc-time');
      row.append(icon, main, time);
      if (show.sun !== false) { row.append(sun); row.classList.add('has-sun'); }
      list.append(row);
      clockRows.set(row, { tz: p.tz, days: p.days, opts, icon, time, date: sub.querySelector('.wc-date'), off: sub.querySelector('.wc-off'), sun: show.sun !== false ? sun : null, sunKey: '', dayKey: '', born: Date.now(), seen: false });
    }
    card.body.append(list);
    tickClocks();
    // The time is never shrunk or scrolled: when the card is short the last places are hidden instead.
    const fit = () => fitClockRows(card.body, list);
    if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(card.body);
    requestAnimationFrame(fit);
  },

  todoist(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const open = safeUrl(d.open);
    if (open) card.head.append(openLink(open, 'Open Todoist'));
    card.el.classList.toggle('dense', d.density === 'compact');
    const groups = (Array.isArray(d.groups) ? d.groups : []).map((g) => ({ label: text(g?.label, 80), more: int(g?.more) || 0, tasks: (Array.isArray(g?.tasks) ? g.tasks : []).filter((t) => t && typeof t.id === 'string' && /^[\w-]{1,40}$/.test(t.id)) })).filter((g) => g.tasks.length);
    const shown = groups.reduce((n, g) => n + g.tasks.length, 0);
    const total = int(d.total) ?? shown;
    if (d.showCount && card.h2) card.h2.textContent = `${text(w.title, 60)} · ${total}`;
    if (typeof d.notice === 'string' && d.notice) card.body.append(el('p', 'w-note', d.notice.slice(0, 200)));
    const today = new Date();
    const quick = d.quick === 'top' || d.quick === 'bottom' ? d.quick : 'off';
    const adder = () => {
      const box = el('div', 'td-add');
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 300;
      input.placeholder = 'Add a task… (“Pay rent tomorrow 9am”)';
      input.setAttribute('aria-label', `Add a task to ${text(w.title, 60)}`);
      const go = () => { const v = input.value.trim(); if (v) { input.disabled = true; widgetAct(w.id, 'add', { text: v }); } };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } e.stopPropagation(); });
      const btn = el('button', 'w-btn', 'Add');
      btn.type = 'button';
      btn.addEventListener('click', go);
      box.append(input, btn);
      return box;
    };
    // Small: how many, and the next one.
    const first = groups[0]?.tasks[0];
    const small = el('div', 'td-summary');
    small.append(el('span', 'td-count', String(total)), el('span', 'td-of', total === 1 ? 'task' : 'tasks'));
    if (first) small.append(el('span', 'td-next', text(first.title)));
    else small.append(el('span', 'td-next', 'Nothing due. Enjoy it.'));
    card.body.append(small);
    const full = el('div', 'td-full');
    if (quick === 'top') full.append(adder());
    if (!groups.length) full.append(el('p', 'w-empty', 'Nothing here. Enjoy it.'));
    const list = el('div', 'w-list');
    for (const g of groups) {
      if (g.label) list.append(el('div', 'w-day', g.label));
      for (const t of g.tasks) {
        const row = el('div', 'w-row');
        const check = el('button', 'w-check');
        check.type = 'button';
        check.setAttribute('role', 'checkbox');
        check.setAttribute('aria-checked', 'false');
        check.dataset.p = String([1, 2, 3, 4].includes(t.priority) ? t.priority : 1);
        const title = text(t.title) || 'Untitled task';
        check.setAttribute('aria-label', `Complete “${title}”`);
        check.addEventListener('click', () => {
          if (check.getAttribute('aria-checked') === 'true') return;
          check.setAttribute('aria-checked', 'true');
          row.classList.add('done');
          setTimeout(() => widgetAct(w.id, 'complete', { task: t.id }), 220);
        });
        const main = el('div', 'w-main');
        const url = safeUrl(t.url);
        main.append(url ? link(url, title, '') : el('span', 'w-title', title));
        const due = dueText(t, today);
        const meta = el('div', 'td-meta');
        if (due) meta.append(el('span', `w-sub${t.overdue && d.overdueRed !== false ? ' late' : ''}`, due));
        if (t.recurring) { const r = el('span', 'td-rec'); r.innerHTML = ICON_REPEAT; r.title = 'Repeats'; r.setAttribute('aria-label', 'Repeats'); meta.append(r); }
        if (t.project && typeof t.project === 'object') {
          const p = el('span', 'td-proj');
          const dot = el('i');
          const color = hex6(t.project.color);
          if (color) dot.style.background = color;
          p.append(dot, text(t.project.name, 60));
          meta.append(p);
        }
        for (const l of (Array.isArray(t.labels) ? t.labels : []).slice(0, 3)) meta.append(el('span', 'td-label', `@${text(l, 40)}`));
        if (int(t.subtasks) > 0) meta.append(el('span', 'td-sub', `${int(t.subtasks)} subtask${int(t.subtasks) === 1 ? '' : 's'}`));
        if (meta.children.length) main.append(meta);
        if (t.description) main.append(el('span', 'td-desc', text(t.description, 120)));
        row.append(check, main);
        list.append(row);
      }
      if (g.more > 0) list.append(el('p', 'w-more', `${g.more} more`));
    }
    full.append(list);
    if (total > shown) full.append(el('p', 'w-more', `${total - shown} more in Todoist`));
    const done = (Array.isArray(d.done) ? d.done : []).filter((x) => x && typeof x.title === 'string').slice(0, 10);
    if (done.length) {
      const sec = el('div', 'td-done');
      sec.append(el('div', 'w-day', 'Completed today'));
      for (const x of done) sec.append(el('div', 'td-done-row', text(x.title)));
      full.append(sec);
    }
    if (quick === 'bottom') full.append(adder());
    card.body.append(full);
    if (d.undo && typeof d.undo.id === 'string' && /^[\w-]{1,40}$/.test(d.undo.id)) {
      const toast = el('div', 'td-toast');
      toast.setAttribute('role', 'status');
      toast.append(el('span', null, `Completed “${text(d.undo.title, 60)}”`));
      const undo = el('button', 'w-btn', 'Undo');
      undo.type = 'button';
      undo.addEventListener('click', () => widgetAct(w.id, 'undo', { task: d.undo.id }));
      toast.append(undo);
      card.body.append(toast);
    }
  },

  // Calendar: one or several calendars as one agenda (features/widgets.js sends d.events soonest first, each with
  // the id of its calendar when there are several, and d.cals: { id, name, color, ok, error?, stale? }). With several,
  // every event has a colour dot (named for screen readers; the name shows too where there is room) and a legend of
  // switches under the title hides a calendar on this card. Which are hidden is remembered per card on this computer.
  calendar(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const cals = (Array.isArray(d.cals) ? d.cals : []).filter((c) => c && typeof c.id === 'string' && /^c[0-9a-z]{1,12}$/.test(c.id)).slice(0, 8)
      .map((c) => ({ id: c.id, name: text(c.name, 60) || 'Calendar', color: hex6(c.color) || '', error: text(c.error, 160), stale: c.stale === true }));
    const multi = d.multi === true && cals.length > 1;
    const byId = new Map(cals.map((c) => [c.id, c]));
    const hideKey = 'lumen.calendar.hidden.' + w.id;
    const hidden = new Set();
    if (multi) {
      try { for (const id of JSON.parse(localStorage.getItem(hideKey) || '[]')) if (byId.has(id)) hidden.add(id); } catch { /* private window: all shown */ }
      if (hidden.size >= cals.length) hidden.clear(); // never a card with nothing it can show
    }
    const remember = () => { try { if (hidden.size) localStorage.setItem(hideKey, JSON.stringify([...hidden])); else localStorage.removeItem(hideKey); } catch { /* it is just not remembered */ } };
    const dot = (c, cls) => {
      const span = el('span', 'cal-dot' + (cls ? ' ' + cls : ''));
      if (c.color) span.style.setProperty('--cal', c.color);
      return span;
    };
    const drawEvents = (events) => {
      const now = Date.now();
      const shown = events.filter((e) => !(multi && hidden.has(e.cal)));
      if (!shown.length) {
        const all = multi && hidden.size >= cals.length;
        return el('p', 'w-empty', all ? 'All calendars are hidden. Turn one back on above.' : multi && hidden.size ? 'Nothing coming up in the calendars that are showing.' : 'Nothing coming up in the next two weeks.');
      }
      const list = el('div', 'w-list');
      let lastDay = '';
      let dayIdx = -1;
      shown.forEach((e, i) => {
        const start = e.allDay && /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? new Date(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10)) : new Date(e.start);
        const day = dayLabel(e.allDay && start < new Date(new Date().setHours(0, 0, 0, 0)) ? new Date() : start); // a multi-day event that began earlier
        if (day !== lastDay) { const dl = el('div', 'w-day', day); if (i > 0) dl.classList.add('later'); if (day === 'Today') dl.classList.add('today-label'); list.append(dl); lastDay = day; dayIdx++; }
        const row = el('div', 'w-row');
        row.dataset.c = String(dayIdx % 3);
        if (day === 'Today') row.classList.add('today');
        const cal = multi ? byId.get(e.cal) : null;
        const evColor = (cal && cal.color) || hex6(e.color) || hex6(d.color); // the calendar's colour; else the feed's own (used when the card's Colors setting is "Calendar colors")
        if (evColor) row.style.setProperty('--ev', evColor);
        if (i > 0) row.classList.add('later');
        if (i > 2) row.classList.add('far');
        const time = e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const main = el('div', 'w-main');
        const title = text(e.title) || 'Busy';
        const url = safeUrl(e.url);
        main.append(url ? link(url, title, '') : el('span', 'w-title', title));
        const where = text(e.location, 200);
        const until = !e.allDay && e.start <= now ? 'Now · until ' + new Date(e.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        if (until || where) main.append(el('span', 'w-sub', [until, where].filter(Boolean).join(' · ')));
        row.append(el('span', 'w-bar'), el('span', 'w-time', time), main);
        if (cal) {
          const mark = dot(cal, 'cal-row-dot');
          mark.setAttribute('role', 'img');
          mark.setAttribute('aria-label', 'Calendar: ' + cal.name);
          mark.title = cal.name;
          main.append(el('span', 'cal-name', cal.name));
          row.append(mark);
        }
        list.append(row);
      });
      return list;
    };
    const events = (Array.isArray(d.events) ? d.events : []).filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end) && (e.allDay || e.end > Date.now()));
    const draw = (focusId) => {
      const nodes = [];
      if (multi) {
        const legend = el('div', 'cal-legend');
        legend.setAttribute('role', 'group');
        legend.setAttribute('aria-label', 'Calendars on this card');
        for (const c of cals) {
          const on = !hidden.has(c.id);
          const chip = el('button', 'cal-chip');
          chip.type = 'button';
          chip.dataset.cal = c.id;
          chip.setAttribute('aria-pressed', String(on));
          chip.setAttribute('aria-label', c.name + (c.error ? (c.stale ? ', could not update, showing earlier events' : ', could not be read') : '') + (on ? ', shown' : ', hidden'));
          chip.title = on ? 'Hide ' + c.name : 'Show ' + c.name;
          chip.append(dot(c), el('span', 'cal-chip-name', c.name));
          chip.addEventListener('click', () => {
            if (on && hidden.size >= cals.length - 1) { announce('At least one calendar stays on.'); return; }
            if (on) hidden.add(c.id); else hidden.delete(c.id);
            remember();
            announce(c.name + (on ? ' hidden' : ' shown'));
            draw(c.id);
          });
          legend.append(chip);
        }
        nodes.push(legend);
      }
      nodes.push(drawEvents(events));
      for (const c of cals) {
        if (!c.error) continue;
        const warn = el('p', 'w-note small cal-warn', c.name + ': ' + c.error + (c.stale ? ' Showing what it had before.' : ''));
        nodes.push(warn);
      }
      card.body.replaceChildren(...nodes);
      if (focusId) card.body.querySelector('.cal-chip[data-cal="' + focusId + '"]')?.focus();
    };
    draw();
  },

  // Gmail (read-only): only text from the API arrives here, and it is set with textContent. The
  // message links are https://mail.google.com addresses built by the browser from a checked id.
  gmail(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    if (d.state === 'reconnect') {
      const note = el('p', 'w-note');
      note.append(el('strong', null, 'Gmail needs to be connected'), text(d.message, 200) || 'Connect Gmail in Settings.');
      // oneClick: Lumen can start Google's sign-in (in the user's browser) straight from the card;
      // otherwise the button opens Settings, where the user's own Google Cloud client is set up.
      const oneClick = d.oneClick === true;
      const fix = el('button', 'w-btn primary', oneClick ? 'Sign in with Google' : 'Open Settings');
      fix.type = 'button';
      fix.setAttribute('aria-label', oneClick ? `Sign in with Google for ${text(w.title, 60)}` : `Open settings to reconnect ${text(w.title, 60)}`);
      fix.addEventListener('click', () => widgetAct(w.id, oneClick ? 'signin' : 'configure'));
      const wrap = el('div');
      wrap.append(fix);
      card.body.append(note, wrap);
      return;
    }
    const open = safeUrl(d.open);
    if (open && /^https:\/\/mail\.google\.com\//.test(open)) card.head.append(openLink(open, 'Open Gmail'));
    const unread = int(d.unread) ?? 0;
    const head = el('div', 'gm-head');
    head.append(el('span', 'gm-count', String(unread)), el('span', 'gm-of', 'unread'));
    card.body.append(head);
    const messages = (Array.isArray(d.messages) ? d.messages : []).filter((m) => m && typeof m.id === 'string' && /^[0-9a-f]{6,32}$/i.test(m.id)).slice(0, 10);
    if (!messages.length) { card.body.append(el('p', 'w-empty', 'The inbox is empty.')); return; }
    const list = el('div', 'w-list');
    messages.forEach((m, i) => {
      const row = el('div', `w-row gm-row${m.unread ? ' unread' : ''}${i > 0 ? ' later' : ''}`);
      const main = el('div', 'w-main');
      const subject = text(m.subject, 200) || '(no subject)';
      const a = link(`https://mail.google.com/mail/u/0/#inbox/${m.id}`, subject, '');
      main.append(el('span', 'gm-from', text(m.from, 100) || 'Unknown sender'), a);
      if (m.snippet) main.append(el('span', 'gm-snip', text(m.snippet, 160)));
      row.append(main);
      if (Number.isFinite(m.at) && m.at > 0) row.append(el('span', 'gm-when', gmailWhen(m.at)));
      list.append(row);
    });
    card.body.append(list);
  },

  feed(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const source = text(d.source, 80) || text(w.title, 80);
    const items = (Array.isArray(d.items) ? d.items : []).filter((i) => i && text(i.title)).slice(0, 12);
    if (!items.length) { card.body.append(el('p', 'w-empty', 'No headlines right now.')); return; }
    const list = el('div', 'w-list');
    items.forEach((i, n) => {
      const row = el('div', 'w-row feed-row');
      if (n > 2) row.classList.add('far');
      if (n > 0) row.classList.add('later');
      const main = el('div', 'w-main');
      const title = text(i.title, 200);
      const url = safeUrl(i.url);
      main.append(url ? link(url, title, '') : el('span', 'w-title', title));
      const when = Number.isFinite(i.time) && i.time > 0 ? agoText(i.time) : '';
      main.append(el('span', 'w-sub', [source, when].filter(Boolean).join(' · ')));
      row.append(main);
      list.append(row);
    });
    card.body.append(list);
  },

  slack(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const home = safeUrl(d.teamUrl);
    if (home && !d.reconnect) card.head.append(openLink(home, 'Open Slack'));
    // Slack refused the stored sign-in: say so, and the button opens this card's settings to sign in again.
    if (d.reconnect) {
      const box = el('div', 'sl-reconnect');
      box.append(el('p', 'w-note', `Slack needs you to reconnect. ${text(d.reason, 160)}`.trim()));
      const btn = el('button', 'w-btn primary', 'Reconnect');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Reconnect ${text(w.title, 60)} in Settings`);
      btn.addEventListener('click', () => widgetAct(w.id, 'configure'));
      box.append(btn);
      card.body.append(box);
      return;
    }
    if (typeof d.notice === 'string' && d.notice) card.body.append(el('p', 'w-note', d.notice.slice(0, 200)));
    const unread = int(d.unread) || 0;
    const mentions = int(d.mentions) || 0;
    const showDms = d.showDms !== false;
    const showMentions = d.showMentions !== false && (int(d.channelCount) || 0) > 0;
    const counts = el('div', 'sl-counts');
    const count = (n, label) => { const c = el('div', 'sl-count'); c.append(el('span', 'sl-n', String(n)), el('span', 'sl-of', label)); return c; };
    if (showDms) counts.append(count(unread, unread === 1 ? 'unread DM' : 'unread DMs'));
    if (showMentions) counts.append(count(mentions, mentions === 1 ? 'mention' : 'mentions'));
    const messages = (Array.isArray(d.messages) ? d.messages : []).filter((m) => m && typeof m === 'object').slice(0, 10);
    // Small: the counts and the newest message.
    const small = el('div', 'sl-summary');
    small.append(counts.cloneNode(true));
    if (messages[0]) small.append(el('span', 'sl-next', `${text(messages[0].from, 60)}: ${text(messages[0].text, 140)}`));
    else small.append(el('span', 'sl-next', 'All caught up.'));
    card.body.append(small);
    const full = el('div', 'sl-full');
    if (counts.children.length) full.append(counts);
    const chats = (Array.isArray(d.dmChats) ? d.dmChats : []).filter((c) => c && typeof c.name === 'string').slice(0, 5);
    if (showDms && chats.length) {
      full.append(el('div', 'w-day', 'Unread'));
      const cl = el('div', 'sl-chats');
      for (const c of chats) { const r = el('span', 'sl-chat', `${text(c.name, 40)} · ${int(c.unread) || 0}`); cl.append(r); }
      full.append(cl);
    }
    if (!messages.length) full.append(el('p', 'w-empty', showDms || (int(d.channelCount) || 0) ? 'Nothing new.' : 'Pick channels or turn on DMs in Settings.'));
    const list = el('div', 'w-list');
    for (const m of messages) {
      const row = el('div', `w-row${m.unread ? ' unread' : ''}`);
      const main = el('div', 'w-main');
      const line = `${text(m.from, 60)}: ${text(m.text, 160)}`;
      const url = safeUrl(m.url);
      main.append(url ? link(url, line, '') : el('span', 'w-title', line));
      const when = Number.isFinite(m.ts) && m.ts > 0 ? agoText(m.ts) : '';
      main.append(el('span', 'w-sub', [text(m.where, 60), when].filter(Boolean).join(' · ')));
      row.append(main);
      list.append(row);
    }
    full.append(list);
    card.body.append(full);
  },

  // Muse (Meta's model): the saved prompt's answer, its sources (https links only), and a field for one
  // question. Everything from the network is text (textContent), split into paragraphs.
  muse(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const paragraphs = (v) => (typeof v === 'string' ? v.slice(0, 6000).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 40) : []);
    const sourcesOf = (list) => (Array.isArray(list) ? list : []).slice(0, 8).map((s) => ({ url: safeUrl(s?.url), title: text(s?.title, 120) })).filter((s) => s.url);
    const drawAnswer = (parent, answer, sources, cls) => {
      const box = el('div', cls);
      for (const p of paragraphs(answer)) box.append(el('p', 'mu-p', p));
      const links = sourcesOf(sources);
      if (links.length) {
        const list = el('ul', 'mu-sources');
        list.setAttribute('aria-label', 'Sources');
        for (const s of links) {
          const li = el('li');
          li.append(link(s.url, s.title || s.url));
          list.append(li);
        }
        box.append(list);
      }
      parent.append(box);
    };
    const wrap = el('div', 'mu-wrap');
    if (typeof d.notice === 'string' && d.notice) wrap.append(el('p', 'w-note', text(d.notice, 200)));
    drawAnswer(wrap, d.answer, d.sources, 'mu-answer');
    if (!paragraphs(d.answer).length) wrap.append(el('p', 'w-empty', 'Nothing yet.'));
    if (d.asked && typeof d.asked === 'object') {
      wrap.append(el('div', 'w-day', text(d.asked.question, 500)));
      drawAnswer(wrap, d.asked.answer, d.asked.sources, 'mu-asked');
    }
    const box = el('div', 'mu-ask');
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Ask Muse…';
    input.setAttribute('aria-label', `Ask Muse a question in ${text(w.title, 60)}`);
    const go = () => { const v = input.value.trim(); if (v) { input.disabled = true; btn.disabled = true; btn.textContent = 'Asking…'; widgetAct(w.id, 'ask', { text: v.slice(0, 500) }); } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } e.stopPropagation(); });
    const btn = el('button', 'w-btn', 'Ask');
    btn.type = 'button';
    btn.addEventListener('click', go);
    box.append(input, btn);
    card.body.append(wrap, box);
    card.el.classList.add('muse-card');
  },
  stocks: (w, card) => marketCard(w, card),
  crypto: (w, card) => marketCard(w, card),

  // TradingView's own chart in a sandboxed frame (features/tradingview-view.js makes both addresses).
  tradingview(w, card) {
    const d = w.data;
    const symbol = text(d.symbol, 60) || 'Chart';
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    // A wallpaper or video background makes every card dark whatever the system scheme says (newtab.js does the same for the accent).
    const isDark = () => d.theme === 'dark' || (d.theme !== 'light' && (scheme.matches || document.body.classList.contains('on-media')));
    const url = tvUrl(isDark() ? d.dark : d.light);
    const list = d.view === 'watchlist';
    if (!url) { card.body.append(el('p', 'w-note', list ? 'This watchlist can’t be shown.' : 'This chart can’t be shown.')); return; }
    if (list) card.head.append(openLink('https://www.tradingview.com/chart/', 'Open', 'Your watchlist on TradingView'));
    else card.head.append(openLink(`https://www.tradingview.com/symbols/${encodeURIComponent(symbol.replace(':', '-'))}/`, 'Open', `${symbol} on TradingView`));
    card.el.classList.add('embed', 'tradingview');
    if (list) card.el.classList.add('tv-watchlist');
    if (text(d.note, 200)) card.body.append(el('p', 'w-note tv-note', text(d.note, 200)));
    const frame = document.createElement('iframe');
    frame.className = 'w-frame';
    // No top navigation and no Lumen privileges; popups (TradingView's own links) open as tabs.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.referrerPolicy = 'no-referrer';
    frame.loading = 'lazy';
    frame.title = list ? `${text(d.name, 60) || 'Watchlist'} from TradingView` : `${symbol} chart from TradingView`;
    // The frame sits in a box that clips and positions it, so a small card can swap what TradingView shows
    // and shrink it to fit (features/tradingview-fit.js: the full chart is all toolbar below ~300 x 230, the
    // mini price view clips below ~190 x 104, a watchlist's tab row eats 45 px). The address is set once the
    // box has a size, so a small card never loads the big view first and reloads.
    const wrap = el('div', 'tv-fit');
    wrap.append(frame);
    card.body.append(wrap);
    const fit = globalThis.TradingViewFit;
    // Interval picker (the pick is saved as the widget's Interval): the full chart takes the bar size in its address, the
    // mini and watchlist views a date range in their options (the nearest one, as features/tradingview-view.js does).
    const TV_STEPS = [['1', '1m'], ['5', '5m'], ['15', '15m'], ['30', '30m'], ['60', '1h'], ['240', '4h'], ['D', '1D'], ['W', '1W'], ['M', '1M']];
    const TV_RANGE = { 1: '1D', 5: '1D', 15: '1D', 30: '1D', 60: '1D', 240: '1M', D: '1M', W: '12M', M: '60M' };
    let picked = ''; // set once the menu is used; until then the addresses already carry the stored interval
    const withInterval = (u) => {
      if (!u || !picked) return u;
      try {
        const x = new URL(u);
        if (x.pathname === '/widgetembed/') x.searchParams.set('interval', picked);
        else { const o = JSON.parse(decodeURIComponent(x.hash.slice(1))); o.dateRange = TV_RANGE[picked]; x.hash = encodeURIComponent(JSON.stringify(o)); }
        return tvUrl(x.href) || u;
      } catch { return u; }
    };
    const pickUrl = (full) => withInterval(tvUrl(isDark() ? (full ? d.dark : d.compactDark) : (full ? d.light : d.compactLight)));
    let small = pickUrl(false); // none in data from before compact views existed
    let src0 = pickUrl(true) || url;
    let shown = '';
    let was = null;
    // The embeds read their options from the hash, and a change to only the hash is a same-page jump the frame never reloads for
    // (the other theme's address differs from this one only there): go through a blank page so the widget starts over.
    const load = (src) => {
      const same = (() => { try { const a = new URL(frame.src); const b = new URL(src); a.hash = ''; b.hash = ''; return frame.src && a.href === b.href; } catch { return false; } })();
      if (!same) { frame.src = src; return; }
      frame.addEventListener('load', () => { if (shown === src) frame.src = src; }, { once: true });
      frame.src = 'about:blank';
    };
    const place = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const next = fit ? fit.plan({ view: d.view, sections: d.sections, chart: d.chart === true }, w, h, was, Boolean(small)) : (w > 0 && h > 0 ? { compact: false, scale: 1 } : null);
      if (!next) return; // not laid out yet (a card in a stack that isn't showing): the observer calls again
      const src = next.compact && small ? small : src0;
      // TradingView's embed-widget pages (mini price view, watchlist) are see-through (isTransparent) and sit on the card; only the full chart paints its own background.
      frame.classList.toggle('tv-clear', src.includes('/embed-widget/'));
      if (src !== shown) { shown = src; load(src); }
      if (next.scale < 1) { frame.style.width = `${Math.round(w / next.scale)}px`; frame.style.height = `${Math.round(h / next.scale)}px`; frame.style.transform = `scale(${next.scale})`; }
      else { frame.style.width = ''; frame.style.height = ''; frame.style.transform = ''; }
      was = next;
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(wrap);
    else frame.src = url;
    // The system scheme (which the in-app dark setting drives) or the page's background changed: load the other theme's address.
    const restyle = () => {
      if (!frame.isConnected) return;
      const next = pickUrl(true) || src0;
      if (next === src0) return;
      src0 = next;
      small = pickUrl(false);
      if (shown) place(); else frame.src = src0;
    };
    scheme.addEventListener('change', restyle);
    new MutationObserver(restyle).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const menu = document.createElement('select');
    menu.className = 'tv-interval';
    menu.title = list || d.view === 'mini' ? 'Time range' : 'Chart interval';
    menu.setAttribute('aria-label', menu.title);
    const start = TV_STEPS.some(([v]) => v === String(d.interval)) ? String(d.interval) : 'D';
    for (const [v, label] of TV_STEPS) { const o = el('option', '', label); o.value = v; menu.append(o); }
    menu.value = start;
    menu.addEventListener('change', () => {
      picked = menu.value;
      widgetAct(w.id, 'tvinterval', { arg: picked }); // stored as the widget's Interval (the same one Settings edits)
      src0 = pickUrl(true) || src0;
      small = pickUrl(false);
      shown = '';
      place();
    });
    card.head.append(menu);
  },

  // Custom recipes (features/custom-widget.js): plain strings only, as numbers or a list.
  custom(w, card) {
    const d = w.data;
    card.el.classList.add('custom');
    if (d.view === 'stats') {
      const grid = el('div', 'cw-stats');
      for (const st of (Array.isArray(d.stats) ? d.stats : []).slice(0, 6)) {
        const cell = el('div', 'cw-stat');
        cell.append(el('span', 'cw-value', text(st?.value, 60) || '–'), el('span', 'cw-label', text(st?.label, 40)));
        grid.append(cell);
      }
      card.body.append(grid);
    } else {
      const items = (Array.isArray(d.items) ? d.items : []).slice(0, 20);
      if (!items.length) { card.body.append(el('p', 'w-note', 'Nothing to show right now.')); return; }
      const ul = el('ul', 'cw-list');
      for (const it of items) {
        const li = el('li');
        const url = safeUrl(it?.url);
        const t = text(it?.title, 200);
        li.append(url ? link(url, t) : el('span', 'cw-title', t));
        if (text(it?.detail, 80)) li.append(el('span', 'cw-detail', text(it.detail, 80)));
        ul.append(li);
      }
      card.body.append(ul);
    }
    if (text(d.host, 80)) card.body.append(el('p', 'cw-source', `From ${text(d.host, 80)}`));
  },

  // Notes: saved as you type (a second after the last key) and when you leave the box.
  notes(w, card) {
    const d = w.data;
    card.el.classList.add('notes');
    const area = el('textarea', 'nt-area');
    area.maxLength = Number.isFinite(d.max) ? d.max : 4000;
    area.placeholder = 'Write something…';
    area.setAttribute('aria-label', `${w.title || 'Notes'}: note text`);
    area.spellcheck = true;
    const draft = noteDrafts.get(w.id);
    area.value = draft ? draft.text : text(d.text, 4000);
    let timer = null;
    const save = () => {
      clearTimeout(timer);
      timer = null;
      const d0 = noteDrafts.get(w.id);
      if (d0 && d0.text !== d0.saved) { d0.saved = d0.text; widgetAct(w.id, 'note', { text: d0.text }); }
    };
    area.addEventListener('input', () => {
      noteDrafts.set(w.id, { text: area.value, saved: noteDrafts.get(w.id)?.saved ?? text(d.text, 4000), focus: true, start: area.selectionStart, end: area.selectionEnd });
      clearTimeout(timer);
      timer = setTimeout(save, 1000);
    });
    area.addEventListener('keydown', (e) => e.stopPropagation()); // typing never reaches the page's shortcuts
    area.addEventListener('select', () => { const dr = noteDrafts.get(w.id); if (dr) { dr.start = area.selectionStart; dr.end = area.selectionEnd; } });
    area.addEventListener('focus', () => { const dr = noteDrafts.get(w.id) || { text: area.value, saved: area.value }; dr.focus = true; noteDrafts.set(w.id, dr); });
    area.addEventListener('blur', () => { const dr = noteDrafts.get(w.id); if (dr) dr.focus = false; save(); });
    card.body.append(area);
    // A redraw (the save coming back) must not take the box away from someone typing in it.
    if (draft?.focus) requestAnimationFrame(() => { area.focus(); try { area.setSelectionRange(draft.start ?? area.value.length, draft.end ?? area.value.length); } catch { /* nothing to restore */ } });
    if (draft && draft.text === text(d.text, 4000) && !draft.focus) noteDrafts.delete(w.id);
  },

  countdown(w, card) {
    const d = w.data;
    card.el.classList.add('countdown');
    const big = el('div', 'cd-big');
    const unit = el('div', 'cd-unit');
    const when = el('div', 'cd-when');
    const target = Number(d.target);
    if (!Number.isFinite(target)) { card.body.append(el('p', 'w-note', 'No date set.')); return; }
    when.textContent = new Date(target).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', ...(d.time ? { hour: 'numeric', minute: '2-digit' } : {}) });
    const paint = (now) => {
      const ms = target - now;
      const days = Math.floor(Math.abs(ms) / 86400e3);
      const past = ms < 0;
      if (!past && ms < 86400e3) {
        const h = Math.floor(ms / 3600e3); const m = Math.floor((ms % 3600e3) / 60e3); const sec = Math.floor((ms % 60e3) / 1000);
        big.textContent = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        unit.textContent = d.label ? `until ${text(d.label, 60)}` : 'to go';
      } else if (past && days === 0) {
        big.textContent = 'Today';
        unit.textContent = text(d.label, 60);
      } else {
        big.textContent = days.toLocaleString();
        unit.textContent = `${days === 1 ? 'day' : 'days'} ${past ? 'since' : 'until'} ${text(d.label, 60) || 'the date'}`;
      }
    };
    paint(Date.now());
    liveTicks.set(card.el, paint);
    card.body.append(big, unit, when);
  },

  timer(w, card) {
    const d = w.data;
    card.el.classList.add('timer');
    const phase = el('div', 'tm-phase');
    const clock = el('div', 'tm-clock');
    const bar = el('div', 'tm-bar');
    const fill = el('i');
    bar.append(fill);
    const btns = el('div', 'tm-btns');
    const btn = (label, arg, primary) => {
      const b = el('button', primary ? 'w-btn primary' : 'w-btn', label);
      b.type = 'button';
      b.addEventListener('click', () => widgetAct(w.id, 'timer', { arg }));
      return b;
    };
    const fmt = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    const total = Number(d.total) || 1;
    const rest = d.phase === 'rest';
    phase.textContent = d.pomodoro ? `${rest ? 'Break' : 'Focus'}${d.rounds ? ` · ${d.rounds} done` : ''}` : 'Timer';
    const paint = (now) => {
      const left = d.state === 'running' ? Math.max(0, d.endsAt - now) : d.state === 'done' ? 0 : Number(d.left) || 0;
      clock.textContent = fmt(left);
      fill.style.width = `${Math.round((1 - left / total) * 100)}%`;
      if (d.state === 'running' && left === 0 && !card.el.classList.contains('tm-ended')) { card.el.classList.add('tm-ended'); widgetAct(w.id, 'refresh'); }
    };
    if (d.state === 'running') btns.append(btn('Pause', 'pause', true), btn('Reset', 'reset'));
    else if (d.state === 'paused') btns.append(btn('Resume', 'start', true), btn('Reset', 'reset'));
    else if (d.state === 'done') {
      card.el.classList.add('tm-done');
      phase.textContent = d.pomodoro ? (rest ? 'Break over' : 'Time for a break') : 'Time’s up';
      btns.append(btn(d.pomodoro ? (rest ? 'Start focus' : 'Start break') : 'Again', 'start', true), btn('Reset', 'reset'));
    } else btns.append(btn('Start', 'start', true), ...(d.pomodoro ? [btn(rest ? 'Skip to focus' : 'Skip to break', 'skip')] : []));
    paint(Date.now());
    if (d.state === 'running') liveTicks.set(card.el, paint);
    card.body.append(phase, clock, bar, btns);
  },

  // AI status (features/aistatus-view.js): main shapes it from what Lumen already knows; nothing here is a secret. A small
  // card shows a summary line and a dot per AI, a bigger one a row per AI, a bigger one still the model and usage hint
  // and the live counts (newtab.html picks which, by the room the card has; fitAiStatus trims what still doesn't fit).
  aistatus(w, card) {
    const d = w.data;
    card.el.classList.add('aistatus');
    const STATES = ['ready', 'limited', 'down', 'out', 'off', 'missing'];
    const ais = (Array.isArray(d.ais) ? d.ais : []).filter((a) => a && typeof a === 'object').slice(0, 8);
    const name = (a) => text(a.name, 40);
    const stateOf = (a) => (STATES.includes(a.state) ? a.state : 'missing');
    const full = (a) => `${name(a)}: ${text(a.stateText, 40)}`;
    // [usage bars] the plan's 5-hour window as a thin bar (the percent is in the words beside it too, so colour is never the only signal)
    const ubar = (a, cls) => {
      const u = a.usage;
      if (!u || !Number.isFinite(u.percent)) return null;
      const p = Math.max(0, Math.min(100, Math.round(u.percent)));
      const b = el('span', `ai-ubar ${cls}`);
      b.dataset.level = ['ok', 'warn', 'high'].includes(u.level) ? u.level : 'ok';
      b.setAttribute('role', 'progressbar');
      b.setAttribute('aria-valuemin', '0');
      b.setAttribute('aria-valuemax', '100');
      b.setAttribute('aria-valuenow', String(p));
      b.setAttribute('aria-valuetext', `${p}% of the 5-hour limit used`);
      b.setAttribute('aria-label', `${name(a)} usage`);
      const fill = el('i');
      fill.style.width = `${p}%`; // through the CSSOM: the page's CSP drops inline style attributes
      b.append(fill);
      return b;
    };
    const mark = (a) => { const m = el('i', 'ai-mark'); m.setAttribute('aria-hidden', 'true'); return m; };
    // The compact view: one line of words, a dot per AI (each with its name and state as text for a screen reader), a note.
    const compact = el('div', 'ai-compact');
    const dots = el('ul', 'ai-dots');
    for (const a of ais) {
      const li = el('li', `ai-dot s-${stateOf(a)} k-${a.kind === 'cli' ? 'cli' : 'api'}`);
      li.dataset.keep = a.current || stateOf(a) !== 'ready' ? '1' : '0'; // what a short card keeps last (fitAiStatus)
      const whole = text(a.label, 200) || full(a);
      li.title = whole;
      const lab = el('span', 'ai-lab', text(a.short, 12));
      lab.setAttribute('aria-hidden', 'true');
      if (a.fact) { const f = el('span', 'ai-fact', `· ${text(a.fact, 14)}`); lab.append(' ', f); }
      li.append(aiLogo(a.brand), mark(a), lab, el('span', 'ai-sr', whole));
      const dotBar = ubar(a, 'ai-ubar-dot');
      if (dotBar) li.append(dotBar);
      dots.append(li);
    }
    const sum = el('p', 'ai-sum');
    (Array.isArray(d.summaryParts) && d.summaryParts.length ? d.summaryParts : [d.summary]).slice(0, 3).forEach((part, i) => { if (i) sum.append(' '); sum.append(el('span', null, `${i ? '· ' : ''}${text(part, 40)}`)); }); // (the space between is outside the spans, where a line may break)
    compact.append(sum, dots, el('p', 'ai-sub', text(d.sub, 120)));
    // The list: a row per AI, then the live counts.
    const list = el('div', 'ai-list');
    const rows = el('ul', 'ai-rows');
    for (const a of ais) {
      const li = el('li', `ai-row s-${stateOf(a)}`);
      li.dataset.keep = a.current || stateOf(a) !== 'ready' ? '1' : '0'; // what a short card keeps last (fitAiStatus)
      const detail = [a.model ? `Using ${text(a.model, 60)}` : '', text(a.note, 140), a.fullAccess ? 'Full access on' : ''].filter(Boolean).join(' · ');
      li.append(mark(a), el('span', 'ai-name', name(a)), el('span', 'ai-state', text(a.stateText, 40)));
      if (detail) li.append(el('span', 'ai-detail', detail));
      const rowBar = ubar(a, 'ai-ubar-row');
      if (rowBar) li.append(rowBar);
      rows.append(li);
    }
    const live = el('p', 'ai-live');
    live.setAttribute('aria-label', 'Right now');
    for (const t of (Array.isArray(d.liveText) ? d.liveText : []).slice(0, 4)) live.append(el('span', null, text(t, 60)));
    list.append(rows, live);
    card.body.append(compact, list);
    card.el.setAttribute('aria-label', `${text(w.title, 60) || 'AI status'}: ${text(d.summary, 90)}`);
  },

  embed(w, card) {
    const d = w.data;
    const url = safeUrl(d.url);
    if (!url) { card.body.append(el('p', 'w-note', 'This address can’t be shown.')); return; }
    const name = text(d.name, 80) || text(d.host, 80) || 'Web page';
    card.head.append(openLink(url, 'Open', name));
    card.el.classList.add('embed');
    if (d.frameable === false) {
      const box = el('div', 'w-fallback');
      const note = el('p', 'w-note');
      note.append(el('strong', null, name), `${text(d.host, 80) || 'This site'} doesn’t allow being shown inside other pages.`);
      const open = link(url, 'Open', 'w-btn primary');
      open.setAttribute('aria-label', `Open ${name} in a new tab`);
      box.append(tile({ title: name, url }, 24), note, open);
      card.body.append(box);
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'w-frame';
    // A page like any other tab's: its own origin, no Lumen privileges, no referrer, no top navigation.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms');
    frame.referrerPolicy = 'no-referrer';
    frame.loading = 'lazy';
    frame.title = name;
    frame.src = url;
    card.body.append(frame);
  },
};

// Today: the time; earlier: the day.
function gmailWhen(ms) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
// Ask before "My location": what is sent, to whom. Nothing goes anywhere until Allow.
function askBox(w, d) {
  const box = el('div', 'wx-ask');
  const service = text(d.service, 40) || 'an IP location service';
  box.append(el('strong', null, 'Show weather for where you are?'));
  box.append(el('p', null, `Lumen asks ${service} which city your network is in. ${service} sees your IP address; nothing else is sent.`));
  const yes = el('button', 'w-btn primary', 'Allow');
  yes.type = 'button';
  yes.addEventListener('click', () => widgetAct(w.id, 'consent', { arg: 'allow' }));
  const no = el('button', 'w-btn', 'Not now');
  no.type = 'button';
  no.addEventListener('click', () => widgetAct(w.id, 'consent', { arg: 'deny' }));
  const row = el('div', 'wx-ask-btns');
  row.append(yes, no);
  box.append(row);
  return box;
}
// ---- Stocks and Crypto: a price table, and a SIMULATED paper portfolio (features/markets-view.js) ----
const marketTab = new Map(); // card id -> 'prices' | 'paper' (a redraw keeps the tab)
const usd = (v, small) => (Number.isFinite(v) ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: small && Math.abs(v) < 1 ? 6 : 2 }) : '–');
const qtyText = (v) => (Number.isFinite(v) ? String(Math.round(v * 1e8) / 1e8) : '–');
function change(v, cls = 'mk-chg') {
  const e = el('span', cls);
  if (!Number.isFinite(v)) { e.textContent = '–'; return e; }
  const dir = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  e.classList.add(dir);
  e.textContent = `${v > 0 ? '▲' : v < 0 ? '▼' : ''}${v === 0 ? '' : ' '}${Math.abs(v).toFixed(2)}%`;
  e.setAttribute('aria-label', `${dir === 'flat' ? 'unchanged' : dir}${dir === 'flat' ? '' : ` ${Math.abs(v).toFixed(2)} percent`}`);
  return e;
}
function marketCard(w, card) {
  const d = w.data;
  const crypto = d.kind === 'crypto';
  const rows = (Array.isArray(d.rows) ? d.rows : []).filter((r) => r && typeof r.sym === 'string' && Number.isFinite(r.px)).slice(0, 12);
  const pf = d.pf && typeof d.pf === 'object' ? d.pf : {};
  const offline = d.offline === true;
  card.el.classList.toggle('mk-offline', offline);
  card.head.append(el('span', `mk-badge${d.badge === 'Live' ? ' live' : ''}`, d.badge === 'Live' ? 'Live' : 'Delayed'));
  if (offline) card.head.append(el('span', 'mk-badge off', 'offline'));
  else if (!crypto && d.marketOpen === false) card.head.append(el('span', 'mk-badge', 'Market closed'));
  card.head.append(refreshButton(w));
  if (typeof d.notice === 'string' && d.notice) { const n = el('p', 'w-note mk-notice', d.notice.slice(0, 200)); n.setAttribute('role', 'status'); card.body.append(n); }

  const tabs = el('div', 'mk-tabs');
  tabs.setAttribute('role', 'tablist');
  const panels = { prices: el('div', 'mk-panel'), paper: el('div', 'mk-panel') };
  const select = (name) => {
    marketTab.set(w.id, name);
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
    for (const b of tabs.children) { const on = b.dataset.tab === name; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  };
  for (const [name, label] of [['prices', 'Prices'], ['paper', 'Paper trading']]) {
    const b = el('button', 'mk-tab', label);
    b.type = 'button';
    b.dataset.tab = name;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => select(name));
    b.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); select(name === 'prices' ? 'paper' : 'prices'); tabs.querySelector('[aria-selected="true"]').focus(); } });
    tabs.append(b);
  }

  // Prices: symbol, price, change.
  const table = el('table', 'mk-table');
  table.setAttribute('aria-label', crypto ? 'Crypto prices' : 'Stock prices');
  const head = el('tr');
  for (const t of ['Symbol', 'Price', crypto ? '24h' : 'Change']) { const th = el('th', null, t); th.scope = 'col'; head.append(th); }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const sym = el('th', 'mk-sym', text(r.sym, 12));
    sym.scope = 'row';
    if (text(r.name, 60) && !crypto) sym.title = text(r.name, 60);
    tr.append(sym, el('td', 'mk-px', usd(r.px, true)), (() => { const td = el('td'); td.append(change(r.chg)); return td; })());
    tbody.append(tr);
  }
  table.append(thead, tbody);
  panels.prices.append(table);
  const missing = (Array.isArray(d.missing) ? d.missing : []).filter((s) => typeof s === 'string').slice(0, 12).map((s) => text(s, 12));
  if (missing.length) panels.prices.append(el('p', 'w-note small', `No quote for ${missing.join(', ')}.`));
  const asOf = Number.isFinite(d.asOf) && d.asOf > 0 ? new Date(d.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  panels.prices.append(el('p', 'mk-foot', [asOf && `as of ${asOf}`, offline && 'offline (last known prices)', text(d.attribution, 60)].filter(Boolean).join(' · ')));

  // Paper trading: equity, P/L, holdings, and a buy/sell form.
  const paper = panels.paper;
  paper.append(el('p', 'mk-paper-note', 'Paper trading — simulated. Not investment advice.'));
  const sum = el('div', 'mk-sum');
  const cell = (label, node) => { const c = el('div'); c.append(el('span', 'mk-k', label), node); return c; };
  const plNode = el('span', 'mk-v');
  plNode.append(change(pf.plPct));
  const plMoney = Number.isFinite(pf.pl) ? `${pf.pl > 0 ? '+' : pf.pl < 0 ? '−' : ''}${usd(Math.abs(pf.pl))}` : '–';
  plNode.prepend(`${plMoney} `);
  sum.append(cell('Equity', el('span', 'mk-v', usd(pf.equity))), cell('P/L', plNode), cell('Cash', el('span', 'mk-v', usd(pf.cash))));
  paper.append(sum);
  const holdings = (Array.isArray(pf.positions) ? pf.positions : []).filter((p) => p && typeof p.sym === 'string').slice(0, 50);
  if (holdings.length) {
    const ht = el('table', 'mk-table mk-hold');
    ht.setAttribute('aria-label', 'Paper holdings');
    const hr = el('tr');
    for (const t of ['Holding', 'Value', 'P/L']) { const th = el('th', null, t); th.scope = 'col'; hr.append(th); }
    const hh = el('thead');
    hh.append(hr);
    const hb = el('tbody');
    for (const p of holdings) {
      const tr = el('tr');
      const s = el('th', 'mk-sym', `${text(p.sym, 12)} ×${qtyText(p.qty)}`);
      s.scope = 'row';
      const td = el('td');
      td.append(change(p.plPct));
      tr.append(s, el('td', 'mk-px', usd(p.value)), td);
      if (!Number.isFinite(p.px)) tr.title = 'No current price: valued at cost';
      hb.append(tr);
    }
    ht.append(hh, hb);
    paper.append(ht);
  } else paper.append(el('p', 'w-note small', 'No holdings yet. Buy something with the simulated cash.'));

  const trade = el('div', 'mk-trade');
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Symbol to trade');
  const held = holdings.map((p) => p.sym);
  const symbols = [...new Set([...rows.map((r) => r.sym), ...held])];
  for (const s of symbols) { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.append(o); }
  const qty = document.createElement('input');
  qty.type = 'text';
  qty.inputMode = 'decimal';
  qty.maxLength = 17;
  qty.placeholder = crypto ? 'Amount' : 'Shares';
  qty.setAttribute('aria-label', crypto ? 'Amount to trade' : 'Number of shares');
  const err = el('p', 'mk-err');
  err.setAttribute('role', 'status');
  const go = (side) => {
    const q = qty.value.trim();
    const ok = /^\d{1,8}(\.\d{1,8})?$/.test(q) && Number(q) > 0 && (crypto || /^\d+$/.test(q));
    if (!ok) { err.textContent = crypto ? 'Enter an amount.' : 'Enter a whole number of shares.'; return; }
    if (!sel.value) { err.textContent = 'Pick a symbol.'; return; }
    for (const b of trade.querySelectorAll('button')) b.disabled = true;
    widgetAct(w.id, side, { sym: sel.value, qty: q });
  };
  qty.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go('buy'); } e.stopPropagation(); });
  const buy = el('button', 'w-btn primary', 'Buy');
  const sell = el('button', 'w-btn', 'Sell');
  for (const [b, side] of [[buy, 'buy'], [sell, 'sell']]) { b.type = 'button'; b.addEventListener('click', () => go(side)); }
  const blocked = d.tradable !== true || !symbols.length;
  for (const c of [sel, qty, buy, sell]) c.disabled = blocked;
  trade.append(sel, qty, buy, sell);
  paper.append(trade, err);
  if (blocked) paper.append(el('p', 'w-note small', text(d.tradeBlock, 120) || 'Trading is paused.'));
  else paper.append(el('p', 'w-note small', 'Trades fill at the last price shown.'));
  const reset = el('button', 'w-btn mk-reset', 'Reset portfolio');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    if (reset.dataset.sure !== '1') { reset.dataset.sure = '1'; reset.textContent = 'Click again to erase all paper trades'; setTimeout(() => { reset.dataset.sure = ''; reset.textContent = 'Reset portfolio'; }, 4000); return; }
    reset.disabled = true;
    widgetAct(w.id, 'resetpf');
  });
  paper.append(el('p', 'mk-foot', `${int(pf.trades) || 0} of ${int(pf.tradesMax) || 200} trades · started with ${usd(pf.start)} · ${asOf ? `prices as of ${asOf} · ` : ''}${text(d.attribution, 60)}`), reset);

  card.body.append(tabs, panels.prices, panels.paper);
  select(marketTab.get(w.id) === 'paper' ? 'paper' : 'prices');
}

function dayLabel(date) {
  const start = new Date(new Date().setHours(0, 0, 0, 0));
  const diff = Math.round((new Date(date).setHours(0, 0, 0, 0) - start) / 86400e3);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return date.toLocaleDateString([], { weekday: diff < 7 ? 'long' : 'short', month: diff < 7 ? undefined : 'short', day: diff < 7 ? undefined : 'numeric' });
}
function dueText(t, today) {
  if (typeof t.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) return '';
  const date = new Date(+t.due.slice(0, 4), +t.due.slice(5, 7) - 1, +t.due.slice(8, 10));
  const time = typeof t.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t.time) ? new Date(t.time) : null;
  const clock = time && !Number.isNaN(time.getTime()) ? time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  if (t.overdue) return `Overdue · ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}${clock ? `, ${clock}` : ''}`;
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? clock || 'Today' : `${dayLabel(date)}${clock ? `, ${clock}` : ''}`;
}

// ---- the cards ----
const shownWidgets = new Map(); // id -> { key, el, title }
function buildCard(w) {
  const title = text(w.title, 60) || 'Widget';
  const cardEl = el('article', `w-card ${w.type}`);
  cardEl.setAttribute('role', 'group');
  cardEl.setAttribute('aria-label', title);
  cardEl.dataset.id = w.id;
  const head = el('div', 'w-head');
  const h2 = el('h2', null, title);
  head.append(h2);
  const body = el('div', 'w-body');
  const foot = el('div', 'w-foot');
  foot.setAttribute('aria-live', 'off');
  cardEl.append(head, body, foot);
  const card = { el: cardEl, head, body, h2 };
  if (w.data && typeof w.data === 'object') {
    try {
      WIDGET_RENDERERS[w.type]({ ...w, title }, card);
      editPencil(w, title, card);
    } catch (err) {
      console.error('widget', w.type, err);
      body.replaceChildren(el('p', 'w-note', 'This widget couldn’t be shown.'));
      const wrap = el('div', 'w-actions');
      const retry = el('button', 'w-btn', 'Try again');
      retry.type = 'button';
      retry.setAttribute('aria-label', `Try ${title} again`);
      retry.addEventListener('click', () => widgetAct(w.id, 'refresh'));
      wrap.append(retry);
      if (w.setup && window.widgetSetup?.can(w.type)) {
        const fix = el('button', 'w-btn', 'Edit settings');
        fix.type = 'button';
        fix.setAttribute('aria-label', `Edit ${title}`);
        fix.addEventListener('click', () => openEditor(w));
        wrap.append(fix);
      }
      body.append(wrap);
      editPencil(w, title, card, true);
    }
  } else if (typeof w.error === 'string' && w.error) {
    const note = el('p', 'w-note');
    note.append(el('strong', null, 'Couldn’t update'), text(w.error, 200));
    const retry = el('button', 'w-btn', 'Try again');
    retry.type = 'button';
    retry.setAttribute('aria-label', `Try ${title} again`);
    retry.addEventListener('click', () => widgetAct(w.id, 'refresh'));
    body.append(note);
    const wrap = el('div', 'w-actions');
    wrap.append(retry);
    // A card that can't load is often one whose address or place is wrong: fix it here, next to Try again.
    if (w.setup && window.widgetSetup?.can(w.type)) {
      const fix = el('button', 'w-btn', 'Edit settings');
      fix.type = 'button';
      fix.setAttribute('aria-label', `Edit ${title}`);
      fix.addEventListener('click', () => openEditor(w));
      wrap.append(fix);
    }
    body.append(wrap);
    editPencil(w, title, card, true);
  } else {
    const skel = el('div', 'w-skel');
    skel.setAttribute('aria-label', `Loading ${title}`);
    skel.setAttribute('role', 'status');
    skel.append(el('i'), el('i'), el('i'));
    body.append(skel);
  }
  window.widgetGrid?.attach(cardEl, w); // handles, badge, gear, presets, gestures (newtab-widgets-grid.js)
  return cardEl;
}
// "Updated 12 min ago", and why it is old when a refresh failed.
function updateFoot(cardEl, w) {
  const foot = cardEl.querySelector('.w-foot');
  if (!foot) return;
  const parts = [];
  if (w.updated) parts.push(`Updated ${agoText(w.updated)}`);
  if (typeof w.warning === 'string' && w.warning) parts.push(text(w.warning, 120));
  foot.textContent = parts.join(' · ');
  foot.classList.toggle('warn', Boolean(w.warning));
  cardEl.dataset.updated = String(w.updated || 0);
}
const lastList = { current: [] };
function renderWidgets(list) {
  if (window.widgetGrid?.busy()) { window.widgetGrid.defer(list); return; } // redrawing mid-gesture would move the card under the pointer
  const box = document.getElementById('widgets');
  const known = (Array.isArray(list) ? list : []).filter((w) => w && widgetId(w.id) && WIDGET_RENDERERS[w.type]);
  // Stacks (newtab-stacks.js): every member gets a card, only the shown one is on the grid; up to 12 places.
  const stacks = window.newtabStacks;
  const valid = stacks ? stacks.prepare(known, 12) : known.slice(0, 12);
  lastList.current = valid;
  const cards = valid.map((w) => {
    const { span, height, layout, updated, warning, colors, setup, stack, sid, top, rotate, smart, ...rest } = w; // a new size, place, age, turn in a stack or edit-form value is applied to the card as it is (the pencil reads setup when clicked)
    const key = JSON.stringify(rest);
    const kept = shownWidgets.get(w.id);
    const card = kept && kept.key === key ? kept.el : buildCard(w);
    if (card !== kept?.el) {
      if (kept?.el) { kept.el.replaceWith(card); } // same place in the DOM order
      shownWidgets.set(w.id, { key, el: card });
    }
    updateFoot(card, w);
    card.dataset.colors = ['calendar', 'match', 'accent', 'mono'].includes(colors) ? colors : 'calendar';
    return card;
  });
  for (const [id, s] of shownWidgets) if (!valid.some((w) => w.id === id)) { s.el.remove(); shownWidgets.delete(id); }
  // Cards are never reordered in the DOM (moving a frame would reload it): new ones go at the end.
  for (const card of cards) if (card.parentNode !== box) box.append(card);
  // The page's own sections that are cards too (newtab-system.js): part of the same grid.
  const system = window.newtabSystem;
  const all = new Map(valid.map((w, i) => [w.id, cards[i]]));
  if (system) for (const [id, card] of system.cards()) all.set(id, card);
  box.classList.toggle('empty', !all.size);
  applyWidgetColors();
  const shown = stacks ? valid.filter((w, i) => stacks.decorate(cards[i], w)) : valid; // a stack's hidden members stay off the grid
  if (stacks) for (const w of valid) if (!shown.includes(w)) all.delete(w.id);
  window.widgetGrid?.sync([...shown, ...(system ? system.entries() : [])], all); // its layout hook puts the hidden members under their card
}
// A card's Colors setting: 'calendar' leaves it alone; the others tint its surface, title, event bars and
// today highlight from the page's accent and background (features/widget-colors.js keeps the text readable).
// Called again whenever the look changes (newtab.js applyLook), so Match screen follows live.
function applyWidgetColors() {
  const WC = window.WidgetColors;
  const look = window.widgetLook?.();
  if (!WC || !look) return;
  const palettes = {};
  for (const { el: card } of shownWidgets.values()) {
    const mode = card.dataset.colors || 'calendar';
    const pal = mode === 'calendar' ? null : (palettes[mode] ||= WC.paletteForMode(mode, look));
    card.classList.toggle('tinted', Boolean(pal));
    for (const name of ['--w-surface', '--w-text', '--w-head', '--w-today', '--w-bar0', '--w-bar1', '--w-bar2']) card.style.removeProperty(name);
    if (!pal) continue;
    card.style.setProperty('--w-surface', pal.surface);
    card.style.setProperty('--w-text', pal.text);
    card.style.setProperty('--w-head', pal.head);
    card.style.setProperty('--w-today', pal.today);
    pal.bars.forEach((c, i) => card.style.setProperty(`--w-bar${i}`, c));
  }
}
window.applyWidgetColors = applyWidgetColors;

// ---- World clock: the page ticks the times itself from time zone names (Intl); nothing is fetched to do it ----
const clockRows = new Map(); // row element -> what it shows
const sunTime = (v, opts) => { const m = /^(\d{2}):(\d{2})$/.exec(typeof v === 'string' ? v : ''); return m ? clockText(Number(m[1]), Number(m[2]), opts) : '–'; };
function tickClocks() {
  const WCK = window.WorldClock;
  if (!WCK) return;
  const now = Date.now();
  for (const [row, c] of clockRows) {
    // A card is drawn before it is put on the page: only a row that was on the page and left it is gone.
    if (row.isConnected) c.seen = true;
    else if (c.seen || now - c.born > 10e3) { clockRows.delete(row); continue; }
    try {
      const t = WCK.timeText(now, c.tz, c.opts);
      if (c.shown !== t) { // the digits big, AM/PM small
        c.shown = t;
        const m = /^(.*?)\s*([AaPp]\.?\s?[Mm]\.?)$/.exec(t);
        if (m) c.time.replaceChildren(m[1], el('span', 'wc-ampm', m[2])); else c.time.textContent = t;
      }
      const parts = WCK.zoneParts(now, c.tz);
      const day = WCK.dayFor(c.days, parts.date);
      const up = WCK.isDaylight(parts, day);
      const key = `${parts.date}|${up}`;
      if (key === c.dayKey) continue;
      c.dayKey = key;
      row.dataset.day = up === null ? '' : up ? 'day' : 'night';
      c.icon.replaceChildren(skyIcon(0, up !== false));
      if (c.date) c.date.textContent = WCK.dateText(now, c.tz);
      if (c.off) {
        c.off.textContent = WCK.relativeLabel(WCK.offsetMinutes(now, c.tz) - WCK.offsetMinutes(now, Intl.DateTimeFormat().resolvedOptions().timeZone));
      }
      if (c.sun) c.sun.textContent = day ? `↑ ${sunTime(day.sunrise, c.opts)}  ↓ ${sunTime(day.sunset, c.opts)}` : '';
    } catch (err) { console.error('world clock', err); clockRows.delete(row); }
  }
}
setInterval(() => { if (!document.hidden && clockRows.size) tickClocks(); }, 1000);
// Countdown and Timer cards count seconds here between reads (a card that left the page drops out).
const liveTicks = new Map(); // card element -> paint(now)
const noteDrafts = new Map(); // Notes card id -> { text, saved, focus, start, end }: what is typed survives a redraw
setInterval(() => {
  if (document.hidden || !liveTicks.size) return;
  const now = Date.now();
  for (const [cardEl, paint] of liveTicks) {
    if (!cardEl.isConnected) { liveTicks.delete(cardEl); continue; }
    try { paint(now); } catch (err) { console.error('widget tick', err); liveTicks.delete(cardEl); }
  }
}, 1000);
// Show as many places as fit whole (at least the first); the rest are hidden, so the list never needs a scrollbar.
function fitClockRows(body, list) {
  if (!body.isConnected) return;
  const rows = [...list.children];
  for (const r of rows) r.hidden = false;
  const room = body.clientHeight;
  for (let i = rows.length - 1; i > 0 && list.scrollHeight > room + 1; i--) rows[i].hidden = true;
}

// ---- Fitting: a card shows what fits, whole pieces only ----
// Nothing in a card scrolls unless its content really is taller than it: weather drops its least
// important parts first (details, then the hourly strip, then days from the end), lists show whole
// rows and end with a "+N more" line, and only if something still doesn't fit does the card get a
// thin scrollbar (styled in newtab.html, "[widget polish]"). Idempotent: every pass starts clean.
const isShown = (n) => Boolean(n) && n.getClientRects().length > 0;
const SLACK = 2; // px of rounding that is not overflow
const tooTall = (n) => n.scrollHeight > n.clientHeight + SLACK;
const tooWide = (n) => n.scrollWidth > n.clientWidth + SLACK;
const fitOff = (n) => n.classList.add('fit-off');
const NO_LIST_FIT = ['weather', 'worldclock', 'spotify', 'applemusic', 'embed', 'muse', 'stocks', 'crypto', 'tradingview', 'notes', 'countdown', 'timer', 'aistatus', 'custom'];
function fitPlace(sec, cycle) {
  // Sideways strips (hours, days laid across): drop what doesn't fit from the end.
  for (const strip of sec.querySelectorAll('.wx-hours, .wx-days')) {
    if (!isShown(strip) || getComputedStyle(strip).flexDirection !== 'row') continue;
    const kids = [...strip.children].filter((c) => !c.classList.contains('wx-more'));
    for (let i = kids.length - 1; i > 0 && tooWide(strip); i--) fitOff(kids[i]);
  }
  if (!tooTall(cycle)) return;
  for (const part of [sec.querySelector('.wx-details'), sec.querySelector('.wx-hours')]) {
    if (isShown(part)) { fitOff(part); if (!tooTall(cycle)) return; }
  }
  const days = sec.querySelector('.wx-days');
  if (!isShown(days)) return;
  if (getComputedStyle(days).flexDirection === 'row') { fitOff(days); return; }
  const rows = [...days.querySelectorAll('.wx-day')];
  for (let i = rows.length - 1; i >= 0 && tooTall(cycle); i--) {
    if (rows.slice(i).some((r) => r.getAttribute('aria-expanded') === 'true')) break; // never under the day being read
    fitOff(rows[i]);
    if (rows[i].nextElementSibling?.classList.contains('wx-more')) fitOff(rows[i].nextElementSibling);
  }
  if (!rows.some((r) => !r.classList.contains('fit-off'))) fitOff(days);
}
function fitWeather(cardEl) {
  const wrap = cardEl.querySelector('.wx-places');
  const cycle = wrap?.querySelector('.wx-cycle');
  if (!cycle) return;
  const secs = [...cycle.children];
  const was = secs.findIndex((s) => s.classList.contains('active'));
  if (isShown(cycle)) {
    for (const sec of secs) { // each place is measured as if it were the one showing
      if (secs.length > 1) secs.forEach((s) => s.classList.toggle('active', s === sec));
      fitPlace(sec, cycle);
    }
    if (secs.length > 1) secs.forEach((s, i) => s.classList.toggle('active', i === was));
  }
  const list = wrap.querySelector('.wx-list');
  if (isShown(list)) {
    const rows = [...list.children];
    for (let i = rows.length - 1; i > 0 && tooTall(wrap); i--) fitOff(rows[i]);
  }
}
// Task, agenda, mail and headline lists: whole rows, then "+N more".
function fitLists(cardEl, body) {
  const lists = [...body.querySelectorAll('.w-list')].filter(isShown);
  if (!lists.length || !tooTall(body)) return;
  const rows = lists.flatMap((l) => [...l.children].filter((c) => c.classList.contains('w-row') && isShown(c)));
  if (rows.length < 2) return;
  const extra = [...body.querySelectorAll('.w-more')].reduce((n, m) => n + (parseInt(/\d+/.exec(m.textContent)?.[0], 10) || 0), 0); // "3 more in Todoist"
  const done = body.querySelector('.td-done');
  if (done) { fitOff(done); if (!tooTall(body)) return; }
  body.querySelectorAll('.w-more').forEach(fitOff);
  const href = cardEl.querySelector('.w-head a.w-link')?.href;
  const more = href ? link(href, '', 'w-fit-more') : el('p', 'w-fit-more');
  const live = (l) => [...l.children].some((c) => c.classList.contains('w-row') && !c.classList.contains('fit-off'));
  const tidy = () => { // a day heading or section with nothing left under it goes too
    for (const l of lists) {
      let head = null;
      let any = false;
      const close = () => { if (head) head.classList.toggle('fit-off', !any); };
      for (const c of l.children) {
        if (c.classList.contains('w-day')) { close(); head = c; any = false; } else if (c.classList.contains('w-row') && !c.classList.contains('fit-off')) any = true;
      }
      close();
      l.closest('.gh-section')?.classList.toggle('fit-off', !live(l));
    }
    (lists.filter(live).pop() || lists[0]).after(more);
  };
  let gone = 0;
  const label = () => { more.replaceChildren(`+${gone + extra} more`); };
  label();
  tidy();
  for (let i = rows.length - 1; i > 0 && tooTall(body); i--) {
    fitOff(rows[i]);
    gone++;
    label();
    tidy();
  }
}
// AI status: the whole list, then what a small card can't hold goes in order of least importance: the second lines, the note,
// rows from the end down to three ("+N more"; the live counts stay) and last the rest of the rows.
// A list that cannot show three rows and the live counts gives way to the summary and dots (ai-compact-only), which show every AI in a line.
// That one drops the note, the "waiting" count, the dots and then the "working" count.
function fitAiStatus(cardEl, body, compactOnly = false) {
  body.classList.toggle('ai-compact-only', compactOnly);
  body.classList.remove('ai-nofact', 'ai-nolabel');
  body.querySelectorAll('.ai-more').forEach((n) => n.remove());
  body.querySelectorAll('.fit-off').forEach((n) => n.classList.remove('fit-off'));
  const bad = () => body.scrollHeight > body.clientHeight || body.scrollWidth > body.clientWidth; // (no slack: a line cut by a pixel is still cut)
  const hide = (sel) => { for (const n of body.querySelectorAll(sel)) if (isShown(n)) fitOff(n); };
  const parts = [...body.querySelectorAll('.ai-sum > span')];
  const rows = [...body.querySelectorAll('.ai-row')].filter(isShown);
  const more = el('p', 'ai-more');
  let gone = 0;
  const trim = (keep) => {
    if (rows.length < 2) return;
    if (!more.isConnected) rows[rows.length - 1].after(more);
    // The ones that matter least go first: an AI that is ready and not the one in use, from the end; then the rest from the end.
    const order = [...rows].reverse().filter((r) => r.dataset.keep !== '1').concat([...rows].reverse().filter((r) => r.dataset.keep === '1'));
    for (const r of order) { if (rows.length - gone <= keep || !bad()) break; if (r.classList.contains('fit-off')) continue; fitOff(r); gone++; more.textContent = `+${gone} more`; }
  };
  if (!bad()) return;
  if (!rows.length) { fitAiChips(body, parts, bad, hide); return; }
  hide('.ai-detail');
  if (!bad()) return;
  hide('.ai-sub');
  if (rows.length) {
    trim(3);
    if (bad() && rows.length > 3 && !compactOnly) { fitAiStatus(cardEl, body, true); return; }
    if (bad()) hide('.ai-live');
    trim(1);
    if (bad() && more.isConnected) fitOff(more);
    return;
  }
  if (bad() && parts[2]) fitOff(parts[2]);
  if (bad()) hide('.ai-dots');
  if (bad() && parts[1]) fitOff(parts[1]);
}
// The small card's chips (logo, dot, word, the one extra fact): what doesn't fit goes in order: the note line, the facts, the summary's
// "waiting" part, the words (the dot's shape still says the state), then chips from the end (ready ones that aren't in use first) with a "+N", then the "working" part.
function fitAiChips(body, parts, bad, hide) {
  hide('.ai-sub'); // (the note repeats what the chip's fact says)
  if (!bad()) return;
  body.classList.add('ai-nofact');
  if (!bad()) return;
  if (parts[2]) fitOff(parts[2]);
  if (!bad()) return;
  body.classList.add('ai-nolabel');
  if (!bad()) return;
  const chips = [...body.querySelectorAll('.ai-dot')].filter(isShown);
  const dots = body.querySelector('.ai-dots');
  if (chips.length > 1 && dots) {
    const more = el('li', 'ai-more ai-more-chip');
    let gone = 0;
    const order = [...chips].reverse().filter((c) => c.dataset.keep !== '1').concat([...chips].reverse().filter((c) => c.dataset.keep === '1'));
    for (const c of order) {
      if (chips.length - gone <= 1 || !bad()) break;
      fitOff(c);
      gone++;
      more.textContent = `+${gone}`;
      more.title = `${gone} more, hidden to fit`;
      if (!more.isConnected) dots.append(more);
    }
  }
  if (bad() && parts[1]) fitOff(parts[1]);
}
function settleCard(cardEl) {
  if (!cardEl?.isConnected || cardEl.classList.contains('sys')) return; // the page's own sections fit themselves (newtab-system.js)
  const body = cardEl.querySelector('.w-body');
  if (!body) return;
  const scrollers = [body, ...cardEl.querySelectorAll('.wx-cycle, .mu-wrap')];
  for (const n of scrollers) { n.style.overflowY = 'hidden'; n.style.overflowX = 'hidden'; }
  cardEl.querySelectorAll('.fit-off').forEach((n) => n.classList.remove('fit-off'));
  cardEl.querySelectorAll('.w-fit-more').forEach((n) => n.remove());
  if (cardEl.classList.contains('weather')) fitWeather(cardEl);
  else if (cardEl.classList.contains('aistatus')) fitAiStatus(cardEl, body);
  else if (!NO_LIST_FIT.some((c) => cardEl.classList.contains(c))) fitLists(cardEl, body);
  // Only what still overflows may scroll (thin, and only while hovered); a card that fits doesn't move or catch the wheel.
  for (const n of scrollers) {
    n.style.overflowY = tooTall(n) ? 'auto' : 'hidden';
    n.style.overflowX = tooWide(n) ? 'auto' : 'hidden';
  }
}
{
  const queue = new Set();
  const flush = () => { const cards = [...queue]; queue.clear(); for (const c of cards) settleCard(c); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const e of entries) queue.add(e.target);
    requestAnimationFrame(flush);
  }) : null;
  const seen = new WeakSet();
  const watch = () => {
    for (const c of document.querySelectorAll('#widgets > .w-card')) if (!seen.has(c)) { seen.add(c); ro?.observe(c, { box: 'border-box' }); queue.add(c); }
    if (queue.size) requestAnimationFrame(flush);
  };
  const box = document.getElementById('widgets');
  if (box) new MutationObserver(watch).observe(box, { childList: true });
  window.settleWidgetCard = settleCard;
}

// Events end and "Tomorrow" becomes "Today": the calendar and task cards redraw once a minute; a card
// whose data is old asks to be refreshed (never while the page is hidden). Nothing polls otherwise.
const REFRESH_AFTER = { weather: 20 * 60e3, worldclock: 6 * 3600e3, todoist: 5 * 60e3, calendar: 15 * 60e3, spotify: 45e3, applemusic: 30e3, gmail: 5 * 60e3, slack: 5 * 60e3, github: 5 * 60e3, feed: 10 * 60e3 };
const asked = new Map();
function tick() {
  if (document.hidden) return;
  for (const [id, s] of shownWidgets) {
    if (s.el.classList.contains('calendar') || s.el.classList.contains('feed') || s.el.classList.contains('todoist')) shownWidgets.set(id, { key: '', el: s.el });
  }
  for (const w of lastList.current) {
    // Stocks and Crypto say how often they refresh (a closed market: hourly).
    const after = (w.type === 'stocks' || w.type === 'crypto') && Number.isFinite(w.data?.refreshMs) ? Math.max(60e3, w.data.refreshMs) : REFRESH_AFTER[w.type];
    if (after && w.updated && Date.now() - w.updated > after && Date.now() - (asked.get(w.id) || 0) > after) { asked.set(w.id, Date.now()); widgetAct(w.id, 'refresh'); return; }
  }
  const box = document.getElementById('widgets');
  if (!box.querySelector('.w-row.done') && !box.querySelector('.td-add input:focus') && !box.querySelector('.mu-ask input:focus') && !box.querySelector('.mk-trade :focus') && !window.widgetGrid?.busy()) window.dispatchEvent(new HashChangeEvent('hashchange'));
}
setInterval(tick, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
// A framed page (Google Calendar's embed) may focus itself as it loads, and then the search box
// stops taking typing. Focus that goes into a frame without the pointer on it or a Tab press goes
// back where it was.
{
  let pointerOnFrame = false;
  let tabbed = 0;
  let before = null;
  document.addEventListener('pointerover', (e) => { pointerOnFrame = e.target.classList?.contains('w-frame') ?? false; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbed = Date.now(); }, true);
  document.addEventListener('focusin', (e) => { if (!e.target.classList?.contains('w-frame')) before = e.target; });
  addEventListener('blur', () => setTimeout(() => {
    const f = document.activeElement;
    if (!f?.classList?.contains('w-frame') || pointerOnFrame || Date.now() - tabbed < 1000) return;
    if (before?.isConnected) before.focus({ preventScroll: true });
    else f.blur();
  }, 0));
}
window.renderWidgets = renderWidgets;
// The page's own editor for card id, or null (a kind it can't edit, or a system card).
window.widgetSetupTarget = (id) => { const w = lastList.current.find((x) => x.id === id); return w && w.setup && window.widgetSetup?.can(w.type) ? { id: w.id, type: w.type, title: w.title, setup: w.setup } : null; };
window.widgetTypes = () => Object.keys(WIDGET_RENDERERS); // the kinds of card this file can draw (newtab-edit.js's Add widget picker)
