// Plain Node: the logic behind the chat's waiting line, a message's read mark and the running pill (renderer/chat-queue.js), and its wiring in
// chat-core.js, both pages, the saved chat (agent.js / chat-branches.js) and the locale.
const fs = require('fs');
const path = require('path');
const Q = require('../../src/renderer/chat-queue');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
const J = (v) => JSON.stringify(v);

// ---- a message's mark only moves forward
check('mark: queued -> sent -> read', Q.advance(null, 'queued') === 'queued' && Q.advance('queued', 'sent') === 'sent' && Q.advance('sent', 'read') === 'read');
check('mark: never goes back (a late "sent" does not undo "read")', Q.advance('read', 'sent') === 'read' && Q.advance('read', 'queued') === 'read' && Q.advance('sent', 'queued') === 'sent');
check('mark: skipping a step is fine (a message sent at once, read by the first word)', Q.advance(undefined, 'read') === 'read');
check('mark: an unknown value changes nothing', Q.advance('sent', 'seen') === 'sent' && Q.advance(null, 'seen') === null && Q.advance(undefined, undefined) === null);
check('mark: the first word, step, thought or approval counts as read; status and errors do not', ['text', 'thinking', 'tool', 'desktop_card', 'helper_card', 'plan', 'approval'].every(Q.countsAsRead) && !['status', 'error', 'done', 'auto', 'turn_start', 'tool_done'].some(Q.countsAsRead));
check('ordinal: 1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 112th', [1, 2, 3, 4, 11, 12, 13, 21, 22, 112].map(Q.ordinal).join() === '1st,2nd,3rd,4th,11th,12th,13th,21st,22nd,112th', [1, 2, 3, 4, 11, 12, 13, 21, 22, 112].map(Q.ordinal).join());

// ---- the line: order, owner chat
const other = (shown) => (id) => Boolean(id && shown && id !== shown);
const q = Q.create();
const a = q.add({ text: 'a', chatId: 'A' });
const b = q.add({ text: 'b', chatId: 'A' });
const c = q.add({ text: 'c', chatId: 'A' });
check('line: kept in the order typed; places count from 1', q.length === 3 && q.place(a, other('A')) === 1 && q.place(c, other('A')) === 3);
check('line: the next message is the first of the chat shown', q.take(other('A')) === a && q.length === 2 && q.list[0] === b);
const x = q.add({ text: 'x', chatId: 'B' });
check('line: another chat\'s message is never taken here, and does not count in the places', q.mine(other('A')).length === 2 && q.place(x, other('A')) === 0 && q.take(other('B')) === x && q.length === 2);
const y = q.add({ text: 'y', chatId: 'B' });
check('line: in chat B the first of B goes, A\'s wait', q.take(other('B')) === y && q.list.map((e) => e.text).join('') === 'bc');
check('line: nothing for this chat: nothing taken', q.take(other('Z')) === null && q.length === 2);
check('line: a chat not named yet (null id) owns what is typed in it, and a view with no id yet owns everything', q.add({ text: 'n', chatId: null }) && q.mine(other('A')).map((e) => e.text).join('') === 'bcn' && q.mine(other(null)).length === 3);
q.drain();
const [p1, p2, p3] = ['1', '2', '3'].map((text) => q.add({ text, chatId: 'A' }));
check('send now: moves the message to the front, the rest keep their order', q.promote(p3) && q.list.map((e) => e.text).join('') === '312' && q.promote(p3) && q.list[0] === p3);
check('send now: a message no longer waiting is refused', q.promote({ text: 'gone' }) === false && q.remove({ text: 'gone' }) === false);
check('remove: the others keep their places', q.remove(p1) && q.list.map((e) => e.text).join('') === '32' && q.place(p2, other('A')) === 2);
check('drain: takes what matches, in order, and leaves the rest', (() => { q.drain(); q.add({ text: 'k1', chatId: 'A' }); q.add({ text: 'o', chatId: 'B' }); q.add({ text: 'k2', chatId: 'A' }); const got = q.drain((e) => e.chatId === 'A'); return got.map((e) => e.text).join() === 'k1,k2' && q.list.map((e) => e.text).join() === 'o'; })());

