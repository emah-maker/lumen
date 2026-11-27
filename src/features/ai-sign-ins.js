// [sign-ins] Settings → AI's sign-ins and local AI, moved out of main.js as they were: Local (Ollama / LM Studio: the address,
// Detect, auto-detect, LM Studio's loader), provider keys, "Sign in with OpenRouter" (OAuth PKCE), the Spotify widget's sign-in
// (OAuth PKCE) and the Anthropic CLI sign-in. create() registers the same IPC channels main.js did, at the same point of start-up.
//
// deps: { ipcMain, net, app, TEST, t, readSettings(), writeSettings(s), refreshModels(provider), modelsChanged(), providers, secretBox,
//   ENV_KEYS, OPENROUTER_CACHE() -> path, tabs() -> the open tabs, openTab(url) -> { id }, closeTab(id), onTabGone(id, fn) -> unwatch,
//   widgets, spotifyRedirectPort(), cliAuth, anthropicKeyOn(), storedApiKey(), clearClient() (the Claude client is built again),
//   clearCliLoginValid() (the CLI sign-in is checked again) }
// Returns { spotifySignIn(clientId), cliStatus(), saveProviderKey(provider, key) }.
const path = require('path');

const CHANNELS = ['settings:local-get', 'settings:local-save', 'settings:local-detect', 'settings:local-auto', 'settings:local-lms-status', 'settings:local-lms-load',
  'settings:local-lms-unload', 'settings:local-lms-bench', 'settings:set-provider-key', 'openrouter:models', 'openrouter:cancel', 'openrouter:sign-in',
  'spotify:cancel', 'spotify:disconnect', 'spotify:sign-in', 'cli:status', 'cli:login', 'cli:cancel', 'cli:logout'];

