// The background save path of the chat store (plain Node, no Electron): saveAsync() writes the same file save() does, coalesces saves of
// one chat, writes nothing for an unchanged chat, writes the index once and only when it changed, never leaves a temp file, is
// finished by load() and flush() (quitting), and its sliced serializer gives JSON.stringify's text exactly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chat-async-'));
let encrypts = 0;
const enc = (t) => { encrypts++; return Buffer.from(t).toString('base64'); };
const dec = (b) => Buffer.from(b, 'base64').toString();
const hexId = (n) => n.toString(16).padStart(16, '0');
const snap = (text, n = 1) => ({ messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `${text} ${i}` }] })), settings: { model: 'm' } });
let clock = 1000;
const mk = (dir, extra = {}) => createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ++clock, ...extra });
const files = (dir) => fs.readdirSync(dir);

(async () => {
  // ---- the file is the same as save()'s, the entry is the same, nothing is left behind
  {
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    const s = snap('hello', 5);
    s.forks = [{ at: 1, tails: [null, { messages: [{ role: 'user', content: [{ type: 'text', text: 'alt' }] }], forks: [] }] }];
    const sync = mk(dirA);
    const bg = mk(dirB);
    sync.save(hexId(1), s);
    bg.saveAsync(hexId(1), s);
    await bg.drain();
    const textOf = (dir) => dec(JSON.parse(fs.readFileSync(path.join(dir, `${hexId(1)}.json`), 'utf8')).enc);
    check('the background write holds exactly the text save() writes (JSON.stringify, character for character)', textOf(dirA) === textOf(dirB), textOf(dirB).slice(0, 120));
    check('its list entry matches (sig, msgs, title)', ['sig', 'msgs', 'title'].every((k) => sync.list()[0][k] === bg.list()[0][k]), JSON.stringify([sync.list()[0], bg.list()[0]]));
    check('no temp file is left', !files(dirB).some((n) => n.includes('.tmp')), files(dirB).join());
    check('a second store reads the chat and the index back', mk(dirB).load(hexId(1)).messages.length === 5 && mk(dirB).list().length === 1, '');
  }

  // ---- the chat is listed at once, before its file is written; load() finishes the save first
  {
    const dir = path.join(root, 'c');
    const store = mk(dir);
    check('saveAsync accepts the chat', store.saveAsync(hexId(1), snap('first', 3)) === true, '');
    check('the chat is in the list at once (has, list)', store.has(hexId(1)) && store.list().length === 1 && !store.list()[0].missing, JSON.stringify(store.list()));
    check('...and load() right away reads what was just saved', store.load(hexId(1))?.messages.length === 3, '');
    check('(that load wrote the file now, not later)', files(dir).includes(`${hexId(1)}.json`), files(dir).join());
    await store.drain();
  }

  // ---- saves of one chat are coalesced: only the newest is written
  {
    const dir = path.join(root, 'd');
    const store = mk(dir);
    store.saveAsync(hexId(1), snap('base', 2));
    await store.drain();
    const before = encrypts;
    for (let i = 3; i < 10; i++) store.saveAsync(hexId(1), snap('base', i)); // seven saves in the same tick
    await store.drain();
    check('seven saves in a row write once, the newest', encrypts - before === 2 /* chat + index */ && store.load(hexId(1)).messages.length === 9, `${encrypts - before} encrypts`);
  }

  // ---- an unchanged chat writes nothing (the digest skip), the index only when it changed
  {
    const dir = path.join(root, 'e');
    const store = mk(dir);
    store.saveAsync(hexId(1), snap('same', 4));
    await store.drain();
    const before = encrypts;
    const m = fs.statSync(path.join(dir, `${hexId(1)}.json`)).mtimeMs;
    await sleep(30);
    for (let i = 0; i < 4; i++) { store.saveAsync(hexId(1), snap('same', 4)); await sleep(60); }
    await store.drain();
    check('saving the same chat again encrypts and writes nothing', encrypts === before && fs.statSync(path.join(dir, `${hexId(1)}.json`)).mtimeMs === m, `${encrypts - before} encrypts`);
    store.setCurrent(hexId(1), { defer: true });
    store.setCurrent(hexId(1), { defer: true });
    await store.drain();
    const mi = fs.statSync(path.join(dir, 'index.json')).mtimeMs;
    const e2 = encrypts;
    store.touch(hexId(1), 1); // (older than its activity time: nothing changes)
    await store.drain();
    check('an index that did not change is not written again', fs.statSync(path.join(dir, 'index.json')).mtimeMs === mi && encrypts === e2, `${encrypts - e2}`);
  }

  // ---- flush() (quitting) writes everything pending, on the spot
  {
    const dir = path.join(root, 'f');
    const store = mk(dir);
    store.saveAsync(hexId(1), snap('quit one', 2));
    store.saveAsync(hexId(2), snap('quit two', 3));
    store.setCurrent(hexId(2), { defer: true });
    store.flush();
    const other = mk(dir);
    check('flush() put both chats and the index on disk at once', other.load(hexId(1))?.messages.length === 2 && other.load(hexId(2))?.messages.length === 3 && other.current() === hexId(2), files(dir).join());
    await store.drain();
    check('the background writes that were pending do not undo it', mk(dir).load(hexId(2)).messages.length === 3 && !files(dir).some((n) => n.includes('.tmp')), files(dir).join());
  }

  // ---- a save() made at once wins over a background save that is waiting or running
  {
    const dir = path.join(root, 'g');
    const store = mk(dir);
    store.saveAsync(hexId(1), snap('old', 2));
    store.save(hexId(1), snap('newer', 6));
    await store.drain();
    check('the newer save() is the one on disk', mk(dir).load(hexId(1)).messages.length === 6, '');
  }

  // ---- loadAsync gives load()'s answers
  {
    const dir = path.join(root, 'h');
    const store = mk(dir);
    store.save(hexId(1), snap('read me', 4));
    check('loadAsync reads a chat', (await mk(dir).loadAsync(hexId(1)))?.messages.length === 4, '');
    check('loadAsync: an unknown chat is null', (await mk(dir).loadAsync(hexId(9))) === null, '');
    const fresh = mk(dir);
    const loaded = await fresh.loadAsync(hexId(1));
    const e = encrypts;
    fresh.saveAsync(hexId(1), loaded);
    await fresh.drain();
    check('a chat read with loadAsync counts as saved (saving it back writes nothing)', encrypts === e, `${encrypts - e}`);
    fs.writeFileSync(path.join(dir, `${hexId(1)}.json`), '{ half a file');
    check('loadAsync: a damaged file is null, not a throw', (await mk(dir).loadAsync(hexId(1))) === null, '');
  }

  // ---- a failed write is reported and retried by the next save, and leaves no temp file
  {
    const dir = path.join(root, 'i');
    const errors = [];
    let fail = true;
    const store = createChatStore({ dir, encrypt: (t) => { if (fail) throw new Error('keychain says no'); return enc(t); }, decrypt: dec, now: () => ++clock, onError: (e) => errors.push(e.message) });
    store.saveAsync(hexId(1), snap('x', 2));
    await store.drain();
    check('a failing encrypt is reported, not thrown into the app', errors.length === 1 && /keychain/.test(errors[0]), errors.join());
    fail = false;
    store.saveAsync(hexId(1), snap('x', 2));
    await store.drain();
    check('the next save of the same chat is written', mk(dir).load(hexId(1))?.messages.length === 2 && !files(dir).some((n) => n.includes('.tmp')), files(dir).join());
  }

  // ---- deleting a chat whose save is still waiting: the save must not bring it back
  {
    const dir = path.join(root, 'k');
    const store = mk(dir);
    store.saveAsync(hexId(1), snap('doomed', 2));
    store.trash(hexId(1));
    await store.drain();
    check('a chat trashed with a save waiting stays trashed', store.list().length === 0 && store.trashed().length === 1 && mk(dir).load(hexId(1)) === null /* (trashed: not opened) */, JSON.stringify(store.trashed()));
    store.saveAsync(hexId(2), snap('removed', 2));
    store.remove(hexId(2));
    await store.drain();
    check('a chat erased with a save waiting is not written back', !files(dir).includes(hexId(2) + '.json') && !store.has(hexId(2)), files(dir).join());
  }

  // ---- no keychain: nothing is kept
  {
    const dir = path.join(root, 'j');
    const store = mk(dir, { available: () => false });
    check('without a keychain saveAsync keeps nothing', store.saveAsync(hexId(1), snap('no', 2)) === false && !fs.existsSync(dir), '');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
