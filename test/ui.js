// Address bar suggestions, inline completion, find-as-you-type, and address bar focus under stress.
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await ui.waitForTimeout(1000);
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

  // Visit example.com so it's in history.
  await ui.fill('#address', 'example.com');
  await ui.press('#address', 'Enter');
  await ui.waitForTimeout(2500);

  // Inline completion + dropdown.
  await ui.click('#address');
  await ui.keyboard.type('exa', { delay: 60 });
  await ui.waitForTimeout(400);
  const value = await ui.inputValue('#address');
  check('inline completion', value === 'example.com', value);
  const popup = await app.evaluate(({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children;
    const v = views.find((x) => x.webContents.getURL().endsWith('suggest.html'));
    return v ? { visible: v.getVisible(), bounds: v.getBounds() } : null;
  });
  check('dropdown shown over page', popup?.visible && popup.bounds.height > 40, JSON.stringify(popup));
  const popupRows = await app.evaluate(async ({ BrowserWindow }) => {
    const v = BrowserWindow.getAllWindows()[0].contentView.children.find((x) => x.webContents.getURL().endsWith('suggest.html'));
    return v.webContents.executeJavaScript('[...document.querySelectorAll("li")].map(l => l.textContent)');
  });
  check('dropdown lists history + search', popupRows.some((r) => r.includes('example.com')) && popupRows.some((r) => r.includes('Google Search')), JSON.stringify(popupRows));
  await ui.keyboard.press('ArrowDown');
  await ui.keyboard.press('Escape');
  await ui.waitForTimeout(200);
  const hidden = await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].contentView.children.find((x) => x.webContents.getURL().endsWith('suggest.html')).getVisible());
  check('Escape hides dropdown', hidden, 'still visible');
  await ui.keyboard.press('Escape');

  // Pick with mouse-equivalent: Google seed site via typing 'you'.
  await ui.click('#address');
  await ui.keyboard.type('you', { delay: 60 });
  await ui.waitForTimeout(300);
  check('seed site completion', (await ui.inputValue('#address')) === 'youtube.com', await ui.inputValue('#address'));
  await ui.keyboard.press('Escape');
  await ui.keyboard.press('Escape');

  // Find as you type (no Enter).
  // Synthetic keys skip Electron's before-input-event, so open the bar the way Ctrl+F does.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('find:open'));
  await ui.waitForTimeout(200);
  await ui.keyboard.type('domain', { delay: 60 });
  await ui.waitForTimeout(700);
  const findText = await ui.evaluate(() => document.getElementById('find-count').textContent);
  check('find as you type shows matches', /[1-9]\d* of [1-9]/.test(findText), JSON.stringify(findText));
  await ui.keyboard.press('Enter');
  await ui.waitForTimeout(400);
  const findText2 = await ui.evaluate(() => document.getElementById('find-count').textContent);
  check('Enter advances to next match', /2 of/.test(findText2) || /1 of 1/.test(findText2), JSON.stringify(findText2));

  // User agent.
  const ua = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getUserAgent());
  check('plain Chrome user agent', /Chrome\/\d+/.test(ua) && !/Electron|claude/i.test(ua), ua);

  // Sidebar layout: after a drag-resize, a window resize and a double-click reset, the page view
  // ends exactly at the sidebar's edge (no gap, no overlap).
  const edges = async () => {
    await ui.waitForTimeout(500);
    const side = await ui.evaluate(() => { const r = document.getElementById('sidebar').getBoundingClientRect(); return { left: r.left, width: r.width }; });
    const view = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const v = win.contentView.children.find((c) => c.getVisible?.() && c.webContents && c.webContents !== win.webContents && !c.webContents.getURL().includes('suggest.html'));
      return v ? v.getBounds() : null;
    });
    return { side, view, gap: view ? Math.abs(view.x + view.width - side.left) : null };
  };
  if (await ui.evaluate(() => document.body.classList.contains('sidebar-hidden'))) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(900);
  const handle = await ui.evaluate(() => { const r = document.getElementById('sidebar-resize').getBoundingClientRect(); return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) }; });
  const before = await edges();
  await app.evaluate(async ({ BrowserWindow }, h) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: h.x, y: h.y, button: 'left', clickCount: 1 });
    for (let dx = 0; dx <= 120; dx += 10) { wc.sendInputEvent({ type: 'mouseMove', x: h.x - dx, y: h.y, button: 'left', modifiers: ['leftButtonDown'] }); await new Promise((r) => setTimeout(r, 16)); }
    wc.sendInputEvent({ type: 'mouseUp', x: h.x - 120, y: h.y, button: 'left', clickCount: 1 });
  }, handle);
  const dragged = await edges();
  check('drag-resize widens the sidebar and the page meets its edge', dragged.side.width > before.side.width + 80 && dragged.gap <= 1, JSON.stringify({ before, dragged }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
  const resized = await edges();
  check('after a window resize the page still meets the sidebar edge', resized.gap <= 1 && resized.view.width >= 400, JSON.stringify(resized));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  const regrown = await edges();
  check('a bigger window gives the chosen width back', Math.abs(regrown.side.width - dragged.side.width) <= 2 && regrown.gap <= 1, JSON.stringify({ regrown, dragged }));
  const handleNow = await ui.evaluate(() => { const r = document.getElementById('sidebar-resize').getBoundingClientRect(); return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) }; });
  await app.evaluate(({ BrowserWindow }, h) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    for (const clickCount of [1, 2]) {
      wc.sendInputEvent({ type: 'mouseDown', x: h.x, y: h.y, button: 'left', clickCount });
      wc.sendInputEvent({ type: 'mouseUp', x: h.x, y: h.y, button: 'left', clickCount });
    }
  }, handleNow);
  const reset = await edges();
  check('double-clicking the handle resets the width, page meets the edge', Math.abs(reset.side.width - 360) <= 2 && reset.gap <= 1, JSON.stringify(reset));

  // Address bar focus under stress: 30 rounds of loading pages, switching tabs, toggling the
  // sidebar and opening new tabs, then a click in the address bar and typing. A real click gives
  // the UI view native focus; keys go to whichever view has native focus, so anything that steals
  // focus afterwards (the new tab's page, the suggestion view) shows up as missing characters.
  const http = require('http');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>page ${req.url}</title><input id="i">`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  // A real click: native focus and the mouse press arrive together.
  const clickAddress = async () => {
    const r = await ui.evaluate(() => { const b = document.getElementById('address').getBoundingClientRect(); return { x: Math.round(b.x + 30), y: Math.round(b.y + b.height / 2) }; });
    await app.evaluate(({ BrowserWindow }, p) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.focus();
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }, r);
  };
  const typeNative = (text) => app.evaluate(async ({ webContents }, t) => {
    for (const ch of t) {
      webContents.getFocusedWebContents()?.sendInputEvent({ type: 'char', keyCode: ch });
      await new Promise((r) => setTimeout(r, 6));
    }
  }, text);
  let good = 0;
  const bad = [];
  for (let i = 0; i < 30; i++) {
    await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); }, `${base}/p${i}`);
    await app.evaluate((_e, n) => { const list = global.__agent.browser.listTabs(); global.__agent.browser.switchTab(list[n % list.length].id); }, i);
    if (i % 3 === 0) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.click('#new-tab');
    if (i % 2) await ui.waitForTimeout(40 + (i % 5) * 30); // sometimes before the new tab has loaded, sometimes after
    else await app.evaluate(() => new Promise((r) => { const wc = global.__agent.browser.activeTab().webContents; if (wc.isLoading()) wc.once('did-stop-loading', r); else r(); }));
    await clickAddress();
    const text = `q${i} hello world`;
    await typeNative(text);
    await ui.waitForTimeout(250); // a late focus steal would land here
    await typeNative('!');
    const state = await ui.evaluate(() => ({ value: document.getElementById('address').value, focused: document.activeElement?.id }));
    if (state.value === `${text}!` && state.focused === 'address') good++;
    else bad.push({ i, ...state, focusedView: await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL().slice(-40)), q: await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('q')?.value")) });
    await ui.keyboard.press('Escape');
    await ui.keyboard.press('Escape');
  }
  check(`address bar keeps focus and every character (${good}/30)`, good === 30, JSON.stringify(bad.slice(0, 3)));
  const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.getVisible?.() && v.getBounds().height > 0 && v.webContents?.getURL().includes('suggest.html')).length);
  check('no suggestion view left over the page', shown === 0, shown);
  server.close();

  check('no renderer errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
