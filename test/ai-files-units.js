// Files the AI makes, shown as cards (features/ai-files.js, agent.js engineFiles / ownFileUrl, the prompts): node test/ai-files-units.js
// Pure Node, no window. The real files live in a temp folder; the Windows-only path forms are checked as strings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const aiFiles = require('../src/features/ai-files');
const { Agent, systemFor, grokBuildNote, antigravityNote, codexNote, transcriptFor } = require('../src/ai/agent');

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${detail}`}`); };

// (realpath: on a Windows runner TEMP is the 8.3 short form, RUNNER~1, and the cards carry the real long path)
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'lumen-ai-files-')));
const docs = path.join(root, 'My Docs');
fs.mkdirSync(docs);
fs.mkdirSync(path.join(root, 'folder.html')); // a folder with a file's name
const page = path.join(docs, 'face diagonal.html');
const plain = path.join(root, 'cube.html');
const svg = path.join(root, 'cube.svg');
const pdf = path.join(root, 'notes.pdf');
const exe = path.join(root, 'setup.exe');
const png = path.join(root, 'shot.png');
fs.writeFileSync(page, '<!doctype html><title>x</title><svg></svg>');
fs.writeFileSync(plain, '<p>hi</p>');
fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
fs.writeFileSync(pdf, '%PDF-1.4 fake');
fs.writeFileSync(exe, 'MZ');
fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4', 'hex'));
const found = (text) => aiFiles.resolveFiles(aiFiles.findPaths(text, { home: root })).map((f) => f.path);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const has = (list, p) => list.some((x) => same(x, p));

// ---- finding paths in text
{
  const text = `Open ${plain} in a browser to see the diagram.`;
  check('a bare path in a sentence is found (the complaint\'s own wording)', has(found(text), plain), found(text).join('|'));
  check('a path with spaces in backticks is found', has(found(`Saved to \`${page}\`.`), page));
  // (bare paths with spaces are read on Windows, where the drive letter and the extension bound them; a bare POSIX path with a space can't be told from the sentence around it, so on macOS and Linux only the backticked form above counts)
  if (process.platform === 'win32') check('a path with spaces, bare, in a sentence, is found', has(found(`Open ${page} in a browser. I drew it as HTML/SVG`), page), found(`Open ${page} in a browser.`).join('|'));
  check('a path in double quotes and in <angle brackets> is found', has(found(`"${page}"`), page) && has(found(`<${plain}>`), plain));
  check('a markdown link target is found', has(found(`[the diagram](${svg})`), svg));
  check('a file:// address (with %20) is found', has(found(`See ${pathToFileURL(page).href} now`), page), found(`See ${pathToFileURL(page).href}`).join('|'));
  check('a path ending a sentence keeps its name, not the full stop', has(found(`I wrote ${plain}.`), plain));
  check('several files in one reply are all found, once each', found(`${plain} and \`${svg}\` and ${plain}`).length === 2);
  check('a path that does not exist is ignored', found('Open C:\\Users\\nobody\\nowhere\\missing.html now and /home/nobody/none.html').length === 0);
  check('a folder, even one named like a file, is ignored', found(`Look in ${path.join(root, 'folder.html')} and ${docs}`).length === 0);
  check('a relative path is ignored', found('see src/ai/agent.js and ./cube.html').length === 0);
  check('a web address is not a path', found('https://example.com/dir/cube.html').length === 0);
  check('a network path is ignored', aiFiles.resolveFiles(['\\\\server\\share\\a.html', '//server/share/a.html']).length === 0);
  check('a tilde path is read against the home folder', has(aiFiles.resolveFiles(aiFiles.findPaths('Saved ~/cube.html', { home: root })).map((f) => f.path), plain));
  const win = aiFiles.findPaths('Open C:\\Users\\emah\\Downloads\\fcc-cn12-face-diagonal.html in a browser to see the diagram.', { home: root });
  check('the Windows path from the complaint is a candidate', win.includes('C:\\Users\\emah\\Downloads\\fcc-cn12-face-diagonal.html'), win.join('|'));
  const dotted = aiFiles.findPaths('Open C:\\Users\\e.mah\\x.html now', { home: root });
  check('a dot in a folder name does not end the path', dotted.includes('C:\\Users\\e.mah\\x.html'), dotted.join('|'));
  const gitBash = aiFiles.findPaths('Saved /c/Users/me/x.html', { home: root, platform: 'win32' });
  check('a Git Bash path is read as the drive path', gitBash.includes('C:/Users/me/x.html'), gitBash.join('|'));
}

