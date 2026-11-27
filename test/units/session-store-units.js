// The saved session's own file (settings/session-store.js): the move out of settings.json, a crash between its two
// writes, older versions on either side of the move, and the atomic write itself. Plain node: node test/units/session-store-units.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sf = require('../../src/settings/settings-file');
const { createSessionStore, MARK } = require('../../src/settings/session-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-session-'));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const S = (tag) => ({ urls: [`https://${tag}.example/`], titles: [tag], active: 0, groups: [] });
let n = 0;
const ok = (name) => { n++; console.log(`ok  ${name}`); };

// What main.js does at its first settings read: load settings.json, move a session key out of it.
function start(dir, over = {}) {
  const settingsPath = path.join(dir, 'settings.json');
  const store = createSessionStore({ dir, settingsPath, ...over });
  const settings = store.migrate(sf.loadJson(settingsPath), over.writeSettings || ((s) => sf.writeJsonAtomic(settingsPath, s)));
  return { store, settings, settingsPath, sessionPath: store.file() };
}
const age = (file, secondsAgo) => { const t = new Date(Date.now() - secondsAgo * 1000); fs.utimesSync(file, t, t); };

(async () => {
  // ---- a fresh profile
  {
    const dir = tmp();
    const { store, settings, sessionPath } = start(dir);
    assert.deepStrictEqual(settings, {}, 'no settings yet');
    assert.strictEqual(store.get(), null, 'no session yet');
    assert.ok(!fs.existsSync(sessionPath), 'reading writes nothing');
    ok('fresh profile: no session, nothing written');
  }

  // ---- the move from an older version's settings.json
  {
    const dir = tmp();
    const old = { model: 'sonnet', bookmarks: [{ url: 'https://b.example/' }], permissions: { a: 1 }, session: S('old') };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(old, null, 2));
    const { store, settings, settingsPath, sessionPath } = start(dir);
    assert.deepStrictEqual(store.get(), S('old'), 'the session comes over');
    assert.deepStrictEqual(read(sessionPath), { version: 1, session: S('old') }, 'session.json holds it');
    const onDisk = read(settingsPath);
    assert.ok(!('session' in onDisk), 'settings.json no longer has it');
    assert.strictEqual(onDisk[MARK], 'session.json', 'and says where it went');
    const { session, ...rest } = old;
    assert.deepStrictEqual({ ...onDisk, [MARK]: undefined }, { ...rest, [MARK]: undefined }, 'every other setting is as it was');
    assert.deepStrictEqual(settings, onDisk, 'the settings in memory are the file');
    // a second start finds nothing to move
    const again = start(dir);
    assert.deepStrictEqual(again.store.get(), S('old'), 'restored on the next start');
    ok('migration: the session key moves to session.json, the settings stay');
  }

  // ---- a crash between the two writes (session.json on disk, settings.json still with the key)
  {
    const dir = tmp();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'm', session: S('first') }));
    age(settingsPath, 60);
    // run 1: session.json written, then the process dies before settings.json is rewritten
    const r1 = createSessionStore({ dir, settingsPath });
    let wrote = false;
    r1.migrate(sf.loadJson(settingsPath), () => { wrote = true; }); // (nothing reaches settings.json)
    assert.ok(wrote, 'the settings write was asked for (and never reached the disk)');
    assert.ok('session' in read(settingsPath), 'settings.json still holds the key');
    assert.deepStrictEqual(read(r1.file()).session, S('first'), 'session.json is on disk');
    // run 1 goes on and saves a newer session before dying
    r1.save(S('newer'));
    age(settingsPath, 60);
    // run 2: settings.json (older, no marker) still has the first session: session.json wins and the move finishes
    const r2 = start(dir);
    assert.deepStrictEqual(r2.store.get(), S('newer'), 'the newer session in session.json is kept');
    assert.ok(!('session' in read(settingsPath)), 'the leftover key is taken out');
    assert.strictEqual(read(settingsPath).model, 'm', 'settings intact');
    ok('crash between the writes: the next start finishes the move, nothing older wins');
  }

  // ---- a crash while session.json itself is written: settings.json keeps the key, nothing is lost
  {
    const dir = tmp();
    const settingsPath = path.join(dir, 'settings.json');
    const before = JSON.stringify({ model: 'm', session: S('keep') });
    fs.writeFileSync(settingsPath, before);
    const failing = { ...sf, writeJsonAtomic: (file, data, space) => { if (file.endsWith('session.json')) throw new Error('disk full'); return sf.writeJsonAtomic(file, data, space); } };
    const store = createSessionStore({ dir, settingsPath, settingsFile: failing });
    let settingsWrites = 0;
    assert.throws(() => store.migrate(sf.loadJson(settingsPath), () => { settingsWrites++; }), /disk full/);
    assert.strictEqual(settingsWrites, 0, 'settings.json is not touched before session.json is safe');
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), before, 'settings.json unchanged, still with the session');
    const next = start(dir);
    assert.deepStrictEqual(next.store.get(), S('keep'), 'the next start moves it');
    ok('session.json write fails: settings.json keeps the session');
  }

  // ---- the atomic write: a half-written temp file (crash before the rename) never replaces the good file
  {
    const dir = tmp();
    const { store, sessionPath } = start(dir);
    store.save(S('one'));
    store.save(S('two'));
    assert.deepStrictEqual(read(`${sessionPath}.bak`).session, S('one'), 'the previous good file is the .bak');
    fs.writeFileSync(`${sessionPath}.tmp`, '{"version":1,"sess'); // a crash mid-write
    fs.writeFileSync(`${sessionPath}.tmp-async`, '{"vers');
    assert.deepStrictEqual(createSessionStore({ dir }).get(), S('two'), 'the renamed file is whole');
    fs.writeFileSync(sessionPath, '{"version":1,"session":{"ur'); // the main file torn (a non-atomic writer, a disk error)
    assert.deepStrictEqual(createSessionStore({ dir }).get(), S('one'), 'a torn session.json falls back to its .bak');
    ok('atomic write: temp + rename, a torn file falls back to the .bak');
  }

  // ---- background saves: off the main thread, the latest wins, a flush lands a pending one
  {
    const dir = tmp();
    const { store, sessionPath } = start(dir);
    const p1 = store.save(S('bg1'), { background: true });
    store.save(S('sync')); // closing: written at once, newer than the background one
    await p1;
    assert.deepStrictEqual(read(sessionPath).session, S('sync'), 'an older background write never lands over a newer one');
    const p2 = store.save(S('bg2'), { background: true });
    assert.ok(store.pending(), 'pending until on disk');
    store.flush(); // quitting
    assert.deepStrictEqual(read(sessionPath).session, S('bg2'), 'flush writes it at once');
    await p2;
    assert.deepStrictEqual(read(sessionPath).session, S('bg2'));
    const p3 = store.save(S('bg3'), { background: true });
    await p3;
    assert.ok(!store.pending(), 'done');
    assert.deepStrictEqual(read(sessionPath).session, S('bg3'));
    ok('background saves: latest wins, flush lands a pending one');
  }

  // ---- a settings write that still carries a session (an older code path, a test's patch)
  {
    const dir = tmp();
    const { store } = start(dir);
    const rest = store.split({ model: 'x', session: null });
    assert.deepStrictEqual(rest, { model: 'x' }, 'the session is taken out of the settings write');
    assert.strictEqual(store.get(), null);
    assert.deepStrictEqual(store.split({ model: 'y' }), { model: 'y' }, 'settings without a session pass through');
    ok('split: a session in a settings write goes to session.json');
  }

  // ---- an older version after the move (a downgrade, then this version again)
  {
    const dir = tmp();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'm', session: S('before') }));
    start(dir).store.save(S('new-version'));
    // the older version reads settings.json: every setting is there (no session: it opens a new tab), and it saves { ...settings, session }
    const seen = sf.loadJson(settingsPath);
    assert.strictEqual(seen.model, 'm', 'an older version reads the settings');
    sf.writeJsonAtomic(settingsPath, { ...seen, session: S('old-version') });
    age(settingsPath, 60); // (older than session.json on the clock: the marker alone decides)
    assert.strictEqual(read(settingsPath)[MARK], 'session.json', 'the older version kept the marker');
    const back = start(dir);
    assert.deepStrictEqual(back.store.get(), S('old-version'), 'the session the older version saved is the newer one');
    assert.ok(!('session' in read(settingsPath)));
    ok('downgrade and back: the older version keeps the settings, its session is taken up');
  }

  // ---- settings.json written after session.json without the marker (a profile copied in): it wins; restored from an old .bak: it doesn't
  {
    const dir = tmp();
    const settingsPath = path.join(dir, 'settings.json');
    const { store, sessionPath } = start(dir);
    store.save(S('current'));
    age(sessionPath, 120);
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'copied', session: S('copied') }));
    assert.deepStrictEqual(start(dir).store.get(), S('copied'), 'a settings.json newer than session.json brings its session');

    const d2 = tmp();
    const sp2 = path.join(d2, 'settings.json');
    fs.writeFileSync(`${sp2}.bak`, JSON.stringify({ model: 'm', session: S('stale') })); // from before the move
    const s2 = createSessionStore({ dir: d2 });
    s2.save(S('current'));
    age(s2.file(), 120);
    fs.writeFileSync(sp2, '{"model":"m",'); // settings.json torn: loadJson falls back to the .bak
    assert.deepStrictEqual(start(d2).store.get(), S('current'), 'a stale session from settings.json.bak never wins');
    ok('which session wins: newer settings.json yes, a restored .bak no');
  }

  // ---- session.json unreadable and no .bak: the copy left in settings.json is better than none
  {
    const dir = tmp();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(path.join(dir, 'session.json'), 'not json');
    fs.writeFileSync(settingsPath, JSON.stringify({ session: S('only-copy') }));
    age(settingsPath, 120);
    assert.deepStrictEqual(start(dir).store.get(), S('only-copy'));
    ok('unreadable session.json: the settings copy is used');
  }

  console.log(`\n${n} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
