// In-app updates (features/updates.js) with a stand-in updater, never the network: off in test
// mode unless a test opts in, the About → Updates row, the toolbar prompt, the manual download for
// copies that can't update themselves, and that "Restart to update" saves the session first.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Update fixture</title>fixture'); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const waitFor = async (fn, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
    return fn();
  };

  async function launch(extraEnv) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-updates-test-'));
    const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ...extraEnv };
    if (!extraEnv.LUMEN_UPDATES_TEST) delete env.LUMEN_UPDATES_TEST;
    const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const openSettings = async () => {
      const id = await app.evaluate(() => global.__settings.open('about'));
      await waitFor(() => app.evaluate((_e, i) => global.__settings.contents(i)?.executeJavaScript('document.body?.dataset.ready === "1"', true).catch(() => false), id));
      return id;
    };
    const inTab = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [id, code]);
    return { app, ui, profile, openSettings, inTab };
  }
  const row = (inTab, id) => inTab(id, `(() => ({
    desc: document.getElementById('updates-desc')?.textContent,
    note: document.getElementById('updates-status')?.textContent,
    action: document.getElementById('updates-apply')?.hidden ? null : document.getElementById('updates-apply')?.textContent,
    checkDisabled: document.getElementById('updates-check')?.disabled,
    auto: document.getElementById('pref-autoDownloadUpdates')?.checked,
    autoDisabled: document.getElementById('pref-autoDownloadUpdates')?.disabled,
  }))()`);
  const pill = (ui) => ui.evaluate(() => {
    const p = document.getElementById('update-pill');
    return p && !p.hidden ? `${p.querySelector('.update-text').textContent} | ${document.getElementById('update-action').textContent}` : null;
  });

  // ---- plain test mode: nothing checks, and the page says so
  {
    const { app, ui, openSettings, inTab } = await launch({});
    const st = await app.evaluate(() => global.__updates.state());
    check('test mode: updates are disabled', st.disabled === 'test' && st.status === 'disabled', JSON.stringify(st));
    check('the update calls are behind the privileged IPC gate', await app.evaluate(() => ['settings:updates-state', 'settings:updates-check', 'settings:updates-apply', 'settings:updates-dismiss'].every((c) => global.__ipcGate.gated(c))), 'ungated');
    const id = await openSettings();
    const r = await row(inTab, id);
    check('About → Updates shows the version and that updates are off', /^Lumen \d+\.\d+\.\d+ · Never checked$/.test(r.desc) && /off in test mode/.test(r.note) && r.checkDisabled && !r.action, JSON.stringify(r));
    check('"Download updates automatically" defaults on', r.auto === true, JSON.stringify(r));
    await inTab(id, "document.getElementById('updates-check').click()");
    await sleep(300);
    check('Check for updates does nothing while disabled', (await app.evaluate(() => global.__updates.state().status)) === 'disabled', 'status');
    check('no toolbar prompt', (await pill(ui)) === null, await pill(ui));
    await app.close();
  }

  // ---- opted in, with a stand-in updater
  const { app, ui, profile, openSettings, inTab } = await launch({ LUMEN_UPDATES_TEST: '1' });
  await app.evaluate(({ session }) => {
    const { EventEmitter } = process.mainModule.require('events');
    const fake = new EventEmitter();
    Object.assign(fake, { checks: 0, downloads: 0, installs: [], next: '9.9.9' });
    fake.checkForUpdates = async () => {
      fake.checks++;
      const info = { version: fake.next, files: [{ url: `Lumen-Setup-${fake.next}.exe` }] };
      fake.emit('update-available', info);
      if (fake.autoDownload) setTimeout(() => fake.downloadUpdate(), 50);
      return { updateInfo: info };
    };
    fake.downloadUpdate = async () => {
      fake.downloads++;
      fake.emit('download-progress', { percent: 50 });
      await new Promise((r) => setTimeout(r, 100));
      fake.emit('update-downloaded', { version: fake.next });
    };
    fake.quitAndInstall = (...args) => { fake.installs.push(args); }; // records instead of quitting
    global.__fakeUpdater = fake;
    global.__updates.testHooks.useUpdater(fake);
    global.__manualDownloads = [];
    session.defaultSession.downloadURL = (url) => global.__manualDownloads.push(url); // nothing leaves the machine
  });
  check('opted in: updates are enabled', (await app.evaluate(() => global.__updates.state().disabled)) === null, 'disabled');

  // A zip copy: "available", and the download is the zip, fetched through Lumen's downloads.
  await app.evaluate(() => global.__updates.testHooks.setKind('zip'));
  let id = await openSettings();
  let r = await row(inTab, id);
  check('a zip copy: the automatic-download switch is off-limits', r.autoDisabled === true && !r.checkDisabled, JSON.stringify(r));
  await inTab(id, "document.getElementById('updates-check').click()");
  r = await waitFor(async () => { const x = await row(inTab, id); return /available/.test(x.note) && x; });
  check('Check for updates finds 9.9.9 and offers the zip', /Lumen 9\.9\.9 is available/.test(r.note) && r.action === 'Download Lumen-9.9.9-win-x64.zip' && /Checked just now/.test(r.desc), JSON.stringify(r));
  check('the updater did not download anything itself', (await app.evaluate(() => global.__fakeUpdater.downloads)) === 0 && (await app.evaluate(() => global.__fakeUpdater.autoDownload)) === false, 'downloaded');
  check('the toolbar offers the download', (await waitFor(() => pill(ui))) === 'Lumen 9.9.9 is available | Download', await pill(ui));
  await ui.click('#update-action');
  const urls = await waitFor(() => app.evaluate(() => global.__manualDownloads.length && global.__manualDownloads));
  check('Download fetches the release zip', JSON.stringify(urls) === '["https://github.com/emah-maker/lumen/releases/download/v9.9.9/Lumen-9.9.9-win-x64.zip"]', JSON.stringify(urls));
  check('the prompt goes away once the download started', (await waitFor(async () => (await pill(ui)) === null)) === true, await pill(ui));
  const checkedAt = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).updatesCheckedAt;
  check('the last check is remembered', typeof checkedAt === 'number' && Date.now() - checkedAt < 60e3, checkedAt);

  // Installed with the setup, automatic downloads off: the prompt downloads, then offers a restart.
  await app.evaluate(() => { global.__updates.testHooks.reset(); global.__updates.testHooks.setKind('nsis'); });
  await inTab(id, 'location.reload()');
  await waitFor(() => inTab(id, 'document.body?.dataset.ready === "1"'));
  r = await row(inTab, id);
  check('an installed copy: the switch is available', r.autoDisabled === false && r.auto === true, JSON.stringify(r));
  await inTab(id, "document.getElementById('pref-autoDownloadUpdates').click()");
  await waitFor(() => app.evaluate(() => global.__settings.backend.prefs().autoDownloadUpdates === false));
  await inTab(id, "document.getElementById('updates-check').click()");
  r = await waitFor(async () => { const x = await row(inTab, id); return x.action === 'Download' && x; });
  check('automatic downloads off: 9.9.9 waits for "Download"', r.action === 'Download' && (await app.evaluate(() => global.__fakeUpdater.downloads)) === 0, JSON.stringify(r));
  check('the toolbar says it is available', (await waitFor(() => pill(ui))) === 'Lumen 9.9.9 is available | Download', await pill(ui));
  await ui.click('#update-action');
  check('Download fetches the installer in the background', (await waitFor(async () => (await pill(ui)) === 'Lumen 9.9.9 is ready | Restart to update')) === true && (await app.evaluate(() => global.__fakeUpdater.downloads)) === 1, await pill(ui));
  check('no manual download for an installed copy', (await app.evaluate(() => global.__manualDownloads.length)) === 1, 'manual');
  await ui.click('#update-dismiss');
  check('closing the prompt hides it', (await waitFor(async () => (await pill(ui)) === null)) === true, await pill(ui));
  r = await waitFor(async () => { const x = await row(inTab, id); return x.action === 'Restart to update' && x; }); // the page refreshes every second
  check('Settings follows a download started from the toolbar and offers the restart', r.action === 'Restart to update' && /is ready/.test(r.note), JSON.stringify(r));

  // Automatic downloads on: found, downloaded, "Restart to update"; the restart saves the session.
  await app.evaluate(() => { global.__updates.testHooks.reset(); global.__fakeUpdater.next = '10.0.0'; });
  await inTab(id, "document.getElementById('pref-autoDownloadUpdates').click()");
  await waitFor(() => app.evaluate(() => global.__settings.backend.prefs().autoDownloadUpdates === true));
  await app.evaluate(() => global.__updates.check());
  check('automatic downloads on: the prompt appears once the update is ready', (await waitFor(async () => (await pill(ui)) === 'Lumen 10.0.0 is ready | Restart to update')) === true, await pill(ui));
  await app.evaluate((_e, url) => global.__agent.browser.openTab(url), `${base}/keep-me`);
  await waitFor(() => app.evaluate(() => global.__tabsArray().length >= 3));
  await sleep(500);
  await app.evaluate(() => global.__patchSettings({ session: null })); // so only the restart can write it
  await ui.click('#update-action');
  const installs = await waitFor(() => app.evaluate(() => global.__fakeUpdater.installs.length && global.__fakeUpdater.installs));
  check('Restart to update installs silently and starts the new version', JSON.stringify(installs) === '[[true,true]]', JSON.stringify(installs));
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).session;
  check('the session is saved before the installer runs', Array.isArray(saved?.urls) && saved.urls.some((u) => u.endsWith('/keep-me')), JSON.stringify(saved));

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
