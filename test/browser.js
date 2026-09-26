// Browser behaviour: fullscreen, popups, background tabs, bookmarks, zoom, tab order, downloads,
// isolation of Claude's page scripts, the cookie-less reader, and per-site approval.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PAGE = `<!doctype html><html><head><title>Browser fixture</title></head><body>
<a id="blank" href="/other" target="_blank">New tab link</a>
<button id="pop" onclick="window.__popup = window.open('/popup', 'auth', 'width=400,height=300')">Sign in</button>
<button id="fs" onclick="document.getElementById('video').requestFullscreen()">Full screen</button>
<div id="video" style="width:200px;height:100px;background:#000"></div>
<a id="dl" href="/file.txt" download>Download</a>
<form><fieldset><legend>Pizza Size</legend>
<label><input type="radio" name="size" value="small"> Small</label>
<label><input type="radio" name="size" value="large"> Large</label></fieldset></form>
</body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/file.txt') {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename="claude-browser-test.txt"');
      return res.end('hello download');
    }
    if (req.url === '/cookie') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(`<title>cookie</title><body>cookie=[${req.headers.cookie || ''}]</body>`);
    }
    if (req.url === '/popup') {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<title>Popup</title><script>window.opener && window.opener.postMessage("from-popup", "*"); document.title = window.opener ? "has-opener" : "no-opener";</script>');
    }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'session=secret123; Path=/');
    res.end(PAGE);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r).slice(0, 300); }
    catch (err) { return 'ERROR: ' + err.message; }
  }, [name, input]);
  const tabState = async () => {
    const id = await app.evaluate(() => global.__agent.browser.activeTab().id);
    return ui.evaluate((activeId) => new Promise((resolve) => {
      window.browser.onTabs((s) => resolve(s));
      window.browser.switchTab(activeId); // re-selecting the active tab makes main re-send state
      setTimeout(() => resolve(null), 1500);
    }), id);
  };
  const tabCount = async () => JSON.parse(await run('list_tabs', {})).length;
  const pageEval = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c, true), code);

  await run('navigate', { url: base + '/' });

  // Isolation: the page can't see Claude's element registry.
  await run('read_page', {});
  check("page can't see Claude's element list", (await pageEval('typeof window.__claudeEls')) === 'undefined', 'visible to page');

  // Fieldset legend names a radio group.
  const r1 = await run('fill_form', { fields: [{ label: 'Pizza Size', value: 'Large' }] });
  check('radio group found by its fieldset legend', !r1.startsWith('ERROR') && (await pageEval("document.querySelector('input[value=large]').checked")), r1);
  const r2 = await run('fill_form', { fields: [{ label: 'No such field', value: 'x' }] });
  check('fill_form reports failures as an error', r2.startsWith('ERROR') && r2.includes('1 of 1 fields failed'), r2);

  // target=_blank opens a foreground tab; Ctrl+click-style background disposition stays in the background.
  const before = await tabCount();
  await pageEval("document.getElementById('blank').click()");
  await new Promise((r) => setTimeout(r, 1200));
  check('target=_blank link opens a new tab', (await tabCount()) === before + 1, await tabCount());
  await run('switch_tab', { tab_id: 1 });
  const activeBefore = await app.evaluate(() => global.__agent.browser.activeTab().id);
  await app.evaluate(({ BrowserWindow }) => {}); // keep window alive
  // A real Ctrl+click (synthetic page events can't open background tabs).
  const pt = await pageEval("(() => { const r = document.getElementById('blank').getBoundingClientRect(); return { x: Math.round(r.left + 5), y: Math.round(r.top + r.height / 2) }; })()");
  await app.evaluate((_e, p) => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: ['control'] });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers: ['control'] });
  }, pt);
  await new Promise((r) => setTimeout(r, 1200));
  const activeAfter = await app.evaluate(() => global.__agent.browser.activeTab().id);
  check('Ctrl+click opens a background tab', (await tabCount()) === before + 2 && activeAfter === activeBefore, `tabs=${await tabCount()} active ${activeBefore}->${activeAfter}`);

  // Popups keep window.opener.
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await pageEval("document.getElementById('pop').click()");
  await new Promise((r) => setTimeout(r, 1500));
  const popup = await app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const p = wins.find((w) => w.webContents.getURL().includes('/popup'));
    return p ? { title: p.webContents.getTitle(), count: wins.length } : { count: wins.length };
  });
  check('window.open popup is a real window with window.opener', popup.title === 'has-opener' && popup.count === windowsBefore + 1, JSON.stringify(popup));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popup'))?.close());

  // HTML fullscreen fills the window.
  await pageEval("document.getElementById('fs').click()");
  await new Promise((r) => setTimeout(r, 1200));
  const fsBounds = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children.find((v) => v.getVisible() && v.webContents === global.__agent.browser.activeTab().webContents);
    return { view: view.getBounds(), content: win.getContentSize() };
  });
  check('video fullscreen fills the whole window', fsBounds.view.y === 0 && fsBounds.view.x === 0 && fsBounds.view.width === fsBounds.content[0], JSON.stringify(fsBounds));
  await pageEval('document.exitFullscreen()');
  await new Promise((r) => setTimeout(r, 1200));
  const normal = await app.evaluate(() => global.__agent.browser.activeTab().webContents);
  const afterFs = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.contentView.children.find((v) => v.getVisible() && v.webContents === global.__agent.browser.activeTab().webContents).getBounds();
  });
  check('leaving fullscreen restores the layout', afterFs.y > 0, JSON.stringify(afterFs));

  // Zoom and bookmarks show up in tab state.
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.setZoomLevel(1));
  let state = await tabState();
  const active = (s) => s?.tabs.find((t) => t.id === s.activeId);
  check('tab state reports zoom', active(state)?.zoom === 120, JSON.stringify(active(state)));
  await ui.evaluate(() => window.browser.resetZoom());
  await ui.evaluate(() => window.browser.toggleBookmark());
  await new Promise((r) => setTimeout(r, 300));
  state = await tabState();
  check('bookmarking marks the tab', active(state)?.bookmarked === true && active(state)?.zoom === 100, JSON.stringify(active(state)));
  const ntUrl = await app.evaluate(async () => {
    const t = global.__agent.browser.openTab();
    await new Promise((r) => setTimeout(r, 800));
    return t.webContents.getURL();
  });
  check('new-tab page receives bookmarks', decodeURIComponent(ntUrl.split('#')[1] || '').includes('127.0.0.1'), ntUrl.slice(0, 200));
  state = await tabState();
  check('new-tab page shows an empty address', active(state)?.url === '', active(state)?.url);

  // Tab reordering.
  const order = state.tabs.map((t) => t.id);
  const last = order[order.length - 1];
  await ui.evaluate((id) => window.browser.moveTab(id, 0), last);
  await new Promise((r) => setTimeout(r, 300));
  state = await tabState();
  check('tabs can be reordered', state.tabs[0].id === last, JSON.stringify(state.tabs.map((t) => t.id)));

  // Downloads save to the Downloads folder without a dialog.
  await run('switch_tab', { tab_id: 1 });
  const dlDir = await app.evaluate(({ app: a }) => a.getPath('downloads'));
  const existing = new Set(fs.readdirSync(dlDir));
  await pageEval("document.getElementById('dl').click()");
  await new Promise((r) => setTimeout(r, 2000));
  const added = fs.readdirSync(dlDir).filter((f) => !existing.has(f) && f.startsWith('claude-browser-test'));
  check('downloads save to the Downloads folder', added.length === 1 && fs.readFileSync(path.join(dlDir, added[0]), 'utf8') === 'hello download', added.join(','));
  for (const f of added) fs.unlinkSync(path.join(dlDir, f));

  // read_urls doesn't carry the user's cookies.
  const withCookie = await pageEval('document.cookie');
  const reader = await app.evaluate((_e, u) => global.__agent.execute('read_urls', { urls: [u] }), base + '/cookie');
  check('read_urls pages load without the user\'s cookies', withCookie.includes('secret123') && reader.includes('cookie=[]'), `${withCookie} / ${reader.slice(0, 200)}`);

  // Per-site approval: an inline card; a denied site blocks acting tools but not reading.
  const approval = await app.evaluate(async () => {
    const agent = global.__agent;
    agent.approvedHosts = new Set();
    const original = agent.browser.autoApprove;
    agent.browser.autoApprove = () => false;
    const events = [];
    const signal = new AbortController().signal;
    const pending = agent.ensureAllowed('click', (e) => events.push(e), signal).then(() => 'allowed', (e) => e.message);
    await new Promise((r) => setTimeout(r, 50));
    const card = events.find((e) => e.type === 'approval');
    agent.resolveApproval(card?.approvalId, false);
    const denied = await pending;
    let read = 'ok';
    try { await agent.ensureAllowed('read_page', () => {}, signal); } catch (e) { read = e.message; }
    const pending2 = agent.ensureAllowed('click', (e) => events.push(e), signal).then(() => 'allowed', (e) => e.message);
    await new Promise((r) => setTimeout(r, 50));
    agent.resolveApproval(events.filter((e) => e.type === 'approval').pop().approvalId, true);
    const allowed = await pending2;
    const again = await agent.ensureAllowed('click', (e) => events.push(e), signal).then(() => 'allowed');
    agent.browser.autoApprove = original;
    return { denied, read, allowed, again, cards: events.filter((e) => e.type === 'approval').length, host: card?.host };
  });
  check('approval card appears for a new site', approval.cards === 2 && approval.host?.startsWith('127.0.0.1'), JSON.stringify(approval));
  check('"Don’t allow" blocks clicks but not reading', approval.denied.includes('did not allow') && approval.read === 'ok', JSON.stringify(approval));
  check('"Allow" is remembered for the chat', approval.allowed === 'allowed' && approval.again === 'allowed' && approval.cards === 2, JSON.stringify(approval));

  // Settings are cached (the ad blocker reads them per request).
  const perf = await app.evaluate(() => { const t = Date.now(); for (let i = 0; i < 20000; i++) global.__agent.getOptions(); return Date.now() - t; });
  check('settings reads are cheap (cached)', perf < 500, `${perf} ms for 20k reads`);

  // A page that closes its own tab (window.close) must not leave a dead tab behind.
  await app.evaluate(() => {
    global.__uncaught = [];
    process.on('uncaughtException', (e) => global.__uncaught.push(e.stack || e.message));
  });
  const beforeClose = await tabCount();
  const selfClosing = await app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => setTimeout(r, 1000));
    await t.webContents.executeJavaScript('window.close()', true).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    return t.id;
  }, base + '/');
  const afterClose = JSON.parse(await run('list_tabs', {}));
  check('a self-closing tab is removed', afterClose.length === beforeClose && !afterClose.some((x) => x.id === selfClosing), JSON.stringify(afterClose.map((x) => x.id)));
  await run('switch_tab', { tab_id: afterClose[0].id });
  await ui.evaluate(() => window.browser.newTab());
  await new Promise((r) => setTimeout(r, 800));
  const uncaught = await app.evaluate(() => global.__uncaught);
  check('no uncaught main-process exceptions', uncaught.length === 0, uncaught.join(' | '));

  // Chrome identity: UA client hints agree with the Chrome user agent.
  await run('navigate', { url: base + '/' });
  const brands = await pageEval('navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand).join(",") : "none"');
  check('navigator.userAgentData says Google Chrome', brands.includes('Google Chrome'), brands);
  const devtools = await app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.openDevTools({ mode: 'detach' });
    await new Promise((r) => setTimeout(r, 1500));
    const open = wc.isDevToolsOpened();
    wc.closeDevTools();
    return open;
  });
  check('DevTools still opens with the identity override', devtools, 'did not open');

  // Sign-in / token URLs from live browsing never become suggestions; query strings aren't matched.
  await run('navigate', { url: base + '/oauth/authorize?client_id=abc123&state=xyz&code=secret' });
  await run('navigate', { url: base + '/docs/page?ref=zebra42' });
  await new Promise((r) => setTimeout(r, 300));
  const oauth = await ui.evaluate(() => window.browser.suggest('client_id'));
  const oauthByPath = await ui.evaluate(() => window.browser.suggest('127.0.0.1'));
  check('sign-in/token URLs are not recorded', !oauthByPath.some((s) => s.url.includes('/oauth/')), JSON.stringify(oauthByPath));
  check('suggestions ignore the query string', oauth.length === 0 && !(await ui.evaluate(() => window.browser.suggest('zebra42'))).length, JSON.stringify(oauth));
  check('suggestions still match the path', (await ui.evaluate(() => window.browser.suggest('127.0.0.1:'))).length >= 0 && oauthByPath.some((s) => s.url.includes('/docs/page')), JSON.stringify(oauthByPath));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
