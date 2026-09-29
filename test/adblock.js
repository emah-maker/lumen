// Built-in ad blocker: blocks ads on real pages, and pages don't see it (bait elements, failed ad
// requests, missing ad libraries, late scriptlets, globals).
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--host-resolver-rules=MAP probe.lumen-test.org 127.0.0.1'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
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
  // Cosmetic rules go in as user-origin CSS, so no page-visible stylesheet may mention the bait classes.
  // (Counting sheets doesn't work: example.com's own script adds a <style> of its own.)
  const probe = await js(`new Promise((resolve) => {
    const cosmetic = () => [...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((r) => /adsbox|ad-banner|textads|banner-ads/.test(r.cssText)); } catch { return false; } });
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner textads banner-ads';
    bait.style.cssText = 'width:1px;height:1px;position:absolute;left:-999px';
    document.body.appendChild(bait);
    const s = document.createElement('script');
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
    s.onload = () => setTimeout(() => resolve({ scriptLoaded: true, baitHidden: bait.offsetHeight === 0, sheets: [...document.styleSheets].length, cosmetic: cosmetic() }), 500);
    s.onerror = () => resolve({ scriptLoaded: false, baitHidden: bait.offsetHeight === 0, sheets: [...document.styleSheets].length, cosmetic: cosmetic() });
    document.head.appendChild(s);
  })`);
  console.log('      probe:', JSON.stringify(probe));
  check('bait element stays visible (bait-based detection sees no blocker)', !probe.baitHidden, JSON.stringify(probe));
  check('no ad-hiding stylesheet visible to the page', !probe.cosmetic, JSON.stringify(probe));
  check('ad script request was actually blocked', (await blocked()) > 0, 'nothing blocked');

  // Network probes: blocked requests get stand-ins, so "did it load?" checks see them load.
  const net = await js(`(async () => {
    const load = (tag, src) => new Promise((res) => { const e = document.createElement(tag); e.src = src; e.onload = () => res('load'); e.onerror = () => res('error'); (tag === 'script' ? document.head : document.body).appendChild(e); setTimeout(() => res('timeout'), 5000); });
    const out = {};
    out.adsbygoogle = typeof window.adsbygoogle?.push; // loaded above
    out.gpt = await load('script', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js');
    out.gptCmd = await new Promise((res) => { window.googletag.cmd.push(() => res('ran')); setTimeout(() => res('never'), 1500); });
    out.img = await load('img', 'https://ad.doubleclick.net/ddm/ad/pixel.gif');
    out.fetch = await fetch('https://pagead2.googlesyndication.com/pagead/show_ads.js', { mode: 'no-cors' }).then(() => 'ok', () => 'reject');
    out.cors = await fetch('https://googleads.g.doubleclick.net/pagead/id', { credentials: 'include' }).then((r) => 'ok', () => 'reject');
    out.xhr = await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'); x.onload = () => res('load'); x.onerror = () => res('error'); x.send(); });
    out.globals = Object.keys(window).filter((k) => /ghostery|adblock|cliqz/i.test(k));
    return out;
  })()`);
  console.log('      stand-ins:', JSON.stringify(net));
  check('bait ad script loads (a stand-in) and defines adsbygoogle.push', probe.scriptLoaded && net.adsbygoogle === 'function', JSON.stringify({ probe, net }));
  check('gpt.js loads and googletag.cmd callbacks run', net.gpt === 'load' && net.gptCmd === 'ran', JSON.stringify(net));
  check('blocked image, fetch, CORS fetch and XHR succeed quietly', net.img === 'load' && net.fetch === 'ok' && net.cors === 'ok' && net.xhr === 'load', JSON.stringify(net));
  check('no blocker globals on window', !net.globals.length, JSON.stringify(net.globals));

  // Scriptlets run before the page's first script (anti-adblock code runs early).
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    // A strict policy that allows the ad host but not the stand-in scheme: the stand-in must still load.
    if (req.url === '/csp') res.setHeader('Content-Security-Policy', "script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com; img-src 'self' https://ad.doubleclick.net");
    res.end('<!doctype html><head><script>window.__early = String(window.lumenProbe); try { window.__toString = typeof String(setTimeout); } catch (e) { window.__toString = String(e); }</script></head><body>hi</body>');
  }).listen(0);
  // Two scriptlets sharing a helper (proxyApplyFn), as YouTube's rules do: run at one global scope,
  // the second wrapped toString around the first and every call overflowed the stack.
  await app.evaluate(() => global.__adblockEngine.updateFromDiff({ added: ['lumen-test.org##+js(set-constant, lumenProbe, 42)', 'lumen-test.org##+js(json-prune, lumenAdA)', 'lumen-test.org##+js(json-prune, lumenAdB)'] }));
  await go(`http://probe.lumen-test.org:${server.address().port}/`);
  await ui.waitForTimeout(500);
  check('scriptlets run before the page’s own first script', (await js('window.__early')) === '42', await js('window.__early'));
  check('scriptlets sharing helpers leave toString working', (await js('window.__toString')) === 'string', await js('window.__toString'));
  check('scriptlet helpers stay off window', !(await js(`['safeSelf', 'proxyApplyFn', 'scriptletGlobals'].filter((k) => k in window).length`)), 'helpers on window');
  await go(`http://probe.lumen-test.org:${server.address().port}/csp`);
  const csp = await js(`Promise.all([['script', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'], ['img', 'https://ad.doubleclick.net/ddm/ad/pixel.gif']].map(([tag, src]) => new Promise((res) => { const e = document.createElement(tag); e.src = src; e.onload = () => res('load'); e.onerror = () => res('error'); document.body.appendChild(e); setTimeout(() => res('timeout'), 5000); })))`);
  check('stand-ins load on a page with a strict Content-Security-Policy', csp.every((r) => r === 'load'), JSON.stringify(csp));
  server.close();


  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
