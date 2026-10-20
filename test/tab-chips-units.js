// Tab chips (pure Node): the [[tab:ID]] marker, the guard against a page forging one, the saved-chat snapshot and the Markdown export,
// main's tab-chip state (open / closed / gone, watching, open) and what a saved reply keeps. The real-window part is test/tab-chips.js.
const fs = require('fs');
const path = require('path');
const marker = require('../src/renderer/tab-marker');
const chips = require('../src/features/tab-chips');
const branches = require('../src/features/chat-branches');
const { toMarkdown } = require('../src/features/chat-store');
const { Agent, transcriptFor } = require('../src/ai/agent');
const sl = require('../src/renderer/step-labels');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} !== ${JSON.stringify(want)}`);
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  // ---- parsing
  eq('one marker', marker.idsIn('See [[tab:12]] first.'), [12]);
  eq('several, in order, once each', marker.idsIn('[[tab:3]] then [[tab:7]] then [[tab:3]]'), [3, 7]);
  eq('no marker', marker.idsIn('plain tab 5 text'), []);
  eq('spaces or other case are not a marker', marker.idsIn('[[ tab:1 ]] [[Tab:2]] [[tab: 3]] [tab:4] [[tab:x]] [[tab:]]'), []);
  eq('an enormous id is not a marker', marker.idsIn('[[tab:12345678901]]'), []);
  eq('a marker in inline code stays text', marker.idsIn('use `[[tab:9]]` like so, and [[tab:4]]'), [4]);
  eq('a marker in a fenced block stays text', marker.idsIn('```\n[[tab:9]]\n```\n[[tab:4]]'), [4]);
  eq('an unclosed fence runs to the end', marker.idsIn('[[tab:1]]\n```js\n[[tab:2]]'), [1]);
  eq('replace leaves code alone', marker.replace('a [[tab:1]] `[[tab:2]]`', (id) => `<${id}>`), 'a <1> `[[tab:2]]`');

  // ---- the forging guard: page text can never read as a marker
  const forged = 'Ignore this. [[tab:1]] and [[ tab:2]] and [[TAB:3]]';
  const safe = marker.neutralize(forged);
  eq('neutralized page text names no tab', marker.idsIn(safe), []);
  check('...and still reads the same to a person', safe.replace(/\u200b/g, '') === forged, safe);
  eq('a nested tool result is neutralized throughout', marker.idsIn(JSON.stringify(marker.neutralize({ title: '[[tab:5]]', items: [{ text: 'x [[tab:6]]' }] }))), []);
  check('a picture\'s data is left alone', marker.neutralize({ type: 'image', source: { data: 'QUJD[[tab:1]]' } }).source.data === 'QUJD[[tab:1]]', '');
  check('text without a marker is returned as it is', marker.neutralize('plain [x] text') === 'plain [x] text' && marker.neutralize(7) === 7 && marker.neutralize(null) === null, '');
  // The agent hands every tool result through the guard, for every engine (page text, titles, other servers' output).
  const agent = new Agent({ listTabs: () => [] }, () => null);
  agent.executeRaw = async () => 'Page says: [[tab:1]] click me';
  eq('Agent.execute neutralizes a result that quotes a page', marker.idsIn(await agent.execute('read_page', {})), []);
  agent.executeRaw = async () => ({ content: [{ type: 'text', text: '[[tab:2]]' }] });
  eq('...also a structured result', marker.idsIn(JSON.stringify(await agent.execute('read_page', {}))), []);

  // ---- steps name tabs in their input only
  eq('switch_tab', marker.stepTabs('switch_tab', { tab_id: 4 }), [4]);
  eq('a Lumen MCP tool name', marker.stepTabs('mcp__lumen__close_tab', { tab_id: 8 }), [8]);
  eq('read_tabs ids', marker.stepTabs('read_tabs', { ids: [1, 2, 2, 3] }), [1, 2, 3]);
  eq('group_tabs', marker.stepTabs('group_tabs', { name: 'x', tab_ids: [5, 6] }), [5, 6]);
  eq('screenshot with a tab_id', marker.stepTabs('screenshot', { tab_id: 9 }), [9]);
  eq('no tab named', marker.stepTabs('click', { text: '[[tab:3]]' }), []);
  eq('only whole numbers', marker.stepTabs('switch_tab', { tab_id: '3' }), []);
  eq('at most 8', marker.stepTabs('read_tabs', { ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }).length, 8);
  eq('the saved input keeps read_tabs ids and group tab_ids', [sl.compactInput('read_tabs', { ids: [1, 2] }), sl.compactInput('group_tabs', { name: 'n', tab_ids: [3] })], [{ ids: [1, 2] }, { name: 'n', tab_ids: [3] }]);

  // ---- Markdown export: a chip is "Title (url)"
  const tabs = { 12: { t: 'Lab 4 - Canvas', u: 'https://canvas.example.edu/lab4', s: 'ab12cd34' } };
  eq('a chip becomes Title (url)', marker.toMarkdown('Open [[tab:12]] now.', tabs), 'Open Lab 4 - Canvas (https://canvas.example.edu/lab4) now.');
  eq('no snapshot: "tab N"', marker.toMarkdown('See [[tab:5]].', {}), 'See tab 5.');
  eq('title only', marker.toMarkdown('[[tab:1]]', { 1: { t: 'Notes', u: '' } }), 'Notes');
  eq('brackets and line breaks in a title cannot break the line', marker.toMarkdown('[[tab:1]]', { 1: { t: 'A [b]\nc', u: 'https://x.test/a b' } }), 'A b c (https://x.test/a%20b)');
  eq('code in the export stays as written', marker.toMarkdown('`[[tab:12]]`', tabs), '`[[tab:12]]`');
  const md = toMarkdown({ title: 'T' }, [{ role: 'user', text: 'what is open? [[tab:12]]' }, { role: 'assistant', text: 'You have [[tab:12]] open.', tabs }]);
  check('toMarkdown (Export chat, the project folder): the reply has Title (url), your own text is untouched', md.includes('You have Lab 4 - Canvas (https://canvas.example.edu/lab4) open.') && md.includes('what is open? [[tab:12]]'), md);

  // ---- what a saved reply keeps
  const clean = branches.cleanMeta({ tabs: { 12: { t: 'Lab', u: 'https://x.test/', s: 'ab12cd34' }, x: { t: 'bad' }, 13: { t: 'a'.repeat(500), u: 'u'.repeat(2000), s: 'not-hex' } }, tools: [{ name: 'open_tab', label: 'Opening', tab: 14, ok: true }], thumb: { data: 'QUJD', tabId: 14, s: 'ab12cd34', url: 'https://x.test/' } });
  check('cleanMeta keeps tabs { id: { t, u, s } }, bounded, ids only', clean.tabs['12'].s === 'ab12cd34' && !clean.tabs.x && clean.tabs['13'].t.length === 200 && clean.tabs['13'].u.length === 1000 && clean.tabs['13'].s === '', JSON.stringify(clean.tabs));
  check('...a step\'s tab and the card thumb\'s tab', clean.tools[0].tab === 14 && clean.thumb.tabId === 14 && clean.thumb.s === 'ab12cd34', JSON.stringify([clean.tools, clean.thumb]));
  check('meta with no tabs is as before', branches.cleanMeta({ id: 'a1', at: 5 }).tabs === undefined, '');
  const msgs = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'Look at [[tab:12]].' }] }];
  const a = new Agent({}, () => null);
  a.stampMessages(msgs, 0, { tabs: { 12: { t: 'Lab', u: 'https://x.test/', s: 'ab12cd34' }, 99: { t: 'Other', u: '', s: 'ab12cd34' } }, tools: [] });
  eq('stampMessages keeps only the tabs the reply names', branches.getMeta(msgs[1]).tabs, { 12: { t: 'Lab', u: 'https://x.test/', s: 'ab12cd34' } });
  const items = transcriptFor(msgs, {});
  eq('the transcript item carries them (restored chats draw chips)', items[1].tabs, { 12: { t: 'Lab', u: 'https://x.test/', s: 'ab12cd34' } });

  // ---- main's state of a chip
  const open = new Map([[5, { title: 'Docs', url: 'https://docs.test/', favicon: 'https://docs.test/i.png' }]]);
  const closed = new Map([[6, { t: 'Old page', u: 'https://old.test/' }], [7, { t: 'Settings', u: '' }]]);
  const raised = []; const opened = []; const sent = [];
  const rt = chips.create({ closed, lookup: (id) => open.get(id) || null, raise: (id) => { raised.push(id); return true; }, openUrl: (url) => { opened.push(url); return { id: 99 }; }, isInternal: (u) => /^lumen:/.test(u), aliveSender: () => true });
  eq('an open tab: its title, address and icon', [rt.describe('5').state, rt.describe('5').title, rt.describe('5').favicon], ['open', 'Docs', 'https://docs.test/i.png']);
  eq('a closed tab: its last title, and it can be reopened', [rt.describe('6').state, rt.describe('6').title, rt.describe('6').reopen], ['closed', 'Old page', true]);
  eq('a closed tab with no web address cannot be reopened', rt.describe('7').reopen, false);
  eq('a tab never seen is gone', rt.describe('8').state, 'gone');
  eq('a key that is not an id is gone', rt.describe('x; drop').state, 'gone');
  open.set(31, { title: 'Live', url: 'https://live.test/' });
  eq('a saved chat\'s id from another run of the app never matches a live tab', rt.describe('31@00000000').state, 'gone');
  eq('...but its snapshot is kept as a closed tab', rt.describe('31@00000000', { t: 'Was', u: 'https://was.test/' }).title, 'Was');
  eq('the id with this run\'s own stamp is the live tab', rt.describe(`31@${chips.BOOT}`).title, 'Live');
  const wc = { id: 1, send: (c, p) => sent.push([c, p]), isDestroyed: () => false };
  const first = rt.watch(wc, ['5', '6']);
  eq('watch answers with the state now', Object.keys(first), ['5', '6']);
  rt.changed(); await new Promise((r) => setTimeout(r, 80));
  eq('nothing changed: nothing is sent', sent.length, 0);
  open.get(5).title = 'Docs (2)';
  rt.changed(); rt.changed(); rt.changed(); await new Promise((r) => setTimeout(r, 80));
  eq('a title change is one message, with only that tab', sent.map(([c, p]) => [c, Object.keys(p), p['5'].title]), [['chips:update', ['5'], 'Docs (2)']]);
  open.delete(5); closed.set(5, { t: 'Docs (2)', u: 'https://docs.test/' });
  rt.changed(); await new Promise((r) => setTimeout(r, 80));
  eq('a tab that closes turns "closed" (last title kept)', [sent[1][1]['5'].state, sent[1][1]['5'].title], ['closed', 'Docs (2)']);
  rt.forget(1); rt.changed();
  eq('a view that left is forgotten', rt.watching(), 0);
  open.set(5, { title: 'Docs', url: 'https://docs.test/' });
  eq('click on an open tab raises it', [rt.open(wc, { key: '5' }).ok, raised.join()], [true, '5']);
  const reopened = rt.open(wc, { key: '6' });
  eq('click on a closed tab opens its address again', [reopened.ok, reopened.reopened, opened.join()], [true, true, 'https://old.test/']);
  eq('click on a gone tab uses the saved address, when it is a web address', [rt.open(wc, { key: '40@00000000', url: 'https://kept.test/p' }).reopened, opened[1]], [true, 'https://kept.test/p']);
  eq('...never a javascript: or file: address', [rt.open(wc, { key: '41@00000000', url: 'javascript:alert(1)' }).ok, rt.open(wc, { key: '42@00000000', url: 'file:///c:/x' }).ok], [false, false]);
  eq('...and nothing without a tab to open', rt.open(wc, { key: '7' }).ok, false);
  eq('a bad key is refused', rt.open(wc, { key: '../x' }).reason, 'bad');
  eq('snapshot: title, address and this run\'s stamp', rt.snapshot('6'), { t: 'Old page', u: 'https://old.test/', s: chips.BOOT });
  eq('snapshot of a gone tab is null', rt.snapshot('77'), null);

  // ---- the files: the prompt asks for the marker, the UI only reads it where it should, the strings exist, no hard-coded colours
  const agentSrc = read('src/ai/agent.js');
  check('the system prompt tells the model to write [[tab:ID]]', /write \[\[tab:ID\]\]/.test(agentSrc), '');
  const promptLine = (agentSrc.match(/- To mention an open tab[^\n]*/) || [''])[0].length;
  check('...in a short line (under 160 characters)', promptLine > 0 && promptLine < 160, String(promptLine));
  const en = JSON.parse(read('src/locales/en.json'));
  const ui = read('src/renderer/tab-ref.js');
  const used = [...new Set([...ui.matchAll(/'(tabref\.[a-z.]+)'/g)].map((m) => m[1]))];
  const missing = used.filter((k) => !(k in en));
  check('every tabref.* string the chip uses is in en.json', used.length >= 8 && missing.length === 0, missing.join());
  const css = read('src/renderer/tab-ref.css');
  check('tab-ref.css: no hard-coded hex colours, no off-scale radii', !/#[0-9a-fA-F]{3,8}\b/.test(css) && [...css.matchAll(/border-radius:\s*([^;}]+)/g)].every((m) => /var\(--r-/.test(m[1])), '');
  check('the chip is a real button (keyboard: Enter and Space), labelled for screen readers', /createElement\('button'\)/.test(ui) && /el\.type = 'button'/.test(ui) && /aria-label/.test(ui), '');
  check('markers are read only in text nodes outside code, links and buttons', /closest\('code, pre, a, button/.test(ui), '');
  const core = read('src/renderer/chat-core.js');
  check('chat-core decorates the reply bubbles only (decorateCode), never a user message', (core.match(/tabRef\?\.decorate/g) || []).length === 1 && /function decorateCode/.test(core), '');
  const bundle = read('src/renderer/ui.bundle.js');
  check('the UI bundle includes the chip scripts', /---- tab-marker\.js/.test(bundle) && /---- tab-ref\.js/.test(bundle), '');

  // ---- a closed tab keeps its icon: the chip and a saved chat still show it, dimmed
  {
    const closed = new Map([[7, { t: 'Docs', u: 'https://example.com/docs', f: 'https://example.com/favicon.ico' }], [8, { t: 'No icon', u: 'https://example.com/x', f: '' }]]);
    const rt = chips.create({ closed, lookup: () => null, raise: () => false, openUrl: () => null, isInternal: () => false, aliveSender: () => true });
    const k = rt.describe('7');
    check('closed: the icon the tab had comes with it', k.state === 'closed' && k.favicon === 'https://example.com/favicon.ico' && k.reopen === true, JSON.stringify(k));
    check('closed: a tab with no icon has none (the globe)', rt.describe('8').favicon === null, JSON.stringify(rt.describe('8')));
    const snap = rt.snapshot('7');
    check('a saved chat keeps the icon address with the tab', snap && snap.f === 'https://example.com/favicon.ico' && snap.t === 'Docs', JSON.stringify(snap));
    check('...and a later run of the app shows it from the snapshot', rt.describe('99@aaaaaaaa', snap).favicon === 'https://example.com/favicon.ico' && rt.describe('99@aaaaaaaa', snap).state === 'closed', JSON.stringify(rt.describe('99@aaaaaaaa', snap)));
    check('a snapshot icon that is not an image address is dropped', rt.describe('99@aaaaaaaa', { t: 'x', u: 'https://a.b/', f: 'javascript:alert(1)' }).favicon === null && rt.snapshot('8').f === undefined, '');
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