function create(deps) {
  const { ipcMain, net, app, TEST, t, readSettings, writeSettings, refreshModels, modelsChanged, providers, secretBox, ENV_KEYS, OPENROUTER_CACHE,
    tabs, openTab, closeTab, onTabGone, widgets, spotifyRedirectPort, cliAuth, anthropicKeyOn, storedApiKey, clearClient, clearCliLoginValid } = deps;
  // ---- [local AI] Settings → AI → Local. The address, the toggle and Detect. Only this computer's addresses unless the user confirms one.
  const localState = () => {
    const lm = require('../ai/local-models');
    const c = lm.clean(readSettings().localAI);
    return { enabled: c.enabled, flavor: c.flavor, url: c.url, confirmedHost: c.confirmedHost, models: c.models, defaults: lm.DEFAULT_URLS, names: lm.LABELS };
  };
  // What the user entered -> { ok, cfg } (the address checked) or { ok: false, error, needsConfirm?, host? }.
  function localCheck(input) {
    const lm = require('../ai/local-models');
    const cur = lm.clean(readSettings().localAI);
    const flavor = lm.FLAVORS.includes(input?.flavor) ? input.flavor : cur.flavor;
    const n = lm.normalizeUrl(flavor, input?.url);
    if (!n.ok) return { ok: false, error: n.error };
    let confirmedHost = '';
    if (!n.local) {
      if (cur.confirmedHost !== n.host && input?.confirmRemote !== true) return { ok: false, needsConfirm: true, host: n.host, error: n.host + ' isn’t on this computer. Messages and the page text you share would be sent there. Use it only if you run that server yourself.' };
      confirmedHost = n.host;
    }
    const same = cur.flavor === flavor && cur.url === n.url;
    return { ok: true, cfg: { ...cur, flavor, url: n.url, confirmedHost, models: same ? cur.models : [] } };
  }
  ipcMain.handle('settings:local-get', () => localState());
  ipcMain.handle('settings:local-save', async (_e, input) => {
    const r = localCheck(input);
    if (!r.ok) return r;
    writeSettings({ ...readSettings(), localAI: { ...r.cfg, enabled: input?.enabled === true } });
    await refreshModels('local');
    return { ok: true, ...localState() };
  });
  ipcMain.handle('settings:local-detect', async (_e, input) => {
    const r = localCheck(input);
    if (!r.ok) return r;
    const found = await require('../ai/local-models').detect(r.cfg, { fetchImpl: require('../browser/net-fetch').netFetch() });
    if (!found.ok) return found;
    writeSettings({ ...readSettings(), localAI: { ...r.cfg, enabled: input?.enabled === true, models: found.models } });
    await refreshModels('local');
    return { ...found, ...localState() };
  });
  // Auto-detect: when Local has no models yet, look for LM Studio or Ollama at their usual addresses and fill in the one that
  // answers. The switch is left as it was: finding a server doesn't put its models in every picker.
  ipcMain.handle('settings:local-auto', async () => {
    const lm = require('../ai/local-models');
    const cur = lm.clean(readSettings().localAI);
    if (cur.models.length) return { ok: true, skipped: true, ...localState() };
    if (TEST && !process.env.LUMEN_TEST_LOCAL_AUTODETECT) return { ok: false, skipped: true }; // a test run never finds the tester's own LM Studio
    const found = await lm.autoDetect({ prefer: cur.flavor === 'ollama' && cur.url !== lm.DEFAULT_URLS.ollama ? 'ollama' : 'lmstudio', fetchImpl: require('../browser/net-fetch').netFetch() });
    if (!found.ok) return found;
    writeSettings({ ...readSettings(), localAI: { ...cur, flavor: found.flavor, url: found.url, confirmedHost: '', models: found.models } });
    await refreshModels('local');
    return { ...found, ...localState() };
  });
  // LM Studio's model loader and stats, against the saved address (never one the page passes in).
  ipcMain.handle('settings:local-lms-status', async () => {
    const lm = require('../ai/local-models');
    return lm.lmStudioStatus(readSettings().localAI, { fetchImpl: require('../browser/net-fetch').netFetch() });
  });
  ipcMain.handle('settings:local-lms-load', async (_e, model) => {
    const lm = require('../ai/local-models');
    return lm.lmStudioLoad(readSettings().localAI, model, { fetchImpl: require('../browser/net-fetch').netFetch() });
  });
  ipcMain.handle('settings:local-lms-unload', async (_e, id) => {
    const lm = require('../ai/local-models');
    return lm.lmStudioUnload(readSettings().localAI, id, { fetchImpl: require('../browser/net-fetch').netFetch() });
  });
  ipcMain.handle('settings:local-lms-bench', async (_e, model) => {
    const lm = require('../ai/local-models');
    return lm.lmStudioBenchmark(readSettings().localAI, model, { fetchImpl: require('../browser/net-fetch').netFetch() });
  });
  ipcMain.handle('settings:set-provider-key', async (_e, provider, key) => {
    if (!providers.PROVIDERS[provider]) return false;
    let unverified = false;
    if (key) {
      const check = await providers.checkKey(provider, String(key).trim());
      if (check.ok === false) throw new Error(check.message);
      unverified = check.ok === null;
    }
    saveProviderKey(provider, key);
    await refreshModels(provider);
    return unverified ? { ok: true, unverified: true } : true;
  });
  // ---- OpenRouter: the full model list for "More models…", and "Sign in with OpenRouter" (OAuth PKCE:
  // openrouter.ai asks the user, then redirects to a one-time loopback address with a code that is
  // exchanged for a key; the key is stored encrypted like a pasted one).
  ipcMain.handle('openrouter:models', async () => {
    const { models } = await providers.openRouterCatalog({ cacheFile: OPENROUTER_CACHE(), onRefresh: () => refreshModels('openrouter') });
    return models.map(({ id, name, tools, context, pricePerM, free }) => ({ id, name, tools, context, pricePerM, free }));
  });
  function saveProviderKey(provider, key) {
    const settings = readSettings();
    const keys = { ...(settings.keys || {}) };
    if (key) {
      if (!secretBox.available()) throw new Error(`OS encryption is unavailable; set ${ENV_KEYS[provider]} instead.`);
      keys[provider] = secretBox.encrypt(String(key).trim());
    } else {
      delete keys[provider];
    }
    writeSettings({ ...settings, keys });
  }
  // Ends a sign-in that is waiting, from the Cancel button (or a second click).
  let cancelOpenRouterSignIn = null;
  ipcMain.handle('openrouter:cancel', () => { cancelOpenRouterSignIn?.(); return true; });
  ipcMain.handle('openrouter:sign-in', () => new Promise((resolve) => {
    cancelOpenRouterSignIn?.(); // one sign-in at a time
    const crypto = require('crypto');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let authTab = null;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unwatch();
      cancelOpenRouterSignIn = null;
      server.close();
      if (authTab && tabs().some((t) => t.id === authTab)) setTimeout(() => { if (tabs().some((t) => t.id === authTab)) closeTab(authTab); }, 1200);
      resolve(result);
    };
    cancelOpenRouterSignIn = () => finish({ ok: false, cancelled: true, message: t('openrouter.cancelled') });
    // Closing the sign-in tab (or it failing to load, offline, and the user closing it) cancels at
    // once (onTabGone), instead of leaving the button disabled until the 5-minute timeout.
    let unwatch = () => {}; // set once the tab exists
    const server = require('http').createServer(async (req, res) => {
      const code = new URL(req.url, 'http://127.0.0.1').searchParams.get('code');
      if (!code) { res.writeHead(404).end(); return; }
      try {
        const r = await net.fetch(`${providers.PROVIDERS.openrouter.baseURL}/auth/keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...providers.PROVIDERS.openrouter.headers },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body.key) throw new Error(body?.error?.message || `HTTP ${r.status}`);
        saveProviderKey('openrouter', body.key);
        await refreshModels('openrouter');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>Signed in</title><body style="font:15px system-ui;padding:40px">Signed in to OpenRouter. You can close this tab.</body>');
        finish({ ok: true });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>Sign-in failed</title><body style="font:15px system-ui;padding:40px">OpenRouter sign-in failed. Close this tab and try again.</body>');
        finish({ ok: false, message: t('openrouter.failed', { error: err.message }) });
      }
    });
    const timer = setTimeout(() => finish({ ok: false, message: t('openrouter.timeout') }), 5 * 60 * 1000);
    server.on('error', (err) => finish({ ok: false, message: t('openrouter.cantStart', { error: err.message }) }));
    server.listen(0, '127.0.0.1', () => {
      const callback = `http://127.0.0.1:${server.address().port}/callback`;
      const url = `https://openrouter.ai/auth?${new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', key_label: 'Lumen' })}`;
      authTab = openTab(url).id;
      if (!done) unwatch = onTabGone(authTab, () => cancelOpenRouterSignIn?.());
    });
  }));

  // ---- Spotify widget sign-in (OAuth Authorization Code + PKCE, no client secret): the user's own Client
  // ID, Spotify asks in an ordinary tab, then redirects to the registered loopback address with a code.
  // features/widgets.js trades the code for tokens and stores the refresh token encrypted (widgetSecret).
  let cancelSpotifySignIn = null;
  ipcMain.handle('spotify:cancel', () => { cancelSpotifySignIn?.(); return true; });
  ipcMain.handle('spotify:disconnect', () => widgets.spotifyDisconnect());
  // One sign-in at a time; resolves { ok, message, cancelled?, allowlist? }. Used by Settings (spotify:sign-in) and by the Spotify card's Reconnect / Connect buttons (do=reconnect).
  const spotifySignIn = (clientId) => new Promise((resolve) => {
    cancelSpotifySignIn?.();
    let session;
    try { session = widgets.spotifyStart(clientId); } catch (err) { resolve({ ok: false, message: err.message }); return; }
    let authTab = null;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unwatch();
      cancelSpotifySignIn = null;
      server.close();
      if (authTab && tabs().some((x) => x.id === authTab)) setTimeout(() => { if (tabs().some((x) => x.id === authTab)) closeTab(authTab); }, 1200);
      resolve(result);
    };
    cancelSpotifySignIn = () => finish({ ok: false, cancelled: true, message: t('spotify.cancelled') });
    // Closing the sign-in tab cancels at once, instead of waiting for the 5-minute timeout.
    let unwatch = () => {}; // set once the tab exists
    const page = (title, text) => `<title>${title}</title><body style="font:15px system-ui;padding:40px">${text}</body>`;
    const server = require('http').createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== session.state) { res.writeHead(400).end(); return; } // not our sign-in: ignore, keep waiting
      if (url.searchParams.get('error')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Not connected', 'Spotify was not connected. You can close this tab.'));
        finish({ ok: false, cancelled: true, message: t('spotify.cancelled') });
        return;
      }
      try {
        await session.exchange(url.searchParams.get('code'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Connected', 'Spotify is connected to Lumen. You can close this tab.'));
        finish({ ok: true, message: t('spotify.connected') });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Sign-in failed', 'Spotify sign-in failed. Close this tab and try again.'));
        finish({ ok: false, allowlist: err.allowlist === true, message: err.allowlist === true ? err.message : t('spotify.failed', { error: err.message }) });
      }
    });
    // (Lumen's own Spotify app, in Spotify's development mode, only lets 25 listed accounts in: for anyone else Spotify's own page says so and never comes back here)
    const timer = setTimeout(() => finish(session.builtin ? { ok: false, allowlist: true, message: t('spotify.timeoutBuiltin') } : { ok: false, message: t('spotify.timeout') }), 5 * 60 * 1000);
    server.on('error', (err) => finish({ ok: false, message: t(err.code === 'EADDRINUSE' ? 'spotify.portBusy' : 'spotify.cantStart', { error: err.message, port: spotifyRedirectPort() }) }));
    server.listen(spotifyRedirectPort(), '127.0.0.1', () => { authTab = openTab(session.url).id; if (!done) unwatch = onTabGone(authTab, () => cancelSpotifySignIn?.()); });
  });
  ipcMain.handle('spotify:sign-in', (_event, clientId) => spotifySignIn(clientId));

  // ---- sign in with the Anthropic CLI (an OAuth profile instead of an API key)
  const CLI_BIN = () => path.join(app.getPath('userData'), 'bin');

  async function cliStatus() {
    const ant = await cliAuth.findAnt(CLI_BIN());
    const { profile, signedIn: hasFile } = cliAuth.profileState();
    // A credentials file can outlive its tokens: confirm with the CLI when it's available.
    const signedIn = hasFile && (ant ? await cliAuth.verifyLogin(ant) : true);
    return {
      installed: Boolean(ant),
      path: ant || null,
      signedIn,
      profile,
      // A saved or exported API key takes precedence over the CLI profile.
      shadowedBy: !anthropicKeyOn() ? null : storedApiKey() ? 'saved key' : 'ANTHROPIC_API_KEY',
    };
  }

  ipcMain.handle('cli:status', cliStatus);
  ipcMain.handle('cli:login', async (event) => {
    const progress = (text) => { if (!event.sender.isDestroyed()) event.sender.send('cli:progress', text); };
    try {
      let ant = await cliAuth.findAnt(CLI_BIN());
      if (!ant) {
        progress('Installing the Anthropic CLI…');
        ant = await cliAuth.installAnt(CLI_BIN());
      }
      progress('Finish signing in in your web browser…');
      const result = await cliAuth.login(ant);
      clearClient(); // the next request picks up the new profile
      if (result.ok) { clearCliLoginValid(); modelsChanged(); }
      return { ...(await cliStatus()), ok: result.ok, cancelled: Boolean(result.cancelled), message: result.ok ? '' : result.message || 'Sign-in did not complete.' };
    } catch (err) {
      return { ...(await cliStatus()), ok: false, message: err.message };
    }
  });
  ipcMain.handle('cli:cancel', () => cliAuth.cancelLogin());
  ipcMain.handle('cli:logout', async () => {
    const ant = await cliAuth.findAnt(CLI_BIN());
    if (ant) await cliAuth.logout(ant);
    clearClient();
    return cliStatus();
  });

  return { spotifySignIn, cliStatus, saveProviderKey };
}

module.exports = { create, CHANNELS };
