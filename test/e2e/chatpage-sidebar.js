// lumen://chat: hiding and showing the sidebar of chats and projects (renderer/chat-page.*), so the conversation takes the
// whole width. Covers: the Hide button in the sidebar and the Show button (with New chat beside it) in the header, Ctrl+B
// from main (any focus) and from the page, Ctrl+Shift+S still working, a slide that animates, a full-width conversation
// that stays a centred column, the choice kept across a restart (the page starts hidden, with no slide), and Settings →
// Reduce motion turning the slide off. Runs in the background (LUMEN_TEST_BACKGROUND): no window shows or takes focus.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..', '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chatpage-sidebar-'));

  let app = await launch(profile);
  let ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  const tabs = () => app.evaluate(() => global.__chatPage.tabs());
  const chatTab = async () => (await tabs()).find((t) => t.chat && /chat-page\.html$/.test(t.url));
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  const geo = (sel) => inPage(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, r: r.right, vw: innerWidth }; })()`);
  const isHidden = () => inPage("document.body.classList.contains('cp-rail-hidden')");
  const booted = () => waitFor(async () => (await inPage("document.readyState === 'complete' && !document.body.classList.contains('cp-booting')")) === true, 15000);
  const railOut = () => waitFor(async () => { const r = await geo('#cp-rail'); return r && r.r <= 1 ? r : null; });
  const railIn = () => waitFor(async () => { const r = await geo('#cp-rail'); return r && r.x === 0 && r.w > 240 ? r : null; });
  const longest = (durations) => Math.max(...String(durations).split(',').map((d) => (/ms$/.test(d.trim()) ? parseFloat(d) / 1000 : parseFloat(d)) || 0)); // seconds
  const shortcut = (input) => app.evaluate((_e, i) => global.__pageTools.handleShortcut(i), input);

  await app.evaluate(() => global.__chatPage.open());
  await waitFor(chatTab, 15000);
  await booted();
  // a wide window, so the sidebar is a rail beside the conversation rather than the narrow window's drawer
  await (await app.browserWindow(ui)).evaluate((w) => w.setBounds({ width: 1400, height: 900 }));
  await waitFor(async () => (await inPage('innerWidth')) >= 1000);

  // ---- 1. Open by default, with a clear Hide button
  check('the sidebar starts open on a wide window', Boolean(await railIn()) && (await isHidden()) === false, JSON.stringify(await geo('#cp-rail')));
  const close = await inPage("(() => { const b = document.getElementById('cp-rail-close'); return { label: b.getAttribute('aria-label'), title: b.title, expanded: b.getAttribute('aria-expanded') }; })()");
  check('its Hide button is named "Hide sidebar" and shows Ctrl+B', close.label === 'Hide sidebar' && /Ctrl\+B/.test(close.title) && close.expanded === 'true', JSON.stringify(close));
  check('the sidebar top no longer carries a Full screen button (the header keeps the one)', await inPage("!document.querySelector('#cp-rail .cp-full-btn') && Boolean(document.getElementById('cp-fullscreen'))") === true, '');
  check('the Show and New chat buttons are out of the header while it is open', await inPage("document.getElementById('cp-rail-open').hidden && document.getElementById('cp-rail-new').hidden") === true, '');
  const slide = await inPage("getComputedStyle(document.getElementById('cp-rail')).transitionDuration");
  check('hiding and showing slide (the rail has a transition of 0.1s or more)', longest(slide) >= 0.1, String(slide));

  // ---- 2. The button hides it, and the conversation takes the whole width
  await inPage("document.getElementById('cp-rail-close').click()");
  const out = await railOut();
  check('the Hide button slides the sidebar out', Boolean(out) && (await isHidden()) === true && await inPage("document.getElementById('cp-rail').inert") === true, JSON.stringify(await geo('#cp-rail')));
  const main = await waitFor(async () => { const g = await geo('#chat-root'); return g && g.x < 2 && g.w > g.vw - 4 ? g : null; });
  check('the conversation takes the whole width', Boolean(main), JSON.stringify(await geo('#chat-root')));
  const col = await inPage("(() => { const c = document.getElementById('composer').getBoundingClientRect(); const m = document.getElementById('chat-root').getBoundingClientRect(); return { w: c.width, mid: (c.left + c.right) / 2, mainMid: (m.left + m.right) / 2 }; })()");
  check('and still reads as a centred column of at most 768px', col.w <= 769 && col.w > 300 && Math.abs(col.mid - col.mainMid) < 3, JSON.stringify(col));
  const shown = await inPage("(() => { const o = document.getElementById('cp-rail-open'); const n = document.getElementById('cp-rail-new'); return { open: !o.hidden, label: o.getAttribute('aria-label'), title: o.title, expanded: o.getAttribute('aria-expanded'), newChat: !n.hidden && n.getAttribute('aria-label') === 'New chat', x: o.getBoundingClientRect().x }; })()");
  check('a Show sidebar button (Ctrl+B) and New chat take its place at the header start', shown.open && shown.label === 'Show sidebar' && /Ctrl\+B/.test(shown.title) && shown.expanded === 'false' && shown.newChat && shown.x < 60, JSON.stringify(shown));
  check('the choice is saved', await inPage("localStorage.getItem('lumen.chatpage.rail')") === 'collapsed', await inPage("localStorage.getItem('lumen.chatpage.rail')"));

  // ---- 3. The Show button brings it back
  await inPage("document.getElementById('cp-rail-open').click()");
  check('the Show button slides it back', Boolean(await railIn()) && (await isHidden()) === false && await inPage("document.getElementById('cp-rail-open').hidden && !document.getElementById('cp-rail').inert") === true, JSON.stringify(await geo('#cp-rail')));
  check('and saves that too', await inPage("localStorage.getItem('lumen.chatpage.rail')") === 'open', await inPage("localStorage.getItem('lumen.chatpage.rail')"));

  // ---- 4. Keys: Ctrl+B from main (whatever has focus), Ctrl+B in the page, Ctrl+Shift+S still
  await shortcut({ key: 'b', control: true });
  check('Ctrl+B hides it (main hands the key to the page)', Boolean(await railOut()) && (await isHidden()) === true, JSON.stringify(await geo('#cp-rail')));
  await shortcut({ key: 'b', control: true });
  check('Ctrl+B again shows it', Boolean(await railIn()) && (await isHidden()) === false, JSON.stringify(await geo('#cp-rail')));
  await inPage("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true }))");
  check('Ctrl+B pressed in the page hides it', Boolean(await railOut()) && (await isHidden()) === true, JSON.stringify(await geo('#cp-rail')));
  await shortcut({ key: 'S', control: true, shift: true });
  check('Ctrl+Shift+S still shows it', Boolean(await railIn()) && (await isHidden()) === false, JSON.stringify(await geo('#cp-rail')));

  // ---- 5. Remembered across a restart, and the page starts hidden with no slide
  await inPage("document.getElementById('cp-rail-close').click()");
  await railOut();
  await sleep(3500); // the session (with the chat tab) is saved a moment after tabs change
  await app.close();
  app = await launch(profile);
  ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  if (!(await waitFor(chatTab, 10000))) await app.evaluate(() => global.__chatPage.open());
  await waitFor(chatTab, 15000);
  const first = await waitFor(async () => { const r = await inPage("(() => { if (document.readyState !== 'complete') return null; const r = document.getElementById('cp-rail').getBoundingClientRect(); return { hidden: document.body.classList.contains('cp-rail-hidden'), right: r.right, booting: document.body.classList.contains('cp-booting') }; })()"); return r && typeof r === 'object' ? r : null; }, 15000);
  check('after a restart the sidebar is still hidden', Boolean(first) && first.hidden === true, JSON.stringify(first));
  check('from the first look, with no slide out (it starts where it was left)', Boolean(first) && first.right <= 1, JSON.stringify(first));
  await booted();
  check('and the Show button is there to bring it back', await inPage("!document.getElementById('cp-rail-open').hidden") === true, '');
  await inPage("document.getElementById('cp-rail-open').click()");
  await railIn();
  await inPage('location.reload()');
  await sleep(500);
  await booted();
  check('shown again, it stays shown on the next load', Boolean(await railIn()) && (await isHidden()) === false, JSON.stringify(await geo('#cp-rail')));

  // ---- 6. Settings → Reduce motion: hidden and shown at once
  await app.evaluate(() => global.__settings.backend.set('reduceMotion', true));
  const calm = await waitFor(async () => (await inPage("document.documentElement.classList.contains('pref-reduce-motion')")) === true);
  const calmSlide = await inPage("getComputedStyle(document.getElementById('cp-rail')).transitionDuration");
  check('with Reduce motion on, the sidebar has no slide', Boolean(calm) && longest(calmSlide) < 0.001, `${calm} ${calmSlide}`);
  await inPage("document.getElementById('cp-rail-close').click()");
  const atOnce = await inPage("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.getElementById('cp-rail').getBoundingClientRect().right))))");
  check('and hides it at once', Number(atOnce) <= 1, String(atOnce));
  await app.evaluate(() => global.__settings.backend.set('reduceMotion', false));

  await app.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll chat page sidebar checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
