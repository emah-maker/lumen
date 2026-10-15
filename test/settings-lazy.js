// [settings speed] Settings builds only the page it shows first and the rest while idle. Everything that reaches a page that may not be built
// yet must still work, in a hidden app:
//   - every link lumen://settings#<section> that settings-backend accepts (SECTION_LINKS: the sections, their old names and the sub-pages) opens
//     the page it names, with its rows built and no empty list on screen, on a Settings page opened fresh (the first route is the lazy one)
//   - search finds a row of a page that is not built yet, and Ctrl+F / "/" focuses the search box and has everything built
//   - the open widget form's unsaved-changes guard is in place when Home > Widgets opens from a link
//   - no frame shows an empty list (a list is only on screen once it has a row), while the page opens and while it fills in
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { SECTION_LINKS } = require('../src/settings/settings-backend');
const { tmpProfile, env, root, sleep } = require('./_settings-open-rig');

// Runs from dom-ready in the Settings page: samples every frame for a list on screen with nothing in it.
const SAMPLER = `(() => {
  if (window.__empty) return;
  window.__empty = { frames: 0, worst: 0, what: '' };
  const tick = () => {
    window.__empty.frames++;
    for (const c of document.querySelectorAll('.pane:not([hidden]) .card')) {
      if (c.offsetParent !== null && c.children.length === 0) { window.__empty.worst++; window.__empty.what = c.parentElement?.dataset?.title || c.className; }
    }
    if (window.__empty.frames < 240) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const app = await electron.launch({ args: [root], env: env(tmpProfile()) });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(2500);
    await app.evaluate(({ app: electronApp }, code) => {
      global.__samplerCode = code;
      electronApp.on('web-contents-created', (_e, wc) => wc.on('dom-ready', () => { if (/settings\.html/.test(wc.getURL())) wc.executeJavaScript(global.__samplerCode, true).catch(() => {}); }));
    }, SAMPLER);

    const run = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [id, code]);
    const waitIn = async (id, code, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await run(id, code)) === true) return true; await sleep(40); } return false; };
    const closeSettings = async (id) => {
      await app.evaluate((_e, i) => global.__closeTabInteractive(i), id);
      for (let i = 0; i < 100 && (await app.evaluate(() => global.__settings.tabs().length)) > 0; i++) await sleep(50);
    };

    // ---- every link, opened fresh
    const bad = [];
    for (const alias of SECTION_LINKS) {
      const id = await app.evaluate((_e, s) => global.__settings.open(s), alias);
      const shown = await waitIn(id, 'document.body?.dataset.shown === "1"');
      const verdict = shown ? await run(id, `(() => {
        const id = location.hash.slice(1);
        let cat = null; let sub = null;
        if (slots.get(id)?.isSub) { cat = slots.get(id).cat; sub = id; } else if (categories.has(id)) cat = id; else if (ALIASES[id]) { cat = ALIASES[id].cat; sub = ALIASES[id].sub || null; }
        if (!cat) return 'unknown section ' + id;
        if (view.cat !== cat || (view.sub || null) !== sub) return 'shows ' + view.cat + '/' + view.sub + ', wanted ' + cat + '/' + sub;
        const pane = sub ? slots.get(sub)?.pane : categories.get(cat).pane;
        if (!pane || pane.hidden) return 'its page is not shown';
        if (!pane.querySelector('.row')) return 'its page has no rows';
        if (!/Settings/.test(document.title)) return 'title ' + document.title;
        return 'ok';
      })()`) : 'never shown';
      if (verdict !== 'ok') bad.push(`${alias}: ${verdict}`);
      await closeSettings(id);
    }
    check(`all ${SECTION_LINKS.length} section links open the page they name, built, on a fresh Settings page`, bad.length === 0, bad.join(' | '));

    // ---- no empty list on screen at any frame while opening (the default page, then a deep link)
    for (const section of ['', 'ai', 'privacy']) {
      const id = await app.evaluate((_e, s) => global.__settings.open(s), section);
      await waitIn(id, 'document.body?.dataset.ready === "1"');
      await sleep(400);
      const e = await run(id, 'JSON.stringify(window.__empty || null)');
      const o = e && !String(e).startsWith('ERROR') ? JSON.parse(e) : null;
      check(`no frame shows an empty list while "${section || 'default'}" opens and fills in (${o?.frames} frames)`, Boolean(o) && o.frames > 3 && o.worst === 0, e);
      await closeSettings(id);
    }

    // ---- search against rows that are not built yet
    {
      const id = await app.evaluate((_e, s) => global.__settings.open(s), '');
      await waitIn(id, 'document.body?.dataset.shown === "1"');
      const early = await run(id, 'document.body.dataset.ready !== "1"'); // (the Advanced > Network rows are not built yet, as a user typing at once would find it)
      await run(id, `(() => { const s = document.getElementById('search'); s.value = 'proxy'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const found = await waitIn(id, `document.body.classList.contains('searching') && [...document.querySelectorAll('.row')].some((r) => !r.classList.contains('filtered') && r.offsetParent !== null && /proxy/i.test(r.textContent)) && document.getElementById('no-results').hidden`);
      check(`search finds a row from a page that is not built yet ("proxy"${early ? ', typed before the rest was built' : ''})`, found, 'no proxy row');
      await run(id, `(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      check('...and clearing the search brings the page back', await waitIn(id, `!document.body.classList.contains('searching') && !document.querySelector('.pane:not([hidden]) .row.filtered')`), 'still filtered');
      await closeSettings(id);
    }

    // ---- Ctrl+F and "/" while pages are not built yet
    {
      const id = await app.evaluate((_e, s) => global.__settings.open(s), '');
      await waitIn(id, 'document.body?.dataset.shown === "1"');
      await app.evaluate((_e, i) => { const wc = global.__settings.contents(i); wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['control'] }); }, id);
      check('Ctrl+F focuses the search box', await waitIn(id, `document.activeElement === document.getElementById('search')`), 'not focused');
      check('...and has every section built', await waitIn(id, 'document.body.dataset.ready === "1"'), 'never fully built');
      await closeSettings(id);
    }

    // ---- the widget form's unsaved-changes guard, from a link into Home > Widgets
    {
      const id = await app.evaluate((_e, s) => global.__settings.open(s), 'widgets');
      await waitIn(id, 'document.body?.dataset.shown === "1"');
      await waitIn(id, 'document.body?.dataset.ready === "1"');
      const state = await run(id, );
      check('Home > Widgets from a link is built, and its open form asks before the tab closes with unsaved changes (and not when unchanged)', state === JSON.stringify({ clean: false, dirty: true }), state);
      await closeSettings(id);
    }
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
