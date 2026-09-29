// [widgets] The new-tab page's widget cards (features/widgets.js fetches their data in the browser;
// it arrives in the page's hash). Every value from the network is set with textContent, links must
// be https, and each field is checked before use. Buttons act by loading this page with
// ?widget=<id>&do=… (the browser cancels that navigation and does it), like the Ask AI box.
// Cards whose data didn't change are kept as they are, so a web page in a frame never reloads (and
// no card is ever moved in the page's DOM: newtab-widgets-grid.js places them with transforms).
// Each card is a size container: what it shows depends on the room it has (see the @container rules
// in newtab.html), so a small card shows the essentials and a big one everything.

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
const safeUrl = (u) => (typeof u === 'string' && u.length < 2000 && /^https:\/\/[^\s"'<>\\]+$/i.test(u) ? u : null);
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
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

// ---- the renderers, one per connector type ----
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
      const name = el('div', 'wx-name');
      name.append(el('span', 'wx-city', label));
      if (p.here) {
        name.append(el('span', 'wx-approx', 'approximate'));
        name.append(iconButton(ICON_LOCATE, `Update my location for ${label}`, () => widgetAct(w.id, 'locate')));
      }
      sec.append(name);
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
          btn.addEventListener('click', () => { const open = btn.getAttribute('aria-expanded') !== 'true'; btn.setAttribute('aria-expanded', String(open)); more.hidden = !open; });
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

  // Now playing. Everything is a checked string or number set with textContent; the album picture is a
  // data: URL that main made from bytes it sniffed itself; the buttons ask main to call Spotify.
  spotify(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const open = typeof d.url === 'string' && /^https:\/\/open\.spotify\.com\/[\w/?=&.-]{1,200}$/.test(d.url) ? d.url : null;
    if (open) card.head.append(openLink(open, 'Open in Spotify'));
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
      info.append(el('span', 'sp-title', 'Nothing is playing'), el('span', 'sp-artist', text(d.device, 60) ? `${text(d.device, 60)} is ready` : 'Start Spotify on any device'));
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
    if (state === 'idle') { // nothing to skip: Play resumes on the last device (Spotify says if there is none)
      controls.append(button('play', 'Play on Spotify', 'play', 'sp-btn main'));
      card.body.append(controls);
      return;
    }
    controls.append(button('prev', 'Previous track', 'previous'), state === 'playing' ? button('pause', 'Pause', 'pause', 'sp-btn main') : button('play', 'Play', 'play', 'sp-btn main'), button('next', 'Next track', 'next'));
    card.body.append(controls);
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
          if (!document.hidden && draw() >= duration) clearInterval(timer);
        }, 1000);
      }
    }
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

  calendar(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const now = Date.now();
    const events = (Array.isArray(d.events) ? d.events : [])
      .filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end) && (e.allDay || e.end > now));
    if (!events.length) { card.body.append(el('p', 'w-empty', 'Nothing coming up in the next two weeks.')); return; }
    const list = el('div', 'w-list');
    let lastDay = '';
    let dayIdx = -1;
    events.forEach((e, i) => {
      const start = e.allDay && /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? new Date(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10)) : new Date(e.start);
      const shown = e.allDay && start < new Date(new Date().setHours(0, 0, 0, 0)) ? new Date() : start; // a multi-day event that began earlier
      const day = dayLabel(shown);
      if (day !== lastDay) { const dl = el('div', 'w-day', day); if (i > 0) dl.classList.add('later'); if (day === 'Today') dl.classList.add('today-label'); list.append(dl); lastDay = day; dayIdx++; }
      const row = el('div', 'w-row');
      row.dataset.c = String(dayIdx % 3);
      if (day === 'Today') row.classList.add('today');
      const evColor = hex6(e.color) || hex6(d.color); // the feed's own colour (used when the card's Colors setting is "Calendar colors")
      if (evColor) row.style.setProperty('--ev', evColor);
      if (i > 0) row.classList.add('later');
      if (i > 2) row.classList.add('far');
      const time = e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const main = el('div', 'w-main');
      const title = text(e.title) || 'Busy';
      const url = safeUrl(e.url);
      main.append(url ? link(url, title, '') : el('span', 'w-title', title));
      const where = text(e.location, 200);
      const until = !e.allDay && e.start <= now ? `Now · until ${new Date(e.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
      if (until || where) main.append(el('span', 'w-sub', [until, where].filter(Boolean).join(' · ')));
      row.append(el('span', 'w-bar'), el('span', 'w-time', time), main);
      list.append(row);
    });
    card.body.append(list);
  },

  // Gmail (read-only): only text from the API arrives here, and it is set with textContent. The
  // message links are https://mail.google.com addresses built by the browser from a checked id.
  gmail(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    if (d.state === 'reconnect') {
      const note = el('p', 'w-note');
      note.append(el('strong', null, 'Gmail needs to be connected'), text(d.message, 200) || 'Connect Gmail in Settings.');
      const fix = el('button', 'w-btn primary', 'Open Settings');
      fix.type = 'button';
      fix.setAttribute('aria-label', `Open settings to reconnect ${text(w.title, 60)}`);
      fix.addEventListener('click', () => widgetAct(w.id, 'configure'));
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
    } catch (err) {
      console.error('widget', w.type, err);
      body.replaceChildren(el('p', 'w-note', 'This widget couldn’t be shown.'));
    }
  } else if (typeof w.error === 'string' && w.error) {
    const note = el('p', 'w-note');
    note.append(el('strong', null, 'Couldn’t update'), text(w.error, 200));
    const retry = el('button', 'w-btn', 'Try again');
    retry.type = 'button';
    retry.setAttribute('aria-label', `Try ${title} again`);
    retry.addEventListener('click', () => widgetAct(w.id, 'refresh'));
    body.append(note);
    const wrap = el('div');
    wrap.append(retry);
    body.append(wrap);
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
  const valid = (Array.isArray(list) ? list : []).filter((w) => w && widgetId(w.id) && WIDGET_RENDERERS[w.type]).slice(0, 12);
  lastList.current = valid;
  const cards = valid.map((w) => {
    const { span, height, layout, updated, warning, colors, ...rest } = w; // a new size, place or age is applied to the card as it is
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
  window.widgetGrid?.sync([...valid, ...(system ? system.entries() : [])], all);
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

// Events end and "Tomorrow" becomes "Today": the calendar and task cards redraw once a minute; a card
// whose data is old asks to be refreshed (never while the page is hidden). Nothing polls otherwise.
const REFRESH_AFTER = { weather: 20 * 60e3, todoist: 5 * 60e3, calendar: 15 * 60e3, spotify: 45e3, gmail: 5 * 60e3, slack: 5 * 60e3 };
const asked = new Map();
function tick() {
  if (document.hidden) return;
  for (const [id, s] of shownWidgets) {
    if (s.el.classList.contains('calendar') || s.el.classList.contains('todoist')) shownWidgets.set(id, { key: '', el: s.el });
  }
  for (const w of lastList.current) {
    const after = REFRESH_AFTER[w.type];
    if (after && w.updated && Date.now() - w.updated > after && Date.now() - (asked.get(w.id) || 0) > after) { asked.set(w.id, Date.now()); widgetAct(w.id, 'refresh'); return; }
  }
  const box = document.getElementById('widgets');
  if (!box.querySelector('.w-row.done') && !box.querySelector('.td-add input:focus') && !window.widgetGrid?.busy()) window.dispatchEvent(new HashChangeEvent('hashchange'));
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
window.widgetTypes = () => Object.keys(WIDGET_RENDERERS); // the kinds of card this file can draw (newtab-edit.js's Add widget picker)
