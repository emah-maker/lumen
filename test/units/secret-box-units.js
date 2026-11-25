// Plain Node: the secret box (features/secret-box.js). A stand-in safeStorage that writes the real format ("v10" + AES-GCM) with
// both the old synchronous calls and the asynchronous ones, so values saved by Lumen before Electron 45 (encryptString) are shown to
// read back through the new path (decryptStringAsync), and the key file, the new format and the failure cases are checked. No Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('../helpers/_tmp-cleanup');
const { createSecretBox, legacyStrings, MAGIC } = require('../../src/features/secret-box');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'secret-box-units-'));
const quiet = () => {};

// The OS keychain: one key per "computer". encryptString (old, sync) and encryptStringAsync write the same "v10" format, as Electron
// does on Windows; calls are counted so the tests can tell that the box uses only the asynchronous ones.
function fakeStorage({ available = true, rotate = false, osKey = crypto.randomBytes(32) } = {}) {
  const calls = { sync: 0, async: 0 };
  const enc = (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', osKey, iv); const body = Buffer.concat([c.update(String(s), 'utf8'), c.final()]); return Buffer.concat([Buffer.from('v10'), iv, c.getAuthTag(), body]); };
  const dec = (b) => {
    if (b.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('not v10');
    const d = crypto.createDecipheriv('aes-256-gcm', osKey, b.subarray(3, 15)); d.setAuthTag(b.subarray(15, 31));
    return Buffer.concat([d.update(b.subarray(31)), d.final()]).toString('utf8');
  };
  return {
    calls,
    // the old calls (what Lumen used before): only the test itself uses them, to make "saved by an older Lumen" data
    encryptString: (s) => { calls.sync++; return enc(s); },
    decryptString: (b) => { calls.sync++; return dec(b); },
    isEncryptionAvailable: () => { calls.sync++; return available; },
    // the new ones
    isAsyncEncryptionAvailable: async () => { calls.async++; return available; },
    encryptStringAsync: async (s) => { calls.async++; if (!available) throw new Error('unavailable'); return enc(s); },
    decryptStringAsync: async (b) => { calls.async++; return { result: dec(b), shouldReEncrypt: rotate }; },
    getSelectedStorageBackend: () => 'gnome_libsecret',
  };
}

(async () => {
  // --- old data reads back (the critical one)
  {
    const dir = tmp();
    const storage = fakeStorage();
    // What an older Lumen left: settings keys, a chat index ({ enc }), passwords.bin (a raw blob)
    const apiKey = 'sk-ant-legacy-0123456789';
    const settings = { apiKeyEnc: storage.encryptString(apiKey).toString('base64'), keys: { openai: storage.encryptString('sk-openai-legacy').toString('base64'), 'widget:todoist': storage.encryptString('todo-token').toString('base64') }, theme: 'dark' };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    const index = { current: 'c1', chats: [{ id: 'c1', title: 'Hello' }] };
    fs.mkdirSync(path.join(dir, 'chats'));
    fs.writeFileSync(path.join(dir, 'chats', 'index.json'), JSON.stringify({ enc: storage.encryptString(JSON.stringify(index)).toString('base64') }));
    const passwords = JSON.stringify({ version: 1, entries: [{ origin: 'https://example.com', username: 'me', password: 'hunter2' }] });
    fs.writeFileSync(path.join(dir, 'passwords.bin'), storage.encryptString(passwords));
    const chatFile = { enc: storage.encryptString(JSON.stringify({ messages: [{ role: 'user', content: 'not warmed' }] })).toString('base64') };
    const syncBefore = storage.calls.sync;

    const box = createSecretBox({ safeStorage: storage, keyFile: path.join(dir, 'secret-box.key'), log: quiet });
    check('before start(): not available, and a read throws a transient error (never "empty")', !box.available() && (() => { try { box.decrypt(settings.apiKeyEnc); return false; } catch (e) { return e.transient === true; } })());
    await box.start({ warmList: [{ file: path.join(dir, 'settings.json') }, { file: path.join(dir, 'chats', 'index.json') }, { file: path.join(dir, 'passwords.bin'), kind: 'raw' }] });
    check('after start(): available', box.available() && box.isReady());
    check('an Anthropic key saved with encryptString reads back with the new box (synchronously, warmed)', box.decrypt(settings.apiKeyEnc) === apiKey);
    check('other provider and widget keys read back too', box.decrypt(settings.keys.openai) === 'sk-openai-legacy' && box.decrypt(settings.keys['widget:todoist']) === 'todo-token');
    check('an old chat index ({ enc }) reads back', JSON.parse(box.decrypt(JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'index.json'), 'utf8')).enc)).chats[0].title === 'Hello');
    check('old passwords.bin (a raw Buffer) reads back', JSON.parse(box.decrypt(fs.readFileSync(path.join(dir, 'passwords.bin')))).entries[0].password === 'hunter2');
    check('the box never calls the deprecated synchronous safeStorage functions', storage.calls.sync === syncBefore, storage.calls.sync - syncBefore);

    // An old value that was not warmed: the sync read says "not now" (transient), the async read waits, and a later sync read has it
    let first = null;
    try { box.decrypt(chatFile.enc); } catch (e) { first = e; }
    check('an old value nobody warmed: decrypt() throws a transient error, not a wrong answer', first?.transient === true && first?.code === 'SECRET_LOCKED', first);
    check('decryptAsync() reads it', JSON.parse(await box.decryptAsync(chatFile.enc)).messages[0].content === 'not warmed');
    check('and then decrypt() has it', JSON.parse(box.decrypt(chatFile.enc)).messages[0].content === 'not warmed');
    check('the old values read are counted (each is rewritten when its store next saves)', box.staleCount() >= 5, box.staleCount());

    // New writes: the new format, read back synchronously; never the plaintext; a fresh IV each time
    const a = box.encrypt('secret text');
    const b = box.encrypt('secret text');
    check('encrypt() writes the new format (MAGIC header), not the text', Buffer.from(a, 'base64').subarray(0, 4).equals(MAGIC) && !Buffer.from(a, 'base64').toString('latin1').includes('secret text'));
    check('two encryptions of one text differ (random IV)', a !== b);
    check('decrypt() reads the new format back', box.decrypt(a) === 'secret text' && box.decrypt(Buffer.from(b, 'base64')) === 'secret text');
    check('encryptBuffer() gives a Buffer that decrypt() reads', box.decrypt(box.encryptBuffer('ünïcødé ✓')) === 'ünïcødé ✓');
    check('isLegacy() tells the two formats apart', box.isLegacy(settings.apiKeyEnc) && !box.isLegacy(a));
    const tampered = Buffer.from(a, 'base64'); tampered[tampered.length - 1] ^= 1;
    let tamperErr = null; try { box.decrypt(tampered); } catch (e) { tamperErr = e; }
    check('a damaged value throws (and not a transient error: it really is unreadable)', tamperErr && !tamperErr.transient);

    // A restart: the same key is read back from secret-box.key (sealed by the keychain), so new-format values still read
    const keyFile = path.join(dir, 'secret-box.key');
    check('the key file is sealed by the keychain (v10), not the key itself', fs.readFileSync(keyFile).subarray(0, 3).toString('latin1') === 'v10');
    const sealedBefore = fs.readFileSync(keyFile);
    const again = createSecretBox({ safeStorage: storage, keyFile, log: quiet });
    await again.start();
    check('a restart reads the same key: values written before it still read', again.decrypt(a) === 'secret text');
    check('a restart does not replace the key file', fs.readFileSync(keyFile).equals(sealedBefore) && fs.readdirSync(dir).filter((f) => f.startsWith('secret-box.key')).length === 1);
  }

  // --- the key is never replaced when it can't be opened (no data loss)
  {
    const dir = tmp();
    const keyFile = path.join(dir, 'secret-box.key');
    const box = createSecretBox({ safeStorage: fakeStorage(), keyFile, log: quiet });
    await box.start();
    const enc = box.encrypt('kept');
    const sealed = fs.readFileSync(keyFile);
    // Another computer's keychain (a copied profile): the key can't be opened
    const other = createSecretBox({ safeStorage: fakeStorage(), keyFile, log: quiet });
    await other.start();
    check('a key the keychain can\'t open: not available', !other.available());
    check('…and the key file is left exactly as it was (never a new key over it)', fs.readFileSync(keyFile).equals(sealed));
    let wrote = null; try { other.encrypt('x'); } catch (e) { wrote = e; }
    check('…and nothing can be encrypted with a key of its own', wrote?.code === 'SECRET_LOCKED');
    let read = null; try { other.decrypt(enc); } catch (e) { read = e; }
    check('…and a read throws instead of answering', Boolean(read));
  }

  // --- no keychain at all
  {
    const dir = tmp();
    const box = createSecretBox({ safeStorage: fakeStorage({ available: false }), keyFile: path.join(dir, 'secret-box.key'), log: quiet });
    await box.start();
    check('no keychain: not available, ready, and no key file made', !box.available() && box.isReady() && !fs.existsSync(path.join(dir, 'secret-box.key')));
    let err = null; try { box.encrypt('x'); } catch (e) { err = e; }
    check('no keychain: encrypt() refuses', Boolean(err));
  }

  // --- the OS rotated its key (shouldReEncrypt): the key file is sealed again, and still opens
  {
    const dir = tmp();
    const keyFile = path.join(dir, 'secret-box.key');
    const osKey = crypto.randomBytes(32);
    const first = createSecretBox({ safeStorage: fakeStorage({ osKey }), keyFile, log: quiet });
    await first.start();
    const enc = first.encrypt('rotated');
    const before = fs.readFileSync(keyFile);
    const rotating = createSecretBox({ safeStorage: fakeStorage({ osKey, rotate: true }), keyFile, log: quiet });
    await rotating.start();
    check('shouldReEncrypt: the key file is written again', !fs.readFileSync(keyFile).equals(before));
    check('shouldReEncrypt: the same key, so earlier values still read', rotating.decrypt(enc) === 'rotated');
    const after = createSecretBox({ safeStorage: fakeStorage({ osKey }), keyFile, log: quiet });
    await after.start();
    check('…and the re-sealed key file opens on the next start', after.decrypt(enc) === 'rotated');
  }

  // --- two Lumens making the first key at once agree on one
  {
    const dir = tmp();
    const keyFile = path.join(dir, 'secret-box.key');
    const osKey = crypto.randomBytes(32);
    const a = createSecretBox({ safeStorage: fakeStorage({ osKey }), keyFile, log: quiet });
    const b = createSecretBox({ safeStorage: fakeStorage({ osKey }), keyFile, log: quiet });
    await Promise.all([a.start(), b.start()]);
    check('two first starts at once: both end up with the same key', a.available() && b.available() && b.decrypt(a.encrypt('same')) === 'same' && a.decrypt(b.encrypt('same')) === 'same');
    check('…and no temp files are left', fs.readdirSync(dir).length === 1, fs.readdirSync(dir));
  }

  // --- start() is called once; ready() waits for it
  {
    const dir = tmp();
    const storage = fakeStorage();
    const box = createSecretBox({ safeStorage: storage, keyFile: path.join(dir, 'secret-box.key'), log: quiet });
    const p1 = box.start(); const p2 = box.start();
    check('start() twice is one start', p1 === p2);
    await box.ready();
    check('ready() resolves once the box is usable', box.available());
  }

  // --- the chat store with the box: old chat files read, are rewritten unchanged, and a "not yet" never sets the index aside
  {
    const { createChatStore } = require('../../src/features/chat-store');
    const dir = tmp();
    const chatsDir = path.join(dir, 'chats');
    fs.mkdirSync(chatsDir);
    const storage = fakeStorage();
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
    const snap = (n) => ({ settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text: `question ${n}` }] }, { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] }] });
    for (const [n, id] of ids.entries()) fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify({ enc: storage.encryptString(JSON.stringify(snap(n))).toString('base64') }));
    const indexText = JSON.stringify({ current: ids[0], chats: ids.map((id, n) => ({ id, title: `question ${n}`, created: n, updated: n })) });
    fs.writeFileSync(path.join(chatsDir, 'index.json'), JSON.stringify({ enc: storage.encryptString(indexText).toString('base64') }));

    // Read before the box has opened: the list is "degraded" (nothing written, nothing deleted), and the index is never set aside
    const box = createSecretBox({ safeStorage: storage, keyFile: path.join(dir, 'secret-box.key'), log: quiet });
    const mkStore = () => createChatStore({ dir: chatsDir, encrypt: box.encrypt, decrypt: box.decrypt, decryptAsync: box.decryptAsync, isLegacy: box.isLegacy, available: box.available, onError: quiet });
    const early = mkStore();
    check('chat store read before the keychain answers: an empty, degraded list (retried later)', early.list().length === 0 && early.usable() === false);
    check('…and the old index is left where it is (not renamed .corrupt)', fs.existsSync(path.join(chatsDir, 'index.json')) && !fs.readdirSync(chatsDir).some((f) => f.includes('corrupt')), fs.readdirSync(chatsDir));

    await box.start({ warmList: [{ file: path.join(chatsDir, 'index.json') }] });
    const store = mkStore();
    check('after start: the old index reads (both chats listed)', store.list().length === 2, store.list().length);
    check('loadAsync reads an old chat file nobody warmed', (await store.loadAsync(ids[1]))?.messages?.[1]?.content?.[0]?.text === 'answer 1');
    const before = fs.readFileSync(path.join(chatsDir, `${ids[0]}.json`), 'utf8');
    const rewritten = await store.upgradeLegacy({ gapMs: 0 });
    const after = JSON.parse(fs.readFileSync(path.join(chatsDir, `${ids[0]}.json`), 'utf8')).enc;
    check('upgradeLegacy rewrites the old chat files in the new format', rewritten === 2 && !box.isLegacy(after) && before !== fs.readFileSync(path.join(chatsDir, `${ids[0]}.json`), 'utf8'), rewritten);
    check('…with the same chat in them, readable synchronously', JSON.stringify(mkStore().load(ids[0])) === JSON.stringify(snap(0)) && JSON.stringify(mkStore().load(ids[1])) === JSON.stringify(snap(1)));
    check('…and running it again changes nothing', (await store.upgradeLegacy({ gapMs: 0 })) === 0);
    check('the box never called the deprecated synchronous functions for the chats', storage.calls.sync === ids.length + 1, storage.calls.sync);
  }

  // --- legacyStrings finds old blobs anywhere in a store's JSON, and nothing else
  {
    const storage = fakeStorage();
    const blob = storage.encryptString('x').toString('base64');
    const found = legacyStrings({ a: 'https://example.com', b: [{ secret: blob }], c: { sealed: blob }, d: 'djEw', e: 42, f: null });
    check('legacyStrings finds every old-format blob (nested, in arrays) and skips plain text', found.length === 2 && found.every((s) => s === blob), found);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
