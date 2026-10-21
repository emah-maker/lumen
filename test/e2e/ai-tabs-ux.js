// AI tabs coherence (UX audit WP-C): one Settings group, one phrase, a "needs you" chip for hidden tabs, and a keyboard path to the
// Hide toggle's menu. The first half is plain Node (wording and markup); the second runs the real app, hidden
// (LUMEN_TEST_BACKGROUND=1), temp profile, 127.0.0.1 only.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

// ---- 1. wording (no Electron)
{
  const en = JSON.parse(read('src/locales/en.json'));
  const phrase = 'Close tabs the AI opened';
  check('wording: the menu, the taskbar task and the tab menu share one phrase', en['menu.closeAiTabs'] === phrase && en['taskbar.closeAiTabs'] === phrase, JSON.stringify([en['menu.closeAiTabs'], en['taskbar.closeAiTabs']]));
  check('wording: a chat\'s own close says "tabs this chat opened" (reply row and chat list agree)', en['chats.closeTabs'] === 'Close tabs this chat opened' && /tabs this chat opened/.test(en['chat.aiTabs.close.other']), en['chats.closeTabs']);
  check('wording: the right-click menu\'s checkbox is "Hide AI tabs" and its close row says it covers all windows', en['sidebar.hideAiTabs.menu.hide'] === 'Hide AI tabs' && /in all windows \(\{count\}\)/.test(en['sidebar.hideAiTabs.menu.close']), JSON.stringify([en['sidebar.hideAiTabs.menu.hide'], en['sidebar.hideAiTabs.menu.close']]));
  check('wording: the hover note says "the AI", as the rest does', en['tabs.aiOpened'] === 'Opened by the AI', en['tabs.aiOpened']);
  check('wording: When the AI finishes: Leave open / Ask / Close (no Never, Always or Off)', en['settings.ai.closeAiTabs'] === 'When the AI finishes' && en['settings.ai.closeAiTabs.off'] === 'Leave open' && en['settings.ai.closeAiTabs.ask'] === 'Ask' && en['settings.ai.closeAiTabs.always'] === 'Close', JSON.stringify([en['settings.ai.closeAiTabs.off'], en['settings.ai.closeAiTabs.always']]));
  check('wording: the Settings group is called AI tabs and has the Hide and front rows', en['settings.ai.groupAiTabs'] === 'AI tabs' && en['settings.ai.hideAiTabs'] === 'Hide AI tabs' && /AI opened/.test(en['settings.ai.stayOnMyTab']), en['settings.ai.stayOnMyTab']);
  const OLD = /tabs opened by (the )?(AI|this chat)|opened by AI\b|Close Tabs Opened by AI|Never close tabs|AI-opened tabs/i;
  const aiKeys = Object.entries(en).filter(([k]) => /ai|tabs?/i.test(k) && /AI|chat/.test(String(en[k])));
  const old = aiKeys.filter(([, v]) => OLD.test(v)).map(([k]) => k);
  check('wording: the old phrasings are gone from en.json', old.length === 0, old.join(', '));
  const titleCase = Object.entries(en).filter(([k, v]) => /AiTabs|aiTabs/.test(k) && /Opened By|Tabs Opened|Close Tabs|Hide Tabs/.test(v)).map(([k]) => k);
  check('wording: no label is Title Case', titleCase.length === 0, titleCase.join(', '));
  const files = ['src/main.js', 'src/renderer/app.js', 'src/renderer/chat-items.js', 'src/renderer/chat-extras.js', 'src/renderer/settings.js', 'src/features/taskbar-tasks.js', 'src/features/ai-manners.js', 'README.md', 'docs/settings.md', 'src/renderer/index.src.html'];
  const hits = files.filter((f) => OLD.test(read(f)));
  check('wording: no menu, source comment, doc or markup uses the old phrasings', hits.length === 0, hits.join(', '));
  check('wording: the first-write fallbacks match en.json', /tr\('chats\.closeTabs', 'Close tabs this chat opened'\)/.test(read('src/renderer/chat-items.js')));
}

