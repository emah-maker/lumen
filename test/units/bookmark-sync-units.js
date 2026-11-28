// [sync] The bookmarks bar's order and folders through Sync (features/sync-providers.js bookmarks, over features/sync-core.js).
// Plain Node: a temp folder stands in for the cloud drive; each "computer" is an engine with its own clock and its own settings
// (bookmarks + bookmarkLayout), changed through the bar's own model (features/bookmark-bar.js) as the bar changes them.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../../src/features/sync-core');
const P = require('../../src/features/sync-providers');
const BB = require('../../src/features/bookmark-bar');
const { kindsChanged } = require('../../src/features/sync-folder');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = JSON.stringify;
const shape = (s, p = '') => BB.childrenOf(s.bookmarks, s.bookmarkLayout, p)
  .map((c) => (c.type === 'link' ? c.title : `[${c.name}: ${shape(s, c.path)}]`)).join(' ');
const U = (x) => `https://${x}.test/`;

function computer(dirs, key, id, start) {
  const pc = { settings: { bookmarks: [], bookmarkLayout: { folders: [], order: {} } }, clock: { t: start } };
  const provider = P.bookmarks({
    read: () => pc.settings.bookmarks,
    readLayout: () => pc.settings.bookmarkLayout,
    write: (list, layout) => { pc.settings = { ...pc.settings, bookmarks: list, ...(layout ? { bookmarkLayout: layout } : {}) }; },
  });
  pc.engine = core.createEngine({ dirs, key, deviceId: id, deviceName: id, state: {}, providers: [provider], now: () => pc.clock.t, saveState: async () => {} });
  pc.sync = async () => { await pc.engine.sync({}); pc.clock.t += 1000; };
  // One change on the bar: fn(list, layout) -> { list, layout } (a bookmark-bar.js function).
  pc.bar = (fn) => { const r = fn(pc.settings.bookmarks, pc.settings.bookmarkLayout); pc.settings = { ...pc.settings, bookmarks: r.list, bookmarkLayout: r.layout }; return r; };
  return pc;
}

