// New-tab widgets (Settings → Appearance → New tab page → Widgets): cards on the new-tab page whose
// data the main process fetches. The page itself never goes online. It gets display data only, in
// its hash: widgets: [{ id, type, title, data, error, loading }]. Tokens stay in main.js (encrypted
// with safeStorage) and never reach the page, the hash or settings.json in plain text.
//
// The list is the `homeWidgets` setting: [{ id, type, title, x, y, w, h, snap?, span, ...config }],
// in reading order. x, y, w, h are the card's cells in the page's 12-column grid (features/
// widget-layout.js does all the arithmetic); span (and an embed's height) mirror w and h in the
// units older Lumens used, and are what a list without x, y, w, h (an older one) is migrated from.
// The page moves and resizes cards by asking for a whole new layout (do=layout, through actionFrom()).
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
// and a renderer with the same type in renderer/newtab-widgets.js's WIDGET_RENDERERS.
//
// A connector with `secret` keeps one encrypted string under that name (main.js widgetSecret). For a
// token (Todoist) that is the token itself. For an OAuth sign-in (Gmail) it is a small JSON blob of
// client id, client secret and refresh token (features/oauth.js encodeCreds), written by the sign-in
// and the token refresh, and never read by anything but this file: the access token lives only in
// memory (x.session()), and none of it ever reaches the page, the hash or settings.json in plain text.
//   x.session(creds?)   the OAuth account for this connector's secret (or for creds, to check them)
//   x.backoff(ms)       no requests for a while (a service's own rate-limit answer)
const ics = require('./ics');
const WL = require('./widget-layout');
const TV = require('./todoist-view');
const WX = require('./weather-view');
const WC = require('./widget-colors');
const GV = require('./gmail-view');
const OA = require('./oauth');

const ENDPOINTS = {
  geocode: 'https://geocoding-api.open-meteo.com/v1/search',
  forecast: 'https://api.open-meteo.com/v1/forecast',
  // "My location": which city this network is in (no key). Asked only after the user agreed, only
  // from this process; it sees the IP address and nothing else of ours is sent.
  locate: 'https://ipapi.co/json/',
  todoist: 'https://api.todoist.com/api/v1', // the unified API (REST v2 was shut down)
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth', // opened in the user's own browser, never in Lumen
  googleToken: 'https://oauth2.googleapis.com/token',
  googleRevoke: 'https://oauth2.googleapis.com/revoke',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
};
const MAX_WIDGETS = 12;
const SPANS = WL.SPANS; // what older Lumens stored: a third, half, two thirds, the full width
const HEIGHTS = ['small', 'medium', 'large', 'tall']; // a web page's frame
const defaultSpan = (type) => (type === 'embed' ? 6 : 3);
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
const LOCATE_SERVICE = 'ipapi.co';
// Geocoding (Open-Meteo, keyless): a city or postal code -> [{ name, lat, lon }] with region and country.
async function searchPlaces(x, query) {
  const url = `${x.endpoint('geocode')}?${new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' })}`;
  const out = [];
  for (const r of (await x.json(url)).results || []) {
    if (!r || num(r.latitude, -90, 90) === null || num(r.longitude, -180, 180) === null) continue;
    const name = [...new Set([r.name, r.admin1, r.country].map((p) => str(p, 60)).filter(Boolean))].join(', ');
    if (name) out.push({ name, lat: r.latitude, lon: r.longitude });
  }
  return out;
}