// ---- 2. markup and settings source (no Electron)
{
  const html = read('src/renderer/index.src.html');
  const button = /<button[^>]*id="hide-ai-tabs"[^>]*>/.exec(html)?.[0] || '';
  check('toggle: aria-haspopup="menu" (it has a menu), aria-pressed and a data-i18n-title tooltip', /aria-haspopup="menu"/.test(button) && /aria-pressed=/.test(button) && /data-i18n-title="sidebar\.hideAiTabs"/.test(button), button);
  check('toggle: the generated index.html agrees (the bundle was rebuilt)', /aria-haspopup="menu"/.test(/<button[^>]*id="hide-ai-tabs"[^>]*>/.exec(read('src/renderer/index.html'))?.[0] || ''));
  const app = read('src/renderer/app.js');
  check('toggle: the Menu key and Shift+F10 open the same menu as a right-click', /e\.key !== 'ContextMenu' && !\(e\.shiftKey && e\.key === 'F10'\)/.test(app) && /hideAiButton\?\.addEventListener\('contextmenu'/.test(app));
  const settings = read('src/renderer/settings.js');
  const group = /card\.group\(tr\('settings\.ai\.groupAiTabs', 'AI tabs'\)\)\.append\(([\s\S]*?)\n {2}\);/.exec(settings)?.[1] || '';
  check('settings: the AI tabs group holds Hide, When the AI finishes and Bring to front', /toggle\('hideAiTabs'/.test(group) && /select\('closeAiTabs'/.test(group) && /toggle\('aiStayOnMyTab'/.test(group), group.slice(0, 200));
  check('settings: the three rows are not listed anywhere else in the AI section', (settings.match(/select\('closeAiTabs'/g) || []).length === 1 && (settings.match(/toggle\('aiStayOnMyTab'/g) || []).length === 1 && (settings.match(/toggle\('hideAiTabs'/g) || []).length === 1);
  const css = read('src/renderer/styles.css');
  check('chip: a needs-you state has its own look (not just a count)', /\.hide-ai-tabs\.needs-you/.test(css));
}

// ---- 3. the real app
(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body><h1>PAGE</h1></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-ai-tabs-ux-'));
  const app = await electron.launch({
    args: [path.join(ROOT)],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => global.__settings.backend.set('groupAiTabs', false)); // (these checks look at the AI's tabs loose in the strip; the folded group is ai-tab-group.js)
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
    const openAi = (url) => app.evaluate((_e, u) => global.__agent.browser.openTab(u, { ai: true }).id, url);
    const prefs = () => app.evaluate(() => global.__settings.backend.prefs?.() || {});
    const toggle = () => ui.evaluate(() => {
      const b = document.getElementById('hide-ai-tabs');
      return { hidden: b.hidden, pressed: b.getAttribute('aria-pressed'), title: b.title, aria: b.getAttribute('aria-description') || '', popup: b.getAttribute('aria-haspopup'), needs: b.classList.contains('needs-you'), chip: document.getElementById('hide-ai-tabs-label').textContent, chipShown: !document.getElementById('hide-ai-tabs-label').hidden };
    });

    // -- Settings > AI > AI tabs
    const sid = await app.evaluate((_e, s) => global.__settings.open(s), 'ai');
    const inTab = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [sid, code]);
    await waitFor(() => inTab("Boolean(document.getElementById('pref-hideAiTabs'))"));
    const rows = await inTab(`(() => {
      const g = document.getElementById('pref-hideAiTabs')?.closest('.group');
      const ids = g ? [...g.querySelectorAll('input[id^="pref-"], select[id^="pref-"]')].map((e) => e.id) : [];
      const opts = [...(document.getElementById('pref-closeAiTabs')?.options || [])].map((o) => o.value + '=' + o.text);
      return JSON.stringify({ title: g?.querySelector('.group-title')?.textContent, ids, opts, hide: document.getElementById('pref-hideAiTabs')?.getAttribute('aria-label'), when: document.getElementById('pref-closeAiTabs')?.getAttribute('aria-label'), front: document.getElementById('pref-aiStayOnMyTab')?.getAttribute('aria-label') });
    })()`);
    const r = JSON.parse(rows || '{}');
    check('settings: the AI tabs group has Group, Hide, When the AI finishes and Bring to front and Keep AI tabs I click on, together', r.title === 'AI tabs' && JSON.stringify(r.ids) === JSON.stringify(['pref-groupAiTabs', 'pref-hideAiTabs', 'pref-aiStayOnMyTab', 'pref-closeAiTabs', 'pref-keepViewedAiTabs']), rows);
    check('settings: When the AI finishes offers Leave open / Ask / Close and keeps the stored values', JSON.stringify(r.opts) === JSON.stringify(['off=Leave open', 'ask=Ask', 'always=Close']) && r.when === 'When the AI finishes', rows);
    check('settings: the row labels use the one phrase', r.hide === 'Hide AI tabs' && /tabs the AI opened/.test(r.front || ''), rows);
    check('settings: Hide AI tabs starts off', (await inTab("document.getElementById('pref-hideAiTabs').checked")) === false && (await prefs()).hideAiTabs !== true);
    await inTab("document.getElementById('pref-hideAiTabs').click()");
    check('settings: the Hide row turns hiding on (the same setting as the strip button)', Boolean(await waitFor(async () => (await prefs()).hideAiTabs === true)), JSON.stringify((await prefs()).hideAiTabs));
    await inTab("(() => { const s = document.getElementById('pref-closeAiTabs'); s.value = 'always'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    check('settings: the When the AI finishes row saves Close as "always"', Boolean(await waitFor(async () => (await prefs()).closeAiTabs === 'always')), (await prefs()).closeAiTabs);
    await inTab("(() => { const s = document.getElementById('pref-closeAiTabs'); s.value = 'off'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    check('settings: ...and Leave open as "off"', Boolean(await waitFor(async () => (await prefs()).closeAiTabs === 'off')), (await prefs()).closeAiTabs);
    // the strip button follows the setting
    const ai = await openAi(`${base}/ai1`);
    const t1 = await waitFor(async () => { const x = await toggle(); return !x.hidden && x.pressed === 'true' && /tab the AI opened/.test(x.title) && x; }); // (the title counts the tab once the strip has it; before that it says only that hiding is on)
    check('toggle: switched on from Settings, the strip button shows it pressed, with its tooltip and haspopup', Boolean(t1) && t1.popup === 'menu' && /tab the AI opened/.test(t1.title), JSON.stringify(t1));
    check('toggle: the AI tab is out of the strip (hidden), not closed', Boolean(await waitFor(() => ui.evaluate((i) => !document.querySelector(`#tabs .tab[data-id="${i}"]`), ai))));

    // -- a hidden tab that needs you
    check('chip: a hidden tab that does not need you says "hidden", not "needs you"', /hidden/.test((await toggle()).chip) && !(await toggle()).needs, JSON.stringify(await toggle()));
    // an error page in the hidden tab (nothing listens on port 1): the tab needs the user
    await app.evaluate(({ webContents }, a) => { webContents.fromId(global.__aiTabs.tab(a.id).view.webContents.id).loadURL(a.url).catch(() => {}); }, { id: ai, url: 'http://127.0.0.1:1/' });
    const t2 = await waitFor(async () => { const x = await toggle(); return x.needs && x; }, 15000);
    check('chip: an AI tab with an error, hidden, turns the chip into "1 needs you"', Boolean(t2) && t2.chip === '1 needs you' && t2.chipShown, JSON.stringify(t2));
    check('chip: its tooltip and spoken description say so too', Boolean(t2) && /needs you/.test(t2.title) && /needs you/.test(t2.aria), JSON.stringify(t2));
    const before = await active();
    await ui.click('#hide-ai-tabs');
    const shown = await waitFor(async () => (await active()) === ai);
    check('chip: a click shows that tab (it does not switch hiding off)', Boolean(shown) && (await prefs()).hideAiTabs === true, `${before} -> ${await active()}`);
    const t3 = await waitFor(async () => { const x = await toggle(); return !x.needs && x; });
    check('chip: with the tab in front, the chip goes back to its normal words', Boolean(t3) && !/needs you/.test(t3.chip), JSON.stringify(t3));

    // -- keyboard: Menu key and Shift+F10 open the same menu as a right-click
    await ui.focus('#hide-ai-tabs');
    const pops = () => app.evaluate(() => global.__hideAiMenuPops());
    const p0 = (await pops()).length;
    await ui.keyboard.press('Shift+F10');
    const p1 = await waitFor(async () => { const p = await pops(); return p.length === p0 + 1 && p; });
    check('keyboard: Shift+F10 on the toggle opens its menu, under the button', Boolean(p1) && Number.isFinite(p1[p0].x) && p1[p0].y > 0, JSON.stringify(p1));
    await ui.keyboard.press('ContextMenu');
    await sleep(900);
    const p2 = await pops();
    check('keyboard: the Menu key does too, once (not twice)', p2.length === p0 + 2 && Number.isFinite(p2[p0 + 1].x), JSON.stringify(p2));
    await ui.click('#hide-ai-tabs', { button: 'right' });
    await sleep(900);
    const p3 = await pops();
    check('keyboard parity: a right-click opens it too, at the pointer (no position sent)', p3.length === p0 + 3 && p3[p0 + 2].x === undefined, JSON.stringify(p3));
    await ui.keyboard.press('Shift+A');
    await sleep(300);
    check('keyboard: other keys on the toggle open nothing', (await pops()).length === p0 + 3);
    const menu = await app.evaluate(() => global.__hideAiMenu().map(({ label, type, checked }) => ({ label, type, checked })));
    check('menu: the same rows as before, the checkbox reads Hide AI tabs and Close says all windows', menu[0].label === 'Hide AI tabs' && menu[0].type === 'checkbox' && menu[0].checked === true && /^Close tabs the AI opened, in all windows \(\d+\)$/.test(menu[2].label), JSON.stringify(menu));

    check('no script errors in the UI', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
