// The chat library (features/chat-store.js): pin, archive, delete with undo, no silent pruning, search over message text, and
// old index files that have none of these fields. Plain Node; every folder is a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chat-library-'));
const enc = (t) => Buffer.from(t).toString('base64');
const dec = (b) => Buffer.from(b, 'base64').toString();
const snap = (text, reply = 'ok') => ({ settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: reply }] }] });
const hexId = (n) => n.toString(16).padStart(16, '0');
let clock = 1000;
const mk = (dir, opts = {}) => createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ++clock, ...opts });
const files = (dir) => fs.readdirSync(dir).filter((n) => /^[a-f0-9]{16}\.json$/.test(n)).sort();
const readIndexFile = (dir) => JSON.parse(dec(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).enc));

// ---- an index written before pin, archive and trash existed
{
  const dir = path.join(root, 'old');
  fs.mkdirSync(dir, { recursive: true });
  const entries = [1, 2, 3].map((i) => ({ id: hexId(i), title: `Old chat ${i}`, renamed: i === 2, created: 100 * i, updated: 100 * i, model: 'm', usage: null, futureField: `kept${i}` }));
  for (const e of entries) fs.writeFileSync(path.join(dir, `${e.id}.json`), JSON.stringify({ enc: enc(JSON.stringify(snap(`question ${e.id}`, `needle-${e.id}`))) }));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ enc: enc(JSON.stringify({ current: hexId(3), chats: entries })) }));
  const store = mk(dir);
  const list = store.list();
  check('old index: every chat loads, with no flags set', list.length === 3 && list.every((c) => !c.pinned && !c.archived && !c.trashed), JSON.stringify(list));
  check('old index: titles, rename flag and the open chat are as they were', list.find((c) => c.id === hexId(2)).renamed === true && store.current() === hexId(3) && list.find((c) => c.id === hexId(1)).title === 'Old chat 1');
  check('old index: chats open', store.load(hexId(1))?.messages?.length === 2 && store.has(hexId(2)));
  store.setPinned(hexId(1), true);
  const onDisk = readIndexFile(dir);
  check('old index: a new flag is written without dropping other fields or chats', onDisk.chats.length === 3 && onDisk.chats.every((c) => /^kept\d$/.test(c.futureField)) && onDisk.chats.find((c) => c.id === hexId(1)).pinned === true && onDisk.current === hexId(3), JSON.stringify(onDisk));
  store.save(hexId(2), snap('question again', 'fresh answer'));
  check('old index: saving an old chat keeps its entry', store.list().length === 3 && files(dir).length === 3);
  check('old index: a store reading the new file sees the flags', mk(dir).list().find((c) => c.id === hexId(1)).pinned === true);
}

// ---- nothing is silently deleted past the limit: old unpinned chats are archived
{
  const dir = path.join(root, 'cap');
  const store = mk(dir, { limit: 5 });
  store.save(hexId(1), snap('first'));
  store.setPinned(hexId(1), true); // the oldest, but pinned
  for (let i = 2; i <= 12; i++) store.save(hexId(i), snap(`chat ${i}`));
  const list = store.list();
  check('cap: all 12 chat files are still on disk', files(dir).length === 12, files(dir).length);
  check('cap: the active list is held at the limit', list.filter((c) => !c.archived).length === 5 && list.filter((c) => c.archived).length === 7, list.map((c) => `${c.id.slice(-2)}:${c.archived ? 'a' : '-'}`).join());
  check('cap: a pinned chat is never auto-archived, the newest are kept active', !list.find((c) => c.id === hexId(1)).archived && !list.find((c) => c.id === hexId(12)).archived && list.find((c) => c.id === hexId(2)).archived);
  check('cap: an archived chat still opens', store.load(hexId(2))?.messages?.length === 2);
  store.save(hexId(2), snap('chat 2', 'a new reply'));
  check('cap: an auto-archived chat that is used again comes back', !store.list().find((c) => c.id === hexId(2)).archived);
  check('cap: the default limit is large (no 50-chat cap)', (() => { const d = path.join(root, 'default'); const s = mk(d); for (let i = 1; i <= 60; i++) s.save(hexId(i), snap(`c${i}`)); return s.list().length === 60 && s.list().every((c) => !c.archived) && files(d).length === 60; })());
}

