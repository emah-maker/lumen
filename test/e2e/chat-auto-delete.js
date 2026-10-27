// [auto-delete chats] "Delete chats not in a project after" (chatAutoDeleteDays; features/chat-auto-delete.js, main.js autoDeleteSweep) in a
// hidden app on a throwaway profile: saved chats with old last-activity dates are deleted by a sweep, with their files, while chats in a
// project, pinned chats, recent ones and the open chat stay; off (the default) deletes nothing; the Settings row is on AI → Chat box and
// voice with every choice. A fake model, invisible windows (LUMEN_TEST_BACKGROUND=1), no network.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  // The release runner names a profile folder it has not made yet.
  const profile = process.env.CLAUDE_BROWSER_PROFILE && process.env.CLAUDE_BROWSER_PROFILE !== '' ? (fs.mkdirSync(process.env.CLAUDE_BROWSER_PROFILE, { recursive: true }), fs.mkdtempSync(path.join(process.env.CLAUDE_BROWSER_PROFILE, 'autodelete-'))) : fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-autodelete-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  app.on('window', (p) => p.on('dialog', (d) => { d.dismiss().catch(() => {}); }));
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    check('off by default', await app.evaluate(() => global.__settings.backend.prefs().chatAutoDeleteDays) === 0);

    // Saved chats with their last activity set (adopt keeps the dates it is given, as sync does). A write the virus scanner holds for a moment
    // (EPERM/EBUSY on the index's rename, Windows) is tried again: that is the store's synchronous write, not what this suite checks.
    const retry = async (fn) => { for (let i = 1; ; i++) { try { return await fn(); } catch (err) { if (i >= 5 || !/EPERM|EBUSY|EACCES/.test(String(err?.message))) throw err; await sleep(200 * i); } } };
    const seed = (name, daysAgo) => retry(() => app.evaluate((_e, [n, d, day]) => {
      const store = global.__chats.store();
      const id = store.newId();
      const at = Date.now() - d * day;
      store.adopt(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: `${n} topic` }] }, { role: 'assistant', content: [{ type: 'text', text: `${n} answer` }] }] }, { created: at - day, updated: at });
      return id;
    }, [name, daysAgo, DAY]));
    const ids = {};
    for (const [n, d] of [['old', 45], ['archived', 45], ['project', 45], ['pinned', 45], ['recent', 3], ['ancient', 400]]) ids[n] = await seed(n, d);
    await retry(() => app.evaluate((_e, i) => {
      const store = global.__chats.store();
      store.setProject(i.project, store.saveProject({ name: 'Keep me' }).id);
      store.setPinned(i.pinned, true);
      store.setArchived(i.archived, true);
    }, ids));
    const open = await app.evaluate(() => global.__chats.id());
    const chatsDir = path.join(profile, 'chats');
    const fileOf = (id) => path.join(chatsDir, `${id}.json`);
    check('the seeded chats are saved', Object.values(ids).every((id) => fs.existsSync(fileOf(id))));

    check('a sweep with the setting off deletes nothing', (await app.evaluate(() => global.__chats.autoDelete())).length === 0);

    let refused = false;
    try { await app.evaluate(() => global.__settings.backend.set('chatAutoDeleteDays', 5)); } catch { refused = true; }
    check('a number of days not in the menu is refused', refused || (await app.evaluate(() => global.__settings.backend.prefs().chatAutoDeleteDays)) === 0);

    await app.evaluate(() => global.__settings.backend.set('chatAutoDeleteDays', 30));
    check('the setting is saved', await app.evaluate(() => global.__settings.backend.prefs().chatAutoDeleteDays) === 30);
    const gone = await app.evaluate(() => global.__chats.autoDelete());
    check('the sweep deletes the old chats in no project (archived too)', [ids.old, ids.archived, ids.ancient].every((id) => gone.includes(id)) && gone.length === 3, JSON.stringify(gone));
    check('the longest unused goes first', gone[0] === ids.ancient, JSON.stringify(gone));
    const listed = await app.evaluate(() => global.__chats.store().list().map((c) => c.id));
    check('they leave the history list', gone.every((id) => !listed.includes(id)));
    check('their files are erased', gone.every((id) => !fs.existsSync(fileOf(id))));
    check('the project, pinned and recent chats stay', [ids.project, ids.pinned, ids.recent].every((id) => listed.includes(id) && fs.existsSync(fileOf(id))), JSON.stringify(listed));
    check('a second sweep finds nothing more', (await app.evaluate(() => global.__chats.autoDelete())).length === 0);

    // The open chat is never deleted, however old: give the open chat an old saved entry.
    await retry(() => app.evaluate((_e, [id, day]) => {
      const store = global.__chats.store();
      store.adopt(id, { settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'open topic' }] }, { role: 'assistant', content: [{ type: 'text', text: 'open answer' }] }] }, { created: Date.now() - 90 * day, updated: Date.now() - 90 * day });
    }, [open, DAY]));
    check('the open chat is never deleted', (await app.evaluate(() => global.__chats.autoDelete())).length === 0 && await app.evaluate((_e, id) => global.__chats.store().has(id), open));

    // A chat whose project is deleted is in no project any more, and goes on the next sweep.
    await retry(() => app.evaluate((_e, id) => { const store = global.__chats.store(); const p = store.projectOf(id); if (p) store.removeProject(p.id); }, ids.project));
    check('a chat whose project was deleted goes next time', JSON.stringify(await app.evaluate(() => global.__chats.autoDelete())) === JSON.stringify([ids.project]));

    // The Settings row: AI → Chat box and voice, every choice, the saved value shown.
    const sid = await app.evaluate(() => global.__settings.open('ai-chat'));
    const run = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [sid, code]);
    let row = null;
    for (let i = 0; i < 150 && !row; i++) { row = await run(`(() => { const el = document.getElementById('pref-chatAutoDeleteDays'); if (!el) return null; return JSON.stringify({ value: el.value, options: [...el.options].map((o) => o.value + '=' + o.textContent), label: el.closest('.row')?.querySelector('.label')?.textContent, desc: el.closest('.row')?.textContent || '' }); })()`); if (!row || row.startsWith('ERROR')) { row = null; await sleep(100); } }
    const r = row ? JSON.parse(row) : null;
    check('the Settings row is there', Boolean(r), row);
    if (r) {
      check('it shows the saved choice', r.value === '30', r.value);
      check('every choice is offered, Never first', r.options.join('|') === '0=Never|1=1 day|7=7 days|14=14 days|30=30 days|60=60 days|90=90 days|180=6 months|365=1 year', r.options.join('|'));
      check('the row says what is deleted and what is kept', /Delete chats not in a project after/.test(r.label) && /not in a project/.test(r.desc) && /Pinned chats/.test(r.desc), r.desc);
    }
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite threw  -> ${err?.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
