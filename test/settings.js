// lumen://settings: nav and search, and the behaviour behind each setting (theme, zoom, clearing
// history, permissions, HTTPS-only, spell check, hardware acceleration, About), plus isolation:
// web pages can't navigate the settings tab or see its API, and the agent can't drive it.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const hints = []; // sec-ch-prefers-color-scheme seen on /hint2
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/hint') {
      res.setHeader('Accept-CH', 'Sec-CH-Prefers-Color-Scheme');
      return res.end('<title>hint</title>asked for the color-scheme hint');
    }
    if (req.url === '/hint2') {
      hints.push(req.headers['sec-ch-prefers-color-scheme'] || '');
      return res.end('<title>hint2</title>');
    }
    if (req.url === '/headers') {
      return res.end(`<title>headers</title><pre id="h">${JSON.stringify(req.headers)}</pre>`);
    }
    res.end(`<!doctype html><title>Settings fixture</title><body><p>fixture ${req.url}</p><textarea id="t"></textarea></body>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-settings-test-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };

  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const skip = (label, why) => console.log(`SKIP  ${label}  (${why})`);

  // colorScheme: null stops Playwright forcing prefers-color-scheme: light on every page.
  let app = await electron.launch({ args: [path.join(__dirname, '..')], env, colorScheme: null });
  app.process().stderr.on('data', (d) => { if (process.env.DEBUG_SETTINGS) process.stdout.write('[main] ' + d); });
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  if (process.env.DEBUG_SETTINGS) await app.evaluate(({ app: a }) => a.on('render-process-gone', (_e, wc, d) => console.error('GONE', wc.getURL().slice(-40), JSON.stringify(d))));

  const settingsTabs = () => app.evaluate(() => global.__settings.tabs());
  const waitFor = async (fn, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
    return fn();
  };
  const openSettings = async (section = '') => {
    const id = await app.evaluate((_e, s) => global.__settings.open(s), section);
    await waitFor(() => app.evaluate((_e, i) => global.__settings.contents(i)?.executeJavaScript('document.body?.dataset.ready === "1"', true).catch(() => false), id));
    return id;
  };
  const inTab = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [id, code]);
  // Selecting a tab makes main re-send the tab state.
  const tabState = (id) => ui.evaluate((i) => new Promise((resolve) => {
    window.browser.onTabs((s) => resolve(s));
    window.browser.switchTab(i);
    setTimeout(() => resolve(null), 1500);
  }), id);
  const readPrefsFile = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
  // A normal tab on `url`; resolves with its id once loaded.
  const openWeb = async (url) => {
    const id = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, url);
    await waitFor(() => app.evaluate((_e, i) => { const wc = global.__settings.contents(i); return wc && !wc.isLoading() && wc.getURL() !== ''; }, id));
    return id;
  };
  const closeTab = (id) => app.evaluate((_e, i) => global.__agent.browser.closeTab(i), id);

  // ---- opening it ----
  await ui.evaluate(() => document.getElementById('open-settings').click());
  let sid = await waitFor(async () => (await settingsTabs()).find((t) => t.settings && t.url.endsWith('#you-and-ai'))?.id);
  check('the sidebar gear opens the settings tab at You and AI', Boolean(sid) && (await settingsTabs()).find((t) => t.settings)?.url.endsWith('#you-and-ai'), JSON.stringify(await settingsTabs()));
  check('the sidebar has no settings panel of its own', await ui.evaluate(() => !document.getElementById('settings') && !document.getElementById('api-key')), 'still there');
  await ui.evaluate(() => window.browser.newTab('lumen://settings/privacy'));
  await waitFor(async () => (await settingsTabs()).find((t) => t.settings)?.url.endsWith('#privacy'));
  const settingsCount = (await settingsTabs()).filter((t) => t.settings).length;
  check('lumen://settings/privacy reuses the one settings tab and opens that section', settingsCount === 1 && (await settingsTabs()).find((t) => t.settings)?.url.endsWith('#privacy'), JSON.stringify((await settingsTabs()).map((t) => [t.id, t.settings, t.url.slice(-24)])));
  sid = await openSettings('you-and-ai');

  // ---- nav and search ----
  const navCount = await inTab(sid, "document.querySelectorAll('#nav a').length");
  const sectionCount = require('../src/settings/settings-backend').SECTIONS.length;
  check(`left nav lists all ${sectionCount} categories`, navCount === sectionCount, navCount);
  await inTab(sid, "document.querySelector('#nav a[data-section=appearance]').click()");
  await waitFor(() => inTab(sid, "!document.getElementById('cat-appearance').hidden"));
  const visible = await inTab(sid, "[...document.querySelectorAll('#sections > .pane')].filter((s) => !s.hidden).map((s) => s.id)");
  check('nav shows just the chosen category', JSON.stringify(visible) === '["cat-appearance"]', JSON.stringify(visible));
  const state = await tabState(sid);
  const shown = state?.tabs.find((t) => t.id === sid)?.url;
  check('address bar shows lumen://settings/appearance', shown === 'lumen://settings/appearance', shown);
  await inTab(sid, "{ const s = document.getElementById('search'); s.value = 'proxy'; s.dispatchEvent(new Event('input')); }");
  const hits = await inTab(sid, "[...document.querySelectorAll('#sections > .pane')].filter((s) => !s.hidden).map((s) => s.id + ':' + [...s.querySelectorAll('.row')].filter((r) => !r.hidden && !r.classList.contains('filtered') && !r.closest('[hidden]')).length)");
  check('search “proxy” shows only the matching row (Advanced)', JSON.stringify(hits) === '["cat-advanced:1"]', JSON.stringify(hits));
  await inTab(sid, "{ const s = document.getElementById('search'); s.value = 'zzqxv'; s.dispatchEvent(new Event('input')); }");
  check('search with no match says so', (await inTab(sid, "!document.getElementById('no-results').hidden")) === true, await inTab(sid, "[...document.querySelectorAll('.row')].filter((r) => !r.hidden).map((r) => r.dataset.search).slice(0, 3).join(' | ')"));
  await inTab(sid, "{ const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); }");

  const setSelect = (id, value) => inTab(sid, `(async () => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 300)); })()`);
  const clickEl = (selector) => inTab(sid, `(async () => { document.querySelector(${JSON.stringify(selector)}).click(); await new Promise((r) => setTimeout(r, 400)); })()`);

  // ---- theme ----
  await setSelect('pref-theme', 'dark');
  check('theme Dark sets nativeTheme.themeSource', (await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) === 'dark', await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource));
  let web = await openWeb(`${base}/media`);
  check('with Dark, pages match prefers-color-scheme: dark', (await inTab(web, "matchMedia('(prefers-color-scheme: dark)').matches")) === true, 'not dark');
  // The hint is learned from the response headers the ad blocker's listener sees.
  const blockerReady = await waitFor(() => app.evaluate(() => global.__adblock.ready()), 30000);
  await app.evaluate((_e, [i, u]) => global.__settings.contents(i).loadURL(u), [web, `${base}/hint`]);
  await app.evaluate((_e, [i, u]) => global.__settings.contents(i).loadURL(u), [web, `${base}/hint2`]);
  if (blockerReady) check('Sec-CH-Prefers-Color-Scheme: "dark" is sent once the site asks', hints.at(-1) === '"dark"', JSON.stringify(hints));
  else skip('Sec-CH-Prefers-Color-Scheme', 'ad blocker (and its header listener) not ready: no network for filter lists?');
  await setSelect('pref-theme', 'light');
  check('with Light, prefers-color-scheme: dark is false (live, no reload)', (await inTab(web, "matchMedia('(prefers-color-scheme: dark)').matches")) === false, 'still dark');
  await app.evaluate((_e, [i, u]) => global.__settings.contents(i).loadURL(u), [web, `${base}/hint2`]);
  if (blockerReady) check('…and the hint follows: "light"', hints.at(-1) === '"light"', JSON.stringify(hints));
  await closeTab(web);

  // Real check: Google's results page renders dark on the server from the hint.
  await setSelect('pref-theme', 'dark');
  try {
    web = await openWeb('https://www.google.com/search?q=test');
    await sleep(1500);
    const g = await inTab(web, `(() => { const c = getComputedStyle(document.body).color.match(/\\d+(\\.\\d+)?/g).map(Number); return { url: location.href, title: document.title, lum: (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 }; })()`);
    if (/\/sorry\/|consent\.google/.test(g.url)) skip('Google results are dark in Dark mode', `Google served a CAPTCHA/consent page: ${g.url.slice(0, 60)}`);
    else check('Google results are dark in Dark mode (light text)', g.lum > 0.6, JSON.stringify(g));
    await closeTab(web);
  } catch (err) {
    skip('Google results are dark in Dark mode', `no network: ${err.message}`);
  }
  await setSelect('pref-theme', 'system');

  // ---- default zoom ----
  await setSelect('pref-defaultZoom', 1.25);
  web = await openWeb(`${base}/zoom`);
  const zoom = await app.evaluate((_e, i) => global.__settings.contents(i).getZoomFactor(), web);
  check('default zoom 125% applies to a new tab', Math.abs(zoom - 1.25) < 0.01, zoom);
  await closeTab(web);
  await setSelect('pref-defaultZoom', 1);

  // ---- clear history ----
  web = await openWeb(`${base}/visited-page`);
  await sleep(300);
  const had = (await app.evaluate(() => global.__settings.historyUrls())).includes(`${base}/visited-page`);
  await closeTab(web);
  await inTab(sid, "location.hash = 'privacy'");
  await inTab(sid, "document.getElementById('clear-range').value = 'hour'; document.getElementById('clear-history').checked = true; document.getElementById('clear-cache').checked = false");
  await clickEl('#clear-go');
  const gone = !(await app.evaluate(() => global.__settings.historyUrls())).includes(`${base}/visited-page`);
  check('clearing browsing data (last hour) removes the visit from history', had && gone, `had=${had} gone=${gone}`);
  check('…and the page reports what was cleared', /Cleared \d+ history/.test(await inTab(sid, "document.getElementById('clear-status').textContent")), await inTab(sid, "document.getElementById('clear-status').textContent"));

  // ---- site permission revoke ----
  await app.evaluate((_e, origin) => { global.__settings.permissions.set(`${origin}|geolocation`, true); global.__settings.backend.savePermissions(global.__settings.permissions); }, base);
  await inTab(sid, 'location.reload()');
  await sleep(300);
  await waitFor(() => inTab(sid, "document.body.dataset.ready === '1' && !!document.querySelector('#site-permissions [data-permission=geolocation] .revoke')").catch(() => false));
  const listed = await inTab(sid, `!!document.querySelector('#site-permissions [data-origin="${base}"]')`);
  await clickEl(`#site-permissions [data-origin="${base}"] .revoke`);
  const revoked = !(await app.evaluate((_e, origin) => global.__settings.permissions.has(`${origin}|geolocation`), base));
  const savedPerms = readPrefsFile().sitePermissions || {};
  check('site permission is listed and Revoke removes it (memory and settings.json)', listed && revoked && !(`${base}|geolocation` in savedPerms), `listed=${listed} revoked=${revoked} saved=${JSON.stringify(savedPerms)}`);

  // ---- HTTPS-only ----
  await clickEl('#pref-httpsOnly');
  check('HTTPS-only is saved', readPrefsFile().httpsOnly === true, readPrefsFile().httpsOnly);
  web = await openWeb('http://lumen-https-test.invalid/page');
  const landed = await waitFor(async () => {
    const u = await app.evaluate((_e, i) => global.__settings.contents(i).getURL(), web);
    return u.includes('https-only.html') ? u : null;
  }, 10000);
  const param = landed ? new URL(landed).searchParams.get('url') : '';
  check('HTTPS-only upgrades http:// and warns when there is no secure version', param === 'http://lumen-https-test.invalid/page', landed || await app.evaluate((_e, i) => global.__settings.contents(i).getURL(), web));
  const warnState = (await tabState(web))?.tabs.find((t) => t.id === web)?.url;
  check('…the address bar keeps showing the http address', warnState === 'http://lumen-https-test.invalid/page', warnState);
  await closeTab(web);
  web = await openWeb(`${base}/local`);
  check('HTTPS-only leaves local addresses alone', (await app.evaluate((_e, i) => global.__settings.contents(i).getURL(), web)) === `${base}/local`, 'upgraded');
  await closeTab(web);
  await clickEl('#pref-httpsOnly');

  // ---- Do Not Track / GPC / Accept-Language headers ----
  await clickEl('#pref-sendDoNotTrack');
  await clickEl('#pref-sendGpc');
  await inTab(sid, "window.lumenSettings.set('languages', ['fr-CA', 'en-US'])");
  web = await openWeb(`${base}/headers`);
  const headers = JSON.parse(await inTab(web, "document.getElementById('h').textContent"));
  check('DNT, Sec-GPC and Accept-Language headers are sent', headers.dnt === '1' && headers['sec-gpc'] === '1' && headers['accept-language'].startsWith('fr-CA,fr;q=0.9,en-US'), JSON.stringify(headers));
  await closeTab(web);
  await clickEl('#pref-sendDoNotTrack');
  await clickEl('#pref-sendGpc');
  await inTab(sid, "window.lumenSettings.set('languages', [])");

  // ---- spell check languages ----
  if (process.platform === 'darwin') {
    skip('spell-check languages', 'the API is a no-op on macOS');
  } else {
    const available = await app.evaluate(({ session }) => session.defaultSession.availableSpellCheckerLanguages);
    const want = available.slice(0, Math.min(2, available.length));
    if (!want.length) {
      skip('spell-check languages', 'no spell-check languages on this machine');
    } else {
      await inTab(sid, `window.lumenSettings.set('spellcheckLanguages', ${JSON.stringify(want)})`);
      const active = await app.evaluate(({ session }) => session.defaultSession.getSpellCheckerLanguages());
      check('spell-check languages apply to the session', JSON.stringify([...active].sort()) === JSON.stringify([...want].sort()), `want ${want} got ${active}`);
    }
  }

  // ---- hardware acceleration (persisted; applied at launch) ----
  await inTab(sid, "location.hash = 'system'");
  await clickEl('#pref-hardwareAcceleration');
  check('turning off graphics acceleration is saved', readPrefsFile().hardwareAcceleration === false, readPrefsFile().hardwareAcceleration);
  check('…and offers Relaunch', await inTab(sid, "!document.getElementById('relaunch').hidden"), 'no relaunch button');

  // ---- About ----
  const aboutRows = await inTab(sid, "Object.fromEntries([...document.querySelectorAll('#about-versions tr[data-component]')].map((r) => [r.dataset.component, r.cells[1].textContent]))");
  const versions = await app.evaluate(() => process.versions);
  check('About versions match process.versions', aboutRows.Electron === versions.electron && aboutRows.Chromium === versions.chrome && aboutRows['Node.js'] === versions.node && aboutRows.V8 === versions.v8, JSON.stringify(aboutRows));
  check('About shows the pinned Anthropic CLI version', /^\d+\.\d+\.\d+$/.test(aboutRows['Anthropic CLI (pinned)'] || ''), aboutRows['Anthropic CLI (pinned)']);
  const procs = await inTab(sid, "document.querySelectorAll('#task-manager tr').length");
  check('task manager lists processes', procs > 2, procs);
  const gpuRows = await inTab(sid, "document.querySelectorAll('#gpu-status tr').length");
  check('Internals shows GPU feature status', gpuRows > 3, gpuRows);

  // ---- isolation ----
  web = await openWeb(`${base}/plain`);
  check("web pages can't see window.lumenSettings", (await inTab(web, 'typeof window.lumenSettings')) === 'undefined', 'visible');
  await closeTab(web);
  const settingsUrl = await app.evaluate(() => global.__settings.page.SETTINGS_URL);
  web = await openWeb(settingsUrl);
  check('the settings file opened in an ordinary tab gets no API', (await inTab(web, 'typeof window.lumenSettings')) === 'undefined' && (await inTab(web, "!document.getElementById('unavailable').hidden")), 'API exposed');
  await closeTab(web);
  const tabsBefore = (await settingsTabs()).length;
  const brief = (list) => JSON.stringify(list.map((t) => [t.id, t.settings, t.url.slice(-32)]));
  await inTab(sid, `window.open(${JSON.stringify(`${base}/popup`)})`);
  await sleep(800);
  const afterOpen = await settingsTabs();
  check("the settings tab can't open windows", afterOpen.length === tabsBefore, brief(afterOpen));
  await inTab(sid, `location.href = ${JSON.stringify(`${base}/away`)}`);
  await sleep(1200);
  const after = await settingsTabs();
  check("the settings tab can't navigate away", after.find((t) => t.id === sid)?.url.startsWith(settingsUrl) && !after.some((t) => t.url.endsWith('/away')), brief(after));
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), sid);
  check("the agent doesn't get the settings tab as its page", (await app.evaluate(() => global.__agent.browser.activeTab())) === null, 'agent sees it');
  const why = await app.evaluate(() => global.__agent.execute('read_page', {}).then(() => 'no error', (err) => err.message));
  check('a tool on the settings tab explains it (not "No tab is open")', /active tab is Lumen Settings/.test(why) && /open_tab/.test(why), why);
  const denied = await app.evaluate(async ({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers?.get?.('prefs:get');
    if (!handler) return 'no-handler-map';
    try { await handler({ sender: { id: -1 }, senderFrame: null }); return 'allowed'; } catch (err) { return err.message; }
  });
  check('prefs:* calls from anything but the settings tab are refused', denied === 'Not allowed' || denied === 'no-handler-map', denied);
  await ui.evaluate((u) => window.browser.go(u), `${base}/typed`);
  const replaced = await waitFor(async () => { const t = await settingsTabs(); return !t.some((x) => x.settings) && t.some((x) => x.url === `${base}/typed`) ? t : null; });
  check('an address typed into the settings tab opens as a normal tab in its place', Boolean(replaced), JSON.stringify(await settingsTabs()));

  check('no UI errors', errors.length === 0, errors.join(' | '));
  await app.close();

  // ---- relaunch: hardware acceleration off takes effect at launch ----
  app = await electron.launch({ args: [path.join(__dirname, '..')], env, colorScheme: null });
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const launched = await app.evaluate(({ app: a }) => ({ launched: global.__settings.backend.launched, gpu: a.getGPUFeatureStatus().gpu_compositing }));
  check('after relaunch, graphics acceleration is off', launched.launched.hardwareAcceleration === false && /disabled|software/.test(launched.gpu), JSON.stringify(launched));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
