// Per-chat composer drafts (renderer/chat-drafts.js), plain Node: what is kept per chat in a fake localStorage, the oldest going past the cap,
// a draft surviving a "restart" (a new store over the same storage), a draft moving to the chat that was just named, the long-paste
// threshold, and how pasted blocks join the message. The wiring in chat-core.js / chat-extras.js is checked by reading the source.
const fs = require('fs');
const path = require('path');
const drafts = require('../src/renderer/chat-drafts');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size }; };

{
  const storage = fakeStorage();
  const a = drafts.create(storage);
  a.set('chat1', { text: 'hello there', pastes: [] });
  a.set('chat2', { text: 'other', pastes: ['x'.repeat(10)] });
  check('each chat keeps its own text', a.get('chat1').text === 'hello there' && a.get('chat2').text === 'other');
  check('a chat with no draft has none', a.get('chat3') === null && a.get(null) === null);
  check('pasted blocks are kept with the draft', a.get('chat2').pastes.length === 1);
  const restarted = drafts.create(storage); // a new run of the app over the same storage
  check('a draft survives a restart', restarted.get('chat1').text === 'hello there' && restarted.get('chat2').text === 'other');
  a.set('chat1', { text: '   ', pastes: [] });
  check('clearing the text removes the draft', a.get('chat1') === null);
  a.clear('chat2');
  check('nothing left: the storage entry goes too', storage.size() === 0);
}
{
  const a = drafts.create(fakeStorage());
  a.set(null, { text: 'typed in a new chat', pastes: [] });
  check('the chat not started yet has a draft of its own', a.get(null).text === 'typed in a new chat' && a.get('abc') === null);
  a.rename(null, 'abc');
  check('a draft moves to the chat that was named', a.get('abc')?.text === 'typed in a new chat' && a.get(null) === null);
  a.rename(null, 'def');
  check('renaming with no draft changes nothing', a.get('def') === null && a.get('abc') !== null);
}
{
  let t = 0;
  const a = drafts.create(fakeStorage(), () => ++t);
  for (let i = 0; i < drafts.MAX_DRAFTS + 5; i++) a.set(`c${i}`, { text: `d${i}`, pastes: [] });
  check('past the cap the oldest drafts go', a.get('c0') === null && a.get('c4') === null && a.get('c5').text === 'd5' && a.get(`c${drafts.MAX_DRAFTS + 4}`) !== null);
}
{
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  const a = drafts.create(broken);
  let ok = true;
  try { a.set('x', { text: 'hi', pastes: [] }); ok = a.get('x') === null; } catch { ok = false; }
  check('storage that throws is ignored', ok);
  const garbage = fakeStorage();
  garbage.setItem(drafts.KEY, '[1,2');
  check('unreadable storage reads as no drafts', drafts.create(garbage).get('x') === null);
}
check('2,000 characters is not a long paste, 2,001 is', !drafts.isLongPaste('a'.repeat(2000)) && drafts.isLongPaste('a'.repeat(2001)));
check('no text is not a long paste', !drafts.isLongPaste('') && !drafts.isLongPaste(undefined));
check('a message with no pastes is just its text', drafts.withPastes('  hi  ', []) === 'hi');
{
  const out = drafts.withPastes('summarize', ['line one\nline two\n']);
  check('a pasted block follows the text in a fence', out === 'summarize\n\n```\nline one\nline two\n```', JSON.stringify(out));
  const tricky = drafts.withPastes('', ['has ``` inside']);
  check('the fence is longer than any backticks inside', tricky === '````\nhas ``` inside\n````', JSON.stringify(tricky));
  check('only a pasted block still makes a message', drafts.withPastes('', ['a']).startsWith('```'));
}
{
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8');
  const core = src('chat-core.js');
  check('chat-core saves the draft when the box changes and puts it away on a chat switch', /const saveDraft = /.test(core) && /function clearChatView\(\) \{\s*saveDraft\(\)/.test(core) && /queueMicrotask\(restoreDraft\)/.test(core));
  check('a draft is restored at start (a restart)', /function startChat\(\) \{\s*restoreDraft\(\)/.test(core));
  check('Up in an empty box edits the last message', /e\.key === 'ArrowUp' && !prompt\.value && !running/.test(core) && /editLast\(\)/.test(core));
  for (const page of ['chat-page.html', 'index.src.html']) {
    const h = src(page);
    check(`${page} loads chat-drafts.js before chat-core.js`, h.indexOf('<script src="chat-drafts.js">') > -1 && h.indexOf('<script src="chat-drafts.js">') < h.indexOf('<script src="chat-core.js">'));
  }
  const extras = src('chat-extras.js');
  check('Ctrl+K is left alone', !/key\.toLowerCase\(\) === 'k'/.test(extras.split('chat shortcuts and their sheet')[1] || ''));
}
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
