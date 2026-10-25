// Settings routing, in a hidden app (LUMEN_TEST_BACKGROUND=1), one Settings tab reused the way a link from elsewhere reuses it:
//   - every id the backend accepts (categories, old names and aliases, sub-pages) opens the page it names through __settings.open (the call
//     behind openSettingsPage, lumen://settings/<id> and the address bar), even when another page was remembered or is open
//   - Back from a sub-page (the button, or the browser's) returns to where the link was (scroll), not the top
//   - following a link moves focus off the previous target, and a pending retry of the old link never steals it back
//   - no id is used twice in the page
//   - the command bar lists the current categories and sub-pages, and each entry opens its page
// LUMEN_SHOT_DIR=<dir> also saves a PNG of the Settings page after Back and of the command bar.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright-core');
const { SECTION_LINKS } = require('../../src/settings/settings-backend');
const { tmpProfile, env, root, sleep } = require('../helpers/_settings-open-rig');

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const app = await electron.launch({ args: [root], env: env(tmpProfile()) });
  const swallowDialogs = (p) => p.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  app.on('window', swallowDialogs);
  for (const p of app.windows()) swallowDialogs(p);
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
    await sleep(1500);
    const open = (section) => app.evaluate((_e, s) => global.__settings.open(s), section);
    const run = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [id, code]);
    const waitIn = async (id, code, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await run(id, code)) === true) return true; await sleep(40); } return false; };
    const shotDir = process.env.LUMEN_SHOT_DIR;
    const save = (name, b64) => { fs.mkdirSync(shotDir, { recursive: true }); fs.writeFileSync(path.join(shotDir, name), Buffer.from(b64, 'base64')); };
    const shotPage = async (id, name) => { if (shotDir) save(name, await app.evaluate(async (_e, i) => (await global.__settings.contents(i).capturePage()).toPNG().toString('base64'), id)); };
    const shotWindow = async (name) => { if (shotDir) save(name, await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))); };

    const id = await open('privacy');
    check('Settings opens', await waitIn(id, 'document.body?.dataset.ready === "1"'), 'never ready');

    // ---- every id opens the page it names, with another page open and remembered
    const expected = JSON.parse(await run(id, `JSON.stringify(Object.fromEntries(${JSON.stringify(SECTION_LINKS)}.map((s) => {
      let cat = null; let sub = null;
      if (slots.get(s)?.isSub) { cat = slots.get(s).cat; sub = s; } else if (categories.has(s)) cat = s; else if (ALIASES[s]) { cat = ALIASES[s].cat; sub = ALIASES[s].sub || null; }
      return [s, [cat, sub]];
    })))`));
    const bad = [];
    const cats = ['general', 'appearance', 'home', 'tabs', 'privacy', 'ai', 'updates', 'advanced'];
    for (const link of SECTION_LINKS) {
      const [cat, sub] = expected[link];
      if (!cat) { bad.push(`${link}: the page does not know it`); continue; }
      const other = cats.find((c) => c !== cat); // (the remembered page is never the answer)
      await open(other);
      await waitIn(id, `view.cat === ${JSON.stringify(other)} && !view.sub && document.body.dataset.shown === "1"`, 8000);
      await open(link);
      const ok = await waitIn(id, `(() => {
        if (view.cat !== ${JSON.stringify(cat)} || (view.sub || null) !== ${JSON.stringify(sub)}) return false;
        if (location.hash !== ${JSON.stringify(`#${link}`)}) return false;
        const pane = view.sub ? slots.get(view.sub)?.pane : categories.get(view.cat).pane;
        return Boolean(pane && !pane.hidden && pane.querySelector('.row') && /Settings/.test(document.title));
      })()`, 8000);
      if (!ok) bad.push(`${link}: ${await run(id, 'location.hash + " shows " + view.cat + "/" + view.sub')} wanted ${cat}/${sub}`);
    }
    check(`all ${SECTION_LINKS.length} ids (categories, aliases, sub-pages) open the page they name`, bad.length === 0, bad.join(' | '));
    for (const s of ['focus', 'external-apps', 'connectors', 'ai-providers', 'ai-keys-page', 'extensions-page', 'visual-effects', 'newtab']) check(`"${s}" is a link`, SECTION_LINKS.includes(s));

    // ---- Back from a sub-page restores the scroll
    await open('ai');
    await waitIn(id, 'view.cat === "ai" && !view.sub && document.body.dataset.ready === "1"');
    await run(id, 'window.scrollTo(0, 1500); true');
    await sleep(200);
    const y0 = await run(id, 'window.scrollY');
    check('the AI page is long enough to scroll', y0 > 600, y0);
    await run(id, 'slots.get("skills").link.click(); true');
    await waitIn(id, 'view.sub === "skills"');
    await sleep(150);
    check('a sub-page opens at the top', (await run(id, 'window.scrollY')) < 5, await run(id, 'window.scrollY'));
    await run(id, 'document.querySelector("#sub-skills .back").click(); true');
    await waitIn(id, '!view.sub && !document.querySelector("#cat-ai").hidden');
    await sleep(200);
    const y1 = await run(id, 'window.scrollY');
    check('Back (button) returns to the scroll position the link was followed from', Math.abs(y1 - y0) <= 2, `${y0} -> ${y1}`);
    await shotPage(id, 'routing-after-back.png');
    await run(id, 'window.scrollTo(0, 900); true');
    await sleep(150);
    const y2 = await run(id, 'window.scrollY');
    await run(id, 'slots.get("macros").link.click(); true');
    await waitIn(id, 'view.sub === "macros"');
    await run(id, 'history.back(); true');
    await waitIn(id, '!view.sub');
    await sleep(250);
    const y3 = await run(id, 'window.scrollY');
    check('Back (browser history) returns there too', Math.abs(y3 - y2) <= 2, `${y2} -> ${y3}`);
    await open('ai');
    await run(id, 'location.hash = "#skills"; true');
    await waitIn(id, 'view.sub === "skills"');
    await run(id, 'document.querySelector("#sub-skills .back").click(); true');
    await waitIn(id, '!view.sub');
    await sleep(250);
    const rect = await run(id, 'JSON.stringify(slots.get("skills").link.getBoundingClientRect())');
    check('Back from a sub-page opened by a link from elsewhere brings its row into view', await run(id, '(() => { const r = slots.get("skills").link.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()'), rect);

    // ---- focus follows the link
    await open('default-browser');
    check('a link to a row focuses it', await waitIn(id, 'document.activeElement?.id === "default-browser-button"', 4000), await run(id, 'document.activeElement?.id'));
    await run(id, 'location.hash = "#startup"; true');
    await waitIn(id, 'location.hash === "#startup" && view.cat === "general"');
    await sleep(300);
    check('following the next link leaves no focus on the previous target', (await run(id, 'document.activeElement?.id')) !== 'default-browser-button', await run(id, 'document.activeElement?.id'));
    await run(id, 'location.hash = "#hands-off"; true');
    await run(id, 'location.hash = "#appearance"; true');
    await sleep(1600);
    check('retries from an abandoned link never take focus later', await run(id, '!document.activeElement?.closest("#cat-ai") && view.cat === "appearance"'), await run(id, 'document.activeElement?.id + " " + view.cat'));
    await open('default-browser');
    await waitIn(id, 'document.activeElement?.id === "default-browser-button"', 4000);
    await run(id, 'location.hash = "#appearance"; true');
    await sleep(300);
    await run(id, 'location.hash = "#default-browser"; true');
    check('the same link focuses its row again', await waitIn(id, 'document.activeElement?.id === "default-browser-button"', 4000), await run(id, 'document.activeElement?.id'));

    // ---- no duplicate ids (all pages built)
    await open('');
    await waitIn(id, 'document.body.dataset.ready === "1"');
    const dupes = await run(id, `(() => { const seen = new Map(); for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1); return JSON.stringify([...seen].filter(([, n]) => n > 1).map(([k, n]) => k + 'x' + n)); })()`);
    check('no id is used twice in Settings', dupes === '[]', dupes);
    check('the Widgets page and the Home slot have different ids', await run(id, '!!document.getElementById("sec-widgets")?.closest(".subpane") && !!document.getElementById("sec-widgets-parent")'));
    check('the startup radios and the pages list have different ids', await run(id, 'document.getElementById("startup-pages").classList.contains("list") && document.getElementById("startup-opt-pages").type === "radio"'));

    // ---- the command bar
    const openBar = async (text) => {
      await app.evaluate(async ({ BrowserWindow }) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents;
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] });
        await new Promise((r) => setTimeout(r, 400));
      });
      const opened = await ui.waitForSelector('#cmdbar:not([hidden])', { timeout: 5000 }).then(() => true).catch(() => false);
      if (opened) { await ui.fill('#cmdbar-input', text); await sleep(250); }
      return opened;
    };
    check('the command bar opens', await openBar('settings'));
    await shotWindow('routing-command-bar.png');
    // (the bar shows a few rows per query: each page is looked up by its name, as a person would)
    const siteCats = JSON.parse(await run(id, 'JSON.stringify([...categories.values()].map((c) => [c.id, c.title]))'));
    const siteSubs = JSON.parse(await run(id, 'JSON.stringify([...slots.values()].filter((s) => s.isSub).map((s) => [s.id, s.title]))'));
    const found = async (title) => { await ui.fill('#cmdbar-input', title); await sleep(120); return ui.evaluate(() => [...document.querySelectorAll('.cmdbar-item[data-group="setting"]')].map((e) => [e.dataset.id.replace('settings:', ''), e.querySelector('.cmdbar-title').textContent])); };
    const missCat = []; const missSub = [];
    for (const [c, title] of siteCats) if (!(await found(title)).some((e) => e[0] === c && e[1] === title)) missCat.push(c);
    for (const [sid, title] of siteSubs) { const want = sid === 'extensions-page' ? 'extensions' : sid; if (!(await found(title)).some((e) => e[0] === want)) missSub.push(sid); }
    check('every current category is listed under its sidebar name', missCat.length === 0, missCat.join());
    check('every sub-page is listed', missSub.length === 0, missSub.join());
    const stale = [];
    for (const old of ['About Lumen', 'You and AI']) if ((await found(old)).some((e) => e[1] === old)) stale.push(old);
    check('the retired names are gone ("About Lumen", "You and AI")', stale.length === 0, stale.join());
    await ui.keyboard.press('Escape');
    for (const [target, query] of [['connectors', 'connectors'], ['usage', 'usage'], ['routines', 'routines'], ['site-permissions', 'site permissions']]) {
      await open('general');
      await waitIn(id, 'view.cat === "general" && !view.sub');
      if (!(await openBar(query))) { check(`the bar opens for "${target}"`, false); continue; }
      await ui.click(`.cmdbar-item[data-id="settings:${target}"]`).catch(() => {});
      check(`the entry "${target}" opens its page`, await waitIn(id, `view.sub === ${JSON.stringify(target)}`, 6000), await run(id, 'view.cat + "/" + view.sub'));
    }
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
