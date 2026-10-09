// A saved chat that History lists must open even when its file is unreadable for a moment (Windows: a scanner holds a
// just-written file, or a rename is replacing it). Plain node: node test/chat-open-race-units.js
require('./_tmp-cleanup');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../src/features/chat-store');

const enc = (s) => Buffer.from(s).toString('base64');
const dec = (s) => Buffer.from(s, 'base64').toString();
const snap = (text) => ({ settings: { model: 'm' }, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
let n = 0;
const ok = (name) => { n++; console.log(`ok  ${name}`); };

// Makes the first `times` reads of this chat's file fail with `code`, as the OS would.
function failReads(file, code, times) {
  const real = fs.readFileSync;
  let left = times;
  fs.readFileSync = function readFileSync(p, ...rest) {
    if (String(p) === file && left > 0) { left--; throw Object.assign(new Error(`${code}: simulated`), { code }); }
    return real.call(this, p, ...rest);
  };
  return () => { fs.readFileSync = real; return times - left; };
}

for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOENT']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-openrace-'));
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec });
  const id = store.newId();
  store.save(id, snap('hello'));
  const restore = failReads(path.join(dir, `${id}.json`), code, 2);
  let loaded;
  try { loaded = store.load(id); } finally { restore(); }
  assert.ok(loaded && loaded.messages.length === 1, `a chat that is unreadable twice (${code}) opens on the next try`);
  assert.strictEqual(store.list().length, 1, 'the entry stays');
  ok(`${code} on the first reads is retried`);
}

{ // a file that is really gone: not opened, and History stops listing it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-openrace-'));
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec });
  const keep = store.newId();
  const gone = store.newId();
  store.save(keep, snap('keep'));
  store.save(gone, snap('gone'));
  fs.rmSync(path.join(dir, `${gone}.json`));
  assert.strictEqual(store.load(gone), null);
  assert.deepStrictEqual(store.list().map((c) => c.id), [keep], 'the dangling entry is dropped');
  assert.ok(store.load(keep), 'the others still open');
  const again = createChatStore({ dir, encrypt: enc, decrypt: dec });
  assert.deepStrictEqual(again.list().map((c) => c.id), [keep], 'and it stays dropped after a restart');
  ok('a chat whose file is gone is not offered again');
}

{ // damaged: no retry storm, no change to the index
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-openrace-'));
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec });
  const id = store.newId();
  store.save(id, snap('x'));
  fs.writeFileSync(path.join(dir, `${id}.json`), '{ not json');
  assert.strictEqual(store.load(id), null);
  assert.strictEqual(store.list().length, 1, 'a damaged file keeps its entry (nothing is decided from a read error)');
  ok('a damaged chat file is not retried or dropped');
}

console.log(`${n} passed`);
