// [sync] Sync through a folder: the encrypted file format, the folder, the merge and the engine (features/sync-core.js).
// Plain Node: temp folders stand in for the cloud drive, in-memory stores for Lumen's data; each "computer" is an engine with its own
// state, clock and store. No Electron, no network.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../../src/features/sync-core');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const rejects = async (fn, code) => { try { await fn(); return false; } catch (err) { return err.code === code || (!code && err instanceof Error); } };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lumen-sync-${name}-`));

// A provider over a Map: key -> value. Options: tombstones, guard, sharded, hint (value -> ts), combine, hold (keys apply refuses), failScan.
function memProvider(name, store, opts = {}) {
  const p = {
    name,
    scan() {
      if (opts.failScan) throw new core.SyncError('unavailable', 'locked');
      const out = new Map();
      for (const [k, v] of store) out.set(k, { value: v, ts: opts.hint ? opts.hint(v) : undefined });
      return out;
    },
    has: (k) => store.has(k),
    apply(changes) {
      const held = [];
      for (const c of changes) {
        if (opts.hold?.has(c.key)) { held.push(c.key); continue; }
        if (c.deleted) store.delete(c.key); else store.set(c.key, c.value);
      }
      opts.applied?.push(...changes.map((c) => c.key));
      return held;
    },
  };
  if (opts.tombstones === false) p.tombstones = false;
  if (opts.guard) p.guard = true;
  if (opts.sharded) p.shardOf = (k) => `${name}-${k}`;
  if (opts.combine) p.combine = opts.combine;
  return p;
}

// One computer: an engine over the shared folder with its own clock and stores.
function computer(root, key, id, stores, opts = {}) {
  const clock = { t: opts.start || 1_000_000 };
  const state = {};
  const providers = Object.entries(stores).map(([name, s]) => memProvider(name, s.map || s, { ...(s.opts || {}) }));
  const engine = core.createEngine({ dirs: core.dirsOf(root), key, deviceId: id, deviceName: `pc-${id}`, state, providers, now: () => clock.t, saveState: async () => {} });
  return { engine, clock, state, sync: (o) => engine.sync(o), tick: (ms = 1000) => { clock.t += ms; } };
}
const files = (root) => fs.readdirSync(core.dirsOf(root).data).filter((f) => f.endsWith('.lsync'));
const mk = async (name, pass = 'correct horse battery') => {
  const root = tmp(name);
  const { key, dirs } = await core.openFolder(root, pass);
  return { root, key, dirs };
};

