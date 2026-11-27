// [profiles] Two profiles are two separate Lumens (features/profiles.js, docs/profiles.md). Hidden run, throwaway folders:
//   - the Default profile sets a cookie, visits a page and saves a chat; a Work profile is added (the toolbar button shows,
//     the switcher asks for `--lumen-profile=<id>`), and the editor window renames Default
//   - Work, started the way the switcher starts it, sees none of Default's cookies, history or chats, and keeps its own
//   - the Default folder is byte-for-byte untouched while Work runs; Default, started again, sees none of Work's data
//   - an unknown --lumen-profile starts Default; Delete refuses a running profile, then removes a closed one's folder
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/profiles.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..', '..');
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};
// Every file and folder under `dir`: path, size and modified time (a write anywhere changes it).
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => { try { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.isDirectory() ? 'd' : st.size}:${st.mtimeMs}`; } catch { return `${f}:gone`; } });
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const urlsIn = (history) => (Array.isArray(history) ? history : Array.isArray(history?.entries) ? history.entries : Object.values(history || {})).map((e) => (Array.isArray(e) ? e[0] : e?.url)).filter(Boolean);
const chat = (text) => ({ settings: { model: 'm' }, messages: [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });

(async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-profiles-'));
  const base = path.join(parent, 'Lumen');
  const root = `${base} Profiles`;
  fs.mkdirSync(base);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'text/html');
    if (u.pathname === '/set') res.setHeader('Set-Cookie', `who=${u.searchParams.get('v')}; Max-Age=3600; Path=/`);
    res.end(`<!doctype html><title>${u.pathname.slice(1) || 'home'}</title><body>${u.pathname}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}`;

  const running = new Set();
  const launch = async (extra = []) => {
    const app = await electron.launch({
      args: [APP, ...extra], timeout: 60000,
      env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: base, ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    running.add(app);
    const ui = await app.firstWindow({ timeout: 60000 });
    await ui.waitForSelector('.tab', { timeout: 60000 });
    return { app, ui };
  };
  const close = async (app) => { await app.close().catch(() => {}); running.delete(app); };
  const visit = (app, url) => app.evaluate((_e, u) => { global.__agent.browser.activeTab().webContents.loadURL(u).catch(() => {}); }, url);
  const cookie = (app) => app.evaluate(async ({ session }, u) => (await session.defaultSession.cookies.get({ url: u })).map((c) => `${c.name}=${c.value}`).join(';'), site);
  const chatTitles = (app) => app.evaluate(() => global.__chats.store().list().map((c) => c.title || c.preview || c.id).join('|'));
  const chatIds = (app) => app.evaluate(() => global.__chats.store().list().map((c) => c.id));
  const userData = (app) => app.evaluate(({ app: a }) => a.getPath('userData'));

  try {
    // ---------- 1. the Default profile
    let { app: def, ui } = await launch();
    check('a plain start is the Default profile in its usual folder', (await def.evaluate(() => global.__profiles.current.id)) === 'default' && path.resolve(await userData(def)) === path.resolve(base), await userData(def));
    check('with one profile the toolbar has no profile button', await ui.evaluate(() => document.getElementById('profile-btn').hidden), '');
    const menu = await def.evaluate(() => global.__profiles.menuItems().map((i) => i.label || '---'));
    check('the profile menu lists Default (checked) and Add / Edit / Delete', menu[0].endsWith('Default') && menu.includes('Add profile…') && menu.includes('Edit this profile…') && menu.includes('Delete profile'), JSON.stringify(menu));
    check('reading the list makes no Lumen Profiles folder', !fs.existsSync(root), root);

    await visit(def, `${site}/set?v=default`);
    check('Default gets its cookie', await waitFor(async () => (await cookie(def)) === 'who=default'), await cookie(def));
    await visit(def, `${site}/default-page`);
    await waitFor(() => def.evaluate(() => global.__agent.browser.activeTab().webContents.getURL().endsWith('/default-page')));
    await def.evaluate((_e, snap) => global.__chats.store().save('aaaaaaaaaaaaaaaa', snap), chat('default secret chat'));
    check('Default has its chat', (await chatIds(def)).includes('aaaaaaaaaaaaaaaa'), await chatTitles(def));

    // Add a profile the way the editor does; the switcher would start it (dry run: this suite starts it itself, below).
    await def.evaluate(() => { global.__profiles.test.dryRun = true; });
    const work = await def.evaluate(() => global.__profiles.save(null, { name: 'Work', color: 'green', avatar: '💼' }));
    check('Add makes a profile with its name, colour and avatar', work.id && work.name === 'Work' && work.color === 'green' && work.avatar === '💼', JSON.stringify(work));
    check('its folder is in "Lumen Profiles" next to Default, not inside it', fs.statSync(path.join(root, work.id)).isDirectory() && !fs.existsSync(path.join(base, work.id)), root);
    const launched = await def.evaluate(() => global.__profiles.test.launches);
    check('the new profile is opened as its own Lumen with --lumen-profile', launched.length === 1 && launched[0].args.includes(`--lumen-profile=${work.id}`), JSON.stringify(launched));
    const shown = await waitFor(() => ui.evaluate(() => { const b = document.getElementById('profile-btn'); return !b.hidden && { label: b.getAttribute('aria-label'), avatar: document.getElementById('profile-avatar').textContent }; }));
    check('with two profiles the toolbar shows this window\'s profile button', Boolean(shown) && /Default/.test(shown.label) && shown.avatar === 'D', JSON.stringify(shown));

    // The editor window: rename Default and give it a colour and an avatar.
    await def.evaluate(() => { global.__profiles.openEditor('default'); });
    const ed = await waitFor(() => def.evaluate(() => { const w = global.__profiles.editor(); return w && !w.webContents.isLoading() && w.webContents.id; }));
    check('Edit this profile… opens the editor window', Boolean(ed), ed);
    const filled = await waitFor(() => def.evaluate(async () => {
      const wc = global.__profiles.editor().webContents;
      return wc.executeJavaScript(`(() => { const n = document.getElementById('name'); if (!n || n.value !== 'Default') return false;
        n.value = 'Personal'; n.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('color-pink').click(); document.querySelector('input[name=avatar][value="🏠"]').click();
        return document.getElementById('preview').textContent; })()`);
    }));
    check('the editor shows the profile and previews the new avatar', filled === '🏠', filled);
    await def.evaluate(() => global.__profiles.editor().webContents.executeJavaScript("document.getElementById('save').click()"));
    const renamed = await waitFor(() => def.evaluate(() => { const p = global.__profiles.store.get('default'); return p.name === 'Personal' && p; }));
    check('Save stores the new name, colour and avatar', renamed && renamed.color === 'pink' && renamed.avatar === '🏠', JSON.stringify(renamed));
    check('...the editor closes', await waitFor(() => def.evaluate(() => !global.__profiles.editor())), '');
    check('...and the toolbar button follows', await waitFor(() => ui.evaluate(() => document.getElementById('profile-avatar').textContent === '🏠' && /Personal/.test(document.getElementById('profile-btn').getAttribute('aria-label')))), '');
    await close(def);
    const defaultFiles = snapshot(base);
    const defaultHistory = urlsIn(readJson(path.join(base, 'history.json')));
    check('Default\'s history has its page', defaultHistory.some((u) => u.endsWith('/default-page')), JSON.stringify(defaultHistory));
    check('the profile list is kept outside the Default folder', fs.existsSync(path.join(root, 'profiles.json')) && !fs.existsSync(path.join(base, 'profiles.json')), '');

    // ---------- 2. the Work profile, started the way the switcher starts it
    let wk;
    ({ app: wk, ui } = await launch(launched[0].args.slice(1)));
    check('Work runs in its own folder', (await wk.evaluate(() => global.__profiles.current.id)) === work.id && path.resolve(await userData(wk)) === path.resolve(path.join(root, work.id)), await userData(wk));
    check('Work has none of Default\'s cookies', (await cookie(wk)) === '', await cookie(wk));
    check('Work has none of Default\'s chats', (await chatIds(wk)).length === 0, await chatTitles(wk));
    const menuWork = await wk.evaluate(() => global.__profiles.menuItems().filter((i) => i.type === 'checkbox').map((i) => `${i.label}${i.checked ? '*' : ''}`));
    check('Work\'s menu lists both profiles, Work checked', menuWork.length === 2 && menuWork.some((l) => /Personal$/.test(l)) && menuWork.some((l) => /Work\*$/.test(l)), JSON.stringify(menuWork));
    check('Work\'s toolbar shows its own avatar', await waitFor(() => ui.evaluate(() => !document.getElementById('profile-btn').hidden && document.getElementById('profile-avatar').textContent === '💼')), '');
    await visit(wk, `${site}/set?v=work`);
    check('Work gets its own cookie', await waitFor(async () => (await cookie(wk)) === 'who=work'), await cookie(wk));
    await visit(wk, `${site}/work-page`);
    await waitFor(() => wk.evaluate(() => global.__agent.browser.activeTab().webContents.getURL().endsWith('/work-page')));
    await wk.evaluate((_e, snap) => global.__chats.store().save('bbbbbbbbbbbbbbbb', snap), chat('work secret chat'));
    await sleep(1500);
    const unchanged = snapshot(base);
    const diff = unchanged.filter((x) => !defaultFiles.includes(x)).concat(defaultFiles.filter((x) => !unchanged.includes(x)));
    check('the Default folder is untouched while Work runs (no file added, changed or removed)', diff.length === 0, JSON.stringify(diff.slice(0, 10)));

    // ---------- 3. an unknown profile id starts Default (alongside Work), and Delete
    let d2;
    ({ app: d2, ui } = await launch(['--lumen-profile=p-deadbeef']));
    check('an unknown --lumen-profile starts the Default profile', (await d2.evaluate(() => global.__profiles.current.id)) === 'default' && path.resolve(await userData(d2)) === path.resolve(base), await userData(d2));
    check('Default still has only its own cookie', (await cookie(d2)) === 'who=default', await cookie(d2));
    const ids = await chatIds(d2);
    check('Default has its chat and none of Work\'s', ids.includes('aaaaaaaaaaaaaaaa') && !ids.includes('bbbbbbbbbbbbbbbb'), JSON.stringify(ids));
    const self = await d2.evaluate(() => global.__profiles.remove('default', { confirmed: true }));
    check('Default can\'t be deleted', self.error === 'not-allowed', JSON.stringify(self));
    if (process.platform === 'win32') {
      const busy = await d2.evaluate((_e, id) => global.__profiles.remove(id, { confirmed: true }), work.id);
      check('Delete refuses a profile that is open, and says so', busy.error === 'busy' && fs.existsSync(path.join(root, work.id)) && /Work/.test((await d2.evaluate(() => global.__profiles.test.lastNotice?.message)) || ''), JSON.stringify(busy));
    }
    await close(wk);
    const workHistory = urlsIn(readJson(path.join(root, work.id, 'history.json')));
    check('Work\'s history has its page and none of Default\'s', workHistory.some((u) => u.endsWith('/work-page')) && !workHistory.some((u) => u.endsWith('/default-page')), JSON.stringify(workHistory));
    check('Work\'s chat is in Work\'s folder', fs.readdirSync(path.join(root, work.id, 'chats')).some((f) => f.startsWith('bbbbbbbbbbbbbbbb')), '');
    await d2.evaluate((_e, id) => { global.__profileDelete = global.__profiles.remove(id); }, work.id); // the confirm dialog shows
    const asked = await waitFor(() => d2.evaluate(() => global.__dialogs.currentKind() === 'message' && global.__dialogs.currentId()));
    check('Delete asks first (a Lumen dialog)', Boolean(asked), asked);
    await d2.evaluate((_e, id) => global.__dialogs.respond({ id, response: 0 }), asked); // Cancel
    const cancelled = await d2.evaluate(() => global.__profileDelete).catch((e) => ({ threw: String(e) }));
    check('Cancel keeps the profile', cancelled.cancelled === true && fs.existsSync(path.join(root, work.id)), JSON.stringify(cancelled));
    const removed = await waitFor(() => d2.evaluate((_e, id) => global.__profiles.remove(id, { confirmed: true }), work.id), 15000);
    check('a closed profile is deleted: its folder goes and it leaves the list', removed?.removed === true && !fs.existsSync(path.join(root, work.id)) && (await d2.evaluate(() => global.__profiles.store.list().length)) === 1, JSON.stringify(removed));
    check('...and the toolbar button hides again (one profile left)', await waitFor(() => ui.evaluate(() => document.getElementById('profile-btn').hidden)), '');
    await close(d2);
    const finalHistory = urlsIn(readJson(path.join(base, 'history.json')));
    check('Default\'s history never got Work\'s page', finalHistory.some((u) => u.endsWith('/default-page')) && !finalHistory.some((u) => u.endsWith('/work-page')), JSON.stringify(finalHistory));
  } catch (err) {
    check('suite ran without throwing', false, err?.stack || err);
  } finally {
    for (const app of running) await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
