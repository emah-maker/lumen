// Saved chats must survive a second process on the same profile (plain Node, no Electron): the chat store never removes the
// whole folder, never deletes a file another writer's index lists, deletes only a few files per save and only after the
// index on disk was read again, and the History list drops a row whose file is gone. And a test or development run can
// never be given the installed Lumen's profile. (Cause of the 2026-10-10 loss: a second dev process on the real profile quit
// before the keychain was ready, and `saveChat()` in its before-quit handler took the "no keychain" branch and removed the
// whole chats folder.) Nothing here touches %APPDATA%: every folder is a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../src/features/chat-store');
const guard = require('../src/features/profile-guard');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chat-loss-'));
const enc = (t) => Buffer.from(t).toString('base64');
const dec = (b) => Buffer.from(b, 'base64').toString();
const snap = (text) => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }], settings: {} });
const hexId = (n) => n.toString(16).padStart(16, '0');
let clock = 1000;
const mk = (dir, opts = {}) => createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ++clock, ...opts });
const files = (dir) => fs.readdirSync(dir).filter((n) => /^[a-f0-9]{16}\.json$/.test(n)).sort();

// ---- clearAll never removes anything from disk
{
  const dir = path.join(root, 'a');
  const store = mk(dir);
  for (let i = 1; i <= 5; i++) store.save(hexId(i), snap(`chat ${i}`));
  store.clearAll();
  check('clearAll leaves the chat files and the index on disk', files(dir).length === 5 && fs.existsSync(path.join(dir, 'index.json')), files(dir).join());
  check('...and the chats are listed again afterwards', mk(dir).list().length === 5);
}

// ---- a keychain that is not available saves nothing and deletes nothing
{
  const dir = path.join(root, 'b');
  let up = true;
  const store = mk(dir, { available: () => up });
  store.save(hexId(1), snap('one'));
  up = false;
  check('save refuses while the keychain is unavailable', store.save(hexId(2), snap('two')) === false);
  store.remove('0000000000000099');
  check('the saved chat is still there', files(dir).length === 1);
}

// ---- prune: a second writer's chats are adopted, never deleted, and one save deletes at most a few files
{
  const dir = path.join(root, 'c');
  const a = mk(dir, { limit: 3 });
  for (let i = 1; i <= 3; i++) a.save(hexId(i), snap(`a${i}`));
  const b = mk(dir, { limit: 3 }); // another process, same folder
  b.save(hexId(10), snap('b10')); // b's own prune deletes the oldest (a1) after re-reading the index
  check('the second writer pruned past its limit', !fs.existsSync(path.join(dir, `${hexId(1)}.json`)), files(dir).join());
  a.save(hexId(4), snap('a4')); // a does not know b10: it must adopt it, not delete it, and not drop it from the index
  check('the first writer did not delete the chat the other one added', fs.existsSync(path.join(dir, `${hexId(10)}.json`)), files(dir).join());
  const ids = mk(dir).list().map((c) => c.id);
  check('and the index on disk still lists it', ids.includes(hexId(10)), ids.join());
}
{
  const dir = path.join(root, 'd');
  const a = mk(dir, { limit: 2 });
  a.save(hexId(1), snap('x1'));
  const b = mk(dir, { limit: 2 });
  b.save(hexId(20), snap('foreign')); // foreign to a, oldest by nothing: a must keep it even when over its limit
  a.save(hexId(2), snap('x2'));
  a.save(hexId(3), snap('x3'));
  a.save(hexId(4), snap('x4'));
  check('a chat added by another writer is never pruned', fs.existsSync(path.join(dir, `${hexId(20)}.json`)), files(dir).join());
}
{
  const dir = path.join(root, 'e');
  const store = mk(dir, { limit: 2 });
  for (let i = 1; i <= 8; i++) store.save(hexId(i), snap(`c${i}`));
  const before = files(dir).length;
  const small = mk(dir, { limit: 1 }); // a mistakenly small limit must not wipe the history in one go
  small.save(hexId(9), snap('c9'));
  check('one save deletes at most three files', before - (files(dir).length - 1) <= 3, `${before} -> ${files(dir).length}`);
}

// ---- prune and remove do nothing destructive when the index on disk can't be read
{
  const dir = path.join(root, 'f');
  const store = mk(dir, { limit: 2 });
  store.save(hexId(1), snap('1'));
  store.save(hexId(2), snap('2'));
  fs.writeFileSync(path.join(dir, 'index.json'), '{ not json'); // damaged behind our back
  store.save(hexId(3), snap('3')); // would prune chat 1
  check('no file is pruned while the index on disk is unreadable', fs.existsSync(path.join(dir, `${hexId(1)}.json`)), files(dir).join());
}

