// Built-in ad blocker: blocks ads on real pages, and pages don't see it.
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const go = (url) => app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), url);
  const js = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  const blocked = () => app.evaluate(() => global.__adblock.blocked(global.__agent.browser.activeTab().webContents.id));

  const start = Date.now();
  while (!(await app.evaluate(() => global.__adblock.ready())) && Date.now() - start < 60000) await ui.waitForTimeout(500);
  check('filter lists load', await app.evaluate(() => global.__adblock.ready()), 'not ready after 60s');

  await go('https://www.cnn.com/');
  await ui.waitForTimeout(4000);
  const cnn = await blocked();
  check('blocks ad/tracker requests on a news site', cnn > 5, `blocked=${cnn}`);
  console.log(`      cnn.com: ${cnn} requests blocked`);

  // Typical anti-adblock probes: a bait element and a bait ad script.
  await go('https://example.com/');
  const probe = await js(`new Promise((resolve) => {
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner textads banner-ads';
    bait.style.cssText = 'width:1px;height:1px;position:absolute;left:-999px';
    document.body.appendChild(bait);
    const s = document.createElement('script');
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
    s.onload = () => setTimeout(() => resolve({ scriptLoaded: true, baitHidden: bait.offsetHeight === 0, sheets: [...document.styleSheets].length }), 500);
    s.onerror = () => resolve({ scriptLoaded: false, baitHidden: bait.offsetHeight === 0, sheets: [...document.styleSheets].length });
    document.head.appendChild(s);
  })`);
  console.log('      probe:', JSON.stringify(probe));
  check('bait element stays visible (bait-based detection sees no blocker)', !probe.baitHidden, JSON.stringify(probe));
  check('no stylesheets added to the page DOM (example.com has 1 of its own)', probe.sheets === 1, JSON.stringify(probe));
  check('ad script request was actually blocked', (await blocked()) > 0, 'nothing blocked');


  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