// ---- merging several waiting messages into one turn
const img1 = { media_type: 'image/png', data: 'AA' };
const img2 = { media_type: 'image/png', data: 'BB' };
const m = Q.merge([{ text: 'first', images: [img1], chatId: 'A', tabs: { ids: [1, 2], names: ['One', 'Two'] } }, { text: 'second', images: [img2], chatId: 'A', tabs: { ids: [2, 3], names: ['Two', 'Three'], gone: ['Old'] }, screen: 'tab' }, { text: '', images: [], chatId: 'A' }]);
check('merge: the texts in order with a blank line, every picture, the tabs once each, the first screen', m && m.text === 'first\n\nsecond' && m.images.length === 2 && J(m.tabs.ids) === '[1,2,3]' && J(m.tabs.names) === '["One","Two","Three"]' && J(m.tabs.gone) === '["Old"]' && m.screen === 'tab' && m.chatId === 'A', J(m));
check('merge: an empty message (nothing typed, nothing attached) is left out of it', m && m.merged.length === 2);
check('merge: fewer than two real messages: nothing to merge', Q.merge([{ text: 'one' }]) === null && Q.merge([]) === null && Q.merge([{ text: 'one' }, { text: '' }]) === null);
check('merge: a message that runs a plan or opens a new chat keeps its own turn', Q.merge([{ text: 'a' }, { text: 'plan', opts: { approvedPlan: 'x' } }]) === null && Q.merge([{ text: 'a' }, { text: 'new', fresh: true }]) === null && Q.merge([{ text: 'a' }, { text: 'b' }, { text: 'plan', opts: { plan: true } }]).merged.length === 2);
check('merge: pictures stop at the limit', Q.merge([{ text: 'a', images: [img1, img1, img1] }, { text: 'b', images: [img2, img2, img2] }], 4).images.length === 4);
check('merge: a picture alone counts as a message', Q.merge([{ text: '', images: [img1] }, { text: 'and this' }]).text === 'and this');

// ---- where the running pill goes
const view = { top: 100, bottom: 600 };
check('pill: the card is in view (whole or in part): no pill', Q.pillSide({ top: 200, bottom: 300 }, view) === null && Q.pillSide({ top: 50, bottom: 150 }, view) === null && Q.pillSide({ top: 550, bottom: 700 }, view) === null);
check('pill: the card scrolled up out of view: the pill is at the top; below it: at the bottom', Q.pillSide({ top: -300, bottom: 40 }, view) === 'top' && Q.pillSide({ top: 650, bottom: 900 }, view) === 'bottom');
check('pill: nothing known: no pill', Q.pillSide(null, view) === null && Q.pillSide({ top: 0, bottom: 1 }, null) === null);

// ---- a message typed before its chat had a name (a new chat's first event names it) is that chat's, not the next one shown
{
  const l = Q.create();
  const early = l.add({ text: 'typed at once', chatId: null });
  const later = l.add({ text: 'other chat', chatId: 'B' });
  check('claim: a message with no owner takes the chat named now; one that has an owner keeps it', l.claim('A') === 1 && early.chatId === 'A' && later.chatId === 'B' && l.claim('A') === 0 && l.claim(null) === 0);
  check('claim: once named it is no longer taken for another chat\'s message', l.mine(other('A')).includes(early) && !l.mine(other('B')).includes(early));
}
check('line: every change reports the line (the saved copy follows it)', (() => {
  const seen = [];
  const l = Q.create((list) => seen.push(list.map((e) => e.text).join('')));
  const e1 = l.add({ text: 'a', chatId: 'A' });
  const e2 = l.add({ text: 'b', chatId: 'A' });
  l.promote(e2); l.take(() => false); l.remove(e1); l.drain();
  return J(seen) === J(['a', 'ab', 'ba', 'a', 'a']) || J(seen) === J(['a', 'ab', 'ba', 'a', '']);
})(), 'the changes were not all reported');
check('line: an onChange that throws never breaks the line', (() => { const l = Q.create(() => { throw new Error('storage gone'); }); l.add({ text: 'a' }); return l.length === 1 && l.take(() => false).text === 'a'; })());
check('line: each entry has an id of its own (the saved copy is keyed by it), kept when it is added again', (() => { const l = Q.create(); const a1 = l.add({ text: 'a' }); const b1 = l.add({ text: 'b' }); const id = a1.uid; l.remove(a1); l.add(a1); return a1.uid === id && a1.uid !== b1.uid && typeof id === 'string' && id.length > 4; })());

