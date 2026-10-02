// Crash-safe persistence: the chat index (features/chat-store.js), loadJsonAsync (settings/settings-file.js)
// and the favicon cache (browser/favicon-store.js). Plain node: node test/persistence-units.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../src/features/chat-store');
const sf = require('../src/settings/settings-file');
const { createFaviconFiles } = require('../src/browser/favicon-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-persist-'));
const enc = (s) => Buffer.from(s).toString('base64').split('').reverse().join('');
const dec = (s) => Buffer.from(s.split('').reverse().join(''), 'base64').toString();
const chat = (text) => ({ settings: { model: 'm' }, messages: [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
const corrupts = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('index.json.corrupt-'));
let n = 0;
const ok = (name) => { n++; console.log(`ok  ${name}`); };

(async () => {
  // ---- chat store
  {
    const dir = tmp();
    const a = createChatStore({ dir, encrypt: enc, decrypt: dec });
    assert.deepStrictEqual(a.list(), [], 'no index and no chats: empty');
    assert.ok(!fs.existsSync(path.join(dir, 'index.json')), 'reading an empty store writes nothing');
    ok('chat store: ENOENT means none yet');

    const id1 = a.newId(); const id2 = a.newId();
    a.save(id1, chat('first chat')); a.save(id2, chat('second chat'));
    a.rename(id2, 'Renamed');
    const indexFile = path.join(dir, 'index.json');

    // half-written index: parse failure
    fs.writeFileSync(indexFile, '{"enc":"abc');
    const b = createChatStore({ dir, encrypt: enc, decrypt: dec });
    const titles = b.list().map((c) => c.title).sort();
    assert.deepStrictEqual(titles, ['first chat', 'second chat'], 'the index is rebuilt from the chat files');
    assert.strictEqual(corrupts(dir).length, 1, 'the unreadable index is kept as index.json.corrupt-<ts>');
    assert.strictEqual(fs.readFileSync(path.join(dir, corrupts(dir)[0]), 'utf8'), '{"enc":"abc', 'and left untouched');
    assert.ok(b.load(id1), 'chats are loadable again');
    assert.strictEqual(JSON.parse(dec(JSON.parse(fs.readFileSync(indexFile, 'utf8')).enc)).chats.length, 2, 'the rebuilt index is saved');
    ok('chat store: corrupt index is set aside and rebuilt');

    // decrypt failure, everything on disk undecryptable: nothing cached, nothing written, nothing overwritten
    const dir2 = tmp();
    const c = createChatStore({ dir: dir2, encrypt: enc, decrypt: dec });
    const cid = c.newId();
    c.save(cid, chat('keep me'));
    const before = fs.readFileSync(path.join(dir2, `${cid}.json`), 'utf8');
    let locked = true;
    const flaky = createChatStore({ dir: dir2, encrypt: enc, decrypt: (s) => { if (locked) throw new Error('keychain locked'); return dec(s); } });
    assert.deepStrictEqual(flaky.list(), [], 'locked: nothing to show');
    assert.strictEqual(flaky.save(flaky.newId(), chat('new while locked')), false, 'saving while the index is unreadable refuses');
    flaky.setCurrent(cid); flaky.rename(cid, 'x');
    assert.strictEqual(fs.readFileSync(path.join(dir2, `${cid}.json`), 'utf8'), before, 'the chat file is untouched');
    assert.ok(!fs.existsSync(path.join(dir2, 'index.json')) || corrupts(dir2).length >= 1, 'no empty index written over the old one');
    locked = false;
    assert.deepStrictEqual(flaky.list().map((x) => x.title), ['keep me'], 'not cached empty: the next call recovers the chats');
    ok('chat store: decrypt failure never caches an empty index or writes');

    // transient read error (not ENOENT): no overwrite, no move, retry works
    const dir3 = tmp();
    const d = createChatStore({ dir: dir3, encrypt: enc, decrypt: dec });
    const did = d.newId();
    d.save(did, chat('transient'));
    const idxBefore = fs.readFileSync(path.join(dir3, 'index.json'), 'utf8');
    const realRead = fs.readFileSync;
    const e = createChatStore({ dir: dir3, encrypt: enc, decrypt: dec });
    fs.readFileSync = (f, ...rest) => { if (String(f).endsWith('index.json')) { const err = new Error('busy'); err.code = 'EBUSY'; throw err; } return realRead(f, ...rest); };
    try {
      assert.deepStrictEqual(e.list(), []);
      assert.strictEqual(e.save(e.newId(), chat('x')), false);
    } finally { fs.readFileSync = realRead; }
    assert.strictEqual(fs.readFileSync(path.join(dir3, 'index.json'), 'utf8'), idxBefore, 'index.json is not overwritten');
    assert.strictEqual(corrupts(dir3).length, 0, 'a transient error does not move the file');
    assert.strictEqual(e.list().length, 1, 'retried on the next call');
    ok('chat store: transient read error neither overwrites nor moves the index');

    // index deleted but chats remain: rebuilt
    const dir4 = tmp();
    const f = createChatStore({ dir: dir4, encrypt: enc, decrypt: dec });
    f.save(f.newId(), chat('orphan'));
    fs.rmSync(path.join(dir4, 'index.json'));
    assert.deepStrictEqual(createChatStore({ dir: dir4, encrypt: enc, decrypt: dec }).list().map((x) => x.title), ['orphan']);
    ok('chat store: missing index with chat files is rebuilt');
  }

  // ---- loadJsonAsync
  {
    const dir = tmp();
    const file = path.join(dir, 'h.json');
    assert.deepStrictEqual(await sf.loadJsonAsync(file), {}, 'missing: empty, nothing created');
    assert.ok(fs.readdirSync(dir).length === 0);
    fs.writeFileSync(file, '[1,2');
    assert.deepStrictEqual(await sf.loadJsonAsync(file), {});
    assert.ok(fs.readdirSync(dir).some((x) => x.startsWith('h.json.corrupt-')), 'unparseable file is set aside, not overwritten');
    sf.writeJsonAtomic(file, [1], 0); sf.writeJsonAtomic(file, [2], 0);
    fs.writeFileSync(file, 'garbage');
    assert.deepStrictEqual(await sf.loadJsonAsync(file), [1], 'falls back to the .bak');
    await sf.writeJsonAtomicAsync(file, [3], undefined, 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '[3]', 'compact when space is 0');
    // a sync write after an async one queued: the async one never lands over it
    let gen = 0;
    const g = ++gen;
    const p = sf.writeJsonAtomicAsync(file, [4], () => g === gen, 0);
    gen++; sf.writeJsonAtomic(file, [5], 0);
    await p;
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [5], 'sync and in-flight async writes do not interleave');
    ok('settings-file: loadJsonAsync recovery and ordered writes');
  }

  // ---- favicon files
  {
    const dir = path.join(tmp(), 'favicon-cache');
    let clock = Date.now();
    const files = createFaviconFiles({ dir, now: () => clock, maxAgeMs: 1000, maxFiles: 3 });
    const png = (s) => `data:image/png;base64,${Buffer.from(s).toString('base64')}`;
    const url = files.fileFor(png('icon-a'));
    assert.ok(/^file:\/\/\/.+favicon-cache\/[0-9a-f]{20}\.png$/.test(url), url);
    assert.strictEqual(files.fileFor(png('icon-a')), url, 'same icon, same address');
    assert.strictEqual(files.fileFor('https://x/y.png'), null);
    const raw = 'data:image/svg+xml;utf8,<svg/>';
    assert.strictEqual(files.fileFor(raw), raw, 'non-base64 passes through');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((x) => x.endsWith('.png')))).toString(), 'icon-a', 'written in the background');
    assert.ok(!fs.readdirSync(dir).some((x) => x.endsWith('.tmp')));
    // prune: old files and files beyond the cap go; the ones this session uses stay
    const mk = (name, age) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); const t = new Date(clock - age); fs.utimesSync(f, t, t); };
    mk(`${'1'.repeat(20)}.png`, 5000); // too old
    mk(`${'2'.repeat(20)}.png`, 10); mk(`${'3'.repeat(20)}.png`, 20); mk(`${'4'.repeat(20)}.png`, 30); // fresh, but the cap is 3 (1 in use)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep'); // not a cache file: never touched
    const removed = await files.prune();
    const left = fs.readdirSync(dir).sort();
    assert.ok(!left.includes(`${'1'.repeat(20)}.png`), 'old file pruned');
    assert.ok(!left.includes(`${'4'.repeat(20)}.png`), 'oldest beyond the cap pruned');
    assert.ok(left.includes(`${'2'.repeat(20)}.png`) && left.includes(`${'3'.repeat(20)}.png`), 'newest kept');
    assert.ok(left.includes('notes.txt') && left.some((x) => x.endsWith('.png') && !/^(\d)\1{19}\.png$/.test(x)), 'foreign and in-use files kept');
    assert.strictEqual(removed, 2);
    ok('favicon cache: async write and idle prune');
  }

  console.log(`all passed (${n})`);
})().catch((e) => { console.log(`FAIL  ${e.stack || e.message}`); process.exit(1); });
