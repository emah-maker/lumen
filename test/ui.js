// Address bar suggestions, inline completion, and find-as-you-type.
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

  check('no renderer errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