// ---- the History list drops an entry whose file is gone (and shows it again when the file returns)
{
  const dir = path.join(root, 'g');
  const store = mk(dir);
  store.save(hexId(1), snap('one'));
  store.save(hexId(2), snap('two'));
  const keep = fs.readFileSync(path.join(dir, `${hexId(1)}.json`));
  fs.rmSync(path.join(dir, `${hexId(1)}.json`));
  const fresh = mk(dir);
  check('a chat whose file is gone is marked missing', fresh.list().filter((c) => c.missing).map((c) => c.id).join() === hexId(1) && !fresh.list().find((c) => c.id === hexId(2)).missing, JSON.stringify(fresh.list().map((c) => [c.id, c.missing])));
  check('and it is not opened as an empty chat', fresh.load(hexId(1)) === null);
  fs.writeFileSync(path.join(dir, `${hexId(1)}.json`), keep);
  const later = mk(dir);
  check('the entry is still in the index: a restored file is no longer missing', later.list().length === 2 && !later.list().some((c) => c.missing));
}

// ---- remove deletes exactly the chat asked for
{
  const dir = path.join(root, 'h');
  const store = mk(dir);
  for (let i = 1; i <= 4; i++) store.save(hexId(i), snap(`r${i}`));
  store.remove(hexId(2));
  check('remove deletes one file', files(dir).join() === [1, 3, 4].map((i) => `${hexId(i)}.json`).join(), files(dir).join());
}

// ---- the profile guard: a test or development run never gets the installed Lumen's profile
{
  const appData = path.join(root, 'AppData', 'Roaming');
  const real = path.join(appData, 'Lumen');
  const base = { appData, defaultUserData: real, tmpdir: path.join(root, 'tmp'), mkdtemp: (p) => `${p}XYZ` };
  const c = (o) => guard.chooseProfile({ ...base, packaged: false, test: true, env: {}, ...o });
  check('guard: a test launch without CLAUDE_BROWSER_PROFILE gets a temp folder, not the real profile', /claude-browser-test-XYZ$/.test(c({}).dir) && !guard.isRealProfile(c({}).dir, guard.realProfiles(base)), JSON.stringify(c({})));
  check('guard: a throwaway CLAUDE_BROWSER_PROFILE is used as given', c({ env: { CLAUDE_BROWSER_PROFILE: path.join(root, 'p1') } }).dir === path.join(root, 'p1'));
  check('guard: CLAUDE_BROWSER_PROFILE naming the real profile is replaced by a temp folder', /claude-browser-test-XYZ$/.test(c({ env: { CLAUDE_BROWSER_PROFILE: real } }).dir));
  check('guard: ...also with a different spelling, or a folder inside it', /XYZ$/.test(c({ env: { CLAUDE_BROWSER_PROFILE: `${real}${path.sep}` } }).dir) && /XYZ$/.test(c({ env: { CLAUDE_BROWSER_PROFILE: path.join(real, 'sub') } }).dir));
  check('guard: ...and the old name\'s profile', /XYZ$/.test(c({ env: { CLAUDE_BROWSER_PROFILE: path.join(appData, 'Claude Browser') } }).dir));
  check('guard: a development run (no test variable) gets its own folder', c({ test: false }).dir === path.join(appData, 'Lumen-dev'), JSON.stringify(c({ test: false })));
  check('guard: LUMEN_DEV_REAL_PROFILE=1 is the one opt-in to the default profile', c({ test: false, env: { LUMEN_DEV_REAL_PROFILE: '1' } }) === null);
  check('guard: that opt-in does not apply to a test run', /XYZ$/.test(c({ env: { LUMEN_DEV_REAL_PROFILE: '1' } }).dir));
  check('guard: a packaged Lumen is left alone', c({ packaged: true, test: false }) === null && c({ packaged: true }) === null);

  // apply() with a fake app: nothing is created under the real profile, the environment variable follows
  const calls = {};
  const fakeApp = { isPackaged: false, getPath: (n) => (n === 'appData' ? appData : real), setPath: (n, v) => { calls[n] = v; } };
  const env = {};
  fs.mkdirSync(path.join(root, 'tmp2'), { recursive: true });
  guard.apply(fakeApp, { test: true, env, fs, os: { tmpdir: () => path.join(root, 'tmp2') } });
  check('guard.apply sets a temp userData and CLAUDE_BROWSER_PROFILE for a test run with no profile', calls.userData && calls.userData.startsWith(path.join(root, 'tmp2')) && env.CLAUDE_BROWSER_PROFILE === calls.userData, JSON.stringify({ calls, env }));
  check('guard.apply never created the real profile folder', !fs.existsSync(real));
}

// ---- main.js: the guard runs before anything reads userData, and the no-keychain branch deletes nothing
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const guardAt = main.indexOf("require('./features/profile-guard').apply(app");
  const firstUserData = main.indexOf("app.getPath('userData')");
  check('main.js applies the profile guard before the first userData read', guardAt > 0 && guardAt < firstUserData, `${guardAt} ${firstUserData}`);
  check('main.js never calls clearAll', !/chats\(\)\.clearAll\(/.test(main));
  check('main.js does not save (or clear) chats before the app is ready', /!app\.isReady\(\) \|\| !safeStorage\.isEncryptionAvailable\(\)\) return;/.test(main));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nAll chat-loss checks passed');
process.exit(failures ? 1 : 0);
