// The settings page (lumen://settings): preferences stored in settings.json and the browser
// behaviour behind them. main.js calls in through small hooks marked "[settings]".
//
// The page itself is renderer/settings.html in an ordinary tab, but that tab alone gets
// settings-preload.js. It can't navigate anywhere else, open windows, or be driven by the AI
// agent, and every IPC call below checks that it came from that tab's settings document.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { registrableDomain } = require('../browser/tab-groups');
const { related } = require('../features/site-activity');
const { cleanList: cleanWidgets, cleanSizes } = require('../features/widgets');
const { requestedHints, withHints } = require('../browser/chrome-identity');

const SETTINGS_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'settings.html')).href;
const HTTPS_ONLY_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'https-only.html')).href;
const SETTINGS_PRELOAD = path.join(__dirname, '..', 'preload', 'settings-preload.js');
// The sidebar's categories (renderer/settings.js CATEGORIES), and every id lumen://settings/<id> also opens: the old
// section ids (mapped to a category) and the sub-pages.
const SECTIONS = ['general', 'appearance', 'home', 'tabs', 'privacy', 'search', 'ai', 'extensions', 'downloads', 'updates', 'advanced'];
const SECTION_LINKS = [...SECTIONS, 'you-and-ai', 'ai-keys', 'default-browser', 'startup', 'languages', 'accessibility', 'system', 'reset', 'about',
  'skills', 'usage', 'internals', 'task-manager', 'widgets', 'site-permissions', 'connect-agents', 'mcp-servers', 'passwords'];
const UPDATES_URL = 'https://github.com/emah-maker/lumen/releases';

const isSettingsUrl = (url) => typeof url === 'string' && (url === SETTINGS_URL || url.startsWith(`${SETTINGS_URL}#`));
const urlFor = (section) => (SECTION_LINKS.includes(section) ? `${SETTINGS_URL}#${section}` : SETTINGS_URL);
const displayUrl = (url) => {
  const section = url.split('#')[1] || '';
  return `lumen://settings${section ? `/${section}` : ''}`;
};
// lumen://settings[/section] (chrome://settings works too) -> the section, or null.
function parseSettingsInput(text) {
  const m = /^(?:lumen|chrome):\/\/settings\/?([a-z-]*)\/?$/i.exec(String(text || '').trim());
  return m ? { section: m[1].toLowerCase() } : null;
}