(async () => {
  // ---- mergeOrder: the newer order, with what only the other had put back after its neighbour
  check('mergeOrder: the winner as it is when the others hold nothing new', J(P.mergeOrder(['u:a', 'u:b'], [['u:b', 'u:a']])) === J(['u:a', 'u:b']));
  check('mergeOrder: a key only another has goes after the same neighbour', J(P.mergeOrder(['u:b', 'u:a', 'u:c'], [['u:a', 'u:x', 'u:c']])) === J(['u:b', 'u:a', 'u:x', 'u:c']));
  check('mergeOrder: a new first key stays first', J(P.mergeOrder(['u:a', 'u:b'], [['u:x', 'u:a', 'u:b']])) === J(['u:x', 'u:a', 'u:b']));
  check('mergeOrder: from two others, both kept', J(P.mergeOrder(['u:a'], [['u:a', 'u:x'], ['u:y', 'u:a']])) === J(['u:y', 'u:a', 'u:x']));
  check('mergeOrder: junk and duplicates are dropped', J(P.mergeOrder(['u:a', 'u:a', 7, 'zzz'], ['bad', null, ['f:F']])) === J(['f:F', 'u:a']), J(P.mergeOrder(['u:a', 'u:a', 7, 'zzz'], ['bad', null, ['f:F']])));

  // ---- the provider on its own
  {
    let s = { bookmarks: [{ url: U('a'), title: 'A' }, { url: U('b'), title: 'B', folder: 'Work/Deep' }], bookmarkLayout: { folders: ['Empty', 'Work/Deep'], order: { '': ['f:Work', 'u:' + U('a')], 'Work/Deep': ['u:' + U('b')] } } };
    const p = P.bookmarks({ read: () => s.bookmarks, readLayout: () => s.bookmarkLayout, write: (list, layout) => { s = { ...s, bookmarks: list, ...(layout ? { bookmarkLayout: layout } : {}) }; } });
    const keys = [...p.scan().keys()].sort();
    check('provider: each bookmark, each folder\'s order and each made folder is a record', J(keys) === J(['e:Empty', 'e:Work/Deep', U('a'), U('b'), 'o:', 'o:Work/Deep'].sort()), J(keys));
    check('provider: a nested folder path syncs whole', p.scan().get(U('b')).value.folder === 'Work/Deep');
    p.apply([{ key: 'o:', value: ['u:' + U('a'), 'f:Work', 'u:' + U('gone')], deleted: false }, { key: 'e:Empty', deleted: true }]);
    check('provider: an order that arrives is kept to what is here', J(s.bookmarkLayout.order['']) === J(['u:' + U('a'), 'f:Work']), J(s.bookmarkLayout));
    check('provider: a folder deleted elsewhere goes', !s.bookmarkLayout.folders.includes('Empty'), J(s.bookmarkLayout.folders));
    p.apply([{ key: 'e:New/Sub', value: { folder: 'Other' }, deleted: false }]);
    check('provider: a folder record that does not name its own key is ignored', !s.bookmarkLayout.folders.includes('New/Sub') && !s.bookmarkLayout.folders.includes('Other'));
    // An older Lumen (no readLayout): layout records are not bookmarks, and never reach the list.
    let old = [{ url: U('a'), title: 'A' }];
    const p0 = P.bookmarks({ read: () => old, write: (l) => { old = l; } });
    p0.apply([{ key: 'o:', value: ['u:x'], deleted: false }, { key: 'e:F', value: { folder: 'F' }, deleted: false }, { key: U('c'), value: { url: U('c'), title: 'C' }, deleted: false }]);
    check('provider: without the layout, layout records are skipped and bookmarks still apply', J(old.map((b) => b.url)) === J([U('a'), U('c')]), J(old));
    check('provider: without the layout, scan has only bookmarks', [...p0.scan().keys()].every((k) => k.startsWith('https://')));
    check('sync service: a change to the bar\'s layout alone starts a bookmarks pass', J(kindsChanged({ bookmarkLayout: { a: 1 } }, { bookmarkLayout: { a: 2 } })) === J(['bookmarks']));
  }

  // ---- two computers
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bmsync-'));
  const { key, dirs } = await core.openFolder(root, 'correct horse battery');
  const A = computer(dirs, key, 'aaaaaaaaaaaa', 1_000_000);
  const B = computer(dirs, key, 'bbbbbbbbbbbb', 1_000_500);

  A.bar((l, y) => BB.addLink(l, y, { url: U('a'), title: 'A' }));
  A.bar((l, y) => BB.addLink(l, y, { url: U('b'), title: 'B' }));
  A.bar((l, y) => BB.newFolder(l, y, { name: 'Work' }));
  A.bar((l, y) => BB.newFolder(l, y, { parent: 'Work', name: 'Deep' }));
  A.bar((l, y) => BB.addLink(l, y, { url: U('c'), title: 'C', folder: 'Work/Deep' }));
  A.bar((l, y) => BB.newFolder(l, y, { name: 'Empty' }));
  A.bar((l, y) => BB.move(l, y, { key: 'f:Work', to: '', index: 0 }));
  await A.sync(); await B.sync();
  check('two: the bar comes across in its order, with nested and empty folders', shape(B.settings) === shape(A.settings) && shape(B.settings) === '[Work: [Deep: C]] A B [Empty: ]', `${shape(A.settings)} / ${shape(B.settings)}`);

  // Each reorders a different folder: both changes stay.
  A.bar((l, y) => BB.addLink(l, y, { url: U('d'), title: 'D', folder: 'Work/Deep' }));
  await A.sync(); await B.sync();
  A.bar((l, y) => BB.move(l, y, { key: 'u:' + U('b'), to: '', index: 0 }));
  B.bar((l, y) => BB.move(l, y, { key: 'u:' + U('d'), to: 'Work/Deep', index: 0 }));
  await A.sync(); await B.sync(); await A.sync();
  check('two: different folders reordered on each computer: both kept', shape(A.settings) === shape(B.settings) && shape(A.settings) === 'B [Work: [Deep: D C]] A [Empty: ]', `${shape(A.settings)} / ${shape(B.settings)}`);

  // Both change the bar itself at once: the newer order wins, and a link the other added keeps its place.
  A.bar((l, y) => BB.move(l, y, { key: 'u:' + U('a'), to: '', index: 0 })); // A: A B [Work] [Empty]
  B.clock.t = A.clock.t + 5000;
  B.bar((l, y) => BB.addLink(l, y, { url: U('n'), title: 'N', index: 1 })); // B: B N [Work] A [Empty]
  await A.sync(); await B.sync(); await A.sync(); await B.sync();
  check('two: the same folder changed on both ends the same on both', shape(A.settings) === shape(B.settings), `${shape(A.settings)} / ${shape(B.settings)}`);
  check('two: the newer order wins and nothing is lost', shape(B.settings) === 'B N [Work: [Deep: D C]] A [Empty: ]', shape(B.settings));

  // The other way round: the newer one is the reorder; the link added on the other computer goes after the same neighbour.
  B.clock.t = A.clock.t;
  B.bar((l, y) => BB.addLink(l, y, { url: U('m'), title: 'M', index: 2 })); // after N
  A.clock.t = B.clock.t + 5000;
  A.bar((l, y) => BB.move(l, y, { key: 'f:Empty', to: '', index: 0 }));
  await B.sync(); await A.sync(); await B.sync(); await A.sync();
  check('two: a link added on the older side keeps its place in the newer order', shape(A.settings) === shape(B.settings) && shape(A.settings) === '[Empty: ] B N M [Work: [Deep: D C]] A', `${shape(A.settings)} / ${shape(B.settings)}`);

  // A folder renamed on one computer is renamed on the other; its old order and empty-folder records go.
  A.bar((l, y) => BB.renameFolder(l, y, 'Work', 'Office'));
  await A.sync(); await B.sync();
  check('two: a renamed folder arrives renamed, in its place, with what it held', shape(B.settings) === '[Empty: ] B N M [Office: [Deep: D C]] A', shape(B.settings));
  check('two: nothing is left under the old name', ![...BB.allFolders(B.settings.bookmarks, B.settings.bookmarkLayout)].some((p) => p.startsWith('Work')) && !Object.keys(B.settings.bookmarkLayout.order).some((p) => p.startsWith('Work')), J(B.settings.bookmarkLayout));

  // A folder deleted on one computer goes from the other, with its links.
  B.bar((l, y) => BB.removeFolder(l, y, 'Office/Deep'));
  B.bar((l, y) => BB.removeFolder(l, y, 'Empty'));
  await B.sync(); await A.sync();
  check('two: deleted folders go on the other computer too', shape(A.settings) === shape(B.settings) && shape(A.settings) === 'B N M [Office: ] A', `${shape(A.settings)} / ${shape(B.settings)}`);
  check('two: and their links', !A.settings.bookmarks.some((b) => b.url === U('c') || b.url === U('d')), J(A.settings.bookmarks));

  // A third computer joining later gets the same bar.
  const C = computer(dirs, key, 'cccccccccccc', A.clock.t + 10);
  await C.sync();
  check('join: a computer that joins gets the bar as it is', shape(C.settings) === shape(A.settings), `${shape(C.settings)} / ${shape(A.settings)}`);

  // Quiet: a pass with nothing changed writes nothing.
  const before = fs.readdirSync(dirs.data).map((f) => fs.statSync(path.join(dirs.data, f)).mtimeMs).join();
  await A.sync(); await B.sync(); await C.sync();
  const after = fs.readdirSync(dirs.data).map((f) => fs.statSync(path.join(dirs.data, f)).mtimeMs).join();
  check('quiet: passes with no change rewrite no file (no ping-pong over the order)', before === after);

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
