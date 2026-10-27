// [auto-delete chats] features/chat-auto-delete.js: which saved chats "Delete chats not in a project after" picks, against plain lists and
// against a real chat store in a temp folder (projects, pins, archive, trash, another writer's chats), and the setting's validation.
// Plain Node; every folder is a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expiredChats, cleanDays, CHOICES, DAY_MS, MAX_PER_SWEEP } = require('../../src/features/chat-auto-delete');
const { createChatStore } = require('../../src/features/chat-store');
const { validate, DEFAULTS } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOW = 1_800_000_000_000;
const ago = (days) => NOW - days * DAY_MS;
const chat = (id, days, extra = {}) => ({ id, updated: ago(days), created: ago(400), ...extra });

// ---- the setting
check('off by default', DEFAULTS.chatAutoDeleteDays === 0);
check('every menu choice is valid', CHOICES.every((n) => validate('chatAutoDeleteDays', n) === n && validate('chatAutoDeleteDays', String(n)) === n));
check('anything else is refused', [-1, 2, 3.5, 'abc', null, undefined, true, 10000].every((v) => validate('chatAutoDeleteDays', v) === null));
check('cleanDays: 0 is Never, not invalid', cleanDays(0) === 0 && cleanDays(5) === null);

// ---- the pure pick
{
  const chats = [chat('old', 40), chat('new', 2), chat('edge', 30)];
  check('off (0) picks nothing', expiredChats({ chats, days: 0, now: NOW }).length === 0);
  check('an invalid number of days picks nothing', expiredChats({ chats, days: 5, now: NOW }).length === 0 && expiredChats({ chats, days: -30, now: NOW }).length === 0);
  check('only chats unused for longer than the days', same(expiredChats({ chats, days: 30, now: NOW }), ['old']), expiredChats({ chats, days: 30, now: NOW }));
  check('a shorter time picks more, the longest unused first', same(expiredChats({ chats, days: 1, now: NOW }), ['old', 'edge', 'new']));
}
{
  // last activity, not creation: a chat started a year ago and used yesterday stays
  const chats = [{ id: 'revived', created: ago(365), updated: ago(1) }, { id: 'stale', created: ago(31), updated: ago(31) }];
  check('counted from the last message, not from when it was started', same(expiredChats({ chats, days: 30, now: NOW }), ['stale']));
}
{
  const projectIds = new Set(['p1']);
  const chats = [
    chat('in-project', 100, { project: 'p1' }),
    chat('gone-project', 100, { project: 'p-removed' }), // its project was deleted: it is in no project now
    chat('pinned', 100, { pinned: true }),
    chat('archived', 100, { archived: true }),
    chat('trashed', 100, { trashed: ago(0) }),
    chat('missing', 100, { missing: true }),
    chat('open', 100),
    chat('foreign', 100),
    chat('plain', 100),
  ];
  const ids = expiredChats({ chats, days: 7, now: NOW, projectIds, keep: new Set(['open']), foreign: (id) => id === 'foreign' });
  check('a chat in a project is never picked', !ids.includes('in-project'));
  check('a chat whose project was removed counts as in no project', ids.includes('gone-project'));
  check('a pinned chat is never picked', !ids.includes('pinned'));
  check('an archived chat counts like the rest', ids.includes('archived'));
  check('trashed, unreadable, open and another writer\'s chats are left alone', !['trashed', 'missing', 'open', 'foreign'].some((id) => ids.includes(id)), ids);
  check('the rest is picked', ids.includes('plain') && ids.length === 3, ids);
}
{
  const bad = [null, {}, { id: 'no-date' }, { id: 'zero', updated: 0 }, { id: 'nan', updated: NaN }, { id: 5, updated: ago(100) }];
  check('entries with no usable date or id are never picked', expiredChats({ chats: bad, days: 1, now: NOW }).length === 0);
}
{
  const many = Array.from({ length: 60 }, (_, i) => chat(`c${i}`, 100 + i));
  const ids = expiredChats({ chats: many, days: 7, now: NOW });
  check(`at most ${MAX_PER_SWEEP} per sweep, the oldest first`, ids.length === MAX_PER_SWEEP && ids[0] === 'c59' && ids[MAX_PER_SWEEP - 1] === `c${60 - MAX_PER_SWEEP}`, ids.slice(0, 3));
  check('max can be set', expiredChats({ chats: many, days: 7, now: NOW, max: 2 }).length === 2 && expiredChats({ chats: many, days: 7, now: NOW, max: -1 }).length === 0);
}