// Every preference the page owns, with its default. Stored flat in settings.json, next to the
// existing keys (searchEngine, adblock, adblockAllow, …).
const DEFAULTS = {
  theme: 'system', // nativeTheme.themeSource: also what websites see as prefers-color-scheme
  accentColor: 'blue', // [look] a preset from ACCENTS, or '#rrggbb'
  newTabBackground: 'plain', // [look] plain | aurora | dusk | ocean | forest | sunset | graphite | image
  newTabWidgetGlass: 'solid', // [look] the widget cards' background: solid | frosted (see-through, blurred) | clear (as transparent as it stays readable)
  newTabEffect: 'none', // [look] an animated layer over the background: none | particles | stars | bubbles | snow
  newTabEffectColor: 'auto', // [look] auto (white, or the text color on Plain) | accent | rainbow | #rrggbb
  newTabEffectAmount: 'normal', // [look] few | normal | many
  newTabEffectSpeed: 'normal', // [look] slow | normal | fast
  newTabEffectSize: 'normal', // [look] small | normal | large
  newTabEffectInteract: true, // [look] the pointer pulls, lights up or pushes the particles
  newTabImage: 0, // [look] when the wallpaper file (newtab-wallpaper.jpg in the profile) was last set; 0: none
  newTabClock: true, // [look] the big clock above the greeting
  newTabClockSize: 'm', // [look] the clock's size: s | m | l | xl (Edit layout on the page resizes it too)
  newTabClockStyle: 'classic', // [look] the clock's look (features/clock-styles.js): classic | rounded | thin | serif | mono | bold
  newTabClockHours: 'auto', // [look] auto (as the system language writes it) | 12 | 24
  newTabClockSeconds: false, // [look] show seconds, small, after the minutes
  newTabClockDate: true, // [look] the date under (or, in Thin, over) the clock
  newTabClockCard: 'none', // [look] behind the clock and date: none | soft | glass
  newTabClockShadow: false, // [look] a stronger shadow under the clock and greeting over a background or picture
  newTabGreetingFont: 'classic', // [look] the greeting's face: classic | match (the clock's) | rounded | serif | thin | mono | hand
  newTabSearchWidth: 640, // [look] the centred column / search bar width in px, 480-960
  newTabName: '', // [look] "Good evening, <name>"
  newTabHeader: true, // [look] the date and greeting (a system card, features/widget-system.js)
  newTabFavorites: true,
  newTabFrequent: true,
  newTabPrivacy: true,
  newTabWidgetsPacked: false, // [widgets] Keep widgets packed: cards slide up into gaps (off: a card stays in the cell it was put in)
  homeWidgetSizes: {}, // [widgets] the last size used per kind of widget (the default for a new one); internal
  weatherPlaces: [], // [widgets] places saved from weather widgets (features/weather-view.js); internal
  weatherHere: null, // [widgets] the last "My location" answer { name, lat, lon, at }, kept an hour; internal
  weatherLocation: 'unset', // [widgets] may Lumen ask an IP service which city this is? unset | granted | denied
  homeWidgets: [], // [widgets] [{ id, type, title, ...config }], in order (features/widgets.js); changed through prefs:widget-*
  forceDarkWebsites: false, // Chromium's auto dark mode (restart)
  defaultZoom: 1,
  fontSize: 16,
  showBookmarkButton: true,
  compactTabs: false,
  startup: 'restore', // restore | newtab | pages
  startupPages: [],
  blockThirdPartyCookies: false,
  sendDoNotTrack: false,
  sendGpc: false,
  httpsOnly: false,
  safeBrowsing: false, // Google Safe Browsing warnings (features/safe-browsing.js); needs the user's API key
  adblock: true,
  adblockAllow: [],
  permissionDefaults: {}, // permission -> 'ask' | 'block'
  downloadDir: '',
  askWhereToSave: false,
  spellcheck: true,
  spellcheckLanguages: [],
  languages: [], // Accept-Language, most preferred first; empty = Chromium's default
  reduceMotion: false,
  minimumFontSize: 0,
  focusRings: false,
  hardwareAcceleration: true, // restart
  tabSleep: true, // free memory from long-unused background tabs (main.js sweepSleep)
  performanceMode: 'auto', // auto | on | off: lighter running on a slow PC (features/performance.js)
  proxy: { mode: 'system', rules: '', pacUrl: '', bypass: '' },
  keepRunningInBackground: true, // macOS: keep running with no windows
  organizeOnlyMixed: true, // [tabs] automatic organize only when the loose tabs are a mix of topics
  organizeDelaySeconds: 5, // [tabs] seconds after the tabs change before loose tabs are organized (features/organize-learn.js ORGANIZE_DELAYS)
  maxSteps: 0, // [ai] most steps the sidebar AI takes per task; 0: unlimited (agent.js stepLimit, loop-guard.js STEP_CHOICES)
  autoModel: true, // [ai] Claude Code with no model picked: choose haiku / sonnet / opus per message by task difficulty (features/model-route.js)
  autoFallback: true, // [ai] a model out of usage or unreachable: the same turn goes on another connected model, and back when it recovers (ai/fallback.js)
  aiSignedInSites: [], // [ai] hosts the sidebar's AI may always read with the user's signed-in session: [{ host, added }] (features/signed-in-sites.js); added only from its approval card
  grokWarmup: true, // [ai] prepare Grok Build in the background after startup (features/grok-warmup.js); acts only while Grok Build is connected or picked
  researchTabs: true, // [ai] web_search / read_urls also open what they look at in background tabs, grouped "AI: <query>" (features/research-tabs.js)
  translateOffer: true, // offer to translate pages in another language (features/translate.js); never automatic
  translateTarget: '', // '' = Lumen's language
  translateNever: [], // sites where the offer stays away
  translateConsent: [], // providers the user allowed to receive page text
  autoDownloadUpdates: true, // Windows setup installs: fetch new versions in the background (features/updates.js)
  showWhatsNew: true, // the release notes come up once after Lumen updates (features/whats-new.js)
  lastSeenVersion: '', // the newest Lumen version run in this profile ('' until the first run records it); internal
};
const RESTART_KEYS = ['hardwareAcceleration', 'forceDarkWebsites'];
const PERMISSIONS = { geolocation: 'Location', media: 'Camera and microphone', notifications: 'Notifications', 'clipboard-read': 'Clipboard' };
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const FONT_SIZES = [9, 12, 16, 20, 24];
// Site storage cleared along with cookies (Clear browsing data).
const SITE_STORAGES = ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'];
// [look] Accent colors: Apple's system colors, each with its light- and dark-mode shade.
const ACCENTS = {
  blue: ['#007aff', '#0a84ff'], indigo: ['#5856d6', '#5e5ce6'], purple: ['#af52de', '#bf5af2'], pink: ['#ff2d55', '#ff375f'],
  red: ['#ff3b30', '#ff453a'], orange: ['#ff9500', '#ff9f0a'], green: ['#28a745', '#30d158'], teal: ['#30b0c7', '#40c8e0'], graphite: ['#8e8e93', '#98989d'],
};
const NEW_TAB_BACKGROUNDS = ['plain', 'aurora', 'dusk', 'ocean', 'forest', 'sunset', 'graphite', 'image'];
const NEW_TAB_EFFECTS = ['none', 'particles', 'stars', 'bubbles', 'snow'];
const EFFECT_LEVELS = { newTabEffectAmount: ['few', 'normal', 'many'], newTabEffectSpeed: ['slow', 'normal', 'fast'], newTabEffectSize: ['small', 'normal', 'large'] };
const HEX = /^#[0-9a-f]{6}$/i;
const accentOf = (value) => (ACCENTS[value] ? { light: ACCENTS[value][0], dark: ACCENTS[value][1] } : HEX.test(value) ? { light: value.toLowerCase(), dark: value.toLowerCase() } : { light: ACCENTS.blue[0], dark: ACCENTS.blue[1] });
const RANGES = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 28 * 86400e3, all: Infinity };

const translate = require('../features/translate');
const WS = require('../features/widget-system'); // the clock's steps and the search bar's width range
const CS = require('../features/clock-styles'); // [look] the clock's styles and the greeting's fonts
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const bool = (v) => v === true;
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
const webUrl = (u) => /^https?:\/\/[^\s]+$/i.test(String(u || '').trim());
const langTag = (l) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(String(l));