(async () => {
  // ---- the file format
  {
    const key = await core.deriveKey('a long passphrase', Buffer.alloc(16, 7));
    const other = await core.deriveKey('another passphrase', Buffer.alloc(16, 7));
    const doc = { records: { a: { t: 5, v: 'hello world SECRET-MARKER' } } };
    const buf = await core.seal(key, doc, 'bookmarks.aaaaaaaaaaaa.lsync');
    check('format: seals and opens a value', JSON.stringify(await core.open(key, buf, 'bookmarks.aaaaaaaaaaaa.lsync')) === JSON.stringify(doc));
    check('format: the bytes hold no plain text', !buf.toString('latin1').includes('SECRET-MARKER') && !buf.toString('latin1').includes('hello'));
    check('format: starts with the magic and a fresh nonce each time', buf.subarray(0, 4).toString() === 'LSY1' && !buf.equals(await core.seal(key, doc, 'bookmarks.aaaaaaaaaaaa.lsync')));
    check('format: another key does not open it', await rejects(() => core.open(other, buf, 'bookmarks.aaaaaaaaaaaa.lsync'), 'unreadable'));
    check('format: the same bytes under another file name do not open (bound to the name)', await rejects(() => core.open(key, buf, 'history.aaaaaaaaaaaa.lsync'), 'unreadable'));
    for (const at of [4, 20, 40, buf.length - 1]) {
      const bad = Buffer.from(buf); bad[at] ^= 1;
      check(`format: a changed byte (${at}) is refused`, await rejects(() => core.open(key, bad, 'bookmarks.aaaaaaaaaaaa.lsync'), 'unreadable'));
    }
    check('format: a cut-short file is refused', await rejects(() => core.open(key, buf.subarray(0, buf.length - 5), 'bookmarks.aaaaaaaaaaaa.lsync'), 'unreadable'));
    check('format: an empty file and a text file are refused', await rejects(() => core.open(key, Buffer.alloc(0), 'x'), 'unreadable') && await rejects(() => core.open(key, Buffer.from('{"records":{}}'), 'x'), 'unreadable'));
    const future = Buffer.from(buf); future[3] = 0x32;
    check('format: a newer format is reported as newer, not as damage', await rejects(() => core.open(key, future, 'bookmarks.aaaaaaaaaaaa.lsync'), 'newer'));
    check('format: passphrase text is normalised (NFKC), so the same letters give the same key', (await core.deriveKey('éclair-and-more', Buffer.alloc(16, 1))).equals(await core.deriveKey('éclair-and-more', Buffer.alloc(16, 1))));
  }

  // ---- the folder and the passphrase
  {
    const root = tmp('folder');
    const a = await core.openFolder(root, 'my sync passphrase');
    check('folder: first use makes the folder set and reports created', a.created === true && fs.existsSync(a.dirs.meta) && fs.existsSync(a.dirs.data) && fs.existsSync(a.dirs.devices));
    const meta = JSON.parse(fs.readFileSync(a.dirs.meta, 'utf8'));
    check('folder: sync.json has the salt and parameters but not the passphrase or key', meta.kdf.name === 'scrypt' && meta.salt && !fs.readFileSync(a.dirs.meta, 'utf8').includes('my sync passphrase') && !fs.readFileSync(a.dirs.meta, 'utf8').includes(a.key.toString('base64')));
    const b = await core.openFolder(root, 'my sync passphrase');
    check('folder: a second computer with the same passphrase joins and gets the same key', b.created === false && b.key.equals(a.key));
    check('folder: a wrong passphrase is refused', await rejects(() => core.openFolder(root, 'my sync passphrasf'), 'wrong-passphrase'));
    check('folder: an empty passphrase is refused', await rejects(() => core.openFolder(root, ''), 'wrong-passphrase'));
    check('folder: a short passphrase is refused when creating', await rejects(() => core.openFolder(tmp('short'), 'short'), 'short-passphrase'));
    check('folder: a missing folder is reported', await rejects(() => core.openFolder(path.join(root, 'nope', 'deeper'), 'my sync passphrase'), 'no-folder'));
    const file = path.join(root, 'a-file.txt'); fs.writeFileSync(file, 'x');
    check('folder: a file instead of a folder is reported', await rejects(() => core.openFolder(file, 'my sync passphrase'), 'no-folder'));
    fs.writeFileSync(a.dirs.meta, '{ not json');
    check('folder: a damaged sync.json is reported, not overwritten', await rejects(() => core.openFolder(root, 'my sync passphrase'), 'bad-meta') && fs.readFileSync(a.dirs.meta, 'utf8') === '{ not json');
    fs.writeFileSync(a.dirs.meta, JSON.stringify({ ...meta, kdf: { name: 'scrypt', N: 1 << 30, r: 8, p: 1 } }));
    check('folder: hostile scrypt parameters (a memory bomb) are refused', await rejects(() => core.openFolder(root, 'my sync passphrase'), 'bad-meta'));
    fs.writeFileSync(a.dirs.meta, JSON.stringify({ ...meta, format: 2 }));
    check('folder: a folder set up by a newer Lumen is reported', await rejects(() => core.openFolder(root, 'my sync passphrase'), 'newer'));
    // two computers setting up the same empty folder at once end up on one salt
    const race = tmp('race');
    const results = await Promise.allSettled([core.openFolder(race, 'the shared passphrase'), core.openFolder(race, 'the shared passphrase')]);
    check('folder: two computers creating at once both end up usable with one key', results.every((r) => r.status === 'fulfilled') && results[0].value.key.equals(results[1].value.key), JSON.stringify(results.map((r) => r.status)));
  }

  // ---- merge rules
  {
    check('merge: the later time wins', core.compare({ t: 5, d: 'a' }, { t: 4, d: 'z' }) === 1 && core.compare({ t: 4, d: 'z' }, { t: 5, d: 'a' }) === -1);
    check('merge: a tie goes to the larger device id, the same on every computer', core.compare({ t: 5, d: 'b' }, { t: 5, d: 'a' }) === 1 && core.compare({ t: 5, d: 'a' }, { t: 5, d: 'b' }) === -1 && core.compare({ t: 5, d: 'a' }, { t: 5, d: 'a' }) === 0);
    check('merge: winner picks the newest of many, null for none', core.winner([{ t: 1, d: 'a' }, { t: 9, d: 'b' }, { t: 3, d: 'c' }]).d === 'b' && core.winner([]) === null);
    check('merge: canonical text ignores key order', core.canonical({ a: 1, b: [1, { y: 1, x: 2 }] }) === core.canonical({ b: [1, { x: 2, y: 1 }], a: 1 }));
  }

  // ---- the engine: two computers
  {
    const { root, key } = await mk('two');
    const A = new Map(); const B = new Map();
    const a = computer(root, key, 'aaaaaaaaaaaa', { bookmarks: A });
    const b = computer(root, key, 'bbbbbbbbbbbb', { bookmarks: B });
    A.set('https://one.example/', { title: 'One' });
    A.set('https://two.example/', { title: 'Two' });
    let r = await a.sync();
    check('engine: the first pass writes this computer\'s records to its own file', r.authored === 2 && files(root).join() === 'bookmarks.aaaaaaaaaaaa.lsync', files(root).join());
    r = await b.sync();
    check('engine: the other computer receives them', r.applied === 2 && B.get('https://one.example/').title === 'One' && r.kinds.join() === 'bookmarks', JSON.stringify(r));
    check('engine: it never writes a file for data it only received', files(root).length === 1);
    r = await b.sync(); const r2 = await a.sync();
    check('engine: nothing read back is written again (no ping-pong)', r.authored === 0 && r.applied === 0 && r2.authored === 0 && r2.applied === 0 && files(root).length === 1, JSON.stringify([r, r2]));

    // an edit
    b.tick(); B.set('https://one.example/', { title: 'One (edited on B)' });
    await b.sync(); await a.sync();
    check('engine: an edit on the second computer reaches the first', A.get('https://one.example/').title === 'One (edited on B)');
    check('engine: the replaced record leaves the first computer\'s file (the newest copy is kept once)', !a.engine.ownRecords().get('bookmarks').records['https://one.example/'] && Boolean(b.engine.ownRecords().get('bookmarks').records['https://one.example/']));

    // both edit the same record: the later one wins on both
    a.tick(5000); A.set('https://two.example/', { title: 'Two by A' });
    b.tick(9000); B.set('https://two.example/', { title: 'Two by B (later)' });
    await a.sync(); await b.sync(); await a.sync();
    check('conflict: the later edit wins on both computers', A.get('https://two.example/').title === 'Two by B (later)' && B.get('https://two.example/').title === 'Two by B (later)');

    // both add different things
    a.tick(); b.tick();
    A.set('https://only-a.example/', { title: 'A' }); B.set('https://only-b.example/', { title: 'B' });
    await a.sync(); await b.sync(); await a.sync();
    check('conflict: different additions on both sides both survive', A.has('https://only-b.example/') && B.has('https://only-a.example/') && A.size === B.size, `${A.size} ${B.size}`);

    // delete
    a.tick(); A.delete('https://one.example/');
    r = await a.sync();
    check('tombstone: a deletion is recorded as a tombstone', r.authored === 1);
    await b.sync();
    check('tombstone: and removes it on the other computer', !B.has('https://one.example/') && A.size === B.size);
    const rr = await b.sync();
    check('tombstone: the removal is not written back as a new record', rr.authored === 0);

    // a deletion and a later re-add
    b.tick(60000); B.set('https://one.example/', { title: 'back again' });
    await b.sync(); await a.sync();
    check('tombstone: adding it again afterwards beats the old deletion', A.get('https://one.example/')?.title === 'back again');

    // a deletion older than an edit elsewhere: the edit wins (last writer)
    a.tick(1000); A.delete('https://two.example/'); a.tick(1000);
    b.tick(500000); B.set('https://two.example/', { title: 'edited after the delete' });
    await a.sync(); await b.sync(); await a.sync();
    check('tombstone: an edit made after the deletion wins over it', A.get('https://two.example/')?.title === 'edited after the delete' && B.has('https://two.example/'));
  }

  // ---- joining a folder that already has data
  {
    const { root, key } = await mk('join');
    const A = new Map([['x', 'from A'], ['shared', 'A version']]);
    const a = computer(root, key, 'aaaaaaaaaaaa', { things: A });
    await a.sync();
    const B = new Map([['y', 'only on B'], ['shared', 'B older local version']]);
    const b = computer(root, key, 'bbbbbbbbbbbb', { things: B }, { start: 5_000_000 });
    await b.sync(); await a.sync();
    check('join: what the folder already has wins over a new computer\'s own version', B.get('shared') === 'A version' && A.get('shared') === 'A version');
    check('join: but what only the new computer has is added, and the first one gets it', B.get('x') === 'from A' && A.get('y') === 'only on B');
    // an empty folder: the first computer's data is not treated as "older"
    const fresh = await mk('join-empty');
    const C = new Map([['k', 'C']]); const D = new Map([['k', 'D']]);
    const c = computer(fresh.root, fresh.key, 'cccccccccccc', { things: C }, { start: 2_000_000 });
    await c.sync();
    const d = computer(fresh.root, fresh.key, 'dddddddddddd', { things: D }, { start: 3_000_000 });
    await d.sync(); await c.sync();
    check('join: a computer that joins later takes the folder\'s value, both end the same', C.get('k') === 'C' && D.get('k') === 'C');
  }

  // ---- damaged, foreign and half-written files
  {
    const { root, key, dirs } = await mk('bad');
    const A = new Map([['a', 1]]); const B = new Map(); const C = new Map([['c', 3]]);
    const a = computer(root, key, 'aaaaaaaaaaaa', { things: A });
    const c = computer(root, key, 'cccccccccccc', { things: C });
    const b = computer(root, key, 'bbbbbbbbbbbb', { things: B });
    await a.sync(); await c.sync();
    const fileA = path.join(dirs.data, 'things.aaaaaaaaaaaa.lsync');
    const good = fs.readFileSync(fileA);
    fs.writeFileSync(fileA, good.subarray(0, 40)); // cut short, as a cloud client mid-copy
    let r = await b.sync();
    check('corrupt: a cut-short file is skipped and counted, the others still sync', r.bad === 1 && B.has('c') && !B.has('a') && r.errors.length === 0, JSON.stringify(r));
    fs.writeFileSync(fileA, good); // the cloud finishes the copy
    r = await b.sync();
    check('corrupt: it is read once the file is whole', r.bad === 0 && B.get('a') === 1);
    const flip = Buffer.from(good); flip[50] ^= 255; fs.writeFileSync(fileA, flip);
    const E = new Map(); const e = computer(root, key, 'eeeeeeeeeeee', { things: E });
    r = await e.sync();
    check('corrupt: a file with a changed byte is refused (not applied)', r.bad === 1 && !E.has('a') && E.has('c'));
    fs.writeFileSync(fileA, 'this is not a sync file at all');
    r = await e.sync();
    check('corrupt: a text file in the data folder is refused', r.bad === 1 && !E.has('a'));
    fs.writeFileSync(fileA, Buffer.alloc(0));
    r = await e.sync();
    check('corrupt: an empty file is refused', r.bad === 1);
    // swapped between names
    fs.copyFileSync(path.join(dirs.data, 'things.cccccccccccc.lsync'), fileA);
    r = await e.sync();
    check('corrupt: a file copied under another computer\'s name is refused', r.bad === 1 && !E.has('a'));
    // the damaged file does not stop the good computer's own file being written
    A.set('a2', 2); fs.writeFileSync(fileA, 'junk'); a.tick(); r = await a.sync();
    check('corrupt: this computer\'s own file is rewritten whole over a damaged copy of it', r.written === 1 && (await e.sync()).bad === 0 && E.get('a2') === 2);
    // a file made with another passphrase (another sync set dropped in)
    const other = await mk('bad-other', 'a totally different passphrase');
    const F = new Map([['f', 9]]);
    const f = computer(other.root, other.key, 'ffffffffffff', { things: F }); await f.sync();
    fs.copyFileSync(path.join(other.dirs.data, 'things.ffffffffffff.lsync'), path.join(dirs.data, 'things.ffffffffffff.lsync'));
    r = await e.sync();
    check('corrupt: a file made with another passphrase is refused', r.bad === 1 && !E.has('f'));
    // records of the wrong shape are dropped one by one
    const bogus = await core.seal(key, { v: 1, shard: 'things', dev: '999999999999', records: { ok: { t: 5, v: 'fine' }, noT: { v: 1 }, neg: { t: -1, v: 1 }, nul: { t: 3, v: null }, str: { t: 'x', v: 1 }, tomb: { t: 4, x: 1 } } }, 'things.999999999999.lsync');
    fs.writeFileSync(path.join(dirs.data, 'things.999999999999.lsync'), bogus);
    const G = new Map([['tomb', 'still here']]); const g = computer(root, key, 'gggggggggggg', { things: G });
    await g.sync();
    check('corrupt: bad records inside a good file are skipped, the good ones are used', G.get('ok') === 'fine' && !G.has('noT') && !G.has('neg') && !G.has('nul') && !G.has('str'), JSON.stringify([...G]));
    check('corrupt: a tombstone in it still removes the record it names', !G.has('tomb'));
    // wrong claimed shard/device inside the file
    const lie = await core.seal(key, { v: 1, shard: 'other', dev: 'aaaaaaaaaaaa', records: { z: { t: 5, v: 1 } } }, 'things.888888888888.lsync');
    fs.writeFileSync(path.join(dirs.data, 'things.888888888888.lsync'), lie);
    const H = new Map(); const h = computer(root, key, 'hhhhhhhhhhhh', { things: H });
    await h.sync();
    check('corrupt: a file whose inside disagrees with its name is refused', !H.has('z'));
    // stray files are ignored
    fs.writeFileSync(path.join(dirs.data, 'things.aaaaaaaaaaaa.lsync.tmp-1-abc'), 'half');
    fs.writeFileSync(path.join(dirs.data, 'notes.txt'), 'hi');
    fs.writeFileSync(path.join(dirs.data, 'things.aaaaaaaaaaaa (1).lsync'), 'conflicted copy');
    r = await h.sync();
    check('corrupt: temp files, strangers and "conflicted copy" names are ignored', r.bad === 2 /* the foreign-passphrase file and the lying one: nothing else */, JSON.stringify(r));
    // a file of a newer format
    const ver = Buffer.from(good); ver[3] = 0x33; fs.writeFileSync(path.join(dirs.data, 'things.777777777777.lsync'), ver);
    r = await h.sync();
    check('corrupt: a newer-format file is counted as newer, not damaged', r.newer === 1);
  }

  // ---- what a pass does not do
  {
    const { root, key } = await mk('safe');
    const items = new Map(); for (let i = 0; i < 30; i++) items.set(`k${i}`, i);
    const a = computer(root, key, 'aaaaaaaaaaaa', { chats: { map: items, opts: { guard: true } } });
    await a.sync();
    // the data cannot be read right now: nothing is deleted
    const broken = new Map(items);
    const stores = { chats: { map: broken, opts: { guard: true, failScan: true } } };
    const a2 = computer(root, key, 'aaaaaaaaaaaa', stores); a2.state.providers = a.state.providers; a2.state.synced = a.state.synced; a2.state.salt = a.state.salt;
    broken.clear();
    let r = await a2.sync();
    check('safety: a store that cannot be read is skipped, and nothing is turned into a deletion', r.skipped.length === 1 && r.skipped[0].reason === 'unavailable' && r.authored === 0);
    // many vanish at once: an automatic pass refuses, "Sync now" accepts
    const gone = new Map(); const a3 = computer(root, key, 'aaaaaaaaaaaa', { chats: { map: gone, opts: { guard: true } } }); a3.state.providers = a.state.providers; a3.state.synced = a.state.synced; a3.state.salt = a.state.salt;
    r = await a3.sync();
    check('safety: 30 items vanishing at once is not trusted by an automatic pass', r.skipped[0]?.reason === 'mass-delete' && r.authored === 0, JSON.stringify(r.skipped));
    const b = new Map(); const bc = computer(root, key, 'bbbbbbbbbbbb', { chats: { map: b, opts: { guard: true } } }); await bc.sync();
    check('safety: and the other computer still has them', b.size === 30);
    a3.tick(); r = await a3.sync({ force: true });
    check('safety: Sync now (force) takes it as meant and records the deletions', r.authored === 30);
    await bc.sync();
    check('safety: which then reach the other computer', b.size === 0);
    // a few deletions are normal
    const small = new Map([['a', 1], ['b', 2], ['c', 3]]);
    const s = computer(root, key, 'dddddddddddd', { small: { map: small, opts: { guard: true } } }); await s.sync();
    small.clear(); s.tick(); r = await s.sync();
    check('safety: a few deletions pass the guard', r.authored === 3 && !r.skipped.length);
    // a setting that is at its default (missing) is not a deletion
    const prefs = new Map([['theme', 'dark']]);
    const p1 = computer(root, key, 'eeeeeeeeeeee', { prefs: { map: prefs, opts: { tombstones: false } } }); await p1.sync();
    prefs.clear(); p1.tick(); r = await p1.sync();
    const prefsB = new Map(); const p2 = computer(root, key, 'ffffffffffff', { prefs: { map: prefsB, opts: { tombstones: false } } }); await p2.sync();
    check('safety: a provider without tombstones never deletes (a missing setting is its default)', r.authored === 0 && prefsB.get('theme') === 'dark');
  }

  // ---- files, shards and the folder's contents
  {
    const { root, key, dirs } = await mk('shards');
    const chats = new Map([['aaaaaaaaaaaaaaaa', 'chat one'], ['bbbbbbbbbbbbbbbb', 'chat two']]);
    const a = computer(root, key, 'aaaaaaaaaaaa', { chats: { map: chats, opts: { sharded: true } }, bookmarks: new Map([['u', 1]]) });
    await a.sync();
    check('shards: each chat is its own file, other kinds are one file each', files(root).sort().join() === 'bookmarks.aaaaaaaaaaaa.lsync,chats-aaaaaaaaaaaaaaaa.aaaaaaaaaaaa.lsync,chats-bbbbbbbbbbbbbbbb.aaaaaaaaaaaa.lsync', files(root).join());
    chats.set('aaaaaaaaaaaaaaaa', 'chat one, longer'); a.tick(); await a.sync();
    const mtimes = Object.fromEntries(files(root).map((f) => [f, fs.statSync(path.join(dirs.data, f)).mtimeMs]));
    a.tick(); chats.set('bbbbbbbbbbbbbbbb', 'chat two, edited'); await new Promise((r) => setTimeout(r, 20)); await a.sync();
    const after = Object.fromEntries(files(root).map((f) => [f, fs.statSync(path.join(dirs.data, f)).mtimeMs]));
    check('shards: untouched files are not rewritten', after['chats-aaaaaaaaaaaaaaaa.aaaaaaaaaaaa.lsync'] === mtimes['chats-aaaaaaaaaaaaaaaa.aaaaaaaaaaaa.lsync'] && after['chats-bbbbbbbbbbbbbbbb.aaaaaaaaaaaa.lsync'] !== mtimes['chats-bbbbbbbbbbbbbbbb.aaaaaaaaaaaa.lsync']);
    const B = new Map(); const b = computer(root, key, 'bbbbbbbbbbbb', { chats: { map: B, opts: { sharded: true } }, bookmarks: new Map() });
    await b.sync();
    check('shards: another computer gets every chat', B.size === 2 && B.get('bbbbbbbbbbbbbbbb') === 'chat two, edited');
    chats.delete('aaaaaaaaaaaaaaaa'); a.tick(); await a.sync(); await b.sync();
    check('shards: a deleted chat leaves a tombstone in its own file and is removed elsewhere', !B.has('aaaaaaaaaaaaaaaa') && B.has('bbbbbbbbbbbbbbbb') && files(root).includes('chats-aaaaaaaaaaaaaaaa.aaaaaaaaaaaa.lsync'));
    // nothing in the folder is readable text
    const everything = fs.readdirSync(dirs.data).map((f) => fs.readFileSync(path.join(dirs.data, f)).toString('latin1')).join('');
    check('files: no value or key appears in plain text in the folder', !/chat two|chat one|aaaaaaaaaaaaaaaa"/.test(everything.replace(/chats-[a-f]+/g, '')));
    // the device list
    const list = await b.engine.devices();
    check('devices: each computer that synced is listed with its name', list.length === 2 && list.find((d) => d.self).name === 'pc-bbbbbbbbbbbb' && list.some((d) => d.name === 'pc-aaaaaaaaaaaa' && !d.self), JSON.stringify(list));
    const devText = fs.readFileSync(path.join(dirs.devices, 'aaaaaaaaaaaa.lsync')).toString('latin1');
    check('devices: and the names are encrypted too', !devText.includes('pc-aaaaaaaaaaaa'));
  }

  // ---- tidying: replaced records, old tombstones, an emptied folder
  {
    const { root, key, dirs } = await mk('tidy');
    const A = new Map([['k', 'v1']]); const B = new Map();
    const a = computer(root, key, 'aaaaaaaaaaaa', { things: A });
    const b = computer(root, key, 'bbbbbbbbbbbb', { things: B });
    await a.sync(); await b.sync();
    b.tick(10000); B.set('k', 'v2'); await b.sync(); a.tick(20000); await a.sync();
    check('tidy: a record another computer replaced is dropped from this computer\'s file, and the empty file goes', !files(root).includes('things.aaaaaaaaaaaa.lsync') && A.get('k') === 'v2', files(root).join());
    // tombstones are kept 180 days, then dropped
    B.delete('k'); b.tick(); await b.sync();
    check('tidy: a tombstone is kept', Object.values(b.engine.ownRecords().get('things').records).some((r) => r.x === 1));
    b.tick(core.TOMBSTONE_MS + 1000); await b.sync();
    check('tidy: and dropped after 180 days', !b.engine.ownRecords().get('things') || !Object.keys(b.engine.ownRecords().get('things').records).length);
    // the folder is emptied (the cloud lost it): a computer puts its data back
    const C = new Map([['x', 1], ['y', 2]]); const c = computer(root, key, 'cccccccccccc', { more: C }); await c.sync();
    const D = new Map(); const d = computer(root, key, 'dddddddddddd', { more: D }); await d.sync();
    for (const f of fs.readdirSync(dirs.data)) fs.rmSync(path.join(dirs.data, f));
    D.set('z', 3); d.tick(); await d.sync(); // d holds what it had received (x, y) and its own z
    check('tidy: after the folder was emptied the computer that still has the data puts it back', D.get('x') === 1 && fs.readdirSync(dirs.data).some((f) => f.startsWith('more.dddddddddddd')));
    const E = new Map(); const e = computer(root, key, 'eeeeeeeeeeee', { more: E }); await e.sync();
    check('tidy: so a new computer still gets everything', E.size === 3 && E.get('y') === 2);
    // our own file is deleted behind our back
    fs.rmSync(path.join(dirs.data, 'more.dddddddddddd.lsync'));
    const d2 = computer(root, key, 'dddddddddddd', { more: D }); d2.state.providers = d.state.providers; d2.state.synced = d.state.synced; d2.state.salt = d.state.salt;
    await d2.sync();
    check('tidy: our own file that was removed is written again', fs.existsSync(path.join(dirs.data, 'more.dddddddddddd.lsync')));
  }

  // ---- held changes, hints, combine, concurrency
  {
    const { root, key } = await mk('misc');
    const A = new Map([['k', 'A']]); const a = computer(root, key, 'aaaaaaaaaaaa', { things: A }); await a.sync();
    const B = new Map(); const hold = new Set(['k']); const applied = [];
    const b = computer(root, key, 'bbbbbbbbbbbb', { things: { map: B, opts: { hold, applied } } });
    let r = await b.sync();
    check('held: a change the store cannot take now is held, and not counted as applied', r.deferred === 1 && r.applied === 0 && !B.has('k'));
    hold.clear(); r = await b.sync();
    check('held: it is tried again on the next pass and then applied', r.applied === 1 && B.get('k') === 'A');
    // a record stamped by its own time (history: the last visit)
    const H1 = new Map([['u', { visits: 2, last: 5000 }]]); const H2 = new Map([['u', { visits: 7, last: 3000 }]]);
    const combine = (w, others) => ({ ...w, visits: Math.max(w.visits, ...others.map((o) => o.visits)) });
    const opts = { hint: (v) => v.last, combine };
    const h1 = computer(root, key, 'cccccccccccc', { history: { map: H1, opts } }, { start: 900_000 });
    await h1.sync();
    const h2 = computer(root, key, 'dddddddddddd', { history: { map: H2, opts } }, { start: 900_000 });
    await h2.sync();
    check('hint: a record is stamped with its own time, so the later visit wins whatever the clocks say', H2.get('u').last === 5000, JSON.stringify(H2.get('u')));
    check('combine: a provider can keep the larger count from the other versions', H2.get('u').visits === 7);
    // passes may overlap in a caller; two engines on one folder at once never throw
    const X = new Map([['k1', 1]]); const Y = new Map([['k2', 2]]);
    const x = computer(root, key, 'eeeeeeeeeeee', { par: X }); const y = computer(root, key, 'ffffffffffff', { par: Y });
    const both = await Promise.all([x.sync(), y.sync()]);
    await x.sync(); await y.sync();
    check('concurrent: two computers syncing at the same moment converge on the next pass', both.every((o) => !o.errors.length) && X.size === 2 && Y.size === 2);
    // the engine reports a folder that went away, and works again when it returns
    const gone = tmp('gone');
    const o = await core.openFolder(gone, 'phrase of passphrase');
    const G = new Map([['k', 1]]); const g = computer(gone, o.key, 'aaaaaaaaaaaa', { things: G });
    await g.sync();
    fs.rmSync(path.join(gone, core.DIR_NAME), { recursive: true });
    check('folder gone: a pass says the folder is not there', await rejects(() => g.sync(), 'no-folder'));
    await core.openFolder(gone, 'phrase of passphrase');
    G.set('k2', 2); g.tick();
    const back = await g.sync();
    check('folder gone: a later pass works once it is back, and writes everything again', back.errors.length === 0 && fs.readdirSync(core.dirsOf(gone).data).some((f) => f.startsWith('things.aaaaaaaaaaaa')));
    // large records
    const big = new Map(); for (let i = 0; i < 3000; i++) big.set(`https://site${i}.example/path`, { title: `Title number ${i}`, visits: i, last: i });
    const bg = computer(root, key, 'aaaaaaaaaaab', { bigset: big }); const t0 = Date.now(); await bg.sync();
    const small = new Map(); const sm = computer(root, key, 'aaaaaaaaaaac', { bigset: small }); await sm.sync();
    check('size: three thousand records sync in well under a few seconds', small.size === 3000 && Date.now() - t0 < 8000, `${small.size} ${Date.now() - t0}ms`);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
