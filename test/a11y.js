// Accessibility and UI strings: the tab strip works from the keyboard alone (the WAI-ARIA tabs
// pattern), no control in the browser UI or Settings is left without a name, and the strings come
// from locales/ (a locale file overrides English; a key it lacks falls back to English).
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createI18n, candidates } = require('../src/features/i18n');
const { openSettingsTab } = require('./settings-tab');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };
const root = path.join(__dirname, '..');
const EN = JSON.parse(fs.readFileSync(path.join(root, 'src', 'locales', 'en.json'), 'utf8'));

// Every visible control without an accessible name (a close approximation of the accname rules:
// aria-label, aria-labelledby, <label for>, alt text, text content, title). Runs in the page.
const AUDIT = `(() => {
  const shown = (el) => {
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const name = (el) => {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const text = by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (text) return text; }
    if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l && l.textContent.trim()) return l.textContent; }
    if (el.closest('label') && el.closest('label').textContent.trim()) return el.closest('label').textContent;
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const text = el.textContent.trim() || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim();
      if (text) return text;
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type) && el.value) return el.value;
    return (el.getAttribute('title') || '').trim();
  };
  const controls = document.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], [role=tab], [role=button], [role=switch], [role=checkbox], [role=option], [role=separator][tabindex], [tabindex]:not([tabindex="-1"])');
  return [...new Set(controls)].filter(shown).filter((el) => !name(el)).map((el) => el.outerHTML.slice(0, 120));
})()`;

