// New-tab widgets (Settings → Appearance → New tab page → Widgets): cards on the new-tab page whose
// data the main process fetches. The page itself never goes online. It gets display data only, in
// its hash: widgets: [{ id, type, title, data, error, loading }]. Tokens stay in main.js (encrypted
// with safeStorage) and never reach the page, the hash or settings.json in plain text.
//
// The list is the `homeWidgets` setting: [{ id, type, title, ...config }], in the order shown.
// Opening a new tab shows what is cached at once, fetches whatever is stale in the background, and
// the fresh data reaches every open new-tab page through deps.onUpdate (main.js refreshNewTabs).
//
// Adding a connector is one entry in CONNECTORS below:
//   label             its name in Settings' type picker
//   ttl               how long fetched data stays fresh, in ms
//   secret            (optional) the name of the encrypted key it needs; resolve() may return one to save
//   clean(c)          a stored config -> its checked fields (plain values), or null. Runs on every read.
//   resolve(input, x) Settings' form input -> { config, secret?, message } to store; may look things up
//                     through x (the fetch helpers below). Throws an Error with a message for the user.
//   title(c)          the card's title when the user gave none
//   summary(c)        one line for Settings' list
//   fetch(c, x)       -> the card's data: plain JSON (strings, numbers, arrays). renderer/newtab.js
//                     draws it with textContent only, so nothing from the network is ever markup.
//   act(c, action, x) (optional) a page action (the Todoist checkbox): see actionFrom() below
// and a renderer with the same type in renderer/newtab.js's WIDGET_RENDERERS.
const ics = require('./ics');

const ENDPOINTS = {
  geocode: 'https://geocoding-api.open-meteo.com/v1/search',
  forecast: 'https://api.open-meteo.com/v1/forecast',
  todoist: 'https://api.todoist.com/api/v1', // the unified API (REST v2 was shut down)
};
const MAX_WIDGETS = 12;
const MIN_REFRESH = 15e3; // a widget is fetched at most this often, even when asked
const RATE = { window: 60e3, max: 40 }; // network requests per minute, all widgets together
const ERROR_TTL = 2 * 60e3; // a failed fetch is retried after this
const TIMEOUT = 12e3;

