// Portable projects (features/project-portable.js): the plain files a project with a folder keeps (INSTRUCTIONS.md, AGENTS.md, sources.md, Sources/,
// project.json) and the two-way sync with Lumen's own copy: outside edits are picked up, Lumen's edits are written out, a second pass finds nothing
// to do (no loops), and when both sides changed the newer one wins and the other is kept next to it. Plain Node, real temp folders, a fake store.
const fs = require('fs');
const os = require('os');
const path = require('path');
const portable = require('../../src/features/project-portable');
const zipWrite = require('../../src/features/zip-write');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-portable-'));
const read = (f) => fs.readFileSync(f, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A project as Lumen has it, and the hooks sync() uses.
function project(name, init = {}) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  const p = { instructions: '', links: [], description: '', defaults: {}, updated: 0, files: [], state: {}, ...init };
  let n = 0;
  const ctx = {
    folder, state: p.state,
    get: () => ({ instructions: p.instructions, links: p.links, description: p.description, defaults: p.defaults, updated: p.updated }),
    apply: (patch) => { Object.assign(p, patch); },
    files: {
      kindOf: (name) => (/\.(txt|md|pdf|csv)$/i.test(name) ? 'text' : ''),
      list: () => p.files.map((f) => ({ ...f })),
      add: async ({ name, bytes }) => {
        if (/\bBAD\b/.test(bytes.toString())) return { ok: false, error: 'No text was found in this file.' };
        const old = p.files.find((f) => f.name.toLowerCase() === name.toLowerCase());
        const f = { id: old?.id || `f${++n}`, name, text: bytes.toString() };
        if (old) p.files.splice(p.files.indexOf(old), 1);
        p.files.push(f);
        return { ok: true, file: { id: f.id, name } };
      },
      remove: async (id) => { p.files = p.files.filter((f) => f.id !== id); return true; },
    },
  };
  return { p, ctx, folder };
}
const tick = () => sleep(25); // (distinct modification times)

