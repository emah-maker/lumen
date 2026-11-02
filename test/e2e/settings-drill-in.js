// Every drill-in row in Settings opens something, in a hidden app (LUMEN_TEST_BACKGROUND=1):
//   - a row with a chevron (a link to a page, a widget's editor) and a fold ("More options", "Advanced", "Choose per program") found on any
//     page or sub-page opens there: the page or editor it names shows, or the fold opens with rows in it
//   - the same rows shown in search results open too: each one's label is searched for, and the labels of the rows in its list (a fold
//     shown because a row next to it matched must not open empty)
// LUMEN_SHOT_DIR=<dir> also saves a PNG of the search the first failure was found in.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright-core');
const { tmpProfile, env, root, sleep } = require('../helpers/_settings-open-rig');

// Installed in the Settings page: finds the drill-in rows on screen and clicks one, saying what it opened.
const PROBE = `(() => {
  const seen = (el) => Boolean(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const textOf = (el) => (el.matches('summary') ? (el.querySelector('.adv-title') || el).textContent : (el.querySelector('.label') || el).textContent).trim().replace(/\\s+/g, ' ');
  const kind = (el) => (el.matches('summary') ? 'fold' : 'link');
  const key = (el) => kind(el) + ':' + textOf(el);
  // A row with a chevron or a fold's summary, on screen now (the Back buttons have a chevron too: they are not rows).
  function rows() {
    const out = new Map();
    const found = [...document.querySelectorAll('#sections .row.link, #sections details > summary')];
    for (const c of document.querySelectorAll('#sections .chev')) { const r = c.closest('button, [role="link"], .row, summary'); if (r && !c.closest('.back')) found.push(r); }
    for (const el of found) if (seen(el) && textOf(el) && !out.has(key(el))) out.set(key(el), el);
    return out;
  }
  const state = () => JSON.stringify([location.hash, view.cat, view.sub, Boolean(view.root), document.body.classList.contains('searching'), Boolean(document.querySelector('#widget-form') && seen(document.querySelector('#widget-form')))]);
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  // Clicks the row named k; resolves to '' when it opened something, else what was wrong.
  async function click(k) {
    const el = rows().get(k);
    if (!el) return 'not on screen';
    if (el.matches('summary')) {
      const d = el.parentElement;
      const filled = () => [...d.children].some((c) => c !== el && seen(c) && c.getBoundingClientRect().height > 4);
      if (d.open) return filled() ? '' : 'open and empty'; // (a search opens the folds its matches are in)
      el.click();
      await frame(); await frame();
      const why = !d.open ? 'did not open' : filled() ? '' : 'opened empty';
      if (d.open) el.click(); // (closed again, as it was)
      return why;
    }
    const before = state();
    el.click();
    for (let i = 0; i < 60; i++) { await frame(); if (state() !== before) break; }
    const after = state();
    if (after === before) return 'nothing happened';
    const [, , sub] = JSON.parse(after);
    const pane = sub ? slots.get(sub)?.pane : categories.get(view.cat)?.pane;
    const form = document.querySelector('#widget-form');
    if (!(form && seen(form)) && !(pane && seen(pane) && pane.querySelector('.row, .card, .group'))) return 'opened a page with nothing on it';
    return '';
  }
  // Closes a widget's editor if one is open (it is a part of the page, not a route).
  async function closeEditor() { const b = document.querySelector('#widget-form .back'); if (b && seen(b)) { b.click(); await frame(); await frame(); } }
  async function search(q) { $('search').value = q; show(); await frame(); }
  async function goTo(hash) {
    $('search').value = '';
    if (location.hash !== hash) location.hash = hash; else route();
    for (let i = 0; i < 100 && (location.hash !== hash || !document.body.dataset.shown); i++) await frame();
    await frame();
  }
  // The labels of the rows in the list the row k is in (its card), for search.
  function listLabels(k) {
    const el = rows().get(k);
    const card = el?.closest('.card');
    return card ? [...card.querySelectorAll('.row .label, summary .adv-title')].map((l) => l.textContent.trim()).filter(Boolean) : [];
  }
  const pages = () => [...categories.keys(), ...[...slots.values()].filter((s) => s.isSub).map((s) => s.id)];
  window.__drill = { rows: () => [...rows().keys()], click, closeEditor, search, goTo, listLabels, pages };
  return true;
})()`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 1500)}`}`); };
  const app = await electron.launch({ args: [root], env: env(tmpProfile()) });
  const swallowDialogs = (p) => p.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  app.on('window', swallowDialogs);
  for (const p of app.windows()) swallowDialogs(p);
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
    await sleep(1000);
    const open = (section) => app.evaluate((_e, s) => global.__settings.open(s), section);
    const run = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [id, code]);
    const waitIn = async (id, code, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await run(id, code)) === true) return true; await sleep(40); } return false; };
    const J = JSON.stringify;

    const id = await open('general');
    check('Settings opens with every page built', await waitIn(id, 'document.body?.dataset.ready === "1"', 30000), 'never ready');
    check('the probe installs', (await run(id, PROBE)) === true);
    const pages = await run(id, '__drill.pages()');

    // ---- on its own page
    const bad = [];
    const all = new Map(); // row key -> the page it is on
    for (const page of pages) {
      await run(id, `__drill.goTo(${J(`#${page}`)})`);
      for (const k of await run(id, '__drill.rows()')) {
        if (!all.has(k)) all.set(k, page);
        const why = await run(id, `__drill.click(${J(k)})`);
        if (why) bad.push(`${page} / ${k}: ${why}`);
        await run(id, '__drill.closeEditor()');
        await run(id, `__drill.goTo(${J(`#${page}`)})`);
      }
    }
    const folds = [...all.keys()].filter((k) => k.startsWith('fold:')).length;
    check(`found the drill-in rows (${all.size}, ${folds} folds, on ${pages.length} pages)`, all.size > 40 && folds >= 4 && all.has('fold:More options'), [...all.keys()].join(' | '));
    check('every drill-in row opens something on its own page', bad.length === 0, bad.join(' | '));

    // ---- in search results
    const queries = new Set();
    for (const [k, page] of all) {
      await run(id, `__drill.goTo(${J(`#${page}`)})`);
      queries.add(k.slice(k.indexOf(':') + 1));
      for (const l of await run(id, `__drill.listLabels(${J(k)})`)) queries.add(l);
    }
    const badSearch = new Map();
    const tested = new Set();
    let shot = false;
    for (const q of queries) {
      await run(id, '__drill.goTo("#general")');
      await run(id, `__drill.search(${J(q)})`);
      for (const k of await run(id, '__drill.rows()')) {
        if (badSearch.has(k)) continue;
        await run(id, `__drill.search(${J(q)})`);
        const why = await run(id, `__drill.click(${J(k)})`);
        tested.add(k);
        if (why) {
          badSearch.set(k, `"${q}" / ${k}: ${why}`);
          if (!shot && process.env.LUMEN_SHOT_DIR) {
            shot = true;
            await run(id, `__drill.search(${J(q)})`);
            const b64 = await app.evaluate(async (_e, i) => (await global.__settings.contents(i).capturePage()).toPNG().toString('base64'), id);
            fs.mkdirSync(process.env.LUMEN_SHOT_DIR, { recursive: true });
            fs.writeFileSync(path.join(process.env.LUMEN_SHOT_DIR, 'drill-in-search-fail.png'), Buffer.from(b64, 'base64'));
          }
        }
        await run(id, '__drill.closeEditor()');
      }
    }
    check(`searched ${queries.size} labels and clicked ${tested.size} drill-in rows in the results`, tested.size >= 15 && tested.has('fold:More options'), [...tested].join(' | '));
    check('every drill-in row in search results opens something', badSearch.size === 0, [...badSearch.values()].join(' | '));
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
