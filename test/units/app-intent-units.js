// [word] [desktop apps] Which app a conversation is about (src/ai/app-intent.js), how that offers the word / desktop tools (agent.js), and what
// open_app may open with a path (src/desktop/open-file.js, index.js). Plain Node: no Electron, no window, no real app started.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const intent = require('../../src/ai/app-intent');
const { checkOpenFile } = require('../../src/desktop/open-file');
const { createDesktop } = require('../../src/desktop');
const { Agent, requestFor } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const user = (text) => [{ role: 'user', content: text }];
const apps = (messages, opts) => intent.appsFor(messages, opts).apps;
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  // ---- extensions
  check('ext: documents map to their app', intent.appForFile('My Essay.DOCX') === 'word' && intent.appForFile('a.doc') === 'word' && intent.appForFile('x.rtf') === 'word' && intent.appForFile('b.xlsx') === 'excel' && intent.appForFile('c.pptx') === 'powerpoint' && intent.appForFile('d.mlx') === 'matlab' && intent.appForFile('p.sldprt') === 'solidworks', '');
  check('ext: programs and scripts belong to no app', ['a.exe', 'a.bat', 'a.cmd', 'a.ps1', 'a.vbs', 'a.js', 'a.lnk', 'a.msi', 'a.docx.exe', 'noext', ''].every((f) => intent.appForFile(f) === ''), '');
  check('names: what a person calls the app', intent.appForName('Microsoft Word') === 'word' && intent.appForName('word') === 'word' && intent.appForName('Excel') === 'excel' && intent.appForName('PowerPoint') === 'powerpoint' && intent.appForName('Notepad') === '' && intent.appForName('cmd') === '');

  // ---- routing
  check('word: "my essay", "this doc", an attached .docx, a named .doc', ['fix the typos in my essay', 'edit this doc', 'proofread my resume', 'make my cover letter shorter', 'clean up Lab 2 report.docx', 'summarize minutes.doc'].every((t) => apps(user(t)).includes('word')));
  check('word: an ordinary request is not Word', ['Summarize this page', 'what is the word for happy', 'fix the bug in my code', 'find a recipe for pasta', 'open the pdf', 'make a table of prices'].every((t) => !apps(user(t)).length), '');
  check('word: an attached file chip names the app', apps(user('look at this\n<attached_files>\n- {"ref":"f_1","name":"Thesis draft.docx","type":"","size":9}\n</attached_files>')).includes('word'));
  const gdoc = { url: 'https://docs.google.com/document/d/abc/edit', title: 'Essay - Google Docs' };
  check('word: a Google Doc in front is the document tool\'s, not Word\'s', !apps(user('fix the typos in my essay'), { active: gdoc }).length && !apps(user('edit this doc'), { active: gdoc }).length && !apps(user('fix my essay\n<untrusted_page_content title="x" url="https://docs.google.com/document/d/abc/edit">t</untrusted_page_content>')).length);
  check('word: "this document" on an ordinary web page means the page; "my essay" still counts', !apps(user('summarize this document'), { active: { url: 'https://example.com/a', title: 'A' } }).length && apps(user('summarize this document'), { active: { url: 'file:///C:/Users/a/essay.pdf', title: 'essay.pdf' } }).includes('word') && apps(user('fix my essay'), { active: { url: 'https://example.com/a', title: 'A' } }).includes('word'));
  check('word: a .docx open in a Lumen file tab', apps(user('fix the typos'), { active: { url: 'file:///C:/Users/me/Desktop/Essay%20draft.docx', title: 'Essay draft.docx' } }).includes('word'));
  const listed = [{ role: 'user', content: 'what is in my downloads' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'list_files', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Downloads (3):\nLab report 2.docx  14 KB\nbudget.xlsx  9 KB\nnotes.txt' }] }, { role: 'user', content: 'tidy those up' }];
  check('tool results: a list_files result with a .docx and an .xlsx routes both', J(apps(listed).sort()) === J(['excel', 'word']), J(apps(listed)));
  const web = [{ role: 'user', content: 'go on' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'read_page', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Download the syllabus.docx or the grades.xlsx here' }] }];
  check('tool results: a web page that merely links a .docx is not the user\'s file', !apps(web).length, J(apps(web)));
  check('excel / powerpoint / matlab / solidworks by file name', apps(user('add a total row to Budget.xlsx')).includes('excel') && apps(user('shorten slides.pptx')).includes('powerpoint') && apps(user('open model.slx')).includes('matlab') && apps(user('check Bracket.sldprt')).includes('solidworks'));
  check('weak extensions (.csv, .m, .key) do not route alone', !apps(user('summarize data.csv')).length && !apps(user('what does main.m do')).length && !apps(user('rotate server.key')).length, J([apps(user('summarize data.csv')), apps(user('what does main.m do'))]));
  check('word and the others stay apart: Word never asks for desktop, Excel never for word', !intent.wantsDesktop(user('fix my essay')) && intent.wantsWord(user('fix my essay')) && intent.wantsDesktop(user('edit Budget.xlsx')) && !intent.wantsWord(user('edit Budget.xlsx')));

  // ---- the agent offers the tools
  const offerWord = (m, browser = {}) => new Agent(browser).wordOffered(m);
  const offerDesk = (m, browser = {}) => new Agent(browser).desktopOffered(m);
  check('offer: word for "fix my essay", a listed .docx; not for chat', offerWord(user('fix the typos in my essay')) && offerWord(listed) && !offerWord(user('what is the capital of France')));
  check('offer: desktop for a .xlsx / .pptx file, still not for chat or Word documents', offerDesk(user('add a sheet to Budget.xlsx')) && offerDesk(user('edit deck.pptx')) && !offerDesk(user('what is the capital of France')) && !offerDesk(user('fix my essay')));
  check('offer: a Google Doc in front keeps Word out of it; a .docx file tab brings it in', !offerWord(user('fix my essay'), { listTabs: () => [{ id: 1, active: true, url: gdoc.url, title: gdoc.title }] }) && offerWord(user('fix the typos'), { listTabs: () => [{ id: 1, active: true, url: 'file:///C:/a/Essay.docx', title: 'Essay.docx' }] }) && !offerWord(user('fix the typos'), { listTabs: () => { throw new Error('no window'); } }));
  const settings = { model: 'claude-sonnet-4-6' };
  const def = (name, flags) => requestFor(settings, user('hi'), undefined, flags).tools.find((t) => t.name === name);
  const wd = def('word', { word: true }).description;
  const dd = def('desktop', { desktop: true }).description;
  check('prompt: the word tool says to prefer it for a docx and to open it in Word; desktop mentions path; both stay under the 420-character description budget', /\.docx/.test(wd) && /open/i.test(wd) && /path/.test(dd) && wd.length < 420 && dd.length < 420, `${wd.length} ${dd.length}`);
  check('prompt: the default request pays nothing (neither tool listed)', !def('word', {}) && !def('desktop', {}));

  // ---- Settings > AI > Work on files in their apps (aiFilesInApps)
  const modeOf = (m) => ({ filesInApps: () => m });
  const csv = user('summarize data.csv and main.m');
  check('apps setting: automatic is the existing behaviour (a .csv or .m alone is not routed; Excel files are)', !offerDesk(csv, modeOf('auto')) && !offerDesk(csv, modeOf('nonsense')) && !offerDesk(csv, {}) && offerDesk(user('edit Budget.xlsx'), modeOf('auto')));
  check('apps setting: "in the app" also offers desktop for a .csv or .m (never a .key), still not for chat', offerDesk(csv, modeOf('app')) && offerDesk(user('open data.csv'), modeOf('app')) && !offerDesk(user('rotate server.key'), modeOf('app')) && !offerDesk(user('what is the capital of France'), modeOf('app')) && J(apps(csv, { weak: true }).sort()) === J(['excel', 'matlab']));
  check('apps setting: "in the app" keeps word offered for a .docx; the Word-only rules are unchanged', offerWord(user('fix my essay'), modeOf('app')) && !offerDesk(user('fix my essay'), modeOf('app')));
  check('apps setting: "from the file" never routes a file to desktop, but a plain request for an app, or the master switch, still offers it', !offerDesk(user('edit Budget.xlsx'), modeOf('file')) && !offerDesk(user('edit deck.pptx'), modeOf('file')) && offerDesk(user('open it in Excel'), modeOf('file')) && offerDesk(user('hello'), { filesInApps: () => 'file', desktopAccess: () => true }));
  check('apps setting: "from the file" still offers word for a .docx (its file route reads and edits the file)', offerWord(user('fix the typos in my essay.docx'), modeOf('file')));
  const noteOf = (name, mode, flags) => requestFor(settings, user('hi'), undefined, { ...flags, filesInApps: mode }).tools.find((t) => t.name === name).description;
  const base = { word: def('word', { word: true }).description, desktop: def('desktop', { desktop: true }).description };
  check('apps setting prompt: automatic adds nothing to either tool', noteOf('word', 'auto', { word: true }) === base.word && noteOf('desktop', 'auto', { desktop: true }) === base.desktop && noteOf('word', undefined, { word: true }) === base.word);
  check('apps setting prompt: app and file add one short sentence each (under 120 characters) to the tool that is offered', ['app', 'file'].every((m) => ['word', 'desktop'].every((n) => { const d = noteOf(n, m, { [n]: true }); return d.startsWith(base[n]) && d.length - base[n].length > 20 && d.length - base[n].length < 120; })));
  check('apps setting prompt: the sentences say what the choice is', /in Word/.test(noteOf('word', 'app', { word: true })) && /do not open Word/.test(noteOf('word', 'file', { word: true })) && /open_app path.*read_app/.test(noteOf('desktop', 'app', { desktop: true })) && /do not open files in apps/.test(noteOf('desktop', 'file', { desktop: true })));
  check('tokens: the word and desktop descriptions are shorter than before (414 and 408 characters on main) and say to read text, not pictures', base.word.length <= 410 && base.desktop.length <= 370 && /read only what you need/.test(base.word) && /Prefer read_app to screenshot_app/.test(base.desktop), `${base.word.length} ${base.desktop.length}`);
  check('word tool: the description says to edit in place, not with scripts, and stays under the 420-character budget', /in place/.test(base.word) && /scripts/.test(base.word) && base.word.length <= 420, String(base.word.length));
  check('apps setting prompt: "in the app" says to edit in place in Word, never the file', /in Word.*in place/.test(noteOf('word', 'app', { word: true })));

  // ---- the CLI engines (Claude Code, Codex, Grok Build, Antigravity): the word tool and one rule, only on Word intent
  {
    const mkAgent = (mode) => new Agent({ filesInApps: () => mode });
    const run = (agent, chat, fn) => agent.inScope({ chat, gate: {}, signal: new AbortController().signal }, fn);
    const withWord = user('fix the typos in my essay.docx');
    const chatA = { settings: {} };
    const a = mkAgent('auto');
    const noteA = run(a, chatA, () => a.cliWordNote(withWord));
    check('cli: Word intent adds the one-line rule (word tool, in Word, in place, no scripts or new files unless asked) and marks the chat', /word tool/.test(noteA) && /edit in place/.test(noteA) && /read only what the edit needs/.test(noteA) && /do not re-read/.test(noteA) && /Never write scripts or new files/.test(noteA) && noteA.split(String.fromCharCode(10)).filter(Boolean).length === 1 && chatA.cliWord === true, noteA);
    const chatB = { settings: {} };
    check('cli: no Word intent, no rule and no tool', run(a, chatB, () => a.cliWordNote(user('what is the capital of France'))) === '' && chatB.cliWord === undefined && a.cliWordToolDefs(chatB).length === 0);
    check('cli: the chat session lists the word tool once marked (a trimmed definition; an unmarked chat or an outside client gets nothing)', a.cliWordToolDefs(chatA).length === 1 && a.cliWordToolDefs(chatA)[0].name === 'word' && !a.cliWordToolDefs(null).length && !a.cliWordToolDefs({}).length);
    check('cli: once marked the tool stays for later messages in the chat', run(a, chatA, () => a.cliWordNote(user('thanks, now shorten it'))) !== '');
    const f = mkAgent('file');
    const noteF = run(f, { settings: {} }, () => f.cliWordNote(withWord));
    check('cli: "from the file" tells the engine to use the word tool with the path, not to open Word', /file path/.test(noteF) && !/open the file in Word/.test(noteF) && /Never write scripts/.test(noteF), noteF);
    check('cli: the rule is small (under 260 characters) and the listing carries the setting sentence', noteA.trim().length < 260 && /Setting:/.test(mkAgent('app').cliWordToolDefs({ cliWord: true })[0].description) && !/Setting:/.test(a.cliWordToolDefs(chatA)[0].description));
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
    check('cli: the shared tool list is untouched (the word tool is a per-run extra: ai-agents.js runTools, main.js wordTools)', !require('../../src/ai/agent').EXTERNAL_TOOLS.some((t) => t.name === 'word') && read('src/features/ai-agents.js').includes('deps.wordTools?.(chat)') && read('src/main.js').includes('wordTools: (chat) => agent.cliWordToolDefs(chat)') && read('src/ai/agent.js').includes('this.cliWordNote(messages)'));
  }
  check('apps setting prompt: nothing is added when the tool is not offered', !requestFor(settings, user('hi'), undefined, { filesInApps: 'app' }).tools.some((t) => t.name === 'word' || t.name === 'desktop'));

  // ---- open_app path checks
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-appintent-'));
  const home = path.join(root, 'home');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.mkdirSync(profile);
  const mkfile = (rel, text = 'x') => { const f = path.join(home, rel); fs.writeFileSync(f, text); return f; };
  const essay = mkfile('Documents/Essay.docx');
  const sheet = mkfile('Documents/Budget.xlsx');
  const exe = mkfile('Documents/setup.exe');
  const bat = mkfile('Documents/run.bat');
  const hidden = mkfile('.ssh/notes.docx');
  const prof = path.join(profile, 'Cookies.docx'); fs.writeFileSync(prof, 'x');
  const envf = mkfile('Documents/.env');
  const opts = { home, profile };
  const r1 = checkOpenFile(essay, { ...opts, name: 'Word' });
  check('path: an existing .docx in a normal folder passes, with the owning app', r1.app === 'word' && r1.label === 'Word' && fs.realpathSync(essay) === r1.file, J(r1));
  check('path: the name can be left out; "~/..." and a bare relative path resolve under the home folder', checkOpenFile('~/Documents/Budget.xlsx', opts).app === 'excel' && checkOpenFile('Documents/Essay.docx', opts).app === 'word');
  const bad = (p, o = {}) => { try { checkOpenFile(p, { ...opts, ...o }); return null; } catch (e) { return e.message; } };
  check('path: programs and scripts are refused (.exe, .bat), however they are named', /not opened/.test(bad(exe)) && /not opened/.test(bad(bat)) && /not opened/.test(bad(path.join(home, 'Documents/a.lnk'))));
  check('path: the credentials folders, Lumen\'s profile and .env files are refused', /credentials/.test(bad(hidden)) && /profile/.test(bad(prof)) && bad(envf) !== null);
  check('path: a missing file, a folder, an empty path, a network path are refused', /does not exist/.test(bad(path.join(home, 'Documents/none.docx'))) && bad(path.join(home, 'Documents')) !== null && bad('') !== null && bad('\\\\server\\share\\a.docx') !== null, '');
  check('path: the named app must own the file (an Excel file is not opened in Word, Notepad is not an app for it)', /belongs to Excel/.test(bad(sheet, { name: 'Word' })) && /belongs to Word/.test(bad(essay, { name: 'Notepad' })) && bad(essay, { name: 'cmd' }) !== null);
  try {
    fs.symlinkSync(exe, path.join(home, 'Documents/innocent.docx'));
    check('path: a "docx" that is a link to a program is refused', /link to a different kind/.test(bad(path.join(home, 'Documents/innocent.docx'))), bad(path.join(home, 'Documents/innocent.docx')));
  } catch { /* no symlink right on this machine */ }
  try {
    fs.symlinkSync(path.join(home, '.ssh/notes.docx'), path.join(home, 'Documents/sneaky.docx'));
    check('path: a link into ~/.ssh is judged by where it goes', /credentials/.test(bad(path.join(home, 'Documents/sneaky.docx'))));
  } catch { /* no symlink right on this machine */ }

  // ---- open_app through the controller, with a stand-in helper
  const WORDX = 'C:\\Office\\WINWORD.EXE';
  const calls = [];
  const wins = [];
  const found = [{ key: 'k1', name: 'Word', exe: WORDX, exact: true }];
  const client = { call: async (cmd, args = {}) => { calls.push([cmd, args]); if (cmd === 'apps') return { ok: true, apps: wins }; if (cmd === 'resolve') return { ok: true, found }; if (cmd === 'launch') { wins.push({ hwnd: 100, pid: 10, proc: 'WINWORD', title: 'Essay.docx - Word', exe: WORDX, description: 'Microsoft Word', start: 1010 }); return { ok: true }; } if (cmd === 'tree') return { ok: true, tree: { t: 'ControlType.Window', n: 'Essay', i: 'e1', c: [] } }; return { ok: true }; }, abort() {}, destroy() {} };
  const asked = [];
  const ctx = { emit() {}, signal: new AbortController().signal, once: new Set(), tainted: () => false, ask: async (card) => { asked.push(card); return true; } };
  const quiet = { ok: true, cursor: () => ({ x: 0, y: 0 }), pidUnderCursor: () => 0, foregroundPid: () => 0, escapeDown: () => false, mouseDown: () => false, typing: () => false };
  const rig = (extra = {}) => createDesktop({ client, settings: { master: () => true, terminals: () => false, allowed: () => [], allow() {}, setMaster() {} }, banner: { async show() {}, async update() {}, hide() {} }, winapi: quiet, platform: 'win32', stopRun() {}, icon: async () => null, shortcut: { register() {}, unregister() {} }, lumen: { pid: 4242, exe: 'C:\\Lumen\\Lumen.exe' }, openWaitMs: 200, profile, ...extra });
  // (the temp home stands in for the user's: the controller's own check reads the real one)
  const d2 = rig({ checkOpenFile: (p, o) => checkOpenFile(p, { ...o, home }) });
  const out = await d2.run({ action: 'open_app', args: { path: essay } }, ctx);
  const launch = calls.find((c) => c[0] === 'launch');
  check('open_app path: Word is found by the file\'s owner (no name needed), the helper gets the checked file, the app card names the file', /Opened Microsoft Word/.test(out) && launch && launch[1].key === 'k1' && launch[1].file === fs.realpathSync(essay) && asked.length === 1 && /Essay\.docx/.test(JSON.stringify(asked[0])), J([out.slice(0, 80), launch, asked.map((a) => a.title)]));
  calls.length = 0;
  const m1 = await rejects(() => d2.run({ action: 'open_app', args: { name: 'Word', path: exe } }, ctx));
  const m2 = await rejects(() => d2.run({ action: 'open_app', args: { name: 'Word', path: hidden } }, ctx));
  check('open_app path: a program or a credentials folder file is refused before anything is resolved or started', m1 && m2 && !calls.some((c) => c[0] === 'launch' || c[0] === 'resolve'), J([m1, m2, calls.map((c) => c[0])]));
  const m3 = await rejects(() => rig().run({ action: 'open_app', args: { name: 'Word', path: path.join(os.homedir(), 'definitely-not-here-4242.docx') } }, ctx));
  check('open_app path: the real file rules apply by default (a missing file is refused)', /does not exist/.test(String(m3)), m3);
  const src = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  check('helpers: the file is one argument, never through a shell (Windows: Start-Process -ArgumentList of one quoted string; macOS: open -a app -- file)', /Start-Process -FilePath \$path -ArgumentList \('"' \+ \$file/.test(src('src/desktop/uia-helper.ps1')) && /\['-a', key, '--', file\]/.test(src('src/desktop/mac-client.js')) && !/shell\s*:\s*true/.test(src('src/desktop/mac-client.js')));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
