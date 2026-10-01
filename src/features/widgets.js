// New-tab widgets (Settings → Appearance → New tab page → Widgets): cards on the new-tab page whose
// data the main process fetches. The page itself never goes online. It gets display data only, in
// its hash: widgets: [{ id, type, title, data, error, loading }]. Tokens stay in main.js (encrypted
// with safeStorage) and never reach the page, the hash or settings.json in plain text.
//
// The list is the `homeWidgets` setting: [{ id, type, title, x, y, w, h, snap?, stack?, top?, span, ...config }],
// in reading order. stack and top put same-size widgets in one place (features/widget-stacks.js). x, y, w, h are the card's cells in the page's 12-column grid (features/
// widget-layout.js does all the arithmetic); span (and an embed's height) mirror w and h in the
// units older Lumens used, and are what a list without x, y, w, h (an older one) is migrated from.
// The page moves and resizes cards by asking for a whole new layout (do=layout, through actionFrom()).
// Opening a new tab shows what is cached at once, fetches whatever is stale in the background, and
// the fresh data reaches every open new-tab page through deps.onUpdate (main.js refreshNewTabs).
//
// Adding a connector is one entry in CONNECTORS below:
//   label             its name in Settings' type picker
//   ttl               how long fetched data stays fresh, in ms (or a function of the data cached so far)
//   secret            (optional) the name of the encrypted key it needs; resolve() may return one to save
//   clean(c)          a stored config -> its checked fields (plain values), or null. Runs on every read.
//   resolve(input, x) Settings' form input -> { config, secret?, message } to store; may look things up
//                     through x (the fetch helpers below). Throws an Error with a message for the user.
//   title(c)          the card's title when the user gave none
//   summary(c)        one line for Settings' list
//   fetch(c, x)       -> the card's data: plain JSON (strings, numbers, arrays). renderer/newtab.js
//                     draws it with textContent only, so nothing from the network is ever markup.
//                     fetch() may throw an Error with .waitMs (a rate limit): the widget isn't asked again before then.
//   (a connector that signs in with OAuth keeps its tokens as one JSON secret: features/oauth.js packs it,
//    x.setSecret(json) rewrites it after a refresh, and the sign-in itself is a set of createWidgets methods,
//    like slackStart/slackFinish/slackDisconnect, that Settings calls)
//   act(c, action, x) (optional) a page action (the Todoist checkbox, Spotify's play/pause, Muse's ask): see actionFrom() below;
//                     returning { keep: true } shows the change without fetching the card again.
//                     act(c, action, x, cached, ctx) may also return { config } (fields merged into the stored
//                     widget), { notice } (a line the card shows for a few seconds) and { local: true } (nothing
//                     to fetch again): the Stocks and Crypto paper trades.
//   ttl               a number of ms, or (data) => ms when the age depends on the answer (Stocks: a closed market)
//   present(c, data, ctx) (optional) the cached data -> what the page gets, worked out on every read
//                     (Stocks and Crypto value the paper portfolio at the last quotes here)
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
const FEED = require('./feed');
const WL = require('./widget-layout');
const TV = require('./todoist-view');
const GH = require('./github-view');
const WX = require('./weather-view');
const WC = require('./widget-colors');
const SYS = require('./widget-system'); // the page's own sections as cards in this same list (docked until moved)
const ST = require('./widget-stacks'); // several same-size widgets in one place, shown one at a time
const { createTrash } = require('./widget-trash'); // removed widgets, held briefly for the page's Undo
const SV = require('./spotify-view');
const SW = require('./spotify-web');
const GV = require('./gmail-view');
const SL = require('./slack-view');
const OA = require('./oauth');
const GC = require('./google-client'); // Lumen's built-in Google client (one-click Gmail sign-in), when it was built with one
const WCK = require('./worldclock-view');
const MV = require('./muse-view');
const MK = require('./markets-view');
const TVW = require('./tradingview-view');
const CW = require('./custom-widget');
const LW = require('./local-widgets');
const WCFG = require('./widget-config'); // the home page's own editor: what it may see, and its form laid over what is saved