// ---- what a file is
{
  const [h, s, p, i, e] = aiFiles.resolveFiles([plain, svg, pdf, png, exe]);
  check('kinds: html, svg, pdf, image, other', h.kind === 'html' && s.kind === 'svg' && p.kind === 'pdf' && i.kind === 'image' && e.kind === 'file', [h, s, p, i, e].map((f) => f.kind).join());
  check('a program is never handed to the system to run, but a page is', !aiFiles.canOpenInSystem('exe') && !aiFiles.canOpenInSystem('ps1') && !aiFiles.canOpenInSystem('js') && aiFiles.canOpenInSystem('docx') && aiFiles.canOpenInSystem('html'));
  const trusted = aiFiles.cardOf(h, true);
  const named = aiFiles.cardOf(h, false);
  check('a trusted page may preview; the same page only named in a reply may not', trusted.previewable && !named.previewable && !named.trusted);
  check('a PDF has no inline preview (it opens in the viewer)', !aiFiles.cardOf(p, true).previewable);
  check('the card carries the name, folder and path', trusted.name === 'cube.html' && same(trusted.dir, root) && same(trusted.path, plain) && trusted.id.length === 16);
  const cards = [aiFiles.cardOf(h, true), aiFiles.cardOf(i, true), aiFiles.cardOf(s, false)];
  check('the main file is a page, SVG or PDF the AI made, never a named one or a picture', aiFiles.pickMain(cards).id === cards[0].id && aiFiles.pickMain([cards[1], cards[2]]) === null);
}

// ---- the registry and previews
{
  const reg = aiFiles.createRegistry();
  const [h] = aiFiles.resolveFiles([plain]);
  const card = reg.add(h, true);
  check('the registry answers only for ids it issued', reg.get(card.id)?.trusted === true && reg.get('0123456789abcdef') === null && reg.get('../../x') === null);
  check('a trusted file stays trusted when a later reply only names it', reg.add(h, false).trusted === true);
  const pv = aiFiles.previewOf(reg.get(card.id));
  check('a trusted page previews with its text', pv?.kind === 'html' && /<p>hi<\/p>/.test(pv.text));
  const named = createNamed();
  check('a file only named in a reply has no preview', aiFiles.previewOf(named.reg.get(named.card.id)) === null);
  const [i] = aiFiles.resolveFiles([png]);
  const ic = reg.add(i, true);
  check('a trusted picture previews as an image data URL', /^data:image\/png;base64,/.test(aiFiles.previewOf(reg.get(ic.id))?.dataUrl || ''));
  function createNamed() { const r = aiFiles.createRegistry(); const [f] = aiFiles.resolveFiles([svg]); return { reg: r, card: r.add(f, false) }; }
}

