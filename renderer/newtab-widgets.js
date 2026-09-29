// [widgets] The new-tab page's widget cards (features/widgets.js fetches their data in the browser;
// it arrives in the page's hash). Every value from the network is set with textContent, links must
// be https, and each field is checked before use. Buttons act by loading this page with
// ?widget=<id>&do=… (the browser cancels that navigation and does it), like the Ask AI box.
// Cards whose data didn't change are kept as they are, so a web page in a frame never reloads.

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

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};
const safeUrl = (u) => (typeof u === 'string' && u.length < 2000 && /^https:\/\/[^\s"'<>\\]+$/i.test(u) ? u : null);
const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const widgetId = (id) => (typeof id === 'string' && /^w[0-9a-z]{4,20}$/.test(id) ? id : null);

// Ask the browser to do something for a widget (see features/widgets.js actionFrom).
function widgetAct(id, action, extra = {}) {
  const params = new URLSearchParams({ widget: id, do: action, ...extra });
  location.href = `${location.pathname}?${params}${location.hash}`;
}
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
function refreshButton(w) {
  const b = el('button', 'w-icon-btn');
  b.type = 'button';
  b.innerHTML = ICON_REFRESH;
  b.setAttribute('aria-label', `Refresh ${w.title}`);
  b.title = 'Refresh';
  b.addEventListener('click', () => widgetAct(w.id, 'refresh'));
  return b;
}

// ---- the renderers, one per connector type ----
const WIDGET_RENDERERS = {
  weather(w, card) {
    const d = w.data;
    const unit = d.units === 'c' ? '°C' : '°F';
    const deg = (v) => (int(v) === null ? '–' : `${int(v)}°`);
    card.head.append(refreshButton(w));
    const now = el('div', 'wx-now');
    const label = WMO[d.code] || 'Weather';
    const textBox = el('div', 'wx-text');
    textBox.append(el('span', 'wx-label', label), el('span', 'wx-range', `H ${deg(d.hi)}  L ${deg(d.lo)} · Feels ${deg(d.feels)}`));
    const temp = el('span', 'wx-temp', deg(d.temp));
    temp.setAttribute('aria-label', `${int(d.temp)} ${unit}, ${label}`);
    now.append(skyIcon(d.code, d.day !== false), temp, textBox);
    card.body.append(now);
    const hours = Array.isArray(d.hours) ? d.hours.filter((h) => h && Number.isInteger(h.hour) && h.hour >= 0 && h.hour < 24).slice(0, 5) : [];
    if (hours.length) {
      const row = el('div', 'wx-hours');
      row.setAttribute('aria-label', 'Next hours');
      for (const h of hours) {
        const cell = el('div');
        const at = new Date(2000, 0, 1, h.hour).toLocaleTimeString([], { hour: 'numeric' });
        cell.append(el('span', null, at), skyIcon(h.code, h.day !== false), el('span', null, deg(h.temp)));
        cell.setAttribute('aria-label', `${at}: ${deg(h.temp)}, ${WMO[h.code] || ''}`);
        row.append(cell);
      }
      card.body.append(row);
    }
  },

  todoist(w, card) {
    const d = w.data;
    card.head.append(refreshButton(w));
    const open = safeUrl(d.open);
    if (open) card.head.append(openLink(open, 'Open Todoist'));
    if (typeof d.notice === 'string' && d.notice) card.body.append(el('p', 'w-note', d.notice.slice(0, 200)));
    const tasks = Array.isArray(d.tasks) ? d.tasks.filter((t) => t && typeof t.id === 'string' && /^[\w-]{1,40}$/.test(t.id)) : [];
    if (!tasks.length) { card.body.append(el('p', 'w-empty', 'Nothing due today. Enjoy it.')); return; }
    const list = el('div', 'w-list');
    const today = new Date();
    for (const t of tasks) {
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
      if (due) main.append(el('span', `w-sub${t.overdue ? ' late' : ''}`, due));
      row.append(check, main);
      list.append(row);
    }
    card.body.append(list);
    if (int(d.more) > 0) card.body.append(el('p', 'w-more', `${int(d.more)} more in Todoist`));
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
    for (const e of events) {
      const start = e.allDay && /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? new Date(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10)) : new Date(e.start);
      const shown = e.allDay && start < new Date(new Date().setHours(0, 0, 0, 0)) ? new Date() : start; // a multi-day event that began earlier
      const day = dayLabel(shown);
      if (day !== lastDay) { list.append(el('div', 'w-day', day)); lastDay = day; }
      const row = el('div', 'w-row');
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
    }
    card.body.append(list);
  },

  embed(w, card) {
    const d = w.data;
    const url = safeUrl(d.url);
    if (!url) { card.body.append(el('p', 'w-note', 'This address can’t be shown.')); return; }
    const name = text(d.name, 80) || text(d.host, 80) || 'Web page';
    card.head.append(openLink(url, 'Open', name));
    card.el.classList.add('wide', 'embed');
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
    frame.dataset.h = ['small', 'medium', 'large', 'tall'].includes(d.height) ? d.height : 'medium';
    // A page like any other tab's: its own origin, no Lumen privileges, no referrer, no top navigation.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms');
    frame.referrerPolicy = 'no-referrer';
    frame.loading = 'lazy';
    frame.title = name;
    frame.src = url;
    card.body.append(frame);
  },
};

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

// ---- the grid ----
const shownWidgets = new Map(); // id -> { key, el }
function renderWidgets(list) {
  const box = document.getElementById('widgets');
  const valid = (Array.isArray(list) ? list : []).filter((w) => w && widgetId(w.id) && WIDGET_RENDERERS[w.type]).slice(0, 12);
  const cards = valid.map((w) => {
    const key = JSON.stringify(w);
    const kept = shownWidgets.get(w.id);
    if (kept && kept.key === key) return kept.el;
    const card = buildCard(w);
    shownWidgets.set(w.id, { key, el: card });
    return card;
  });
  for (const id of shownWidgets.keys()) if (!valid.some((w) => w.id === id)) shownWidgets.delete(id);
  // Put cards in order, moving only the ones out of place (moving a frame would reload it).
  cards.forEach((card, i) => { if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null); });
  while (box.children.length > cards.length) box.lastChild.remove();
}
function buildCard(w) {
  const title = text(w.title, 60) || 'Widget';
  const cardEl = el('article', `w-card ${w.type}`);
  cardEl.setAttribute('aria-label', title);
  const head = el('div', 'w-head');
  head.append(el('h2', null, title));
  const body = el('div', 'w-body');
  body.style.cssText = 'display:flex;flex-direction:column;flex:1 1 auto;min-height:0';
  cardEl.append(head, body);
  const card = { el: cardEl, head, body };
  if (w.type === 'embed') cardEl.classList.add('wide');
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
  return cardEl;
}
// Events end and "Tomorrow" becomes "Today": the calendar and task cards redraw once a minute.
setInterval(() => {
  for (const [id, s] of shownWidgets) {
    if (s.el.classList.contains('calendar') || s.el.classList.contains('todoist')) shownWidgets.set(id, { key: '', el: s.el });
  }
  const box = document.getElementById('widgets');
  if (!box.querySelector('.w-row.done')) window.dispatchEvent(new HashChangeEvent('hashchange'));
}, 60e3);
window.renderWidgets = renderWidgets;
