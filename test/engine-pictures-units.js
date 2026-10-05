// Pictures a CLI engine made with its own tools (full access) show in the chat reply instead of a file address, plain Node:
// how file paths are read out of a reply and out of tool results (Windows, posix, backticks, markdown, file: addresses, quotes,
// trailing punctuation), the rules a file must meet to be shown (written during the run, real picture bytes, size cap, no
// link out, a few per reply), each engine's tool-result hook, and a markdown image that names a local file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const gen = require('../src/features/gen-images');
const gb = require('../src/ai/grok-build');
const cx = require('../src/ai/codex');
const { Agent } = require('../src/ai/agent');
const { render } = require('../src/renderer/markdown');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const J = JSON.stringify;
const same = (a, b) => J([...a].sort()) === J([...b].sort());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(20)]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-enginepics-'));

(async () => {
  // ---- reading paths out of text
  const win = 'C:\\Users\\me\\Pictures\\cat.png';
  const posix = '/home/me/pics/cat.jpg';
  const p = (text, o) => gen.pathsIn(text, o);
  check('paths: a plain Windows path, with trailing punctuation', same(p(`Saved to ${win}.`), [win]) && same(p(`Saved (${win}), done`), [win]), J(p(`Saved to ${win}.`)));
  check('paths: a plain posix path in a sentence, after a colon and in parentheses', same(p(`It is at ${posix}.`), [posix]) && same(p(`file: ${posix}`), [posix]) && same(p(`(${posix})`), [posix]));
  check('paths: backticks and quotes, with spaces', same(p('see `C:\\Users\\Me Too\\My Pics\\cat.png` now'), ['C:\\Users\\Me Too\\My Pics\\cat.png']) && same(p('see "/home/me/my pics/cat.webp" now'), ['/home/me/my pics/cat.webp']) && same(p("see '/home/me/a b/cat.gif'"), ['/home/me/a b/cat.gif']), J(p('see `C:\\Users\\Me Too\\My Pics\\cat.png` now')));
  check('paths: a markdown link and a markdown image (also with spaces and a title)', same(p(`[cat](${win})`), [win]) && same(p(`![a cat](${posix})`), [posix]) && same(p('![x](C:\\My Pics\\cat.png "title")'), ['C:\\My Pics\\cat.png']) && same(p('![x](<C:\\My Pics\\cat.png>)'), ['C:\\My Pics\\cat.png']), J(p('![x](C:\\My Pics\\cat.png "title")')));
  check('paths: file: addresses (Windows and posix, percent-escapes decoded)', same(p('file:///C:/Users/me/My%20Pics/cat.png'), ['C:/Users/me/My Pics/cat.png']) && same(p(`![x](file://${posix})`), [posix]) && same(p('file:///home/me/a%20b/cat.png'), ['/home/me/a b/cat.png']), J(p('file:///C:/Users/me/My%20Pics/cat.png')));
  check('paths: a file: address on another host is not a local path', gen.fromFileUrl('file://evil.example/share/cat.png') === null && gen.fromFileUrl('https://x.test/cat.png') === null);
  check('paths: only picture extensions; a web address and a relative path are not paths', p('a.txt /tmp/x.svg /tmp/x.pdf https://example.com/cat.png images/1.jpg ./cat.png').length === 0, J(p('a.txt /tmp/x.svg /tmp/x.pdf https://example.com/cat.png images/1.jpg ./cat.png')));
  check('paths: ~/ and Git Bash forms need the home folder to be read', same(p('~/Pictures/cat.png', { home: '/h' }), [path.join('/h', 'Pictures', 'cat.png')]) && p('~/Pictures/cat.png').length === 0);

  // ---- reading paths out of tool results
  const shot = 'C:\\Users\\me\\.grok\\sessions\\C%3A%5Cw\\01a1\\images\\1.jpg';
  const ig = J({ type: 'ImageGen', path: shot, filename: '1.jpg', session_folder: 'images', message: `Image generated and saved to ${shot}. Do not read or re-display it.` });
  check('tool result: Grok\'s ImageGen JSON (text, object, nested content) gives its path once', same(gen.toolImagePaths(ig), [shot]) && same(gen.toolImagePaths(JSON.parse(ig)), [shot]) && same(gen.toolImagePaths([{ type: 'content', content: { type: 'text', text: ig } }]), [shot]), J(gen.toolImagePaths(ig)));
  check('tool result: plain text, nothing, and a deeply nested value are safe', same(gen.toolImagePaths(`wrote ${posix}`), [posix]) && gen.toolImagePaths(null).length === 0 && gen.toolImagePaths(undefined).length === 0 && Array.isArray(gen.toolImagePaths(JSON.parse('{"a":'.repeat(20) + '1' + '}'.repeat(20)))));
  check('grok: only image_gen / image_edit results are read', same(gb.imageToolPaths('image_gen', ig), [shot]) && same(gb.imageToolPaths('image_edit', ig), [shot]) && gb.imageToolPaths('read_file', ig).length === 0 && gb.imageToolPaths('run_terminal_command', ig).length === 0 && gb.imageToolPaths(undefined, ig).length === 0);
  check('codex: a finished shell command\'s line and output, and a file change, name pictures (both event spellings)',
    same(cx.itemImagePaths({ type: 'commandExecution', command: 'python draw.py', aggregatedOutput: `wrote ${win}` }), [win])
    && same(cx.itemImagePaths({ type: 'command_execution', command: `convert a.png ${posix}`, aggregated_output: '' }), [posix])
    && same(cx.itemImagePaths({ type: 'fileChange', changes: [{ path: win, kind: 'add' }, { path: 'C:\\x\\a.txt' }] }), [win])
    && cx.itemImagePaths({ type: 'agentMessage', text: win }).length === 0);

  // ---- which files are shown
  const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, 'Pictures'), { recursive: true });
  const other = path.join(tmp, 'other'); fs.mkdirSync(other, { recursive: true });
  const since = Date.now() - 2000;
  const w = (dir, name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f; };
  const fresh = w(path.join(home, 'Pictures'), 'cat.png', PNG);
  const old = w(path.join(home, 'Pictures'), 'old.png', PNG); fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const future = w(path.join(home, 'Pictures'), 'future.png', PNG); fs.utimesSync(future, new Date(Date.now() + 3600e3), new Date(Date.now() + 3600e3));
  const fake = w(path.join(home, 'Pictures'), 'fake.png', Buffer.from('this is plain text, not a picture at all'));
  const svg = w(path.join(home, 'Pictures'), 'x.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'));
  const outside = w(other, 'outside.png', PNG);
  const opts = { roots: [home], since, until: Date.now(), home };
  const names = (list) => list.map((f) => path.basename(f.file)).sort();
  check('shown: only a file written during the run, inside the allowed folders, with picture bytes',
    same(names(gen.findLocalImages(`${fresh} ${old} ${future} ${fake} ${svg} ${outside}`, [], { fresh: opts })), ['cat.png']), J(names(gen.findLocalImages(`${fresh} ${old} ${future} ${fake} ${svg} ${outside}`, [], { fresh: opts }))));
  check('shown: a type is decided by the bytes (a JPEG named .png still shows; text named .png does not)', (() => { const j = w(path.join(home, 'Pictures'), 'really-jpeg.png', JPG); return names(gen.findLocalImages(j, [], { fresh: opts })).join() === 'really-jpeg.png' && gen.findLocalImages(fake, [], { fresh: opts }).length === 0; })());
  check('shown: with no run window nothing outside the engine\'s own folders is shown', gen.findLocalImages(fresh, [], {}).length === 0 && gen.findLocalImages(fresh, [], { fresh: null }).length === 0);
  check('shown: the size cap applies', gen.findLocalImages(fresh, [], { fresh: opts, max: 30 }).length === 0 && gen.findLocalImages(fresh, [], { fresh: opts }).length === 1);
  check('shown: explicit tool paths follow the same rules; a relative one is never opened', names(gen.findLocalImages('', [], { fresh: opts, paths: [fresh, old, outside, 'images/1.jpg', 'Pictures/cat.png'] })).join() === 'cat.png');
  let linked = false;
  const link = path.join(home, 'Pictures', 'link.png');
  try { fs.symlinkSync(outside, link); linked = true; } catch { /* no symlink rights on this machine */ }
  check('shown: a link pointing out of the allowed folders is not followed', !linked || gen.findLocalImages(link, [], { fresh: opts }).length === 0);
  const many = []; for (let i = 0; i < 7; i++) many.push(w(path.join(home, 'Pictures'), `many-${i}.png`, PNG));
  check('shown: at most a few pictures per reply', gen.findLocalImages(many.join(' '), [], { fresh: opts }).length === 4);

  // ---- through the agent: saved with the chat, told to the chat, kept on the reply
  const CHAT = 'abcdef0123456789';
  const store = gen.createImageStore({ dir: path.join(tmp, 'store'), available: () => false });
  const events = [];
  const emit = (e) => events.push(e);
  const agent = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '' }, () => null, () => ({}), () => null);
  agent.imageStore = store;
  const inChat = (fn) => agent.inTask(null, new AbortController().signal, fn, [], null, { chatId: CHAT });
  // an engine with no folders of its own (Codex, Antigravity): the home folder is the only place a run's picture may be
  const realHome = os.homedir();
  const mine = w(fs.mkdtempSync(path.join(realHome, '.lumen-enginepics-')), 'cat.png', PNG);
  try {
    events.length = 0;
    const blocks = await inChat(() => agent.enginePictures('I drew it: see the file', {}, emit, { since: Date.now() - 5000, paths: [mine] }));
    check('agent: a picture a tool reported is saved with the chat and shown, with its file name', blocks.length === 1 && blocks[0].caption === 'cat.png' && store.read(blocks[0].id)?.buffer.equals(PNG) && events.some((e) => e.type === 'image' && e.caption === 'cat.png'), J(events));
    events.length = 0;
    const named = await inChat(() => agent.enginePictures(`Saved as \`${mine}\``, {}, emit, { since: Date.now() - 5000 }));
    check('agent: a reply that only names the path (backticks) shows it too', named.length === 1, J(events));
    events.length = 0;
    const early = await inChat(() => agent.enginePictures(`Saved as ${mine}`, {}, emit, { since: Date.now() + 60000 }));
    check('agent: a file older than the run is not shown', early.length === 0 && !events.some((e) => e.type === 'image'), J(events));
    events.length = 0;
    const noFull = await inChat(() => agent.enginePictures(`Saved as ${mine}`, {}, emit, { paths: [mine] }));
    check('agent: without full access (no run window) nothing outside the engine\'s folders is shown', noFull.length === 0, J(events));
    const hist = require('../src/ai/agent').transcriptFor([{ role: 'user', content: 'draw' }, { role: 'assistant', content: [{ type: 'text', text: 'done' }, ...blocks] }]);
    check('agent: the history gives the picture back (with its caption) for the chat to draw', hist.at(-1).generated?.[0]?.caption === 'cat.png' && hist.at(-1).generated[0].id === blocks[0].id, J(hist.at(-1)));
  } finally { fs.rmSync(path.dirname(mine), { recursive: true, force: true }); }

  // ---- a markdown image naming a local file reads as its alt text, never as raw syntax or a loaded file
  const html = (s) => render(s);
  const w1 = html('Here: ![a cat](C:\\Users\\me\\Pictures\\cat.png) ok');
  check('markdown: a Windows path image becomes its alt text', /md-img-local">a cat</.test(w1) && !/<img/.test(w1) && !/!\[/.test(w1), w1);
  check('markdown: a posix path and a file: address too', /md-img-local">dog</.test(html('![dog](/home/me/dog.jpg)')) && /md-img-local">fox</.test(html('![fox](file:///C:/a/fox.webp)')), html('![dog](/home/me/dog.jpg)'));
  check('markdown: <path with spaces>, and no alt text falls back to the file name', /md-img-local">my cat</.test(html('![my cat](<C:\\My Pics\\cat.png>)')) && /md-img-local">cat.png</.test(html('![](C:\\My Pics\\cat.png)')) && /md-img-local">cat.png</.test(html('![](/home/me/cat.png)')), html('![](<C:\\My Pics\\cat.png>)'));
  check('markdown: never an <img> or a loadable address for a local file', !/<img|src=|file:\/\//.test(html('![x](file:///C:/a/b.png)') + html('![x](C:\\a\\b.png)') + html('![x](/etc/passwd.png)')));
  check('markdown: a local path that is not a picture type, and web pictures, are as before', !/md-img-local/.test(html('![x](C:\\a\\b.txt)')) && /md-img-remote/.test(html('![x](https://example.com/a.png)')));

  // A Claude Code reply ends early (reply_complete) before agent.js enginePictures runs: its picture event must still be drawn.
  {
    const core = fs.readFileSync(path.join(__dirname, '../src/renderer/chat-core.js'), 'utf8').replace(/\r\n/g, '\n');
    const lateAt = core.indexOf("if (event.type === 'image' && earlyEnded && event.runId === earlyEnded.runId)");
    const guardAt = core.indexOf('if (!turn || event.runId !== runId || forOtherChat(event.chatId)) return;');
    check('renderer: a picture arriving after an early-ended reply is handled before the finished-turn guard drops it', lateAt > 0 && guardAt > 0 && lateAt < guardAt, `${lateAt} ${guardAt}`);
    check('renderer: the late picture is placed after that reply (latePicture), not dropped', /function latePicture\(event\)/.test(core) && /anchor\.after\(pic\)/.test(core));
    const bundle = fs.readFileSync(path.join(__dirname, '../src/renderer/ui.bundle.js'), 'utf8');
    check('renderer: the committed bundle has the late-picture handling', bundle.includes('function latePicture(event)'));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
