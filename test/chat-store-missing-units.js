// [chat store] A History index whose chat files are gone (moved to a backup folder, lost by a sync client) must not stall the main process.
// The user's index listed a couple of hundred chats whose files had been moved away: list() waited 25 ms per missing file and load() 120 ms
// more per title, so every sidebar open, tab switch, tab close and window focus froze Lumen for about 30 s ("not responding").
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createChatStore } = require('../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chatmissing-'));
const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
const dec = (s) => Buffer.from(s, 'base64').toString('utf8');
const store = createChatStore({ dir, encrypt: enc, decrypt: dec });
const snap = (n) => ({ messages: [{ role: 'user', content: [{ type: 'text', text: `<screen>shot</screen> question ${n}` }] }, { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] }] });
const ids = [];
for (let i = 0; i < 300; i++) { const id = (0x1000000000000000n + BigInt(i)).toString(16).slice(0, 16); ids.push(id); store.save(id, snap(i)); }
// Titles saved with screen markup (an older Lumen), so list() wants to remake them from the chat file.
const idxFile = path.join(dir, 'index.json');
const idx = JSON.parse(dec(JSON.parse(fs.readFileSync(idxFile, 'utf8')).enc));
for (const c of idx.chats) { c.title = '<screen>shot</screen> question'; c.renamed = false; }
fs.writeFileSync(idxFile, JSON.stringify({ enc: enc(JSON.stringify(idx)) }));
// The files move away; the index stays.
for (const id of ids.slice(4)) fs.renameSync(path.join(dir, `${id}.json`), path.join(os.tmpdir(), `lumen-chatmissing-moved-${process.pid}-${id}.json`));
const fresh = createChatStore({ dir, encrypt: enc, decrypt: dec });

let t = Date.now(); const list = fresh.list(); const first = Date.now() - t;
check(`list() over 300 entries, 296 files missing, is quick (${first} ms; was about 40 s)`, first < 250, first);
check('...and marks the missing ones', list.filter((c) => c.missing).length === 296 && list.filter((c) => !c.missing).length === 4, list.filter((c) => c.missing).length);
t = Date.now(); for (let i = 0; i < 10; i++) fresh.list(); const again = (Date.now() - t) / 10;
check(`list() again (as each tab switch asks) stays quick (${again.toFixed(1)} ms)`, again < 100, again);
t = Date.now(); const gone = fresh.load(ids[10]); const loadMs = Date.now() - t;
check(`load() of a chat whose file is gone returns at once (${loadMs} ms; was 120 ms of waiting)`, gone === null && loadMs < 30, `${gone} ${loadMs}`);
check('a chat that is there still loads', fresh.load(ids[0])?.messages?.length === 2, JSON.stringify(fresh.load(ids[0])));
if (typeof fresh.search === 'function') { t = Date.now(); try { fresh.search('answer'); } catch {} const s = Date.now() - t; check(`search over the same index is quick (${s} ms)`, s < 400, s); }
try { fs.rmSync(dir, { recursive: true, force: true }); for (const id of ids.slice(4)) fs.rmSync(path.join(os.tmpdir(), `lumen-chatmissing-moved-${process.pid}-${id}.json`), { force: true }); } catch {}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