// Text is only ever shown with textContent, so < and > stay (a task called "<b>" reads "<b>").
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// An https address (webcal:// is https), or null. No credentials in it, no spaces or quotes.
function httpsUrl(value, { allowWebcal = false } = {}) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (allowWebcal) text = text.replace(/^webcals?:\/\//i, 'https://');
  if (!/^https:\/\//i.test(text) || text.length > 2000 || /[\s"'<>\\]/.test(text)) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}
const shortPlace = (s) => String(s || '').split(',')[0].trim();

// ---- connectors ----
const CONNECTORS = {
  weather: {
    label: 'Weather',
    ttl: 15 * 60e3,
    clean: (c) => {
      const lat = num(c.lat, -90, 90);
      const lon = num(c.lon, -180, 180);
      const place = str(c.place, 120);
      if (lat === null || lon === null || !place) return null;
      return { place, lat, lon, units: pick(c.units, ['f', 'c'], 'f') };
    },
    async resolve(input, x) {
      const query = str(input.city, 80);
      if (!query) throw new Error('Type a city.');
      const url = `${x.endpoint('geocode')}?${new URLSearchParams({ name: query, count: '1', language: 'en', format: 'json' })}`;
      const found = (await x.json(url)).results?.[0];
      if (!found || num(found.latitude, -90, 90) === null || num(found.longitude, -180, 180) === null) throw new Error(`No place called “${query}” was found.`);
      const place = [...new Set([found.name, found.admin1, found.country].map((p) => str(p, 60)).filter(Boolean))].join(', ');
      return { config: { place, lat: found.latitude, lon: found.longitude, units: pick(input.units, ['f', 'c'], 'f') }, message: `Found ${place}.` };
    },
    title: (c) => shortPlace(c.place),
    summary: (c) => `${c.place} · °${c.units.toUpperCase()}`,
    async fetch(c, x) {
      const params = new URLSearchParams({
        latitude: String(c.lat), longitude: String(c.lon), timezone: 'auto', forecast_days: '5', forecast_hours: '7',
        current: 'temperature_2m,apparent_temperature,weather_code,is_day',
        hourly: 'temperature_2m,weather_code,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min',
        temperature_unit: c.units === 'c' ? 'celsius' : 'fahrenheit',
      });
      const w = await x.json(`${x.endpoint('forecast')}?${params}`);
      const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
      const code = (v) => (Number.isInteger(v) && v >= 0 && v < 100 ? v : null);
      const hourOf = (t) => { const m = /T(\d{2}):/.exec(String(t)); return m ? Number(m[1]) : null; };
      const cur = w.current || {};
      const hourly = w.hourly || {};
      const daily = w.daily || {};
      const at = (list, i) => (Array.isArray(list) ? list[i] : undefined);
      const hours = [];
      for (let i = 1; i < Math.min(7, hourly.time?.length || 0); i++) {
        hours.push({ hour: hourOf(at(hourly.time, i)), temp: round(at(hourly.temperature_2m, i)), code: code(at(hourly.weather_code, i)), day: at(hourly.is_day, i) !== 0 });
      }
      const days = [];
      for (let i = 0; i < Math.min(5, daily.time?.length || 0); i++) {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(at(daily.time, i)) ? at(daily.time, i) : null;
        days.push({ date, hi: round(at(daily.temperature_2m_max, i)), lo: round(at(daily.temperature_2m_min, i)), code: code(at(daily.weather_code, i)) });
      }
      if (round(cur.temperature_2m) === null) throw new Error('The forecast came back empty.');
      return {
        place: c.place, units: c.units,
        temp: round(cur.temperature_2m), feels: round(cur.apparent_temperature), code: code(cur.weather_code), day: cur.is_day !== 0,
        hi: days[0]?.hi ?? null, lo: days[0]?.lo ?? null,
        hours: hours.filter((h) => h.hour !== null && h.temp !== null).slice(0, 5),
        days: days.filter((d) => d.date && d.hi !== null).slice(1, 5),
      };
    },
  },

  calendar: {
    label: 'Calendar (ICS)',
    ttl: 15 * 60e3,
    clean: (c) => {
      const url = httpsUrl(c.url, { allowWebcal: true });
      return url ? { url, name: str(c.name, 80), count: Math.min(8, Math.max(3, Math.round(num(c.count, 3, 8) ?? 5))) } : null;
    },
    async resolve(input, x) {
      const url = httpsUrl(input.url, { allowWebcal: true });
      if (!url) throw new Error('Paste an https:// or webcal:// calendar address.');
      const cal = ics.eventsBetween(await x.text(url, { max: 5e6 }), { days: 14 });
      const upcoming = cal.events.filter((e) => e.allDay || e.end > Date.now());
      const events = cal.total === 1 ? '1 event' : `${cal.total} events`;
      return {
        config: { url, name: cal.name, count: 5 },
        message: `${cal.name ? `${cal.name}: ` : ''}${events}, ${upcoming.length} in the next two weeks.`,
      };
    },
    title: (c) => c.name || 'Calendar',
    summary: (c) => hostOf(c.url),
    async fetch(c, x) {
      const now = Date.now();
      const cal = ics.eventsBetween(await x.text(c.url, { max: 5e6 }), { from: now, days: 14, limit: 60 });
      const events = cal.events.filter((e) => e.allDay || e.end > now).slice(0, c.count)
        .map(({ title, location, url, allDay, date, start, end }) => ({ title: title || 'Busy', location, url, allDay, date: date || null, start, end }));
      return { events, name: cal.name };
    },
  },

  todoist: {
    label: 'Todoist',
    ttl: 5 * 60e3,
    secret: 'todoist',
    clean: () => ({}),
    async resolve(input, x) {
      const token = typeof input.token === 'string' ? input.token.trim() : '';
      if (token && !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error('That doesn’t look like a Todoist API token (Settings → Integrations → Developer in Todoist).');
      if (!token && !x.secret()) throw new Error('Paste your Todoist API token.');
      const tasks = await todoistTasks(x, token || x.secret());
      const n = tasks.length;
      return { config: {}, secret: token || undefined, message: `Connected. ${n === 1 ? '1 task is' : `${n} tasks are`} due today or overdue.` };
    },
    title: () => 'Today',
    summary: () => 'Today and overdue tasks',
    async fetch(_c, x) {
      if (!x.secret()) throw new Error('Add your Todoist API token in Settings.');
      const today = localDate(new Date());
      const tasks = (await todoistTasks(x, x.secret())).map((t) => {
        const due = t.due && typeof t.due === 'object' ? t.due : null;
        const when = str(due?.datetime || due?.date, 30);
        const date = when.slice(0, 10);
        const time = /T\d{2}:\d{2}/.test(when) ? when : null;
        return {
          id: str(String(t.id ?? ''), 40),
          title: str(t.content, 300) || 'Untitled task',
          due: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
          time: time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?$/.test(time) ? time : null,
          overdue: /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today,
          priority: pick(t.priority, [1, 2, 3, 4], 1), // 4 is Todoist's p1 (urgent)
          url: /^[\w-]{1,40}$/.test(String(t.id ?? '')) ? `https://app.todoist.com/app/task/${t.id}` : null,
        };
      }).filter((t) => /^[\w-]{1,40}$/.test(t.id));
      tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.priority - a.priority || String(a.time || a.due).localeCompare(String(b.time || b.due)));
      return { tasks: tasks.slice(0, 8), more: Math.max(0, tasks.length - 8), open: 'https://app.todoist.com/app/today' };
    },
    async act(_c, action, x, cached) {
      if (action.do !== 'complete') return false;
      // Only a task the card is showing can be completed from it.
      if (!cached?.tasks?.some((t) => t.id === action.task)) return false;
      await x.request(`${x.endpoint('todoist')}/tasks/${encodeURIComponent(action.task)}/close`, { method: 'POST', headers: { Authorization: `Bearer ${x.secret()}` } });
      cached.tasks = cached.tasks.filter((t) => t.id !== action.task);
      return true;
    },
  },

  embed: {
    label: 'Web page',
    ttl: 12 * 3600e3, // re-checks whether the site still allows being framed
    clean: (c) => {
      const url = httpsUrl(c.url);
      if (!url) return null;
      return { url, height: pick(c.height, ['small', 'medium', 'large', 'tall'], 'medium'), name: str(c.name, 80) || hostOf(url), frameable: c.frameable !== false, reason: str(c.reason, 120) };
    },
    async resolve(input, x) {
      const url = httpsUrl(input.url);
      if (!url) throw new Error('Paste an https:// address.');
      const check = await framing(url, x);
      return {
        config: { url, height: pick(input.height, ['small', 'medium', 'large', 'tall'], 'medium'), name: check.name, frameable: check.frameable, reason: check.reason },
        message: check.frameable ? `${check.name} can be embedded.` : `${check.name} can’t be embedded (${check.reason}). The card shows an Open button instead.`,
        frameable: check.frameable,
      };
    },
    title: (c) => c.name || hostOf(c.url),
    summary: (c) => `${hostOf(c.url)} · ${c.height}${c.frameable ? '' : ' · opens in a tab'}`,
    async fetch(c, x) {
      const check = await framing(c.url, x).catch(() => ({ frameable: c.frameable, name: c.name })); // offline: keep what Settings found
      return { url: c.url, height: c.height, name: c.name || check.name, host: hostOf(c.url), frameable: check.frameable };
    },
  },
};

// Todoist's tasks due today or overdue (the unified API: /tasks/filter, paged by cursor).
async function todoistTasks(x, token) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ query: 'today | overdue', limit: '50' });
    if (cursor) params.set('cursor', cursor);
    const body = await x.json(`${x.endpoint('todoist')}/tasks/filter?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const results = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null;
    if (!results) throw new Error('Todoist sent something unexpected.');
    out.push(...results.filter((t) => t && typeof t === 'object'));
    cursor = typeof body?.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
    if (!cursor) break;
  }
  return out;
}
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Whether a page lets itself be shown in a frame on the new-tab page, and its title. The new-tab
// page is a file: page, so X-Frame-Options (any value) and a CSP frame-ancestors directive (any
// list: even "*" doesn't match file:, as test/widgets.js checks) always refuse it.
async function framing(url, x) {
  const res = await x.raw(url, { max: 65536 });
  const xfo = res.headers.get('x-frame-options');
  const csp = res.headers.get('content-security-policy') || '';
  const ancestors = csp.split(/[;,]/).map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d));
  const title = str(/<title[^>]*>([^<]{1,200})<\/title>/i.exec(res.body)?.[1]?.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '’').replace(/&quot;/g, '"'), 60);
  const name = title || hostOf(url);
  if (xfo) return { frameable: false, name, reason: `X-Frame-Options: ${str(xfo, 30)}` };
  if (ancestors) return { frameable: false, name, reason: 'its Content-Security-Policy allows only certain sites to frame it' };
  if (!res.ok) return { frameable: false, name, reason: `it answered ${res.status}` };
  return { frameable: true, name, reason: '' };
}

// Settings' form fields -> checked values (what resolve() gets).
function cleanInput(input) {
  const i = input && typeof input === 'object' ? input : {};
  return { type: CONNECTORS[i.type] ? i.type : null, title: str(i.title, 60), city: str(i.city, 80), units: i.units, url: typeof i.url === 'string' ? i.url.slice(0, 2000) : '', height: i.height, token: typeof i.token === 'string' ? i.token.slice(0, 200) : '' };
}

// A stored widget -> { id, type, title, ...config } with every field checked, or null.
function cleanWidget(w) {
  if (!w || typeof w !== 'object' || !CONNECTORS[w.type] || typeof w.id !== 'string' || !/^w[0-9a-z]{4,20}$/.test(w.id)) return null;
  const config = CONNECTORS[w.type].clean(w);
  return config ? { id: w.id, type: w.type, title: str(w.title, 60), ...config } : null;
}
// The homeWidgets setting, checked (settings-backend.js validate()).
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  return list.map(cleanWidget).filter((w) => w && !seen.has(w.id) && seen.add(w.id)).slice(0, MAX_WIDGETS);
}

// deps: { readSettings, writeSettings, fetch (Electron's net.fetch), getSecret(name), setSecret(name, value|null),
//         onUpdate(), endpoints() (test overrides; {} otherwise), now? }
function createWidgets(deps) {
  const cache = new Map(); // id -> { data, error, at, key, pending }
  const recent = []; // times of recent network requests (the rate limit)
  const now = () => (deps.now ? deps.now() : Date.now());

  const list = () => cleanList(deps.readSettings().homeWidgets) || [];
  const save = (widgets) => deps.writeSettings({ ...deps.readSettings(), homeWidgets: widgets });
  const keyOf = (w) => JSON.stringify(w); // a changed config invalidates its cached data

  // ---- network helpers handed to connectors (x) ----
  function spend() {
    const t = now();
    while (recent.length && t - recent[0] > RATE.window) recent.shift();
    if (recent.length >= RATE.max) throw new Error('Too many requests right now. Try again in a minute.');
    recent.push(t);
  }
  async function request(url, { method = 'GET', headers = {}, max = 2e6 } = {}) {
    if (!/^https:\/\//.test(url)) throw new Error('Only https addresses are allowed.');
    spend();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    let res;
    try {
      res = await deps.fetch(url, { method, headers: { Accept: '*/*', ...headers }, signal: controller.signal, credentials: 'omit', redirect: 'follow', cache: 'no-store' });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(err.name === 'AbortError' ? 'The server took too long to answer.' : 'Couldn’t connect. Check your internet connection.');
    }
    try {
      if (res.url && !/^https:\/\//.test(res.url)) throw new Error('The address redirected away from https.');
      // Read at most `max` bytes: a huge or endless answer can't eat memory.
      const reader = res.body?.getReader();
      const chunks = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { chunks.push(value.subarray(0, value.length - (size - max))); await reader.cancel().catch(() => {}); break; }
        chunks.push(value);
      }
      return { ok: res.ok, status: res.status, headers: res.headers, url: res.url, body: Buffer.concat(chunks).toString('utf8'), truncated: size > max };
    } finally {
      clearTimeout(timer);
    }
  }
  const failure = (res) => {
    if (res.status === 401 || res.status === 403) return new Error('The token was refused. Check it in Settings.');
    if (res.status === 404) return new Error('Nothing was found at that address.');
    if (res.status === 429) return new Error('The service is busy. Lumen will try again shortly.');
    return new Error(`The server answered ${res.status}.`);
  };
  function helpers(secretName, secretOverride) {
    return {
      endpoint: (name) => deps.endpoints?.()[name] || ENDPOINTS[name],
      secret: () => secretOverride || (secretName ? deps.getSecret(secretName) : null),
      raw: (url, opts) => request(url, opts),
      async request(url, opts) {
        const res = await request(url, { max: 65536, ...opts });
        if (!res.ok) throw failure(res);
        return res;
      },
      async json(url, opts) {
        const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...opts?.headers } });
        if (!res.ok) throw failure(res);
        try { return JSON.parse(res.body); } catch { throw new Error('The service sent something unexpected.'); }
      },
      async text(url, opts) {
        const res = await request(url, opts);
        if (!res.ok) throw failure(res);
        if (res.truncated) throw new Error('That file is too big.');
        return res.body;
      },
    };
  }

  // ---- fetching ----
  function refresh(w, { force = false } = {}) {
    const c = connector(w);
    let entry = cache.get(w.id);
    if (!entry || entry.key !== keyOf(w)) { entry = { key: keyOf(w), data: null, error: null, at: 0 }; cache.set(w.id, entry); }
    if (entry.pending) return entry.pending;
    const age = now() - entry.at;
    const fresh = entry.at && age < (entry.error ? ERROR_TTL : c.ttl);
    if (fresh && (!force || age < MIN_REFRESH)) return Promise.resolve(false);
    entry.pending = Promise.resolve()
      .then(() => c.fetch(w, helpers(c.secret)))
      .then((data) => { entry.data = data; entry.error = null; }, (err) => { entry.error = String(err?.message || err).slice(0, 200); })
      .then(() => { entry.at = now(); entry.pending = null; deps.onUpdate?.(); return true; });
    return entry.pending;
  }
  const connector = (w) => CONNECTORS[w.type];
  // What the new-tab page shows now; stale widgets refresh in the background.
  function forPage() {
    return list().map((w) => {
      const entry = cache.get(w.id);
      const current = entry && entry.key === keyOf(w) ? entry : null;
      if (!current?.pending) refresh(w).catch((err) => console.error('[lumen] widget refresh:', err.message));
      return { id: w.id, type: w.type, title: w.title || connector(w).title(w), data: current?.data ?? null, error: current?.data ? null : current?.error ?? null, loading: !current?.data && !current?.error };
    });
  }
  function refreshAll({ force = false } = {}) {
    return Promise.all(list().map((w) => refresh(w, { force })));
  }

  // ---- Settings ----
  async function resolveInput(input, id = null) {
    const i = cleanInput(input);
    if (!i.type) throw new Error('Pick a kind of widget.');
    const c = CONNECTORS[i.type];
    const out = await c.resolve(i, helpers(c.secret));
    const config = c.clean(out.config);
    if (!config) throw new Error('That didn’t check out. Try again.');
    return { widget: { id: id || newId(), type: i.type, title: i.title, ...config }, secret: out.secret, message: out.message, ok: out.frameable !== false };
  }
  const newId = () => `w${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // "Check": look the input up without saving anything.
  async function test(input) {
    try {
      const { message, ok } = await resolveInput(input);
      return { ok, message };
    } catch (err) {
      return { ok: false, error: true, message: String(err?.message || err) };
    }
  }
  // Add (no id) or replace a widget. The token, if any, is saved encrypted, never in the widget.
  async function saveWidget(input, id = null) {
    const widgets = list();
    if (id && !widgets.some((w) => w.id === id)) throw new Error('That widget is gone.');
    if (!id && widgets.length >= MAX_WIDGETS) throw new Error(`Up to ${MAX_WIDGETS} widgets.`);
    const { widget, secret, message } = await resolveInput(input, id);
    if (secret && CONNECTORS[widget.type].secret) deps.setSecret(CONNECTORS[widget.type].secret, secret);
    const next = id ? widgets.map((w) => (w.id === id ? widget : w)) : [...widgets, widget];
    save(next);
    cache.delete(widget.id);
    if (secret) for (const w of next) if (w.type === widget.type) cache.delete(w.id);
    deps.onUpdate?.();
    refresh(widget).catch(() => {});
    return { widget, message };
  }
  function remove(id) {
    const widgets = list();
    const gone = widgets.find((w) => w.id === id);
    const next = widgets.filter((w) => w.id !== id);
    save(next);
    cache.delete(id);
    // The last widget that used a token takes the token with it.
    const secret = gone && CONNECTORS[gone.type].secret;
    if (secret && !next.some((w) => CONNECTORS[w.type].secret === secret)) deps.setSecret(secret, null);
    deps.onUpdate?.();
    return true;
  }
  function move(id, delta) {
    const widgets = list();
    const i = widgets.findIndex((w) => w.id === id);
    const j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= widgets.length) return false;
    [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
    save(widgets);
    deps.onUpdate?.();
    return true;
  }
  // For Settings: the list with a line each, and which secrets are stored (never their values).
  function state() {
    return {
      widgets: list().map((w) => ({ ...w, title: w.title || connector(w).title(w), customTitle: w.title, summary: connector(w).summary(w), label: connector(w).label, error: cache.get(w.id)?.error || null })),
      types: Object.entries(CONNECTORS).map(([type, c]) => ({ type, label: c.label })),
      secrets: Object.fromEntries([...new Set(Object.values(CONNECTORS).map((c) => c.secret).filter(Boolean))].map((s) => [s, Boolean(deps.getSecret(s))])),
      max: MAX_WIDGETS,
    };
  }

  // ---- page actions ----
  // The new-tab page asks by loading itself with ?widget=<id>&do=<action>[&task=<id>] (like its Ask
  // AI box); main.js cancels that navigation and passes the URL here. True when it was one.
  function actionFrom(url) {
    let params;
    try { params = new URL(url).searchParams; } catch { return null; }
    const id = params.get('widget');
    if (id === null) return null;
    const action = { id, do: params.get('do'), task: params.get('task') };
    if (!/^w[0-9a-z]{4,20}$/.test(id) || !/^(refresh|complete)$/.test(action.do || '') || (action.task !== null && !/^[\w-]{1,40}$/.test(action.task))) return { invalid: true };
    return action;
  }
  async function act(action) {
    const w = list().find((x) => x.id === action.id);
    if (!w) return false;
    if (action.do === 'refresh') return refresh(w, { force: true });
    const c = connector(w);
    const entry = cache.get(w.id);
    if (!c.act || !entry?.data) return false;
    try {
      const done = await c.act(w, action, helpers(c.secret), entry.data);
      if (!done) return false;
      deps.onUpdate?.(); // the task leaves the card at once
      entry.at = 0; // and the list is fetched again
      setTimeout(() => refresh(w).catch(() => {}), 800);
      return true;
    } catch (err) {
      entry.error = String(err?.message || err).slice(0, 200);
      entry.data = { ...entry.data, notice: entry.error };
      deps.onUpdate?.();
      return false;
    }
  }

  return { list, forPage, refresh, refreshAll, test, save: saveWidget, remove, move, state, actionFrom, act, cache };
}

module.exports = { createWidgets, cleanList, cleanWidget, httpsUrl, CONNECTORS, ENDPOINTS };
