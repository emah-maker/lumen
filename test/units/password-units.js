// [passwords] Plain Node checks for saved passwords (features/passwords.js, features/password-page.js):
// which pages may offer to save or fill (https only, never private / research / Lumen's own pages), the
// sign-in form rules, where a fill goes, CSV import, the vault's encrypt/decrypt round trip over a
// stand-in cipher (no plaintext on disk, a file it can't decrypt left alone), off by default, the
// settings calls, and the AI side: run_script refused after a fill, nothing AI-facing requires the vault.
// No Electron window; a temp folder, never the real profile.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
module.exports = async function passwordUnits(check) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const P = require('../../src/features/passwords');
  const PG = require('../../src/features/password-page');
  const root = path.join(__dirname, '..', '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

  // ---- sites: exact host (www dropped), https only, http only on localhost
  const sites = [
    ['https://accounts.example.com/login', 'accounts.example.com'],
    ['https://www.example.com/', 'example.com'],
    ['https://Example.COM./x', 'example.com'],
    ['https://example.com:8443/', 'example.com:8443'],
    ['http://localhost:3000/login', 'localhost:3000'],
    ['http://app.localhost/', 'app.localhost'],
    ['http://127.0.0.1:8080/', '127.0.0.1:8080'],
    ['http://[::1]:5000/', '[::1]:5000'],
    ['http://example.com/login', ''],
    ['https://user:pw@example.com/', ''],
    ['lumen://settings', ''], ['file:///Users/me/login.html', ''], ['data:text/html,<input type=password>', ''], ['chrome://settings', ''], ['about:blank', ''], ['javascript:alert(1)', ''],
  ];
  for (const [url, want] of sites) check(`passwords: site of ${url} is ${want || '(none)'}`, P.siteOf(url) === want, P.siteOf(url));
  check('passwords: exact host, not the registrable domain', P.siteOf('https://shop.example.com/') !== P.siteOf('https://accounts.example.com/'), '');

  // ---- where it may offer: off by default, never private / isolated / internal / AI tabs / insecure
  const ok = { url: 'https://example.com/login', enabled: true };
  check('passwords: an ordinary https tab may offer when it is on', P.verdict(ok).ok && P.verdict(ok).site === 'example.com', JSON.stringify(P.verdict(ok)));
  check('passwords: off by default (nothing enabled: nothing offered)', P.verdict({ url: ok.url }).reason === 'off', JSON.stringify(P.verdict({ url: ok.url })));
  check('passwords: never in private windows', P.verdict({ ...ok, privateWindow: true }).reason === 'private', '');
  check('passwords: never in research tabs (isolated partition)', P.verdict({ ...ok, isolated: true }).reason === 'isolated', '');
  check('passwords: never on the settings tab or Lumen\'s own pages', P.verdict({ ...ok, settings: true }).reason === 'internal' && P.verdict({ ...ok, internal: true }).reason === 'internal', '');
  check('passwords: never in a tab the AI opened to read signed in', P.verdict({ ...ok, aiTab: true }).reason === 'ai', '');
  check('passwords: never on plain http (other than localhost)', P.verdict({ ...ok, url: 'http://example.com/login' }).reason === 'not-secure' && P.verdict({ ...ok, url: 'http://localhost:3000/' }).ok, '');
  const SB = require('../../src/settings/settings-backend');
  check('passwords: not a generic setting (prefs:set can\'t turn it on)', !('savePasswords' in SB.DEFAULTS) && !('passwordsNever' in SB.DEFAULTS), '');
  check('passwords: lumen://settings/passwords opens the sub-page', SB.SECTION_LINKS.includes('passwords'), '');

  // ---- the sign-in rules (duck-typed fields)
  let order = 0;
  const f = (type, value, extra = {}) => ({ type, value, autocomplete: '', name: '', id: '', visible: true, form: 0, order: order++, readOnly: false, disabled: false, ...extra });
  order = 0;
  let got = PG.pickCredentials([f('text', 'search me', { form: -1 }), f('email', 'me@example.com'), f('password', 'hunter2'), f('submit', 'Sign in')]);
  check('forms: a login form gives its username and password', got && got.username === 'me@example.com' && got.password === 'hunter2', JSON.stringify(got));
  order = 0;
  got = PG.pickCredentials([f('text', 'me'), f('password', 's3cret!'), f('password', 's3cret!')]);
  check('forms: a sign-up form (password + confirm) saves the new password', got && got.username === 'me' && got.password === 's3cret!', JSON.stringify(got));
  order = 0;
  got = PG.pickCredentials([f('text', 'me'), f('password', 'old', { autocomplete: 'current-password' }), f('password', 'new1', { autocomplete: 'new-password' }), f('password', 'new1')]);
  check('forms: a change-password form saves the new one (autocomplete new-password)', got && got.password === 'new1', JSON.stringify(got));
  order = 0;
  check('forms: no filled password field: nothing to save', PG.pickCredentials([f('text', 'me'), f('password', '')]) === null && PG.pickCredentials([f('email', 'a@b.c')]) === null, '');
  order = 0;
  check('forms: a hidden password field is not a sign-in', PG.pickCredentials([f('text', 'me'), f('password', 'x', { visible: false })]) === null, '');
  order = 0;
  check('forms: one-time codes, card numbers and CAPTCHAs are never saved', PG.pickCredentials([f('password', '123456', { autocomplete: 'one-time-code' })]) === null
    && PG.pickCredentials([f('password', '4111', { autocomplete: 'cc-number' })]) === null && PG.pickCredentials([f('password', '999', { name: 'otp' })]) === null, '');
  order = 0;
  got = PG.pickCredentials([f('hidden', 'me@example.com', { autocomplete: 'username', visible: false }), f('password', 'pw')]);
  check('forms: step two of a two-step sign-in finds the hidden username', got && got.username === 'me@example.com', JSON.stringify(got));
  order = 0;
  got = PG.pickCredentials([f('text', 'newsletter@x.com', { form: 1 }), f('password', 'pw', { form: 2 })]);
  check('forms: a text field in another form is not the username', got && got.username === '', JSON.stringify(got));
  order = 0;
  got = PG.pickCredentials([f('text', 'nick'), f('email', 'me@x.com', { autocomplete: 'username' }), f('text', 'remember'), f('password', 'pw')]);
  check('forms: autocomplete="username" wins over the nearest field', got && got.username === 'me@x.com', JSON.stringify(got));
  check('forms: an over-long password is ignored', PG.pickCredentials([f('password', 'x'.repeat(P.MAX_PASSWORD + 1))]) === null, '');

  // ---- where a fill goes
  order = 0;
  let fields = [f('search', ''), f('email', ''), f('password', ''), f('password', '', { form: 1, autocomplete: 'new-password' })];
  let target = PG.fillTargets(fields);
  check('fill: the username field before the password field, same form', target && target.username === 1 && target.password === 2, JSON.stringify(target));
  target = PG.fillTargets(fields, 3);
  check('fill: the focused password field is the one filled', target && target.password === 3, JSON.stringify(target));
  order = 0;
  fields = [f('password', '', { autocomplete: 'new-password' }), f('password', '', { autocomplete: 'current-password' })];
  check('fill: current-password is preferred over new-password', PG.fillTargets(fields).password === 1, JSON.stringify(PG.fillTargets(fields)));
  order = 0;
  fields = [f('email', '', { autocomplete: 'username' })];
  check('fill: step one of a two-step sign-in fills the username only', JSON.stringify(PG.fillTargets(fields)) === JSON.stringify({ username: 0, password: -1 }), JSON.stringify(PG.fillTargets(fields)));
  order = 0;
  check('fill: nowhere to put it (read-only, hidden, no fields)', PG.fillTargets([f('password', '', { readOnly: true }), f('password', '', { visible: false })]) === null && PG.fillTargets([]) === null, '');
  const fillCode = PG.fill('me', 'p"w\\</script>');
  check('fill: values go into the script as JSON strings, and it never submits', fillCode.includes(JSON.stringify('p"w\\</script>')) && !/\.submit\(|requestSubmit|\.click\(\)/.test(fillCode), '');
  check('fill: the page scripts compile', (() => { try { new Function(PG.watch()); new Function(PG.fill('a', 'b')); new Function(PG.FLUSH); return true; } catch (err) { return err.message; } })() === true, '');
  check('page world: its own isolated world, not the AI\'s (1001) or the skills world (1002)', ![0, 1001, 1002].includes(PG.PASSWORD_WORLD) && /CLAUDE_WORLD = 1001/.test(read('src/ai/agent.js')) && /SKILL_WORLD = 1002/.test(read('src/main.js')), PG.PASSWORD_WORLD);

  // ---- CSV import
  const csv = P.parseCsv('﻿a,"b,c","d ""q"" e","multi\nline"\r\n1,2,3,4\n\n');
  check('csv: quotes, commas, escaped quotes, line breaks in quotes, CRLF, BOM, blank lines', JSON.stringify(csv) === JSON.stringify([['a', 'b,c', 'd "q" e', 'multi\nline'], ['1', '2', '3', '4']]), JSON.stringify(csv));
  const chrome = P.importCsv('name,url,username,password,note\nexample.com,https://www.example.com/login,me@example.com,"pa,ss",\nApp,android://abc@com.app/,u,p,\nOld,http://insecure.example/,u,p,\nLocal,http://localhost:3000/,dev,devpw,\nBare,shop.example.org,buyer,pw2,\n');
  check('csv: a Chrome export imports its web logins, skips apps and plain http', !chrome.error && chrome.logins.length === 3 && chrome.skipped === 2
    && chrome.logins[0].site === 'example.com' && chrome.logins[0].password === 'pa,ss' && chrome.logins[1].site === 'localhost:3000' && chrome.logins[2].site === 'shop.example.org', JSON.stringify(chrome));
  const apple = P.importCsv('Title,URL,Username,Password,Notes,OTPAuth\nMy bank,https://bank.example/,me,pw,,\n');
  check('csv: an Apple Passwords export imports', apple.logins?.length === 1 && apple.logins[0].site === 'bank.example' && apple.logins[0].username === 'me', JSON.stringify(apple));
  check('csv: a file without url, username and password columns is refused', P.importCsv('a,b\n1,2\n').error === 'columns' && P.importCsv('').error === 'empty', '');

  // ---- the vault over a stand-in cipher: round trip, no plaintext on disk
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-password-units-'));
  const file = path.join(dir, P.FILE_NAME);
  let available = true;
  let backend = 'keychain';
  const MARK = Buffer.from('FAKE-OS-ENCRYPTED:');
  const cipher = {
    available: () => available,
    backend: () => backend,
    encrypt: (text) => Buffer.concat([MARK, Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a))]),
    decrypt: (buf) => {
      if (!buf.subarray(0, MARK.length).equals(MARK)) throw new Error('not ours');
      return Buffer.from(buf.subarray(MARK.length).map((b) => b ^ 0x5a)).toString('utf8');
    },
  };
  let clock = 1000;
  const vault = P.createVault({ file, cipher, now: () => clock });
  check('vault: empty before anything is saved, and no file', vault.list().length === 0 && !fs.existsSync(file), '');
  const first = vault.upsert({ site: 'example.com', username: 'me@example.com', password: 'correct horse battery' });
  clock = 2000;
  vault.upsert({ site: 'shop.example.org', username: '', password: 'second-secret' });
  const onDisk = fs.readFileSync(file);
  check('vault: the file holds no password, username or site in plain text', !['correct horse battery', 'me@example.com', 'example.com', 'second-secret'].some((s) => onDisk.includes(Buffer.from(s))), onDisk.toString('utf8').slice(0, 80));
  if (process.platform !== 'win32') check('vault: the file is readable by this user only (0600)', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  const again = P.createVault({ file, cipher });
  check('vault: encrypt/decrypt round trip (a fresh vault reads the same logins)', again.get(first.entry.id)?.password === 'correct horse battery' && again.list().length === 2, JSON.stringify(again.list()));
  check('vault: list() and forSite() carry no passwords', again.list().every((e) => !('password' in e)) && again.forSite('example.com').every((e) => !('password' in e)), JSON.stringify(again.list()));
  clock = 3000;
  const upd = vault.upsert({ site: 'example.com', username: 'me@example.com', password: 'new horse' });
  check('vault: the same site and username updates the one login', !upd.created && vault.count('example.com') === 1 && vault.find('example.com', 'me@example.com').password === 'new horse', JSON.stringify(vault.list()));
  vault.update(first.entry.id, { username: 'renamed' });
  check('vault: Edit changes the username and keeps the password', vault.get(first.entry.id).username === 'renamed' && vault.get(first.entry.id).password === 'new horse', '');
  let threw = false;
  try { vault.upsert({ site: 'bad site', username: 'x', password: 'y' }); } catch { threw = true; }
  check('vault: an invalid site is refused', threw, '');
  const before = fs.readFileSync(file);
  available = false;
  threw = false;
  try { vault.upsert({ site: 'example.com', username: 'x', password: 'plain-y' }); } catch { threw = true; }
  check('vault: without OS encryption nothing is written (no plaintext fallback)', threw && fs.readFileSync(file).equals(before) && !fs.readdirSync(dir).some((n) => fs.readFileSync(path.join(dir, n)).includes(Buffer.from('plain-y'))), '');
  available = true;
  const junk = path.join(dir, 'other.bin');
  fs.writeFileSync(junk, 'not encrypted by us');
  const broken = P.createVault({ file: junk, cipher });
  threw = false;
  try { broken.list(); } catch { threw = true; }
  let wrote = false;
  try { broken.upsert({ site: 'example.com', username: 'a', password: 'b' }); wrote = true; } catch {}
  check('vault: a file it can\'t decrypt is left exactly as it was', threw && !wrote && fs.readFileSync(junk, 'utf8') === 'not encrypted by us', '');
  vault.remove(first.entry.id);
  check('vault: Delete takes one login out', vault.count() === 1, JSON.stringify(vault.list()));
  vault.clear();
  check('vault: Delete all removes the file', !fs.existsSync(file) && vault.count() === 0, '');

  // ---- the runtime with stand-ins for Electron
  let settings = {};
  const confirms = [];
  let confirmAnswer = 0;
  let reauthOk = true;
  const clip = { text: '', writeText(t) { this.text = t; }, readText() { return this.text; }, clear() { this.text = ''; } };
  const wcFake = (url) => ({ url, isDestroyed: () => false, isLoading: () => false, getURL() { return this.url; }, on() {}, executeJavaScriptInIsolatedWorld: async () => null });
  const tab = { id: 1, view: { webContents: wcFake('https://example.com/login') } };
  const privTab = { id: 2, view: { webContents: wcFake('https://example.com/login') } };
  const ipc = {};
  const rt = P.createPasswords({
    file: path.join(dir, 'rt.bin'), cipher, readSettings: () => ({ ...settings }), writeSettings: (v) => { settings = v; },
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key), sendTabs: () => {},
    tabOf: (wc) => [tab, privTab].find((x) => x.view.webContents === wc) || null,
    facts: (x) => ({ isolated: x === privTab }), allTabs: () => [tab, privTab],
    popupMenu: () => {}, openSettings: () => {}, reauth: async () => reauthOk,
    confirm: async (opts) => { confirms.push(opts); return confirmAnswer; }, notify: () => {}, clipboard: clip, pickCsv: async () => null,
    outsideDriver: () => false, isSettingsSender: (event) => event === 'settings-page',
  });
  rt.register({ handle: (ch, fn) => { ipc[ch] = fn; } });
  const call = (ch, ...args) => ipc[ch]('settings-page', ...args);
  const mainList = /PASSWORD_CHANNELS = \[([^\]]*)\]/.exec(read('src/main.js'))?.[1].match(/'([a-z-]+)'/g).map((c) => `settings:passwords-${c.slice(1, -1)}`) || [];
  check('runtime: main.js registers exactly the settings channels the module answers', JSON.stringify(mainList.sort()) === JSON.stringify(rt.channels().sort()), `${mainList} vs ${rt.channels()}`);
  check('runtime: the module isn\'t loaded at startup unless it is on', /if \(readSettings\(\)\.savePasswords === true\) passwords\(\);/.test(read('src/main.js')) && !/^const .*require\('\.\/features\/passwords'\)/m.test(read('src/main.js')), '');
  check('runtime: off by default', !rt.enabled() && rt.stateOf(tab) === null && settings.savePasswords === undefined, JSON.stringify(settings));
  check('runtime: settings channels only, each refusing anything but the settings page', Object.keys(ipc).every((ch) => ch.startsWith('settings:passwords-'))
    && (() => { try { ipc['settings:passwords-list']('a-web-page'); return false; } catch { return true; } })(), Object.keys(ipc).join());
  available = false;
  let st = await call('settings:passwords-set-enabled', true);
  check('runtime: refuses to turn on without OS encryption, and says why', st.refused === 'unavailable' && !st.enabled && settings.savePasswords !== true, JSON.stringify(st));
  available = true;
  backend = 'basic_text';
  st = await call('settings:passwords-set-enabled', true);
  check('runtime: refuses Linux\'s basic_text store (a fixed key is no protection)', st.refused === 'basic-text' && !st.enabled, JSON.stringify(st));
  backend = 'keychain';
  st = await call('settings:passwords-set-enabled', true);
  check('runtime: turns on with OS encryption', st.enabled && settings.savePasswords === true, JSON.stringify(st));
  st = await call('settings:passwords-set-enabled', 'yes');
  check('runtime: only a real true turns it on (anything else is off)', !st.enabled, JSON.stringify(st));
  await call('settings:passwords-set-enabled', true);

  rt.vault.upsert({ site: 'example.com', username: 'me', password: 'pw-1' });
  const s1 = rt.stateOf(tab);
  check('runtime: the key button shows on a site with saved logins, with no password in the state', s1 && s1.saved === 1 && !JSON.stringify(s1).includes('pw-1'), JSON.stringify(s1));
  check('runtime: nothing in a research (isolated) tab', rt.stateOf(privTab) === null, JSON.stringify(rt.stateOf(privTab)));
  check('runtime: no page is marked filled until the user fills one', !rt.filledIn(tab.view.webContents), '');
  const filled = await rt.fillLogin(tab, rt.vault.list()[0].id);
  check('runtime: a fill marks the page, so run_script refuses it', rt.filledIn(tab.view.webContents) && filled === null, String(filled));
  tab.view.webContents.url = 'https://other.example/';
  check('runtime: the mark is per site: another site in the tab isn\'t marked', !rt.filledIn(tab.view.webContents), '');
  tab.view.webContents.url = 'https://example.com/account';
  check('runtime: back on the filled site (the back/forward cache can restore the field), still marked', rt.filledIn(tab.view.webContents), '');
  check('runtime: never fills into an isolated tab', (await rt.fillLogin(privTab, rt.vault.list()[0].id)) === 'none' && !rt.filledIn(privTab.view.webContents), '');
  const list = await call('settings:passwords-list');
  check('runtime: the settings list has site and username, never the password', list.length === 1 && list[0].site === 'example.com' && !JSON.stringify(list).includes('pw-1'), JSON.stringify(list));
  reauthOk = false;
  check('runtime: Show without re-authentication gives nothing', (await call('settings:passwords-reveal', list[0].id)) === null && (await call('settings:passwords-copy', list[0].id)) === false && clip.text === '', '');
  reauthOk = true;
  check('runtime: Show after re-authentication gives the password; Copy puts it on the clipboard', (await call('settings:passwords-reveal', list[0].id)) === 'pw-1' && (await call('settings:passwords-copy', list[0].id)) === true && clip.text === 'pw-1', '');
  check('runtime: malformed ids and edits are refused', (await call('settings:passwords-reveal', '../x')) === null
    && (() => { try { ipc['settings:passwords-update']('settings-page', list[0].id, { username: 'a\u0000b' }); return false; } catch { return true; } })(), '');
  confirmAnswer = 0;
  st = await call('settings:passwords-set-enabled', false);
  check('runtime: turning off asks whether to delete, and Keep (the default) keeps them', !st.enabled && confirms.length === 1 && confirms[0].defaultId === 0 && rt.vault.count() === 1, JSON.stringify({ st, confirms }));
  check('runtime: off: no key button, no fill', rt.stateOf(tab) === null && (await rt.fillLogin(tab, list[0].id)) === 'none', '');
  await call('settings:passwords-set-enabled', true);
  confirmAnswer = 1;
  st = await call('settings:passwords-set-enabled', false);
  check('runtime: turning off with Delete removes them', rt.vault.count() === 0 && !fs.existsSync(path.join(dir, 'rt.bin')), JSON.stringify(st));
  await call('settings:passwords-set-enabled', true);
  rt.vault.upsert({ site: 'example.com', username: 'me', password: 'pw-2' });
  confirmAnswer = 0;
  await call('settings:passwords-delete-all');
  check('runtime: Delete all asks first; Cancel keeps them', rt.vault.count() === 1, '');
  confirmAnswer = 1;
  await call('settings:passwords-delete-all');
  check('runtime: Delete all, confirmed, removes them', rt.vault.count() === 0, '');
  check('runtime: Never for this site is stored validated, and Remove takes it out', P.cleanNever(['example.com', 'bad site', 'example.com', 'lumen://x']).join() === 'example.com'
    && (await call('settings:passwords-never-remove', 'example.com')).never.length === 0, '');

  // ---- importing a Google Password Manager or Safari export (test/fixtures/passwords, no real passwords)
  const googleCsv = read('test/fixtures/passwords/google.csv');
  const safariCsv = read('test/fixtures/passwords/safari.csv');
  const g = P.importCsv(googleCsv);
  const sf = P.importCsv(safariCsv);
  check('import: the header tells Google, Safari and other exports apart', g.source === 'google' && sf.source === 'safari' && P.importCsv('url,username,password\nhttps://a.example/,u,p\n').source === 'other', `${g.source} ${sf.source}`);
  check('import: Google: web logins kept, an Android app, plain http and an empty password skipped', g.logins.length === 3 && g.skipped === 3 && g.logins[2].password === 'fixture,pw-2', JSON.stringify({ n: g.logins.length, skipped: g.skipped }));
  check('import: Safari: BOM, bare host, a note across lines; notes and OTP secrets never kept', sf.logins.length === 3 && sf.logins[2].site === 'mail.example.net' && !JSON.stringify(sf.logins).includes('FIXTURE') && !JSON.stringify(sf.logins).includes('line note'), JSON.stringify(sf.logins.map((l) => l.site)));
  let plan = P.planImport(g.logins, () => null);
  check('import plan: www.example.com and example.com are one login (a duplicate, merged)', plan.add.length === 2 && plan.duplicates === 1 && plan.same === 0 && plan.replace.length === 0, JSON.stringify(plan));
  const saved = { 'example.com\nalice@example.com': { password: 'fixture-pw-1' } };
  plan = P.planImport(sf.logins, (site, username) => saved[`${site}\n${username}`] || null);
  check('import plan: a login saved with another password is a conflict, not a new one', plan.add.length === 2 && plan.replace.length === 1 && plan.replace[0].password === 'fixture-pw-changed', JSON.stringify(plan));
  plan = P.planImport(g.logins, (site, username) => saved[`${site}\n${username}`] || null);
  check('import plan: the same password already saved counts as already saved', plan.same === 1 && plan.add.length === 1, JSON.stringify(plan));
  plan = P.planImport([{ site: 'a.example', username: 'u', password: 'one' }, { site: 'a.example', username: 'u', password: 'two' }], () => null);
  check('import plan: duplicates with different passwords: the last row wins', plan.add.length === 1 && plan.add[0].password === 'two' && plan.duplicates === 1, JSON.stringify(plan));

  // The whole flow over the runtime: pick -> preview -> merge -> offer to delete the file.
  const idir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-password-import-'));
  let isettings = {};
  let picked = null;
  const prompts = [];
  let answers = [];
  const trashed = [];
  const irt = P.createPasswords({
    file: path.join(idir, P.FILE_NAME), cipher, readSettings: () => ({ ...isettings }), writeSettings: (v) => { isettings = v; },
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key), sendTabs: () => {}, tabOf: () => null, facts: () => ({}), allTabs: () => [],
    popupMenu: () => {}, openSettings: () => {}, reauth: async () => true, notify: () => {}, clipboard: clip, outsideDriver: () => false, isSettingsSender: () => true,
    pickCsv: async () => picked, confirm: async (opts) => { prompts.push(opts); return answers.shift() ?? opts.cancelId; },
    trash: async (f) => { trashed.push(f); fs.rmSync(f, { force: true }); },
  });
  const copyFixture = (name) => { const to = path.join(idir, name); fs.copyFileSync(path.join(root, 'test/fixtures/passwords', name), to); return to; };
  picked = copyFixture('google.csv');
  answers = [0];
  let r = await irt.importFile();
  check('import flow: the preview comes first and Cancel saves nothing', r.cancelled && prompts.length === 1 && irt.vault.count() === 0 && !fs.existsSync(path.join(idir, P.FILE_NAME)) && isettings.savePasswords === undefined, JSON.stringify(r));
  check('import flow: the preview names the source and shows the count, new, duplicates and skipped', /preview\.google \{"count":2\}/.test(prompts[0].message)
    && /import\.new \{"count":2\}/.test(prompts[0].detail) && /duplicates \{"count":1\}/.test(prompts[0].detail) && /skipped \{"count":3\}/.test(prompts[0].detail) && /turnsOn/.test(prompts[0].detail)
    && prompts[0].cancelId === 0 && prompts[0].buttons.length === 2, JSON.stringify(prompts[0]));
  prompts.length = 0;
  answers = [1, 0];
  r = await irt.importFile();
  const onDiskImport = fs.readFileSync(path.join(idir, P.FILE_NAME));
  check('import flow: Import saves them encrypted (no password on disk) and turns Save passwords on', r.added === 2 && r.duplicates === 1 && r.skipped === 3 && r.turnedOn && isettings.savePasswords === true
    && irt.vault.count() === 2 && !['fixture-pw-1', 'fixture,pw-2', 'alice@example.com'].some((x) => onDiskImport.includes(Buffer.from(x))), JSON.stringify(r));
  check('import flow: then it suggests deleting the plain-text file (Move to Trash the default, closing keeps it)', prompts.length === 2 && /deleteFile \{"name":"google.csv"\}/.test(prompts[1].detail)
    && prompts[1].defaultId === 1 && prompts[1].cancelId === 0 && /trashFile/.test(prompts[1].buttons[1]) && !r.deleted && fs.existsSync(picked) && !trashed.length, JSON.stringify(prompts[1]));
  prompts.length = 0;
  picked = copyFixture('safari.csv');
  answers = [1, 1];
  r = await irt.importFile();
  check('import flow: a conflict offers Keep Lumen\'s (the default) or Use the File\'s', prompts[0].buttons.length === 3 && prompts[0].defaultId === 1 && /conflict \{"count":1\}/.test(prompts[0].detail) && /preview\.safari/.test(prompts[0].message), JSON.stringify(prompts[0]));
  check('import flow: Keep Lumen\'s adds the new ones and leaves the saved password alone', r.added === 2 && r.updated === 0 && r.kept === 1 && irt.vault.find('example.com', 'alice@example.com').password === 'fixture-pw-1' && irt.vault.count() === 4, JSON.stringify(r));
  check('import flow: Move to Trash removes the export', r.deleted && trashed.length === 1 && !fs.existsSync(picked), JSON.stringify(r));
  prompts.length = 0;
  picked = copyFixture('safari.csv');
  answers = [2, 0];
  r = await irt.importFile();
  check('import flow: Use the File\'s replaces only the conflicting password', r.added === 0 && r.updated === 1 && r.unchanged === 2 && irt.vault.find('example.com', 'alice@example.com').password === 'fixture-pw-changed' && irt.vault.count() === 4, JSON.stringify(r));
  prompts.length = 0;
  answers = [0];
  r = await irt.importFile();
  check('import flow: a file with nothing new skips the preview and still suggests deleting it', !r.cancelled && r.added === 0 && r.unchanged === 3 && prompts.length === 1 && /allSaved \{"count":3\}/.test(prompts[0].message), JSON.stringify({ r, prompts }));
  picked = path.join(idir, 'apps.csv');
  fs.writeFileSync(picked, 'name,url,username,password,note\nApp,android://x@com.app/,u,p,\n');
  r = await irt.importFile();
  check('import flow: a file with no web logins says so, with no preview', r.error === 'none' && r.skipped === 1, JSON.stringify(r));
  available = false;
  r = await irt.importFile();
  check('import flow: without OS encryption nothing is imported (no file is even asked for)', r.error === 'unavailable', JSON.stringify(r));
  available = true;
  picked = null;
  check('import flow: no file picked: nothing happens', (await irt.importFile()).cancelled === true, '');
  check('import: upsertMany writes once for the whole file', (() => { let writes = 0; const v = P.createVault({ file: path.join(idir, 'many.bin'), cipher, onChange: () => { writes++; } }); const res = v.upsertMany(g.logins.concat(sf.logins)); return writes === 1 && res.created === 4 && res.updated === 2; })(), '');
  check('import: from the ⋯ menu\'s Import submenu and from Settings (General and Saved passwords)', /label: t\('menu\.importPasswords'\), click: \(\) => importPasswordsFromMenu\(\)/.test(read('src/main.js'))
    && /id: 'import-passwords'/.test(read('src/renderer/settings.js')) && /id: 'passwords-import'/.test(read('src/renderer/settings.js')), '');
  check('import: only a file the user picks: Chrome\'s Login Data and other stores are never read', !/Login Data|logins\.json|key4\.db|find-generic-password|CredRead/.test(read('src/features/passwords.js')), '');
  fs.rmSync(idir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });

  // ---- isolation from the AI (static): nothing AI-facing reaches the vault
  for (const file of ['src/ai/agent.js', 'mcp.js', 'src/automation/mcp-http.js', 'src/ai/snapshot.js', 'src/ai/page-scripts.js', 'src/automation/automation.js', 'src/automation/cdp-inproc.js', 'src/ai/claude-code.js', 'src/ai/grok-build.js',
    'src/features/ai-agents.js', 'src/features/background-runner.js', 'src/features/background-agents.js', 'src/features/tabs-ask.js', 'src/features/mcp-client.js', 'src/features/chat-store.js', 'src/features/skills.js']) {
    check(`isolation: ${file} doesn't load the password vault`, !/require\([^)]*passwords?['"/]|password-page/.test(read(file)), '');
  }
  check('isolation: the Agent gets a yes/no only (passwordFilled), never the vault', /passwordFilled: \(wc\) => Boolean\(passwordsRt\?\.filledIn\(wc\)\)/.test(read('src/main.js'))
    && !/passwords\.(vault|fillLogin|stateOf|act)\b/.test(read('src/ai/agent.js')), '');
  check('isolation: read_page and find never read a password field\'s value', /!secretField\(el\)/.test(read('src/ai/page-scripts.js')) && /secretField\(entry\.el\) \? null : entry\.el\.value/.test(read('src/ai/page-scripts.js'))
    && /!secretField\(el\)/.test(read('src/ai/snapshot.js')), '');
  check('isolation: no password is logged', !/console\.(log|error|warn)\([^)]*password/i.test(read('src/features/passwords.js')) && !/console\./.test(read('src/features/password-page.js')), '');
  check('isolation: the browser UI gets no password (only site, count and username)', !/\.password\b/.test(read('src/renderer/passwords.js')) && /passwordsAct: \(action\) => ipcRenderer\.send\('passwords:act', action\),/.test(read('src/preload/preload.js')), '');
  check('isolation: outside CDP clients never see the settings tab', /userTabs: \(\) => tabs\.filter\(\(t\) => alive\(t\) && !t\.settings\)/.test(read('src/main.js')), '');

  // ---- run_script on a page where the user filled a password (the sidebar AI and MCP share this path)
  const { Agent } = require('../../src/ai/agent');
  const ran = [];
  const pageWc = { id: 7, isDestroyed: () => false, getURL: () => 'https://example.com/login', isLoading: () => false, executeJavaScript: async (code) => { ran.push(code); return '"ok"'; }, executeJavaScriptInIsolatedWorld: async () => null };
  let isFilled = true;
  const agent = new Agent({ activeTab: () => ({ id: 1, webContents: pageWc }), listTabs: () => [], passwordFilled: (wc) => wc === pageWc && isFilled }, () => null);
  let refused = '';
  try { await agent.runTool('run_script', { code: 'return document.querySelector("input[type=password]").value' }); } catch (err) { refused = err.message; }
  check('agent: run_script is refused on a page with a filled password, and the script never runs', /not available on this page/.test(refused) && ran.length === 0, refused);
  isFilled = false;
  let out;
  try { out = await agent.runTool('run_script', { code: 'return 1' }); } catch (err) { out = err.message; }
  check('agent: run_script runs where nothing was filled', ran.length === 1 && /ok/.test(out), out);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
};
