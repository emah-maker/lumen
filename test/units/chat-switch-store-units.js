// Leaving a chat for another (every tab switch to a tab with its own chat) must not cost disk work when nothing changed (plain Node, no Electron):
// saving a chat that is the same as what is on disk writes nothing, a chat that was just loaded counts as saved, a changed chat or a missing
// file is still written, and moving the "open chat" pointer with `defer` is written once, a moment later, or by flush() (quitting).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chat-switch-'));
let encrypts = 0;
const enc = (t) => { encrypts++; return Buffer.from(t).toString('base64'); };
const dec = (b) => Buffer.from(b, 'base64').toString();
const snap = (text, n = 1) => ({ messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `${text} ${i}` }] })), settings: {} });
const hexId = (n) => n.toString(16).padStart(16, '0');
let clock = 1000;
const mk = (dir) => createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ++clock });
const mtimes = (dir) => Object.fromEntries(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]));

(async () => {
  // ---- an unchanged chat is not written again
  {
    const dir = path.join(root, 'a');
    const store = mk(dir);
    store.save(hexId(1), snap('hello', 4));
    store.save(hexId(2), snap('other', 2));
    const before = encrypts;
    const updated = store.list().find((c) => c.id === hexId(1)).updated;
    await sleep(30);
    const m1 = mtimes(dir);
    for (let i = 0; i < 5; i++) store.save(hexId(1), snap('hello', 4));
    check('saving the same chat again encrypts and writes nothing', encrypts === before && JSON.stringify(mtimes(dir)) === JSON.stringify(m1), `${encrypts - before} encrypts`);
    check('...and does not move it up the list', store.list().find((c) => c.id === hexId(1)).updated === updated, '');
    store.save(hexId(1), snap('hello', 6));
    check('a changed chat is written', encrypts > before && store.load(hexId(1)).messages.length === 6, `${encrypts - before}`);
    check('...and moves to the top of the list', store.list()[0].id === hexId(1), JSON.stringify(store.list().map((c) => c.id)));
  }

  // ---- a chat that was loaded counts as saved
  {
    const dir = path.join(root, 'b');
    const first = mk(dir);
    first.save(hexId(1), snap('loaded', 4));
    const store = mk(dir); // another run of the app: nothing known about the chat yet
    const loaded = store.load(hexId(1));
    const before = encrypts;
    store.save(hexId(1), loaded);
    check('a chat read from disk and saved back unchanged writes nothing', encrypts === before, `${encrypts - before}`);
    store.save(hexId(1), { ...loaded, settings: { model: 'x' } });
    check('...but a changed setting of it is written', encrypts > before && store.load(hexId(1)).settings.model === 'x', '');
  }

  // ---- what must still be written
  {
    const dir = path.join(root, 'c');
    const store = mk(dir);
    store.save(hexId(1), snap('keep', 2));
    fs.rmSync(path.join(dir, `${hexId(1)}.json`));
    store.save(hexId(1), snap('keep', 2));
    check('a chat whose file went missing is written again, unchanged', fs.existsSync(path.join(dir, `${hexId(1)}.json`)), '');
    store.trash(hexId(1));
    store.save(hexId(1), snap('keep', 2));
    check('a trashed chat saved again comes back to the list', store.list().some((c) => c.id === hexId(1)), '');
    store.remove(hexId(1));
    store.save(hexId(1), snap('keep', 2));
    check('a removed chat saved again is written and listed', store.list().some((c) => c.id === hexId(1)) && fs.existsSync(path.join(dir, `${hexId(1)}.json`)), '');
  }

  // ---- the open-chat pointer
  {
    const dir = path.join(root, 'd');
    const store = mk(dir);
    store.save(hexId(1), snap('one', 2));
    store.save(hexId(2), snap('two', 2));
    store.setCurrent(hexId(1));
    const indexText = () => fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    const before = indexText();
    store.setCurrent(hexId(2), { defer: true });
    check('a deferred pointer change is seen at once', store.current() === hexId(2), store.current());
    check('...but not written yet', indexText() === before, '');
    const reopened = mk(dir);
    check('...so another reader still sees the old pointer', reopened.current() === hexId(1), reopened.current());
    store.flush();
    check('flush() writes it', mk(dir).current() === hexId(2), mk(dir).current());
    const written = indexText();
    store.setCurrent(hexId(2), { defer: true });
    store.flush();
    check('setting the pointer to what it already is writes nothing', indexText() === written, '');
    store.setCurrent(hexId(1), { defer: true });
    store.save(hexId(2), snap('two', 4)); // any other write carries the pointer along
    check('another write carries a pending pointer with it', mk(dir).current() === hexId(1), mk(dir).current());
    check('a pointer set without defer is written at once', (store.setCurrent(hexId(2)), mk(dir).current() === hexId(2)), '');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
