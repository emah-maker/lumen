// Find in page, Match case (hidden): the find bar's Aa button searches with matchCase, the count follows it at once, and it stays on for the
// window: across closing and reopening the bar and switching tabs. Windows are invisible (LUMEN_TEST_BACKGROUND); nothing moves the real mouse.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await sleep(60); } };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const pages = {
    '/one': '<p>Apple apple APPLE apple</p>', // "apple": 4 any case, 2 matching case; "Apple": 1
    '/two': '<p>apple Apple</p>',
  };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Fixture</title><body>${pages[req.url] || ''}</body>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-findcase-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const open = (url, background = false) => app.evaluate(async (_e, { url, background }) => {
    const t = global.__agent.browser.openTab(url, { background });
    await new Promise((r) => { if (!t.webContents.isLoading()) r(); else t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, { url, background });
  const one = await open(`${base}/one`);
  const two = await open(`${base}/two`, true);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), one);
  await sleep(300);

  // Synthetic keys skip Electron's before-input-event, so the bar is opened the way Ctrl+F does (as test/e2e/ui.js).
  const openBar = () => app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents.send('find:open'));
  const count = () => ui.evaluate(() => document.getElementById('find-count').textContent);
  // (Find goes on from the match last selected, so after a reopen or a toggle the total is what tells the case rule, not which one is current.)
  const countIs = async (re) => waitFor(async () => { const c = await count(); return re.test(c) ? c : null; });
  const pressed = () => ui.evaluate(() => document.getElementById('find-case').getAttribute('aria-pressed'));

  await openBar();
  await ui.waitForSelector('#findbar.open');
  check('the find bar has a Match case button, off at first', (await pressed()) === 'false'
    && (await ui.evaluate(() => document.getElementById('find-case').getAttribute('aria-label'))) === 'Match case', await pressed());
  await ui.keyboard.type('apple', { delay: 30 });
  check('without Match case every case matches', Boolean(await countIs(/^1 of 4$/)), await count());

  await ui.click('#find-case');
  check('Match case on: the count follows at once', Boolean(await countIs(/^1 of 2$/)), await count());
  check('…the button shows it is on, and the field keeps the keyboard', (await pressed()) === 'true' && (await ui.evaluate(() => document.activeElement?.id)) === 'find-input', `${await pressed()} ${await ui.evaluate(() => document.activeElement?.id)}`);
  await ui.keyboard.press('Enter');
  check('Enter steps through the case-matching ones', Boolean(await countIs(/^2 of 2$/)), await count());
  await ui.keyboard.press('Enter');
  check('…and wraps', Boolean(await countIs(/^1 of 2$/)), await count());
  await ui.fill('#find-input', 'Apple');
  check('typing searches with Match case too', Boolean(await countIs(/^1 of 1$/)), await count());
  await ui.fill('#find-input', 'APPLE');
  check('…and an exact-case word is found', Boolean(await countIs(/^1 of 1$/)), await count());
  await ui.fill('#find-input', 'aPPLE');
  check('…a case no word has finds nothing', Boolean(await countIs(/^No matches$/)), await count());

  // It stays on for the window: closing and reopening the bar, and another tab.
  await ui.fill('#find-input', 'apple');
  await countIs(/^1 of 2$/);
  await ui.keyboard.press('Escape');
  await waitFor(async () => !(await ui.evaluate(() => document.getElementById('findbar').classList.contains('open'))));
  await openBar();
  await ui.waitForSelector('#findbar.open');
  check('reopened, the bar still has Match case on and counts with it', (await pressed()) === 'true' && Boolean(await countIs(/^[12] of 2$/)), `${await pressed()} ${await count()}`);
  await ui.keyboard.press('Escape');
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), two);
  await sleep(300);
  await openBar();
  await ui.waitForSelector('#findbar.open');
  check('on another tab it is still on', (await pressed()) === 'true' && Boolean(await countIs(/^1 of 1$/)), `${await pressed()} ${await count()}`);

  await ui.click('#find-case');
  check('turned off, every case matches again', (await pressed()) === 'false' && Boolean(await countIs(/^[12] of 2$/)), `${await pressed()} ${await count()}`);
  await ui.fill('#find-input', '');
  await ui.click('#find-case');
  check('with an empty field the button only flips (no search, no count)', (await pressed()) === 'true' && (await count()) === '', `${await pressed()} ${JSON.stringify(await count())}`);

  check('no renderer errors', errors.length === 0, errors.join('; '));
  server.close();
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
