// [passwords] Importing passwords exported from Google Password Manager / Chrome and Safari
// (features/passwords.js importFile) end to end, with the fixture exports in test/fixtures/passwords
// (no real passwords). Checks: the ⋯ menu's Import submenu has "Passwords from a file…", the preview
// (count, new, duplicates, skipped) comes before anything is saved and Cancel saves nothing, Import
// saves them encrypted with safeStorage (no plaintext on disk) and turns Save passwords on, the offer to
// move the plain-text export to the Trash, a conflict (Keep Lumen's / Use the file's), and Settings →
// General → Import passwords showing what came in. A throwaway profile; windows stay invisible
// (LUMEN_TEST_BACKGROUND); the file picker and the dialogs are stand-ins.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(100); } return v; };

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-password-import-'));
  const exports = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-password-exports-'));
  const fixture = (name) => { const to = path.join(exports, name); fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'passwords', name), to); return to; };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: '' }, colorScheme: null });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const vaultFile = path.join(profile, 'passwords.bin');
  const settingsJson = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); } catch { return {}; } };
  // The picker returns `file`; each dialog gets the next answer (the cancel button when none is left) and is recorded.
  const stage = (file, answers) => app.evaluate((_e, [f, a]) => {
    global.__pwPrompts = [];
    const left = a.slice();
    global.__passwordsPickCsv = async () => f;
    global.__passwordsConfirm = async (opts) => { global.__pwPrompts.push(opts); return left.length ? left.shift() : opts.cancelId; };
  }, [file, answers]);
  const prompts = () => app.evaluate(() => global.__pwPrompts);

  // ---- the ⋯ menu's Import submenu ----
  const menu = await app.evaluate(() => global.__importMenu().map((i) => i.label));
  check('the Import submenu ends with "Passwords from a file…"', menu[menu.length - 1] === 'Passwords from a file…' && menu.includes('---'), JSON.stringify(menu));

  // ---- Google: preview, Cancel ----
  const google = fixture('google.csv');
  await stage(google, [0]);
  let r = await app.evaluate(() => global.__importPasswordsFromMenu());
  let p = await prompts();
  check('Google: the preview comes first, and Cancel saves nothing', r.cancelled && p.length === 1 && !fs.existsSync(vaultFile) && settingsJson().savePasswords === undefined, JSON.stringify(r));
  check('Google: the preview names Google Password Manager and shows the count, duplicates and skipped rows', /Import 2 passwords from Google Password Manager\?/.test(p[0].message)
    && /New: 2/.test(p[0].detail) && /Duplicates in the file, merged: 1/.test(p[0].detail) && /Skipped .*: 3/.test(p[0].detail) && /Save passwords will be turned on/.test(p[0].detail), JSON.stringify(p[0]));

  // ---- Google: Import, keep the file ----
  await stage(google, [1, 0]);
  r = await app.evaluate(() => global.__importPasswordsFromMenu());
  p = await prompts();
  await waitFor(() => settingsJson().savePasswords === true);
  const onDisk = fs.existsSync(vaultFile) ? fs.readFileSync(vaultFile) : Buffer.alloc(0);
  check('Google: Import saves 2 logins and turns Save passwords on', r.added === 2 && r.duplicates === 1 && r.turnedOn && settingsJson().savePasswords === true
    && (await app.evaluate(() => global.__passwords.vault.count())) === 2, JSON.stringify(r));
  check('Google: passwords.bin is encrypted (no password, username or site in plain text)', onDisk.length > 0 && !['fixture-pw-1', 'fixture,pw-2', 'alice@example.com', 'shop.example.org'].some((s) => onDisk.includes(Buffer.from(s))), onDisk.toString('utf8').slice(0, 60));
  check('Google: then it suggests deleting the plain-text export; Keep File keeps it', p.length === 2 && /Delete the exported file\?/.test(p[1].message) && /google\.csv holds your passwords in plain text/.test(p[1].detail)
    && p[1].buttons[1] === 'Move to Trash' && p[1].defaultId === 1 && p[1].cancelId === 0 && fs.existsSync(google) && !r.deleted, JSON.stringify(p[1]));
  check('nothing about the logins is in settings.json', !/fixture-pw|alice@example\.com/.test(JSON.stringify(settingsJson())), '');

  // ---- Safari: a conflict, Keep Lumen's, Move to Trash ----
  const safari = fixture('safari.csv');
  await stage(safari, [1, 1]);
  r = await app.evaluate(() => global.__importPasswordsFromMenu());
  p = await prompts();
  const kept = await app.evaluate(() => global.__passwords.vault.find('example.com', 'alice@example.com')?.password);
  check('Safari: the preview names Safari and offers Keep Lumen\'s or Use the file\'s', /from Safari\?/.test(p[0].message) && /different password: 1/.test(p[0].detail)
    && JSON.stringify(p[0].buttons) === JSON.stringify(['Cancel', 'Import, Keep Lumen’s', 'Import, Use the File’s']), JSON.stringify(p[0]));
  check('Safari: Keep Lumen\'s adds the new logins and keeps the saved password', r.added === 2 && r.kept === 1 && kept === 'fixture-pw-1' && (await app.evaluate(() => global.__passwords.vault.count())) === 4, JSON.stringify(r));
  check('Safari: Move to Trash removes the export', r.deleted && !fs.existsSync(safari), JSON.stringify(r));

  // ---- Settings → General → Import passwords: Use the file's ----
  const sid = await app.evaluate(() => global.__settings.open('general'));
  const sWc = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err.message}`; } }, [sid, code]);
  check('Settings → General has Import passwords', await waitFor(() => sWc('Boolean(document.getElementById("import-passwords"))')), '');
  const safari2 = fixture('safari.csv');
  await stage(safari2, [2, 1]);
  await sWc('document.getElementById("import-passwords").click()');
  const note = await waitFor(async () => { const t = await sWc('document.getElementById("import-passwords-status")?.textContent || ""'); return /Imported passwords/.test(t) && t; });
  const replaced = await app.evaluate(() => global.__passwords.vault.find('example.com', 'alice@example.com')?.password);
  check('Settings: Use the file\'s replaces the one conflicting password', replaced === 'fixture-pw-changed' && (await app.evaluate(() => global.__passwords.vault.count())) === 4, replaced);
  check('Settings: the note says what came in and that the file went to the Trash', /1 updated/.test(note) && /2 already saved/.test(note) && /safari\.csv was moved to the Trash/.test(note) && !fs.existsSync(safari2), note);
  check('Settings: no password ever reaches the page', !/fixture-pw/.test(await sWc('document.body.innerText')), '');

  // ---- a file that isn't a passwords export ----
  const bad = path.join(exports, 'notes.csv');
  fs.writeFileSync(bad, 'a,b\n1,2\n');
  await stage(bad, []);
  await app.evaluate(() => { global.__pwWarned = null; const show = global.__dialogs.showMessageBox; global.__dialogs.showMessageBox = async (w, o) => { global.__pwWarned = o; return { response: 0, cancelled: false }; }; global.__restoreDialogs = () => { global.__dialogs.showMessageBox = show; }; });
  r = await app.evaluate(() => global.__importPasswordsFromMenu());
  const warned = await app.evaluate(() => global.__pwWarned);
  await app.evaluate(() => global.__restoreDialogs());
  check('a file without the columns: no preview, a warning that says which exports work', r.error === 'columns' && (await prompts()).length === 0 && /Google Password Manager/.test(warned?.detail || '') && fs.existsSync(bad), JSON.stringify({ r, warned }));

  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  fs.rmSync(exports, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
