// Hardening: Lumen's own UI window can't be navigated or made to open windows, its IPC answers only
// its own top-level document, and the AI's hidden reader views get no permissions or downloads.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A local page stands in for "the web": the checks are about where Lumen lets a load go, not the network.
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>web</title>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const web = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hardening-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const uiUrl = () => app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents.getURL());
  const tabCount = () => app.evaluate(() => global.__settings.tabs().length);
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

  // ---- every channel preload.js sends is gated
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:send|invoke|sendSync)\('([^']+)'/g)].map((m) => m[1])
    .filter((c) => c !== 'ui-preload:loaded'); // open to every sender on purpose: it only restricts the view that sends it
  const ungated = await app.evaluate((_e, list) => list.filter((c) => !global.__ipcGate.gated(c)), channels);
  check(`every preload.js channel (${channels.length}) is gated to the UI`, channels.length > 30 && ungated.length === 0, ungated.join(', '));

  // ---- the UI window runs sandboxed, and its bundled preload still works there
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  });
  check('UI: the window is sandboxed with context isolation', prefs.sandbox === true && prefs.contextIsolation === true && !prefs.nodeIntegration, JSON.stringify(prefs));
  // webPreferences don't report the preload path, so check the source names the bundle.
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check('UI: it loads the bundled preload', /preload: path\.join\(__dirname, 'preload', 'preload\.bundle\.js'\)/.test(mainSrc) && !/'preload\.js'\)/.test(mainSrc), 'src/main.js');
  const bridge = await ui.evaluate(() => ({ browser: typeof window.browser?.newTab, toolbar: Boolean(customElements.get('browser-action-list')), node: typeof require }));
  check('UI: the bridge and the extensions toolbar element work under the sandbox', bridge.browser === 'function' && bridge.toolbar && bridge.node === 'undefined', JSON.stringify(bridge));

  // ---- the UI can't be navigated away from index.html
  await ui.evaluate((web) => { location.href = web; }, web).catch(() => {});
  await sleep(1500);
  check('UI: a renderer-side navigation is refused', /renderer\/index\.html$/.test(await uiUrl()), await uiUrl());
  await ui.evaluate((web) => { const a = document.createElement('a'); a.href = web; document.body.append(a); a.click(); a.remove(); }, web).catch(() => {});
  await sleep(1000);
  check('UI: a link click inside the UI is refused', /renderer\/index\.html$/.test(await uiUrl()), await uiUrl());

  // ---- window.open from the UI never makes a window; a web URL becomes an ordinary tab
  const tabsBefore = await tabCount();
  const winsBefore = await windowCount();
  const opened = await ui.evaluate((web) => window.open(web) === null, web);
  check('UI: window.open returns null (denied)', opened, opened);
  const tabsAfter = await waitFor(async () => ((await tabCount()) > tabsBefore ? tabCount() : 0));
  check('UI: window.open of a web URL opens a tab instead', tabsAfter === tabsBefore + 1, `${tabsBefore} -> ${tabsAfter}`);
  check('UI: no new window', (await windowCount()) === winsBefore, await windowCount());
  const tabsNow = await tabCount();
  await ui.evaluate(() => window.open('file:///C:/Windows/win.ini'));
  await sleep(800);
  check('UI: window.open of a file: URL is dropped', (await tabCount()) === tabsNow && (await windowCount()) === winsBefore, `${await tabCount()} tabs`);

  // ---- the suggestions dropdown can't be navigated or open windows
  const suggest = await app.evaluate(async ({ webContents }, web) => {
    const wc = webContents.getAllWebContents().find((w) => /renderer\/suggest\.html$/.test(w.getURL()));
    if (!wc) return 'no suggest view';
    await wc.executeJavaScript(`window.open('${web}'); location.href = '${web}'; 1`);
    await new Promise((r) => setTimeout(r, 1500));
    return wc.getURL();
  }, web);
  check('suggest view stays on suggest.html', /renderer\/suggest\.html$/.test(suggest), suggest);

  // ---- the dialogs overlay likewise
  const overlay = await app.evaluate(async ({ webContents }, web) => {
    const pending = global.__dialogs.showMessageBox(null, { message: 'hardening', buttons: ['OK'] });
    let wc;
    for (let i = 0; i < 40 && !wc; i++) { await new Promise((r) => setTimeout(r, 100)); wc = webContents.getAllWebContents().find((w) => /renderer\/dialog\.html$/.test(w.getURL())); }
    if (!wc) return 'no overlay';
    await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
    await wc.executeJavaScript(`location.href = '${web}'; 1`);
    await new Promise((r) => setTimeout(r, 1500));
    const url = wc.getURL();
    global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 0 });
    await pending;
    return url;
  }, web);
  check('dialog overlay stays on dialog.html', /renderer\/dialog\.html$/.test(overlay), overlay);

  // ---- backstop: any other webContents with the UI preload can't leave index.html either
  const backstop = await app.evaluate(async ({ BrowserWindow }, { preload, web }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } });
    await w.loadURL('about:blank#probe').catch(() => {});
    // about:blank is where it started; a renderer-side navigation to the web must be refused.
    await w.webContents.executeJavaScript(`location.href = '${web}'; 1`);
    await new Promise((r) => setTimeout(r, 1500));
    const url = w.webContents.getURL();
    w.destroy();
    return { url };
  }, { preload: path.join(__dirname, '..', 'src', 'preload', 'preload.bundle.js'), web });
  check('backstop: a view with the UI preload can\'t navigate to the web', !backstop.url.startsWith(web), backstop.url);

  // ---- privileged / UI-only IPC from a tab (or a subframe) is refused
  const ipc = await app.evaluate(async ({ ipcMain, BrowserWindow }, web) => {
    const tab = global.__agent.browser.openTab('about:blank');
    await new Promise((r) => setTimeout(r, 500));
    const twc = tab.webContents;
    const uiWc = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents;
    const invoke = async (channel, event, ...args) => {
      try { await ipcMain._invokeHandlers.get(channel)(event, ...args); return 'allowed'; } catch (err) { return err.message; }
    };
    const before = global.__settings.tabs().length;
    ipcMain.emit('tab:new', { sender: twc, senderFrame: twc.mainFrame }, web);
    ipcMain.emit('tab:new', { sender: uiWc, senderFrame: { url: 'https://evil.example/' } }, web);
    await new Promise((r) => setTimeout(r, 500));
    return {
      autoAllow: await invoke('agent:auto-allow', { sender: twc, senderFrame: twc.mainFrame }, true),
      setKey: await invoke('settings:set-key', { sender: twc, senderFrame: twc.mainFrame }, 'sk-x'),
      subframe: await invoke('agent:auto-allow', { sender: uiWc, senderFrame: { url: 'https://evil.example/' } }, true),
      uiAllowed: await invoke('agent:auto-allow', { sender: uiWc, senderFrame: uiWc.mainFrame }),
      tabsOpened: global.__settings.tabs().length - before,
    };
  }, web);
  check('tab: agent:auto-allow refused', ipc.autoAllow === 'Not allowed', ipc.autoAllow);
  check('tab: settings:set-key refused', ipc.setKey === 'Not allowed', ipc.setKey);
  check('UI webContents but not its main frame: refused', ipc.subframe === 'Not allowed', ipc.subframe);
  check('tab / foreign frame: tab:new ignored', ipc.tabsOpened === 0, ipc.tabsOpened);
  check('the UI document itself is still allowed', ipc.uiAllowed === 'allowed', ipc.uiAllowed);
  const realUi = await ui.evaluate(async () => typeof (await window.assistant.autoAllow()));
  check('real UI call still works (assistant.autoAllow)', realUi === 'boolean', realUi);
  const tabsBeforeNew = await tabCount();
  await ui.evaluate(() => window.browser.newTab('about:blank'));
  check('test mode: the UI bridge has its test-only calls', await ui.evaluate(() => typeof window.assistant.mcpInfo === 'function'), 'no assistant.mcpInfo');
  check('real UI call still works (browser.newTab)', (await waitFor(async () => ((await tabCount()) > tabsBeforeNew ? 1 : 0))) === 1, await tabCount());

  // ---- the error page runs with no inline script allowed (its script is renderer/error.js)
  const errorHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'error.html'), 'utf8');
  check('error.html: CSP allows no inline script', /script-src 'self'(;|")/.test(errorHtml) && !/<script>/.test(errorHtml), errorHtml.match(/Content-Security-Policy" content="([^"]+)/)?.[1]);
  const errorPage = await app.evaluate(async ({ WebContentsView }, url) => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    await view.webContents.loadURL(url).catch(() => {});
    const text = await view.webContents.executeJavaScript("document.getElementById('message').textContent + ' | ' + document.getElementById('code').textContent");
    view.webContents.close();
    return text;
  }, `file:///${path.join(__dirname, '..', 'src', 'renderer', 'error.html').replace(/\\/g, '/')}?url=${encodeURIComponent('https://unreachable.test/')}&desc=ERR_NAME_NOT_RESOLVED&code=-105`);
  check('error.html: its script still fills in the message', errorPage.includes('unreachable.test') && errorPage.includes('ERR_NAME_NOT_RESOLVED (-105)'), errorPage);

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
  await app.evaluate(({ BrowserWindow }, web) => { [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents.loadURL(web).catch(() => {}); }, web);
  const back = await waitFor(async () => { const u = await uiUrl(); return /renderer\/index\.html$/.test(u) ? u : ''; }, 8000);
  check('UI: a main-process loadURL of a web page ends up back on index.html', /renderer\/index\.html$/.test(back || ''), back || await uiUrl());
  const ui2 = (await app.windows()).find((p) => /index\.html$/.test(p.url())) || ui;
  await ui2.waitForSelector('.tab', { timeout: 10000 }).then(() => true, () => false);
  check('…and the UI comes back with its tabs', (await ui2.locator('.tab').count()) > 0, await ui2.locator('.tab').count());

  check('no UI errors', errors.length === 0, errors.join('; '));
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });

  // ---- a packaged build ignores CLAUDE_BROWSER_TEST / CLAUDE_BROWSER_PROFILE
  // A stand-in entry makes app.isPackaged true, gives Lumen its own throwaway profile (as a packaged
  // build would have its real one) and keeps a handle on the Agent's autoApprove, then loads main.js.
  const root = path.join(__dirname, '..');
  const packedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-packaged-'));
  const packedProfile = path.join(packedDir, 'profile');
  const plantedProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-planted-'));
  fs.mkdirSync(packedProfile);
  fs.writeFileSync(path.join(packedDir, 'entry.js'), `
    const { app } = require('electron');
    Object.defineProperty(app, 'isPackaged', { get: () => true, configurable: true });
    app.setPath('userData', ${JSON.stringify(packedProfile)});
    const agentModule = require(${JSON.stringify(path.join(root, 'src', 'ai', 'agent.js'))});
    const { Agent } = agentModule;
    agentModule.Agent = class extends Agent { constructor(host, ...rest) { super(host, ...rest); globalThis.lumenProbe = { autoApprove: host.autoApprove }; } };
    require(${JSON.stringify(path.join(root, 'src', 'main.js'))});
  `);
  const packed = await electron.launch({ args: [path.join(packedDir, 'entry.js')], env: { ...env, CLAUDE_BROWSER_PROFILE: plantedProfile } });
  const packedUi = await packed.firstWindow();
  await packedUi.waitForSelector('.tab');
  const state = await packed.evaluate(({ app, ipcMain, webContents }) => {
    const marked = () => webContents.getAllWebContents().filter((w) => w.getURL().includes('synthetic-marker')).length; // (a spare view of Lumen's own may be made meanwhile, so count a tab for this address, not all views)
    const before = marked();
    ipcMain.emit('tab:new', { sender: {} }, 'http://127.0.0.1:9/synthetic-marker'); // a synthetic event, as the tests send
    return new Promise((r) => setTimeout(() => r({
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      hooks: Object.keys(globalThis).filter((k) => k.startsWith('__') && !/playwright/i.test(k)),
      autoApprove: globalThis.lumenProbe?.autoApprove(),
      synthetic: marked() - before,
    }), 1000));
  });
  check('packaged: app.isPackaged is faked true', state.packaged === true, state.packaged);
  check('packaged: AI auto-approve stays off despite CLAUDE_BROWSER_TEST', state.autoApprove === false, state.autoApprove);
  check('packaged: no global.__* test hooks', state.hooks.length === 0, state.hooks.join(', '));
  check('packaged: CLAUDE_BROWSER_PROFILE is ignored', path.resolve(state.userData) === path.resolve(packedProfile), state.userData);
  check('packaged: a synthetic IPC event is refused', state.synthetic === 0, state.synthetic);
  const testCalls = await packedUi.evaluate(() => Object.keys(window.assistant).filter((k) => ['mcpInfo', 'setMcpEnabled', 'automationInfo', 'setAutomation', 'setAutoGroup', 'setProviderKey'].includes(k)));
  check('packaged: the UI bridge has no test-only calls', testCalls.length === 0, testCalls.join(', '));
  await packed.close();
  fs.rmSync(packedDir, { recursive: true, force: true });
  fs.rmSync(plantedProfile, { recursive: true, force: true });
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