// ---- pin and archive
{
  const dir = path.join(root, 'flags');
  const store = mk(dir);
  store.save(hexId(1), snap('a'));
  store.save(hexId(2), snap('b'));
  check('pin: set and cleared', store.setPinned(hexId(1), true) && store.list().find((c) => c.id === hexId(1)).pinned === true && store.setPinned(hexId(1), false) && !store.list().find((c) => c.id === hexId(1)).pinned);
  check('archive: a manual archive survives a restart', store.setArchived(hexId(2), true) && mk(dir).list().find((c) => c.id === hexId(2)).archived === true);
  store.save(hexId(2), snap('b')); // same messages saved again (autosave): still archived
  check('archive: an autosave of an unchanged chat does not unarchive it', store.list().find((c) => c.id === hexId(2)).archived === true);
  store.save(hexId(2), { ...snap('b'), messages: [...snap('b').messages, { role: 'user', content: [{ type: 'text', text: 'more' }] }] });
  check('archive: a new message in an archived chat unarchives it', !store.list().find((c) => c.id === hexId(2)).archived);
  check('flags: an unknown chat is refused', store.setPinned('0000000000000099', true) === false && store.setArchived('nope', true) === false);
}

// ---- delete with undo
{
  const dir = path.join(root, 'undo');
  const store = mk(dir);
  store.save(hexId(1), snap('keep me'));
  store.save(hexId(2), snap('delete me'));
  store.setCurrent(hexId(2));
  check('undo: trash hides the chat but keeps its file', store.trash(hexId(2)) && !store.list().some((c) => c.id === hexId(2)) && files(dir).includes(`${hexId(2)}.json`) && !store.has(hexId(2)) && store.load(hexId(2)) === null);
  check('undo: trashing the open chat clears which one is open', store.current() === null);
  check('undo: the hidden chat is listed as waiting', store.trashed().map((t) => t.id).join() === hexId(2));
  check('undo: restore brings it back whole', store.restore(hexId(2)) && store.list().some((c) => c.id === hexId(2)) && store.load(hexId(2))?.messages?.[0]?.content?.[0]?.text === 'delete me' && store.trashed().length === 0);
  check('undo: it survives a restart in the list', mk(dir).list().length === 2);
  store.trash(hexId(2));
  const later = mk(dir); // the app quit during the undo time
  check('undo: a chat hidden before a restart stays hidden, file intact', later.list().length === 1 && later.trashed().length === 1 && files(dir).length === 2);
  check('undo: remove after the time erases exactly that file', later.remove(hexId(2)) && files(dir).join() === `${hexId(1)}.json` && later.trashed().length === 0);
  check('undo: restoring something that is not hidden does nothing', later.restore(hexId(1)) === false);
  check('undo: a trashed chat can not be pinned or archived', (() => { const s = mk(path.join(root, 'undo2')); s.save(hexId(1), snap('x')); s.trash(hexId(1)); return s.setPinned(hexId(1), true) === false && s.setArchived(hexId(1), true) === false; })());
}

// ---- nothing is deleted when it is not safe
{
  const dir = path.join(root, 'safe');
  let up = true;
  const store = mk(dir, { available: () => up });
  store.save(hexId(1), snap('one'));
  up = false;
  check('safe: trash does nothing while the keychain is not available', store.trash(hexId(1)) === false && store.list().length === 1);
  up = true;
  store.trash(hexId(1));
  fs.writeFileSync(path.join(dir, 'index.json'), '{ damaged'); // the index on disk can not be read
  check('safe: remove re-reads the index on disk and erases nothing when it is unreadable', store.remove(hexId(1)) === false && files(dir).length === 1);
}
{
  const dir = path.join(root, 'foreign');
  const a = mk(dir);
  a.save(hexId(1), snap('a1'));
  a.save(hexId(2), snap('a2'));
  const b = mk(dir); // another process on the same profile
  b.save(hexId(30), snap('b30'));
  a.trash(hexId(2));
  a.remove(hexId(2));
  check('safe: remove adopts a chat another writer added and does not drop it from the index', files(dir).includes(`${hexId(30)}.json`) && readIndexFile(dir).chats.some((c) => c.id === hexId(30)), JSON.stringify(readIndexFile(dir).chats.map((c) => c.id)));
}
{ // a chat nobody undid is erased by a later save, a day on, never sooner
  const dir = path.join(root, 'expire');
  let t = 1e12;
  const store = mk(dir, { now: () => t });
  store.save(hexId(1), snap('one'));
  store.save(hexId(2), snap('two'));
  store.trash(hexId(2));
  t += 3600 * 1000;
  store.save(hexId(1), snap('one', 'again'));
  check('expire: an hour later the hidden chat is still on disk', files(dir).includes(`${hexId(2)}.json`));
  t += 25 * 3600 * 1000;
  store.save(hexId(1), snap('one', 'and again'));
  check('expire: after a day it is erased, and only it', files(dir).join() === `${hexId(1)}.json` && store.trashed().length === 0, files(dir).join());
}