// ---- connectors ----
const CONNECTORS = {
  // Places, units, sections: c.wx (features/weather-view.js). An older widget has only place, lat, lon
  // and units, and that place becomes its first one. "My location" (wx.places[].here) is asked of an IP
  // service by x.here(), only after the user agreed (Settings, or the card's own question).
  weather: {
    label: 'Weather',
    ttl: 15 * 60e3,
    clean: (c) => {
      const wx = WX.cleanConfig(c.wx, c);
      return wx ? { ...WX.mirrorPlace(wx, null), units: wx.units, wx, colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      let places = WX.cleanPlaces(input.wx?.places);
      let message = places.length === 1 ? `${places[0].here ? 'My location' : places[0].name} is ready.` : `${places.length} places are ready.`;
      if (!places.length) { // the older form: a typed city
        const query = str(input.city, 80);
        if (!query) throw new Error('Type a city, or search for a place.');
        const found = (await searchPlaces(x, query))[0];
        if (!found) throw new Error(`No place called “${query}” was found.`);
        places = [{ name: found.name, lat: found.lat, lon: found.lon }];
        message = `Found ${found.name}.`;
      }
      const wx = WX.cleanConfig({ ...input.wx, places, units: pick(input.units, ['f', 'c'], input.wx?.units) }, {});
      return { config: { ...WX.mirrorPlace(wx, null), units: wx.units, wx, colors: WC.cleanMode(input.colors) }, message };
    },
    title: (c) => (c.wx.places.length > 1 ? 'Weather' : c.wx.places[0].here ? c.wx.places[0].nick || 'My location' : WX.placeLabel(c.wx.places[0])),
    summary: (c) => `${c.wx.places.map((p) => (p.here ? 'My location' : WX.placeLabel(p))).join(', ')} · °${c.wx.units.toUpperCase()}`,
    async fetch(c, x) {
      const wx = c.wx;
      const places = [];
      let ask = false;
      let hereNote = '';
      for (const p of wx.places) {
        let real = p;
        if (p.here) {
          const at = await x.here();
          if (at.status === 'consent') { ask = true; continue; }
          if (at.status !== 'ok') { hereNote = at.message || 'My location is off.'; continue; }
          real = { name: at.place.name, lat: at.place.lat, lon: at.place.lon, nick: p.nick };
        }
        try {
          const shaped = await x.memo(`wx:${real.lat},${real.lon}:${wx.units}:${wx.wind}:${wx.days}:${wx.hours}`, 10 * 60e3, async () => {
            const s = WX.shape(await x.json(`${x.endpoint('forecast')}?${new URLSearchParams(WX.forecastParams(real, wx))}`), wx);
            if (!s) throw new Error('The forecast came back empty.');
            return s;
          });
          places.push({ name: real.name, label: WX.placeLabel(real), here: Boolean(p.here), approximate: Boolean(p.here), ...shaped });
        } catch (err) {
          places.push({ name: real.name, label: WX.placeLabel(real), here: Boolean(p.here), error: String(err?.message || err).slice(0, 200) });
        }
      }
      if (places.length && places.every((p) => p.error)) throw new Error(places[0].error);
      return {
        places, ask, hereNote, units: wx.units, windLabel: WX.WIND_LABELS[WX.windUnit(wx)], precipUnit: WX.precipUnit(wx),
        clock: wx.clock, view: wx.view, show: wx.show, days: wx.days, hours: wx.hours, service: LOCATE_SERVICE,
        hourLabels: Object.fromEntries([...Array(24).keys()].map((h) => [h, WX.hourLabel(h, wx.clock)])),
      };
    },
  },

  calendar: {
    label: 'Calendar (ICS)',
    ttl: 15 * 60e3,
    clean: (c) => {
      const url = httpsUrl(c.url, { allowWebcal: true });
      return url ? { url, name: str(c.name, 80), count: Math.min(8, Math.max(3, Math.round(num(c.count, 3, 8) ?? 5))), colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      const url = httpsUrl(input.url, { allowWebcal: true });
      if (!url) throw new Error('Paste an https:// or webcal:// calendar address.');
      const cal = ics.eventsBetween(await x.text(url, { max: 5e6 }), { days: 14 });
      const upcoming = cal.events.filter((e) => e.allDay || e.end > Date.now());
      const events = cal.total === 1 ? '1 event' : `${cal.total} events`;
      return {
        config: { url, name: cal.name, count: 5, colors: WC.cleanMode(input.colors) },
        message: `${cal.name ? `${cal.name}: ` : ''}${events}, ${upcoming.length} in the next two weeks.`,
      };
    },
    title: (c) => c.name || 'Calendar',
    summary: (c) => hostOf(c.url),
    async fetch(c, x) {
      const now = Date.now();
      const cal = ics.eventsBetween(await x.text(c.url, { max: 5e6 }), { from: now, days: 14, limit: 60 });
      const events = cal.events.filter((e) => e.allDay || e.end > now).slice(0, 12)
        .map(({ title, location, url, color, allDay, date, start, end }) => ({ title: title || 'Busy', location, url, color: color || '', allDay, date: date || null, start, end }));
      return { events, name: cal.name, color: cal.color || '' };
    },
  },

  todoist: {
    label: 'Todoist',
    ttl: 5 * 60e3,
    secret: 'todoist',
    // What it shows is c.todo (features/todoist-view.js); an older widget has none: today and overdue.
    clean: (c) => ({ todo: TV.cleanConfig(c.todo), colors: WC.cleanMode(c.colors) }),
    async resolve(input, x) {
      const token = typeof input.token === 'string' ? input.token.trim() : '';
      if (token && !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error('That doesn’t look like a Todoist API token (Settings → Integrations → Developer in Todoist).');
      if (!token && !x.secret()) throw new Error('Paste your Todoist API token.');
      const todo = TV.cleanConfig(input.todo);
      const tasks = await todoistTasks(x, token || x.secret(), todo);
      const n = tasks.length;
      const what = { todayOverdue: 'due today or overdue', today: 'due today', upcoming: `due in the next ${todo.days} days`, inbox: 'in the Inbox', project: 'in that project', label: 'with that label', all: 'open', custom: 'matching that filter' }[todo.source];
      return { config: { todo, colors: WC.cleanMode(input.colors) }, secret: token || undefined, message: `Connected. ${n === 1 ? '1 task is' : `${n} tasks are`} ${what}.` };
    },
    title: (c) => TV.nameFor(c.todo),
    summary: (c) => TV.summaryFor(c.todo),
    async fetch(c, x) {
      if (!x.secret()) throw new Error('Add your Todoist API token in Settings.');
      const today = TV.ymd(new Date());
      const projects = await x.projects().catch(() => new Map());
      const tasks = (await todoistTasks(x, x.secret(), c.todo)).map((t) => TV.normalizeTask(t, projects, today)).filter(Boolean);
      const done = c.todo.showDone ? await completedToday(x).catch(() => []) : [];
      const project = c.todo.source === 'project' && c.todo.projectId ? `https://app.todoist.com/app/project/${c.todo.projectId}` : null;
      return {
        ...TV.shape(tasks, c.todo, today), done,
        open: project || 'https://app.todoist.com/app/today',
        density: c.todo.density, overdueRed: c.todo.overdueRed, showCount: c.todo.showCount, quick: c.todo.quick,
      };
    },
    // Page actions: complete (the caller then keeps an undo for a few seconds), undo (reopen it), add (quick add).
    async act(c, action, x, cached) {
      const find = (id) => cached.groups?.flatMap((g) => g.tasks).find((t) => t.id === id);
      const auth = { Authorization: `Bearer ${x.secret()}` };
      if (action.do === 'complete') {
        const task = find(action.task); // only a task the card is showing can be completed from it
        if (!task) return false;
        await x.request(`${x.endpoint('todoist')}/tasks/${encodeURIComponent(action.task)}/close`, { method: 'POST', headers: auth });
        for (const g of cached.groups) g.tasks = g.tasks.filter((t) => t.id !== action.task);
        cached.groups = cached.groups.filter((g) => g.tasks.length);
        cached.total = Math.max(0, cached.total - 1);
        cached.shown = Math.max(0, cached.shown - 1);
        return { undo: { id: action.task, title: task.title } };
      }
      if (action.do === 'undo') {
        await x.request(`${x.endpoint('todoist')}/tasks/${encodeURIComponent(action.task)}/reopen`, { method: 'POST', headers: auth });
        return { undone: true };
      }
      if (action.do === 'add') {
        if (c.todo.quick === 'off' || !action.text) return false;
        const made = await x.postJson(`${x.endpoint('todoist')}/tasks/quick`, { text: action.text });
        // Quick add reads the due date out of the words; the project (its name can have spaces) is set after.
        if (c.todo.quickProjectId && made && typeof made === 'object' && String(made.project_id) !== c.todo.quickProjectId && /^[\w-]{1,40}$/.test(String(made.id))) {
          await x.postJson(`${x.endpoint('todoist')}/tasks/${encodeURIComponent(String(made.id))}/move`, { project_id: c.todo.quickProjectId }).catch(() => {});
        }
        return { added: true };
      }
      return false;
    },
  },

  // Read-only inbox summary: the unread count and the latest few subjects, senders and snippets. Signs
  // in with the user's own Google Cloud OAuth client (features/oauth.js); see features/gmail-view.js.
  gmail: {
    label: 'Gmail',
    ttl: 5 * 60e3,
    secret: 'gmail',
    clean: (c) => { const g = GV.cleanConfig(c); return g ? { ...g, colors: WC.cleanMode(c.colors) } : null; },
    async resolve(input, x) {
      const clientId = GV.cleanClientId(input.clientId);
      if (!clientId) throw new Error('Paste the Client ID of your Google Cloud OAuth client (it ends in .apps.googleusercontent.com).');
      const typed = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
      if (typed && !GV.cleanClientSecret(typed)) throw new Error('That doesn’t look like a Google client secret.');
      const stored = OA.decodeCreds(x.secret());
      const same = stored?.clientId === clientId;
      const creds = { clientId, clientSecret: typed || (same ? stored.clientSecret : ''), refresh: same ? stored.refresh : '' };
      if (!creds.clientSecret) throw new Error('Paste the client secret shown next to the Client ID in Google Cloud.');
      if (!creds.refresh) throw new Error('Connect your Google account first: use Connect Gmail.');
      const cfg = GV.cleanConfig({ ...input, clientId });
      const data = await gmailData(x, x.session(creds), { ...cfg, count: 3 });
      const changed = !stored || stored.clientId !== creds.clientId || stored.clientSecret !== creds.clientSecret || stored.refresh !== creds.refresh;
      return { config: { ...cfg, colors: WC.cleanMode(input.colors) }, secret: changed ? OA.encodeCreds(creds) : undefined, message: `Connected. ${data.unread === 1 ? '1 unread message' : `${data.unread} unread messages`} in the inbox.` };
    },
    title: () => 'Gmail',
    summary: (c) => `Inbox · ${c.count} latest`,
    async fetch(c, x) {
      const session = x.session();
      if (!session.connected()) return GV.reconnect('Connect Gmail in Settings.');
      try {
        return await gmailData(x, session, c);
      } catch (err) {
        if (err?.reconnect) return GV.reconnect(err.message); // a revoked grant is a state the card shows, not an error
        throw err;
      }
    },
  },

  embed: {
    label: 'Web page',
    ttl: 12 * 3600e3, // re-checks whether the site still allows being framed
    clean: (c) => {
      const url = httpsUrl(c.url);
      if (!url) return null;
      return { url, height: pick(c.height, HEIGHTS, 'medium'), name: str(c.name, 80) || hostOf(url), frameable: c.frameable !== false, reason: str(c.reason, 120) };
    },
    async resolve(input, x) {
      const url = httpsUrl(input.url);
      if (!url) throw new Error('Paste an https:// address.');
      const check = await framing(url, x);
      return {
        config: { url, height: pick(input.height, HEIGHTS, 'medium'), name: check.name, frameable: check.frameable, reason: check.reason },
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

// Todoist's tasks for a widget's question (a filter query, or a project's own list; the unified API,
// paged by cursor). Shared for a minute between widgets asking the same thing.
async function todoistTasks(x, token, cfg) {
  const question = TV.questionFor(cfg);
  return x.memo(`tasks:${token.length}:${token.slice(-6)}:${JSON.stringify(question)}`, 60e3, async () => {
    const out = [];
    let cursor = null;
    for (let page = 0; page < Math.ceil(TV.FETCH_LIMIT / 50); page++) {
      const params = new URLSearchParams(question.projectId ? { project_id: question.projectId, limit: '50' } : { query: question.query, limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const body = await x.json(`${x.endpoint('todoist')}/tasks${question.projectId ? '' : '/filter'}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const results = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null;
      if (!results) throw new Error('Todoist sent something unexpected.');
      out.push(...results.filter((t) => t && typeof t === 'object'));
      cursor = typeof body?.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
      if (!cursor) break;
    }
    return out;
  });
}
// The projects (id -> { name, color }): names and colours for the cards, and Settings' picker.
async function todoistProjects(x, token) {
  return x.memo(`projects:${token.length}:${token.slice(-6)}`, 10 * 60e3, async () => {
    const map = new Map();
    let cursor = null;
    for (let page = 0; page < 4; page++) {
      const params = new URLSearchParams({ limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const body = await x.json(`${x.endpoint('todoist')}/projects?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const results = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null;
      if (!results) throw new Error('Todoist sent something unexpected.');
      for (const p of results) if (p && /^[\w-]{1,40}$/.test(String(p.id ?? ''))) map.set(String(p.id), { name: str(p.name, 60) || 'Project', color: p.color });
      cursor = typeof body?.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
      if (!cursor) break;
    }
    return map;
  });
}
// Tasks completed today, for the struck-through section ("show completed today").
async function completedToday(x) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const params = new URLSearchParams({ since: start.toISOString(), until: new Date(start.getTime() + 86400e3).toISOString(), limit: '30' });
  return x.memo(`done:${params}`, 60e3, async () => {
    const body = await x.json(`${x.endpoint('todoist')}/tasks/completed/by_completion_date?${params}`, { headers: { Authorization: `Bearer ${x.secret()}` } });
    const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.results) ? body.results : [];
    return items.map((i) => ({ id: str(String(i?.task_id ?? i?.id ?? ''), 40), title: str(i?.content, 300) })).filter((i) => /^[\w-]{1,40}$/.test(i.id) && i.title).slice(0, 10);
  });
}

// Gmail's inbox: the label (unread count), the newest ids, then each message's headers (in parallel).
async function gmailData(x, session, cfg) {
  try {
    const label = await gmailGet(x, session, GV.labelPath());
    const ids = GV.messageIds(await gmailGet(x, session, GV.listPath(cfg.count)), cfg.count);
    const failed = [];
    const got = await Promise.all(ids.map((id) => gmailGet(x, session, GV.messagePath(id)).catch((err) => { failed.push(err); return null; })));
    const messages = got.filter(Boolean);
    if (ids.length && !messages.length) throw failed[0];
    return GV.shape(label, messages, cfg);
  } catch (err) {
    if (err?.retryAfter) x.backoff(err.retryAfter);
    throw err;
  }
}
// One GET with the bearer token. A 401 gets a fresh token and one more try; what still fails is
// explained by GV.apiError (revoked grant -> err.reconnect, rate limit -> err.retryAfter).
async function gmailGet(x, session, path) {
  for (let attempt = 0; ; attempt++) {
    const access = await session.access({ force: attempt > 0 });
    const res = await x.raw(`${x.endpoint('gmail')}${path}`, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' }, max: 1e6 });
    if (res.status === 401 && attempt === 0) { session.invalidate(); continue; }
    if (res.ok) {
      try { return JSON.parse(res.body); } catch { throw new Error('Gmail sent something unexpected.'); }
    }
    const e = GV.apiError(res.status, res.body);
    throw new OA.OAuthError(e.message, { reconnect: Boolean(e.reconnect), kind: e.rate ? 'rate' : 'other', retryAfter: e.rate ? OA.classifyTokenFailure(429, '', res.headers.get('retry-after')).retryAfter : 0 });
  }
}

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
  return { type: CONNECTORS[i.type] ? i.type : null, title: str(i.title, 60), city: str(i.city, 80), units: i.units, colors: i.colors, url: typeof i.url === 'string' ? i.url.slice(0, 2000) : '', height: i.height, span: pick(Number(i.span), SPANS, null), token: typeof i.token === 'string' ? i.token.slice(0, 200) : '', todo: i.todo, wx: i.wx,
    clientId: typeof i.clientId === 'string' ? i.clientId.slice(0, 300) : '', clientSecret: typeof i.clientSecret === 'string' ? i.clientSecret.slice(0, 300) : '', count: i.count, snippets: i.snippets };
}

// A stored widget -> { id, type, title, x, y, w, h, snap?, span, ...config } with every field checked, or null.
// x, y, w, h are left out when they aren't four integers (an older list, or garbage): cleanList places those.
function cleanWidget(w) {
  if (!w || typeof w !== 'object' || !CONNECTORS[w.type] || typeof w.id !== 'string' || !/^w[0-9a-z]{4,20}$/.test(w.id)) return null;
  const config = CONNECTORS[w.type].clean(w);
  if (!config) return null;
  const out = { id: w.id, type: w.type, title: str(w.title, 60), span: pick(w.span, SPANS, defaultSpan(w.type)), ...config };
  const rect = WL.cleanRect(w.type, w); // w.x, w.y, w.w, w.h
  if (rect) {
    Object.assign(out, rect);
    const snap = WL.cleanSnap(w.snap);
    if (snap) out.snap = snap;
  }
  return out;
}
const hasRect = (w) => Number.isInteger(w.x);
// Every widget gets a place: an older list is migrated from span and height (same order and sizes),
// a widget without one goes in the first free spot, overlaps are pushed down, and span/height are
// kept in step (what an older Lumen reads); the list stays in reading order.
function layoutAll(items) {
  if (!items.length) return items;
  let rects;
  if (!items.some(hasRect)) {
    rects = WL.fromLegacy(items);
  } else {
    const taken = items.filter(hasRect).map(WL.rectOf);
    rects = items.map((it) => {
      if (hasRect(it)) return WL.rectOf(it);
      const size = WL.sizeFromLegacy(it.type, it.span, it.height);
      const r = { ...WL.firstFit(taken, size), ...size };
      taken.push(r);
      return r;
    });
  }
  const laid = WL.resolve(items.map((it, i) => ({ id: it.id, type: it.type, ...rects[i], ...(it.snap && hasRect(it) ? { snap: it.snap } : {}) })), { packed: false });
  const out = items.map((it, i) => {
    const { x, y, w, h, snap } = laid[i];
    const next = { ...it, x, y, w, h, ...WL.mirror(it.type, { w, h }) };
    if (snap) next.snap = snap; else delete next.snap;
    return next;
  });
  return WL.flowOrder(out);
}
// The homeWidgets setting, checked (settings-backend.js validate()).
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  return layoutAll(list.map(cleanWidget).filter((w) => w && !seen.has(w.id) && seen.add(w.id)).slice(0, MAX_WIDGETS));
}
// The last size used per kind of widget (the default for a new one): { weather: { w, h }, ... }.
function cleanSizes(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const type of Object.keys(CONNECTORS)) {
    const r = WL.cleanRect(type, { x: 0, y: 0, w: v[type]?.w, h: v[type]?.h });
    if (r) out[type] = { w: r.w, h: r.h };
  }
  return out;
}
const toItem = (w) => ({ id: w.id, type: w.type, x: w.x, y: w.y, w: w.w, h: w.h, ...(w.snap ? { snap: w.snap } : {}) });
function applyRects(widgets, items) {
  return widgets.map((w) => {
    const r = items.find((i) => i.id === w.id);
    if (!r) return w;
    const next = { ...w, x: r.x, y: r.y, w: r.w, h: r.h };
    if (r.snap) next.snap = r.snap; else delete next.snap;
    return next;
  });
}

// deps: { readSettings, writeSettings, fetch (Electron's net.fetch), getSecret(name), setSecret(name, value|null),
//         onUpdate(), onConfigure(id)?, endpoints() (test overrides; {} otherwise), now?, undoMs?,
//         openExternal(url)? (the user's default browser, for OAuth consent pages), signInMs? }
function createWidgets(deps) {
  const cache = new Map(); // id -> { data, error, at, key, pending, undo }
  const recent = []; // times of recent network requests (the rate limit)
  const memoCache = new Map(); // shared answers: what Todoist said to a question a minute ago
  let backoffUntil = 0; // after a 429: no requests until then
  let pendingEdit = null; // a card's gear: the Settings page opens this widget's editor
  const now = () => (deps.now ? deps.now() : Date.now());
  const UNDO_MS = deps.undoMs ?? 6000;

  const list = () => cleanList(deps.readSettings().homeWidgets) || [];
  const save = (widgets, extra = {}) => deps.writeSettings({ ...deps.readSettings(), homeWidgets: cleanList(widgets), ...extra });
  const sizes = () => cleanSizes(deps.readSettings().homeWidgetSizes);
  const sizeFor = (type) => sizes()[type] || WL.DEFAULT_SIZE[type] || { w: 4, h: 3 };
  // A changed config invalidates its cached data; its size and place on the page don't.
  const keyOf = ({ span, height, x, y, w, h, snap, colors, ...rest }) => JSON.stringify(rest);

  let epoch = 0; // flush() bumps it: an answer that was in flight is not kept
  async function memo(key, ttl, fn) {
    const hit = memoCache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const born = epoch;
    const value = await fn();
    if (born !== epoch) return value;
    memoCache.set(key, { at: now(), value });
    if (memoCache.size > 60) memoCache.delete(memoCache.keys().next().value);
    return value;
  }
  const forget = (prefix) => { for (const k of [...memoCache.keys()]) if (k.startsWith(prefix)) memoCache.delete(k); };

  // ---- network helpers handed to connectors (x) ----
  function spend() {
    const t = now();
    if (t < backoffUntil) throw new Error('The service asked Lumen to slow down. It will try again shortly.');
    while (recent.length && t - recent[0] > RATE.window) recent.shift();
    if (recent.length >= (Number(deps.rateMax?.()) || RATE.max)) throw new Error('Too many requests right now. Try again in a minute.');
    recent.push(t);
  }
  async function request(url, { method = 'GET', headers = {}, max = 2e6, body } = {}) {
    if (!/^https:\/\//.test(url)) throw new Error('Only https addresses are allowed.');
    spend();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    let res;
    try {
      res = await deps.fetch(url, { method, headers: { Accept: '*/*', ...headers }, body, signal: controller.signal, credentials: 'omit', redirect: 'follow', cache: 'no-store' });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(err.name === 'AbortError' ? 'The server took too long to answer.' : 'Couldn’t connect. Check your internet connection.');
    }
    try {
      if (res.url && !/^https:\/\//.test(res.url)) throw new Error('The address redirected away from https.');
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after'));
        backoffUntil = now() + Math.min(120e3, Math.max(5e3, Number.isFinite(wait) && wait > 0 ? wait * 1000 : 60e3));
      }
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
  // A form POST to an OAuth token endpoint: { ok, status, body, retryAfter } (a failure is an answer, not a throw).
  async function formPost(url, body) {
    const res = await request(url, { method: 'POST', max: 65536, body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
    return { ok: res.ok, status: res.status, body: res.body, retryAfter: res.headers.get('retry-after') };
  }
  // OAuth accounts by secret name: the access token is kept here, in memory, and the refresh token in
  // the encrypted secret (a JSON blob, see features/oauth.js).
  const sessions = new Map();
  const tokenUrl = () => deps.endpoints?.().googleToken || ENDPOINTS.googleToken;
  function sessionFor(name) {
    if (!sessions.has(name)) {
      sessions.set(name, OA.createSession({
        tokenUrl, post: formPost, now,
        load: () => OA.decodeCreds(deps.getSecret(name)),
        save: (c) => deps.setSecret(name, c ? OA.encodeCreds(c) : null),
      }));
    }
    return sessions.get(name);
  }
  const failure = (res) => {
    if (res.status === 401 || res.status === 403) return new Error('The token was refused. Check it in Settings.');
    if (res.status === 404) return new Error('Nothing was found at that address.');
    if (res.status === 429) return new Error('The service is busy. Lumen will try again shortly.');
    return new Error(`The server answered ${res.status}.`);
  };
  function helpers(secretName, secretOverride) {
    const x = {
      endpoint: (name) => deps.endpoints?.()[name] || ENDPOINTS[name],
      secret: () => secretOverride || (secretName ? deps.getSecret(secretName) : null),
      // The OAuth account behind this connector's secret; or one built from creds not stored yet (Check).
      session(creds) {
        if (!creds) return sessionFor(secretName);
        let held = creds;
        return OA.createSession({ tokenUrl, post: formPost, now, load: () => held, save: (c) => { held = c; } });
      },
      backoff(ms) { backoffUntil = Math.max(backoffUntil, now() + Math.min(120e3, Math.max(1e3, ms))); },
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
      // A POST with a JSON body and the token (Todoist), the answer parsed when there is one.
      async postJson(url, obj) {
        const res = await request(url, { method: 'POST', max: 65536, body: JSON.stringify(obj), headers: { Authorization: `Bearer ${x.secret()}`, 'Content-Type': 'application/json', Accept: 'application/json' } });
        if (!res.ok) throw failure(res);
        try { return res.body ? JSON.parse(res.body) : null; } catch { return null; }
      },
      memo,
      forget,
      projects: () => todoistProjects(x, x.secret() || ''),
      // "My location": { status: 'consent' | 'off' | 'ok' | 'error', place?, message? }. Nothing is sent
      // before the user agreed; the answer is kept for an hour (in settings, so a restart doesn't ask again).
      async here() {
        const s = deps.readSettings();
        const consent = pick(s.weatherLocation, ['unset', 'granted', 'denied'], 'unset');
        const h = s.weatherHere;
        const cached = h && typeof h === 'object' && Number.isFinite(h.at) && str(h.name, 80) && num(h.lat, -90, 90) !== null && num(h.lon, -180, 180) !== null ? { name: str(h.name, 80), lat: h.lat, lon: h.lon, at: h.at } : null;
        const d = WX.locationDecision({ consent, cached, now: now() });
        if (d === 'consent') return { status: 'consent' };
        if (d === 'off') return { status: 'off' };
        if (d === 'cached') return { status: 'ok', place: cached };
        try {
          const loc = WX.cleanLocation(await x.json(x.endpoint('locate')));
          if (!loc) throw new Error('Couldn’t tell which city you are in.');
          deps.writeSettings({ ...deps.readSettings(), weatherHere: { ...loc, at: now() } });
          return { status: 'ok', place: loc };
        } catch (err) {
          if (cached) return { status: 'ok', place: cached };
          return { status: 'error', message: `My location: ${String(err?.message || err).slice(0, 120)}` };
        }
      },
    };
    return x;
  }

  // ---- fetching ----
  function refresh(w, { force = false } = {}) {
    const c = connector(w);
    let entry = cache.get(w.id);
    if (!entry || entry.key !== keyOf(w)) { entry = { key: keyOf(w), data: null, error: null, at: 0, undo: entry?.undo }; cache.set(w.id, entry); }
    if (entry.pending) return entry.pending;
    const age = now() - entry.at;
    const fresh = entry.at && age < (entry.error ? ERROR_TTL : c.ttl);
    if (fresh && (!force || age < MIN_REFRESH)) return Promise.resolve(false);
    if (force) { forget('tasks:'); forget('done:'); forget('wx:'); }
    entry.pending = Promise.resolve()
      .then(() => c.fetch(w, helpers(c.secret)))
      .then((data) => { entry.data = data; entry.error = null; entry.okAt = now(); }, (err) => { entry.error = String(err?.message || err).slice(0, 200); })
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
      const undo = current?.undo && current.undo.until > now() ? { id: current.undo.id, title: current.undo.title } : null;
      const data = current?.data ? (undo ? { ...current.data, undo } : current.data) : null;
      const layout = WL.rectOf(w);
      if (w.snap) layout.snap = w.snap;
      // With old data on hand a failed refresh is a warning under it ("offline"), not an empty card.
      return { id: w.id, type: w.type, title: w.title || connector(w).title(w), span: w.span, height: w.height, colors: w.colors || 'calendar', layout, data, updated: current?.data ? current.okAt || current.at : 0, warning: current?.data ? current.error || null : null, error: current?.data ? null : current?.error ?? null, loading: !current?.data && !current?.error };
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
    return { widget: { id: id || newId(), type: i.type, title: i.title, span: i.span || defaultSpan(i.type), ...config }, secret: out.secret, message: out.message, ok: out.frameable !== false };
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
    const prev = id ? widgets.find((w) => w.id === id) : null;
    if (id && !prev) throw new Error('That widget is gone.');
    if (!id && widgets.length >= MAX_WIDGETS) throw new Error(`Up to ${MAX_WIDGETS} widgets.`);
    const { widget, secret, message } = await resolveInput(input, id);
    const ci = cleanInput(input);
    if (prev) {
      // An edit keeps its place and size; the width and height pickers only count when they changed.
      Object.assign(widget, WL.rectOf(prev));
      if (prev.snap) widget.snap = prev.snap;
      if (ci.span && ci.span !== prev.span) widget.w = WL.sizeFromLegacy(widget.type, ci.span).w;
      if (widget.type === 'embed' && widget.height !== prev.height) widget.h = WL.sizeFromLegacy('embed', null, widget.height).h;
    } else {
      // A new one is the size last used for its kind, or what the pickers ask for, in the first free spot.
      const size = { ...sizeFor(widget.type) };
      if (ci.span && ci.span !== defaultSpan(widget.type)) size.w = WL.sizeFromLegacy(widget.type, ci.span).w;
      if (widget.type === 'embed' && widget.height !== 'medium') size.h = WL.sizeFromLegacy('embed', null, widget.height).h;
      Object.assign(widget, WL.firstFit(widgets.map(WL.rectOf), size), size);
    }
    if (secret && CONNECTORS[widget.type].secret) deps.setSecret(CONNECTORS[widget.type].secret, secret);
    if (widget.type === 'weather') rememberPlaces(widget.wx.places);
    const next = id ? widgets.map((w) => (w.id === id ? widget : w)) : [...widgets, widget];
    save(next);
    cache.delete(widget.id);
    if (secret) for (const w of next) if (w.type === widget.type) cache.delete(w.id);
    deps.onUpdate?.();
    refresh(list().find((w) => w.id === widget.id) || widget).catch(() => {});
    return { widget: list().find((w) => w.id === widget.id) || widget, message };
  }
  function remove(id) {
    const widgets = list();
    const gone = widgets.find((w) => w.id === id);
    const next = widgets.filter((w) => w.id !== id);
    save(next);
    cache.delete(id);
    // The last widget that used a token takes the token with it.
    const secret = gone && CONNECTORS[gone.type].secret;
    if (secret && !next.some((w) => CONNECTORS[w.type].secret === secret)) {
      if (secret === 'gmail') revokeGoogle(OA.decodeCreds(deps.getSecret(secret)));
      deps.setSecret(secret, null);
      sessions.get(secret)?.invalidate();
    }
    deps.onUpdate?.();
    return true;
  }
  // Settings' up and down: swap places with the neighbour in reading order.
  function move(id, delta) {
    const widgets = list();
    const i = widgets.findIndex((w) => w.id === id);
    const j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= widgets.length) return false;
    const a = widgets[i];
    const b = widgets[j];
    [a.x, b.x] = [b.x, a.x];
    [a.y, b.y] = [b.y, a.y];
    delete a.snap;
    delete b.snap;
    save(widgets);
    deps.onUpdate?.();
    return true;
  }
  // do=place: take the place of the widget at an index in reading order (the others make room).
  function place(id, to) {
    const widgets = list();
    const it = widgets.find((w) => w.id === id);
    const target = widgets[Math.max(0, Math.min(widgets.length - 1, Math.trunc(to)))];
    if (!it || !target || target === it || !Number.isFinite(to)) return false;
    save(applyRects(widgets, WL.move(widgets.map(toItem), id, { x: target.x, y: target.y }, { packed: false })));
    deps.onUpdate?.();
    return true;
  }
  // do=size (older pages and tests): a width in the old units and, for a web page, a frame height.
  function resize(id, { span, height } = {}) {
    const widgets = list();
    const w = widgets.find((x) => x.id === id);
    if (!w) return false;
    const want = { x: w.x, y: w.y, w: span ? WL.sizeFromLegacy(w.type, pick(span, SPANS, w.span)).w : w.w, h: w.type === 'embed' && height ? WL.sizeFromLegacy('embed', null, pick(height, HEIGHTS, w.height)).h : w.h };
    if (want.w === w.w && want.h === w.h) return false;
    save(applyRects(widgets, WL.resize(widgets.map(toItem), id, want, { packed: false })));
    deps.onUpdate?.();
    return true;
  }
  // do=layout: the page's drag, resize and snap: rects for (some of) the widgets. Checked and clamped
  // here; the last size resized per kind is remembered for new widgets.
  function layout(items) {
    const widgets = list();
    let resized = null;
    const next = widgets.map((w) => {
      const r = Array.isArray(items) ? items.find((i) => i && i.id === w.id) : null;
      const rect = r && WL.cleanRect(w.type, r);
      if (!rect) return w;
      const n = { ...w, ...rect };
      const snap = WL.cleanSnap(r.snap);
      if (snap) n.snap = snap; else delete n.snap;
      if ((rect.w !== w.w || rect.h !== w.h) && !snap) resized = { type: w.type, w: rect.w, h: rect.h };
      return n;
    });
    if (JSON.stringify(cleanList(next)) === JSON.stringify(widgets)) return false;
    save(next, resized ? { homeWidgetSizes: { ...sizes(), [resized.type]: { w: resized.w, h: resized.h } } } : {});
    deps.onUpdate?.();
    return true;
  }
  // Settings' "Reset layout": every card its default size, packed in reading order.
  function resetLayout() {
    const widgets = list();
    const rects = WL.flowPack(widgets.map((w) => WL.DEFAULT_SIZE[w.type] || { w: 4, h: 3 }));
    widgets.forEach((w, i) => { Object.assign(w, rects[i]); delete w.snap; });
    save(widgets, { homeWidgetSizes: {} });
    deps.onUpdate?.();
    return true;
  }
  // ---- Gmail: sign-in from Settings ----
  // The consent page opens in the user's default browser (deps.openExternal, https only); Google
  // redirects to a one-shot listener on 127.0.0.1 (features/oauth.js). Only this process sees the code,
  // the tokens and the client secret; Settings gets a message, never a token.
  let signIn = null;
  const staleGmail = () => { sessions.get('gmail')?.invalidate(); for (const w of list()) if (w.type === 'gmail') cache.delete(w.id); deps.onUpdate?.(); };
  async function gmailConnect(input) {
    const clientId = GV.cleanClientId(input?.clientId);
    if (!clientId) throw new Error('Paste the Client ID of your Google Cloud OAuth client (it ends in .apps.googleusercontent.com).');
    const typed = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
    if (typed && !GV.cleanClientSecret(typed)) throw new Error('That doesn’t look like a Google client secret.');
    const stored = OA.decodeCreds(deps.getSecret('gmail'));
    const clientSecret = typed || (stored?.clientId === clientId ? stored.clientSecret : '');
    if (!clientSecret) throw new Error('Paste the client secret shown next to the Client ID in Google Cloud.');
    if (!deps.openExternal) throw new Error('Lumen can’t open your browser here.');
    const authBase = deps.endpoints?.().googleAuth || ENDPOINTS.googleAuth;
    signIn?.cancel(); // one sign-in at a time
    const flow = await OA.beginSignIn({
      authorizeBase: authBase, tokenUrl: tokenUrl(), clientId, clientSecret, scope: GV.SCOPE, extra: GV.AUTH_EXTRA, post: formPost, now, timeoutMs: deps.signInMs,
      openExternal: (url) => { if (!url.startsWith(`${authBase}?`)) throw new Error('Refusing to open that address.'); return deps.openExternal(url); },
      messages: { title: 'Lumen', done: 'Gmail is connected to Lumen. You can close this tab.', denied: 'Gmail was not connected. You can close this tab.' },
    });
    signIn = flow;
    try {
      const t = await flow.done;
      deps.setSecret('gmail', OA.encodeCreds({ clientId, clientSecret, refresh: t.refresh }));
      staleGmail();
      return { message: 'Gmail is connected.' };
    } finally {
      if (signIn === flow) signIn = null;
    }
  }
  const gmailCancel = () => { signIn?.cancel(); return true; };
  // Best effort: tell Google the refresh token is no longer wanted.
  function revokeGoogle(creds) {
    if (!creds?.refresh) return Promise.resolve(false);
    return formPost(deps.endpoints?.().googleRevoke || ENDPOINTS.googleRevoke, new URLSearchParams({ token: creds.refresh }).toString()).then(() => true, () => false);
  }
  // Forget the sign-in (the client id and secret stay, so connecting again is one click).
  async function gmailDisconnect() {
    const creds = OA.decodeCreds(deps.getSecret('gmail'));
    signIn?.cancel();
    if (creds?.refresh) deps.setSecret('gmail', OA.encodeCreds({ ...creds, refresh: '' }));
    staleGmail();
    await revokeGoogle(creds);
    return true;
  }
  // Settings' project picker for a Todoist widget (a token typed but not saved yet may be given).
  async function projects(token) {
    const t = typeof token === 'string' ? token.trim() : '';
    if (t && !/^[A-Za-z0-9_-]{20,100}$/.test(t)) throw new Error('That doesn’t look like a Todoist API token.');
    const x = helpers('todoist', t || undefined);
    if (!x.secret()) throw new Error('Add your Todoist token first.');
    return [...(await x.projects())].map(([id, p]) => ({ id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
  }
  // ---- weather: places and "My location" ----
  const savedPlaces = () => WX.cleanSaved(deps.readSettings().weatherPlaces);
  const rememberPlaces = (places) => {
    const merged = WX.cleanSaved([...savedPlaces(), ...places.filter((p) => !p.here)]);
    deps.writeSettings({ ...deps.readSettings(), weatherPlaces: merged });
  };
  // Settings' place editor for the saved list (rename, reorder, remove).
  function setSavedPlaces(list) {
    deps.writeSettings({ ...deps.readSettings(), weatherPlaces: WX.cleanSaved(list) });
    return savedPlaces();
  }
  async function search(query) {
    const q = str(query, 80);
    if (q.length < 2) throw new Error('Type at least two letters.');
    return searchPlaces(helpers(null), q);
  }
  const locationState = () => {
    const h = deps.readSettings().weatherHere;
    return { consent: pick(deps.readSettings().weatherLocation, ['unset', 'granted', 'denied'], 'unset'), service: LOCATE_SERVICE, here: h && typeof h.name === 'string' ? str(h.name, 80) : '' };
  };
  // The user's answer to "Show weather for where you are?" (Settings, or the card's own question).
  function setLocationConsent(choice) {
    if (choice !== 'allow' && choice !== 'deny') return false;
    deps.writeSettings({ ...deps.readSettings(), weatherLocation: choice === 'allow' ? 'granted' : 'denied', weatherHere: null });
    forget('wx:');
    for (const w of list()) if (w.type === 'weather' && cache.has(w.id)) cache.get(w.id).at = 0; // stale: fetched again, the old forecast stays until then
    deps.onUpdate?.();
    return true;
  }
  // Ask again where the network is (the card's refresh-location button).
  function relocate() {
    deps.writeSettings({ ...deps.readSettings(), weatherHere: null });
    forget('wx:');
    for (const w of list()) if (w.type === 'weather' && cache.has(w.id)) cache.get(w.id).at = 0; // stale: fetched again, the old forecast stays until then
    deps.onUpdate?.();
    return true;
  }
  // For Settings: the list with a line each, and which secrets are stored (never their values).
  function state() {
    const edit = pendingEdit;
    pendingEdit = null;
    return {
      savedPlaces: savedPlaces(),
      location: locationState(),
      widgets: list().map((w) => ({ ...w, title: w.title || connector(w).title(w), customTitle: w.title, summary: connector(w).summary(w), label: connector(w).label, error: cache.get(w.id)?.error || null })),
      types: Object.entries(CONNECTORS).map(([type, c]) => ({ type, label: c.label })),
      connections: { gmail: Boolean(OA.decodeCreds(deps.getSecret('gmail'))?.refresh) }, // whether a Google account is connected (never the token)
      secrets: Object.fromEntries([...new Set(Object.values(CONNECTORS).map((c) => c.secret).filter(Boolean))].map((s) => [s, Boolean(deps.getSecret(s))])),
      max: MAX_WIDGETS,
      spans: SPANS,
      edit,
    };
  }

  // ---- page actions ----
  // The new-tab page asks by loading itself with ?widget=<id>&do=<action>[&task=<id>] (like its Ask
  // AI box): refresh, complete, undo (&task), add (&text), place (&to=<index>), size (&span, &height),
  // layout (&l=<id:x,y,w,h[,snap];…>), remove, configure. main.js cancels that navigation and passes
  // the URL here. Null when it isn't one; { invalid: true } when it is one that is refused.
  function actionFrom(url) {
    let params;
    try { params = new URL(url).searchParams; } catch { return null; }
    const id = params.get('widget');
    if (id === null) return null;
    const action = { id, do: params.get('do'), task: params.get('task') };
    if (!/^w[0-9a-z]{4,20}$/.test(id) || !/^(refresh|complete|undo|add|place|size|layout|remove|configure|consent|locate)$/.test(action.do || '') || (action.task !== null && !/^[\w-]{1,40}$/.test(action.task))) return { invalid: true };
    if ((action.do === 'complete' || action.do === 'undo') && !action.task) return { invalid: true };
    if (action.do === 'add') {
      action.text = str(params.get('text'), 300);
      if (!action.text) return { invalid: true };
    }
    if (action.do === 'consent') {
      action.arg = params.get('arg');
      if (action.arg !== 'allow' && action.arg !== 'deny') return { invalid: true };
    }
    if (action.do === 'place') {
      if (!/^\d{1,2}$/.test(params.get('to') || '')) return { invalid: true };
      action.to = Number(params.get('to'));
    }
    if (action.do === 'size') {
      action.span = pick(Number(params.get('span')), SPANS, null);
      action.height = params.has('height') ? pick(params.get('height'), HEIGHTS, null) : undefined;
      if (!action.span || action.height === null) return { invalid: true };
    }
    if (action.do === 'layout') {
      action.items = WL.decode(params.get('l'));
      if (!action.items) return { invalid: true };
    }
    return action;
  }
  async function act(action) {
    const w = list().find((x) => x.id === action.id);
    if (!w) return false;
    if (action.do === 'refresh') return refresh(w, { force: true });
    if (action.do === 'place') return place(w.id, action.to);
    if (action.do === 'size') return resize(w.id, { span: action.span, height: action.height });
    if (action.do === 'layout') return layout(action.items);
    if (action.do === 'remove') return remove(w.id);
    if (action.do === 'consent') return setLocationConsent(action.arg);
    if (action.do === 'locate') return relocate();
    if (action.do === 'configure') { pendingEdit = w.id; deps.onConfigure?.(w.id); return true; }
    const c = connector(w);
    const entry = cache.get(w.id);
    if (!c.act || !entry?.data) return false;
    try {
      const done = await c.act(w, action, helpers(c.secret), entry.data);
      if (!done) return false;
      forget('tasks:');
      forget('done:');
      if (done.undo) {
        entry.undo = { ...done.undo, until: now() + UNDO_MS };
        setTimeout(() => { if (entry.undo && entry.undo.until <= now()) { entry.undo = null; deps.onUpdate?.(); } }, UNDO_MS + 50);
      }
      if (done.undone) entry.undo = null;
      deps.onUpdate?.(); // the task leaves the card at once
      entry.at = 0; // and the list is fetched again
      setTimeout(() => refresh(w).catch(() => {}), done.undo ? 800 : 0);
      return true;
    } catch (err) {
      entry.error = String(err?.message || err).slice(0, 200);
      entry.data = { ...entry.data, notice: entry.error };
      deps.onUpdate?.();
      return false;
    }
  }

  // flush: forget everything fetched (tests point the connectors at a fake server after the first page already asked).
  const flush = () => { epoch++; cache.clear(); memoCache.clear(); };
  return { flush, list, forPage, refresh, refreshAll, test, save: saveWidget, remove, move, place, resize, layout, resetLayout, projects, search, setSavedPlaces, setLocationConsent, relocate, gmailConnect, gmailCancel, gmailDisconnect, state, actionFrom, act, cache };
}

module.exports = { createWidgets, cleanList, cleanWidget, cleanSizes, httpsUrl, CONNECTORS, ENDPOINTS, SPANS, HEIGHTS };
