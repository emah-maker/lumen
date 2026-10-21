// [parallel chats] The page-read cache is per chat (src/ai/snapshot.js reads): two chats working at once each have a model that saw
// only its own reads, so chat A never gets "Unchanged since your last read" for a page only chat B read, B's new CLI session does
// not reset A's, and since_last baselines stay apart. Runs with no chat share one cache. Plain Node.
const { reads } = require('../src/ai/snapshot');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const chatA = [];
const chatB = [];
let current = null;
reads.setChatOf(() => current);
const as = (chat, fn) => { const was = current; current = chat; try { return fn(); } finally { current = was; } };
const read = (tab = 5, body = 'PAGE') => reads.check(tab, 'https://x.test/', 'c|0|false', body);

as(chatB, () => { reads.tick('read_page'); read(); });
check('a read chat B made is not "unchanged" for chat A', as(chatA, () => { reads.tick('read_page'); return read(); }) === null);
check("chat A's own repeat read is", /^Unchanged since your last read/.test(as(chatA, () => { reads.tick('read_page'); return read(); }) || ''));
check("...and so is chat B's", /^Unchanged/.test(as(chatB, () => { reads.tick('read_page'); return read(); }) || ''));

as(chatB, () => reads.reset('session-b'));
check("chat B's new session (reset) leaves chat A's reads alone", /^Unchanged/.test(as(chatA, () => { reads.tick('read_page'); return read(); }) || ''));
check("...and starts chat B over", as(chatB, () => { reads.tick('read_page'); return read(); }) === null);
check('each chat has its own session', as(chatB, () => reads.session) === 'session-b' && as(chatA, () => reads.session) === '');

as(chatA, () => reads.tick('click'));
check("an acting tool in chat A clears A's cache, not B's", as(chatA, () => { reads.tick('read_page'); return read(); }) === null && /^Unchanged/.test(as(chatB, () => { reads.tick('read_page'); return read(); }) || ''));

as(chatA, () => reads.snaps().set(5, { url: 'https://x.test/', lines: ['a'], seq: 1, acted: 0 }));
check('since_last baselines (snaps) are per chat', as(chatA, () => reads.snaps().has(5)) && !as(chatB, () => reads.snaps().has(5)));
as(chatA, () => reads.clear());
check("clear() empties only that chat's reads and baselines", !as(chatA, () => reads.snaps().has(5)) && /^Unchanged/.test(as(chatB, () => { reads.tick('read_page'); return read(); }) || ''));

check('a run with no chat uses the shared cache', as(null, () => { reads.tick('read_page'); read(9); reads.tick('read_page'); return /^Unchanged/.test(read(9) || ''); }) && as(chatA, () => { reads.tick('read_page'); return read(9); }) === null);
check('seq and acted count per chat', as(chatA, () => reads.acted) === 1 && as(chatB, () => reads.acted) === 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