// ---- search: titles and message text
{
  const dir = path.join(root, 'search');
  const store = mk(dir);
  store.save(hexId(1), snap('Plan a trip to Lisbon', 'Take the tram 28 to Alfama for pastel de nata.'));
  store.save(hexId(2), snap('Fix my regex', 'Use a lookahead: (?=foo) works here.'));
  store.save(hexId(3), snap('Lisbon weather', 'Mild in spring.'));
  store.setArchived(hexId(3), true);
  const ids = (q) => store.search(q).map((h) => h.id).sort().join();
  check('search: a word in the answer finds the chat, with a snippet', ids('alfama') === hexId(1) && /alfama/.test(store.search('alfama')[0].snippet), JSON.stringify(store.search('alfama')));
  check('search: titles match with no snippet', store.search('regex')[0].id === hexId(2) && store.search('regex')[0].snippet === '');
  check('search: every word must match, anywhere in the chat', ids('lisbon tram') === hexId(1) && ids('lisbon spring') === hexId(3));
  check('search: archived chats are searched too', ids('lisbon') === [hexId(1), hexId(3)].sort().join());
  check('search: case does not matter and a miss is empty', ids('PASTEL') === hexId(1) && store.search('zebra').length === 0 && store.search('   ').length === 0);
  store.save(hexId(2), snap('Fix my regex', 'Now it mentions zebra.'));
  check('search: a saved change is seen', ids('zebra') === hexId(2));
  store.trash(hexId(1));
  check('search: a chat waiting to be deleted is not found', ids('alfama') === '');
  const tools = { messages: [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }, { role: 'assistant', content: [{ type: 'tool_result', content: 'SECRETPAGE text' }, { type: 'text', text: 'done' }] }], settings: {} };
  store.save(hexId(4), tools);
  check('search: tool results are not searched', ids('secretpage') === '');
}

// ---- the list's order is the chat's last activity: new messages and touch() move a chat up; viewing, saving unchanged, rename and pin do not
{
  const dir = path.join(root, 'recency');
  const store = mk(dir);
  const [a, b, c] = [hexId(11), hexId(12), hexId(13)];
  for (const id of [a, b, c]) store.save(id, snap(`chat ${id}`));
  const order = () => store.list().map((x) => x.id).join();
  check('recency: newest saved first', order() === [c, b, a].join(), order());
  store.save(a, snap(`chat ${a}`)); // (what leaving a chat does: the same messages written again)
  check('recency: saving the same messages again does not move the chat', order() === [c, b, a].join(), order());
  const withReply = snap(`chat ${a}`); withReply.messages.push({ role: 'user', content: [{ type: 'text', text: 'more' }] });
  store.save(a, withReply);
  check('recency: a saved new message moves the chat to the top', order() === [a, c, b].join(), order());
  store.rename(b, 'Renamed'); store.setPinned(c, true); store.setArchived(c, false);
  check('recency: rename and pin leave the order alone', order() === [a, c, b].join(), order());
  check('recency: touch() moves a listed chat to the top (index only, no file write)', store.touch(b) === true && order() === [b, a, c].join(), order());
  check('recency: touch() on an unknown or trashed chat does nothing', store.touch(hexId(99)) === false && (store.trash(c), store.touch(c)) === false, order());
  store.restore(c);
  const old = mk(path.join(root, 'recency-old'));
  old.save(a, snap('x')); const idx = readIndexFile(path.join(root, 'recency-old')); delete idx.chats[0].sig;
  fs.writeFileSync(path.join(root, 'recency-old', 'index.json'), JSON.stringify({ enc: enc(JSON.stringify(idx)) }));
  const before = mk(path.join(root, 'recency-old')).list()[0].updated;
  mk(path.join(root, 'recency-old')).save(a, snap('x'));
  check('recency: an entry saved before the activity stamp is not moved by an unchanged save', mk(path.join(root, 'recency-old')).list()[0].updated === before);
}

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