// ---- engineFiles: which files get a card, and which are trusted
(async () => {
  const run = async (text, opts = {}, browser = {}) => {
    const events = [];
    const listed = []; // the run's Files card list (type 'card_files'): no bubble of its own
    const blocks = await Agent.prototype.engineFiles.call({ browser }, text, opts.engine || null, (e) => (e.type === 'card_files' ? listed.push(...e.files) : events.push(e)), opts);
    return { blocks, events, listed };
  };
  const since = Date.now() - 60000;
  {
    const r = await run(`Open ${page} in a browser.`, { since, written: [page], engine: { freshRoots: () => [root] } });
    check('the complaint: a page the AI wrote and named gets a trusted card, flagged as the main file', r.events.length === 1 && r.events[0].type === 'file' && r.events[0].file.trusted && r.events[0].main === true && r.blocks[0].type === 'ai_file', JSON.stringify(r.events));
  }
  {
    const r = await run('Done.', { since, written: [svg, path.join(root, 'cube.html'), pdf] });
    check('a page, SVG or PDF the AI wrote gets a card even if the reply does not name it', r.events.length === 3 && r.events.every((e) => e.file.trusted), String(r.events.length));
    check('only one of them is the main file to open', r.events.filter((e) => e.main).length === 1);
  }
  {
    const r = await run('Done.', { since, written: [exe, path.join(root, 'folder.html')] });
    check('a file the AI only edited (no viewable type) gets no card unless the reply names it', r.events.length === 0);
    check('...but every file it wrote is listed in the Files card of the run, trusted, so it opens from there', r.listed.length === 1 && r.listed.every((f) => f.trusted && f.id), JSON.stringify(r.listed.map((f) => f.name)));
    check('a program it wrote is listed but can only be shown in its folder', r.listed.some((f) => f.canSystem === false), JSON.stringify(r.listed.map((f) => [f.name, f.canSystem])));
  }
  {
    const other = path.join(root, 'other.pdf'); fs.writeFileSync(other, '%PDF-1.4 other');
    const r = await run(`The notes are in ${other}.`, { since: null, written: [] });
    check('an existing file only named in the reply gets a card, not trusted, never the main file', r.events.length === 1 && !r.events[0].file.trusted && !r.events[0].main && !r.events[0].file.previewable);
  }
  {
    const oldPage = path.join(root, 'old.html'); const newSvg = path.join(root, 'new.svg');
    fs.writeFileSync(oldPage, '<p>old</p>'); fs.writeFileSync(newSvg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const old = Date.now() - 3600000; fs.utimesSync(oldPage, old / 1000, old / 1000);
    const r = await run(`${oldPage} and ${newSvg}`, { since, written: [], engine: { freshRoots: () => [root] } });
    const byName = Object.fromEntries(r.events.map((e) => [e.file.name, e.file.trusted]));
    check('a CLI with its own tools: a file written during the run is trusted, an older one is only named', byName['new.svg'] === true && byName['old.html'] === false, JSON.stringify(byName));
  }
  {
    const elsewhere = path.join(root, 'elsewhere.svg'); fs.writeFileSync(elsewhere, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const r = await run(`${elsewhere}`, { since, written: [], engine: { freshRoots: () => [path.join(root, 'My Docs')] } });
    check('a file outside the folders the run could write to is not trusted, whatever its age', r.events.length === 1 && r.events[0].file.trusted === false);
  }
  {
    const r = await run(`${page}`, { since, written: [page] }, { aiOff: (url) => /^file:/.test(url) });
    check('"Turn off AI here" for local files: no card, no auto-open', r.events.length === 0 && r.blocks.length === 0);
  }
  {
    const r = await run(`I saved ${png}`, { since, written: [png], pictures: [{ type: 'generated_image', caption: 'shot.png' }] });
    check('a picture the chat already drew from its file gets no second card', r.events.length === 0);
  }
  {
    const many = [];
    for (let i = 0; i < 7; i++) { const f = path.join(root, `m${i}.html`); fs.writeFileSync(f, '<p>m</p>'); many.push(f); }
    const r = await run('ok', { since, written: many });
    check('at most four cards per reply', r.events.length === aiFiles.MAX_FILES, String(r.events.length));
  }

  // ---- the stored block, and restoring the chat
  {
    const r = await run(`Here: ${page}`, { since, written: [page] });
    const items = transcriptFor([{ role: 'user', content: 'draw it' }, { role: 'assistant', content: [{ type: 'text', text: 'Here is the diagram.' }, ...r.blocks] }]);
    const reply = items.find((i) => i.role === 'assistant');
    check('a restored chat gets the card again, still trusted, and registered for its buttons', reply?.outFiles?.length === 1 && reply.outFiles[0].trusted && aiFiles.shared.get(reply.outFiles[0].id)?.trusted === true, JSON.stringify(reply));
    const gone = transcriptFor([{ role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'ai_file', path: path.join(root, 'deleted.html'), trusted: true }] }]);
    check('a file deleted since is not drawn', !gone[0].outFiles);
    check('a reply that is only a file still shows', transcriptFor([{ role: 'assistant', content: [{ type: 'ai_file', path: plain, trusted: true }] }]).length === 1);
  }

  // ---- open_tab: only a file the AI wrote in this chat, no approval; anything else keeps the old rules
  {
    const agent = new Agent({ aiOff: () => false }, () => null);
    const chat = [];
    const own = (p, who = chat) => agent.inTask(null, undefined, async () => agent.ownFileUrl(p), who);
    check('before any write is noted, open_tab on a local page is not a file the AI wrote', (await own(page)) === null);
    aiFiles.noteWritten(chat, page);
    const url = await own(page);
    check('after it noted the write, open_tab gets the file:// address', typeof url === 'string' && url.startsWith('file:///') && decodeURIComponent(url).toLowerCase().includes('face diagonal.html'), String(url));
    check('the same file by its file:// address', (await own(pathToFileURL(page).href)) === url);
    check('another file of the same folder, not written by the AI, is refused', (await own(plain)) === null);
    check('another chat has no claim on it', (await own(page, [])) === null);
    check('a PDF is left to the per-file approval of #340, a script and a program are never opened here', (await own(pdf)) === null && (await own(exe)) === null);
    aiFiles.noteWritten(chat, path.join(root, 'tool.js'));
    fs.writeFileSync(path.join(root, 'tool.js'), 'x');
    check('a script the AI wrote is not opened in a tab by this route', (await own(path.join(root, 'tool.js'))) === null);
    const off = new Agent({ aiOff: (u) => /^file:/.test(u) }, () => null);
    check('"Turn off AI here" for local files also stops open_tab on its own file', (await off.inTask(null, undefined, async () => off.ownFileUrl(page), chat)) === null);
  }

  // ---- the instruction side
  {
    const sys = systemFor({ model: 'claude-sonnet-4-5' });
    check('the shared prompt says Lumen is the browser: show what you make, never "open it in a browser"', /Show what you make in Lumen/.test(sys) && /never tell them to open a file in a browser/.test(sys) && /small diagrams inline/.test(sys));
    const note = /never tell them to open it in a browser/;
    check('every full-access note says the file is shown from its full path', note.test(grokBuildNote(null, { fullAccess: true, home: root })) && note.test(antigravityNote(null, new Date(), { fullAccess: true, home: root })) && note.test(codexNote(null, new Date(), { fullAccess: true, home: root })) && note.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'agent.js'), 'utf8').match(/CLAUDE_CODE_FULL_NOTE = `[\s\S]*?`;/)[0]));
    check('open_tab says it takes a file the AI wrote', /you wrote/.test(require('../src/ai/agent').EXTERNAL_TOOLS.find((t) => t.name === 'open_tab').description));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