// ---- against a real chat store
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-autodelete-'));
const enc = (t) => Buffer.from(t).toString('base64');
const dec = (b) => Buffer.from(b, 'base64').toString();
const snap = (text) => ({ settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
try {
  const dir = path.join(root, 'store');
  let clock = ago(200);
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => clock });
  const made = {};
  for (const [name, daysAgo] of [['old', 120], ['project', 120], ['pinned', 120], ['archived', 120], ['recent', 3], ['open', 120]]) {
    clock = ago(daysAgo);
    made[name] = store.newId();
    store.save(made[name], snap(name));
  }
  clock = NOW;
  const p = store.saveProject({ name: 'Thesis' });
  store.setProject(made.project, p.id);
  store.setPinned(made.pinned, true);
  store.setArchived(made.archived, true);
  const touched = store.newId();
  clock = ago(120); store.save(touched, snap('touched'));
  clock = NOW; store.touch(touched, ago(1)); // a message sent yesterday
  const pick = () => expiredChats({ chats: store.list(), days: 30, now: NOW, projectIds: new Set(store.projects().map((x) => x.id)), keep: new Set([made.open]), foreign: store.isForeign });
  const ids = pick();
  check('store: old chats in no project are picked (archived too)', ids.includes(made.old) && ids.includes(made.archived), ids);
  check('store: project, pinned, recent, open and just-used chats stay', ![made.project, made.pinned, made.recent, made.open, touched].some((id) => ids.includes(id)), ids);
  check('store: the list is trusted to decide (read, not rebuilt)', store.trusted());
  // deleted the way main.js does it: trash, then remove
  for (const id of ids) { store.trash(id); store.remove(id); }
  const left = store.list().map((c) => c.id).sort();
  check('store: what was picked is gone, files and all', ids.every((id) => !store.has(id) && !fs.existsSync(path.join(dir, `${id}.json`))));
  check('store: everything else is still there', same(left, [made.project, made.pinned, made.recent, made.open, touched].sort()), left);
  check('store: a second sweep picks nothing more', pick().length === 0);
  // the project is removed: its chat is in no project now, and old enough
  store.removeProject(p.id);
  check('store: a chat whose project was deleted is picked next time', same(pick(), [made.project]));

  // another Lumen on the same profile adds a chat to the index on disk: this store never picks it
  const other = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ago(120) });
  const theirs = other.newId();
  other.save(theirs, snap('theirs'));
  clock = NOW;
  store.save(made.recent, snap('recent again')); // (a write here merges the disk's index: their chat joins ours as another writer's)
  check('store: another writer\'s chat is listed but marked', store.list().some((c) => c.id === theirs) && store.isForeign(theirs) && !store.isForeign(made.recent));
  check('store: another writer\'s chat is never picked', !pick().includes(theirs), pick());

  // an index rebuilt from the chat files (lost its projects and pins) must not be trusted
  const dir2 = path.join(root, 'rebuilt');
  const s2 = createChatStore({ dir: dir2, encrypt: enc, decrypt: dec, now: () => ago(120) });
  const a = s2.newId(); s2.save(a, snap('a'));
  fs.writeFileSync(path.join(dir2, 'index.json'), 'not json');
  const s3 = createChatStore({ dir: dir2, encrypt: enc, decrypt: dec, now: () => NOW });
  check('store: a rebuilt list is not trusted (main.js skips the sweep)', s3.list().length === 1 && s3.trusted() === false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
