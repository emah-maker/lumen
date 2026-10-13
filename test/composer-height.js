// The chat box (the composer's text input) is exactly as tall as its text, in the sidebar and on the lumen://chat page: one line when
// empty, back to one line after typing five lines and clearing, the right height for a draft restored while the box was hidden or
// narrow and then shown wide, fitting again after a wide -> narrow -> wide resize, never taller than the cap, and scrolling past it.
// Hidden window (LUMEN_TEST_BACKGROUND=1), no network. LUMEN_COMPOSER_SHOTS=<dir> saves a screenshot of the tricky states.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// Runs inside each page. Every step is measured after two animation frames, the way a user would see it. A step may set the
// value without any event (the draft restore, the queue-to-draft path), with an 'input' event, or while the composer is hidden.
const IN_PAGE = `(async () => {
  const prompt = document.getElementById('prompt');
  const composer = document.getElementById('composer');
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const h = () => Math.round(prompt.getBoundingClientRect().height * 10) / 10;
  const wide = () => composer.style.removeProperty('width');
  const narrow = (px) => composer.style.setProperty('width', px + 'px', 'important');
  const set = (v, input = true) => { prompt.value = v; if (input) prompt.dispatchEvent(new Event('input', { bubbles: true })); };
  const out = { vh: innerHeight };
  prompt.focus();
  set(''); await frames();
  out.empty = h();
  set('x'); await frames();
  out.one = h();
  set('x\\nx'); await frames();
  out.two = h();
  out.line = Math.round((out.two - out.one) * 10) / 10;
  set(''); await frames();
  out.emptyAgain = h();
  // five lines typed, then cleared (by an input event, and by a bare value change)
  set('a\\nb\\nc\\nd\\ne'); await frames(); out.five = h();
  set(''); await frames(); out.afterClear = h();
  set('a\\nb\\nc\\nd\\ne', false); await frames();
  set('', false); await frames(); out.afterBareClear = h();
  // a two-line draft restored while the composer is hidden and narrow, then shown wide
  narrow(90); composer.style.display = 'none';
  set('first line of a draft\\nsecond line of a draft'); await frames();
  composer.style.display = ''; wide(); await frames(); await frames();
  out.restored = h();
  set(''); await frames();
  // the same, without an event at all
  narrow(90); composer.style.display = 'none';
  set('first line of a draft\\nsecond line of a draft', false); await frames();
  composer.style.display = ''; wide(); await frames(); await frames();
  out.restoredBare = h();
  set(''); await frames();
  // wide -> narrow -> wide
  const para = 'short text wraps when narrow';
  set(para); await frames(); out.paraWide = h();
  narrow(150); await frames(); await frames(); out.paraNarrow = h();
  wide(); await frames(); await frames(); out.paraWideAgain = h();
  // typed while narrow (it wraps), then widened: the extra rows must go
  narrow(150); set(para); await frames(); await frames(); out.setNarrow = h();
  wide(); await frames(); await frames(); out.setNarrowThenWide = h();
  set(''); await frames();
  // an empty box (with its placeholder) narrow, and wide again
  narrow(120); await frames(); await frames(); out.emptyNarrow = h();
  wide(); await frames(); await frames(); out.emptyWideAgain = h();
  // the cap
  set(Array.from({ length: 120 }, (_, i) => 'line ' + i).join('\\n')); await frames();
  out.max = h();
  out.scrolls = prompt.scrollHeight > prompt.clientHeight + 1 && getComputedStyle(prompt).overflowY !== 'hidden';
  prompt.scrollTop = prompt.scrollHeight; await frames();
  out.scrolledTo = prompt.scrollTop;
  set(''); await frames();
  out.final = h();
  return out;
})()`;
// A draft restored into a narrow composer, which is then widened: the state that used to leave the box too tall.
const DRAFT = `(() => { const p = document.getElementById('prompt'); const c = document.getElementById('composer'); c.style.setProperty('width', '90px', 'important'); p.value = 'first line of a draft\\nsecond line of a draft'; p.dispatchEvent(new Event('input', { bubbles: true })); c.style.removeProperty('width'); })()`;
const CLEAR = `(() => { const p = document.getElementById('prompt'); p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); })()`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const shots = process.env.LUMEN_COMPOSER_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-composer-height-'));
  const env = { ...process.env, LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#prompt', { state: 'visible' });
    await sleep(500);

    const verify = (name, r) => {
      const near = (a, b) => Math.abs(a - b) <= 1.5;
      check(`${name}: an empty box is one line (as tall as a box with one line in it)`, r && near(r.empty, r.one) && r.two > r.one + 8, JSON.stringify(r));
      check(`${name}: it is one line again after the text is cleared`, r && near(r.emptyAgain, r.one), JSON.stringify(r));
      check(`${name}: five lines typed, then cleared, goes back to one line (by event and by a bare value change)`, r && r.five > r.one + 3 * r.line && near(r.afterClear, r.one) && near(r.afterBareClear, r.one), JSON.stringify(r));
      check(`${name}: a 2-line draft restored while hidden and narrow is 2 lines once shown wide (event or none)`, r && near(r.restored, r.two) && near(r.restoredBare, r.two), JSON.stringify(r));
      check(`${name}: wide -> narrow -> wide fits again (taller narrow, one line wide)`, r && near(r.paraWide, r.one) && r.paraNarrow > r.paraWide + 8 && near(r.paraWideAgain, r.one) && r.setNarrow > r.one + 8 && near(r.setNarrowThenWide, r.one), JSON.stringify(r));
      check(`${name}: an empty box stays one line when narrow (a long placeholder does not wrap) and when wide again`, r && near(r.emptyNarrow, r.one) && near(r.emptyWideAgain, r.one), JSON.stringify(r));
      check(`${name}: a long text stops at the cap (40% of the window, at most 320px) and scrolls`, r && r.max <= 0.4 * r.vh + 1.5 && r.max <= 321 && r.max > r.two && r.scrolls && r.scrolledTo > 0, JSON.stringify(r));
      check(`${name}: it ends one line tall`, r && near(r.final, r.one), JSON.stringify(r));
    };
    const save = (name, buf) => { if (shots) try { fs.writeFileSync(path.join(shots, `${name}.png`), buf); } catch { /* a look only */ } };

    // ---- the sidebar's composer
    verify('sidebar', await ui.evaluate(IN_PAGE));
    await ui.evaluate(DRAFT);
    await sleep(300);
    if (shots) save('sidebar-draft-after-narrow', await ui.screenshot());
    await ui.evaluate(CLEAR);

    // ---- the full page
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const chat = await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs())).find((t) => t.chat && /chat-page\.html$/.test(t.url)));
    check('the chat page opens', Boolean(chat), 'no chat tab');
    if (chat) {
      await sleep(800);
      const inPage = (code) => app.evaluate(async (_e, [id, c]) => global.__chatPage.contents(id).executeJavaScript(c, true), [chat.id, code]);
      verify('chat page', await inPage(IN_PAGE));
      await inPage(DRAFT);
      await sleep(300);
      if (shots) save('page-draft-after-narrow', Buffer.from(await app.evaluate(async (_e, id) => (await global.__chatPage.contents(id).capturePage()).toPNG().toString('base64'), chat.id), 'base64'));
    }
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