const ENDPOINTS = {
  geocode: 'https://geocoding-api.open-meteo.com/v1/search',
  forecast: 'https://api.open-meteo.com/v1/forecast',
  // "My location": which city this network is in (no key). Asked only after the user agreed, only
  // from this process; it sees the IP address and nothing else of ours is sent.
  locate: 'https://ipapi.co/json/',
  todoist: 'https://api.todoist.com/api/v1', // the unified API (REST v2 was shut down)
  spotify: 'https://api.spotify.com/v1',
  spotifyAccounts: 'https://accounts.spotify.com', // sign-in and tokens (PKCE: no client secret)
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth', // opened in the user's own browser, never in Lumen
  googleToken: 'https://oauth2.googleapis.com/token',
  googleRevoke: 'https://oauth2.googleapis.com/revoke',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  slack: 'https://slack.com/api', // Web API; sign-in is oauth.v2.access here and slack.com/oauth/v2/authorize (features/slack-view.js)
  github: 'https://api.github.com',
  muse: 'https://api.meta.ai/v1', // Meta Model API (OpenAI-style), bearer key
  twelvedata: 'https://api.twelvedata.com', // Stocks: the user's own free key
  coingecko: 'https://api.coingecko.com/api/v3', // Crypto: keyless, or the user's own Demo key
};
// Kinds the new-tab page can add and edit itself (renderer/newtab-setup.js), through do=setup: none of
// them has a key or a sign-in, so their settings may be shown to the page. The value picks what the
// page's form starts from. Weather, World clock, Calendar and Feed are edited the same way, but their
// settings are cut down (features/widget-config.js: a calendar's address never leaves the browser) and
// laid over what is saved when the form comes back. Everything else opens Settings (do=configure).
const INLINE = {
  notes: () => ({}),
  countdown: (w) => ({ cd: w.cd }),
  timer: (w) => ({ tm: { work: w.tm.work, rest: w.tm.rest, pomodoro: w.tm.pomodoro } }),
  tradingview: (w) => ({ tv: w.tv }),
  custom: (w) => ({ recipe: w.recipe }),
  embed: (w) => ({ url: w.url, height: w.height }),
  weather: (w) => WCFG.view(w),
  worldclock: (w) => WCFG.view(w),
  calendar: (w) => WCFG.view(w),
  feed: (w) => WCFG.view(w),
};
const MAX_WIDGETS = 24; // every kind of card can be added more than once (several feeds, places, pages), so the cap is well above the number of kinds
const SPANS = WL.SPANS; // what older Lumens stored: a third, half, two thirds, the full width
const HEIGHTS = ['small', 'medium', 'large', 'tall']; // a web page's frame
const defaultSpan = (type) => (type === 'embed' ? 6 : 3);
const MIN_REFRESH = 15e3; // a widget is fetched at most this often, even when asked
const RATE = { window: 60e3, max: 40 }; // network requests per minute, all widgets together
const ERROR_TTL = 2 * 60e3; // a failed fetch is retried after this
const TIMEOUT = 12e3;
const MUSE_TIMEOUT = 60e3; // a model answer (with web search) takes longer than a lookup

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
    const tz = WCK.cleanTz(r.timezone); // the World clock keeps it; the weather ignores it
    if (name) out.push({ name, lat: r.latitude, lon: r.longitude, ...(tz ? { tz } : {}) });
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
      // A typed city: the older form (no places yet), or the home page's editor, which adds it to the places (wx.append).
      const query = str(input.city, 80);
      if (!places.length || (query && input.wx?.append === true)) {
        if (!query) throw new Error('Type a city, or search for a place.');
        const found = (await searchPlaces(x, query))[0];
        if (!found) throw new Error(`No place called “${query}” was found.`);
        places = WX.cleanPlaces([...places, { name: found.name, lat: found.lat, lon: found.lon }]);
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

  // Places and options: c.wc (features/worldclock-view.js). Only sunrise and sunset come from the network
  // (Open-Meteo, keyless); the page gets each place's time zone NAME and ticks the time itself.
  worldclock: {
    label: 'World clock',
    ttl: 6 * 3600e3,
    clean: (c) => {
      const wc = WCK.cleanConfig(c.wc);
      return wc ? { wc, colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      let places = WCK.cleanPlaces(input.wc?.places);
      const query = str(input.city, 80);
      if (!places.length || (query && input.wc?.append === true)) { // a typed city (the home page's editor adds it to the places: wc.append)
        if (!query) throw new Error('Type a city, or search for a place.');
        const found = (await searchPlaces(x, query))[0];
        if (!found) throw new Error(`No place called “${query}” was found.`);
        places = WCK.cleanPlaces([...places, found]);
      }
      const sun = await Promise.all(places.map((p) => sunFor(x, p)));
      places = places.map((p, i) => ({ ...p, tz: sun[i].tz }));
      const wc = WCK.cleanConfig({ ...input.wc, places });
      return { config: { wc, colors: WC.cleanMode(input.colors) }, message: places.length === 1 ? `${places[0].name} is ready.` : `${places.length} places are ready.` };
    },
    title: () => 'World clock',
    summary: (c) => c.wc.places.map(WCK.placeLabel).join(', '),
    async fetch(c, x) {
      const wc = c.wc;
      const places = [];
      for (const p of wc.places) {
        try {
          const s = await sunFor(x, p);
          places.push({ label: WCK.placeLabel(p), name: p.name, tz: s.tz, days: s.days });
        } catch (err) {
          // Without a sun answer the clock still runs if the zone is known.
          if (p.tz) places.push({ label: WCK.placeLabel(p), name: p.name, tz: p.tz, days: [], error: String(err?.message || err).slice(0, 200) });
        }
      }
      if (!places.length) throw new Error('Couldn’t find the time zones. Check your internet connection.');
      return { places, clock: wc.clock, seconds: wc.seconds, show: wc.show };
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
        config: { url, name: cal.name, count: input.count ?? 5, colors: WC.cleanMode(input.colors) },
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

  // Headlines from an RSS 2.0 or Atom feed (features/feed.js reads it safely): a preset (FEED.PRESETS) or
  // any https address. The card gets { source, items: [{ title, url, time }] }; links are https only.
  feed: {
    label: 'Feed headlines',
    ttl: 10 * 60e3,
    clean: (c) => {
      const url = httpsUrl(c.url);
      const preset = FEED.presetFor(c.preset);
      return url ? { url, preset: preset && preset.url === url ? preset.id : '', name: str(c.name, 80), count: Math.min(12, Math.max(3, Math.round(num(c.count, 3, 12) ?? 8))), colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      const preset = FEED.presetFor(input.feed);
      const url = preset ? preset.url : httpsUrl(input.url);
      if (!url) throw new Error('Pick a feed, or paste an https:// feed address.');
      const feed = FEED.parseFeed(await x.text(url, { max: FEED.MAX_INPUT }), { base: url });
      const name = preset ? preset.name : feed.title || hostOf(url);
      return {
        config: { url, preset: preset ? preset.id : '', name, count: input.count ?? 8, colors: WC.cleanMode(input.colors) },
        message: `${name}: ${feed.items.length} headlines, the newest “${feed.items[0].title.slice(0, 60)}”.`,
      };
    },
    title: (c) => c.name || hostOf(c.url) || 'Headlines',
    summary: (c) => hostOf(c.url),
    async fetch(c, x) {
      const feed = FEED.parseFeed(await x.text(c.url, { max: FEED.MAX_INPUT }), { base: c.url, max: 12 });
      // The page opens https links only: a feed's http article address is upgraded, the same page nearly everywhere.
      const items = feed.items.slice(0, c.count).map((i) => ({ title: i.title, url: i.url.replace(/^http:/i, 'https:'), time: i.time }));
      return { source: c.name || feed.title || hostOf(c.url), items };
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

  // Now playing (Spotify Web API). The user's own Client ID is in the config; the refresh token is the
  // encrypted secret (OAuth Authorization Code + PKCE, signed in from Settings: spotifyStart() below).
  // The short-lived access token lives only in memory here. The album picture is fetched here and goes
  // to the page as a data: URL, so the page never learns an address or a token.
  spotify: {
    label: 'Spotify',
    ttl: 20e3,
    secret: 'spotify',
    clean: (c) => {
      const cfg = SV.cleanConfig(c);
      return cfg ? { ...cfg, colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      const clientId = SV.cleanClientId(input.clientId); // the user's own, or '' to use Lumen's
      // Web player: Spotify's own site in the card, nothing to check here (the user signs in on the site itself).
      if (SW.cleanMode(input) === 'web') return { config: { mode: 'web', clientId, art: input.art !== false, colors: WC.cleanMode(input.colors) }, message: 'The card shows open.spotify.com. Sign in there once.' };
      if (!SV.effectiveClientId(clientId)) throw new Error('Lumen’s own Spotify app isn’t available here. Add the Client ID of a Spotify app you made (32 letters and digits) on the Spotify widget’s page.');
      if (!x.secret()) throw new Error('Log in with Spotify first.');
      const me = await spotifyCall(x, { clientId }, 'GET', '/me');
      if (!me.ok) throw new Error(SV.playerError(me.status, me.body));
      let name = '';
      try { name = str(JSON.parse(me.body)?.display_name, 60); } catch { /* the name is only for the message */ }
      return { config: { mode: 'api', clientId, art: input.art !== false, colors: WC.cleanMode(input.colors) }, message: `Connected${name ? ` as ${name}` : ''}.` };
    },
    title: () => 'Spotify',
    summary: (c) => (c.mode === 'web' ? 'Spotify web player' : `Now playing${c.art ? '' : ' · no album art'}`),
    async fetch(c, x) {
      if (c.mode === 'web') return { mode: 'web', url: SW.WEB_URL }; // the card is Spotify's own site (features/spotify-web.js)
      if (!x.secret()) throw new Error('Log in with Spotify in Settings.');
      const res = await spotifyCall(x, c, 'GET', '/me/player?additional_types=episode');
      if (res.status !== 204 && !res.ok) throw new Error(SV.playerError(res.status, res.body));
      let body = null;
      if (res.status !== 204 && res.body) {
        try { body = JSON.parse(res.body); } catch { throw new Error('Spotify sent something unexpected.'); }
      }
      const { images, ...data } = SV.normalizePlayback(body, x.now());
      let art = '';
      if (c.art) for (const url of images) { art = await x.image(url).catch(() => ''); if (art) break; }
      return { ...data, art };
    },
    // Web player: whether Spotify's site is signed in (known to main, so the card can offer a sign-in tab).
    present: (c, d, ctx) => (d.mode === 'web' ? { ...d, signedIn: ctx.spotifySignedIn } : d),
    // Page actions: play, pause, next, previous. The card is updated at once and fetched again shortly.
    async act(c, action, x, cached) {
      if (c.mode === 'web') return false;
      const req = SV.actionRequest(action.do);
      if (!req) return false;
      const res = await spotifyCall(x, c, req.method, req.path);
      if (!res.ok) throw new Error(SV.playerError(res.status, res.body));
      if (action.do === 'play' || action.do === 'pause') {
        cached.progressMs = Math.round(SV.progressNow(cached, x.now()));
        cached.at = x.now();
        cached.state = action.do === 'play' ? 'playing' : 'paused';
      }
      delete cached.notice;
      return { delay: 700 };
    },
  },

  // Read-only inbox summary: the unread count and the latest few subjects, senders and snippets. Signs
  // in with Lumen's built-in Google client (features/google-client.js) or, when the widget has one, the
  // user's own Google Cloud OAuth client, which wins (features/oauth.js); see features/gmail-view.js.
  gmail: {
    label: 'Gmail',
    ttl: 5 * 60e3,
    secret: 'gmail',
    clean: (c) => { const g = GV.cleanConfig(c); return g ? { ...g, colors: WC.cleanMode(c.colors) } : null; },
    async resolve(input, x) {
      const stored = OA.decodeCreds(x.secret());
      const client = gmailClient(input, stored, x.googleClient());
      const same = stored?.clientId === client.clientId;
      const creds = { clientId: client.clientId, clientSecret: client.clientSecret, refresh: same ? stored.refresh : '' };
      if (!creds.refresh) throw new Error(client.source === 'builtin' ? 'Connect your Google account first: use Sign in with Google.' : 'Connect your Google account first: use Connect Gmail.');
      const cfg = GV.cleanConfig({ ...input, clientId: client.source === 'own' ? client.clientId : '' }); // the built-in client is never written to settings.json
      const data = await gmailData(x, x.session(creds), { ...cfg, count: 3 });
      const changed = !stored || stored.clientId !== creds.clientId || stored.clientSecret !== creds.clientSecret || stored.refresh !== creds.refresh;
      return { config: { ...cfg, colors: WC.cleanMode(input.colors) }, secret: changed ? OA.encodeCreds(creds) : undefined, message: `Connected. ${data.unread === 1 ? '1 unread message' : `${data.unread} unread messages`} in the inbox.` };
    },
    title: () => 'Gmail',
    summary: (c) => `Inbox · ${c.count} latest`,
    async fetch(c, x) {
      const session = x.session();
      // oneClick: the card's button can start the sign-in itself (do=signin) instead of opening Settings.
      const oneClick = () => GC.uiState({ clientId: c.clientId, stored: OA.decodeCreds(x.secret()), builtin: x.googleClient() }).oneClick;
      if (!session.connected()) { const one = oneClick(); return GV.reconnect(one ? 'Sign in to see your inbox here. Read-only: Lumen can’t send or delete anything.' : 'Connect Gmail in Settings.', { oneClick: one }); }
      try {
        return await gmailData(x, session, c);
      } catch (err) {
        if (err?.reconnect) return GV.reconnect(err.message, { oneClick: oneClick() }); // a revoked grant is a state the card shows, not an error
        throw err;
      }
    },
  },

  // Read-only Slack: unread DM and mention counts and recent messages from chosen channels. Sign-in is
  // OAuth v2 with the user's own Slack app (features/slack-view.js explains the paste-the-address flow);
  // the secret is one encrypted JSON string (client id and secret, user token, refresh token, expiry).
  // Only display text (names, short plain messages, counts) is sent to the page.
  slack: {
    label: 'Slack',
    ttl: 4 * 60e3,
    secret: 'slack',
    clean: (c) => ({ slack: SL.cleanConfig(c.slack), colors: WC.cleanMode(c.colors) }),
    async resolve(input, x) {
      const pasted = SL.cleanUserToken(input.token);
      if (typeof input.token === 'string' && input.token.trim() && !pasted) throw new Error('That doesn’t look like a Slack user token (it starts with xoxp-). Or use Sign in with a client ID and secret.');
      let secret;
      let who;
      if (pasted) {
        who = await x.slack.identify(pasted);
        secret = OA.packTokens({ access: pasted, userId: who.userId, teamId: who.teamId, teamName: who.teamName, teamUrl: who.teamUrl });
      } else {
        if (!OA.unpackTokens(x.secret())?.access) throw new Error('Sign in to Slack first (Open Slack, approve, paste the address), or paste a user token.');
        who = await x.slack.identify();
      }
      const slack = SL.cleanConfig(input.slack);
      const what = [slack.dms && 'unread DMs', slack.mentions && slack.channels.length && 'mentions', slack.channels.length && `${slack.channels.length} channel${slack.channels.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
      return { config: { slack, colors: WC.cleanMode(input.colors) }, secret, message: `Connected to ${who.teamName || 'Slack'}${what ? `: ${what}` : ''}.` };
    },
    title: (c) => SL.nameFor(c.slack),
    summary: (c) => SL.summaryFor(c.slack),
    async fetch(c, x) {
      const tok = OA.unpackTokens(x.secret());
      if (!tok?.access) return { reconnect: true, reason: 'Sign in to Slack in Settings.' };
      try {
        const data = await SL.collect((method, params) => x.slack.call(method, params), c.slack, tok, (id) => x.slack.userName(id));
        return { ...data, reconnect: false };
      } catch (err) {
        if (err instanceof SL.SlackError && err.reconnect) return { reconnect: true, reason: err.message, team: tok.teamName };
        if (err instanceof SL.SlackError && err.code === 'ratelimited') throw new Error('Slack asked Lumen to slow down. It will try again shortly.');
        throw err;
      }
    },
  },

  // Review requests, assigned issues and pull requests, and the unread notification count (settings in
  // c.gh, features/github-view.js). The token (a fine-grained read-only personal access token) is the
  // encrypted `github` secret and goes only to api.github.com, from this process.
  github: {
    label: 'GitHub',
    ttl: 5 * 60e3,
    secret: 'github',
    clean: (c) => ({ gh: GH.cleanConfig(c.gh), colors: WC.cleanMode(c.colors) }),
    async resolve(input, x) {
      const token = typeof input.token === 'string' ? input.token.trim() : '';
      if (token && !GH.looksLikeToken(token)) throw new Error('That doesn’t look like a GitHub token. Create a fine-grained personal access token at github.com/settings/personal-access-tokens.');
      if (!token && !x.secret()) throw new Error('Paste your GitHub token.');
      const gh = GH.cleanConfig(input.gh);
      const data = await githubData(x, token || x.secret(), gh);
      const parts = [];
      if (data.reviews) parts.push(data.reviews.error ? 'review requests unavailable' : `${data.reviews.total} review request${data.reviews.total === 1 ? '' : 's'}`);
      if (data.assigned) parts.push(data.assigned.error ? 'assigned items unavailable' : `${data.assigned.total} assigned`);
      if (data.notifications) parts.push(data.notifications.error ? 'notifications unavailable' : `${GH.countLabel(data.notifications)} unread`);
      return { config: { gh, colors: WC.cleanMode(input.colors) }, secret: token || undefined, message: `Connected: ${parts.join(', ')}.` };
    },
    title: (c) => GH.nameFor(c.gh),
    summary: (c) => GH.summaryFor(c.gh),
    async fetch(c, x) {
      if (!x.secret()) throw new Error('Add your GitHub token in Settings.');
      return GH.shape(await githubData(x, x.secret(), c.gh), c.gh);
    },
  },

  // Meta's Muse model: a saved prompt answered on the card (c.muse, features/muse-view.js), and a
  // field on the card for one-off questions. One encrypted secret, the API key. Prompts and answers go
  // to Meta and use the key's credit, so nothing is asked until the card is added, the answer is kept
  // for hours, and a typed question is kept in memory only (never stored, no history).
  muse: {
    label: 'Muse',
    ttl: 6 * 3600e3,
    secret: 'muse',
    clean: (c) => ({ muse: MV.cleanConfig(c.muse), colors: WC.cleanMode(c.colors) }),
    async resolve(input, x) {
      const token = typeof input.token === 'string' ? input.token.trim() : '';
      if (token && !MV.cleanKey(token)) throw new Error('That doesn’t look like a Meta API key (create one at dev.meta.ai).');
      if (!token && !x.secret()) throw new Error('Paste your Meta API key.');
      // No request here: checking would spend the key's credit. A wrong key shows on the card.
      return { config: { muse: MV.cleanConfig(input.muse), colors: WC.cleanMode(input.colors) }, secret: token || undefined, message: 'Saved. The key is used the first time the card loads, and it costs a small amount of your Meta credit each time.' };
    },
    title: () => 'Muse',
    summary: (c) => `${c.muse.model}${c.muse.search ? ' · web search' : ''}`,
    async fetch(c, x) {
      const got = await museCall(x, c.muse, null);
      return { ...got, model: c.muse.model, search: c.muse.search, asked: null };
    },
    // Page action ask: one typed question. The answer sits on the card until the next refresh.
    async act(c, action, x, cached) {
      if (action.do !== 'ask') return false;
      const question = MV.cleanQuestion(action.text);
      if (!question) return false;
      const t = x.now();
      if (t - (cached.askedAt || 0) < MIN_REFRESH) { cached.notice = 'Wait a few seconds between questions.'; return { keep: true }; }
      cached.askedAt = t;
      try {
        const got = await museCall(x, c.muse, question);
        cached.asked = { question, answer: got.answer, sources: got.sources };
        delete cached.notice;
      } catch (err) {
        delete cached.asked;
        cached.notice = String(err?.message || err).slice(0, 200);
      }
      return { keep: true };
    },
  },

  // Stocks and Crypto: a watchlist and a SIMULATED paper portfolio (features/markets-view.js). Lumen never
  // places an order anywhere; the trades are entries in this widget's own config, filled at the last quote.
  stocks: {
    label: 'Stocks',
    ttl: (data) => (data?.rows?.length && !data.anyOpen ? 60 * 60e3 : 15 * 60e3), // market closed: quotes can't change
    secret: 'twelvedata',
    portfolio: true,
    clean: (c) => {
      const symbols = MK.cleanSymbols(c.mk?.symbols, MK.MAX_STOCKS);
      return symbols.length ? { mk: { symbols }, pf: MK.cleanPortfolio(c.pf, { fractional: false }), colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      const token = keyFrom(input.token, 'Twelve Data');
      if (!token && !x.secret()) throw new Error('Paste your Twelve Data API key (twelvedata.com, free plan).');
      const symbols = MK.cleanSymbols(input.mk?.symbols, MK.MAX_STOCKS);
      if (!symbols.length) throw new Error('Add at least one symbol, like AAPL.');
      const { rows, missing } = await twelveQuotes(x, symbols, token || x.secret());
      return {
        config: { mk: { symbols }, pf: { cash0: MK.cleanCash(input.mk?.startCash) }, colors: WC.cleanMode(input.colors) }, secret: token || undefined,
        message: `Connected. ${rows.length} of ${symbols.length} symbols found${missing.length ? ` (no quote for ${missing.join(', ')})` : ''}.`,
      };
    },
    title: () => 'Stocks',
    summary: (c) => c.mk.symbols.join(', '),
    async fetch(c, x) {
      if (!x.secret()) throw new Error('Add your Twelve Data API key in Settings.');
      const { rows, missing } = await twelveQuotes(x, c.mk.symbols, x.secret());
      if (!rows.length) throw new Error(`Twelve Data has no quote for ${missing.join(', ')}.`);
      const anyOpen = rows.some((r) => r.open);
      return marketData(rows, missing, x.now(), { anyOpen, refreshMs: anyOpen ? 15 * 60e3 : 60 * 60e3 });
    },
    present: (c, d, ctx) => presentMarket('stocks', c, d, ctx),
    act: (c, action, x, cached, ctx) => marketAct(c, action, cached, ctx, false),
  },

  crypto: {
    label: 'Crypto',
    ttl: 2 * 60e3,
    secret: 'coingecko', // optional: a free Demo key allows more requests than going without
    portfolio: true,
    clean: (c) => {
      const coins = MK.cleanCoins(c.mk?.coins, MK.MAX_COINS);
      return coins.length ? { mk: { coins }, pf: MK.cleanPortfolio(c.pf, { fractional: true }), colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      const token = keyFrom(input.token, 'CoinGecko');
      const coins = MK.cleanCoins(input.mk?.coins, MK.MAX_COINS);
      if (!coins.length) throw new Error('Add at least one coin, like bitcoin (CoinGecko’s id for it).');
      const { rows, missing } = await geckoQuotes(x, coins, token || x.secret());
      return {
        config: { mk: { coins }, pf: { cash0: MK.cleanCash(input.mk?.startCash) }, colors: WC.cleanMode(input.colors) }, secret: token || undefined,
        message: `Connected${token || x.secret() ? '' : ' without a key'}. ${rows.length} of ${coins.length} coins found${missing.length ? ` (no price for ${missing.join(', ')})` : ''}.`,
      };
    },
    title: () => 'Crypto',
    summary: (c) => c.mk.coins.map((k) => k.sym).join(', '),
    async fetch(c, x) {
      const { rows, missing } = await geckoQuotes(x, c.mk.coins, x.secret());
      if (!rows.length) throw new Error(`CoinGecko has no price for ${missing.join(', ')}.`);
      return marketData(rows, missing, x.now(), { anyOpen: true, refreshMs: 2 * 60e3 });
    },
    present: (c, d, ctx) => presentMarket('crypto', c, d, ctx),
    act: (c, action, x, cached, ctx) => marketAct(c, action, cached, ctx, true),
  },

  // TradingView: TradingView's own embeddable chart in a sandboxed frame (features/tradingview-view.js).
  // No key, nothing fetched by Lumen: the frame loads the chart and its quotes from TradingView itself.
  // The one exception is a watchlist imported from the user's TradingView account with sync on: its
  // symbols are read again (x.tvLists, the user's own TradingView cookies) so edits there show up here.
  tradingview: {
    label: 'TradingView',
    ttl: (data) => (data?.synced ? TVW.SYNC_MS : 24 * 3600e3),
    clean: (c) => {
      const tv = TVW.cleanConfig(c.tv);
      return tv ? { tv, colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input) {
      const tv = TVW.cleanConfig(input.tv);
      if (!tv && input.tv?.view === 'watchlist') throw new Error('Add at least one symbol, like NASDAQ:AAPL, or import a watchlist from your TradingView account.');
      if (!tv) throw new Error(input.tv?.symbol ? 'That doesn’t look like a TradingView symbol. Try NASDAQ:AAPL, BINANCE:BTCUSDT or SPX.' : 'Add a symbol, like NASDAQ:AAPL.');
      if (tv.view === 'watchlist') {
        const n = TVW.symbolsOf(tv.symbols).length;
        return { config: { tv, colors: WC.cleanMode(input.colors) }, message: `${n} symbol${n === 1 ? '' : 's'} will show as a TradingView watchlist${tv.list && tv.sync ? `, kept in sync with “${tv.list.name}” in your TradingView account` : ''}. A symbol TradingView doesn’t know shows as a blank row.` };
      }
      return { config: { tv, colors: WC.cleanMode(input.colors) }, message: `${tv.symbol} will show as a TradingView ${tv.view === 'mini' ? 'mini chart' : 'chart'}. If TradingView doesn’t know the symbol, the chart says so.` };
    },
    title: (c) => (c.tv.view === 'watchlist' ? c.tv.list?.name || 'Watchlist' : c.tv.symbol),
    summary: (c) => TVW.summary(c.tv),
    async fetch(c, x) {
      let tv = c.tv;
      let synced = false;
      let note = '';
      if (tv.view === 'watchlist' && tv.list && tv.sync) {
        synced = true;
        try {
          const got = await x.tvLists();
          const mine = got.lists.find((l) => l.id === tv.list.id);
          if (mine) tv = { ...tv, symbol: TVW.symbolsOf(mine.symbols)[0], symbols: mine.symbols, list: { id: mine.id, name: mine.name } };
          else note = got.signedIn ? `“${tv.list.name}” is no longer in your TradingView account; showing the symbols it had.` : 'Sign in to TradingView in a Lumen tab to keep this list in sync.';
        } catch (err) {
          note = `Couldn’t reach your TradingView account (${err.message}); showing the last symbols.`;
        }
      }
      // Both themes' addresses, so the page can follow light and dark mode without asking again.
      return { symbol: tv.symbol, view: tv.view, theme: tv.theme, name: tv.list?.name || '', synced, note, light: TVW.embedUrl(tv, false), dark: TVW.embedUrl(tv, true) };
    },
  },

  // Custom: a shared "recipe" (features/custom-widget.js, docs/custom-widgets.md): one https JSON
  // address and which values to show. Fetched here like any feed, drawn as plain text on the page.
  custom: {
    label: 'Custom',
    ttl: (data) => (Number.isFinite(data?.every) ? data.every * 60e3 : 30 * 60e3),
    clean: (c) => {
      const recipe = CW.recipeOrNull(c.recipe);
      return recipe ? { recipe, colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input, x) {
      let raw = input.recipe;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (err) { throw new Error(`The recipe isn’t valid JSON (${String(err.message).replace(/^JSON\.parse: /, '').slice(0, 80)}).`); }
      }
      const recipe = CW.cleanRecipe(raw);
      const shaped = CW.shape(await x.json(recipe.url), recipe);
      const n = recipe.view === 'stats' ? `${shaped.stats.filter((st) => st.value !== '–').length} of ${recipe.stats.length} values found` : `${shaped.items.length} items found`;
      return { config: { recipe, colors: WC.cleanMode(input.colors) }, message: `Works: ${n}. Refreshed every ${recipe.every} minutes.` };
    },
    title: (c) => c.recipe.name || hostOf(c.recipe.url),
    summary: (c) => `${hostOf(c.recipe.url)} · ${c.recipe.view === 'stats' ? `${c.recipe.stats.length} values` : 'list'} · every ${c.recipe.every} min`,
    async fetch(c, x) {
      return { ...CW.shape(await x.json(c.recipe.url), c.recipe), view: c.recipe.view, every: c.recipe.every, host: hostOf(c.recipe.url) };
    },
  },

  // Notes, Countdown and Timer (features/local-widgets.js): no account, never online. Their state is
  // their config; present() hands the page the current state on every read.
  notes: {
    label: 'Notes',
    ttl: 365 * 24 * 3600e3,
    clean: (c) => ({ note: LW.cleanNote(c.note), colors: WC.cleanMode(c.colors) }),
    async resolve(input) { return { config: { note: LW.cleanNote(input.note), colors: WC.cleanMode(input.colors) }, message: 'Saved. Type on the card; it saves as you go.' }; },
    title: () => 'Notes',
    summary: (c) => (c.note.text ? `${c.note.text.split('\n')[0].slice(0, 40)}${c.note.text.length > 40 ? '…' : ''}` : 'Empty'),
    async fetch() { return {}; },
    present: (c) => ({ text: c.note.text, max: LW.MAX_NOTE }),
    act(c, action) {
      if (action.do !== 'note') return false;
      return { config: { note: LW.cleanNote({ text: action.text }) }, local: true };
    },
  },
  countdown: {
    label: 'Countdown',
    ttl: 365 * 24 * 3600e3,
    clean: (c) => {
      const cd = LW.cleanCountdown(c.cd);
      return cd ? { cd, colors: WC.cleanMode(c.colors) } : null;
    },
    async resolve(input) {
      const cd = LW.cleanCountdown(input.cd);
      if (!cd) throw new Error('Pick a date to count to.');
      return { config: { cd, colors: WC.cleanMode(input.colors) }, message: `Counting to ${cd.label || cd.date}.` };
    },
    title: (c) => c.cd.label || 'Countdown',
    summary: (c) => `${c.cd.date}${c.cd.time ? ` ${c.cd.time}` : ''}`,
    async fetch() { return {}; },
    present: (c) => ({ label: c.cd.label, date: c.cd.date, time: c.cd.time, target: LW.countdownTarget(c.cd) }),
  },
  timer: {
    label: 'Timer',
    ttl: 365 * 24 * 3600e3,
    clean: (c) => ({ tm: LW.cleanTimer(c.tm), colors: WC.cleanMode(c.colors) }),
    async resolve(input) {
      const tm = LW.cleanTimer({ ...input.tm, endsAt: null, left: null });
      return { config: { tm, colors: WC.cleanMode(input.colors) }, message: tm.pomodoro ? `Pomodoro: ${tm.work} minutes of focus, ${tm.rest} of break.` : `A ${tm.work}-minute timer.` };
    },
    title: (c) => (c.tm.pomodoro ? 'Pomodoro' : 'Timer'),
    summary: (c) => (c.tm.pomodoro ? `${c.tm.work} min focus · ${c.tm.rest} min break` : `${c.tm.work} minutes`),
    async fetch() { return {}; },
    present: (c, d, ctx) => LW.timerView(c.tm, ctx.now),
    act(c, action, x) {
      if (action.do !== 'timer') return false;
      return { config: { tm: LW.timerStep(c.tm, action.arg, x.now()) }, local: true };
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

// One place's time zone and sunrise/sunset for the next days (shared for hours between clocks asking the same).
function sunFor(x, place) {
  return x.memo(`wc:${place.lat},${place.lon}`, 3 * 3600e3, async () => {
    const s = WCK.shapeSun(await x.json(`${x.endpoint('forecast')}?${new URLSearchParams(WCK.sunParams(place))}`), place);
    if (!s) throw new Error('The service didn’t say which time zone this is.');
    return s;
  });
}

// One call to Meta: the saved prompt (no question) or a typed question -> { answer, sources }.
async function museCall(x, cfg, question) {
  const key = x.secret();
  if (!key) throw new Error('Add your Meta API key in Settings.');
  const req = MV.buildRequest(cfg, question);
  const res = await x.raw(`${x.endpoint('muse')}/${req.path}`, {
    method: 'POST', max: MV.MAX_BODY, timeout: MUSE_TIMEOUT, body: JSON.stringify(req.body),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(MV.errorMessage(res.status, res.body));
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* handled below */ }
  const out = MV.parseResponse(json);
  if (!out) throw new Error('Muse sent an answer Lumen couldn’t read.');
  return out;
}

// ---- Stocks and Crypto ----
// An API key typed in Settings, or '' when none was ("" keeps the saved one); throws when it can't be one.
function keyFrom(value, who) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key && !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new Error(`That doesn’t look like a ${who} API key.`);
  return key;
}
// Twelve Data /quote for the watchlist in ONE request (an error may come as HTTP 200, or with the status).
async function twelveQuotes(x, symbols, key) {
  const url = `${x.endpoint('twelvedata')}/quote?${new URLSearchParams({ symbol: symbols.join(',') })}`;
  const res = await x.raw(url, { headers: { Authorization: `apikey ${key}`, Accept: 'application/json' } });
  let body = null;
  try { body = JSON.parse(res.body); } catch { /* handled below */ }
  if (!res.ok) throw new Error(MK.twelveError(res.status, body && typeof body === 'object' ? body : null));
  return MK.parseTwelve(body, symbols, x.now(), res.status);
}
// CoinGecko /simple/price for all coins in ONE request; the Demo key (if any) goes in a header.
async function geckoQuotes(x, coins, key) {
  const params = new URLSearchParams({ ids: coins.map((c) => c.id).join(','), vs_currencies: 'usd', include_24hr_change: 'true', include_last_updated_at: 'true' });
  const res = await x.raw(`${x.endpoint('coingecko')}/simple/price?${params}`, { headers: { Accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) } });
  let body = null;
  try { body = JSON.parse(res.body); } catch { /* handled below */ }
  if (!res.ok) throw new Error(MK.geckoError(res.status, body && typeof body === 'object' ? body : null));
  return MK.parseGecko(body, coins, x.now());
}
const marketData = (rows, missing, fetchedAt, extra) => ({ rows, missing, fetchedAt, asOf: Math.max(0, ...rows.map((r) => r.at || 0)) || fetchedAt, ...extra });
const MARKET_INFO = {
  stocks: { source: 'Twelve Data', attribution: 'Data: Twelve Data', badge: 'Delayed' },
  crypto: { source: 'CoinGecko', attribution: 'Data: CoinGecko', badge: 'Live' },
};
// What the page gets: the cached quotes plus the paper portfolio worked out from the trades, now.
function presentMarket(kind, c, d, ctx) {
  const fractional = kind === 'crypto';
  const quotes = Object.fromEntries(d.rows.map((r) => [r.sym, r.px]));
  const offline = Boolean(ctx.offline);
  const stale = MK.isStale({ fetchedAt: d.fetchedAt, now: ctx.now, refreshMs: d.refreshMs, offline });
  return {
    kind, ...MARKET_INFO[kind], rows: d.rows, missing: d.missing, asOf: d.asOf, fetchedAt: d.fetchedAt, refreshMs: d.refreshMs,
    marketOpen: kind === 'stocks' ? d.anyOpen : true, offline, fractional,
    tradable: !stale, tradeBlock: offline ? 'Offline: trading is paused.' : stale ? 'Prices are out of date: trading is paused.' : '',
    pf: MK.present(c.pf, quotes, { fractional }),
  };
}
// Page actions of Stocks and Crypto: buy and sell at the last fetched quote (simulated), reset the portfolio.
function marketAct(c, action, cached, ctx, fractional) {
  if (action.do === 'resetpf') return { config: { pf: { cash0: c.pf.cash0, trades: [] } }, local: true, notice: 'Paper portfolio reset.' };
  if (action.do !== 'buy' && action.do !== 'sell') return false;
  const stale = MK.isStale({ fetchedAt: cached.fetchedAt, now: ctx.now, refreshMs: cached.refreshMs, offline: ctx.offline });
  if (stale) return { local: true, notice: ctx.offline ? 'Offline: trading is paused.' : 'Prices are out of date: trading is paused.' };
  const row = cached.rows.find((r) => r.sym === action.sym);
  const r = MK.attempt(c.pf, { side: action.do, sym: action.sym, qty: action.qty, px: row?.px, now: ctx.now, fractional });
  if (!r.ok) return { local: true, notice: r.error };
  const t = r.trade;
  return { config: { pf: r.pf }, local: true, notice: `Paper ${t.qty > 0 ? 'bought' : 'sold'} ${Math.abs(t.qty)} ${t.sym} at ${t.px.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })}.` };
}

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
// One GET to api.github.com with the token -> { body, link }. A refusal becomes an Error carrying
// .kind ('auth' | 'rate' | 'scope' | 'missing' | 'other') and, for a rate limit, .waitMs (Retry-After or
// x-ratelimit-reset), which the widget honours before asking again.
async function githubGet(x, token, path, params) {
  const res = await x.raw(`${x.endpoint('github')}${path}?${new URLSearchParams(params)}`, {
    max: 1e6,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) {
    const f = GH.classify(res.status, res.headers, res.body, x.now());
    throw Object.assign(new Error(f.message), { kind: f.kind, waitMs: f.waitMs });
  }
  let body;
  try { if (res.truncated) throw new Error('too big'); body = JSON.parse(res.body); } catch { throw new Error('GitHub sent something unexpected.'); }
  return { body, link: res.headers.get('link') };
}
// The lists for a widget's settings, shared for a minute between widgets asking the same. A list GitHub
// refuses on its own (the token lacks a permission) is an { error } in its place; a bad token, a rate
// limit or no connection fails the whole fetch. When every list is refused the first refusal is thrown.
async function githubData(x, token, cfg) {
  return x.memo(`gh:${token.length}:${token.slice(-6)}:${JSON.stringify(cfg)}`, 60e3, async () => {
    const out = { reviews: null, assigned: null, notifications: null };
    const errors = [];
    const section = async (name, fn) => {
      try {
        out[name] = await fn();
      } catch (err) {
        if (!['scope', 'missing', 'other'].includes(err.kind)) throw err;
        errors.push(err);
        out[name] = { error: name === 'notifications' && err.kind !== 'other' ? 'Notifications aren’t available to this token. GitHub allows them only on a classic token with the notifications scope.' : err.message };
      }
    };
    const search = (kind) => async () => {
      const { body } = await githubGet(x, token, '/search/issues', { q: GH.searchFor(kind, cfg), sort: 'updated', order: 'desc', per_page: String(cfg.max) });
      const r = GH.readSearch(body, cfg);
      if (!r) throw new Error('GitHub sent something unexpected.');
      return r;
    };
    if (cfg.reviews) await section('reviews', search('reviews'));
    if (cfg.assigned) await section('assigned', search('assigned'));
    if (cfg.notifications) {
      await section('notifications', async () => {
        const { body, link } = await githubGet(x, token, '/notifications', { per_page: '1' }); // unread only; the "last" page number is the count
        const n = GH.readNotificationCount(body, link);
        if (!n) throw new Error('GitHub sent something unexpected.');
        return n;
      });
    }
    if (errors.length && errors.length === ['reviews', 'assigned', 'notifications'].filter((k) => out[k]).length) throw errors[0];
    return out;
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

// One call to the Spotify Web API with a fresh access token. A 401 gets one refresh and one retry;
// a 429 already backs every request off (request() below) and reads as a calm message.
async function spotifyCall(x, cfg, method, path, body) {
  const go = async (force) => {
    const token = await spotifyAccess(x, SV.effectiveClientId(cfg.clientId), force);
    return x.raw(`${x.endpoint('spotify')}${path}`, {
      method, max: 262144, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
  };
  let res = await go(false);
  if (res.status === 401) res = await go(true);
  return res;
}
// The access token: the one in memory while it lasts, else a new one from the refresh token (kept
// encrypted; Spotify may send a new refresh token, which replaces the old).
async function spotifyAccess(x, clientId, force = false) {
  const s = x.spotifyToken;
  if (!force && s.access && s.exp > x.now()) return s.access;
  if (!s.pending) {
    s.pending = (async () => {
      const refresh = x.secret();
      if (!refresh) throw new Error('Log in with Spotify in Settings.');
      const res = await x.raw(`${x.endpoint('spotifyAccounts')}/api/token`, {
        method: 'POST', max: 65536, body: SV.tokenForm('refresh', { clientId, refresh }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) s.access = null;
        throw new Error(SV.tokenError(res.status, res.body));
      }
      const t = SV.parseToken(res.body, x.now(), refresh);
      s.access = t.access;
      s.exp = t.exp;
      if (t.refresh !== refresh) x.setSecret(t.refresh);
    })().finally(() => { s.pending = null; });
  }
  await s.pending;
  return s.access;
}

// Which Google client a Gmail sign-in or Check uses: the user's own (typed, or the widget's saved Client
// ID with its stored secret) before Lumen's built-in one. Throws a message for the user when neither.
function gmailClient(input, stored, builtin) {
  const r = GC.resolveClient({ clientId: input?.clientId, clientSecret: input?.clientSecret, stored, builtin });
  if (r.error) throw new Error(GC.MESSAGES[r.error]);
  return r;
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
  return { type: CONNECTORS[i.type] ? i.type : null, title: str(i.title, 60), city: str(i.city, 80), units: i.units, colors: i.colors, url: typeof i.url === 'string' ? i.url.slice(0, 2000) : '', height: i.height, feed: str(i.feed, 30), span: pick(Number(i.span), SPANS, null), token: typeof i.token === 'string' ? i.token.slice(0, 300) : '', todo: i.todo, wx: i.wx, mk: i.mk, tv: i.tv, recipe: i.recipe, note: i.note, cd: i.cd, tm: i.tm, wc: i.wc, muse: i.muse, gh: i.gh, clientId: typeof i.clientId === 'string' ? i.clientId.slice(0, 300) : '', clientSecret: typeof i.clientSecret === 'string' ? i.clientSecret.slice(0, 300) : '', art: i.art, mode: i.mode, count: i.count, snippets: i.snippets, slack: i.slack };
}

// A stored widget -> { id, type, title, x, y, w, h, snap?, span, ...config } with every field checked, or null.
// x, y, w, h are left out when they aren't four integers (an older list, or garbage): cleanList places those.
function cleanWidget(w) {
  if (SYS.isSystem(w)) return SYS.clean(w);
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
  return Object.assign(out, ST.cleanFields(w));
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
    const next = { ...it, x, y, w, h, ...(SYS.isSystem(it) ? {} : WL.mirror(it.type, { w, h })) };
    if (snap) next.snap = snap; else delete next.snap;
    return next;
  });
  return WL.flowOrder(out);
}
// The homeWidgets setting, checked (settings-backend.js validate()).
// A stack's hidden members are not laid out: they take their shown member's place (ST.settle).
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const norm = ST.normalize(SYS.capReal(list.map(cleanWidget).filter((w) => w && !seen.has(w.id) && seen.add(w.id)), MAX_WIDGETS));
  if (!norm.some((w) => w.stack)) return layoutAll(norm); // no stacks: exactly as before
  const { list: out, ejected } = ST.settle(norm, layoutAll(norm.filter((w) => !ST.isHidden(w))), WL);
  return ejected.length ? cleanList(out) : out; // a member that couldn't take the stack's size is its own place now
}
const slots = (widgets) => widgets.filter((w) => !ST.isHidden(w)); // what is on the grid
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
//         spotifyWebSignedIn()? (true | false | null: is Spotify's site signed in, for the Web player card),
//         tradingviewLists()? (TradingView's account answer, read with the user's TradingView cookies; see TVW.ACCOUNT_URL),
//         openExternal(url)? (the user's default browser, for OAuth consent pages), signInMs? }
function createWidgets(deps) {
  const cache = new Map(); // id -> { data, error, at, key, pending, undo, notice }
  const recent = []; // times of recent network requests (the rate limit)
  const memoCache = new Map(); // shared answers: what Todoist said to a question a minute ago
  const spotifyTokens = new Map(); // secret name -> { access, exp, pending }: short-lived tokens, in memory only
  let backoffUntil = 0; // after a 429: no requests until then
  let pendingEdit = null; // a card's gear: the Settings page opens this widget's editor
  let slackPending = null; // a Slack sign-in that is waiting for its address: { state, clientId, clientSecret, redirectUri, at }
  let slackBad = false; // Slack refused the stored sign-in: the cards say Reconnect until it is redone
  let slackRefreshing = null; // one token refresh at a time (rotation invalidates the old refresh token)
  const now = () => (deps.now ? deps.now() : Date.now());
  const UNDO_MS = deps.undoMs ?? 6000;

  // list(): the widgets. The system cards (features/widget-system.js) share the stored list, and are kept through every save.
  const stored = () => cleanList(deps.readSettings().homeWidgets) || [];
  const list = () => stored().filter((w) => !SYS.isSystem(w));
  const sysList = () => stored().filter(SYS.isSystem);
  const save = (widgets, extra = {}, sys = sysList()) => deps.writeSettings({ ...deps.readSettings(), homeWidgets: cleanList([...widgets, ...sys]), ...extra });
  const trash = createTrash({ now, ttl: deps.trashMs ?? 30000 });
  const sizes = () => cleanSizes(deps.readSettings().homeWidgetSizes);
  const sizeFor = (type) => sizes()[type] || WL.defaultSize(type); // a size the person used stays; a first card fits beside the centre column
  // A changed config invalidates its cached data; its size, place and paper trades don't.
  const keyOf = ({ span, height, x, y, w, h, snap, stack, top, colors, pf, ...rest }) => JSON.stringify(rest);

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
  async function request(url, { method = 'GET', headers = {}, max = 2e6, body, timeout = TIMEOUT } = {}) {
    if (!/^https:\/\//.test(url)) throw new Error('Only https addresses are allowed.');
    spend();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
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
      const bytes = Buffer.concat(chunks);
      return { ok: res.ok, status: res.status, headers: res.headers, url: res.url, body: bytes.toString('utf8'), bytes, truncated: size > max };
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
  // Lumen's built-in Google client or null (tests hand in their own; see features/google-client.js).
  const tt = (key, english) => { const v = deps.t?.(key); return v && v !== key ? v : english; }; // UI strings (locales/)
  const googleClient = () => (deps.googleClient ? deps.googleClient() : GC.builtinClient());
  const tokenUrl = () => deps.endpoints?.().googleToken || ENDPOINTS.googleToken;
  function sessionFor(name) {
    if (!sessions.has(name)) {
      sessions.set(name, OA.createSession({
        tokenUrl, post: formPost, now,
        load: () => OA.decodeCreds(deps.getSecret(name)),
        save: (c) => deps.setSecret(name, c ? OA.encodeCreds(c) : null),
        // With Lumen's own client there is no ID or secret to check: the advice is to connect again.
        messages: () => (name === 'gmail' && googleClient() && [undefined, '', googleClient().clientId].includes(OA.decodeCreds(deps.getSecret('gmail'))?.clientId)
          ? { client: 'Google stopped accepting Lumen’s sign-in for Gmail. Connect again in Settings; if that fails, add your own Client ID there.', reconnect: 'Google signed Lumen out of Gmail. Connect again from the Gmail card or Settings.' }
          : {}),
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
  const spotifyTokenFor = (name) => { if (!name) return {}; if (!spotifyTokens.has(name)) spotifyTokens.set(name, {}); return spotifyTokens.get(name); };
  function helpers(secretName, secretOverride) {
    const x = {
      endpoint: (name) => deps.endpoints?.()[name] || ENDPOINTS[name],
      now,
      secret: () => secretOverride || (secretName ? deps.getSecret(secretName) : null),
      setSecret: (value) => { if (secretName) deps.setSecret(secretName, value); },
      spotifyToken: spotifyTokenFor(secretName),
      // A small picture as a data: URL (Spotify's album art), kept for an hour. Throws when it isn't a
      // small enough JPEG, PNG or WebP from Spotify's own host.
      image: (url) => memo(`img:${url}`, 3600e3, async () => {
        if (!SV.isImageUrl(url)) throw new Error('Not a Spotify picture.');
        const res = await request(url, { max: SV.MAX_ART_BYTES + 1, headers: { Accept: 'image/*' } });
        const data = res.ok && !res.truncated ? SV.dataUrl(res.bytes) : null;
        if (!data) throw new Error('That picture can’t be shown.');
        return data;
      }),
      // The OAuth account behind this connector's secret; or one built from creds not stored yet (Check).
      session(creds) {
        if (!creds) return sessionFor(secretName);
        let held = creds;
        return OA.createSession({ tokenUrl, post: formPost, now, load: () => held, save: (c) => { held = c; } });
      },
      backoff(ms) { backoffUntil = Math.max(backoffUntil, now() + Math.min(120e3, Math.max(1e3, ms))); },
      googleClient,
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
      get slack() { return (this._slack ||= slackHelpers(x)); },
      projects: () => todoistProjects(x, x.secret() || ''),
      // The user's TradingView watchlists, { signedIn, lists }: one read a minute at most, shared by every card.
      tvLists: () => memo('tv:lists', 60e3, async () => {
        if (!deps.tradingviewLists) throw new Error('not available here');
        return TVW.shapeLists(await deps.tradingviewLists());
      }),
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

  // ---- Slack (features/slack-view.js, features/oauth.js) ----
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  // One Web API call. Slack answers 200 with { ok: false, error } for most failures; 429 carries Retry-After
  // (request() already backs every widget off for that long).
  async function slackRequest(x, access, method, params = {}) {
    const res = await request(`${x.endpoint('slack')}/${method}`, { method: 'POST', max: 1e6, body: OA.form(params), headers: { ...FORM, Authorization: `Bearer ${access}` } });
    if (res.status === 429) throw new SL.SlackError('ratelimited');
    let body = null;
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    if (!body || typeof body !== 'object') throw new Error(res.ok ? 'Slack sent something unexpected.' : `Slack answered ${res.status}.`);
    if (!body.ok) throw new SL.SlackError(typeof body.error === 'string' ? body.error.replace(/[^\w]/g, '').slice(0, 60) : 'unknown_error');
    return body;
  }
  // The stored sign-in, refreshed first when Slack's rotating token is about to expire.
  async function slackToken(x) {
    const tok = OA.unpackTokens(x.secret());
    if (!tok?.access) throw new SL.SlackError('not_authed');
    if (OA.isFresh(tok, now())) return tok;
    if (!tok.refresh || !tok.clientId || !tok.clientSecret) throw new SL.SlackError('token_expired');
    if (!slackRefreshing) {
      slackRefreshing = (async () => {
        const res = await request(`${x.endpoint('slack')}/oauth.v2.access`, { method: 'POST', max: 65536, body: SL.refreshForm({ clientId: tok.clientId, clientSecret: tok.clientSecret, refresh: tok.refresh }), headers: FORM });
        if (res.status === 429) throw new SL.SlackError('ratelimited');
        const next = { ...tok, ...SL.parseAccess(res.body, now(), tok) };
        x.setSecret(OA.packTokens(next));
        return next;
      })().finally(() => { slackRefreshing = null; });
    }
    return slackRefreshing;
  }
  function slackHelpers(x) {
    return {
      async call(method, params) {
        try {
          return await slackRequest(x, (await slackToken(x)).access, method, params);
        } catch (err) {
          if (err instanceof SL.SlackError && err.reconnect && !slackBad) { slackBad = true; deps.onUpdate?.(); }
          throw err;
        }
      },
      async identify(access) {
        const r = await slackRequest(x, access || (await slackToken(x)).access, 'auth.test');
        return { userId: str(r.user_id, 40), teamId: str(r.team_id, 40), teamName: str(r.team, 120), teamUrl: /^https:\/\/[\w.-]+\.slack\.com/.test(r.url || '') ? new URL(r.url).origin : '' };
      },
      userName: (id) => x.memo(`slack:user:${id}`, 3600e3, async () => {
        const u = (await x.slack.call('users.info', { user: id })).user || {};
        return str(u.profile?.display_name, 60) || str(u.real_name, 60) || str(u.name, 60);
      }),
    };
  }

  // ---- fetching ----
  function refresh(w, { force = false } = {}) {
    const c = connector(w);
    let entry = cache.get(w.id);
    if (!entry || entry.key !== keyOf(w)) { entry = { key: keyOf(w), data: null, error: null, at: 0, undo: entry?.undo }; cache.set(w.id, entry); }
    if (entry.pending) return entry.pending;
    if (entry.retryAt && now() < entry.retryAt) return Promise.resolve(false); // a rate limit said when to come back
    const age = now() - entry.at;
    const ttl = typeof c.ttl === 'function' ? c.ttl(entry.data) : c.ttl;
    const fresh = entry.at && age < (entry.error ? ERROR_TTL : ttl);
    if (fresh && (!force || age < MIN_REFRESH)) return Promise.resolve(false);
    if (force) { forget('tasks:'); forget('done:'); forget('gh:'); forget('wx:'); forget('wc:'); forget('tv:'); }
    entry.pending = Promise.resolve()
      .then(() => c.fetch(w, helpers(c.secret)))
      .then((data) => { entry.data = data; entry.error = null; entry.retryAt = 0; entry.okAt = now(); }, (err) => { entry.error = String(err?.message || err).slice(0, 200); entry.retryAt = err?.waitMs > 0 ? now() + err.waitMs : 0; })
      .then(() => { entry.at = now(); entry.pending = null; deps.onUpdate?.(); return true; });
    return entry.pending;
  }
  const connector = (w) => CONNECTORS[w.type];
  // What the new-tab page shows now; stale widgets refresh in the background.
  function forPage() {
    const all = list();
    const cards = all.map((w) => {
      const entry = cache.get(w.id);
      const current = entry && entry.key === keyOf(w) ? entry : null;
      if (!current?.pending) refresh(w).catch((err) => console.error('[lumen] widget refresh:', err.message));
      const undo = current?.undo && current.undo.until > now() ? { id: current.undo.id, title: current.undo.title } : null;
      let data = current?.data ? (undo ? { ...current.data, undo } : current.data) : null;
      if (data && connector(w).present) data = connector(w).present(w, data, { now: now(), offline: Boolean(current.error), spotifySignedIn: deps.spotifyWebSignedIn ? deps.spotifyWebSignedIn() : null });
      if (data && current.notice && current.notice.until > now()) data = { ...data, notice: current.notice.text };
      const layout = WL.rectOf(w);
      if (w.snap) layout.snap = w.snap;
      // With old data on hand a failed refresh is a warning under it ("offline"), not an empty card.
      const stack = w.stack ? { stack: ST.membersOf(all, w.stack), top: Boolean(w.top) } : {}; // the page draws the hidden members too (a switch is instant)
      return { id: w.id, type: w.type, title: w.title || connector(w).title(w), span: w.span, height: w.height, colors: w.colors || 'calendar', layout, ...stack, data, updated: current?.data ? current.okAt || current.at : 0, warning: current?.data ? current.error || null : null, error: current?.data ? null : current?.error ?? null, loading: !current?.data && !current?.error, ...(INLINE[w.type] ? { setup: { title: w.title || '', ...INLINE[w.type](w) } } : {}) };
    });
    return [...cards, ...SYS.forPage(sysList())]; // free system cards (Favorites moved, ...): the page draws them, see renderer/newtab-system.js
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
    // Paper trades survive an edit; the starting cash can only change while there are none (Reset first).
    if (prev?.pf && CONNECTORS[widget.type].portfolio) widget.pf = { cash0: prev.pf.trades.length ? prev.pf.cash0 : widget.pf?.cash0, trades: prev.pf.trades };
    const ci = cleanInput(input);
    if (prev) {
      // An edit keeps its place and size; the width and height pickers only count when they changed.
      Object.assign(widget, WL.rectOf(prev));
      if (prev.snap) widget.snap = prev.snap;
      Object.assign(widget, ST.cleanFields(prev)); // an edit stays in its stack (a new width takes the whole stack along only if it is the shown one)
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
    const next = ST.drop(widgets, id); // a stack shows its next member
    save(next);
    cache.delete(id);
    // The last widget that used a token takes the token with it.
    const secret = gone && CONNECTORS[gone.type].secret;
    if (secret && !next.some((w) => CONNECTORS[w.type].secret === secret)) {
      if (secret === 'gmail') revokeGoogle(OA.decodeCreds(deps.getSecret(secret)));
      deps.setSecret(secret, null);
      spotifyTokens.delete(secret);
      sessions.get(secret)?.invalidate();
    }
    deps.onUpdate?.();
    return true;
  }
  // Settings' up and down: swap places with the neighbour in reading order.
  function move(id, delta) {
    const widgets = list();
    const places = slots(widgets); // a stack moves as one (its hidden members follow its shown one)
    const i = places.findIndex((w) => w.id === id);
    const j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= places.length) return false;
    const a = places[i];
    const b = places[j];
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
    const places = slots(widgets);
    const it = places.find((w) => w.id === id);
    const target = places[Math.max(0, Math.min(places.length - 1, Math.trunc(to)))];
    if (!it || !target || target === it || !Number.isFinite(to)) return false;
    save(applyRects(widgets, WL.move(places.map(toItem), id, { x: target.x, y: target.y }, { packed: false })));
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
    save(applyRects(widgets, WL.resize(slots(widgets).map(toItem), id, want, { packed: false })));
    deps.onUpdate?.();
    return true;
  }
  // do=layout: the page's drag, resize and snap: rects for (some of) the widgets. Checked and clamped
  // here; the last size resized per kind is remembered for new widgets.
  function layout(items, dock) {
    const widgets = list();
    const sysBefore = sysList();
    const sysNext = SYS.applyLayout(sysBefore, items, dock);
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
    if (JSON.stringify(cleanList([...next, ...sysNext])) === JSON.stringify(cleanList([...widgets, ...sysBefore]))) return false;
    save(next, resized ? { homeWidgetSizes: { ...sizes(), [resized.type]: { w: resized.w, h: resized.h } } } : {}, sysNext);
    deps.onUpdate?.();
    return true;
  }
  // Settings' "Reset layout": every card its default size, packed in reading order.
  function resetLayout() {
    const widgets = list();
    const places = slots(widgets); // a stack stays a stack, at its shown member's default size
    const rects = WL.flowPack(places.map((w) => WL.defaultSize(w.type)));
    places.forEach((w, i) => { Object.assign(w, rects[i]); delete w.snap; });
    save(widgets, { homeWidgetSizes: {}, newTabClockSize: SYS.CLOCK_DEFAULT, newTabSearchWidth: SYS.SEARCH_DEFAULT }, []); // and every section back in the centre column, at its default clock and search size
    deps.onUpdate?.();
    return true;
  }
  // ---- Gmail: sign-in from Settings ----
  // The consent page opens in the user's default browser (deps.openExternal, https only); Google
  // redirects to a one-shot listener on 127.0.0.1 (features/oauth.js). Only this process sees the code,
  // the tokens and the client secret; Settings gets a message, never a token.
  let signIn = null;
  // What may have happened while Lumen waits. Until Google approves Lumen's client, it shows an "unverified app" page
  // (Advanced › Go to Lumen gets past it) or, for some accounts, "Access blocked" (only an own client helps then).
  const gmailBlockedHint = () => (googleClient()?.verified
    ? 'Still waiting. Finish signing in, in your browser, or try again.'
    : 'Still waiting. If Google says Lumen “hasn’t verified this app”, choose Advanced › Go to Lumen. If it says “Access blocked”, use your own Google Cloud client (Settings › Gmail › Advanced).');
  const staleGmail = () => { sessions.get('gmail')?.invalidate(); for (const w of list()) if (w.type === 'gmail') cache.delete(w.id); deps.onUpdate?.(); };
  // input: { clientId, clientSecret } from Settings' Advanced fields; both empty means Lumen's built-in
  // client ("Sign in with Google"). An own Client ID always wins over the built-in one.
  async function gmailConnect(input) {
    const { clientId, clientSecret } = gmailClient(input, OA.decodeCreds(deps.getSecret('gmail')), googleClient());
    if (!deps.openExternal) throw new Error('Lumen can’t open your browser here.');
    // Checked before the consent page opens: finding out after the user has already said yes loses the sign-in.
    if (deps.canKeepSecrets && !deps.canKeepSecrets()) throw new Error('This computer has no secure place for Lumen to keep the sign-in (the system keyring is off), so Gmail can’t be connected.');
    const builtin = googleClient()?.clientId === clientId;
    const authBase = deps.endpoints?.().googleAuth || ENDPOINTS.googleAuth;
    if (signIn) signIn.userCancelled = true; // (replaced: no need to come back for it)
    signIn?.cancel(); // one sign-in at a time
    const flow = await OA.beginSignIn({
      authorizeBase: authBase, tokenUrl: tokenUrl(), clientId, clientSecret, scope: GV.SCOPE, extra: GV.AUTH_EXTRA, post: formPost, now, timeoutMs: deps.signInMs,
      openExternal: (url) => { if (!url.startsWith(`${authBase}?`)) throw new Error('Refusing to open that address.'); return deps.openExternal(url); },
      messages: { title: 'Lumen', done: tt('gmail.signin.done', 'You can close this tab and go back to Lumen, which finishes connecting Gmail.'), denied: tt('gmail.signin.denied', 'Gmail was not connected. You can close this tab.') },
    });
    signIn = flow;
    try {
      let t;
      try {
        t = await flow.done;
      } catch (err) {
        // Lumen's own client: the user typed no Client ID, so "check them in Settings" would point nowhere.
        if (builtin && err?.kind === 'client') throw new Error('Lumen’s Google sign-in isn’t available right now. Update Lumen, or use your own Google Cloud client (Settings › Gmail › Advanced).');
        if (err?.kind === 'timeout') flow.userCancelled = true; // (no focus steal for someone who walked away)
        if (err?.kind === 'timeout') throw new Error(builtin && !googleClient()?.verified ? 'Sign-in timed out. If Google said Lumen “hasn’t verified this app”, choose Advanced › Go to Lumen next time; if it said “Access blocked”, use your own Google Cloud client (Settings › Gmail › Advanced).' : 'Sign-in timed out. Try again.');
        throw err;
      }
      const old = OA.decodeCreds(deps.getSecret('gmail'));
      // Which account this is (Gmail's profile: the read-only scope allows it), so Settings can say so.
      let email = '';
      try {
        const res = await deps.fetch(`${deps.endpoints?.().gmail || ENDPOINTS.gmail}/users/me/profile`, { headers: { Authorization: `Bearer ${t.access}` } });
        if (res.ok) email = String((await res.json())?.emailAddress || '').slice(0, 320);
      } catch { /* shown as "a Google account" */ }
      deps.setSecret('gmail', OA.encodeCreds({ clientId, clientSecret, refresh: t.refresh, email }));
      // Signed in again as someone else (or with another client): the grant it replaces is given back to Google. The
      // same account and client share one grant, so revoking its old token would end the new sign-in too.
      if (old?.refresh && old.refresh !== t.refresh && (old.clientId !== clientId || (old.email && email && old.email.toLowerCase() !== email.toLowerCase()))) revokeGoogle(old);
      staleGmail();
      return { message: email ? `Gmail is connected as ${email}.` : 'Gmail is connected.' };
    } finally {
      if (signIn === flow) signIn = null;
      if (!flow.userCancelled) deps.focusApp?.(); // back from the browser's consent page to Lumen, however it went
    }
  }
  const gmailCancel = () => { if (signIn) signIn.userCancelled = true; signIn?.cancel(); return true; };
  let pageSignIns = 0;
  // The card's "Sign in with Google" (do=signin): the same sign-in as Settings', with the widget's own
  // Client ID if it has one, else the built-in client. Only for a Gmail card that is not connected and
  // can sign in without typing anything; otherwise it opens Settings at the widget. The page learns
  // only what the card shows (a waiting or error line), never a token.
  function gmailSignInFromPage(w) {
    // Also when a sign-in is stored but Google stopped accepting it (the card asks to reconnect): a new sign-in replaces it.
    if (w.type !== 'gmail') return false;
    if (sessionFor('gmail').connected() && cache.get(w.id)?.data?.state !== 'reconnect') return false;
    if (!GC.uiState({ clientId: w.clientId, stored: OA.decodeCreds(deps.getSecret('gmail')), builtin: googleClient() }).oneClick) { pendingEdit = w.id; deps.onConfigure?.(w.id); return true; }
    const show = (message) => {
      const old = cache.get(w.id);
      const entry = old && old.key === keyOf(w) ? old : { key: keyOf(w), undo: old?.undo };
      Object.assign(entry, { data: GV.reconnect(message, { oneClick: true }), error: null, at: now() });
      cache.set(w.id, entry);
      deps.onUpdate?.();
    };
    const attempt = ++pageSignIns;
    show('Finish signing in, in your browser. Lumen is waiting…');
    // Google never comes back when it blocks the sign-in ("Access blocked", an unverified-app page): after a minute,
    // the card says what may have happened and what to do, instead of only waiting.
    const usesBuiltin = !GC.resolveClient({ clientId: w.clientId, stored: OA.decodeCreds(deps.getSecret('gmail')), builtin: googleClient() }).error && GC.resolveClient({ clientId: w.clientId, stored: OA.decodeCreds(deps.getSecret('gmail')), builtin: googleClient() }).source === 'builtin';
    const hint = setTimeout(() => { if (attempt === pageSignIns && !sessionFor('gmail').connected()) show(usesBuiltin ? gmailBlockedHint() : 'Still waiting. Finish signing in, in your browser, or try again.'); }, 60000);
    hint.unref?.();
    gmailConnect({ clientId: w.clientId })
      .then(() => Promise.all(list().filter((x) => x.type === 'gmail').map((x) => refresh(x, { force: true }).catch(() => {}))))
      .catch((err) => { if (attempt === pageSignIns) show(String(err?.message || err)); }) // a newer click's wait is not overwritten by the one it cancelled
      .finally(() => clearTimeout(hint));
    return true;
  }
  // Best effort: tell Google the refresh token is no longer wanted.
  function revokeGoogle(creds) {
    if (!creds?.refresh) return Promise.resolve(false);
    return formPost(deps.endpoints?.().googleRevoke || ENDPOINTS.googleRevoke, new URLSearchParams({ token: creds.refresh }).toString()).then((r) => Boolean(r?.ok), () => false);
  }
  // Forget the sign-in (the client id and secret stay, so connecting again is one click).
  async function gmailDisconnect() {
    const creds = OA.decodeCreds(deps.getSecret('gmail'));
    signIn?.cancel();
    if (creds?.refresh) deps.setSecret('gmail', OA.encodeCreds({ ...creds, refresh: '', email: '' }));
    staleGmail();
    lastRevoke = await revokeGoogle(creds);
    return true;
  }
  let lastRevoke = null; // whether Google confirmed the last disconnect's revoke (Settings says so only then)
  // Settings' project picker for a Todoist widget (a token typed but not saved yet may be given).
  // Settings' "Import from my TradingView account": the lists, fresh (not the minute-old answer).
  async function tradingviewLists() {
    forget('tv:lists');
    return helpers(null).tvLists();
  }
  async function projects(token) {
    const t = typeof token === 'string' ? token.trim() : '';
    if (t && !/^[A-Za-z0-9_-]{20,100}$/.test(t)) throw new Error('That doesn’t look like a Todoist API token.');
    const x = helpers('todoist', t || undefined);
    if (!x.secret()) throw new Error('Add your Todoist token first.');
    return [...(await x.projects())].map(([id, p]) => ({ id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
  }
  // ---- Spotify: sign-in (main.js opens the browser and the loopback listener) ----
  // Returns what main.js needs: the address to open, the state to check on return, and exchange(code),
  // which trades the code for tokens (the PKCE verifier stays in here) and stores the refresh token encrypted.
  function spotifyStart(clientIdInput) {
    const clientId = SV.effectiveClientId(clientIdInput);
    if (!clientId) throw new Error('Lumen’s own Spotify app isn’t available here. Add the Client ID of a Spotify app you made (32 letters and digits) on the Spotify widget’s page.');
    const p = SV.pkce();
    const x = helpers('spotify');
    return {
      url: SV.authorizeUrl(x.endpoint('spotifyAccounts'), { clientId, challenge: p.challenge, state: p.state }),
      state: p.state,
      async exchange(code) {
        if (typeof code !== 'string' || !/^[\w.~-]{1,2000}$/.test(code)) throw new Error('Spotify sent something unexpected.');
        const res = await x.raw(`${x.endpoint('spotifyAccounts')}/api/token`, {
          method: 'POST', max: 65536, body: SV.tokenForm('code', { clientId, code, verifier: p.verifier }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(SV.tokenError(res.status, res.body));
        const t = SV.parseToken(res.body, now());
        deps.setSecret('spotify', t.refresh);
        Object.assign(x.spotifyToken, { access: t.access, exp: t.exp, name: undefined });
        for (const w of list()) if (w.type === 'spotify') cache.delete(w.id);
        await spotifyName(x, clientId); // "Connected as …" in Settings
        deps.onUpdate?.();
        return true;
      },
    };
  }
  // Who is signed in, for Settings' status line (kept in memory, never stored). '' when unknown.
  async function spotifyName(x, clientId) {
    const tok = x.spotifyToken;
    if (!x.secret() || tok.namePending) return tok.name || '';
    tok.namePending = true;
    try {
      const me = await spotifyCall(x, { clientId }, 'GET', '/me');
      tok.name = me.ok ? str(JSON.parse(me.body)?.display_name, 60) || 'your account' : '';
    } catch { tok.name = ''; } finally { tok.namePending = false; }
    return tok.name;
  }
  // Settings' Disconnect: forget the refresh token (Spotify's own account page can revoke the app too).
  function spotifyDisconnect() {
    deps.setSecret('spotify', null);
    spotifyTokens.delete('spotify');
    for (const w of list()) if (w.type === 'spotify') cache.delete(w.id);
    deps.onUpdate?.();
    return true;
  }
  // ---- Slack: sign-in (Settings calls these; settings-backend.js opens the approval page) ----
  const slackReset = () => { slackBad = false; slackRefreshing = null; forget('slack:'); for (const w of list()) if (w.type === 'slack') cache.delete(w.id); deps.onUpdate?.(); };
  // For Settings: what is stored, never its values (the client id is not secret, so it prefills the form).
  function slackStatus() {
    const tok = OA.unpackTokens(deps.getSecret('slack'));
    return {
      connected: Boolean(tok?.access), team: tok?.teamName || '', reconnect: Boolean(tok?.access) && slackBad, canRefresh: Boolean(tok?.refresh),
      clientId: tok?.clientId || slackPending?.clientId || '', hasSecret: Boolean(tok?.clientSecret), redirect: SL.DEFAULT_REDIRECT, scopes: SL.USER_SCOPES, waiting: Boolean(slackPending),
    };
  }
  // Step 1: check the app's client id and secret (the stored secret is kept when the field is left empty),
  // remember them for the exchange, and return Slack's approval address for settings-backend to open.
  function slackStart(input) {
    const i = input && typeof input === 'object' ? input : {};
    const stored = OA.unpackTokens(deps.getSecret('slack'));
    const clientId = SL.cleanClientId(i.clientId) || (!i.clientId && stored?.clientId) || '';
    const clientSecret = SL.cleanClientSecret(i.clientSecret) || (!i.clientSecret && clientId === stored?.clientId && stored?.clientSecret) || '';
    const redirectUri = SL.cleanRedirect(i.redirect);
    if (!clientId) throw new Error('Paste your Slack app’s Client ID (Basic Information → App Credentials: two numbers with a dot).');
    if (!clientSecret) throw new Error('Paste your Slack app’s Client Secret (the same page). It is stored encrypted and never shown again.');
    if (!redirectUri) throw new Error('The redirect URL must be an https:// address. Add the same one under OAuth & Permissions → Redirect URLs in your Slack app.');
    slackPending = { state: OA.randomState(), clientId, clientSecret, redirectUri, at: now() };
    return { url: SL.authorizeUrl({ clientId, redirectUri, state: slackPending.state }), redirectUri };
  }
  // Step 2: the address the browser landed on after approving. Checks its state, trades the code for a
  // user token, learns the workspace, and stores everything encrypted (the code works once).
  async function slackFinish(pasted) {
    const p = slackPending;
    if (!p || now() - p.at > 15 * 60e3) { slackPending = null; throw new Error('That sign-in timed out. Start again with “Open Slack”.'); }
    const { code } = OA.parseRedirect(pasted, p.state);
    slackPending = null;
    const x = helpers('slack');
    const res = await request(`${x.endpoint('slack')}/oauth.v2.access`, { method: 'POST', max: 65536, body: SL.codeForm({ clientId: p.clientId, clientSecret: p.clientSecret, code, redirectUri: p.redirectUri }), headers: FORM });
    if (res.status === 429) throw new SL.SlackError('ratelimited');
    const t = SL.parseAccess(res.body, now());
    const who = await x.slack.identify(t.access).catch(() => ({}));
    deps.setSecret('slack', OA.packTokens({ ...t, teamUrl: who.teamUrl, clientId: p.clientId, clientSecret: p.clientSecret }));
    slackReset();
    return { message: `Connected to ${t.teamName || 'Slack'}.` };
  }
  function slackCancel() { slackPending = null; return true; }
  // Settings' Disconnect: revoke the token at Slack when possible, then forget everything stored.
  async function slackDisconnect() {
    const tok = OA.unpackTokens(deps.getSecret('slack'));
    slackPending = null;
    if (tok?.access) await slackRequest(helpers('slack'), tok.access, 'auth.revoke').catch(() => {});
    deps.setSecret('slack', null);
    slackReset();
    return true;
  }
  // The channels the signed-in user is in, for Settings' picker.
  async function slackChannels() {
    const x = helpers('slack');
    if (!OA.unpackTokens(x.secret())?.access) throw new Error('Sign in to Slack first.');
    const out = await x.slack.call('users.conversations', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200' });
    return (Array.isArray(out.channels) ? out.channels : []).filter((c) => c && /^[CG][A-Z0-9]{2,20}$/.test(String(c.id)))
      .map((c) => ({ id: c.id, name: str(c.name, 80), private: Boolean(c.is_private) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
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
  // For Settings' Spotify page: the redirect to register on an own app, where the Client ID in use comes
  // from ('user' is per widget, so Settings works that out), and who is signed in.
  function spotifyState() {
    const x = helpers('spotify');
    const source = SV.clientIdSource({ env: process.env.LUMEN_SPOTIFY_CLIENT_ID });
    if (x.secret() && x.spotifyToken.name === undefined && !x.spotifyToken.namePending) {
      const own = list().find((w) => w.type === 'spotify')?.clientId;
      const id = SV.effectiveClientId(own);
      if (id) spotifyName(x, id).then(() => deps.onUpdate?.());
    }
    return { redirect: SV.REDIRECT_URI, shared: source !== 'none', name: x.secret() ? x.spotifyToken.name || '' : '' };
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
      gmailAccount: OA.decodeCreds(deps.getSecret('gmail'))?.refresh ? OA.decodeCreds(deps.getSecret('gmail'))?.email || '' : '', // which one, when known
      gmailSignedOut: !OA.decodeCreds(deps.getSecret('gmail'))?.refresh ? OA.decodeCreds(deps.getSecret('gmail'))?.email || '' : '', // Google ended this account's sign-in (a disconnect forgets the address)
      gmailClient: { builtin: Boolean(googleClient()), verified: Boolean(googleClient()?.verified), revoked: lastRevoke }, // Lumen has its own Google client: Settings leads with "Sign in with Google" (never the id or secret)
      slack: slackStatus(),
      secrets: Object.fromEntries([...new Set(Object.values(CONNECTORS).map((c) => c.secret).filter(Boolean))].map((s) => [s, Boolean(deps.getSecret(s))])),
      feedPresets: FEED.PRESETS.map(({ id, name }) => ({ id, name })),
      recipeExamples: CW.EXAMPLES,
      max: MAX_WIDGETS,
      spans: SPANS,
      edit: typeof edit === 'string' ? edit : null,
      create: edit?.create || null, // the page's Add widget picked a kind: Settings opens the new-widget form for it
      spotify: spotifyState(),
    };
  }

  // ---- page actions ----
  // The new-tab page asks by loading itself with ?widget=<id>&do=<action>[&task=<id>] (like its Ask
  // AI box): refresh, complete, undo (&task), add (&text), play, pause, next, previous (Spotify), signin (Gmail), place (&to=<index>), size (&span, &height),
  // layout (&l=<id:x,y,w,h[,snap];…>), remove, configure, and a stack's cycle (show this member), stack (&onto=<id>) and unstack. main.js cancels that navigation and passes
  // the URL here. Null when it isn't one; { invalid: true } when it is one that is refused.
  function actionFrom(url) {
    let params;
    try { params = new URL(url).searchParams; } catch { return null; }
    const id = params.get('widget');
    if (id === null) return null;
    const action = { id, do: params.get('do'), task: params.get('task') };
    if (!/^w[0-9a-z]{4,20}$/.test(id) || !/^(refresh|complete|undo|add|place|size|layout|remove|configure|consent|locate|restore|create|reset|look|play|pause|next|previous|ask|buy|sell|resetpf|signin|cycle|stack|unstack|note|timer|setup)$/.test(action.do || '') || (action.task !== null && !/^[\w-]{1,40}$/.test(action.task))) return { invalid: true };
    if ((action.do === 'complete' || action.do === 'undo') && !action.task) return { invalid: true };
    if (action.do === 'add') {
      action.text = str(params.get('text'), 300);
      if (!action.text) return { invalid: true };
    }
    if (action.do === 'ask') {
      action.text = MV.cleanQuestion(params.get('text'));
      if (!action.text) return { invalid: true };
    }
    if (action.do === 'buy' || action.do === 'sell') {
      action.sym = params.get('sym');
      const qty = params.get('qty') || '';
      if (!MK.SYM_RE.test(action.sym || '') || !/^\d{1,8}(\.\d{1,8})?$/.test(qty) || !(Number(qty) > 0) || Number(qty) > MK.MAX_QTY) return { invalid: true };
      action.qty = Number(qty);
    }
    if (action.do === 'setup') { // the page's own add/edit form: its input as JSON, checked like Settings' (cleanInput, resolve)
      let cfg;
      try { cfg = JSON.parse(params.get('cfg') || ''); } catch { return { invalid: true }; }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !Object.prototype.hasOwnProperty.call(INLINE, cfg.type) || (params.get('cfg') || '').length > 12000) return { invalid: true };
      action.cfg = cfg;
      action.create = id === 'wcreate';
    }
    if (action.do === 'note') action.text = (params.get('text') || '').slice(0, LW.MAX_NOTE); // may be empty: the note was cleared
    if (action.do === 'timer') {
      action.arg = params.get('arg');
      if (!['start', 'pause', 'reset', 'skip'].includes(action.arg)) return { invalid: true };
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
      action.dock = (params.get('d') || '').split(',').filter(SYS.isSystemId).slice(0, SYS.IDS.length); // system cards back to the centre column
    }
    if (action.do === 'look') { // the clock's size (k=clock&v=s|m|l|xl), the search bar's width (k=search&v=480-960) and the clock card's own choices (features/widget-config.js LOOK)
      const look = WCFG.cleanLook(params.get('k'), params.get('v'));
      if (!look) return { invalid: true };
      action.key = look.key;
      action.value = look.value;
    }
    if (action.do === 'stack') { // Edit layout: this widget (and its stack) dropped onto another of the same size
      action.onto = params.get('onto');
      if (!/^w[0-9a-z]{4,20}$/.test(action.onto || '') || action.onto === id) return { invalid: true };
    }
    if (action.do === 'create') { // the page's Add widget: open Settings' new-widget form for a kind
      action.type = Object.prototype.hasOwnProperty.call(CONNECTORS, params.get('type')) ? params.get('type') : null;
      if (!action.type) return { invalid: true };
    }
    return action;
  }
  // ---- the new-tab page's edit mode: hiding a section, removing with Undo ----
  // A system card: layout (moved, resized, docked), remove (hides the section: its Settings toggle) or nothing else.
  function setSectionShown(id, shown) {
    const pref = SYS.prefOf(id);
    if (!pref) return false;
    deps.writeSettings({ ...deps.readSettings(), [pref]: shown });
    deps.onUpdate?.();
    return true;
  }
  function actSystem(action) {
    if (action.do === 'layout') return layout(action.items, action.dock);
    if (action.do === 'remove') return setSectionShown(action.id, false);
    return false;
  }
  // The page's remove badge: the widget goes, but its settings (and token) are kept for a few seconds so Undo can bring it back.
  function removeFromPage(w) {
    const name = CONNECTORS[w.type].secret;
    trash.hold({ id: w.id, widget: w, secretName: name || null, secret: name ? deps.getSecret(name) || null : null });
    return remove(w.id);
  }
  // do=restore: Undo of a removal, or "show again" for a section that was hidden.
  function restore(id) {
    if (SYS.isSystemId(id)) return setSectionShown(id, true);
    const held = trash.take(id);
    if (!held) return false;
    const widgets = list();
    if (widgets.length >= MAX_WIDGETS || widgets.some((w) => w.id === id)) return false;
    if (held.secret && held.secretName) deps.setSecret(held.secretName, held.secret);
    save([...widgets, held.widget]);
    deps.onUpdate?.();
    return true;
  }
  // A stack's arrow (cycle: show this member), Edit layout's drop onto a same-size card (stack) and its
  // "Remove from stack" (unstack). The choice of what is shown is stored, so every new tab shows it.
  function stackAct(action) {
    const widgets = list();
    const next = action.do === 'cycle' ? ST.select(widgets, action.id) : action.do === 'stack' ? ST.join(widgets, action.id, action.onto) : ST.leave(widgets, action.id, WL);
    if (!next) return false;
    save(next);
    deps.onUpdate?.();
    return true;
  }
  async function act(action) {
    if (action.do === 'create') { pendingEdit = { create: action.type }; deps.onConfigure?.(null); return true; }
    if (action.do === 'restore') return restore(action.id);
    if (action.do === 'look') { deps.writeSettings({ ...deps.readSettings(), [action.key]: action.value }); deps.onUpdate?.(); return true; }
    if (action.do === 'reset') return resetLayout(); // Edit layout's Reset layout (the page keeps an Undo for it)
    if (action.do === 'setup') return setupFromPage(action);
    if (SYS.isSystemId(action.id)) return actSystem(action);
    const w = list().find((x) => x.id === action.id);
    if (!w) return false;
    if (action.do === 'refresh') return refresh(w, { force: true });
    if (action.do === 'place') return place(w.id, action.to);
    if (action.do === 'size') return resize(w.id, { span: action.span, height: action.height });
    if (action.do === 'layout') return layout(action.items, action.dock);
    if (action.do === 'remove') return removeFromPage(w);
    if (action.do === 'cycle' || action.do === 'stack' || action.do === 'unstack') return stackAct(action);
    if (action.do === 'consent') return setLocationConsent(action.arg);
    if (action.do === 'locate') return relocate();
    if (action.do === 'configure') { pendingEdit = w.id; deps.onConfigure?.(w.id); return true; }
    if (action.do === 'signin') return gmailSignInFromPage(w);
    const c = connector(w);
    const entry = cache.get(w.id);
    if (!c.act || !entry?.data) return false;
    try {
      const done = await c.act(w, action, helpers(c.secret), entry.data, { now: now(), offline: Boolean(entry.error) });
      if (!done) return false;
      if (done.keep) { deps.onUpdate?.(); return true; } // nothing to fetch again (a Muse answer costs money)
      forget('tasks:');
      forget('done:');
      if (done.config) save(list().map((x) => (x.id === w.id ? { ...x, ...done.config } : x)));
      if (done.notice) {
        entry.notice = { text: String(done.notice).slice(0, 200), until: now() + 8000 };
        setTimeout(() => { if (entry.notice && entry.notice.until <= now()) { entry.notice = null; deps.onUpdate?.(); } }, 8050);
      }
      if (done.local) { deps.onUpdate?.(); return true; }
      if (done.undo) {
        entry.undo = { ...done.undo, until: now() + UNDO_MS };
        setTimeout(() => { if (entry.undo && entry.undo.until <= now()) { entry.undo = null; deps.onUpdate?.(); } }, UNDO_MS + 50);
      }
      if (done.undone) entry.undo = null;
      deps.onUpdate?.(); // the task leaves the card at once
      entry.at = 0; // and the list is fetched again
      setTimeout(() => refresh(w).catch(() => {}), done.delay ?? (done.undo ? 800 : 0));
      return true;
    } catch (err) {
      entry.error = String(err?.message || err).slice(0, 200);
      entry.data = { ...entry.data, notice: entry.error };
      deps.onUpdate?.();
      return false;
    }
  }

  // do=setup: the new-tab page's own form adds (id wcreate) or edits one of the INLINE kinds. The same
  // checks as Settings (saveWidget -> cleanInput -> the connector's resolve); the answer goes back to the
  // page that asked: { ok, message, id }.
  async function setupFromPage(action) {
    const input = { ...action.cfg };
    const prev = action.create ? null : list().find((x) => x.id === action.id);
    if (!action.create && (!prev || prev.type !== input.type)) return { ok: false, message: 'That widget is gone.' };
    if (prev?.type === 'notes') input.note = prev.note; // editing a note's card keeps what is written on it
    if (WCFG.KINDS.includes(input.type)) Object.assign(input, WCFG.mergeEdit(prev, input)); // the form's few fields over the saved settings
    try {
      const { widget, message } = await saveWidget(input, prev ? prev.id : null);
      return { ok: true, message: message || 'Saved.', id: widget.id };
    } catch (err) {
      return { ok: false, message: String(err?.message || err).slice(0, 300) };
    }
  }

  // flush: forget everything fetched (tests point the connectors at a fake server after the first page already asked).
  const flush = () => { epoch++; cache.clear(); memoCache.clear(); };
  return { flush, list, forPage, refresh, refreshAll, test, save: saveWidget, remove, restore, move, place, resize, layout, resetLayout, projects, tradingviewLists, search, setSavedPlaces, setLocationConsent, relocate, state, actionFrom, act, cache, spotifyStart, spotifyDisconnect, gmailConnect, gmailCancel, gmailDisconnect, slackStatus, slackStart, slackFinish, slackCancel, slackDisconnect, slackChannels };
}

module.exports = { INLINE, createWidgets, cleanList, cleanWidget, cleanSizes, httpsUrl, CONNECTORS, ENDPOINTS, SPANS, HEIGHTS, MAX_WIDGETS };
