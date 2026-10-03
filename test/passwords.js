// [passwords] Saved passwords end to end (features/passwords.js) against a local login page
// (http://127.0.0.1 counts as local, so plain http is allowed there). Checks: off by default (nothing
// watched, nothing offered, no file), turning it on, the "Save password?" bar after a sign-in, Save
// (encrypted on disk with safeStorage, no plaintext), the key button and a fill (no submit), the AI side
// (read_page shows no password, run_script refused after a fill), research tabs and private windows
// never offered, Never for this site, the settings page list with Show behind re-authentication, and
// turning it off (Keep by default). A throwaway profile; windows stay invisible (LUMEN_TEST_BACKGROUND).
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<form id="f" method="post" action="/welcome">
  <label>Email <input id="user" type="email" name="email" autocomplete="username"></label>
  <label>Password <input id="pw" type="password" name="password" autocomplete="current-password"></label>
  <button id="go" type="submit">Sign in</button>
</form></body></html>`;
const WELCOME = '<!doctype html><html><head><title>Welcome</title></head><body><p>Signed in.</p></body></html>';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const skip = (label, why) => console.log(`SKIP  ${label}  (${why})`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(100); } return v; };

  const posted = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') { req.resume(); req.on('end', () => { posted.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(WELCOME); }); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LOGIN);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const site = `127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-passwords-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: '' }, colorScheme: null });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const vaultFile = path.join(profile, 'passwords.bin');
  const SECRET = 'Tr0ub4dor&3-horse';

  const open = (url, opts) => app.evaluate(async (_e, [u, o]) => {
    const t = global.__agent.browser.openTab(u, o);
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.id;
  }, [url, opts || {}]);
  const inTab = (id, js) => app.evaluate((_e, [i, code]) => global.__translate.tab(i).view.webContents.executeJavaScript(code), [id, js]);
  const pwWorld = (id, js) => app.evaluate((_e, [i, code]) => global.__translate.tab(i).view.webContents.executeJavaScriptInIsolatedWorld(1077, [{ code }]), [id, js]);
  const stateOf = (id) => app.evaluate((_e, i) => global.__passwords.stateOf(global.__translate.tab(i)), id);
  // Types like a user would (real key events, so the watcher sees trusted input), then clicks Sign in.
  const signIn = async (id, user, pw) => {
    await app.evaluate(async (_e, [i, u, p]) => {
      const wc = global.__translate.tab(i).view.webContents;
      await wc.executeJavaScript('document.getElementById("user").focus()');
      await wc.insertText(u);
      await wc.executeJavaScript('document.getElementById("pw").focus()');
      await wc.insertText(p);
      await wc.executeJavaScript('document.getElementById("pw").dispatchEvent(new Event("input", { bubbles: true }))');
      const done = new Promise((r) => wc.once('did-finish-load', r));
      await wc.executeJavaScript('document.getElementById("f").requestSubmit(document.getElementById("go"))');
      await done;
    }, [id, user, pw]);
  };
  const settingsJson = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); } catch { return {}; } };

  // ---- off by default ----
  const t0 = await open(`${base}/login`);
  await sleep(400);
  check('off by default: no watcher in the page', (await pwWorld(t0, 'typeof window.__lumenPasswords')) === 'undefined', await pwWorld(t0, 'typeof window.__lumenPasswords'));
  await signIn(t0, 'alice@example.com', SECRET);
  await sleep(500);
  check('off by default: a sign-in offers nothing and writes nothing', (await stateOf(t0)) === null && !fs.existsSync(vaultFile) && settingsJson().savePasswords === undefined, JSON.stringify(await stateOf(t0)));

  // ---- turning it on ----
  const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  const on = await app.evaluate(() => global.__passwords.setEnabled(true));
  if (!available) {
    check('without OS encryption it refuses to turn on', on.refused && !on.enabled, JSON.stringify(on));
    skip('the rest of the saved passwords checks', 'safeStorage is unavailable here');
    await app.close();
    server.close();
    process.exit(failures ? 1 : 0);
  }
  check('turns on when OS encryption is available', on.enabled && settingsJson().savePasswords === true, JSON.stringify(on));

  // ---- the save offer ----
  const t1 = await open(`${base}/login`);
  await waitFor(async () => (await pwWorld(t1, 'typeof window.__lumenPasswords')) === 'object');
  await signIn(t1, 'alice@example.com', SECRET);
  const offered = await waitFor(async () => (await stateOf(t1))?.offer);
  check('a sign-in offers to save, naming the site and username (no password in the state)', offered && offered.site === site && offered.username === 'alice@example.com' && !JSON.stringify(await stateOf(t1)).includes(SECRET), JSON.stringify(await stateOf(t1)));
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), t1);
  const barText = await waitFor(() => ui.$eval('#password-bar', (el) => (el.hidden ? '' : el.textContent)));
  check('the bar under the toolbar asks "Save password for <site>?"', barText.includes(`Save password for ${site}?`) && barText.includes('Never for this site') && barText.includes('Not now') && !barText.includes(SECRET), barText);
  check('the browser UI never gets the password', !(await ui.evaluate(() => document.body.innerHTML)).includes(SECRET), '');
  await ui.evaluate(() => [...document.querySelectorAll('#password-bar button')].find((b) => b.textContent === 'Save').click());
  await waitFor(() => fs.existsSync(vaultFile));
  const onDisk = fs.existsSync(vaultFile) ? fs.readFileSync(vaultFile) : Buffer.alloc(0);
  check('Save writes the encrypted file, with no password, username or site in plain text', onDisk.length > 0 && ![SECRET, 'alice@example.com', site].some((s) => onDisk.includes(Buffer.from(s))), onDisk.toString('utf8').slice(0, 60));
  check('nothing about the login is in settings.json', !JSON.stringify(settingsJson()).includes('alice@example.com') && !JSON.stringify(settingsJson()).includes(SECRET), '');
  const saved = await app.evaluate(() => global.__passwords.vault.list());
  check('the saved login is listed (site and username)', saved.length === 1 && saved[0].site === site && saved[0].username === 'alice@example.com', JSON.stringify(saved));
  check('the bar goes after Save', await waitFor(() => ui.$eval('#password-bar', (el) => el.hidden)), '');

  // ---- the key button and a fill ----
  const t2 = await open(`${base}/login`);
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), t2);
  check('the key button shows on a site with saved logins', await waitFor(() => ui.$eval('#passwords-btn', (b) => !b.hidden)), '');
  check('nothing is filled by itself', (await inTab(t2, 'document.getElementById("pw").value')) === '' && (await inTab(t2, 'document.getElementById("user").value')) === '', '');
  const before = posted.length;
  const result = await app.evaluate((_e, [i, id]) => global.__passwords.fillLogin(global.__translate.tab(i), id), [t2, saved[0].id]);
  check('Fill puts the login into the page', result === 'filled' && (await inTab(t2, 'document.getElementById("user").value')) === 'alice@example.com' && (await inTab(t2, 'document.getElementById("pw").value')) === SECRET, result);
  await sleep(500);
  check('Fill never submits the form', posted.length === before && (await inTab(t2, 'location.pathname')) === '/login', `${posted.length} posts, ${await inTab(t2, 'location.pathname')}`);

  // ---- the AI can't read it ----
  const page = await app.evaluate(async () => { try { return String(await global.__agent.execute('read_page', { mode: 'full' })); } catch (err) { return `ERROR ${err.message}`; } });
  check('read_page (full) shows no password value after a fill', !page.includes(SECRET) && page.includes('Password'), page.slice(0, 300));
  const compact = await app.evaluate(async () => { try { return String(await global.__agent.execute('read_page', { mode: 'compact' })); } catch (err) { return `ERROR ${err.message}`; } });
  check('read_page (compact) shows no password value either', !compact.includes(SECRET), compact.slice(0, 300));
  await inTab(t2, 'document.getElementById("pw").type = "text"'); // a page's "show password" button
  const shown = await app.evaluate(async () => { try { return String(await global.__agent.execute('read_page', { mode: 'full' })); } catch (err) { return `ERROR ${err.message}`; } });
  check('read_page hides it even after the page shows it as text (autocomplete marks it)', !shown.includes(SECRET), shown.slice(0, 300));
  const script = await app.evaluate(async () => { try { return String(await global.__agent.execute('run_script', { code: 'return document.getElementById("pw").value' })); } catch (err) { return `ERROR ${err.message}`; } });
  check('run_script is refused on the page with the filled password', /^ERROR run_script is not available on this page/.test(script) && !script.includes(SECRET), script);
  const t3 = await open(`${base}/login`);
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), t3);
  const script2 = await app.evaluate(async () => { try { return String(await global.__agent.execute('run_script', { code: 'return 1 + 1' })); } catch (err) { return `ERROR ${err.message}`; } });
  check('run_script works on a page where nothing was filled', script2.includes('2') && !script2.startsWith('ERROR'), script2);

  // ---- research tabs and private windows are never offered ----
  const research = require('../src/features/research-tabs').RESEARCH_PARTITION;
  const tr = await open(`${base}/login`, { partition: research, background: true });
  await sleep(400);
  check('a research tab gets no watcher and no key button', (await pwWorld(tr, 'typeof window.__lumenPasswords')) === 'undefined' && (await stateOf(tr)) === null, JSON.stringify(await stateOf(tr)));
  await app.evaluate((_e, u) => global.__private.open(u), `${base}/login`);
  const priv = await waitFor(() => app.evaluate(({ webContents }) => { const w = global.__private.list()[0]; return w && w.tabs[0] && !webContents.fromId(w.tabs[0].contentsId).isLoading() && w.tabs[0].url.includes('/login') ? w.tabs[0] : null; }));
  if (priv) {
    const privWorld = await app.evaluate(async ({ webContents }, cid) => {
      const wc = webContents.fromId(cid);
      await wc.executeJavaScript('document.getElementById("user").value = "p@example.com"; document.getElementById("pw").value = "private-secret"');
      const done = new Promise((r) => wc.once('did-finish-load', r));
      await wc.executeJavaScript('document.getElementById("f").requestSubmit()');
      await done;
      return wc.executeJavaScriptInIsolatedWorld(1077, [{ code: 'typeof window.__lumenPasswords' }]);
    }, priv.contentsId);
    await sleep(400);
    const list = await app.evaluate(() => global.__passwords.vault.list());
    check('a private window never watches or saves', privWorld === 'undefined' && list.length === 1 && !list.some((l) => l.username === 'p@example.com'), `${privWorld} ${JSON.stringify(list)}`);
  } else check('a private window opened for the check', false, JSON.stringify(await app.evaluate(() => global.__private.list())));

  // ---- Never for this site ----
  const t4 = await open(`${base}/login`);
  await waitFor(async () => (await pwWorld(t4, 'typeof window.__lumenPasswords')) === 'object');
  await signIn(t4, 'bob@example.com', 'bob-pw-123');
  await waitFor(async () => (await stateOf(t4))?.offer);
  await app.evaluate((_e, i) => { global.__agent.browser.switchTab(i); global.__passwords.act(global.__translate.tab(i), 'never'); }, t4);
  check('Never for this site is remembered (site only) and nothing is saved', (settingsJson().passwordsNever || []).includes(site) && (await app.evaluate(() => global.__passwords.vault.count())) === 1, JSON.stringify(settingsJson().passwordsNever));
  const t5 = await open(`${base}/login`);
  await sleep(400);
  check('a Never site gets no watcher (but saved logins still fill)', (await pwWorld(t5, 'typeof window.__lumenPasswords')) === 'undefined' && (await stateOf(t5))?.saved === 1, JSON.stringify(await stateOf(t5)));

  // ---- the settings page ----
  const sid = await app.evaluate(() => global.__settings.open('passwords'));
  const sWc = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err.message}`; } }, [sid, code]);
  await waitFor(async () => (await sWc('document.body?.dataset.ready === "1" && document.querySelectorAll("#passwords-list .item").length === 1')) === true);
  const row = await sWc('document.querySelector("#passwords-list .item")?.textContent || ""');
  check('Settings lists the login (site, username) with the password hidden', row.includes(site) && row.includes('alice@example.com') && !row.includes(SECRET), row);
  await app.evaluate(() => { global.__passwordsReauth = async () => false; });
  await sWc('[...document.querySelectorAll("#passwords-list button")].find((b) => b.textContent === "Show").click()');
  await sleep(400);
  check('Show without passing re-authentication shows nothing', !(await sWc('document.getElementById("passwords-list").textContent')).includes(SECRET), '');
  await app.evaluate(() => { global.__passwordsReauth = async () => true; });
  await sWc('[...document.querySelectorAll("#passwords-list button")].find((b) => b.textContent === "Show").click()');
  check('Show after re-authentication shows the password', await waitFor(async () => (await sWc('document.getElementById("passwords-list").textContent')).includes(SECRET)), '');
  const pageApi = await inTab(t3, 'typeof window.lumenSettings');
  check('web pages have no settings API', pageApi === 'undefined', pageApi);

  // ---- turning it off ----
  await app.evaluate(() => { global.__passwordsConfirm = async ({ buttons }) => { global.__pwConfirmButtons = buttons; return 0; }; });
  const off = await app.evaluate(() => global.__passwords.setEnabled(false));
  check('turning off asks, and Keep (the default) keeps the saved passwords', !off.enabled && off.count === 1 && fs.existsSync(vaultFile) && settingsJson().savePasswords === false, JSON.stringify(off));
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), t2);
  check('off: the key button goes', await waitFor(() => ui.$eval('#passwords-btn', (b) => b.hidden)), '');
  const t6 = await open(`${base}/login`);
  await sleep(400);
  check('off: new pages aren\'t watched', (await pwWorld(t6, 'typeof window.__lumenPasswords')) === 'undefined', '');

  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
