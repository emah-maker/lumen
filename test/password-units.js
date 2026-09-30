// [passwords] Plain Node checks for saved passwords (features/passwords.js, features/password-page.js):
// which pages may offer to save or fill (https only, never private / research / Lumen's own pages), the
// sign-in form rules, where a fill goes, CSV import, the vault's encrypt/decrypt round trip over a
// stand-in cipher (no plaintext on disk, a file it can't decrypt left alone), off by default, the
// settings calls, and the AI side: run_script refused after a fill, nothing AI-facing requires the vault.
// No Electron window; a temp folder, never the real profile.
module.exports = async function passwordUnits(check) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const P = require('../features/passwords');
  const PG = require('../features/password-page');
  const root = path.join(__dirname, '..');
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
  const SB = require('../settings-backend');
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
  check('page world: its own isolated world, not the AI\'s (1001) or the skills world (1002)', ![0, 1001, 1002].includes(PG.PASSWORD_WORLD) && /CLAUDE_WORLD = 1001/.test(read('agent.js')) && /SKILL_WORLD = 1002/.test(read('main.js')), PG.PASSWORD_WORLD);

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
  const mainList = /PASSWORD_CHANNELS = \[([^\]]*)\]/.exec(read('main.js'))?.[1].match(/'([a-z-]+)'/g).map((c) => `settings:passwords-${c.slice(1, -1)}`) || [];
  check('runtime: main.js registers exactly the settings channels the module answers', JSON.stringify(mainList.sort()) === JSON.stringify(rt.channels().sort()), `${mainList} vs ${rt.channels()}`);
  check('runtime: the module isn\'t loaded at startup unless it is on', /if \(readSettings\(\)\.savePasswords === true\) passwords\(\);/.test(read('main.js')) && !/^const .*require\('\.\/features\/passwords'\)/m.test(read('main.js')), '');
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

  // ---- isolation from the AI (static): nothing AI-facing reaches the vault
  for (const file of ['agent.js', 'mcp.js', 'mcp-http.js', 'snapshot.js', 'page-scripts.js', 'automation.js', 'cdp-inproc.js', 'claude-code.js', 'grok-build.js',
    'features/ai-agents.js', 'features/background-runner.js', 'features/background-agents.js', 'features/tabs-ask.js', 'features/mcp-client.js', 'features/chat-store.js', 'features/skills.js']) {
    check(`isolation: ${file} doesn't load the password vault`, !/require\([^)]*passwords?['"/]|password-page/.test(read(file)), '');
  }
  check('isolation: the Agent gets a yes/no only (passwordFilled), never the vault', /passwordFilled: \(wc\) => Boolean\(passwordsRt\?\.filledIn\(wc\)\)/.test(read('main.js'))
    && !/passwords\.(vault|fillLogin|stateOf|act)\b/.test(read('agent.js')), '');
  check('isolation: read_page and find never read a password field\'s value', /!secretField\(el\)/.test(read('page-scripts.js')) && /secretField\(entry\.el\) \? null : entry\.el\.value/.test(read('page-scripts.js'))
    && /!secretField\(el\)/.test(read('snapshot.js')), '');
  check('isolation: no password is logged', !/console\.(log|error|warn)\([^)]*password/i.test(read('features/passwords.js')) && !/console\./.test(read('features/password-page.js')), '');
  check('isolation: the browser UI gets no password (only site, count and username)', !/\.password\b/.test(read('renderer/passwords.js')) && /passwordsAct: \(action\) => ipcRenderer\.send\('passwords:act', action\),/.test(read('preload.js')), '');
  check('isolation: outside CDP clients never see the settings tab', /userTabs: \(\) => tabs\.filter\(\(t\) => alive\(t\) && !t\.settings\)/.test(read('main.js')), '');

  // ---- run_script on a page where the user filled a password (the sidebar AI and MCP share this path)
  const { Agent } = require('../agent');
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
  fs.rmSync(dir, { recursive: true, force: true });
};
