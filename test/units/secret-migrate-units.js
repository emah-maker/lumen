// Plain Node: the one-time migration of secrets saved before Electron 45 (features/secret-migrate.js). A profile written the
// old way (safeStorage.encryptString: settings keys, chats, memory, passwords, sync, tokens, project files, pictures,
// thumbnails), then migrate, then read back (also from a fresh box, as after a restart); a failure mid-way leaves that value
// exactly as it was and the rest move; a rerun moves what failed and nothing else. A stand-in safeStorage; no Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('../helpers/_tmp-cleanup');
const { createSecretBox } = require('../../src/features/secret-box');
const { migrateSecrets, replaceFile } = require('../../src/features/secret-migrate');
const { createChatStore } = require('../../src/features/chat-store');
const settingsFile = require('../../src/settings/settings-file');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const quiet = () => {};

// The keychain ("v10" + AES-GCM, as Electron writes on Windows). `fail` holds base64 blobs decryptStringAsync refuses (a value the
// keychain can't read right now); calls are counted to show the migration never uses the deprecated synchronous ones.
function fakeStorage(osKey = crypto.randomBytes(32)) {
  const calls = { sync: 0 };
  const fail = new Set();
  const enc = (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', osKey, iv); const body = Buffer.concat([c.update(String(s), 'utf8'), c.final()]); return Buffer.concat([Buffer.from('v10'), iv, c.getAuthTag(), body]); };
  const dec = (b) => { const d = crypto.createDecipheriv('aes-256-gcm', osKey, b.subarray(3, 15)); d.setAuthTag(b.subarray(15, 31)); return Buffer.concat([d.update(b.subarray(31)), d.final()]).toString('utf8'); };
  return {
    calls, fail,
    oldEncrypt: (s) => enc(s), // what Lumen 0.5.106 and earlier did (encryptString): the test's own seeding only
    encryptString: (s) => { calls.sync++; return enc(s); },
    decryptString: (b) => { calls.sync++; return dec(b); },
    isEncryptionAvailable: () => { calls.sync++; return true; },
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => enc(s),
    decryptStringAsync: async (b) => { if (fail.has(Buffer.from(b).toString('base64'))) throw new Error('keychain busy'); return { result: dec(b), shouldReEncrypt: false }; },
  };
}

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-migrate-units-'));
  const storage = fakeStorage();
  const old = (text) => storage.oldEncrypt(text).toString('base64');
  const J = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };

  // ---- a profile saved by an older Lumen
  const plain = {
    apiKeyEnc: 'sk-ant-old', openai: 'sk-openai-old', widget: 'todoist-old', telegram: '123:telegram-old', safebrowsing: 'AIza-old',
    memory: JSON.stringify({ entries: [{ id: 'm1', text: 'likes tea' }] }),
    places: JSON.stringify({ places: [] }),
    extToken: 'lumen-app-token-old', connector: 'canvas-token-old',
    passwords: JSON.stringify({ version: 1, entries: [{ password: 'hunter2' }] }), sync: 'sync passphrase',
    pfIndex: JSON.stringify({ files: [{ id: 'f1', name: 'notes.txt' }] }), pfBlob: JSON.stringify({ text: 'project text' }),
    img: Buffer.from('fake png bytes').toString('base64'), thumb: Buffer.from('thumb png').toString('base64'),
  };
  const settingsPath = path.join(ud, 'settings.json');
  J(settingsPath, { theme: 'dark', apiKeyEnc: old(plain.apiKeyEnc), keys: { openai: old(plain.openai), 'widget:todoist': old(plain.widget), telegram: old(plain.telegram), safebrowsing: old(plain.safebrowsing) } });
  J(path.join(ud, 'memory.json'), { enc: old(plain.memory) });
  J(path.join(ud, 'project-places.json'), { enc: old(plain.places) });
  J(path.join(ud, 'external-apps.json'), { version: 1, apps: [{ id: 'a1', name: 'Cursor', secret: old(plain.extToken) }] });
  J(path.join(ud, 'connectors.json'), { canvas: { on: true, token: old(plain.connector), host: 'https://school.instructure.com' } });
  fs.writeFileSync(path.join(ud, 'passwords.bin'), storage.oldEncrypt(plain.passwords));
  fs.writeFileSync(path.join(ud, 'sync-secret.bin'), storage.oldEncrypt(plain.sync));
  J(path.join(ud, 'project-files', 'p1', 'index.json'), { enc: old(plain.pfIndex) });
  J(path.join(ud, 'project-files', 'p1', 'f1.dat'), { enc: old(plain.pfBlob) });
  J(path.join(ud, 'generated-images', 'c1', 'pic.img'), { enc: old(plain.img), mime: 'image/png' });
  fs.mkdirSync(path.join(ud, 'office-thumb-cache'));
  fs.writeFileSync(path.join(ud, 'office-thumb-cache', 'k.thumb'), old(plain.thumb));
  const chatsDir = path.join(ud, 'chats');
  const chatId = 'aaaaaaaaaaaaaaaa';
  const chatSnap = { settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text: 'old chat' }] }] };
  J(path.join(chatsDir, `${chatId}.json`), { enc: old(JSON.stringify(chatSnap)) });
  J(path.join(chatsDir, 'index.json'), { enc: old(JSON.stringify({ current: chatId, chats: [{ id: chatId, title: 'old chat', created: 1, updated: 1 }] })) });

  // the app's pieces, as main.js wires them
  let settingsCache = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const readSettings = () => ({ ...settingsCache });
  const writeSettings = (s) => { settingsCache = { ...s }; settingsFile.writeJsonAtomic(settingsPath, s); };
  const keyFile = path.join(ud, 'secret-box.key');
  const box = createSecretBox({ safeStorage: storage, keyFile, log: quiet });
  await box.start({ warmList: [{ file: settingsPath }, { file: path.join(chatsDir, 'index.json') }] });
  let chatStore = null;
  const chats = () => (chatStore ||= createChatStore({ dir: chatsDir, encrypt: box.encrypt, decrypt: box.decrypt, decryptAsync: box.decryptAsync, isLegacy: box.isLegacy, available: box.available, onError: quiet }));
  const deps = { box, userData: ud, readSettings, writeSettings, chats, log: quiet, gapMs: 0 };
  const syncBefore = storage.calls.sync;

  // ---- run 1: the keychain refuses one value (memory.json) mid-way
  const memoryRaw = fs.readFileSync(path.join(ud, 'memory.json'), 'utf8');
  storage.fail.add(JSON.parse(memoryRaw).enc);
  const r1 = await migrateSecrets(deps);
  check('run 1: one value failed, the others moved', r1.failed === 1 && r1.migrated >= 15, JSON.stringify(r1));
  check('run 1: the failed file is left exactly as it was', fs.readFileSync(path.join(ud, 'memory.json'), 'utf8') === memoryRaw);
  const s1 = readSettings();
  check('settings keys are in the new format: apiKeyEnc, a provider key, widget:*, telegram, safebrowsing', [s1.apiKeyEnc, s1.keys.openai, s1.keys['widget:todoist'], s1.keys.telegram, s1.keys.safebrowsing].every((v) => !box.isLegacy(v)));
  check('…and read back to the same text', box.decrypt(s1.apiKeyEnc) === plain.apiKeyEnc && box.decrypt(s1.keys.openai) === plain.openai && box.decrypt(s1.keys['widget:todoist']) === plain.widget && box.decrypt(s1.keys.telegram) === plain.telegram && box.decrypt(s1.keys.safebrowsing) === plain.safebrowsing);
  check('…and settings.json on disk has them (non-secret settings untouched), with a .bak of the old file', JSON.parse(fs.readFileSync(settingsPath, 'utf8')).keys.openai === s1.keys.openai && JSON.parse(fs.readFileSync(settingsPath, 'utf8')).theme === 'dark' && fs.existsSync(`${settingsPath}.bak`));

  // ---- a restart: a fresh box with nothing warmed reads everything that moved, synchronously
  const fresh = createSecretBox({ safeStorage: storage, keyFile, log: quiet });
  await fresh.start();
  const rd = (file) => JSON.parse(fs.readFileSync(path.join(ud, file), 'utf8'));
  const tryRead = (fn) => { try { return fn(); } catch (e) { return `ERR ${e.message}`; } };
  check('after a restart: external app token', tryRead(() => fresh.decrypt(rd('external-apps.json').apps[0].secret)) === plain.extToken);
  check('after a restart: a connector token inside connectors.json (and its other fields kept)', tryRead(() => fresh.decrypt(rd('connectors.json').canvas.token)) === plain.connector && rd('connectors.json').canvas.host === 'https://school.instructure.com');
  check('after a restart: project places', tryRead(() => fresh.decrypt(rd('project-places.json').enc)) === plain.places);
  check('after a restart: passwords.bin (and no .bak of the old one is left: a password deleted later must not live on in it)', tryRead(() => fresh.decrypt(fs.readFileSync(path.join(ud, 'passwords.bin')))) === plain.passwords && !fs.existsSync(path.join(ud, 'passwords.bin.bak')));
  check('after a restart: sync-secret.bin', tryRead(() => fresh.decrypt(fs.readFileSync(path.join(ud, 'sync-secret.bin')))) === plain.sync);
  check('after a restart: a project\'s file list and a project file', tryRead(() => fresh.decrypt(rd(path.join('project-files', 'p1', 'index.json')).enc)) === plain.pfIndex && tryRead(() => fresh.decrypt(rd(path.join('project-files', 'p1', 'f1.dat')).enc)) === plain.pfBlob);
  check('after a restart: a generated picture (its mime kept)', tryRead(() => fresh.decrypt(rd(path.join('generated-images', 'c1', 'pic.img')).enc)) === plain.img && rd(path.join('generated-images', 'c1', 'pic.img')).mime === 'image/png');
  check('after a restart: a thumbnail', tryRead(() => fresh.decrypt(fs.readFileSync(path.join(ud, 'office-thumb-cache', 'k.thumb'), 'utf8'))) === plain.thumb);
  check('after a restart: the chat index and the chat file', tryRead(() => JSON.parse(fresh.decrypt(rd(path.join('chats', 'index.json')).enc)).chats[0].id) === chatId && tryRead(() => JSON.parse(fresh.decrypt(rd(path.join('chats', `${chatId}.json`)).enc)).messages[0].content[0].text) === 'old chat');
  check('per-item files leave no .bak once checked (a deleted chat or picture leaves no copy behind)', !fs.existsSync(path.join(chatsDir, `${chatId}.json.bak`)) && !fs.existsSync(path.join(ud, 'generated-images', 'c1', 'pic.img.bak')) && !fs.existsSync(path.join(ud, 'project-files', 'p1', 'f1.dat.bak')));
  check('no temp files are left', !fs.readdirSync(ud).some((f) => f.includes('.tmp')) && !fs.readdirSync(chatsDir).some((f) => f.includes('.tmp')));

  // ---- run 2: the keychain answers again; only what failed moves
  storage.fail.clear();
  const extBefore = fs.readFileSync(path.join(ud, 'external-apps.json'), 'utf8');
  const r2 = await migrateSecrets(deps);
  check('run 2 (rerun): nothing fails, and only the value that failed moves', r2.failed === 0 && r2.migrated === 1, JSON.stringify(r2));
  check('run 2: memory.json is now in the new format, same text', tryRead(() => fresh.decrypt(rd('memory.json').enc)) === plain.memory);
  check('run 2: files already moved are not written again', fs.readFileSync(path.join(ud, 'external-apps.json'), 'utf8') === extBefore);
  const r3 = await migrateSecrets(deps);
  check('run 3: nothing left to do', r3.failed === 0 && r3.migrated === 0, JSON.stringify(r3));
  check('the migration never called the deprecated synchronous safeStorage functions', storage.calls.sync === syncBefore, storage.calls.sync - syncBefore);

  // ---- a value whose new form doesn't read back is never written
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-migrate-units-'));
    const s = fakeStorage();
    const b = createSecretBox({ safeStorage: s, keyFile: path.join(dir, 'k'), log: quiet });
    await b.start();
    const before = JSON.stringify({ enc: s.oldEncrypt('x').toString('base64') });
    fs.writeFileSync(path.join(dir, 'memory.json'), before);
    const broken = { ...b, encrypt: () => b.encrypt('something else') }; // (an encrypt that doesn't give the text back)
    const r = await migrateSecrets({ box: broken, userData: dir, readSettings: () => ({}), writeSettings: () => { throw new Error('no settings write expected'); }, log: quiet, gapMs: 0 });
    check('a new value that doesn\'t read back: counted as failed, the file untouched', r.failed === 1 && fs.readFileSync(path.join(dir, 'memory.json'), 'utf8') === before, JSON.stringify(r));
  }

  // ---- replaceFile: never over a file that changed, and puts the .bak back when the check fails
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-migrate-units-'));
    const f = path.join(dir, 'a.img');
    fs.writeFileSync(f, 'current');
    check('replaceFile: a file changed since it was read is left alone', (await replaceFile(fs, f, Buffer.from('what was read'), Buffer.from('new'), () => true)) === false && fs.readFileSync(f, 'utf8') === 'current');
    check('replaceFile: a new file that fails its check is replaced by the .bak', (await replaceFile(fs, f, Buffer.from('current'), Buffer.from('bad'), () => false)) === false && fs.readFileSync(f, 'utf8') === 'current');
    check('replaceFile: a good one replaces it and its .bak goes', (await replaceFile(fs, f, Buffer.from('current'), Buffer.from('good'), (b) => b.toString() === 'good')) === true && fs.readFileSync(f, 'utf8') === 'good' && !fs.existsSync(`${f}.bak`));
  }

  // ---- no keychain: nothing happens, and it says so (main.js records no marker)
  {
    const r = await migrateSecrets({ box: { available: () => false }, userData: ud, readSettings, writeSettings, log: quiet });
    check('no keychain: nothing is touched and the run is not counted as done', r.unavailable === true && r.failed > 0 && r.migrated === 0);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
