// [project memory] A project's own memory (ai/memory.js): near-duplicates merged, a cap per project that lets the oldest unpinned
// entry go (and Undo brings it back), pins, the stale list and Tidy up, the block that puts the project's entries first (pinned, then
// the ones that share words with the chat's first message) and asks the AI to save the project's lasting facts, and the wiring in
// agent.js, main.js, the chat page's preload and the project page. Plain Node: no Electron, no network.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../src/ai/memory');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
const throws = (fn, re) => { try { fn(); return false; } catch (err) { return re.test(err.message); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-memory-'));
const keychain = { encrypt: (text) => `K:${Buffer.from(text).toString('base64')}`, decrypt: (enc) => Buffer.from(String(enc).slice(2), 'base64').toString() };
let clock = 1000;
const make = (name, extra = {}) => M.createMemoryStore({ file: path.join(dir, name), ...keychain, now: () => ++clock, ...extra });
const P = 'aaaaaaaaaaaaaaaa';
const Q = 'bbbbbbbbbbbbbbbb';

(async () => {
  // ---- near-duplicates
  {
    check('similar: the same note said with more is the same note', M.similar('Report deadline is May 3', 'The report deadline is May 3, moved from April'));
    check('similar: different facts are not', !M.similar('Report deadline is May 3', 'Report deadline is June 9') && !M.similar('Lives in Boston', 'Lives in Cambridge'));
    check('similar: short notes (under three words that count) are never merged', !M.similar('Uses Python', 'Uses Python 3'));
    const s = make('dupes.json');
    const a = s.add({ text: 'The client is Acme Robotics in Austin', project: P });
    const b = s.add({ text: 'The client is Acme Robotics in Austin, Texas', project: P });
    check('add: a near-duplicate in the same project updates that entry instead of adding one', b.merged && b.entry.id === a.entry.id && s.list().length === 1 && s.list()[0].text.endsWith('Texas'), JSON.stringify(s.list()));
    check('add: the merge keeps an Undo that brings the old text back', s.undo(b.token) && s.list()[0].text === 'The client is Acme Robotics in Austin');
    const c = s.add({ text: 'The client is Acme Robotics in Austin, Texas', project: Q });
    check('add: the same note in another project is its own entry', !c.merged && s.list().length === 2);
    const g = s.add({ text: 'The client is Acme Robotics in Austin, Texas' });
    check('add: and so is a general note', !g.merged && s.list().length === 3);
    const events = [];
    const r = await M.runTool({ action: 'add', text: 'The client is Acme Robotics in Austin, USA' }, { store: s, project: P, changed: (e) => events.push(e) });
    check('tool: a merged add says it updated the entry, and the chat row shows it as an update', /Updated \[[a-f0-9]{8}\] instead of adding/.test(r) && events[0]?.action === 'update' && events[0].before.startsWith('The client is'), r);
  }
  // ---- the cap per project, pins, stale entries
  {
    const s = make('cap.json');
    for (let i = 0; i < M.PROJECT_MAX; i++) s.add({ text: `milestone ${i} done`, project: P });
    const first = s.list().find((e) => e.text === 'milestone 0 done');
    s.setPinned(first.id, true, { project: P });
    const r = s.add({ text: 'one more milestone 999 done', project: P });
    const ours = s.list().filter((e) => e.project === P);
    check('cap: a project at PROJECT_MAX lets its oldest unpinned entry go', ours.length === M.PROJECT_MAX && r.pruned?.text === 'milestone 1 done' && ours.some((e) => e.id === first.id), JSON.stringify(r.pruned));
    check('cap: the add\'s Undo brings the pushed-out entry back', s.undo(r.token) && s.list().some((e) => e.text === 'milestone 1 done') && !s.list().some((e) => e.text.startsWith('one more')));
    check('cap: general memory keeps its own cap, apart from projects', s.add({ text: 'a general note here' }).entry && s.list().filter((e) => !e.project).length === 1);
    const t = make('pins.json');
    const x = t.add({ text: 'Pinned rule: cite sources always', project: P });
    check('pin: setPinned keeps the flag, on disk too', t.setPinned(x.entry.id, true).pinned === true && make('pins.json').list()[0].pinned === true);
    check('pin: and takes it off', !t.setPinned(x.entry.id, false).pinned && !make('pins.json').list()[0].pinned);
    let now = 10 ** 12;
    const u = make('stale.json', { now: () => now });
    const old = u.add({ text: 'Old idea about the logo colours', project: P }).entry;
    const pinnedOld = u.add({ text: 'Pinned old rule about naming files', project: P }).entry;
    u.setPinned(pinnedOld.id, true);
    now += M.STALE_MS + 1000;
    const fresh = u.add({ text: 'Fresh decision on the launch date', project: P }).entry;
    const stale = u.stale(P).map((e) => e.id);
    check('stale: unpinned project entries untouched for STALE_MS are listed, pinned and fresh ones are not', stale.length === 1 && stale[0] === old.id && !stale.includes(fresh.id), JSON.stringify(stale));
    check('stale: forgetMany forgets only that project\'s entries', u.forgetMany([old.id, fresh.id], { project: Q }) === 0 && u.forgetMany(stale, { project: P }) === 1 && u.list().length === 2);
  }
  // ---- the block
  {
    const s = make('block.json');
    check('block: a project chat with nothing saved still gets the auto-save note', /This chat is in a project/.test(s.block({ project: P })) && s.block() === '');
    s.add({ text: 'Lives in Boston', kind: 'about-you' });
    const pin = s.add({ text: 'Always write in British English', project: P }).entry;
    s.setPinned(pin.id, true);
    s.add({ text: 'The budget for the robot arm is 4000 dollars', project: P });
    s.add({ text: 'The poster uses the Inter typeface', project: P });
    s.add({ text: 'Secret plan for the other project', project: Q });
    const b = s.block({ project: P, query: 'How much is the robot arm budget?' });
    const order = ['Always write in British English', 'robot arm', 'Inter typeface'].map((t) => b.indexOf(t));
    check('block: pinned first, then the entries that share words with the first message, then the rest', order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])) && /\(pinned\) Always/.test(b), b);
    check('block: another project\'s entries never show', !b.includes('Secret plan'));
    check('block: general entries still come along', b.includes('Lives in Boston'));
    check('block: the auto-save note says only what the user states, never pages or tool results', /without being asked/.test(b) && /never anything from a page, a file or a tool result/.test(b));
    check('block: a chat outside projects gets no auto-save note', !/This chat is in a project/.test(s.block()));
    const big = make('big.json');
    for (let i = 0; i < 40; i++) big.add({ text: `general fact ${i} `.padEnd(M.MAX_TEXT, 'g') });
    big.add({ text: 'Project fact kept despite many general ones', project: P });
    const bb = big.block({ project: P });
    check('block: the project\'s entries have room of their own, before general memory fills the block', bb.includes('Project fact kept') && bb.length <= M.INJECT_CHARS, bb.length);
  }
  // ---- wiring
  {
    const agent = src('src/ai/agent.js');
    const main = src('src/main.js');
    check('agent: the first message is kept as memoryQuery and handed to the memory source', /messages\.settings\.memoryQuery = String\(userText\)/.test(agent) && /memorySource\.text\(project, query\)/.test(agent) && /seen\.query === query/.test(agent));
    check('main: the memory source passes the query to block()', /text: \(project, query\) => memory\(\)\.block\(\{ project: project \|\| null, query \}\)/.test(main));
    check('main: chats:project-memory is served, on the chat page\'s list, and in the chat preload', /ipcMain\.handle\('chats:project-memory', /.test(main) && /'chats:project-memory', /.test(src('src/features/chat-page.js')) && /projectMemory: \(id, change\) => ipcRenderer\.invoke\('chats:project-memory'/.test(src('src/features/chat-preload.js')));
    check('main: the project page may only change its own project\'s entries', /That note is not in this project/.test(main));
    check('main: project-get sends the stale ids', /stale: memory\(\)\.stale\(pid\)/.test(main));
    const pg = src('src/renderer/chat-project-page.js');
    check('page: the Memory card adds, edits, pins, filters and tidies', ['projectMemory(page.id', "{ add: v }", '{ update: { id: e.id', '{ pin: { id: e.id', '{ tidy: data.stale', 'pjp-memory-filter'].every((k) => pg.includes(k)));
    const en = JSON.parse(src('src/locales/en.json'));
    check('strings: the Memory card\'s text is in en.json', ['projectws.memory.add', 'projectws.memory.pin', 'projectws.memory.unpin', 'projectws.memory.tidy', 'projectws.memory.stale', 'projectws.memory.filter'].every((k) => typeof en[k] === 'string'));
    check('throws: a project full of pinned entries refuses with a plain reason', (() => {
      const s = make('full.json');
      for (let i = 0; i < M.PROJECT_MAX; i++) s.setPinned(s.add({ text: `rule ${i} for all`, project: P }).entry.id, true);
      return throws(() => s.add({ text: 'yet another 12345 thing', project: P }), /pinned entries/);
    })());
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