// ---- the copy of the line kept on this machine: a reload, a crash or a restart does not forget a waiting message
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; };
{
  const disk = memory();
  let clock = 1000000;
  const mk = (session) => Q.createStore(disk, { session, now: () => clock });
  const view1 = mk('v1');
  const l1 = Q.create((list) => view1.save(list));
  l1.add({ text: 'first', chatId: 'A', images: [{ media_type: 'image/png', data: 'AA', url: 'data:image/png;base64,AA', name: 'p.png' }], bubble: { dom: true }, label: {}, meta: {} });
  l1.add({ text: 'second', chatId: 'A', tabs: { ids: [3], names: ['Docs'] } });
  l1.add({ text: 'elsewhere', chatId: 'B' });
  const raw = disk.getItem(Q.STORE_KEY);
  const saved = JSON.parse(raw);
  check('store: every waiting message is saved with its chat, words, pictures and tabs; no page elements, no preview URL', Object.keys(saved).length === 3 && Object.values(saved).every((e) => e.session === 'v1') && Object.values(saved).some((e) => e.text === 'first' && e.images[0].data === 'AA' && !('url' in e.images[0])) && !/"bubble"|"label"|"meta"|data:image/.test(raw), raw);
  const view2 = mk('v2');
  check('store: what a view that still beats waits with is not carried (a second window never takes it)', view2.carried('A').length === 0);
  clock += Q.STALE_MS - 1000;
  check('store: still alive just inside the stale time', view2.carried('A').length === 0);
  clock += 2000;
  const got = view2.carried('A');
  check('store: after a restart (the beat is old) the chat\'s messages come back in the order typed, none of another chat', got.map((e) => e.text).join() === 'first,second' && got[0].images.length === 1 && got[1].tabs.ids[0] === 3 && got.every((e) => e.chatId === 'A'), J(got.map((e) => e.text)));
  check('store: reading does not take them; taking does, once (a second view starting at the same time finds none)', view2.carried('A').length === 2 && view2.carried('A', { take: true }).length === 2 && mk('v3').carried('A', { take: true }).length === 0 && mk('v3').carried('B').map((e) => e.text).join() === 'elsewhere');
  view1.save([]);
  check('store: an emptied line removes its entries', mk('v9').carried('B').length === 0 && disk.getItem(Q.STORE_KEY) === null);
}
{
  const disk = memory();
  const a = Q.createStore(disk, { session: 'a', now: () => 5000 });
  const l = Q.create((list) => a.save(list));
  l.add({ text: 'bye', chatId: 'A' });
  check('store: while the view beats, nothing of it is carried', Q.createStore(disk, { session: 'b', now: () => 5000 }).carried('A').length === 0);
  a.save(l.list, 0);
  check('store: a view that leaves on purpose (reload, window closed) saves with beat 0: carried at once, no wait for the stale time', Q.createStore(disk, { session: 'b', now: () => 50000 }).carried('A').map((e) => e.text).join() === 'bye');
  check('store: a message with nothing in it (no words, no picture) is not kept', (() => { const s = Q.createStore(memory(), { session: 'x', now: () => 1 }); s.save([{ uid: 'u', text: '  ', chatId: 'A', images: [] }], 0); return Q.createStore(memory(), { session: 'y' }).carried('A').length === 0 && s.carried('A').length === 0; })());
}
check('store: pictures too big to keep are left out and the entry says how many (the words are kept)', (() => {
  const disk = memory();
  const s = Q.createStore(disk, { session: 'a', now: () => 1 });
  s.save([{ uid: 'u1', text: 'look', chatId: 'A', images: [{ media_type: 'image/png', data: 'x'.repeat(1600000) }, { media_type: 'image/png', data: 'y' }] }], 0);
  const [e] = Q.createStore(disk, { session: 'b', now: () => 100000 }).carried('A');
  return e && e.text === 'look' && e.images.length === 0 && e.imagesLost === 2;
})());
check('store: storage that is full keeps the words without the pictures; storage that throws never breaks the chat', (() => {
  const full = memory();
  const tight = { getItem: (k) => full.getItem(k), removeItem: (k) => full.removeItem(k), setItem: (k, v) => { if (String(v).length > 2000) throw new Error('quota'); full.setItem(k, v); } };
  const s = Q.createStore(tight, { session: 'a', now: () => 1 });
  s.save([{ uid: 'u1', text: 'words', chatId: 'A', images: [{ media_type: 'image/png', data: 'z'.repeat(5000) }] }], 0);
  const [e] = Q.createStore(full, { session: 'b', now: () => 100000 }).carried('A');
  const dead = Q.createStore({ getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } }, { session: 'c' });
  return e && e.text === 'words' && e.imagesLost === 1 && dead.save([{ uid: 'u', text: 'x', chatId: 'A' }]) === false && dead.carried('A').length === 0;
})());
check('store: the copy is capped and the oldest go first; a corrupt copy reads as empty', (() => {
  const disk = memory();
  let clock = 1;
  const s = Q.createStore(disk, { session: 'a', now: () => clock++ });
  s.save(Array.from({ length: 80 }, (_, i) => ({ uid: `u${i}`, text: `m${i}`, chatId: 'A' })), 0);
  const kept = Q.createStore(disk, { session: 'b', now: () => 100000 }).carried('A').map((e) => e.text);
  disk.setItem(Q.STORE_KEY, '{not json');
  return kept.length === 60 && kept[0] === 'm20' && kept[59] === 'm79' && Q.createStore(disk, { session: 'c' }).carried('A').length === 0;
})());
check('store: a chat-page copy and a sidebar copy are separate keys', (() => { const disk = memory(); const side = Q.createStore(disk, { session: 'a' }); const page = Q.createStore(disk, { session: 'b', key: `${Q.STORE_KEY}.page` }); side.save([{ uid: 'u1', text: 'side', chatId: 'A' }], 0); page.save([{ uid: 'u2', text: 'page', chatId: 'A' }], 0); const reader = Q.createStore(disk, { session: 'c', now: () => Date.now() + 100000 }); return reader.carried('A').map((e) => e.text).join() === 'side' && Q.createStore(disk, { session: 'd', key: `${Q.STORE_KEY}.page`, now: () => Date.now() + 100000 }).carried('A').map((e) => e.text).join() === 'page'; })());

