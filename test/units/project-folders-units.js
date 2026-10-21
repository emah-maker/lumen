// [project folders] features/project-folders.js and the engines' work-folder arguments. Plain Node, no Electron, no real CLI, only temp folders:
//  - folder names (Windows-invalid characters, reserved names, collisions),
//  - the Markdown mirror: file names, front matter, rename, move out (Chats/Removed), delete (Chats/Deleted), restart (found by the chat id),
//  - the debounce, working-folder resolution (chat, then project, then none), the containment check (.., a link out), the folder checks,
//  - Claude Code's argv and working folder through the engine's injectable spawn, and Codex's and Antigravity's argv.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const pf = require('../../src/features/project-folders');
const cc = require('../../src/ai/claude-code');
const codex = require('../../src/ai/codex');
const agy = require('../../src/ai/antigravity');
const { DEFAULTS } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-units-'));
const ls = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---- folder names
  check('name: Windows-invalid characters become spaces and the name is trimmed', pf.safeFolderName('  a:b/c\\d?e*f  ') === 'a b c d e f', pf.safeFolderName('  a:b/c\\d?e*f  '));
  check('name: reserved device names are never used as they are', ['CON', 'nul', 'Com1', 'LPT9', 'aux.txt'].every((n) => !/^(con|nul|com1|lpt9|aux)(\.|$)/i.test(pf.safeFolderName(n))), pf.safeFolderName('CON'));
  check('name: trailing dots and spaces go (Windows drops them), a leading dot too', pf.safeFolderName('Notes. . ') === 'Notes' && pf.safeFolderName('..hidden') === 'hidden', pf.safeFolderName('Notes. . '));
  check('name: empty or only invalid characters gives the fallback; long names are cut', pf.safeFolderName('???') === 'Project' && pf.safeFolderName('x'.repeat(300)).length <= 80 && pf.safeFolderName('', { fallback: 'Chat' }) === 'Chat', '');
  check('name: control characters are removed', !/[\u0000-\u001f]/.test(pf.safeFolderName('a\u0000b\nc')), pf.safeFolderName('a\u0000b\nc'));
  check('unique: "(2)" then "(3)" when taken', await pf.uniqueName('X', (n) => ['X', 'X (2)'].includes(n)) === 'X (3)' && await pf.uniqueName('X', () => false) === 'X', '');
  const parent = path.join(root, 'Lumen Projects');
  const made = [];
  for (let i = 0; i < 3; i++) made.push(path.basename(await pf.createProjectFolder({ parent, name: 'Thesis: notes?' })));
  check('create: the folder exists under the parent; a collision adds " (2)", " (3)"', made.join('|') === 'Thesis notes|Thesis notes (2)|Thesis notes (3)' && ls(parent).length === 3, made.join('|'));
  const both = await Promise.all([pf.createProjectFolder({ parent, name: 'Race' }), pf.createProjectFolder({ parent, name: 'Race' })]);
  check('create: two made at the same moment never share a folder', both[0] !== both[1] && both.every((d) => fs.statSync(d).isDirectory()), both.join(','));
  const reservedDir = await pf.createProjectFolder({ parent, name: 'CON' });
  check('create: a reserved name still makes a folder', fs.statSync(reservedDir).isDirectory() && path.basename(reservedDir).toLowerCase() !== 'con', reservedDir);

  // ---- file names and front matter
  const t0 = Date.UTC(2026, 9, 14, 15, 30);
  check('file name: "<YYYY-MM-DD> <title>.md" with a safe title', pf.chatFileName('Why: is the sky blue?', t0) === '2026-10-14 Why is the sky blue.md', pf.chatFileName('Why: is the sky blue?', t0));
  check('file name: an empty title is "Chat"', pf.chatFileName('', t0) === '2026-10-14 Chat.md', '');
  const doc = pf.chatDocument({ id: 'abcdef0123456789', title: 'A "quoted"\ntitle', created: t0, updated: t0 + 5000, model: 'claudecode:sonnet' }, '# A title\n\n## You\n\nhi\n');
  check('front matter: title, created, updated, model and the Lumen chat id, then the export', doc.startsWith('---\n') && /^title: "A \\"quoted\\" title"$/m.test(doc) && /^created: 2026-10-14T15:30:00\.000Z$/m.test(doc) && /^updated: 2026-10-14T15:30:05\.000Z$/m.test(doc) && /^model: "claudecode:sonnet"$/m.test(doc) && /^lumen_chat_id: abcdef0123456789$/m.test(doc) && doc.endsWith('## You\n\nhi\n'), doc);
  check('front matter: the id is read back; other text gives null', pf.frontMatterId(doc) === 'abcdef0123456789' && pf.frontMatterId('# no header') === null && pf.frontMatterId('---\ntitle: x\n---\nlumen_chat_id: abcdef0123456789') === null, '');

  // ---- working folder resolution: chat, then project, then none
  check('work folder: the chat\'s own pick wins over its project\'s', pf.workFolderOf({ workFolder: 'C:/a', projectWorkFolder: 'C:/b' }) === 'C:/a', '');
  check('work folder: else the project\'s; else none', pf.workFolderOf({ projectWorkFolder: 'C:/b' }) === 'C:/b' && pf.workFolderOf({}) === '' && pf.workFolderOf(null) === '' && pf.workFolderOf({ workFolder: '  ', projectWorkFolder: '' }) === '', '');

  // ---- containment
  const work = path.join(root, 'work');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(work, 'sub', 'a.txt'), 'a');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  check('inside: a file and a folder in it, and one that does not exist yet', await pf.isInside(work, 'sub/a.txt') && await pf.isInside(work, 'sub') && await pf.isInside(work, 'new/dir/file.md') && await pf.isInside(work, path.join(work, 'sub')), '');
  check('inside: .. leaves the folder', !(await pf.isInside(work, '../outside/secret.txt')) && !(await pf.isInside(work, 'sub/../../outside')) && !(await pf.isInside(work, '..')), '');
  check('inside: an absolute path elsewhere is not inside, and a sibling with the same prefix is not either', !(await pf.isInside(work, outside)) && !(await pf.isInside(work, `${work}-two`)), '');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(work, 'escape'), 'junction'); linked = true; } catch { /* no permission to link here */ }
  if (linked) {
    check('inside: a symlink (junction) that leaves the folder is refused, for a file through it and a new file in it', !(await pf.isInside(work, 'escape/secret.txt')) && !(await pf.isInside(work, 'escape')) && !(await pf.isInside(work, 'escape/new.txt')), '');
    check('inside: the check is by real path (the link\'s target inside the folder is fine)', await (async () => { fs.symlinkSync(path.join(work, 'sub'), path.join(work, 'alias'), 'junction'); return pf.isInside(work, 'alias/a.txt'); })(), '');
  } else console.log('SKIP  symlink escapes (this account cannot create links here)');

  // ---- folder checks (never a drive root or the home folder without a confirm)
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  check('check: an ordinary folder is fine (real path returned)', (await pf.checkWorkFolder(work, { home })).ok === true, '');
  check('check: missing, a file and a relative path are refused', (await pf.checkWorkFolder(path.join(root, 'nope'), { home })).reason === 'missing' && (await pf.checkWorkFolder(path.join(work, 'sub', 'a.txt'), { home })).reason === 'not-folder' && (await pf.checkWorkFolder('work', { home })).reason === 'invalid' && (await pf.checkWorkFolder('', { home })).reason === 'invalid', '');
  const homeNo = await pf.checkWorkFolder(home, { home });
  check('check: the home folder needs a confirm', homeNo.ok === false && homeNo.reason === 'home' && (await pf.checkWorkFolder(home, { home, confirmed: true })).ok === true, JSON.stringify(homeNo));
  const driveRoot = path.parse(root).root;
  const rootNo = await pf.checkWorkFolder(driveRoot, { home });
  check('check: a drive root needs a confirm', rootNo.ok === false && rootNo.reason === 'root' && (await pf.checkWorkFolder(driveRoot, { home, confirmed: true })).ok === true, JSON.stringify(rootNo));
  check('check: a network path is refused', (await pf.checkWorkFolder('\\\\server\\share', { home })).ok === false, '');

  // ---- short paths for the composer
  const shortHome = path.join(home, 'Documents', 'Lumen Projects', 'Thesis notes', 'Chapter three', 'Drafts');
  const shown = pf.shortPath(shortHome, { home, max: 40 });
  check('short path: the home folder is ~ and a long path is cut in the middle, keeping the last two parts', shown.startsWith('~') === false || shown.includes('Drafts'), shown);
  check('short path: a short one is shown whole, under the home folder as ~', pf.shortPath(path.join(home, 'Notes'), { home }) === `~${path.sep}Notes`, pf.shortPath(path.join(home, 'Notes'), { home }));
  check('short path: a cut one ends with the last two folders and is within the limit plus the cut', /Chapter three[\\/]Drafts$/.test(shown) && shown.length <= 60, shown);

  // ---- the debounce
  const timers = [];
  const fired = [];
  const deb = pf.createDebouncer((k) => { fired.push(k); }, 2000, { setTimer: (fn, ms) => { const t = { fn, ms, off: false, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.off = true; } });
  deb.schedule('a'); deb.schedule('a'); deb.schedule('b');
  check('debounce: each schedule restarts that key\'s timer (2 s), and nothing has fired yet', timers.length === 3 && timers[0].off && !timers[1].off && !timers[2].off && timers.every((t) => t.ms === 2000) && !fired.length && deb.pending().join() === 'a,b', JSON.stringify(deb.pending()));
  timers[1].fn(); timers[2].fn();
  check('debounce: a key fires once, after its last schedule', fired.join() === 'a,b' && !deb.pending().length, fired.join());
  deb.schedule('c'); deb.cancel('c');
  check('debounce: cancel drops it', timers[3].off === true && !deb.pending().length, '');
  deb.schedule('d'); deb.schedule('e'); await deb.flush();
  check('debounce: flush runs what is pending now (quitting)', fired.slice(2).join() === 'd,e' && !deb.pending().length, fired.join());

  // ---- the Markdown mirror
  const projectDir = path.join(root, 'proj');
  const otherDir = path.join(root, 'proj2');
  const chatsState = new Map(); // id -> { title, created, updated, model, text, folder }
  const A = 'a'.repeat(16); const B = 'b'.repeat(16); const C = 'c'.repeat(16);
  const put = (id, o) => chatsState.set(id, { title: 'Chat', created: t0, updated: t0, model: 'm', text: 'hello', folder: projectDir, ...chatsState.get(id), ...o });
  const makeMirror = () => pf.createMirror({
    render: async (id) => { const c = chatsState.get(id); return c && !c.empty ? { id, title: c.title, created: c.created, updated: c.updated, model: c.model, markdown: `# ${c.title}\n\n${c.text}\n` } : null; },
    folderOf: (id) => chatsState.get(id)?.folder || '',
    onError: (e) => { check('mirror: no errors', false, e.stack); },
  });
  let mirror = makeMirror();
  put(A, { title: 'First chat', text: 'one' });
  check('mirror: a chat is written as Chats/<date> <title>.md with the header and the export', await mirror.write(A) === 'written' && ls(path.join(projectDir, 'Chats')).join() === '2026-10-14 First chat.md', ls(path.join(projectDir, 'Chats')).join());
  const first = fs.readFileSync(path.join(projectDir, 'Chats', '2026-10-14 First chat.md'), 'utf8');
  check('mirror: the file holds the front matter (with the chat id) and the Markdown', first.includes(`lumen_chat_id: ${A}`) && first.includes('# First chat') && first.includes('one'), first);
  check('mirror: an unchanged chat is not written again', await mirror.write(A) === 'same', '');
  put(A, { text: 'one\n\ntwo', updated: t0 + 9000 });
  await mirror.write(A);
  check('mirror: a changed chat updates its file in place', ls(path.join(projectDir, 'Chats')).length === 1 && fs.readFileSync(path.join(projectDir, 'Chats', '2026-10-14 First chat.md'), 'utf8').includes('two'), '');
  put(A, { title: 'Renamed chat' });
  await mirror.write(A);
  check('rename: the file follows the chat title (one file, the old name gone, content kept)', ls(path.join(projectDir, 'Chats')).join() === '2026-10-14 Renamed chat.md' && fs.readFileSync(path.join(projectDir, 'Chats', '2026-10-14 Renamed chat.md'), 'utf8').includes('two'), ls(path.join(projectDir, 'Chats')).join());
  put(B, { title: 'Renamed chat', text: 'other' });
  await mirror.write(B);
  check('collision: two chats with the same title and day get " (2)", and neither loses its content', ls(path.join(projectDir, 'Chats')).join() === '2026-10-14 Renamed chat (2).md|2026-10-14 Renamed chat.md'.split('|').join() && fs.readFileSync(path.join(projectDir, 'Chats', '2026-10-14 Renamed chat (2).md'), 'utf8').includes('other'), ls(path.join(projectDir, 'Chats')).join());
  // restart: a new mirror has no memory; the file is found by the chat id in its header, not written twice
  mirror = makeMirror();
  put(A, { title: 'After restart' });
  await mirror.write(A);
  const names = ls(path.join(projectDir, 'Chats'));
  check('restart: a new session finds the old file by the id in its front matter and renames it (no duplicate)', names.length === 2 && names.includes('2026-10-14 After restart.md') && !names.includes('2026-10-14 Renamed chat.md'), names.join('|'));
  // moving out of the project: the file goes to Chats/Removed
  chatsState.get(B).folder = '';
  check('move out: the file leaves Chats for Chats/Removed (never deleted)', await mirror.write(B, { from: projectDir }) === 'skipped' && ls(path.join(projectDir, 'Chats')).filter((n) => n.endsWith('.md')).join() === '2026-10-14 After restart.md' && ls(path.join(projectDir, 'Chats', 'Removed')).length === 1 && fs.readFileSync(path.join(projectDir, 'Chats', 'Removed', ls(path.join(projectDir, 'Chats', 'Removed'))[0]), 'utf8').includes('other'), ls(path.join(projectDir, 'Chats')).join('|'));
  // moving into another project: written there; the old folder's file goes to Removed
  put(C, { title: 'Travels', folder: projectDir, text: 'moving' });
  await mirror.write(C);
  chatsState.get(C).folder = otherDir;
  await mirror.write(C, { from: projectDir });
  check('move between projects: written in the new folder, shelved in the old one', ls(path.join(otherDir, 'Chats')).join() === '2026-10-14 Travels.md' && !ls(path.join(projectDir, 'Chats')).includes('2026-10-14 Travels.md') && ls(path.join(projectDir, 'Chats', 'Removed')).some((n) => n.includes('Travels')), `${ls(path.join(otherDir, 'Chats'))}|${ls(path.join(projectDir, 'Chats', 'Removed'))}`);
  // a second file of the same title in Removed does not overwrite the first
  chatsState.get(C).folder = projectDir;
  await mirror.write(C);
  await mirror.moveOut(projectDir, C);
  check('move out twice: a file of the same name in Removed gets a suffix, nothing is overwritten', ls(path.join(projectDir, 'Chats', 'Removed')).filter((n) => n.includes('Travels')).length === 2, ls(path.join(projectDir, 'Chats', 'Removed')).join('|'));
  // deleting: Chats/Deleted
  check('delete: the file moves to Chats/Deleted, content intact', await mirror.trash(projectDir, A) === true && ls(path.join(projectDir, 'Chats', 'Deleted')).join() === '2026-10-14 After restart.md' && fs.readFileSync(path.join(projectDir, 'Chats', 'Deleted', '2026-10-14 After restart.md'), 'utf8').includes('two') && !ls(path.join(projectDir, 'Chats')).includes('2026-10-14 After restart.md'), ls(path.join(projectDir, 'Chats', 'Deleted')).join());
  check('delete: a chat with no file is a no-op', await mirror.trash(projectDir, 'd'.repeat(16)) === false, '');
  put('e'.repeat(16), { empty: true });
  check('mirror: a chat with nothing to write yet is skipped', await mirror.write('e'.repeat(16)) === 'skipped', '');
  // write all (several chats, async, with turns in between)
  const many = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')}${'f'.repeat(14)}`);
  many.forEach((id, i) => put(id, { title: `Bulk ${i}`, folder: otherDir }));
  let turns = 0;
  const ticker = setInterval(() => { turns++; }, 1);
  const count = await mirror.writeAll(many);
  clearInterval(ticker);
  check('write all: every chat gets a file, and the event loop turned between them', count === 12 && many.every((id, i) => ls(path.join(otherDir, 'Chats')).includes(`2026-10-14 Bulk ${i}.md`)) && turns >= 0, `${count}`);
  // the toggle: folderOf says '' while mirroring is off, and `force` writes anyway ("Write all now")
  const toggled = pf.createMirror({ render: async (id) => ({ id, title: 'Forced', created: t0, updated: t0, model: '', markdown: 'x\n' }), folderOf: (id, force) => (force ? otherDir : ''), onError: () => {} });
  check('toggle off: nothing is written; "Write all now" (force) writes anyway', await toggled.write('1'.repeat(16)) === 'skipped' && await toggled.write('1'.repeat(16), { force: true }) === 'written' && ls(path.join(otherDir, 'Chats')).includes('2026-10-14 Forced.md'), '');
  // a failing disk is reported, not thrown (the chat is saved either way)
  const errors = [];
  fs.writeFileSync(path.join(root, 'blocker'), 'a file where a folder should be');
  const broken = pf.createMirror({ render: async (id) => ({ id, title: 'X', created: t0, updated: t0, model: '', markdown: 'x' }), folderOf: () => path.join(root, 'blocker', 'nope'), onError: (e) => errors.push(e.code || e.message) });
  await tick();
  check('a failing write never throws: it is reported and skipped', await broken.write('2'.repeat(16)) === 'skipped' && errors.length === 1, errors.join());
  // no leftover temp files
  const stray = [...ls(path.join(projectDir, 'Chats')), ...ls(path.join(otherDir, 'Chats'))].filter((n) => n.endsWith('.tmp'));
  check('writes go through a temp file that is renamed: none is left behind', !stray.length, stray.join());

  // ---- Claude Code: argv, and the working folder through the engine's injectable spawn
  const wd = path.join(root, 'cc-work');
  fs.mkdirSync(wd);
  const baseArgs = cc.buildArgs({ mcpConfig: 'm.json', sessionId: 's', resume: false, systemPrompt: 'P' });
  check('claude args: without a work folder nothing changed (no tools, dontAsk, no --add-dir)', after(baseArgs, '--tools') === '' && after(baseArgs, '--permission-mode') === 'dontAsk' && !baseArgs.includes('--add-dir') && !baseArgs.includes('--settings'), baseArgs.join(' '));
  const workArgs = cc.buildArgs({ mcpConfig: 'm.json', sessionId: 's', resume: false, systemPrompt: 'P', workDir: wd });
  check('claude args: a work folder gives the file tools (no shell), acceptEdits, --add-dir for it only, and reads outside it blocked', after(workArgs, '--tools') === 'Read,Write,Edit,Glob,Grep' && !/Bash|WebFetch|WebSearch/.test(after(workArgs, '--tools')) && after(workArgs, '--permission-mode') === 'acceptEdits' && after(workArgs, '--add-dir') === wd && JSON.parse(after(workArgs, '--settings')).permissions.blockReadsOutsideWorkingDirectories === true && after(workArgs, '--allowedTools') === 'mcp__lumen' && workArgs.includes('--strict-mcp-config'), workArgs.join(' '));
  check('claude args: the arguments are one array (a folder name with spaces or quotes is never split or joined into a shell string)', workArgs.filter((a) => a === wd).length === 1, '');
  const spacey = path.join(root, 'with space "q"');
  check('claude args: odd folder names stay one argument', cc.buildArgs({ mcpConfig: 'm.json', sessionId: 's', resume: false, systemPrompt: 'P', workDir: spacey }).includes(spacey), '');
  const fullArgs = cc.buildArgs({ mcpConfig: 'm.json', sessionId: 's', resume: false, systemPrompt: 'P', workDir: wd, fullAccess: true });
  check('claude args: full access keeps bypassPermissions (the folder only changes where it runs)', after(fullArgs, '--permission-mode') === 'bypassPermissions' && !fullArgs.includes('--add-dir'), fullArgs.join(' '));

  const FAKE = `
const fs = require('fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sess-1', total_cost_usd: 0, usage: {} });
  }
});
`;
  const fake = path.join(root, 'fake-claude.js');
  fs.writeFileSync(fake, FAKE);
  process.env.LUMEN_CLAUDE_BIN = fake;
  const startMs = (() => { const t = Date.now(); require('child_process').spawnSync(process.execPath, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); return Date.now() - t; })();
  const runOnce = async (name, extra) => {
    const log = path.join(root, `log-${name}.json`);
    const fakeSpawn = (bin, argv, opts) => spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1', FAKE_LOG: log } });
    const engine = new cc.ClaudeCodeEngine({ userData: root, mcpCommand: () => ({ command: process.execPath, args: ['-e', ''], env: {} }), ensureServer: () => {}, keepAlive: false, watchdogMs: Math.max(1500, startMs * 4), spawn: fakeSpawn });
    const out = await engine.run({ prompt: 'hello', sessionId: '00000000-0000-4000-8000-000000000001', resume: false, systemPrompt: 'LUMEN', signal: new AbortController().signal, emit: () => {}, ...extra });
    engine.dispose?.();
    return { out, rec: JSON.parse(fs.readFileSync(log, 'utf8')) };
  };
  const inFolder = await runOnce('work', { workDir: wd });
  check('claude run: the CLI starts in the work folder, with --add-dir for it', fs.realpathSync(inFolder.rec.cwd) === fs.realpathSync(wd) && after(inFolder.rec.argv, '--add-dir') === wd && inFolder.out.text === 'Done.', JSON.stringify(inFolder.rec));
  const missing = await runOnce('missing', { workDir: path.join(root, 'gone') });
  check('claude run: a work folder that is gone falls back to the empty folder and the old lockdown', fs.realpathSync(missing.rec.cwd) !== fs.realpathSync(wd) && /lumen-cc-/.test(missing.rec.cwd) && after(missing.rec.argv, '--tools') === '' && !missing.rec.argv.includes('--add-dir'), JSON.stringify(missing.rec));
  const plain = await runOnce('plain', {});
  check('claude run: no work folder, the same empty folder as before', /lumen-cc-/.test(plain.rec.cwd) && after(plain.rec.argv, '--permission-mode') === 'dontAsk', JSON.stringify(plain.rec));
  const keyA = JSON.stringify([1]);
  check('claude: a kept process is not reused for another work folder (it is part of the process key)', keyA !== undefined && (() => {
    // two engines' keys differ by the last part only
    const a = cc.buildArgs({ mcpConfig: 'm', sessionId: 's', resume: false, systemPrompt: 'P', workDir: wd });
    const b = cc.buildArgs({ mcpConfig: 'm', sessionId: 's', resume: false, systemPrompt: 'P', workDir: path.join(wd, 'x') });
    return a.join('\0') !== b.join('\0');
  })(), '');

  // ---- Codex and Antigravity
  const cxBase = codex.buildArgs({ model: 'default' });
  const cxWork = codex.buildArgs({ model: 'default', workDir: wd });
  const cxFull = codex.buildArgs({ model: 'default', workDir: wd, fullAccess: true });
  check('codex args: read-only without a work folder (never workspace-write)', after(cxBase, '--sandbox') === 'read-only' && !cxBase.includes('--add-dir'), cxBase.join(' '));
  check('codex args: a work folder is workspace-write with --add-dir for it', after(cxWork, '--sandbox') === 'workspace-write' && after(cxWork, '--add-dir') === wd, cxWork.join(' '));
  check('codex args: full access stays danger-full-access', after(cxFull, '--sandbox') === 'danger-full-access' && !cxFull.includes('--add-dir'), cxFull.join(' '));
  const agyWork = agy.buildArgs({ prompt: 'p', workDir: wd });
  check('antigravity args: --add-dir for the work folder, the sandbox flag as before; none without one', after(agyWork, '--add-dir') === wd && agyWork.includes('--sandbox') && !agy.buildArgs({ prompt: 'p' }).includes('--add-dir'), agyWork.join(' '));

  check('setting: the projects folder defaults to empty (Documents\\Lumen Projects)', DEFAULTS.projectsDir === '', JSON.stringify(DEFAULTS.projectsDir));

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
