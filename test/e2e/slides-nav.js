// The slide chooser in the slide viewer, in the real app (hidden Electron run: LUMEN_TEST_BACKGROUND=1, a profile of its own): a generated
// 40-slide deck opens in the viewer; the slide-number box jumps, the thumbnails panel is lazy and jumps, the keys move between slides
// (and are left alone in the number box), the address keeps #slide=N, and a deck opened at #slide=N lands on that slide.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const F = require('../helpers/_pptx-fixtures');

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000, every = 100) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-slides-nav-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile'); const docs = path.join(root, 'docs');
  for (const d of [work, profile, docs]) fs.mkdirSync(d);
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env, timeout: 60000 });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(2000);

    const COUNT = 40;
    const slides = Array.from({ length: COUNT }, (_, i) => ({ hidden: i === 4, shapes: F.rect({ box: { x: 100, y: 100, w: 600, h: 200 }, color: i % 2 ? 'FFCC00' : '99CCFF', text: `Title of slide ${i + 1}` }) }));
    const file = path.join(docs, 'forty.pptx');
    fs.writeFileSync(file, F.deck({ slides }));

    const win0 = async () => (await app.evaluate(() => global.__windows.list()))[0];
    const viewers = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((x) => /slides\.html/.test(x.getURL())).map((x) => x.id));
    const run = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, code]);
    const open = async (url) => {
      const known = await viewers();
      const w = await win0();
      await app.evaluate((_, [wid, u]) => { global.__windows.open(wid, u); }, [w.windowId, url]);
      const id = await waitFor(async () => (await viewers()).find((x) => !known.includes(x)), 20000);
      if (id) await waitFor(async () => (await run(id, 'document.body.dataset.ready')) === 'true', 30000);
      return id;
    };
    const key = (id, keyCode, modifiers = []) => app.evaluate(({ webContents }, [i, k, m]) => { const wc = webContents.fromId(i); wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m }); wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m }); }, [id, keyCode, modifiers]);
    const state = (id) => run(id, `(() => {
      const info = window.lumenSlidesInfo();
      const f = document.querySelectorAll('.frame')[info.current];
      return { current: info.current, box: document.getElementById('slideNumber').value, total: document.getElementById('slideCount').textContent,
        frameTop: Math.round(f.getBoundingClientRect().top), header: document.querySelector('header').offsetHeight, hash: location.hash,
        marked: [...document.querySelectorAll('.thumb[aria-current]')].map((b) => b.dataset.index), drawn: info.thumbsDrawn,
        thumbs: document.body.classList.contains('thumbs-open'), pressed: document.getElementById('thumbsBtn').getAttribute('aria-pressed') };
    })()`);
    let last = null;
    const settle = (id, n) => waitFor(async () => { last = await state(id); return last.current === n; }, 5000);
    const still = async (id) => { let prev = null; for (let k = 0; k < 60; k++) { const y = await run(id, "window.scrollY"); if (y === prev) return; prev = y; await sleep(250); } };
    const atTop = (s) => Math.abs(s.frameTop - (s.header + 14)) <= 6;
    const typeNumber = (id, text) => run(id, `(() => { const b = document.getElementById('slideNumber'); b.focus(); b.value = ${JSON.stringify(text)}; })()`);

    const id = await open(pathToFileURL(file).href);
    check('the 40-slide deck opens in the viewer', Boolean(id), id);
    if (!id) throw new Error('no viewer');
    // Scrolling is instant for most of this run (reduced motion, so a hidden window does not make the glide slow); the smooth glide has its own case below.
    const emulate = (features) => app.evaluate(({ webContents }, [i, f]) => { const wc = webContents.fromId(i); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); return wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: f }); }, [id, features]);
    await emulate([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    let s = await state(id);
    check('the number box shows 1 and the total reads / 40', s.box === '1' && s.total === '/ 40', JSON.stringify(s));
    check('the thumbnails panel starts closed and nothing in it is drawn', !s.thumbs && s.pressed === 'false' && s.drawn === 0, JSON.stringify(s));
    check('the controls have accessible names', await run(id, `['slideNumber', 'thumbsBtn', 'prev', 'next'].every((i) => document.getElementById(i).getAttribute('aria-label')) && document.getElementById('thumbs').getAttribute('aria-label') === 'Slide thumbnails'`));

    // ---- jump by number
    await typeNumber(id, '12');
    await key(id, 'Return');
    check('typing 12 and pressing Enter goes to slide 12', await settle(id, 11), JSON.stringify(last));
    await still(id);
    s = await state(id);
    check('slide 12 is scrolled to the top of the view', atTop(s), JSON.stringify(s));
    await sleep(500);
    s = await state(id);
    check('the box shows 12 and the address keeps #slide=12', s.box === '12' && s.hash === '#slide=12', JSON.stringify(s));
    await typeNumber(id, '999');
    await key(id, 'Return');
    check('a number past the end goes to the last slide (40)', await settle(id, 39), JSON.stringify(last));
    await typeNumber(id, 'abc');
    await key(id, 'Return');
    await sleep(300);
    s = await state(id);
    check('typing words keeps the slide and puts its number back in the box', s.current === 39 && s.box === '40', JSON.stringify(s));
    await run(id, 'document.getElementById("next").click(); 0');
    await sleep(200);
    check('Next at the last slide is disabled and does nothing', await run(id, 'document.getElementById("next").disabled && window.lumenSlidesInfo().current === 39'));
    await run(id, 'document.getElementById("prev").click(); 0');
    check('Previous goes back one (39)', await settle(id, 38), JSON.stringify(last));

    // ---- keys, and keys left alone in the number box
    await run(id, 'const b = document.getElementById("slideNumber"); b.focus(); for (const k of ["PageUp", "ArrowLeft", "Home", "ArrowUp"]) b.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); 0');
    await sleep(300);
    check('navigation keys typed inside the number box are left to the box (slide stays 39)', (await state(id)).current === 38);
    await run(id, 'document.getElementById("slideNumber").blur(); document.body.focus(); 0');
    await key(id, 'Home');
    check('Home goes to the first slide', await settle(id, 0), JSON.stringify(last));
    await key(id, 'PageDown');
    check('PageDown goes to slide 2', await settle(id, 1), JSON.stringify(last));
    await key(id, 'Right');
    check('ArrowRight goes to slide 3', await settle(id, 2), JSON.stringify(last));
    await key(id, 'Down');
    check('ArrowDown goes to slide 4', await settle(id, 3), JSON.stringify(last));
    await key(id, 'PageUp');
    check('PageUp goes back to slide 3', await settle(id, 2), JSON.stringify(last));
    await key(id, 'Left');
    check('ArrowLeft goes back to slide 2', await settle(id, 1), JSON.stringify(last));
    await key(id, 'End');
    check('End goes to the last slide', await settle(id, COUNT - 1), JSON.stringify(last));
    await key(id, 'PageDown');
    await sleep(300);
    check('PageDown on the last slide stays', (await state(id)).current === COUNT - 1);
    await key(id, 'Home');
    await settle(id, 0);

    // ---- thumbnails
    await key(id, 'F4');
    await waitFor(async () => (await state(id)).thumbs, 3000);
    await sleep(600);
    s = await state(id);
    check('F4 opens the thumbnails panel (button pressed)', s.thumbs && s.pressed === 'true', JSON.stringify(s));
    const count = await run(id, 'document.querySelectorAll(".thumb").length');
    check('there is one thumbnail per slide, numbered', count === COUNT && (await run(id, 'document.querySelectorAll(".thumb")[6].querySelector(".tnum").textContent')) === '7', count);
    check('only the thumbnails near the view are drawn (lazy)', s.drawn > 0 && s.drawn < COUNT, JSON.stringify(s));
    check('the current slide (1) is highlighted', s.marked.join() === '0', JSON.stringify(s));
    check('the hidden slide says so in its label', (await run(id, 'document.querySelectorAll(".thumb")[4].getAttribute("aria-label")')) === 'Slide 5 (hidden)');
    check('a thumbnail is the slide drawing scaled down, not a second renderer', await run(id, `(() => { const t = document.querySelector('.thumb .tslide .stage'); return Boolean(t) && /scale\\(0\\.\\d+\\)/.test(t.style.transform) && t.textContent.includes('Title of slide 1'); })()`));
    await run(id, 'document.querySelectorAll(".thumb")[1].click(); 0');
    check('clicking a thumbnail goes to that slide', await settle(id, 1), JSON.stringify(last));
    const before = (await state(id)).drawn;
    await run(id, 'document.getElementById("thumbs").scrollTop = document.getElementById("thumbs").scrollHeight; 0');
    await sleep(600);
    s = await state(id);
    check('scrolling the panel draws more thumbnails, still not all of them', s.drawn >= before && s.drawn < COUNT, JSON.stringify({ before, ...s }));
    await run(id, 'document.querySelectorAll(".thumb")[34].click(); 0');
    check('clicking a thumbnail far down goes to slide 35', await settle(id, 34), JSON.stringify(last));
    await still(id);
    s = await state(id);
    check('the main view scrolled to it and its thumbnail is highlighted', atTop(s) && s.marked.join() === '34', JSON.stringify(s));
    await run(id, 'window.scrollTo(0, 0); 0');
    await waitFor(async () => (await state(id)).current === 0, 5000);
    await sleep(600);
    s = await state(id);
    check('scrolling the slides back to the top moves the highlight and the box to slide 1', s.current === 0 && s.box === '1' && s.marked.join() === '0', JSON.stringify(s));
    check('the highlighted thumbnail is kept in view in the panel', await run(id, `(() => { const p = document.getElementById('thumbs').getBoundingClientRect(); const t = document.querySelector('.thumb.current').getBoundingClientRect(); return t.top >= p.top - 1 && t.bottom <= p.bottom + 1; })()`));
    const mainLeft = await run(id, 'document.getElementById("slides").getBoundingClientRect().left');
    check('the slides sit to the right of the panel', mainLeft >= 184, mainLeft);
    await key(id, 'F4');
    await waitFor(async () => !(await state(id)).thumbs, 3000);
    s = await state(id);
    check('F4 again closes the panel', !s.thumbs && s.pressed === 'false', JSON.stringify(s));

    // ---- the address keeps the slide, and reopening lands on it
    await key(id, 'End');
    await settle(id, COUNT - 1);
    await sleep(700);
    const href = await run(id, 'location.href');
    check('the address carries #slide=40', /#slide=40$/.test(href), href);
    check('changing the fragment did not reload the page', (await run(id, 'document.querySelectorAll(".frame").length')) === COUNT);
    const shown = await app.evaluate(({ webContents }, i) => webContents.fromId(i).getURL(), id);
    check('the main process sees the same address', /#slide=40$/.test(shown), shown);
    await app.evaluate(async ({ webContents }, [i, u]) => { const wc = webContents.fromId(i); await wc.loadURL('about:blank'); await wc.loadURL(u); }, [id, href.replace('#slide=40', '#slide=17')]);
    await waitFor(async () => (await run(id, 'document.body.dataset.ready')) === 'true' && (await state(id)).current === 16, 15000);
    await sleep(900);
    s = await state(id);
    check('loading the viewer address with #slide=17 lands on slide 17 (as a restored session does)', s.current === 16 && s.box === '17' && atTop(s), JSON.stringify(s));
    const drawn = await run(id, 'document.querySelectorAll("#slides .stage").length');
    check('the slides near it are drawn, not the whole deck', drawn > 0 && drawn < COUNT, drawn);

    const id2 = await open(pathToFileURL(file).href + '#slide=9');
    check('the deck opened at file.pptx#slide=9 gets a viewer', Boolean(id2), id2);
    if (id2) {
      await sleep(900);
      s = await state(id2);
      check('...and lands on slide 9', s.current === 8 && s.box === '9', JSON.stringify(s));
    }

    // ---- the smooth glide: slides asked for in quick succession end on the last one, and the scroll position does not pull the highlight back
    await emulate([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await key(id, 'Home');
    await settle(id, 0);
    await still(id);
    await key(id, 'PageDown'); await key(id, 'PageDown'); await key(id, 'PageDown');
    await settle(id, 3);
    await still(id);
    await sleep(800);
    s = await state(id);
    check('three quick PageDowns during the glide end on slide 4, with slide 4 at the top', s.current === 3 && s.box === '4' && atTop(s), JSON.stringify(s));
    await key(id, 'End');
    await settle(id, COUNT - 1);
    await still(id);
    await sleep(600);
    check('End glides to the last slide and stays there (the last slides cannot reach the top)', (await state(id)).current === COUNT - 1);

    // ---- light and dark
    for (const scheme of ['light', 'dark']) {
      await app.evaluate(({ webContents }, [i, sc]) => { const wc = webContents.fromId(i); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); return wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: sc }] }); }, [id, scheme]);
      await sleep(500);
      await run(id, 'document.getElementById("thumbsBtn").click(); 0');
      await sleep(400);
      const c = await run(id, `(() => { const cs = (e) => getComputedStyle(e); return { bg: cs(document.getElementById('thumbs')).backgroundColor, text: cs(document.getElementById('slideNumber')).color, open: document.body.classList.contains('thumbs-open') }; })()`);
      const lum = (rgb) => { const v = (rgb.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number); return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255; };
      check(`${scheme}: the panel and the number box use the theme (${c.bg}, ${c.text})`, c.open && (scheme === 'dark' ? lum(c.bg) < 0.3 && lum(c.text) > 0.6 : lum(c.bg) > 0.7 && lum(c.text) < 0.4), JSON.stringify(c));
      await run(id, 'document.getElementById("thumbsBtn").click(); 0');
    }
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