(async () => {
  // ---- 1. the string table (no Electron) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-locales-'));
  fs.copyFileSync(path.join(root, 'src', 'locales', 'en.json'), path.join(dir, 'en.json'));
  fs.writeFileSync(path.join(dir, 'xx.json'), JSON.stringify({ 'toolbar.newTab': 'Nouvel onglet', 'menu.newTab': 'NT-xx', 'settings.section.appearance': 'Apparence', 'tabs.close': 'Fermer {title}', 'toolbar.back': '' }));
  const xx = createI18n({ locale: 'xx-YY', dir });
  check('i18n: a region falls back to its language (xx-YY -> xx)', xx.locale === 'xx', xx.locale);
  check('i18n: the locale file overrides English', xx.t('toolbar.newTab') === 'Nouvel onglet', xx.t('toolbar.newTab'));
  check('i18n: a key the locale lacks falls back to English', xx.t('toolbar.forward') === 'Forward', xx.t('toolbar.forward'));
  check('i18n: an empty translation falls back to English too', xx.t('toolbar.back') === 'Back', xx.t('toolbar.back'));
  check('i18n: placeholders are filled in', xx.t('tabs.close', { title: 'Docs {x}' }) === 'Fermer Docs {x}', xx.t('tabs.close', { title: 'Docs {x}' }));
  check('i18n: an unknown key shows the key, not blank', xx.t('no.such.key') === 'no.such.key', xx.t('no.such.key'));
  const en = createI18n({ locale: 'en-US', dir });
  check('i18n: English needs no locale file', en.locale === 'en' && en.t('toolbar.newTab') === 'New tab', `${en.locale} ${en.t('toolbar.newTab')}`);
  check('i18n: an unknown locale is English', createI18n({ locale: 'zz', dir }).t('toolbar.newTab') === 'New tab', '');
  check('i18n: locale names can\'t reach other folders', candidates('../../etc/pt-BR').every((c) => !/[./\\]/.test(c)), candidates('../../etc/pt-BR').join(','));

  // Every key the code and pages use exists in en.json.
  const missing = [];
  const scan = (file, pattern) => { const src = fs.readFileSync(path.join(root, file), 'utf8'); for (const m of src.matchAll(pattern)) if (!(m[1] in EN)) missing.push(`${file}: ${m[1]}`); };
  for (const f of ['src/main.js', 'src/renderer/app.js', 'src/renderer/extras.js', 'src/renderer/chat-core.js', 'src/renderer/chat-extras.js', 'src/renderer/chat-items.js', 'src/renderer/chat-page.js', 'src/renderer/updates.js', 'src/renderer/settings.js', 'src/features/downloads.js', 'src/features/adblock.js']) scan(f, /\b(?:t|tr|chatTr)\('([^'`]+)'/g);
  for (const f of ['src/renderer/index.html', 'src/renderer/settings.html', 'src/renderer/chat-page.html']) scan(f, /data-i18n[a-z-]*="([^"]+)"/g);
  check('i18n: every key in use is in locales/en.json', missing.length === 0, missing.join(', '));

  // ---- 2. the browser UI, in English ----
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Page ${req.url.slice(1)}</title><p>${req.url}</p>`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = (env = {}) => electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-a11y-')), ...env } });
  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setSize(1280, 860));
  const open = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, url);
  for (const name of ['one', 'two', 'three']) await open(`${base}/${name}`);
  await waitFor(() => ui.evaluate(() => document.querySelectorAll('#tabs .tab').length === 4));

  const strip = () => ui.evaluate(() => {
    const tabs = [...document.querySelectorAll('#tabs .tab:not(.tab-ghost)')];
    return {
      role: document.getElementById('tabs').getAttribute('role'),
      titles: tabs.map((t) => t.querySelector('.tab-title').textContent),
      roles: tabs.map((t) => t.getAttribute('role')),
      selected: tabs.map((t) => t.getAttribute('aria-selected')),
      stops: [...document.querySelectorAll('#tabs [tabindex="0"]')].length,
      closeStops: [...document.querySelectorAll('#tabs .tab-close')].filter((b) => b.tabIndex !== -1).length,
      active: document.querySelector('#tabs .tab.active .tab-title')?.textContent,
      focused: document.activeElement?.closest?.('.tab')?.querySelector('.tab-title')?.textContent ?? document.activeElement?.id ?? document.activeElement?.tagName,
    };
  });
  let s = await strip();
  check('aria: the tab container is the tablist', s.role === 'tablist', s.role);
  check('aria: every tab is role=tab with aria-selected', s.roles.every((r) => r === 'tab') && s.selected.filter((v) => v === 'true').length === 1 && s.selected.every((v) => v === 'true' || v === 'false'), JSON.stringify(s));
  check('aria: the strip is one Tab stop (roving tabindex), ✕ buttons aren\'t stops', s.stops === 1 && s.closeStops === 0, JSON.stringify(s));

  // Keyboard only from here: put focus in the window's UI, on the strip's one stop.
  await app.evaluate(({ BrowserWindow }) => { const w = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0]; w.focus(); w.webContents.focus(); });
  await waitFor(() => ui.evaluate(() => document.querySelector('#tabs .tab.active .tab-title')?.textContent === 'Page three')); // (the title arrives a moment after the load)
  await ui.evaluate(() => document.querySelector('#tabs [tabindex="0"]').focus());
  s = await strip();
  check('keyboard: the strip\'s stop is the active tab', s.focused === s.active && s.active === 'Page three', JSON.stringify(s));
  await ui.keyboard.press('ArrowLeft');
  s = await strip();
  check('keyboard: ArrowLeft moves focus to the previous tab, without switching', s.focused === 'Page two' && s.active === 'Page three', JSON.stringify(s));
  check('keyboard: the focused tab becomes the strip\'s stop', s.stops === 1 && await ui.evaluate(() => document.activeElement.tabIndex === 0), JSON.stringify(s));
  const ring = await ui.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check('keyboard: the focused tab shows a focus ring', ring !== 'none', ring);
  await ui.keyboard.press('Home');
  s = await strip();
  check('keyboard: Home moves to the first tab', s.focused === s.titles[0], JSON.stringify(s));
  await ui.keyboard.press('ArrowLeft');
  s = await strip();
  check('keyboard: ArrowLeft from the first tab wraps to the last', s.focused === s.titles[s.titles.length - 1], JSON.stringify(s));
  await ui.keyboard.press('ArrowRight');
  await ui.keyboard.press('ArrowRight');
  s = await strip();
  check('keyboard: ArrowRight moves on (and wraps)', s.focused === s.titles[1], JSON.stringify(s));
  await ui.keyboard.press('End');
  await ui.keyboard.press('ArrowLeft');
  s = await strip();
  check('keyboard: End then ArrowLeft', s.focused === 'Page two', JSON.stringify(s));
  await ui.keyboard.press('Enter');
  s = await waitFor(async () => { const v = await strip(); return v.active === 'Page two' ? v : null; }) || await strip();
  check('keyboard: Enter opens the focused tab', s.active === 'Page two', JSON.stringify(s));

  // Delete closes the focused tab and keeps focus in the strip, on a neighbour.
  await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].find((t) => t.textContent.includes('Page one')).focus());
  await ui.keyboard.press('Delete');
  s = await waitFor(async () => { const v = await strip(); return v.titles.length === 3 ? v : null; }) || await strip();
  check('keyboard: Delete closes the focused tab', s.titles.length === 3 && !s.titles.includes('Page one'), JSON.stringify(s));
  check('keyboard: after Delete, focus stays on a neighbouring tab', ['Page two', s.titles[0]].includes(s.focused), JSON.stringify(s));

  // Ctrl+Shift+PageDown / PageUp move the active tab (main.js handleShortcut, which sees native
  // input: sendInputEvent, as test/home.js does, not Playwright's synthetic key events).
  const shortcut = (key) => app.evaluate(({ BrowserWindow }, k) => {
    const wc = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents;
    for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: k, modifiers: ['control', 'shift'] });
  }, key);
  await ui.evaluate(() => document.querySelector('#tabs .tab.active').focus());
  const before = (await strip()).titles;
  await shortcut('PageDown');
  s = await waitFor(async () => { const v = await strip(); return v.titles.join() !== before.join() ? v : null; }) || await strip();
  const from = before.indexOf('Page two');
  check('keyboard: Ctrl+Shift+PageDown moves the active tab right', s.titles.indexOf('Page two') === from + 1, `${before} -> ${s.titles}`);
  check('keyboard: the moved tab keeps focus', s.focused === 'Page two', JSON.stringify(s));
  await shortcut('PageUp');
  s = await waitFor(async () => { const v = await strip(); return v.titles.indexOf('Page two') === from ? v : null; }) || await strip();
  check('keyboard: Ctrl+Shift+PageUp moves it back', s.titles.indexOf('Page two') === from, `${s.titles}`);
  await ui.keyboard.press('Tab');
  s = await strip();
  check('keyboard: Tab leaves the strip in one step', !s.titles.includes(s.focused), JSON.stringify(s));

  // ---- 3. no unnamed controls: the UI (sidebar open too) and every Settings section ----
  await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
  await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden')));
  await sleep(600); // the sidebar springs open
  const unnamedUi = await ui.evaluate(AUDIT);
  check('audit: every control in the browser UI has a name', unnamedUi.length === 0, unnamedUi.join(' | '));
  const inSettings = await openSettingsTab(app, 'you-and-ai');
  const ids = await inSettings('[...document.querySelectorAll("#nav a")].map((a) => a.dataset.section)');
  const unnamedSettings = [];
  for (const id of ids) {
    await inSettings(`location.hash = '#${id}'`);
    await sleep(150);
    for (const html of await inSettings(AUDIT)) unnamedSettings.push(`${id}: ${html}`);
  }
  check(`audit: every control in Settings has a name (${ids.length} sections)`, ids.length > 5 && unnamedSettings.length === 0, unnamedSettings.join(' | '));
  check('ui: no page errors', errors.length === 0, errors.join(' | '));
  await app.close();

  // ---- 4. a locale file changes the UI, menus and Settings; missing keys stay English ----
  app = await launch({ LUMEN_LOCALE: 'xx', LUMEN_LOCALES_DIR: dir });
  ui = await app.firstWindow();
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const got = await ui.evaluate(() => ({
    lang: document.documentElement.lang,
    newTab: document.getElementById('new-tab').getAttribute('aria-label'),
    forward: document.getElementById('forward').getAttribute('aria-label'),
    back: document.getElementById('back').getAttribute('aria-label'),
  }));
  check('locale: the UI picks up the locale file', got.lang === 'xx' && got.newTab === 'Nouvel onglet', JSON.stringify(got));
  check('locale: keys it lacks (or leaves empty) stay English in the UI', got.forward === 'Forward' && got.back === 'Back', JSON.stringify(got));
  const menu = await app.evaluate(() => [global.__i18n().t('menu.newTab'), global.__i18n().t('menu.reload')]);
  check('locale: main-process menus use it too, with English for the rest', menu[0] === 'NT-xx' && menu[1] === 'Reload', menu.join(', '));
  const inXxSettings = await openSettingsTab(app, 'appearance');
  const nav = await inXxSettings('[...document.querySelectorAll("#nav a")].map((a) => a.textContent)');
  check('locale: Settings section names follow it, English for the rest', Array.isArray(nav) && nav.includes('Apparence') && nav.includes('Advanced'), JSON.stringify(nav));
  check('locale: no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