(async () => {
  // ---- who is right about one text
  {
    const r = portable.reconcile;
    check('reconcile: equal texts (line ends and trailing space ignored) need nothing', r({ store: 'a\nb', file: 'a  \r\nb\r\n', last: '' }).do === 'none');
    check('reconcile: no file yet: Lumen\'s text is written; nothing when both are empty', r({ store: 'x', file: null }).do === 'writeFile' && r({ store: '', file: null }).do === 'none');
    const last = portable.sha('old');
    check('reconcile: only Lumen changed since the last sync: write the file', r({ store: 'new', file: 'old', last }).do === 'writeFile');
    check('reconcile: only the file changed: adopt it', r({ store: 'old', file: 'edited', last }).do === 'adoptFile');
    const both = r({ store: 'mine', file: 'theirs', last, storeTime: 5, fileTime: 9 });
    check('reconcile: both changed: the newer wins and the other is the loser to keep', both.do === 'adoptFile' && both.conflict && both.loser === 'store' && r({ store: 'mine', file: 'theirs', last, storeTime: 9, fileTime: 5 }).loser === 'file');
    check('reconcile: never synced and both have text: the file on disk wins, Lumen\'s text is kept aside; an empty side loses without a conflict', r({ store: 'mine', file: 'theirs', last: '' }).conflict === true && r({ store: '', file: 'theirs', last: '' }).conflict === undefined && r({ store: 'mine', file: '', last: portable.sha('zzz') }).do === 'writeFile');
  }

  // ---- sources.md
  {
    const links = [{ url: 'https://example.com/a', title: 'A page [draft]' }, { url: 'https://docs.python.org/3/', title: 'Python 3', site: true }, { url: 'https://example.org/', title: '' }];
    const text = portable.renderSources(links);
    check('sources.md: one line per source, a website marked whole site, brackets and untitled pages handled', /- \[A page draft\]\(https:\/\/example\.com\/a\)\n/.test(text) && /- \[Python 3\]\(https:\/\/docs\.python\.org\/3\/\) — whole site\n/.test(text) && /- \[example\.org\]\(https:\/\/example\.org\/\)/.test(text), text);
    const back = portable.parseSources(text);
    check('sources.md: it reads back what it wrote (titles, websites, no title for a bare address)', back.length === 3 && back[0].title === 'A page draft' && back[1].site === true && back[1].url === 'https://docs.python.org/3/' && back[2].title === '' && back[0].site === false, JSON.stringify(back));
    const hand = portable.parseSources('# My links\n\nSome notes of mine.\n\n- https://a.com/x\n* [B](http://b.com/y#frag) (whole site)\n- <https://c.com/z>\n- [bad](javascript:alert(1))\n- [dup](https://a.com/x)\n- [local](file:///etc/passwd)\n');
    check('sources.md: a file written by hand works: bare addresses, other bullets, http, no fragments; bad schemes and duplicates dropped; notes ignored', JSON.stringify(hand.map((x) => [x.url, x.site])) === JSON.stringify([['https://a.com/x', false], ['http://b.com/y', true], ['https://c.com/z', false]]), JSON.stringify(hand));
    check('sources.md: notes of the user\'s are told from the header and the list', portable.hasNotes('# My links\n- https://a.com/\nremember to read this') && !portable.hasNotes(portable.renderSources(links)));
    const merged = portable.mergeLinks(portable.parseSources('- [My own name](https://example.com/a)\n- [New](https://n.com/)'), [{ url: 'https://example.com/a', title: 'A page', added: 7 }]);
    check('sources.md: an address keeps its time, a different title typed in the file is the user\'s own (named)', merged[0].added === 7 && merged[0].named === true && merged[1].named === true && !merged[1].site);
  }

  // ---- the first pass writes the files, the second finds nothing
  {
    const { p, ctx, folder } = project('first', { instructions: 'Answer in a formal tone.', links: [{ url: 'https://example.com/a', title: 'A page', added: 3 }], description: 'Thesis', defaults: { plan: true } });
    const r1 = await portable.sync(ctx);
    check('first pass: INSTRUCTIONS.md, its AGENTS.md copy, CLAUDE.md (an import), sources.md and project.json are written', ['INSTRUCTIONS.md', 'AGENTS.md', 'CLAUDE.md', 'sources.md', 'project.json'].every((n) => r1.wrote.includes(n)) && read(path.join(folder, 'INSTRUCTIONS.md')) === 'Answer in a formal tone.\n' && read(path.join(folder, 'AGENTS.md')) === 'Answer in a formal tone.\n' && read(path.join(folder, 'CLAUDE.md')) === '@AGENTS.md\n' && /A page/.test(read(path.join(folder, 'sources.md'))) && JSON.parse(read(path.join(folder, 'project.json'))).defaults.plan === true, JSON.stringify(r1));
    const before = fs.readdirSync(folder).map((n) => [n, fs.statSync(path.join(folder, n)).mtimeMs]);
    const r2 = await portable.sync(ctx);
    check('second pass: nothing written, nothing changed (no loop)', !r2.wrote.length && !r2.changed && !r2.adopted.length && !r2.conflicts.length && JSON.stringify(fs.readdirSync(folder).map((n) => [n, fs.statSync(path.join(folder, n)).mtimeMs])) === JSON.stringify(before), JSON.stringify(r2));
    check('Lumen\'s copy is untouched by writing out', p.instructions === 'Answer in a formal tone.' && p.links.length === 1);
    // an existing CLAUDE.md is never overwritten
    const other = project('claude-md', { instructions: 'Be brief.' });
    fs.writeFileSync(path.join(other.folder, 'CLAUDE.md'), 'My own notes for Claude.\n');
    await portable.sync(other.ctx);
    check('an existing CLAUDE.md is left alone', read(path.join(other.folder, 'CLAUDE.md')) === 'My own notes for Claude.\n');

    // ---- an edit made in an editor
    await tick();
    fs.writeFileSync(path.join(folder, 'INSTRUCTIONS.md'), '# Tone\r\nAnswer in a casual tone.\r\n');
    const r3 = await portable.sync(ctx);
    check('INSTRUCTIONS.md edited outside Lumen: picked up, and AGENTS.md follows', p.instructions === '# Tone\nAnswer in a casual tone.' && r3.adopted.includes('instructions') && r3.changed && read(path.join(folder, 'AGENTS.md')) === '# Tone\nAnswer in a casual tone.\n', JSON.stringify([p.instructions, r3]));
    check('...and the pass after that does nothing', !(await portable.sync(ctx)).wrote.length);
    await tick();
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), 'Edited in AGENTS.md.\n');
    await portable.sync(ctx);
    check('only AGENTS.md edited: that is taken, and INSTRUCTIONS.md follows', p.instructions === 'Edited in AGENTS.md.' && read(path.join(folder, 'INSTRUCTIONS.md')) === 'Edited in AGENTS.md.\n');
    // ---- an edit made in Lumen
    p.instructions = 'Changed in Lumen.'; p.updated = Date.now();
    const r4 = await portable.sync(ctx);
    check('instructions changed in Lumen: both files are written', r4.wrote.includes('INSTRUCTIONS.md') && r4.wrote.includes('AGENTS.md') && read(path.join(folder, 'INSTRUCTIONS.md')) === 'Changed in Lumen.\n');
    // ---- both at once: the newer wins, the other is kept
    await tick();
    p.instructions = 'Lumen says this.'; p.updated = Date.now() - 5000;
    fs.writeFileSync(path.join(folder, 'INSTRUCTIONS.md'), 'The editor says this.\n');
    const r5 = await portable.sync(ctx);
    const aside = fs.readdirSync(folder).filter((n) => /^INSTRUCTIONS\.conflict-/.test(n));
    check('both changed: the newer (the file) wins and Lumen\'s text is kept as INSTRUCTIONS.conflict-<date>.md', p.instructions === 'The editor says this.' && r5.conflicts.length === 1 && aside.length === 1 && /Lumen says this/.test(read(path.join(folder, aside[0]))), JSON.stringify([p.instructions, r5, aside]));
    await tick();
    p.instructions = 'Lumen again.'; p.updated = Date.now() + 60000;
    fs.writeFileSync(path.join(folder, 'INSTRUCTIONS.md'), 'And the editor again.\n');
    await portable.sync(ctx);
    check('both changed, Lumen newer: Lumen wins and the file\'s text is kept aside', p.instructions === 'Lumen again.' && read(path.join(folder, 'INSTRUCTIONS.md')) === 'Lumen again.\n' && fs.readdirSync(folder).filter((n) => /^INSTRUCTIONS\.conflict-/.test(n)).some((n) => /And the editor again/.test(read(path.join(folder, n)))));
    // ---- deleted files come back
    fs.rmSync(path.join(folder, 'AGENTS.md'));
    fs.rmSync(path.join(folder, 'INSTRUCTIONS.md'));
    await portable.sync(ctx);
    check('a deleted INSTRUCTIONS.md or AGENTS.md is written again from Lumen\'s copy', read(path.join(folder, 'INSTRUCTIONS.md')) === 'Lumen again.\n' && read(path.join(folder, 'AGENTS.md')) === 'Lumen again.\n');

    // ---- sources.md edited outside
    await tick();
    fs.writeFileSync(path.join(folder, 'sources.md'), `${read(path.join(folder, 'sources.md'))}- [Course site](https://course.example.edu/cs101/) — whole site\n- https://example.net/reading\n`);
    const r6 = await portable.sync(ctx);
    check('sources.md edited outside: new pages and websites are picked up, the old one keeps its time', r6.adopted.includes('sources') && p.links.length === 3 && p.links[0].added === 3 && p.links[1].site === true && p.links[1].url === 'https://course.example.edu/cs101/' && p.links[2].url === 'https://example.net/reading', JSON.stringify(p.links));
    p.links = p.links.slice(0, 1); p.updated = Date.now();
    await portable.sync(ctx);
    check('a source removed in Lumen leaves sources.md too', !/course\.example/.test(read(path.join(folder, 'sources.md'))));
    fs.writeFileSync(path.join(folder, 'sources.md'), '# Sources\nmy own notes here\n- [A page](https://example.com/a)\n');
    p.links = [{ url: 'https://example.com/a', title: 'A page', added: 3 }, { url: 'https://new.example.com/', title: 'New', added: 9 }]; p.updated = Date.now() + 60000;
    await portable.sync(ctx);
    check('overwriting a sources.md that holds notes of the user keeps them aside', fs.readdirSync(folder).some((n) => /^sources\.conflict-/.test(n) && /my own notes here/.test(read(path.join(folder, n)))));
    // ---- project.json
    await tick();
    fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify({ description: 'Edited goal', defaults: { model: 'claude-opus-5', mcp: false, plan: 'yes' } }));
    await portable.sync(ctx);
    check('project.json edited outside: the goal line and the defaults are taken (bad values dropped)', p.description === 'Edited goal' && JSON.stringify(p.defaults) === JSON.stringify({ model: 'claude-opus-5', mcp: false }), JSON.stringify([p.description, p.defaults]));
    fs.writeFileSync(path.join(folder, 'project.json'), '{ not json');
    p.description = 'Kept'; p.updated = Date.now() + 120000;
    await portable.sync(ctx);
    check('a project.json that is not JSON is kept aside and rewritten', p.description === 'Kept' && JSON.parse(read(path.join(folder, 'project.json'))).description === 'Kept' && fs.readdirSync(folder).some((n) => /^project\.conflict-/.test(n)));
  }

  // ---- Sources/: drop a file in, edit it, delete it
  {
    const { p, ctx, folder } = project('files');
    await portable.sync(ctx);
    const dir = path.join(folder, 'Sources');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Handbook.txt'), 'How the co-op works.');
    fs.writeFileSync(path.join(dir, 'broken.txt'), 'BAD file');
    fs.writeFileSync(path.join(dir, 'tool.exe'), 'MZ');
    fs.writeFileSync(path.join(dir, '.hidden.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.md.tmp'), 'x');
    fs.mkdirSync(path.join(dir, 'Nested'));
    fs.writeFileSync(path.join(dir, 'Nested', 'deep.txt'), 'not looked at');
    const r1 = await portable.sync(ctx);
    check('a file dropped into Sources/ is added; an unreadable one is reported, not retried; other types, hidden, temp files and sub-folders are ignored', JSON.stringify(p.files.map((f) => f.name)) === JSON.stringify(['Handbook.txt']) && r1.files.added[0] === 'Handbook.txt' && r1.files.failed.length === 1 && /broken\.txt/.test(r1.files.failed[0]) && r1.changed, JSON.stringify(r1));
    const r2 = await portable.sync(ctx);
    check('the next pass does nothing about any of them (no loop, no retry of the failed one)', !r2.files.added.length && !r2.files.failed.length && !r2.changed && p.files.length === 1, JSON.stringify(r2));
    await tick();
    fs.writeFileSync(path.join(dir, 'Handbook.txt'), 'How the co-op works, revised and longer.');
    const r3 = await portable.sync(ctx);
    check('a file edited outside is read again (same name: replaced, same id)', r3.files.updated[0] === 'Handbook.txt' && p.files.length === 1 && /revised/.test(p.files[0].text) && p.files[0].id === 'f1', JSON.stringify([r3, p.files]));
    await tick();
    fs.writeFileSync(path.join(dir, 'broken.txt'), 'Now it is fine.');
    const r3b = await portable.sync(ctx);
    check('a file that failed is tried again once it changes', r3b.files.added.includes('broken.txt') && p.files.length === 2);
    fs.rmSync(path.join(dir, 'broken.txt'));
    const r4 = await portable.sync(ctx);
    check('a file deleted from Sources/ leaves the project', r4.files.removed[0] === 'broken.txt' && p.files.length === 1);
    // Lumen's own upload is written as the real file and is not "found" again
    await portable.writeUpload(ctx, 'Syllabus.pdf', Buffer.from('Week 1: intro'), 'f9');
    p.files.push({ id: 'f9', name: 'Syllabus.pdf', text: 'Week 1: intro' });
    const r5 = await portable.sync(ctx);
    check('an upload made in Lumen is kept as the real file in Sources/, and the next pass leaves it alone', read(path.join(dir, 'Syllabus.pdf')) === 'Week 1: intro' && !r5.files.added.length && !r5.files.updated.length && p.files.length === 2, JSON.stringify(r5));
    check('a file renamed in Lumen is renamed in Sources/', (await portable.renameFile(ctx, 'Syllabus.pdf', 'Course syllabus.pdf')) === true && fs.existsSync(path.join(dir, 'Course syllabus.pdf')) && !fs.existsSync(path.join(dir, 'Syllabus.pdf')) && (await portable.renameFile(ctx, 'nope.txt', 'x.txt')) === false);
    p.files = p.files.map((f) => (f.id === 'f9' ? { ...f, name: 'Course syllabus.pdf' } : f));
    check('a file removed in Lumen goes to Sources/Removed/, never deleted, and does not come back', (await portable.removeFile(ctx, 'Course syllabus.pdf')) === true && fs.existsSync(path.join(dir, 'Removed', 'Course syllabus.pdf')) && !fs.existsSync(path.join(dir, 'Course syllabus.pdf')));
    p.files = p.files.filter((f) => f.id !== 'f9');
    check('...the pass after it finds nothing', !(await portable.sync(ctx)).files.added.length && p.files.length === 1);
    // a folder that is gone is not a reason to remove anything
    const gone = project('gone', { files: [{ id: 'f1', name: 'A.txt' }], state: { files: { 'A.txt': { size: 1, mtimeMs: 1, id: 'f1' } } } });
    fs.rmSync(gone.folder, { recursive: true });
    const rg = await portable.sync(gone.ctx);
    check('a folder that is missing (a drive that is unplugged) changes nothing', rg.missing === true && gone.p.files.length === 1);
    // a Sources/ that is missing while the project has recorded files: nothing is removed
    const nodir = project('nodir', { files: [{ id: 'f1', name: 'A.txt' }], state: { files: { 'A.txt': { size: 1, mtimeMs: 1, id: 'f1' } } } });
    await portable.sync(nodir.ctx);
    check('no Sources/ folder at all: nothing is removed from the project', nodir.p.files.length === 1);
  }

  // ---- first time on a folder that already has things (enabling it for a project that has some, or a folder made by hand)
  {
    const { p, ctx, folder } = project('existing', { instructions: 'Lumen had these.' });
    fs.writeFileSync(path.join(folder, 'INSTRUCTIONS.md'), 'The folder had these.\n');
    const r = await portable.sync(ctx);
    check('turning it on over an INSTRUCTIONS.md that differs: the folder\'s text is used and Lumen\'s is kept aside', p.instructions === 'The folder had these.' && r.conflicts.length === 1 && /Lumen had these/.test(read(path.join(folder, r.conflicts[0]))), JSON.stringify(r));
    const empty = project('adopt-empty');
    fs.writeFileSync(path.join(empty.folder, 'AGENTS.md'), 'From a repo.\n');
    await portable.sync(empty.ctx);
    check('a folder with only AGENTS.md gives a project its instructions (and gets INSTRUCTIONS.md)', empty.p.instructions === 'From a repo.' && read(path.join(empty.folder, 'INSTRUCTIONS.md')) === 'From a repo.\n');
  }

  // ---- Open folder as project
  {
    const made = path.join(root, 'by-hand');
    fs.mkdirSync(path.join(made, 'Sources'), { recursive: true });
    fs.writeFileSync(path.join(made, 'INSTRUCTIONS.md'), 'Formal tone.\n');
    fs.writeFileSync(path.join(made, 'sources.md'), '- [Docs](https://docs.python.org/3/) — whole site\n');
    fs.writeFileSync(path.join(made, 'project.json'), JSON.stringify({ description: 'Goal', defaults: { plan: true } }));
    fs.writeFileSync(path.join(made, 'Sources', 'a.txt'), 'A');
    fs.writeFileSync(path.join(made, 'Sources', 'b.exe'), 'MZ');
    const got = await portable.readFolder(made, { kindOf: (n) => (/\.txt$/.test(n) ? 'text' : '') });
    check('readFolder: a folder made by hand gives instructions, sources, files and settings', got.instructions === 'Formal tone.' && got.links[0].site === true && got.files.length === 1 && got.files[0].name === 'a.txt' && got.description === 'Goal' && got.defaults.plan === true && got.loose === false, JSON.stringify([got.instructions, got.links, got.files.map((f) => f.name)]));
    const plain = path.join(root, 'plain-files');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'notes.txt'), 'n');
    fs.writeFileSync(path.join(plain, 'paper.txt'), 'p');
    fs.writeFileSync(path.join(plain, 'run.exe'), 'MZ');
    const loose = await portable.readFolder(plain, { kindOf: (n) => (/\.txt$/.test(n) ? 'text' : '') });
    check('readFolder: a plain folder of files: its own files are the sources', loose.loose === true && loose.files.map((f) => f.name).join() === 'notes.txt,paper.txt' && !loose.instructions);
    const claude = path.join(root, 'claude-only');
    fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'Use the repo style.\n');
    check('readFolder: a CLAUDE.md with text is instructions; one that only imports AGENTS.md is not', (await portable.readFolder(claude)).instructions === 'Use the repo style.' && (fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '@AGENTS.md\n'), (await portable.readFolder(claude)).instructions === ''));
  }

  // ---- the zip of an export
  {
    const zip = zipWrite.create([{ name: 'INSTRUCTIONS.md', data: Buffer.from('Formal tone.\n') }, { name: 'Sources/a.txt', data: Buffer.from('A'.repeat(5000)) }, { name: 'Chats/2026-01-01 Hello.md', data: Buffer.from('# Hello ünï\n') }]);
    const f = path.join(root, 'x.zip');
    fs.writeFileSync(f, zip);
    const entries = zipWrite.list(zip);
    check('zip: a zip with the project\'s files, UTF-8 names and deflated content that reads back', entries.length === 3 && entries[1].name === 'Sources/a.txt' && entries[1].size === 5000 && zipWrite.read(zip, 'INSTRUCTIONS.md').toString() === 'Formal tone.\n' && zipWrite.read(zip, 'Chats/2026-01-01 Hello.md').toString() === '# Hello ünï\n' && zip.length < 1000, JSON.stringify(entries));
    let unzipOk = true;
    try { const { execFileSync } = require('child_process'); if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -A System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${f.replace(/'/g, "''")}'); if($z.Entries.Count -ne 3){exit 3}; $z.Dispose()`], { stdio: 'ignore' }); else execFileSync('unzip', ['-tq', f], { stdio: 'ignore' }); } catch (err) { unzipOk = err?.code === 'ENOENT'; }
    check('zip: the system\'s own unzip accepts it', unzipOk);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
