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

// ---- wiring
const core = read('src/renderer/chat-core.js');
const css = read('src/renderer/chat-actions.css');
const en = JSON.parse(read('src/locales/en.json'));
check('both pages load chat-queue.js before chat-core.js', ['src/renderer/index.src.html', 'src/renderer/chat-page.html'].every((f) => { const h = read(f); return h.indexOf('<script src="chat-queue.js">') > -1 && h.indexOf('<script src="chat-queue.js">') < h.indexOf('<script src="chat-core.js">'); }));
check('chat-core: waiting messages are bubbles of their own, not .msg.user (message counts and rewind positions skip them)', /className = 'queued-bubble queued'/.test(core) && !/className: 'notice queued'/.test(core));
check('chat-core: a message is marked sent when it starts, read on the reply\'s first word, and a saved one shows read', /setMark\(bubble, 'sent'\)/.test(core) && /countsAsRead\(event\.type\)\) setMark\(turn\.userBubble, 'read'\)/.test(core) && /if \(item\.read\) setMark\(bubble, 'read'\)/.test(core));
check('chat-core: after Stop or a failed reply the waiting messages come back to the box; a new-chat question still goes', /backToBox/.test(core) && /queuedToDraft\(\); if \(line\.mine\(forOtherChat\)\.some\(\(q\) => q\.fresh\)\) setTimeout\(sendQueued\)/.test(core));
check('chat-core: the line waits while a reply runs (a message typed in between is not overtaken)', /function sendQueued\(\) \{\s*if \(running\) return;/.test(core));
check('chat-core: a sync that draws the same chat again keeps what waits in the line (it does not go back to the box)', core.includes('const staying = keepBox ? line.drain() : [];') && core.includes('for (const q of staying) { messages.append(q.bubble); line.add(q);'));
check('chat-core: the pill watches the card with an observer, ticks with a plain setTimeout call, and Stop is the composer\'s Stop', /new IntersectionObserver/.test(core) && /tickTimer = setTimeout\(tick, 1000\)/.test(core) && /stop\.onclick = \(\) => stopReply\(\)/.test(core) && !/\.setTimeout\(/.test(core.slice(core.indexOf('const runPill'), core.indexOf('const runPill') + 4000)));
check('chat-core: the pill goes when the run ends or the chat changes (setRunning)', /renderWorkingIn\(\);\s*runPill\.sync\(\);/.test(core));
check('the saved chat keeps "read" on the user message, and the transcript carries it', /if \(raw\.read === true\) out\.read = true/.test(read('src/features/chat-branches.js')) && /if \(meta\.read\) out\.read = true;/.test(read('src/ai/agent.js')) && /m\.role === 'user' && !meta\?\.read && messages\.slice\(i \+ 1\)\.some/.test(read('src/ai/agent.js')));
check('styles: the pill and marks use tokens, respect reduced motion (system and Lumen\'s own setting)', /\.run-pill \{[^}]*var\(--surface-raised\)/.test(css) && /prefers-reduced-motion: reduce\) \{ \.run-pill/.test(css) && /pref-reduce-motion \.run-pill/.test(css) && !/\.run-pill[^{]*\{[^}]*#[0-9a-f]{3,6}\b/i.test(css));
const keys = ['chat.queued.label', 'chat.queued.nth', 'chat.queued.count', 'chat.queued.sendAll', 'chat.queued.sendAll.title', 'chat.queued.edit', 'chat.queued.cancel', 'chat.queued.sendNow', 'chat.mark.queued', 'chat.mark.sent', 'chat.mark.read', 'runpill.label', 'runpill.show'];
check('locale: every new string exists, and the marks read Queued / Sent / Read by AI', keys.every((k) => typeof en[k] === 'string' && en[k]) && en['chat.mark.queued'] === 'Queued' && en['chat.mark.sent'] === 'Sent' && en['chat.mark.read'] === 'Read by AI', keys.filter((k) => !en[k]).join());

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
