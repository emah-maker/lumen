// The settings page (lumen://settings): preferences stored in settings.json and the browser
// behaviour behind them. main.js calls in through small hooks marked "[settings]".
//
// The page itself is renderer/settings.html in an ordinary tab, but that tab alone gets
// settings-preload.js. It can't navigate anywhere else, open windows, or be driven by the AI
// agent, and every IPC call below checks that it came from that tab's settings document.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { registrableDomain } = require('./tab-groups');

const SETTINGS_URL = pathToFileURL(path.join(__dirname, 'renderer', 'settings.html')).href;
const HTTPS_ONLY_URL = pathToFileURL(path.join(__dirname, 'renderer', 'https-only.html')).href;
const SETTINGS_PRELOAD = path.join(__dirname, 'settings-preload.js');
const SECTIONS = ['you-and-ai', 'appearance', 'search', 'startup', 'privacy', 'downloads', 'languages', 'accessibility', 'system', 'extensions', 'reset', 'about', 'internals'];
const UPDATES_URL = 'https://github.com/emah-maker/lumen/releases';

const isSettingsUrl = (url) => typeof url === 'string' && (url === SETTINGS_URL || url.startsWith(`${SETTINGS_URL}#`));
const urlFor = (section) => (SECTIONS.includes(section) ? `${SETTINGS_URL}#${section}` : SETTINGS_URL);
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
  proxy: { mode: 'system', rules: '', pacUrl: '', bypass: '' },
  keepRunningInBackground: true, // macOS: keep running with no windows
};
const RESTART_KEYS = ['hardwareAcceleration', 'forceDarkWebsites'];
const PERMISSIONS = { geolocation: 'Location', media: 'Camera and microphone', notifications: 'Notifications', 'clipboard-read': 'Clipboard' };
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const FONT_SIZES = [9, 12, 16, 20, 24];
const RANGES = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 28 * 86400e3, all: Infinity };

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const bool = (v) => v === true;
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
const webUrl = (u) => /^https?:\/\/[^\s]+$/i.test(String(u || '').trim());
const langTag = (l) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(String(l));

// Coerce a value for `key` to something valid, or throw.
function validate(key, value) {
  switch (key) {
    case 'theme': return pick(value, ['system', 'light', 'dark'], null);
    case 'defaultZoom': return pick(Number(value), ZOOMS, null);
    case 'fontSize': return pick(Number(value), FONT_SIZES, null);
    case 'minimumFontSize': return pick(Number(value), [0, 6, 9, 12, 16, 20, 24], null);
    case 'startup': return pick(value, ['restore', 'newtab', 'pages'], null);
    case 'startupPages':
      return Array.isArray(value) ? value.map((u) => String(u).trim()).filter(webUrl).slice(0, 20) : null;
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
    return { compactTabs: p.compactTabs, showBookmarkButton: p.showBookmarkButton, reduceMotion: p.reduceMotion, focusRings: p.focusRings };
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
    return ses().setProxy(config).catch((err) => console.error('Proxy:', err.message));
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
  function noteResponseHeaders(details) {
    for (const [name, values] of Object.entries(details.responseHeaders || {})) {
      if (!/^(accept-ch|critical-ch)$/i.test(name)) continue;
      if ([].concat(values).join(',').toLowerCase().includes('sec-ch-prefers-color-scheme')) hintOrigins.add(originOf(details.url));
    }
  }
  function setupHeaders() {
    ses().webRequest.onBeforeSendHeaders((details, callback) => {
      const p = prefs();
      const headers = details.requestHeaders;
      if (p.sendDoNotTrack) headers.DNT = '1';
      if (p.sendGpc) headers['Sec-GPC'] = '1';
      if (p.languages.length) headers['Accept-Language'] = acceptLanguage(p.languages);
      // Electron has no client-hints store, so Chromium never sends this hint itself; Google (which
      // renders its theme on the server) and sites that asked for it get it from here.
      if (wantsColorHint(details.url)) headers['Sec-CH-Prefers-Color-Scheme'] = nativeTheme.shouldUseDarkColors ? '"dark"' : '"light"';
      if (p.blockThirdPartyCookies && isThirdParty(details)) {
        for (const name of Object.keys(headers)) if (name.toLowerCase() === 'cookie') delete headers[name];
      }
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
    u.protocol = 'https:';
    upgraded.set(wc.id, { from: url, to: u.href });
    // (Calling wc.stop() inside did-start-navigation crashes Electron; the new load replaces it.)
    setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(u.href).catch(() => {}); });
    return true;
  }
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
      if (upgraded.get(wc.id)?.to === url) upgraded.delete(wc.id);
      applyDefaultZoom(wc);
    });
    wc.once('destroyed', () => upgraded.delete(wc.id));
  }
  function noteUserZoom(wc) {
    try { userZoomed.add(new URL(wc.getURL()).host); } catch {}
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
      case 'adblock': case 'adblockAllow': for (const wc of deps.tabContents()) if (/^https?:/.test(wc.getURL())) wc.reload(); break;
      default: break;
    }
    if (['compactTabs', 'showBookmarkButton', 'reduceMotion', 'focusRings'].includes(key)) deps.ui()?.send('prefs:ui', uiPrefs());
    return undefined;
  }

  async function set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
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
      restartNeeded: RESTART_KEYS.filter((k) => p[k] !== launched[k]),
      platform: process.platform,
      zooms: ZOOMS,
      fontSizes: FONT_SIZES,
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
    if (history) {
      const map = deps.history();
      let removed = 0;
      for (const [url, entry] of map) if ((entry.last || 0) >= since) { map.delete(url); removed++; }
      deps.saveHistory();
      done.history = removed;
    }
    if (cookies) {
      // Electron can't clear cookies or site storage by time: these go for all time.
      await ses().clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] });
      done.cookies = true;
    }
    if (cache) {
      await ses().clearCache();
      done.cache = true;
    }
    if (downloads) done.downloads = clearDownloads();
    return done;
  }
  function clearDownloads() {
    const list = deps.downloads;
    const before = list.length;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].state !== 'progressing') list.splice(i, 1);
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
    for (const key of [...Object.keys(DEFAULTS), 'searchEngine', 'sitePermissions']) delete s[key];
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
      if (process.env.CLAUDE_BROWSER_TEST) return false; // tests check the saved value instead
      app.relaunch();
      app.quit();
      return true;
    });
    handle('prefs:about', about);
    handle('prefs:task-manager', taskManager);
    handle('prefs:restart-tab', restartTabProcess);
    handle('prefs:internals', internals);
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
    prefs, set, state, start, attachTab, guardSettingsTab, tabWebPreferences, spellingItems, onFailLoad,
    noteUserZoom, noteResponseHeaders, downloadDir, askWhereToSave, startupPlan, loadPermissions, savePermissions, permissionDefault,
    clearData, uiPrefs, launched,
  };
}

module.exports = { create, SETTINGS_URL, HTTPS_ONLY_URL, SECTIONS, isSettingsUrl, urlFor, displayUrl, parseSettingsInput, acceptLanguage, DEFAULTS };