// ---- wiring
const core = read('src/renderer/chat-core.js');
const css = read('src/renderer/chat-actions.css');
const en = JSON.parse(read('src/locales/en.json'));
check('both pages load chat-queue.js before chat-core.js', ['src/renderer/index.src.html', 'src/renderer/chat-page.html'].every((f) => { const h = read(f); return h.indexOf('<script src="chat-queue.js">') > -1 && h.indexOf('<script src="chat-queue.js">') < h.indexOf('<script src="chat-core.js">'); }));
// ---- whose a message is when typed / taken: the chat of the run, never the chat shown next (a queued message used to open a new chat)
const st = (shown, running, runOwner) => ({ shown, running, runOwner });
check('owner: the chat shown owns what is typed', Q.ownerNow(st('A', true, null)) === 'A' && Q.ownerNow(st('A', false, 'B')) === 'A');
check('owner: while a continued chat has no name yet (running, nothing shown) the run chat owns it', Q.ownerNow(st(null, true, 'A')) === 'A');
check('owner: a new chat run has no owner yet (the first event names it), and an idle empty chat has none', Q.ownerNow(st(null, true, null)) === null && Q.ownerNow(st(null, false, 'A')) === null && Q.ownerNow() === null);
check('other: a message of another chat is another chat\'s, also while no chat is shown (a new empty chat never takes it)', Q.otherChat('A', st('B', false, null)) && Q.otherChat('A', st(null, false, null)) && Q.otherChat('A', st(null, true, null)));
check('other: its own chat message is not, shown or running there; an unowned one is never another\'s', !Q.otherChat('A', st('A', true, null)) && !Q.otherChat('A', st(null, true, 'A')) && !Q.otherChat(null, st('B', false, null)) && !Q.otherChat(undefined, st(null, false, null)));
{
  const line = Q.create();
  const mine = line.add({ text: 'queued in A', chatId: 'A' });
  const state = st(null, false, null); // (a new empty chat shown: the sidebar followed another tab)
  check('line: a new empty chat takes nothing of chat A\'s line', line.take((id) => Q.otherChat(id, state)) === null && line.length === 1 && line.mine((id) => Q.otherChat(id, state)).length === 0);
  check('line: the same message goes when chat A is shown again', line.take((id) => Q.otherChat(id, st('A', false, null))) === mine);
}
check('chat-core: a queued message is sent into the chat it waited in (ask passes forChat, main opens that chat, not the front tab\'s), and an unnamed run is not any other chat\'s', /ask\(next\.text, next\.images, next\.tabs, next\.screen, next\.opts, next\.chatId \|\| null\)/.test(core) && /screen, planOpts, forChat \|\| undefined\)/.test(core) && /runOwner = shownChatId;/.test(core) && /\(!shownChatId && !running && !view\.live/.test(core) && /forChat = null\) => \{/.test(read('src/main.js')) && /switchChat\(forChat, \{ quiet: true \}\)/.test(read('src/main.js')) && /opts, forChat\) => ipcRenderer\.send\('agent:ask'/.test(read('src/preload/preload.js')) && /opts, forChat\) => ipcRenderer\.send\('agent:ask'/.test(read('src/features/chat-preload.js')));
check('chat-core: waiting messages are bubbles of their own, not .msg.user (message counts and rewind positions skip them)', /className = 'queued-bubble queued'/.test(core) && !/className: 'notice queued'/.test(core));
check('chat-core: a message is marked sent when it starts, read on the reply\'s first word, and a saved one shows read', /setMark\(bubble, 'sent'\)/.test(core) && /countsAsRead\(event\.type\)\) setMark\(turn\.userBubble, 'read'\)/.test(core) && /if \(item\.read\) setMark\(bubble, 'read'\)/.test(core));
check('chat-core: after Stop or a failed reply the waiting messages come back to the box; a new-chat question still goes', /backToBox/.test(core) && /queuedToDraft\(\); if \(line\.mine\(queueOther\)\.some\(\(q\) => q\.fresh\)\) setTimeout\(sendQueued\)/.test(core));
check('chat-core: the line waits while a reply runs (a message typed in between is not overtaken)', /function sendQueued\(\) \{\s*if \(running\) return;/.test(core));
check('chat-core: a sync that draws the same chat again keeps what waits in the line (it does not go back to the box), also what was typed before the chat had a name', core.includes('const staying = line.drain((q) => keepBox || Boolean(incomingChatId && q.chatId === incomingChatId) || (ownRun && q.chatId == null));') && core.includes('for (const q of staying) { messages.append(q.bubble); line.add(q);') && core.includes('const ownRun = Boolean(view?.live && running && view.live.runId === runId);') && core.includes('clearChatView({ keepBox: sameChat, ownRun });'));
check('chat-core: a message typed before its chat was named gets the chat when it is named (nameChat, applySync)', /shownChatId = id;\n\s*runOwner = null;\n\s*line\.claim\(id\);/.test(core) && /shownChatId = view\?\.id \|\| null;[^\n]*\n\s*if \(sameChat \|\| ownRun\) line\.claim\(shownChatId\);/.test(core));
check('chat-core: leaving a chat sends its own waiting messages back to ITS box, before its draft and pictures are saved (not into the next chat\'s box)', (() => { const body = core.slice(core.indexOf('function clearChatView('), core.indexOf('$(\'new-chat\').onclick')); const back = body.indexOf('if (!keepBox) queuedToDraft();'); return back > -1 && back < body.indexOf('saveDraft();') && back < body.indexOf('stashView(shownChatId);') && back < body.indexOf('prompt.value = \'\';'); })());
check('chat-core: the line is copied to localStorage as it changes, with a beat; a view that goes away marks it carried at once', /const line = window\.chatQueue\.create\(mirrorLine\);/.test(core) && /queueStore\?\.save\(tempChatShown\(\) \? \[\] : list\)/.test(core) && /window\.chatQueue\.BEAT_MS/.test(core) && /addEventListener\('pagehide', \(\) => \{ if \(line\.length && !tempChatShown\(\)\) queueStore\?\.save\(line\.list, 0\); \}\)/.test(core) && /chat-page'\) \? \{ key: `\$\{window\.chatQueue\.STORE_KEY\}\.page` \}/.test(core));
check('chat-core: what a gone view left waiting comes back where its chat is shown (named, box open, after a sync): as bubbles while it still runs, else in the box', /function restoreCarried\(\) \{\s*if \(!queueStore \|\| !shownChatId \|\| draftHold \|\| tempChatShown\(\)\) return;/.test(core) && /queueStore\.carried\(shownChatId, \{ take: true \}\)/.test(core) && /if \(running && !e\.fresh\) queueUp\(/.test(core) && /entriesToBox\(rest\);/.test(core) && /restoreCarried\(\); \/\/ \(the chat is named and its box is open again/.test(core) && /if \(!prompt\.value && !pastes\.length\) restoreDraft\(\);\n\s*restoreCarried\(\);/.test(core) && /if \(!running && line\.length\) setTimeout\(sendQueued\);[^\n]*\n\s*restoreCarried\(\);/.test(core));
check('chat-core: with no AI connected the line goes back to the box instead of being parked unseen in the one-slot pendingAsk', /if \(running\) return;[^\n]*\n[^\n]*\n\s*if \(!modelReady\) \{ queuedToDraft\(\); return; \}/.test(core));
check('locale: the note for pictures that could not be kept exists', typeof en['chat.queued.imagesLost'] === 'string' && en['chat.queued.imagesLost'].length > 20);
check('chat-core: the pill watches the card with an observer, ticks with a plain setTimeout call, and Stop is the composer\'s Stop', /new IntersectionObserver/.test(core) && /tickTimer = setTimeout\(tick, 1000\)/.test(core) && /stop\.onclick = \(\) => stopReply\(\)/.test(core) && !/\.setTimeout\(/.test(core.slice(core.indexOf('const runPill'), core.indexOf('const runPill') + 4000)));
check('chat-core: the pill goes when the run ends or the chat changes (setRunning)', /renderWorkingIn\(\);\s*runPill\.sync\(\);/.test(core));
check('the saved chat keeps "read" on the user message, and the transcript carries it', /if \(raw\.read === true\) out\.read = true/.test(read('src/features/chat-branches.js')) && /if \(meta\.read\) out\.read = true;/.test(read('src/ai/agent.js')) && /m\.role === 'user' && !meta\?\.read && messages\.slice\(i \+ 1\)\.some/.test(read('src/ai/agent.js')));
check('styles: the pill and marks use tokens, respect reduced motion (system and Lumen\'s own setting)', /\.run-pill \{[^}]*var\(--surface-raised\)/.test(css) && /prefers-reduced-motion: reduce\) \{ \.run-pill/.test(css) && /pref-reduce-motion \.run-pill/.test(css) && !/\.run-pill[^{]*\{[^}]*#[0-9a-f]{3,6}\b/i.test(css));
const keys = ['chat.queued.label', 'chat.queued.nth', 'chat.queued.count', 'chat.queued.sendAll', 'chat.queued.sendAll.title', 'chat.queued.edit', 'chat.queued.cancel', 'chat.queued.sendNow', 'chat.mark.queued', 'chat.mark.sent', 'chat.mark.read', 'runpill.label', 'runpill.show'];
check('locale: every new string exists, and the marks read Queued / Sent / Read by AI', keys.every((k) => typeof en[k] === 'string' && en[k]) && en['chat.mark.queued'] === 'Queued' && en['chat.mark.sent'] === 'Sent' && en['chat.mark.read'] === 'Read by AI', keys.filter((k) => !en[k]).join());

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
