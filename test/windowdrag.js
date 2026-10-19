// Window dragging: the title bar must always have somewhere to grab. Asserts the computed -webkit-app-region of the
// tab strip, tabs, buttons, toolbar and address field, and that the strip's drag gutter keeps its width (and stays
// on screen, clear of the caption buttons) with 1, 20 and 60 tabs. With WINDOWDRAG_SHOTS=<dir> it also saves
// screenshots with the drag regions outlined (outline added by the test only, never in the app).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-windowdrag-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
  await sleep(300);
  const shots = process.env.WINDOWDRAG_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const region = (sel) => ui.evaluate((s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).webkitAppRegion : null; }, sel);
  const regions = async (label) => {
    for (const [sel, want] of [
      ['#tabstrip', 'drag'], ['#tabs', 'drag'], ['.tab', 'no-drag'], ['#new-tab', 'no-drag'], ['#tab-search', 'no-drag'], ['#drag-gutter', 'drag'],
      ['.toolbar', 'drag'], ['.toolbar-start', 'drag'], ['#back', 'no-drag'], ['#forward', 'no-drag'], ['#omnibox', 'no-drag'], ['#address', 'no-drag'],
      ['.toolbar-end', 'drag'], ['#app-menu', 'no-drag'], ['#toggle-sidebar', 'no-drag'],
    ]) { const got = await region(sel); check(`${label}: ${sel} is ${want}`, got === want, got); }
  };
  const gutter = () => ui.evaluate(() => {
    const g = document.getElementById('drag-gutter').getBoundingClientRect();
    const bar = document.getElementById('tabstrip').getBoundingClientRect();
    const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
    return { left: g.left, right: g.right, width: g.width, height: g.height, barRight: bar.right, vw: innerWidth, hit: hit && hit.id, tabs: document.querySelectorAll('.tab').length };
  });
  const gutterCheck = async (n) => {
    const g = await gutter();
    check(`${n} tab(s): drag gutter keeps >= 56px (${Math.round(g.width)}px)`, g.width >= 55.5, JSON.stringify(g));
    check(`${n} tab(s): gutter is as tall as the strip`, g.height >= 30, JSON.stringify(g));
    check(`${n} tab(s): gutter is on screen, clear of the window controls`, g.right <= g.vw - 100 && g.left >= 0, JSON.stringify(g));
    check(`${n} tab(s): gutter is what is under its centre`, g.hit === 'drag-gutter', JSON.stringify(g));
  };
  const shot = async (n) => {
    if (!shots) return;
    await ui.addStyleTag({ content: '[data-wd-shot] * { outline: 0 !important; } .drag-gutter, .tabstrip, .toolbar { outline: 2px solid rgb(0 200 80 / 0.8) !important; outline-offset: -2px; background-image: repeating-linear-gradient(45deg, rgb(0 200 80 / 0.18) 0 6px, transparent 6px 12px); } .tab, .tabstrip button, .toolbar button, .toolbar .omnibox, .toolbar-end > * { outline: 1.5px solid rgb(230 40 40 / 0.85) !important; outline-offset: -1px; } .tab, .omnibox { background-image: none; }' });
    await sleep(200);
    await ui.screenshot({ path: path.join(shots, `drag-${n}-tabs.png`), clip: { x: 0, y: 0, width: 1440, height: 90 } });
  };
  const openTabs = (count) => app.evaluate(async (_e, c) => {
    const have = global.__agent.browser.listTabs ? global.__agent.browser.listTabs().length : 1;
    for (let i = have; i < c; i++) global.__agent.browser.openTab('about:blank', { background: true });
  }, count);
  const waitTabs = async (n) => { for (let i = 0; i < 100; i++) { if (await ui.evaluate(() => document.querySelectorAll('.tab').length) === n) return; await sleep(100); } };

  await regions('1 tab');
  await gutterCheck(1); await shot(1);
  await openTabs(20); await waitTabs(20); await sleep(400);
  await gutterCheck(20); await shot(20);
  await openTabs(60); await waitTabs(60); await sleep(600);
  await regions('60 tabs');
  await gutterCheck(60); await shot(60);
  const overflow = await ui.evaluate(() => { const t = document.getElementById('tabs'); return t.scrollWidth > t.clientWidth; });
  check('60 tabs overflow the strip (so the gutter is what is protected)', overflow, overflow);

  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
