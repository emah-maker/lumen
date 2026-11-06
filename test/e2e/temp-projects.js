// [temp projects] Temporary projects and the project page's views, in a real (invisible) window:
//  - the clock button in the Projects block makes one at once ("Quick project, <day>", no folder) and opens its page, which says it is
//    temporary and when it goes; the rail row has a Temp mark;
//  - the sweep leaves it alone until a week after its last use, then deletes it like Delete project (its chat stays, out of any project);
//  - Keep as project (on the page, or in the row's ⋯ menu) makes it an ordinary project that the sweep never deletes;
//  - the page's Overview / Memory / Settings tabs (arrow keys too): Memory shows the notes card on its own, Settings the project card
//    (pin, archive, export, delete) with the instructions, defaults and folder; Pin and Archive there work, and an archived project's
//    page says so with Move out of archive.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-profile-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); });
    const seeded = await app.evaluate(() => global.__chats.store().saveProject({ name: 'Thesis' }).id); // (so the Projects block shows)
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false && (await inPage("Boolean(document.querySelector('#cp-projects .cp-pj-temp-new'))")) === true, 20000);
    const projects = () => app.evaluate(() => global.__chats.store().projects());
    const pageText = () => inPage("document.getElementById('cp-project-page')?.innerText || ''");

    // ======== one click ========
    await inPage("document.querySelector('#cp-projects .cp-pj-temp-new').click()");
    const temp = await waitFor(async () => (await projects()).find((p) => p.temporary));
    check('the clock button makes a temporary project with no folder, named for the day', temp && /^Quick project, /.test(temp.name) && !temp.folder, JSON.stringify(temp));
    check('...and opens its page, which says it is temporary and when it goes', await waitFor(async () => /Temporary project\. Deleted .* unless you keep it\. Its chats stay in your chat list\./.test(await pageText()), 15000), await pageText());
    check('the rail row has a Temp mark with the date in its tooltip', (await inPage(`(() => { const c = document.querySelector('#cp-projects .cp-pj-item[data-project="${temp.id}"] .cp-pj-temp'); return c && c.textContent === 'Temp' && /unless you keep it/.test(c.title); })()`)) === true);
    // a chat in it, for the sweep
    const chat = await app.evaluate((_e, pid) => { const store = global.__chats.store(); const id = store.newId(); store.save(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'quick q' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }); store.setProject(id, pid); return id; }, temp.id);
    const ms = await app.evaluate(() => global.__tempProjects.ms);
    const expiry = await app.evaluate((_e, id) => global.__tempProjects.expiry(id), temp.id);
    check('it goes a week after its last use (its chat counts)', expiry > Date.now() + ms - 60000 && expiry <= Date.now() + ms + 1000, `${expiry - Date.now()} vs ${ms}`);
    check('the sweep leaves it alone before then', (await app.evaluate(() => global.__tempProjects.sweep(Date.now() + 60000))) === 0 && (await projects()).some((p) => p.id === temp.id));
    check('...and deletes it after', (await app.evaluate((_e, at) => global.__tempProjects.sweep(at), expiry + 1000)) === 1 && !(await projects()).some((p) => p.id === temp.id));
    check('its open page closes once it is gone', await waitFor(async () => (await inPage('window.chatProjectPage?.id() || null')) === null));
    check('its chat stays, out of any project', await app.evaluate((_e, id) => { const c = global.__chats.store().list().find((x) => x.id === id); return Boolean(c) && !c.project; }, chat));
    check('an ordinary project is never swept', (await projects()).some((p) => p.id === seeded));

    // ======== Keep as project ========
    await inPage("document.querySelector('#cp-projects .cp-pj-temp-new').click()");
    const second = await waitFor(async () => (await projects()).find((p) => p.temporary));
    await waitFor(async () => (await inPage('window.chatProjectPage?.id()')) === second.id && (await inPage("Boolean(document.querySelector('#cp-project-page .pjp-notice .pjp-keep'))")), 15000);
    await inPage("document.querySelector('#cp-project-page .pjp-notice .pjp-keep').click()");
    check('Keep as project on the page makes it an ordinary project', await waitFor(async () => { const p = (await projects()).find((x) => x.id === second.id); return p && !p.temporary; }), JSON.stringify((await projects()).find((x) => x.id === second.id)));
    check('...the notice and the Temp mark go', await waitFor(async () => (await inPage("document.querySelector('#cp-project-page .pjp-notice').hidden")) === true && (await inPage(`Boolean(document.querySelector('#cp-projects .cp-pj-item[data-project="${second.id}"] .cp-pj-temp'))`)) === false));
    check('...and the sweep never deletes it', (await app.evaluate(() => global.__tempProjects.sweep(Date.now() + 365 * 86400000))) === 0 && (await projects()).some((p) => p.id === second.id));
    await inPage("document.querySelector('#cp-projects .cp-pj-temp-new').click()");
    const third = await waitFor(async () => (await projects()).find((p) => p.temporary));
    await waitFor(() => inPage(`Boolean(document.querySelector('#cp-projects .cp-pj-item[data-project="${third.id}"] .cp-pj-more'))`));
    await inPage(`document.querySelector('#cp-projects .cp-pj-item[data-project="${third.id}"] .cp-pj-more').click()`);
    await waitFor(() => inPage("Boolean(document.querySelector('.cp-pj-actions'))"));
    await inPage("[...document.querySelectorAll('.cp-pj-actions [role=menuitem]')].find((b) => b.textContent === 'Keep as project').click()");
    check('Keep as project in the row\'s ⋯ menu works too', await waitFor(async () => !(await projects()).find((x) => x.id === third.id)?.temporary));

    // ======== the views ========
    await inPage(`document.querySelector('#cp-projects .cp-pj-item[data-project="${seeded}"] .cp-pj').click()`);
    await waitFor(async () => (await inPage("document.querySelector('#cp-project-page .pjp-title')?.value")) === 'Thesis', 15000);
    const tabs = await inPage("[...document.querySelectorAll('#cp-project-page .pjp-tab')].map((b) => b.textContent + ':' + b.getAttribute('aria-selected'))");
    check('the page has Overview / Memory / Settings tabs, Overview selected', JSON.stringify(tabs) === JSON.stringify(['Overview:true', 'Memory:false', 'Settings:false']), JSON.stringify(tabs));
    await inPage("document.querySelector('#cp-project-page .pjp-tab[data-view=\"memory\"]').click()");
    check('Memory: the notes card on its own, the overview hidden', (await inPage("document.querySelector('#cp-project-page .pjp-cols').hidden && Boolean(document.querySelector('#cp-project-page .pjp-view .pjp-memory'))")) === true);
    await inPage("document.querySelector('#cp-project-page .pjp-tab[data-view=\"memory\"]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
    check('ArrowRight moves to Settings', (await inPage("document.activeElement?.dataset.view === 'settings' && document.querySelector('#cp-project-page .pjp-tab[data-view=\"settings\"]').getAttribute('aria-selected') === 'true'")) === true);
    const settingsText = await inPage("document.querySelector('#cp-project-page .pjp-view').innerText");
    check('Settings: the project card (pin, archive, export, delete), then instructions, defaults and folder', ['Pin to top', 'Archive', 'Export project…', 'Delete project', 'Instructions', 'Defaults'].every((w) => settingsText.includes(w)), settingsText.slice(0, 400));
    await inPage("document.querySelector('#cp-project-page .pjp-view .pjp-pin').click()");
    check('Pin to top in Settings pins the project', await waitFor(async () => (await projects()).find((p) => p.id === seeded)?.pinned === true));
    check('...and the card then offers Unpin', await waitFor(async () => (await inPage("document.querySelector('#cp-project-page .pjp-view .pjp-pin')?.textContent")) === 'Unpin'));
    await inPage("document.querySelector('#cp-project-page .pjp-tab[data-view=\"overview\"]').click()");
    check('back to Overview: the columns show again', (await inPage("!document.querySelector('#cp-project-page .pjp-cols').hidden && document.querySelector('#cp-project-page .pjp-view').hidden")) === true);
    await inPage("document.querySelector('#cp-project-page .pjp-tab[data-view=\"settings\"]').click()");
    await inPage("document.querySelector('#cp-project-page .pjp-view .pjp-archive').click()");
    check('Archive in Settings archives it (and the page closes, with Undo)', await waitFor(async () => (await projects()).find((p) => p.id === seeded)?.archived === true && !(await inPage("Boolean(document.getElementById('cp-project-page'))"))));
    await waitFor(() => inPage("Boolean(document.querySelector('#cp-projects .cp-pj-shelf'))"));
    await inPage("document.querySelector('#cp-projects .cp-pj-shelf').click()");
    await waitFor(() => inPage(`Boolean(document.querySelector('#cp-projects .cp-pj-item[data-project="${seeded}"]'))`));
    await inPage(`document.querySelector('#cp-projects .cp-pj-item[data-project="${seeded}"] .cp-pj').click()`);
    check('an archived project\'s page says so', await waitFor(async () => /This project is archived/.test(await pageText()), 15000), await pageText());
    await inPage("document.querySelector('#cp-project-page .pjp-notice .pjp-unarchive').click()");
    check('...and Move out of archive brings it back', await waitFor(async () => !(await projects()).find((p) => p.id === seeded)?.archived && (await inPage("document.querySelector('#cp-project-page .pjp-notice').hidden")) === true));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
