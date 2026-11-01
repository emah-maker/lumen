// [account tabs] A tab with a second identity, in the real app with a temp profile and no network (features/account-tabs.js, main.js
// "[account tabs]"): a sign-in page that would pick the remembered school account offers "Use another account", which opens the
// site in Account 2's own session; that session's cookies and storage are kept apart from the main ones and survive a restart;
// links from it stay in it; the strip marks it and the address bar names it (renameable); an installed extension runs in it.
// portal.azure.com and login.microsoftonline.com are answered inside Lumen (protocol.handle), never fetched.
// Run with LUMEN_TEST_BACKGROUND=1 so the windows stay invisible and never take focus.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await sleep(100); } return v; };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..', '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
});

// An unpacked extension in the profile (id folder / version folder) whose content script marks every local test page.
function makeExtension(profile) {
  const dir = path.join(profile, 'Extensions', 'abcdefghijklmnopabcdefghijklmnop', '1.0.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, key: crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    name: 'Account tabs test extension', version: '1.0.0', host_permissions: ['http://127.0.0.1/*'],
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_end' }],
  }));
  fs.writeFileSync(path.join(dir, 'content.js'), 'document.documentElement.dataset.lumenExt = "1";');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'text/html');
    if (u.pathname === '/set') {
      const v = u.searchParams.get('v');
      res.setHeader('Set-Cookie', `who=${v}; Max-Age=86400; Path=/; SameSite=Lax`);
      res.end(`<!doctype html><title>set ${v}</title><script>localStorage.setItem('who', ${JSON.stringify(v)})</script>set`);
      return;
    }
    if (u.pathname === '/links') { res.end('<!doctype html><title>links</title><a id="l" href="/show" target="_blank">open</a>'); return; }
    res.end(`<!doctype html><title>Page ${u.pathname}</title><h1>${u.pathname}</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-accounttabs-'));
  makeExtension(profile);

  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  const watch = () => ui.on('pageerror', (e) => errors.push(e.message));
  watch();

  const win = () => app.evaluate(() => global.__windows.list().find((w) => w.current) || global.__windows.list()[0]);
  const active = async () => (await win()).activeId;
  const tabInfo = (id) => app.evaluate((_e, i) => global.__accounts.tab(i), id);
  const contentsOf = async (id) => (await win()).tabs.find((t) => t.id === id)?.contentsId;
  const js = async (id, code) => app.evaluate(({ webContents }, a) => webContents.fromId(a.wc).executeJavaScript(a.code, true), { wc: await contentsOf(id), code });
  const load = async (id, url) => { await app.evaluate(({ webContents }, a) => webContents.fromId(a.wc).loadURL(a.url).catch(() => {}), { wc: await contentsOf(id), url }); await waitFor(async () => (await win()).tabs.find((t) => t.id === id)?.url === url && !(await app.evaluate(({ webContents }, wc) => webContents.fromId(wc).isLoading(), await contentsOf(id)))); };
  const switchTo = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
  const who = async (id) => js(id, `JSON.stringify({ cookie: document.cookie, local: localStorage.getItem('who') })`).then(JSON.parse);
  const chip = () => ui.evaluate(() => { const c = document.getElementById('account-chip'); return c ? { shown: !c.hidden && getComputedStyle(c).display !== 'none', text: c.textContent, label: c.getAttribute('aria-label') } : null; });
  const bar = () => ui.evaluate(() => { const b = document.getElementById('account-bar'); return b ? { shown: !b.hidden, text: b.textContent, button: b.querySelector('button.primary')?.textContent || '' } : null; });

  // ---- a site that sends you to the remembered school account's sign-in, answered inside Lumen
  await app.evaluate(({ session }) => {
    const tenant = 'https://login.microsoftonline.com/1a2b3c4d-0000-0000-0000-000000000000/oauth2/v2.0/authorize?client_id=c44b4083&redirect_uri=https%3A%2F%2Fportal.azure.com%2Fsignin%2Findex%2F';
    global.__fakeAzure = (ses, signedIn) => ses.protocol.handle('https', (req) => {
      const u = new URL(req.url);
      if (u.hostname === 'portal.azure.com') return signedIn ? new Response(null, { status: 302, headers: { location: tenant } }) : new Response('<!doctype html><title>Azure: pick an account</title>Pick an account', { headers: { 'content-type': 'text/html' } });
      if (u.hostname === 'login.microsoftonline.com') return new Response('<!doctype html><title>Sign in to Northeastern</title>Northeastern University', { headers: { 'content-type': 'text/html' } });
      return new Response('offline', { status: 404 });
    });
    global.__fakeAzure(session.defaultSession, true);
    global.__fakeAzure(session.fromPartition('persist:lumen-account-2'), false); // (the session Account 2 will use: protocol handlers belong to it)
  });
  const first = await active();
  await load(first, 'https://portal.azure.com/');
  const signIn = await waitFor(async () => { const b = await bar(); return b?.shown && b; });
  check('portal.azure.com sends the main tab to the school tenant, and Lumen offers "Use another account"', signIn && /portal\.azure\.com/.test(signIn.text) && signIn.button === 'Use another account', JSON.stringify({ signIn, url: (await win()).tabs.find((t) => t.id === first)?.url }));
  check('nothing is marked as an account yet (the bar is the only thing shown)', (await chip())?.shown === false && (await tabInfo(first)).account === null, JSON.stringify(await chip()));
  await ui.evaluate(() => document.querySelector('#account-bar button.primary').click());
  const acct = await waitFor(async () => { const id = await active(); return id !== first && id; });
  const opened = await waitFor(async () => { const i = await tabInfo(acct); const t = (await win()).tabs.find((x) => x.id === acct); return i?.account === 2 && t?.url === 'https://portal.azure.com/' && { ...i, url: t.url }; });
  check('one click opens portal.azure.com in a new tab with Account 2 (made on the spot), its own saved session', opened && opened.partition === 'persist:lumen-account-2', JSON.stringify({ opened, info: await tabInfo(acct) }));
  check('there, with no remembered account, the site asks which account (a clean sign-in)', await waitFor(async () => (await js(acct, 'document.title')) === 'Azure: pick an account'), await js(acct, 'document.title').catch((e) => e.message));
  check('the accounts list now has Account 2', JSON.stringify(await app.evaluate(() => global.__accounts.list().map((a) => a.name))) === '["Account 2"]');
  check('the bar is gone in the account tab (not a sign-in page)', (await bar())?.shown === false);
  const c = await waitFor(async () => { const x = await chip(); return x?.shown && x; });
  check('the address bar names the account: "Account 2"', c && c.text === 'Account 2' && /own sign-ins/.test(c.label), JSON.stringify(c));
  const mark = await ui.evaluate((i) => { const el = document.querySelector(`#tabs .tab[data-id="${i}"]`); return el && { acct: el.classList.contains('acct'), color: el.style.getPropertyValue('--acct'), after: getComputedStyle(el, '::after').height, label: el.getAttribute('aria-label') }; }, acct);
  check('the strip marks the tab in the account\'s color and its name is part of the tab\'s label', mark?.acct && /^#[0-9a-f]{6}$/.test(mark.color) && mark.after === '2px' && /Account 2/.test(mark.label), JSON.stringify(mark));
  const plainMark = await ui.evaluate((i) => document.querySelector(`#tabs .tab[data-id="${i}"]`)?.classList.contains('acct'), first);
  check('the main tab has no mark', plainMark === false);

  // ---- cookies and storage apart
  await load(first, `${base}/set?v=main`);
  await load(acct, `${base}/set?v=acct`);
  await load(first, `${base}/show`);
  await load(acct, `${base}/show`);
  const wMain = await who(first);
  const wAcct = await who(acct);
  check('the main tab sees only its own cookie and storage', wMain.cookie === 'who=main' && wMain.local === 'main', JSON.stringify(wMain));
  check('the account tab sees only its own (same site, other identity)', wAcct.cookie === 'who=acct' && wAcct.local === 'acct', JSON.stringify(wAcct));
  const jar = await app.evaluate(async ({ session }, url) => ({ main: (await session.defaultSession.cookies.get({ url })).map((c) => c.value), acct: (await session.fromPartition('persist:lumen-account-2').cookies.get({ url })).map((c) => c.value) }), base);
  check('the cookie jars are separate', JSON.stringify(jar) === JSON.stringify({ main: ['main'], acct: ['acct'] }), JSON.stringify(jar));

  // ---- links stay in the account
  await load(acct, `${base}/links`);
  const before = (await win()).tabs.length;
  await js(acct, 'document.getElementById("l").click(); true');
  const linked = await waitFor(async () => { const w = await win(); return w.tabs.length > before && w.tabs[w.tabs.length - 1] && w.tabs.find((t) => t.url === `${base}/show` && t.id !== acct && t.id !== first); });
  check('a link that opens a new tab from the account tab opens in Account 2 too', linked && (await tabInfo(linked.id))?.account === 2, JSON.stringify({ linked, info: linked && await tabInfo(linked.id) }));
  if (linked) check('and sees the account\'s cookie', (await waitFor(async () => (await who(linked.id)).cookie === 'who=acct')) === true, JSON.stringify(await who(linked.id).catch(() => null)));

  // ---- the menus
  const mainMenu = await app.evaluate((_e, i) => global.__accounts.menu(i), first);
  const acctMenu = await app.evaluate((_e, i) => global.__accounts.menu(i), acct);
  check('tab menu, main tab: Open with another account > Account 2, New account', JSON.stringify(mainMenu) === JSON.stringify(['Account 2', '-', 'New account']), JSON.stringify(mainMenu));
  check('tab menu, account tab: Main account, New account', JSON.stringify(acctMenu) === JSON.stringify(['Main account', '-', 'New account']), JSON.stringify(acctMenu));
  const count = (await win()).tabs.length;
  await app.evaluate((_e, i) => global.__accounts.pick(i, 'Main account'), acct);
  const back = await waitFor(async () => { const w = await win(); return w.tabs.length > count && w.tabs.find((t) => !([first, acct, linked?.id].includes(t.id)) && t.url === `${base}/links`); });
  check('"Main account" opens the page in a main-session tab, which has the main cookie', back && (await tabInfo(back.id))?.account === null && (await waitFor(async () => (await who(back.id)).cookie === 'who=main')) === true, JSON.stringify(back));

  // ---- rename
  await switchTo(acct);
  await waitFor(async () => (await chip())?.text === 'Account 2');
  await ui.evaluate(() => window.browser.accountAct('rename', '  Personal  '));
  const renamed = await waitFor(async () => { const x = await chip(); return x?.text === 'Personal' && x; });
  check('renaming the account (the chip\'s Rename…) changes its name everywhere', renamed && JSON.stringify(await app.evaluate(() => global.__accounts.list().map((a) => a.name))) === '["Personal"]'
    && /Personal/.test(await ui.evaluate((i) => document.querySelector(`#tabs .tab[data-id="${i}"]`)?.getAttribute('aria-label') || '', acct)), JSON.stringify(renamed));
  await switchTo(first);
  check('the chip is hidden on a main tab', await waitFor(async () => (await chip())?.shown === false) === true);

  // ---- the extension runs in the account's session too
  const loadedThere = await waitFor(() => app.evaluate(({ session }) => session.fromPartition('persist:lumen-account-2').extensions.getAllExtensions().some((e) => e.name === 'Account tabs test extension')), 15000);
  check('the installed extension is loaded in the account\'s session', loadedThere === true);
  await load(acct, `${base}/ext`);
  check('and its content script runs on the account tab\'s pages', (await waitFor(async () => (await js(acct, 'document.documentElement.dataset.lumenExt || ""')) === '1')) === true, await js(acct, 'document.documentElement.dataset.lumenExt || ""').catch((e) => e.message));

  // ---- a restart
  await switchTo(acct);
  await app.evaluate(async ({ session }) => { await session.defaultSession.cookies.flushStore(); await session.fromPartition('persist:lumen-account-2').cookies.flushStore(); });
  await sleep(500);
  await app.close();
  app = await launch(profile);
  ui = await app.firstWindow();
  watch();
  await ui.waitForSelector('.tab');
  const restored = await waitFor(async () => { const w = await win(); const infos = await Promise.all(w.tabs.map((t) => tabInfo(t.id).then((i) => ({ ...t, ...i })))); return infos.length >= 4 && infos; });
  const rAcct = restored && restored.filter((t) => t.account === 2);
  const rMain = restored && restored.find((t) => t.account === null && /\/show$|\/links$/.test(t.url));
  check('after a restart the account tabs come back as Account 2 tabs (and the others as main tabs)', rAcct?.length === 2 && rMain, JSON.stringify(restored));
  const front = rAcct?.find((t) => /\/ext$/.test(t.url)) || rAcct?.[0];
  if (front) {
    await switchTo(front.id);
    await waitFor(async () => (await win()).tabs.find((t) => t.id === front.id)?.contentsId);
    await waitFor(async () => !(await app.evaluate(({ webContents }, wc) => webContents.fromId(wc).isLoading(), await contentsOf(front.id))));
    const after = await waitFor(async () => { const w2 = await who(front.id); return w2.cookie === 'who=acct' && w2; });
    check('its cookie and storage are still there, still apart', after && after.local === 'acct' && (await tabInfo(front.id)).partition === 'persist:lumen-account-2', JSON.stringify({ after, info: await tabInfo(front.id) }));
    const c2 = await waitFor(async () => { const x = await chip(); return x?.shown && x.text === 'Personal' && x; });
    check('and the address bar still names it "Personal"', Boolean(c2), JSON.stringify(await chip()));
  }
  if (rMain) {
    await switchTo(rMain.id);
    await waitFor(async () => (await win()).tabs.find((t) => t.id === rMain.id)?.contentsId);
    await waitFor(async () => !(await app.evaluate(({ webContents }, wc) => webContents.fromId(wc).isLoading(), await contentsOf(rMain.id))));
    const m2 = await waitFor(async () => { const w2 = await who(rMain.id); return w2.cookie === 'who=main' && w2; });
    check('the main session kept its own', Boolean(m2), JSON.stringify(await who(rMain.id).catch((e) => e.message)));
  }

  // ---- Settings → Privacy and security → Clear browsing data (all time, cookies) clears the account's session too
  await app.evaluate(() => global.__settings.backend.clearData({ range: 'all', cookies: true }));
  const cleared = await app.evaluate(async ({ session }, url) => ({ main: (await session.defaultSession.cookies.get({ url })).length, acct: (await session.fromPartition('persist:lumen-account-2').cookies.get({ url })).length }), base);
  check('Clear browsing data clears the account\'s cookies with the main ones', cleared.main === 0 && cleared.acct === 0, JSON.stringify(cleared));

  check('no page errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