// Coerce a value for `key` to something valid, or throw.
function validate(key, value) {
  switch (key) {
    case 'theme': return pick(value, ['system', 'light', 'dark'], null);
    case 'accentColor': return ACCENTS[value] || HEX.test(String(value)) ? String(value).toLowerCase() : null;
    case 'newTabBackground': return pick(value, NEW_TAB_BACKGROUNDS, null);
    case 'newTabEffect': return pick(value, NEW_TAB_EFFECTS, null);
    case 'newTabWidgetGlass': return pick(value, ['solid', 'frosted', 'clear'], null);
    case 'newTabEffectColor': return ['auto', 'accent', 'rainbow'].includes(value) || HEX.test(String(value)) ? String(value).toLowerCase() : null;
    case 'newTabEffectAmount': case 'newTabEffectSpeed': case 'newTabEffectSize': return pick(value, EFFECT_LEVELS[key], null);
    case 'newTabClockSize': return WS.cleanClockSize(value);
    case 'newTabClockStyle': return CS.cleanStyle(value);
    case 'newTabClockHours': return CS.cleanHours(value);
    case 'newTabClockCard': return CS.cleanCard(value);
    case 'newTabGreetingFont': return CS.cleanGreetingFont(value);
    case 'newTabSearchWidth': return WS.cleanSearchWidth(value);
    case 'newTabName': return String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    case 'newTabImage': return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    case 'defaultZoom': return pick(Number(value), ZOOMS, null);
    case 'fontSize': return pick(Number(value), FONT_SIZES, null);
    case 'minimumFontSize': return pick(Number(value), [0, 6, 9, 12, 16, 20, 24], null);
    case 'maxSteps': return pick(Number(value), [0, 30, 60, 120, 250], null);
    case 'organizeDelaySeconds': return pick(Number(value), [2, 5, 10, 30, 60], null);
    case 'startup': return pick(value, ['restore', 'newtab', 'pages'], null);
    case 'performanceMode': return pick(value, ['auto', 'on', 'off'], null);
    case 'startupPages':
      return Array.isArray(value) ? value.map((u) => String(u).trim()).filter(webUrl).slice(0, 20) : null;
    case 'aiSignedInSites': return require('../features/signed-in-sites').clean(value); // no sensitive hosts, valid hosts only
    case 'translateNever': return translate.cleanHosts(value);
    case 'translateConsent': return translate.cleanConsent(value);
    case 'translateTarget': return value === '' || translate.LANG_CODES.includes(value) ? value : null;
    case 'adblockAllow':
      return Array.isArray(value) ? [...new Set(value.map((h) => String(h).trim().toLowerCase().replace(/^www\./, '')).filter((h) => /^[a-z0-9.-]+$/.test(h)))] : null;
    case 'permissionDefaults':
      if (!value || typeof value !== 'object') return null;
      return Object.fromEntries(Object.keys(PERMISSIONS).filter((p) => value[p]).map((p) => [p, pick(value[p], ['ask', 'block'], 'ask')]));
    case 'downloadDir': {
      const dir = String(value || '');
      return dir === '' || (path.isAbsolute(dir) && fs.existsSync(dir)) ? dir : null;
    }
    case 'spellcheckLanguages':
    case 'languages':
      return Array.isArray(value) ? [...new Set(value.map(String).filter(langTag))].slice(0, 12) : null;
    case 'homeWidgets': return cleanWidgets(value);
    case 'homeWidgetSizes': return cleanSizes(value);
    case 'weatherLocation': return pick(value, ['unset', 'granted', 'denied'], null);
    case 'lastSeenVersion': return value === '' ? '' : require('../features/whats-new').cleanVersion(value);
    case 'proxy': {
      if (!value || typeof value !== 'object') return null;
      const mode = pick(value.mode, ['system', 'direct', 'fixed_servers', 'pac_script', 'auto_detect'], null);
      if (!mode) return null;
      return { mode, rules: String(value.rules || '').trim().slice(0, 500), pacUrl: String(value.pacUrl || '').trim().slice(0, 500), bypass: String(value.bypass || '').trim().slice(0, 500) };
    }
    default:
      return typeof DEFAULTS[key] === 'boolean' && typeof value === 'boolean' ? value : null;
  }
}

// q-weighted Accept-Language: en-US,en;q=0.9,fr;q=0.8
function acceptLanguage(langs) {
  const out = [];
  for (const l of langs) {
    if (!out.includes(l)) out.push(l);
    const base = l.split('-')[0];
    if (base !== l && !langs.includes(base) && !out.includes(base)) out.push(base);
  }
  return out.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(',');
}

