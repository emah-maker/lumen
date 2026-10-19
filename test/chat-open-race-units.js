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

{ // a file missing for longer than the retries (a scanner or sync client holding it): not opened, but its entry is kept,
  // so when the file comes back the chat opens again instead of being orphaned
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-openrace-'));
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec });
  const keep = store.newId();
  const away = store.newId();
  store.save(keep, snap('keep'));
  store.save(away, snap('away'));
  const file = path.join(dir, `${away}.json`);
  const saved = fs.readFileSync(file);
  fs.rmSync(file);
  assert.strictEqual(store.load(away), null);
  assert.deepStrictEqual(store.list().map((c) => c.id).sort(), [keep, away].sort(), 'the entry is kept');
  assert.ok(store.load(keep), 'the others still open');
  fs.writeFileSync(file, saved); // the file is handed back
  assert.ok(store.load(away), 'and the chat opens again once its file is back');
  const again = createChatStore({ dir, encrypt: enc, decrypt: dec });
  assert.ok(again.list().some((c) => c.id === away), 'still listed after a restart');
  ok('a chat whose file is missing for a while keeps its History entry and opens when the file is back');
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
