// Hardening: Lumen's own UI window can't be navigated or made to open windows, its IPC answers only
// its own top-level document, and the AI's hidden reader views get no permissions or downloads.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hardening-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const uiUrl = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
  const tabCount = () => app.evaluate(() => global.__settings.tabs().length);
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

  // ---- every channel preload.js sends is gated
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:send|invoke|sendSync)\('([^']+)'/g)].map((m) => m[1]);
  const ungated = await app.evaluate((_e, list) => list.filter((c) => !global.__ipcGate.gated(c)), channels);
  check(`every preload.js channel (${channels.length}) is gated to the UI`, channels.length > 30 && ungated.length === 0, ungated.join(', '));

  // ---- the UI can't be navigated away from index.html
  await ui.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
  await sleep(1500);
  check('UI: a renderer-side navigation is refused', /renderer\/index\.html$/.test(await uiUrl()), await uiUrl());
  await ui.evaluate(() => { const a = document.createElement('a'); a.href = 'https://example.com/'; document.body.append(a); a.click(); a.remove(); }).catch(() => {});
  await sleep(1000);
  check('UI: a link click inside the UI is refused', /renderer\/index\.html$/.test(await uiUrl()), await uiUrl());

  // ---- window.open from the UI never makes a window; a web URL becomes an ordinary tab
  const tabsBefore = await tabCount();
  const winsBefore = await windowCount();
  const opened = await ui.evaluate(() => window.open('https://example.com/') === null);
  check('UI: window.open returns null (denied)', opened, opened);
  const tabsAfter = await waitFor(async () => ((await tabCount()) > tabsBefore ? tabCount() : 0));
  check('UI: window.open of a web URL opens a tab instead', tabsAfter === tabsBefore + 1, `${tabsBefore} -> ${tabsAfter}`);
  check('UI: no new window', (await windowCount()) === winsBefore, await windowCount());
  const tabsNow = await tabCount();
  await ui.evaluate(() => window.open('file:///C:/Windows/win.ini'));
  await sleep(800);
  check('UI: window.open of a file: URL is dropped', (await tabCount()) === tabsNow && (await windowCount()) === winsBefore, `${await tabCount()} tabs`);

  // ---- the suggestions dropdown can't be navigated or open windows
  const suggest = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /renderer\/suggest\.html$/.test(w.getURL()));
    if (!wc) return 'no suggest view';
    await wc.executeJavaScript("window.open('https://example.com/'); location.href = 'https://example.com/'; 1");
    await new Promise((r) => setTimeout(r, 1500));
    return wc.getURL();
  });
  check('suggest view stays on suggest.html', /renderer\/suggest\.html$/.test(suggest), suggest);

  // ---- the dialogs overlay likewise
  const overlay = await app.evaluate(async ({ webContents }) => {
    const pending = global.__dialogs.showMessageBox(null, { message: 'hardening', buttons: ['OK'] });
    let wc;
    for (let i = 0; i < 40 && !wc; i++) { await new Promise((r) => setTimeout(r, 100)); wc = webContents.getAllWebContents().find((w) => /renderer\/dialog\.html$/.test(w.getURL())); }
    if (!wc) return 'no overlay';
    await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
    await wc.executeJavaScript("location.href = 'https://example.com/'; 1");
    await new Promise((r) => setTimeout(r, 1500));
    const url = wc.getURL();
    global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 0 });
    await pending;
    return url;
  });
  check('dialog overlay stays on dialog.html', /renderer\/dialog\.html$/.test(overlay), overlay);

  // ---- backstop: any other webContents with the UI preload can't leave index.html either
  const backstop = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: false } });
    await w.loadURL('about:blank#probe').catch(() => {});
    // about:blank is where it started; a renderer-side navigation to the web must be refused.
    await w.webContents.executeJavaScript("location.href = 'https://example.com/'; 1");
    await new Promise((r) => setTimeout(r, 1500));
    const url = w.webContents.getURL();
    w.destroy();
    return { url };
  }, path.join(__dirname, '..', 'preload.js'));
  check('backstop: a view with preload.js can\'t navigate to the web', !/example\.com/.test(backstop.url), backstop.url);

  // ---- privileged / UI-only IPC from a tab (or a subframe) is refused
  const ipc = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const tab = global.__agent.browser.openTab('about:blank');
    await new Promise((r) => setTimeout(r, 500));
    const twc = tab.webContents;
    const uiWc = BrowserWindow.getAllWindows()[0].webContents;
    const invoke = async (channel, event, ...args) => {
      try { await ipcMain._invokeHandlers.get(channel)(event, ...args); return 'allowed'; } catch (err) { return err.message; }
    };
    const before = global.__settings.tabs().length;
    ipcMain.emit('tab:new', { sender: twc, senderFrame: twc.mainFrame }, 'https://example.com/');
    ipcMain.emit('tab:new', { sender: uiWc, senderFrame: { url: 'https://evil.example/' } }, 'https://example.com/');
    await new Promise((r) => setTimeout(r, 500));
    return {
      autoAllow: await invoke('agent:auto-allow', { sender: twc, senderFrame: twc.mainFrame }, true),
      setKey: await invoke('settings:set-key', { sender: twc, senderFrame: twc.mainFrame }, 'sk-x'),
      subframe: await invoke('agent:auto-allow', { sender: uiWc, senderFrame: { url: 'https://evil.example/' } }, true),
      uiAllowed: await invoke('agent:auto-allow', { sender: uiWc, senderFrame: uiWc.mainFrame }),
      tabsOpened: global.__settings.tabs().length - before,
    };
  });
  check('tab: agent:auto-allow refused', ipc.autoAllow === 'Not allowed', ipc.autoAllow);
  check('tab: settings:set-key refused', ipc.setKey === 'Not allowed', ipc.setKey);
  check('UI webContents but not its main frame: refused', ipc.subframe === 'Not allowed', ipc.subframe);
  check('tab / foreign frame: tab:new ignored', ipc.tabsOpened === 0, ipc.tabsOpened);
  check('the UI document itself is still allowed', ipc.uiAllowed === 'allowed', ipc.uiAllowed);
  const realUi = await ui.evaluate(async () => typeof (await window.assistant.autoAllow()));
  check('real UI call still works (assistant.autoAllow)', realUi === 'boolean', realUi);
  const tabsBeforeNew = await tabCount();
  await ui.evaluate(() => window.browser.newTab('about:blank'));
  check('real UI call still works (browser.newTab)', (await waitFor(async () => ((await tabCount()) > tabsBeforeNew ? 1 : 0))) === 1, await tabCount());

  // ---- the AI's reader partition: no permissions, no downloads
  const reader = await app.evaluate(async ({ WebContentsView, session }, fixture) => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, partition: 'claude-reader' } });
    const wc = view.webContents;
    await wc.loadURL(fixture).catch(() => {});
    const notification = await wc.executeJavaScript('Notification.requestPermission()').catch((e) => `error ${e.message}`);
    const geoCheck = await wc.executeJavaScript("navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state)").catch((e) => `error ${e.message}`);
    const media = await wc.executeJavaScript('navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", (e) => e.name)', true).catch((e) => `error ${e.message}`);
    const downloads = [];
    session.fromPartition('claude-reader').on('will-download', (event, item) => downloads.push({ prevented: event.defaultPrevented, state: item.getState() }));
    await wc.executeJavaScript("(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = 'x.txt'; document.body.append(a); a.click(); })()", true).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    wc.close();
    return { notification, geoCheck, media, downloads };
  }, `file:///${path.join(__dirname, 'fixture.html').replace(/\\/g, '/')}`);
  check('reader: Notification.requestPermission is denied', reader.notification === 'denied', reader.notification);
  check('reader: permission check says denied', reader.geoCheck === 'denied', reader.geoCheck);
  check('reader: microphone request is refused', reader.media === 'NotAllowedError', reader.media);
  check('reader: downloads are cancelled', reader.downloads.length > 0 && reader.downloads.every((d) => d.prevented), JSON.stringify(reader.downloads));

  // ---- a main-process load of the web in the UI window is put back (last: it reloads the UI)
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.loadURL('https://example.com/').catch(() => {}); });
  const back = await waitFor(async () => { const u = await uiUrl(); return /renderer\/index\.html$/.test(u) ? u : ''; }, 8000);
  check('UI: loadURL(https://example.com) ends up back on index.html', /renderer\/index\.html$/.test(back || ''), back || await uiUrl());
  const ui2 = (await app.windows()).find((p) => /index\.html$/.test(p.url())) || ui;
  await ui2.waitForSelector('.tab', { timeout: 10000 }).then(() => true, () => false);
  check('…and the UI comes back with its tabs', (await ui2.locator('.tab').count()) > 0, await ui2.locator('.tab').count());

  check('no UI errors', errors.length === 0, errors.join('; '));
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