const isLocalHost = (host) => host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]'
  || /^(10|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || !host.includes('.');

// Settings read before the app is ready: GPU and Chromium feature switches only apply at launch.
function applyAtLaunch(app, settings) {
  const launched = { hardwareAcceleration: settings.hardwareAcceleration !== false, forceDarkWebsites: settings.forceDarkWebsites === true };
  if (!launched.hardwareAcceleration) app.disableHardwareAcceleration();
  if (launched.forceDarkWebsites) app.commandLine.appendSwitch('enable-features', 'WebContentsForceDark');
  return launched;
}

function create(deps) {
  const { app, session, nativeTheme, dialog, shell, readSettings, writeSettings } = deps;
  const launched = applyAtLaunch(app, readSettings());
  const userZoomed = new Set(); // hosts the user zoomed by hand: the default zoom leaves them alone
  const upgraded = new Map(); // webContents id -> { from, to } while an HTTPS-only upgrade loads
  const httpAllowed = new Set(); // hosts the user chose to visit over http this session

  function prefs() {
    const s = readSettings();
    const out = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const valid = s[key] === undefined ? null : validate(key, s[key]);
      out[key] = valid === null ? structuredClone(fallback) : valid;
    }
    return out;
  }
  const ses = () => session.defaultSession;

  // ---- appearance ----
  const isGoogleSearch = (url) => /^https:\/\/(www\.)?google\.[a-z.]+\/(search|webhp)?/i.test(url);
  function applyTheme() {
    nativeTheme.themeSource = prefs().theme;
  }
  // Google renders its theme on the server from the Sec-CH-Prefers-Color-Scheme hint, so an open
  // results page only follows a theme change once it reloads.
  function reloadGoogleTabs() {
    for (const wc of deps.tabContents()) if (isGoogleSearch(wc.getURL())) wc.reload();
  }
  function applyDefaultZoom(wc) {
    let host;
    try { host = new URL(wc.getURL()).host; } catch { return; }
    if (!/^https?:/.test(wc.getURL()) || userZoomed.has(host)) return;
    wc.setZoomFactor(prefs().defaultZoom);
  }
  function uiPrefs() {
    const p = prefs();
    return { compactTabs: p.compactTabs, showBookmarkButton: p.showBookmarkButton, reduceMotion: p.reduceMotion, focusRings: p.focusRings, lite: Boolean(deps.performance?.active()), accent: accentOf(p.accentColor) };
  }

  // ---- [look] the new-tab page's design (newtab.js reads it from the page's hash) ----
  const wallpaperFile = () => path.join(app.getPath('userData'), 'newtab-wallpaper.jpg');
  // The wallpaper's dominant colours (widgets set to "Match screen" tint themselves with them): sampled once
  // per picture from a 32 px copy, in this process, and kept until the picture changes.
  let imageColorsCache = { v: 0, colors: [] };
  function imageColorsFor(version) {
    if (imageColorsCache.v === version) return imageColorsCache.colors;
    let colors = [];
    try {
      const small = require('electron').nativeImage.createFromPath(wallpaperFile()).resize({ width: 32, height: 32, quality: 'good' });
      const bgra = small.toBitmap();
      const rgba = new Uint8ClampedArray(bgra.length);
      for (let i = 0; i + 3 < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = bgra[i + 3]; }
      colors = require('../features/widget-colors').dominantColors(rgba, 3);
    } catch (err) { console.error('[lumen] could not sample the background picture:', err.message); }
    imageColorsCache = { v: version, colors };
    return colors;
  }
  function newTabLook() {
    const p = prefs();
    const image = p.newTabBackground === 'image' && p.newTabImage && fs.existsSync(wallpaperFile())
      ? `${pathToFileURL(wallpaperFile()).href}?v=${p.newTabImage}` : null;
    return {
      background: image ? 'image' : p.newTabBackground === 'image' ? 'plain' : p.newTabBackground,
      image,
      // Reduce motion draws one still frame; Performance mode keeps the effect sparser and slower.
      effect: p.newTabEffect, still: Boolean(p.reduceMotion), lite: Boolean(deps.performance?.active()),
      effectStyle: { color: p.newTabEffectColor, amount: p.newTabEffectAmount, speed: p.newTabEffectSpeed, size: p.newTabEffectSize, interact: p.newTabEffectInteract !== false },
      accent: accentOf(p.accentColor),
      clock: p.newTabClock, clockSize: p.newTabClockSize, searchWidth: p.newTabSearchWidth, name: p.newTabName,
      clockStyle: { style: p.newTabClockStyle, hours: p.newTabClockHours, seconds: p.newTabClockSeconds, date: p.newTabClockDate, card: p.newTabClockCard, shadow: p.newTabClockShadow, greeting: p.newTabGreetingFont },
      sections: { header: p.newTabHeader !== false, favorites: p.newTabFavorites, frequent: p.newTabFrequent, privacy: p.newTabPrivacy },
      widgetsPacked: p.newTabWidgetsPacked === true,
      widgetGlass: p.newTabWidgetGlass,
      imageColors: image ? imageColorsFor(p.newTabImage) : [],
    };
  }
  // A picture from disk, made at most 2560 px wide and saved as JPEG in the profile, so the page
  // never depends on the original staying where it was.
  async function pickWallpaper() {
    const { canceled, filePaths } = await dialog.showOpenDialog(deps.win(), {
      title: 'Choose a background picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif', 'bmp', 'tif', 'tiff'] }],
    });
    if (canceled || !filePaths[0]) return state();
    let image = require('electron').nativeImage.createFromPath(filePaths[0]);
    if (image.isEmpty()) throw new Error('That file isn’t a picture Lumen can read.');
    const { width } = image.getSize();
    if (width > 2560) image = image.resize({ width: 2560, quality: 'best' });
    fs.writeFileSync(wallpaperFile(), image.toJPEG(88));
    writeSettings({ ...readSettings(), newTabImage: Date.now(), newTabBackground: 'image' });
    deps.refreshNewTabs?.();
    return state();
  }
  function removeWallpaper() {
    try { fs.rmSync(wallpaperFile(), { force: true }); } catch (err) { console.error('[lumen] could not remove the background picture:', err.message); }
    writeSettings({ ...readSettings(), newTabImage: 0, newTabBackground: prefs().newTabBackground === 'image' ? 'plain' : prefs().newTabBackground });
    deps.refreshNewTabs?.();
    return state();
  }

  // ---- languages ----
  function applySpellcheck() {
    const p = prefs();
    ses().setSpellCheckerEnabled(p.spellcheck);
    if (process.platform === 'darwin') return; // macOS picks the language itself; the API is a no-op there
    const available = ses().availableSpellCheckerLanguages;
    const wanted = p.spellcheckLanguages.filter((l) => available.includes(l));
    try {
      if (wanted.length) ses().setSpellCheckerLanguages(wanted);
    } catch (err) {
      console.error('Spell check languages:', err.message);
    }
  }

  // ---- proxy ----
  function applyProxy() {
    const { mode, rules, pacUrl, bypass } = prefs().proxy;
    const config = { mode };
    if (mode === 'fixed_servers') Object.assign(config, { proxyRules: rules, proxyBypassRules: bypass });
    if (mode === 'pac_script') config.pacScript = pacUrl;
    return Promise.all([ses(), ...mirrored].map((target) => target.setProxy(config).catch((err) => console.error('Proxy:', err.message))));
  }
  // Other sessions that follow the profile's network settings (proxy, request headers): the research tabs'
  // isolated session must not go around a proxy the user set, or ignore Do Not Track / language.
  const mirrored = new Set();
  function mirrorSession(target) {
    if (mirrored.has(target)) return;
    mirrored.add(target);
    applyProxy();
    setupHeaders(target);
  }

  // ---- request headers: the one onBeforeSendHeaders listener (the ad blocker owns the others) ----
  function isThirdParty(details) {
    if (details.resourceType === 'mainFrame') return false;
    const top = details.webContents?.getURL() || details.referrer || '';
    if (!/^https?:/.test(top)) return false;
    return registrableDomain(top) !== registrableDomain(details.url);
  }
  const hintOrigins = new Set(); // origins whose responses asked for Sec-CH-Prefers-Color-Scheme
  const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
  const wantsColorHint = (url) => hintOrigins.has(originOf(url)) || /^https:\/\/([a-z0-9-]+\.)*google\.[a-z.]+$/i.test(originOf(url));
  // Called with every response's headers (from the ad blocker's onHeadersReceived wrapper in main.js).
  const uaHintOrigins = new Map(); // origin -> the user-agent hints (Sec-CH-UA-Arch…) its responses asked for
  function noteResponseHeaders(details) {
    for (const [name, values] of Object.entries(details.responseHeaders || {})) {
      if (!/^(accept-ch|critical-ch)$/i.test(name)) continue;
      const value = [].concat(values).join(',');
      const origin = originOf(details.url);
      if (value.toLowerCase().includes('sec-ch-prefers-color-scheme')) {
        hintOrigins.add(origin);
        if (hintOrigins.size > 1000) hintOrigins.delete(hintOrigins.values().next().value); // oldest first
      }
      // Electron keeps no client-hints store, so what Chrome would now send to this origin (Google asks for the
      // full version list, platform version, architecture…) is remembered here and added by setupHeaders.
      const asked = deps.chromeHighEntropy ? requestedHints(value) : [];
      if (asked.length) {
        uaHintOrigins.set(origin, [...new Set([...(uaHintOrigins.get(origin) || []), ...asked])]);
        if (uaHintOrigins.size > 1000) uaHintOrigins.delete(uaHintOrigins.keys().next().value);
      }
    }
  }
  // Chrome sends client hints only to secure origins: https, and http on localhost.
  function sendsClientHints(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'wss:' || (/^(http|ws):$/.test(u.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname));
    } catch {
      return false;
    }
  }
  // Every request asks: the prefs are worked out again only when the settings change (a new cache object).
  let hot = null;
  const hotPrefs = () => {
    const ref = deps.peekSettings?.();
    if (!ref) return prefs();
    if (hot?.ref !== ref) hot = { ref, value: prefs() };
    return hot.value;
  };
  const googleAuth = require('../browser/google-auth-identity'); // Google sign-in is Firefox's identity, not Chrome's
  const firefoxProfile = googleAuth.firefoxProfile(process.platform);
  function setupHeaders(target = ses()) {
    target.webRequest.onBeforeSendHeaders((details, callback) => {
      const p = hotPrefs();
      let headers = details.requestHeaders;
      if (deps.chromeHintHeaders && sendsClientHints(details.url)) {
        // Every Sec-CH-UA* hint is ours (Chromium's own list names no "Google Chrome"), first in the list as in Chrome.
        const asked = deps.chromeHighEntropy && uaHintOrigins.get(originOf(details.url));
        headers = withHints(headers, asked ? { ...deps.chromeHintHeaders, ...deps.chromeHighEntropy(asked) } : deps.chromeHintHeaders);
      }
      if (p.sendDoNotTrack) headers.DNT = '1';
      if (p.sendGpc) headers['Sec-GPC'] = '1';
      if (p.languages.length) headers['Accept-Language'] = acceptLanguage(p.languages);
      // Electron has no client-hints store, so Chromium never sends this hint itself; Google (which
      // renders its theme on the server) and sites that asked for it get it from here.
      if (wantsColorHint(details.url)) headers['Sec-CH-Prefers-Color-Scheme'] = nativeTheme.shouldUseDarkColors ? '"dark"' : '"light"';
      if (p.blockThirdPartyCookies && isThirdParty(details)) {
        for (const name of Object.keys(headers)) if (name.toLowerCase() === 'cookie') delete headers[name];
      }
      // Google's sign-in hosts see Firefox (Firefox's User-Agent, no client hints), last so nothing above adds one back.
      if (googleAuth.isAuthUrl(details.url)) headers = googleAuth.firefoxRequestHeaders(headers, firefoxProfile);
      callback({ requestHeaders: headers });
    });
  }

  // ---- site permissions ----
  function loadPermissions(decisions) {
    for (const [key, allowed] of Object.entries(readSettings().sitePermissions || {})) {
      if (typeof allowed === 'boolean') decisions.set(key, allowed);
    }
  }
  function savePermissions(decisions) {
    writeSettings({ ...readSettings(), sitePermissions: Object.fromEntries(decisions) });
  }
  const permissionDefault = (permission) => prefs().permissionDefaults[permission] || 'ask';

  // ---- HTTPS-only ----
  // The ad blocker owns onBeforeRequest, so upgrades happen at navigation start: the https address
  // loads in place of the http one.
  function upgrade(wc, url) {
    if (!prefs().httpsOnly) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' || isLocalHost(u.hostname) || httpAllowed.has(u.host)) return false;
    const current = wc.getURL();
    if (current.startsWith(HTTPS_ONLY_URL) && new URL(current).searchParams.get('url') === url) {
      httpAllowed.add(u.host); // "Continue to site" on the warning page
      return false;
    }
    // A site whose https address sends you back to http (by redirect or script) looped forever:
    // upgrade, bounce back, upgrade again. The second time round, or after 3 upgrades of one host
    // within 10 s, the warning page shows instead, with its "Continue to site" choice.
    const pending = upgraded.get(wc.id);
    const now = Date.now();
    const recent = (recentUpgrades.get(u.host) || []).filter((t) => now - t < 10000);
    if ((pending && new URL(pending.to).host === u.host) || recent.length >= 3) {
      upgraded.delete(wc.id);
      recentUpgrades.delete(u.host);
      setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(`${HTTPS_ONLY_URL}?${new URLSearchParams({ url })}`).catch(() => {}); });
      return true;
    }
    recentUpgrades.set(u.host, [...recent, now]);
    if (recentUpgrades.size > 200) recentUpgrades.delete(recentUpgrades.keys().next().value);
    u.protocol = 'https:';
    upgraded.set(wc.id, { from: url, to: u.href });
    // (Calling wc.stop() inside did-start-navigation crashes Electron; the new load replaces it.)
    setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(u.href).catch(() => {}); });
    return true;
  }
  const recentUpgrades = new Map(); // host -> times it was upgraded lately (the loop guard above)
  // Called from did-fail-load: true when the failure was an upgraded load (the warning shows instead).
  function onFailLoad(wc, failedUrl) {
    const pending = upgraded.get(wc.id);
    if (!pending || pending.to !== failedUrl) return false;
    upgraded.delete(wc.id);
    wc.loadURL(`${HTTPS_ONLY_URL}?${new URLSearchParams({ url: pending.from })}`).catch(() => {});
    return true;
  }

  // Every ordinary tab: default zoom, HTTPS-only.
  function attachTab(wc) {
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) upgrade(wc, details.url);
    });
    wc.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame && prefs().httpsOnly && /^http:/i.test(url) && upgrade(wc, url)) event.preventDefault();
    });
    wc.on('did-navigate', (_e, url) => {
      // The upgraded load committed (maybe after an https redirect elsewhere on the site): done.
      if (upgraded.has(wc.id) && /^https:/i.test(url)) upgraded.delete(wc.id);
      applyDefaultZoom(wc);
    });
    wc.once('destroyed', () => upgraded.delete(wc.id));
  }
  function noteUserZoom(wc) {
    try { userZoomed.add(new URL(wc.getURL()).host); } catch {}
  }
  // "Actual size" means the default zoom from Settings for web pages (100% for Lumen's own pages),
  // and the site follows that default again from now on.
  function resetZoom(wc) {
    try { userZoomed.delete(new URL(wc.getURL()).host); } catch {}
    if (/^https?:/.test(wc.getURL())) wc.setZoomFactor(prefs().defaultZoom);
    else wc.setZoomLevel(0);
  }

  // The settings tab: nothing but the settings page may load in it.
  function guardSettingsTab(wc, leave) {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-frame-navigate', (event) => { if (!event.isMainFrame || !isSettingsUrl(event.url)) event.preventDefault(); });
    wc.on('will-navigate', (event) => { if (!isSettingsUrl(event.url)) event.preventDefault(); });
    wc.on('will-redirect', (event) => event.preventDefault());
    // Anything else that commits here (a browser-initiated load that got past the hooks) moves to a
    // normal tab and this one closes. The preload and the IPC checks ignore non-settings documents.
    // (did-start-navigation fires before will-frame-navigate is prevented, so it can't be used.)
    wc.on('did-navigate', (_e, url) => { if (!isSettingsUrl(url)) setImmediate(() => leave(url)); });
    wc.on('will-attach-webview', (event) => event.preventDefault());
  }

  function tabWebPreferences(privileged) {
    const p = prefs();
    return {
      defaultFontSize: p.fontSize,
      defaultMonospaceFontSize: Math.round(p.fontSize * 0.8125),
      ...(p.minimumFontSize ? { minimumFontSize: p.minimumFontSize } : {}),
      spellcheck: p.spellcheck,
      plugins: true, // Widevine CDM registers as a Pepper plugin; needed for DRM playback (castlabs ECS)
      disableBlinkFeatures: 'AutomationControlled', // navigator.webdriver stays false in every renderer, whatever the process-wide switch did (ai-agents.js prepareAutomation)
      ...(privileged ? { preload: SETTINGS_PRELOAD } : {}),
    };
  }

  // Spelling suggestions at the top of the context menu.
  function spellingItems(wc, params) {
    if (!params.misspelledWord) return [];
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    return [
      ...(suggestions.length
        ? suggestions.map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) }))
        : [{ label: 'No spelling suggestions', enabled: false }]),
      { label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      { type: 'separator' },
    ];
  }

  // ---- downloads ----
  const downloadDir = () => prefs().downloadDir || app.getPath('downloads');
  const askWhereToSave = () => prefs().askWhereToSave;

  // ---- startup ----
  function startupPlan() {
    const { startup, startupPages } = prefs();
    return { mode: startup === 'pages' && !startupPages.length ? 'newtab' : startup, pages: startupPages };
  }

  // Apply a changed preference to the running browser.
  function apply(key) {
    switch (key) {
      case 'theme': applyTheme(); reloadGoogleTabs(); break;
      case 'defaultZoom': for (const wc of deps.tabContents()) applyDefaultZoom(wc); break;
      case 'spellcheck': case 'spellcheckLanguages': applySpellcheck(); break;
      case 'proxy': return applyProxy();
      // The blocker reads these on every request, so the change applies to whatever loads next.
      // Open tabs are left alone: reloading every one of them lost whatever was typed in their forms.
      case 'adblock': case 'adblockAllow': break;
      case 'safeBrowsing': deps.onSafeBrowsingChange?.(); break;
      case 'performanceMode': deps.performance?.refresh(); break;
      default: break;
    }
    if (['compactTabs', 'showBookmarkButton', 'reduceMotion', 'focusRings', 'accentColor'].includes(key)) deps.ui()?.send('prefs:ui', uiPrefs());
    if (key === 'accentColor' || key.startsWith('newTab') || key === 'homeWidgets' || key === 'reduceMotion' || key === 'performanceMode') deps.refreshNewTabs?.(); // [look] open new-tab pages follow at once
    return undefined;
  }

  async function set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
    if (key === 'homeWidgets') throw new Error('Widgets are changed with prefs:widget-save'); // each one is looked up and checked first
    if (['homeWidgetSizes', 'weatherPlaces', 'weatherHere', 'weatherLocation'].includes(key)) throw new Error('That is changed through the widget calls'); // [widgets]
    if (key === 'lastSeenVersion') throw new Error('Lumen records the version itself'); // [what's new]
    if (key === 'aiSignedInSites') throw new Error('Signed-in sites are added from the AI\'s approval card and removed with settings:remove-signed-in-site'); // [signed-in sites]
    const valid = validate(key, value);
    if (valid === null) throw new Error(`Invalid value for ${key}`);
    writeSettings({ ...readSettings(), [key]: valid });
    await apply(key);
    return state();
  }

  function state() {
    const p = prefs();
    return {
      prefs: p,
      performance: deps.performance?.info() ?? null, // Settings → System notes why Performance mode is on
      accent: accentOf(p.accentColor), // [look]
      restartNeeded: RESTART_KEYS.filter((k) => p[k] !== launched[k]),
      platform: process.platform,
      zooms: ZOOMS,
      fontSizes: FONT_SIZES,
      clockStyles: CS.CLOCK_STYLES, greetingFonts: CS.GREETING_FONTS, // [look] Settings → Home's pickers
      permissions: PERMISSIONS,
      defaultDownloadDir: app.getPath('downloads'),
      spellcheckAvailable: process.platform === 'darwin' ? [] : ses().availableSpellCheckerLanguages,
      spellcheckActive: process.platform === 'darwin' ? [] : ses().getSpellCheckerLanguages(),
      systemLocale: app.getLocale(),
      acceptLanguagePreview: p.languages.length ? acceptLanguage(p.languages) : '',
    };
  }

  // ---- clear browsing data ----
  async function clearData({ range = 'hour', history = false, cookies = false, cache = false, downloads = false } = {}) {
    const span = RANGES[range] ?? RANGES.hour;
    const since = span === Infinity ? 0 : Date.now() - span;
    const done = {};
    // Sites active in the range, read before history is cleared: the origins of pages visited, and
    // the domains that stored cookies (features/site-activity.js).
    const recent = span === Infinity ? null : recentSites(since);
    if (history) {
      const map = deps.history();
      let removed = 0;
      for (const [url, entry] of map) if ((entry.last || 0) >= since) { map.delete(url); removed++; }
      deps.saveHistory();
      done.history = removed;
    }
    if (cookies && !recent) {
      await ses().clearStorageData({ storages: ['cookies', ...SITE_STORAGES] });
      deps.siteActivity?.clear();
      done.cookies = true;
    } else if (cookies) {
      // Cookies have no creation time and Electron clears site storage only for all time or per
      // origin, so a time range means: everything stored by the sites active in that range.
      const hosts = recent.hosts;
      let removed = 0;
      for (const c of await ses().cookies.get({})) {
        const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
        if (!hosts.some((h) => related(d, h))) continue;
        const url = `${c.secure ? 'https' : 'http'}://${d}${c.path || '/'}`;
        await ses().cookies.remove(url, c.name).then(() => { removed++; }, () => {});
      }
      for (const origin of recent.origins) await ses().clearStorageData({ origin, storages: SITE_STORAGES }).catch(() => {});
      deps.siteActivity?.forget(hosts);
      done.cookies = true;
      done.sites = hosts.length;
      done.cookieCount = removed;
    }
    if (cache) {
      // Electron has no time range for the HTTP cache: it is cleared for all time.
      await ses().clearCache();
      done.cache = true;
    }
    if (downloads) done.downloads = clearDownloads(since);
    return done;
  }
  function recentSites(since) {
    const origins = new Set();
    const hosts = new Set(deps.siteActivity?.since(since) || []);
    for (const [url, entry] of deps.history()) {
      if ((entry.last || 0) < since) continue;
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        origins.add(u.origin);
        hosts.add(u.hostname.toLowerCase());
      } catch { /* not a URL */ }
    }
    for (const h of hosts) { origins.add(`https://${h}`); origins.add(`http://${h}`); }
    return { hosts: [...hosts], origins: [...origins] };
  }
  function clearDownloads(since = 0) {
    if (!Number.isFinite(since)) since = 0; // prefs:clear-downloads: the whole list
    const list = deps.downloads;
    const before = list.length;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].state !== 'progressing' && (list[i].started || 0) >= since) list.splice(i, 1);
    deps.sendDownloads();
    return before - list.length;
  }

  // ---- about / task manager / internals ----
  function about() {
    return {
      name: app.getName(),
      version: app.getVersion(),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
      cliPinned: deps.cliPinnedVersion(),
      appPath: app.getAppPath(),
      exePath: process.execPath,
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
      os: `${process.platform} ${process.getSystemVersion()} (${process.arch})`,
      updatesUrl: UPDATES_URL,
    };
  }
  function taskManager() {
    const byPid = new Map();
    for (const { id, title, wc } of deps.tabsInfo()) {
      const pid = wc.getOSProcessId();
      byPid.set(pid, [...(byPid.get(pid) || []), { id, title }]);
    }
    return app.getAppMetrics().map((m) => {
      const tabsHere = byPid.get(m.pid) || [];
      const name = tabsHere.length ? tabsHere.map((t) => `Tab: ${t.title || 'Untitled'}`).join(', ')
        : m.type === 'Browser' ? 'Browser' : m.type === 'GPU' ? 'GPU process' : m.name || m.serviceName || m.type;
      return {
        pid: m.pid,
        type: m.type,
        name,
        cpu: Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10,
        memoryKB: m.memory?.workingSetSize || 0,
        tabIds: tabsHere.map((t) => t.id),
      };
    }).sort((a, b) => b.memoryKB - a.memoryKB);
  }
  function restartTabProcess(tabId) {
    const tab = deps.tabsInfo().find((t) => t.id === tabId);
    if (!tab || tab.settings) return false;
    tab.wc.forcefullyCrashRenderer();
    setTimeout(() => { if (!tab.wc.isDestroyed()) tab.wc.reload(); }, 300);
    return true;
  }
  async function internals() {
    const s = ses();
    const gpu = await app.getGPUInfo('basic').catch(() => null);
    const cookieCount = await s.cookies.get({}).then((c) => c.length).catch(() => null);
    return {
      gpuFeatures: app.getGPUFeatureStatus(),
      gpuDevices: (gpu?.gpuDevice || []).map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, driver: d.driverVersion || '' })),
      hardwareAcceleration: launched.hardwareAcceleration,
      sessions: [{
        name: 'Default',
        persistent: s.isPersistent(),
        storagePath: s.storagePath,
        cacheBytes: await s.getCacheSize().catch(() => null),
        cookies: cookieCount,
        userAgent: s.getUserAgent(),
        proxyForExample: await s.resolveProxy('https://example.com').catch(() => ''),
        spellcheck: s.isSpellCheckerEnabled(),
      }],
      commandLine: process.argv.slice(1).filter((a) => a.startsWith('--')),
    };
  }

  // ---- extensions ----
  function listExtensions() {
    return ses().extensions.getAllExtensions()
      .filter((ext) => ext.manifest.name && !ext.id.startsWith('chrome-web-store'))
      .map((ext) => ({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        description: ext.manifest.description || '',
        options: ext.manifest.options_ui?.page || ext.manifest.options_page || '',
      }));
  }

  // ---- reset ----
  async function reset() {
    const s = readSettings();
    for (const key of [...Object.keys(DEFAULTS), 'searchEngine', 'sitePermissions']) if (key !== 'lastSeenVersion') delete s[key]; // not a preference: a reset doesn't bring back old release notes
    writeSettings(s);
    deps.permissionDecisions.clear();
    userZoomed.clear();
    httpAllowed.clear();
    for (const key of Object.keys(DEFAULTS)) await apply(key);
    deps.onSearchEngineReset?.();
    return state();
  }

  // ---- IPC: only the settings tab's own document may call these ----
  function registerIpc(ipcMain) {
    const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
      if (!deps.isSettingsSender(event)) throw new Error('Not allowed');
      return fn(...args);
    });
    handle('prefs:get', state);
    handle('prefs:set', set);
    handle('prefs:clear-data', clearData);
    handle('prefs:clear-downloads', clearDownloads);
    handle('prefs:downloads', () => deps.downloads.map(({ id, name, path: file, state: st, received, total }) => ({ id, name, path: file, state: st, received, total })));
    handle('prefs:open-download', (id) => {
      const d = deps.downloads.find((x) => x.id === id);
      if (d?.state === 'completed') shell.showItemInFolder(d.path);
    });
    handle('prefs:pick-wallpaper', pickWallpaper); // [look]
    handle('prefs:remove-wallpaper', removeWallpaper);
    // [widgets] the new-tab page's widgets (features/widgets.js): tokens go in, never come back out
    handle('prefs:widgets', () => deps.widgets.state());
    handle('prefs:widget-test', (input) => deps.widgets.test(input));
    handle('prefs:widget-save', async (input, id) => { const out = await deps.widgets.save(input, typeof id === 'string' ? id : null); return { message: out.message, state: deps.widgets.state() }; });
    handle('prefs:widget-remove', (id) => { deps.widgets.remove(String(id)); return deps.widgets.state(); });
    handle('prefs:widget-gmail-connect', async (input) => { const out = await deps.widgets.gmailConnect(input); return { message: out.message, state: deps.widgets.state() }; });
    handle('prefs:widget-gmail-cancel', () => deps.widgets.gmailCancel());
    handle('prefs:widget-gmail-disconnect', async () => { await deps.widgets.gmailDisconnect(); return deps.widgets.state(); });
    handle('prefs:widget-projects', (token) => deps.widgets.projects(token));
    handle('prefs:widget-tv-lists', () => deps.widgets.tradingviewLists());
    // A "Where do I get this?" link on a widget's page: only these fixed addresses, chosen by name, open in the browser.
    const WIDGET_HELP = {
      todoist: 'https://app.todoist.com/app/settings/integrations/developer', github: 'https://github.com/settings/personal-access-tokens', twelvedata: 'https://twelvedata.com/account/api-keys',
      coingecko: 'https://www.coingecko.com/en/api', muse: 'https://dev.meta.ai', spotify: 'https://developer.spotify.com/dashboard', gmail: 'https://console.cloud.google.com/apis/credentials',
      slack: 'https://api.slack.com/apps', calendar: 'https://support.google.com/calendar/answer/37648',
    };
    handle('prefs:widget-help', (key) => { const url = Object.hasOwn(WIDGET_HELP, key) ? WIDGET_HELP[key] : null; if (url) shell.openExternal(url).catch(() => {}); return Boolean(url); });
    // Slack sign-in: Open Slack (the approval page opens in the default browser), then the pasted address finishes it.
    handle('prefs:slack-start', (input) => {
      const out = deps.widgets.slackStart(input);
      if (!out.url.startsWith('https://slack.com/oauth/v2/authorize?')) throw new Error('Not allowed');
      shell.openExternal(out.url).catch(() => {});
      return { redirectUri: out.redirectUri, state: deps.widgets.state() };
    });
    handle('prefs:slack-finish', async (pasted) => { const out = await deps.widgets.slackFinish(pasted); return { message: out.message, state: deps.widgets.state() }; });
    handle('prefs:slack-cancel', () => { deps.widgets.slackCancel(); return deps.widgets.state(); });
    handle('prefs:slack-disconnect', async () => { await deps.widgets.slackDisconnect(); return deps.widgets.state(); });
    handle('prefs:slack-channels', () => deps.widgets.slackChannels());
    handle('prefs:widget-search', (query) => deps.widgets.search(query));
    handle('prefs:widget-saved-places', (list) => { deps.widgets.setSavedPlaces(list); return deps.widgets.state(); });
    handle('prefs:widget-location', (choice) => { deps.widgets.setLocationConsent(String(choice)); return deps.widgets.state(); });
    handle('prefs:widget-reset-layout', () => { deps.widgets.resetLayout(); return deps.widgets.state(); });
    handle('prefs:widget-move', (id, delta) => { deps.widgets.move(String(id), Number(delta)); return deps.widgets.state(); });
    handle('prefs:pick-download-dir', async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(deps.win(), { properties: ['openDirectory', 'createDirectory'], defaultPath: downloadDir() });
      return canceled || !filePaths[0] ? state() : set('downloadDir', filePaths[0]);
    });
    handle('prefs:site-permissions', () => [...deps.permissionDecisions].map(([key, allowed]) => {
      const i = key.lastIndexOf('|');
      return { origin: key.slice(0, i), permission: key.slice(i + 1), label: PERMISSIONS[key.slice(i + 1)] || key.slice(i + 1), allowed };
    }));
    handle('prefs:revoke-permission', (origin, permission) => {
      const removed = deps.permissionDecisions.delete(`${origin}|${permission}`);
      savePermissions(deps.permissionDecisions);
      return removed;
    });
    handle('prefs:extensions', listExtensions);
    handle('prefs:remove-extension', async (id) => {
      await deps.uninstallExtension(id, { session: ses() }).catch(() => {});
      return listExtensions();
    });
    handle('prefs:extension-options', (id) => {
      const ext = listExtensions().find((e) => e.id === id);
      if (ext?.options) deps.openTab(`chrome-extension://${id}/${ext.options}`);
    });
    handle('prefs:open-url', (url) => { if (/^https:\/\//.test(url)) deps.openTab(url); });
    handle('prefs:reset', reset);
    handle('prefs:relaunch', () => {
      if (require('../test-mode').isTest()) return false; // tests check the saved value instead
      app.relaunch();
      app.quit();
      return true;
    });
    handle('prefs:about', about);
    handle('prefs:whats-new', () => { deps.showWhatsNew?.(); return true; }); // the notes open over the window; the page doesn't wait for them
    handle('prefs:task-manager', taskManager);
    handle('prefs:restart-tab', restartTabProcess);
    handle('prefs:internals', internals);
    handle('prefs:usage', (options) => deps.usage?.summary({ refresh: Boolean(options?.refresh) }) ?? null); // [usage]
    handle('prefs:clear-usage', () => { deps.usage?.clear(); return true; });
    handle('prefs:usage-budget', (budget) => deps.usage?.setBudget(budget) ?? null); // [usage] the Grok budget
    ipcMain.handle('prefs:ui', () => uiPrefs()); // the browser UI's own classes (compact tabs, …)
  }

  // Once the app is ready.
  function start(ipcMain) {
    applyTheme();
    applySpellcheck();
    applyProxy();
    setupHeaders();
    registerIpc(ipcMain);
  }

  return {
    prefs, set, state, start, attachTab, mirrorSession, pushUiPrefs: () => deps.ui()?.send('prefs:ui', uiPrefs()), guardSettingsTab, tabWebPreferences, spellingItems, onFailLoad,
    noteUserZoom, resetZoom, noteResponseHeaders, downloadDir, askWhereToSave, startupPlan, loadPermissions, savePermissions, permissionDefault,
    clearData, uiPrefs, launched, newTabLook,
  };
}

module.exports = { create, validate, ACCENTS, NEW_TAB_BACKGROUNDS, NEW_TAB_EFFECTS, SETTINGS_URL, HTTPS_ONLY_URL, SECTIONS, SECTION_LINKS, isSettingsUrl, urlFor, displayUrl, parseSettingsInput, acceptLanguage, DEFAULTS };
