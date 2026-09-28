// Private windows (features/private-window.js): Ctrl+Shift+N opens one; its cookies, history and
// tabs stay out of the normal profile, the AI's tools and session restore; closing it clears its
// session; and its UI bridge answers only its own window.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const server = http.createServer((req, res) => {
    const page = (title, body = '') => `<!doctype html><title>${title}</title><body>${body}</body>`;
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/set') {
      res.setHeader('Set-Cookie', 'pv=secret; Max-Age=3600; Path=/');
      return res.end(page('Set', '<a id="pop" href="/popped" target="_blank">pop</a>'));
    }
    if (req.url === '/popped') return res.end(page('Popped'));
    if (req.url === '/agent') return res.end(page('Agent'));
    return res.end(page('Other'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-windows-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  const launch = async () => {
    const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    return { app, ui };
  };

  let { app, ui } = await launch();
  const errors = [];
  try {
    // ---- Ctrl+Shift+N in the main window opens a private window
    // Synthetic Playwright keys skip before-input-event (see test/ui.js), so send real input events.
    const shortcut = (urlPart, keyCode, modifiers) => app.evaluate(({ BrowserWindow }, [part, k, mods]) => {
      const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(part)).webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods });
    }, [urlPart, keyCode, modifiers]);
    await shortcut('index.html', 'N', ['control', 'shift']);
    await waitFor(() => app.evaluate(() => global.__private.count() === 1));
    const pw = await waitFor(async () => app.windows().find((p) => p.url().includes('private.html')));
    pw.on('pageerror', (e) => errors.push(e.message));
    await pw.waitForSelector('#address');
    check('Ctrl+Shift+N opens a private window', (await app.evaluate(() => global.__private.count())) === 1);
    check('the private window is labelled Private', /Private/.test(await pw.textContent('#badge')) && /Private/.test(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getTitle(), (await app.evaluate(() => global.__private.list()[0].windowId)))), await pw.textContent('#badge'));
    const first = await waitFor(() => app.evaluate(() => { const w = global.__private.list()[0]; return w.tabs.length === 1 && /private-newtab\.html$/.test(w.tabs[0].url) ? w : null; }));
    check('it starts on the private new-tab page', Boolean(first), JSON.stringify(first));
    const { windowId, partition } = first;
    check('it uses an in-memory session (no persist: partition)', /^lumen-private-/.test(partition) && !partition.startsWith('persist:'), partition);

    // ---- browse through the private UI's own address box
    await pw.fill('#address', `${base}/set`);
    await pw.press('#address', 'Enter');
    const loaded = await waitFor(() => app.evaluate((_e, url) => global.__private.list()[0].tabs.some((t) => t.url === url), `${base}/set`));
    check('the address box loads a page in the private tab', loaded, JSON.stringify(await app.evaluate(() => global.__private.list())));
    await waitFor(async () => /Set/.test(await pw.textContent('.tab.active .title')));
    check('the tab strip shows the page title', /Set/.test(await pw.textContent('.tab.active .title')), await pw.textContent('#tabs'));

    const cookies = await app.evaluate(async ({ session }, part) => ({
      priv: (await session.fromPartition(part).cookies.get({ name: 'pv' })).length,
      normal: (await session.defaultSession.cookies.get({ name: 'pv' })).length,
    }), partition);
    check('the cookie is set in the private session', cookies.priv === 1, JSON.stringify(cookies));
    check('the cookie does not reach the normal profile', cookies.normal === 0, JSON.stringify(cookies));

    // ---- a target=_blank link opens another private tab, not a normal one
    const privTabId = (await app.evaluate(() => global.__private.list()[0].tabs[0])).contentsId;
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.getElementById('pop').click()", true), privTabId);
    const popped = await waitFor(() => app.evaluate((_e, url) => global.__private.list()[0].tabs.some((t) => t.url === url), `${base}/popped`));
    check('a new-window link opens as a private tab', popped, JSON.stringify(await app.evaluate(() => global.__private.list())));
    const normalUrls = await app.evaluate(() => global.__settings.tabs().map((t) => t.url));
    check('no private page appears among the normal tabs', !normalUrls.some((u) => u.startsWith(base)), normalUrls.join(', '));

    // ---- history, the AI's tools
    const hist = await app.evaluate(() => global.__settings.historyUrls());
    check('private pages are not added to history', !hist.some((u) => u === `${base}/set` || u === `${base}/popped`), hist.join(', '));
    const listed = JSON.stringify(await app.evaluate(() => global.__agent.execute('list_tabs', {})));
    check("the AI's list_tabs does not see private tabs", !listed.includes('127.0.0.1'), listed.slice(0, 300));
    // (navigate opens /agent in a normal tab: that one is expected in the normal tabs and history)
    await app.evaluate((_e, url) => global.__agent.execute('navigate', { url }), `${base}/agent`).catch(() => {});
    const afterAgent = await app.evaluate(() => global.__private.list()[0].tabs.map((t) => t.url));
    check("the AI's navigate never drives a private tab", !afterAgent.includes(`${base}/agent`), afterAgent.join(', '));

    // ---- the private:* bridge answers only the private window's own UI
    const before = await app.evaluate(() => global.__private.list()[0].tabs.map((t) => t.url).join(' '));
    await app.evaluate(({ ipcMain, BrowserWindow }, url) => {
      const main = BrowserWindow.getAllWindows().find((w) => /index\.html$/.test(w.webContents.getURL())).webContents;
      ipcMain.emit('private:go', { sender: main, senderFrame: main.mainFrame }, url);
      ipcMain.emit('private:new-tab', { sender: main, senderFrame: main.mainFrame });
    }, `${base}/other`);
    await new Promise((r) => setTimeout(r, 500)); // a refusal has no event to wait for
    const after = await app.evaluate(() => global.__private.list()[0].tabs.map((t) => t.url).join(' '));
    check('the main window cannot drive a private window over IPC', before === after, `${before} -> ${after}`);

    // ---- Ctrl+W in the private window closes a tab; Ctrl+T opens one
    await shortcut('private.html', 'T', ['control']);
    const three = await waitFor(() => app.evaluate(() => global.__private.list()[0].tabs.length === 3));
    check('Ctrl+T opens a private tab', three, JSON.stringify(await app.evaluate(() => global.__private.list()[0].tabs.length)));
    await shortcut('private.html', 'W', ['control']);
    const two = await waitFor(() => app.evaluate(() => global.__private.list()[0].tabs.length === 2));
    check('Ctrl+W closes the active private tab', two, JSON.stringify(await app.evaluate(() => global.__private.list()[0].tabs.length)));

    // ---- closing the window clears its session
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), windowId);
    const closed = await waitFor(() => app.evaluate(() => global.__private.count() === 0));
    check('the private window closes', closed);
    const left = await waitFor(() => app.evaluate(async ({ session }, part) => ((await session.fromPartition(part).cookies.get({})).length === 0 ? 'empty' : null), partition));
    check("closing it clears the private session's cookies", left === 'empty', left);
    check('the main window is still open', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => /index\.html$/.test(w.webContents.getURL()))));
    check('no errors in the private UI', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close();
  }

  // ---- restart with the same profile: nothing from the private window comes back
  ({ app, ui } = await launch());
  try {
    await new Promise((r) => setTimeout(r, 1000)); // session restore opens its tabs right after the UI is ready
    const state = await app.evaluate(async ({ session }) => ({
      privateWindows: global.__private.count(),
      cookie: (await session.defaultSession.cookies.get({ name: 'pv' })).length,
      tabs: global.__settings.tabs().map((t) => t.url),
      history: global.__settings.historyUrls(),
    }));
    check('after a restart no private window is restored', state.privateWindows === 0, JSON.stringify(state));
    check('after a restart the private cookie is not in the profile', state.cookie === 0, JSON.stringify(state));
    check('after a restart no private page is among the tabs or history', ![...state.tabs, ...state.history].some((u) => ['/set', '/popped', '/other'].some((x) => u === base + x)), JSON.stringify(state));
  } finally {
    await app.close();
    server.close();
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
