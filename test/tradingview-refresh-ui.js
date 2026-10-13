// The TradingView card's Reload button on the new-tab page, in a real window (off-screen, throwaway profile) against a stand-in for
// TradingView's embed served from https://127.0.0.1 (the page's test-only __tvTestOrigin swaps the origin; tradingview.com is never
// reached): the button is there with the right name and tooltip, a press loads the frame again (the stand-in sees one more request) and
// the card keeps its symbols, a double click is one reload, and an embed that never answers shows the card's Couldn't reload note with
// Try again, which loads it. (The unit side is test/tradingview-units.js.)
'use strict';
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tv-refresh-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the browser checks: openssl isn't available (${err.message})`);
    process.exit(0);
  }
  const srv = { loads: 0, hang: false, open: [] };
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    if (!/^\/(widgetembed|embed-widget)\//.test(u.pathname)) { res.writeHead(404); res.end(); return; }
    srv.loads++;
    if (srv.hang) { srv.open.push(res); return; } // never answers
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>stand-in TradingView</title><p>stand-in</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;
  const baseRe = base.replace(/[.]/g, '\\\\.').replace(/\//g, '\\\\/');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-tv-refresh-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    // The home page first, with the stand-in's origin set, then the widgets: the cards are drawn from the stand-in's address.
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__homeTab = t; });
    const inTab = (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js);
    const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await inTab(code).catch(() => false)) return true; await sleep(100); } return false; };
    await inTab(`globalThis.__tvTestOrigin = ${JSON.stringify(base)}; globalThis.__tvTestStallMs = 1500; true`);
    const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
    const saved = await W('save', { type: 'tradingview', tv: { view: 'chart', symbol: 'NASDAQ:AAPL', interval: '60', theme: 'dark' } });
    const id = saved.widget.id;
    const card = `document.querySelector('.w-card[data-id="${id}"]')`;
    const btn = `${card}?.querySelector('.w-reload')`;
    const frameSrc = () => inTab(`${card}?.querySelector('iframe.w-frame')?.src || ''`);
    const idle = `(() => { const b = ${btn}; return Boolean(b) && !b.disabled && !b.classList.contains('spinning'); })()`;
    const symbolIn = (u) => { try { const x = new URL(u); return decodeURIComponent(x.search + x.hash).includes('AAPL'); } catch { return false; } };

    check('the card loads its frame from the stand-in (not tradingview.com)', await waitFor(`new RegExp('^${baseRe}').test(${card}?.querySelector('iframe.w-frame')?.src || '')`) && await (async () => { for (let i = 0; i < 50 && srv.loads < 1; i++) await sleep(100); return srv.loads >= 1; })(), await frameSrc());
    await sleep(800);
    const before = await frameSrc();
    check('the frame carries the configured symbol', symbolIn(before), before);
    check('a Reload button is there, named for the symbol, with the tooltip Reload, on and not turning', await inTab(`(() => { const b = ${btn}; return Boolean(b) && b.tagName === 'BUTTON' && b.type === 'button' && b.title === 'Reload' && b.getAttribute('aria-label') === 'Reload NASDAQ:AAPL' && Boolean(b.querySelector('svg')); })()`) && await inTab(idle), await inTab(`${btn}?.outerHTML`));
    check('...it is a real button in the card head with the other icon buttons, so the keyboard can reach and press it', await inTab(`(() => { const b = ${btn}; b.focus(); return b.parentElement === ${card}.querySelector('.w-head') && b.classList.contains('w-icon-btn') && document.activeElement === b && b.tabIndex >= 0; })()`), '');

    // 1. one press: one more request, the same address, the button back on
    const n0 = srv.loads;
    await inTab(`${btn}.click()`);
    check('a press loads the frame again: the stand-in sees one more request', await (async () => { for (let i = 0; i < 50 && srv.loads === n0; i++) await sleep(100); await sleep(600); return srv.loads === n0 + 1; })(), String(srv.loads - n0));
    check('...the button is back on when it has loaded', await waitFor(idle), await inTab(`${btn}?.outerHTML`));
    check('...and the frame has the same address, so the symbol and interval are kept', (await frameSrc()) === before, `${before} -> ${await frameSrc()}`);

    // 2. a double click is one reload
    const n2 = srv.loads;
    await inTab(`${btn}.click(); ${btn}.click(); ${btn}.dispatchEvent(new MouseEvent('click', { bubbles: true }));`);
    await sleep(1500);
    check('a double click reloads once', srv.loads === n2 + 1, String(srv.loads - n2));
    check('...and the button is back on', await waitFor(idle), await inTab(`${btn}?.outerHTML`));

    // 3. a watchlist keeps its symbols through a reload
    const list = await W('save', { type: 'tradingview', tv: { view: 'watchlist', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'], theme: 'dark' } });
    const lcard = `document.querySelector('.w-card[data-id="${list.widget.id}"]')`;
    const lsrc = () => inTab(`${lcard}?.querySelector('iframe.w-frame')?.src || ''`);
    check('a watchlist card loads from the stand-in too', await waitFor(`new RegExp('^${baseRe}').test(${lcard}?.querySelector('iframe.w-frame')?.src || '')`), await lsrc());
    await sleep(800);
    const lbefore = await lsrc();
    const n3 = srv.loads;
    await inTab(`${lcard}.querySelector('.w-reload').click()`);
    await sleep(1500);
    const lafter = await lsrc();
    const both = (u) => { try { const t = decodeURIComponent(new URL(u).hash); return t.includes('NASDAQ:AAPL') && t.includes('NASDAQ:MSFT'); } catch { return false; } };
    check('a watchlist reload loads once and keeps its symbols', srv.loads === n3 + 1 && both(lafter) && lafter === lbefore, `${srv.loads - n3} ${lafter}`);

    // 4. an embed that never answers: Couldn't reload with Try again; Try again loads it
    await waitFor(idle);
    srv.hang = true;
    await inTab(`${btn}.click()`);
    check('while TradingView does not answer the button turns and is off', await waitFor(`(() => { const b = ${btn}; return Boolean(b) && b.disabled && b.classList.contains('spinning') && b.getAttribute('aria-busy') === 'true'; })()`), await inTab(`${btn}?.outerHTML`));
    check('...then the card shows Couldn’t reload with Try again and the button is back on', await waitFor(`/Couldn’t reload/.test(${card}?.textContent || '') && Boolean(${card}.querySelector('.w-retry')) && !${btn}.disabled`, 60), await inTab(`${card}?.textContent`));
    srv.hang = false;
    for (const r of srv.open.splice(0)) { try { r.end(); } catch { /* gone */ } }
    const n5 = srv.loads;
    await inTab(`${card}.querySelector('.w-retry').click()`);
    check('Try again loads the frame and clears the note', await waitFor(`!/Couldn’t reload/.test(${card}?.textContent || '') && !${card}.querySelector('.w-retry') && ${card}.querySelector('.tv-fit')?.hidden === false`, 60) && await (async () => { for (let i = 0; i < 50 && srv.loads === n5; i++) await sleep(100); return srv.loads > n5; })() && symbolIn(await frameSrc()), `${await inTab(`[${card}?.querySelector('.tv-fit')?.hidden, !!${card}?.querySelector('.w-retry'), ${card}?.querySelector('iframe.w-frame')?.src]`)} loads ${srv.loads - n5}`);
    check('...and the button is on again', await waitFor(idle, 60), await inTab(`${btn}?.outerHTML`));
  } finally {
    await app.close().catch(() => {});
    server.close();
    for (const r of srv.open) { try { r.destroy(); } catch { /* gone */ } }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
