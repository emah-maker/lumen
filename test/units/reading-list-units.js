// The reading list store and the AI's reading_list tool (features/reading-list.js), plain Node: saving, the same page twice,
// unread / read, mark all read, remove and Undo, the cap, the file on disk (atomic: a failed write leaves the old file whole,
// no temp files stay, a damaged file is kept aside), and the tool's text.
const fs = require('fs');
const os = require('os');
const path = require('path');
const RL = require('../../src/features/reading-list');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reading-list-'));
const fileOf = (name) => path.join(dir, name);
let clock = 1000;
const make = (name = 'rl.json', extra = {}) => RL.create({ file: fileOf(name), now: () => (clock += 10), delay: 5, ...extra });

(async () => {
  // ---- saving
  const s = make('basic.json');
  const a = s.add({ url: 'https://www.example.com/a#intro', title: '  An   article \n title ' });
  check('a page is saved with a tidy title and without its #fragment', a.ok && a.added && a.item.url === 'https://www.example.com/a' && a.item.title === 'An article title', JSON.stringify(a));
  check('the site is the host without www.', a.item.host === 'example.com');
  check('a new page is unread', a.item.read === false && s.unread() === 1);
  check('the same page again (other fragment) is not a second entry', s.add({ url: 'https://www.example.com/a#other' }).added === false && s.count() === 1);
  check('a page with no title is named for its site', s.add({ url: 'https://news.example.org/x', title: '' }).item.title === 'news.example.org');
  for (const bad of ['javascript:alert(1)', 'file:///c:/x.txt', 'lumen://history', 'about:blank', '', 'nonsense', null, undefined]) {
    check(`not saved: ${String(bad)}`, s.add({ url: bad }).ok === false);
  }
  check('only the two good pages are listed', s.count() === 2);
  check('newest first', s.list()[0].url === 'https://news.example.org/x');
  check('has / get work on an address with a fragment', s.has('https://www.example.com/a#zzz') && s.get('https://www.example.com/a')?.title === 'An article title' && !s.has('https://example.com/other'));

  // ---- read state
  check('opening marks it read', s.markRead('https://news.example.org/x') === true && s.get('https://news.example.org/x').read === true);
  check('marking read twice changes nothing', s.markRead('https://news.example.org/x') === false);
  check('the Unread filter hides it; All keeps it', s.list({ filter: 'unread' }).length === 1 && s.list({ filter: 'all' }).length === 2 && s.list({ filter: 'unread' })[0].url === 'https://www.example.com/a');
  check('mark as unread brings it back', s.markRead('https://news.example.org/x', false) === true && s.unread() === 2);
  s.add({ url: 'https://third.example.net/' });
  check('mark all read counts what changed', s.markAllRead() === 3 && s.unread() === 0 && s.markAllRead() === 0);
  const again = s.add({ url: 'https://www.example.com/a', title: 'Newer title' });
  check('saving a read page again puts it on top, unread, with the newer title', again.added === false && s.list()[0].url === 'https://www.example.com/a' && s.list()[0].read === false && s.list()[0].title === 'Newer title');

  // ---- remove and Undo
  const gone = s.get('https://third.example.net/');
  check('remove', s.remove('https://third.example.net/') === true && !s.has('https://third.example.net/') && s.remove('https://third.example.net/') === false);
  check('Undo puts it back where its date puts it, read state kept', s.restore(gone) === true && s.get('https://third.example.net/').read === true && s.list().map((e) => e.url).indexOf('https://third.example.net/') > 0 && s.restore(gone) === false);
  check('restore refuses a non-web address', s.restore({ url: 'file:///x' }) === false);

  // ---- listeners
  let calls = 0;
  const off = s.onChange(() => { calls++; });
  s.markRead('https://www.example.com/a'); s.markRead('https://www.example.com/a'); s.remove('https://nope.example/');
  check('a change tells the listeners once; a no-op tells nobody', calls === 1, String(calls));
  off(); s.markRead('https://www.example.com/a', false);
  check('a removed listener is not called', calls === 1);

  // ---- the cap
  const capped = make('cap.json', { cap: 3 });
  for (let i = 0; i < 5; i++) capped.add({ url: `https://c.example/${i}` });
  check('over the cap the oldest go', capped.count() === 3 && capped.list().map((e) => e.url.slice(-1)).join('') === '432');
  await capped.flush(); // (its debounced write must not still be in flight when the next checks list the folder)

  // ---- the file
  await s.flush();
  const onDisk = JSON.parse(fs.readFileSync(fileOf('basic.json'), 'utf8'));
  check('the file holds version and items with only address, title and dates', onDisk.version === 1 && onDisk.items.length === 3 && onDisk.items.every((e) => Object.keys(e).sort().join() === 'readAt,savedAt,title,url'), JSON.stringify(onDisk));
  check('no temp file is left behind', fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), fs.readdirSync(dir).join(','));
  const again2 = make('basic.json');
  check('a new store reads the same list back, order and read state', JSON.stringify(again2.list()) === JSON.stringify(s.list()), JSON.stringify(again2.list()));
  // the debounced write happens by itself
  const timed = make('timed.json');
  timed.add({ url: 'https://t.example/' });
  check('a change is pending until written', timed.pending() === true);
  await new Promise((r) => setTimeout(r, 120));
  check('and the debounce writes it', timed.pending() === false && JSON.parse(fs.readFileSync(fileOf('timed.json'), 'utf8')).items.length === 1);
  // flushSync (quitting)
  const quit = make('quit.json');
  quit.add({ url: 'https://q.example/' });
  quit.flushSync();
  check('flushSync writes at once', JSON.parse(fs.readFileSync(fileOf('quit.json'), 'utf8')).items.length === 1 && !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
  // a failed write: the old file stays whole
  const failing = { ...fs, promises: { ...fs.promises, rename: async () => { throw new Error('disk full'); } } };
  const keep = make('keep.json');
  keep.add({ url: 'https://k.example/1' }); await keep.flush();
  const before = fs.readFileSync(fileOf('keep.json'), 'utf8');
  const frail = RL.create({ file: fileOf('keep.json'), fs: failing, now: () => (clock += 10), delay: 5 });
  frail.add({ url: 'https://k.example/2' });
  await frail.flush();
  check('a write that fails leaves the old file whole, with no temp file', fs.readFileSync(fileOf('keep.json'), 'utf8') === before && !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
  check('and the list in memory is still right, to be written next time', frail.count() === 2 && frail.pending() === true);
  // a damaged file
  fs.writeFileSync(fileOf('bad.json'), '{ "items": [ { "url": "https://x.example/"', 'utf8');
  const bad = make('bad.json');
  check('a damaged file reads as an empty list and is kept aside, not overwritten', bad.count() === 0 && !fs.existsSync(fileOf('bad.json')) && fs.readdirSync(dir).some((f) => f.startsWith('bad.json.damaged-')));
  fs.writeFileSync(fileOf('odd.json'), JSON.stringify({ items: [{ url: 'javascript:1', title: 'x' }, { url: 'https://ok.example/', title: 5, savedAt: 'later' }, { url: 'https://ok.example/#again' }, 7, null] }), 'utf8');
  const odd = make('odd.json');
  check('odd entries in a file are dropped or cleaned', odd.count() === 1 && odd.list()[0].title === '5' && odd.list()[0].savedAt === 0, JSON.stringify(odd.list()));
  check('a missing file is an empty list and is not made until something is saved', make('none.json').count() === 0 && !fs.existsSync(fileOf('none.json')));

  // ---- the AI's tool
  const t = make('tool.json');
  const tab = { url: 'https://site.example/post?id=1', title: 'A post' };
  check('save with no url saves the tab, with its title', /Saved “A post”/.test(RL.toolText({ action: 'save' }, { store: t, tab })) && t.has(tab.url));
  check('saving it again says so', /already on the reading list/.test(RL.toolText({ action: 'save' }, { store: t, tab })));
  RL.toolText({ action: 'save', url: 'https://other.example/p' }, { store: t, tab });
  check('save with a url uses that url, not the tab title', t.get('https://other.example/p').title === 'other.example');
  check('save refuses what is not a web page', (() => { try { RL.toolText({ action: 'save', url: 'file:///x' }, { store: t, tab }); return false; } catch (e) { return /web pages/.test(e.message); } })());
  const list = RL.toolText({ action: 'list' }, { store: t });
  check('list shows unread ones, title, site and address', /^2 unread:/.test(list) && /A post \(site\.example\) https:\/\/site\.example\/post\?id=1/.test(list), list);
  t.markRead('https://other.example/p');
  check('list hides read ones; all:true shows them marked', !/other\.example/.test(RL.toolText({ action: 'list' }, { store: t })) && /\[read\]/.test(RL.toolText({ action: 'list', all: true }, { store: t })));
  check('list leaves out a site the user turned AI off on', !/site\.example/.test(RL.toolText({ action: 'list', all: true }, { store: t, hidden: (u) => u.includes('site.example') })));
  check('an empty list says so', RL.toolText({ action: 'list' }, { store: make('empty.json') }) === 'Nothing unread on the reading list.');
  check('remove with a url, then with nothing there', /Removed/.test(RL.toolText({ action: 'remove', url: 'https://other.example/p' }, { store: t })) && /not on the reading list/.test(RL.toolText({ action: 'remove', url: 'https://other.example/p' }, { store: t })));
  check('an unknown action is refused', (() => { try { RL.toolText({ action: 'explode' }, { store: t }); return false; } catch { return true; } })());
  const many = make('many.json');
  for (let i = 0; i < 40; i++) many.add({ url: `https://m.example/${i}` });
  check('a long list is cut at 30 and says how many there are', /^40 unread, first 30:/.test(RL.toolText({ action: 'list' }, { store: many })) && RL.toolText({ action: 'list' }, { store: many }).split('\n').length === 31);

  // ---- the tool is offered only when the chat is about it (ai/agent.js), so the default request keeps its size
  const { Agent, requestFor, EXTERNAL_TOOLS } = require('../../src/ai/agent');
  const offered = (...texts) => Agent.prototype.readingOffered.call({}, texts.map((text) => ({ role: 'user', content: text })));
  check('"save this for later" offers it', offered('can you save this for later?') && offered('Save this page to my reading list') && offered('add it to read later') && offered('what is on my Reading List'));
  check('an ordinary chat does not', !offered('open the news') && !offered('what time is it later today') && !offered('please read the page'));
  check('a chat that already used it keeps it', Agent.prototype.readingOffered.call({}, [{ role: 'user', content: 'ok' }, { role: 'assistant', content: [{ type: 'tool_use', name: 'reading_list', input: {} }] }]));
  const names = (req) => req.tools.map((x) => x.name);
  const msgs = [{ role: 'user', content: 'hi' }];
  check('the default request has no reading_list', !names(requestFor({ model: 'claude-sonnet-5-5' }, msgs)).includes('reading_list'));
  check('and with reading: true it has it, with its short schema', (() => { const tool = requestFor({ model: 'claude-sonnet-5-5' }, msgs, undefined, { reading: true }).tools.find((x) => x.name === 'reading_list'); return Boolean(tool) && tool.description.length < 130 && JSON.stringify(tool.input_schema).length < 230; })());
  check('MCP clients and the CLI engines do not list it (their budget is full)', !EXTERNAL_TOOLS.some((x) => x.name === 'reading_list'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
