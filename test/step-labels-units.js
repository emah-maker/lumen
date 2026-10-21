// Plain Node: the readable line of each step of the AI's work (renderer/step-labels.js): the tool's own description first, a humanized
// label per tool, a summary of a shell command (never the raw command), grouping, failure phrasing and truncation.
const fs = require('fs');
const path = require('path');
const sl = require('../src/renderer/step-labels');
const L = sl.defaults;

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const eq = (label, got, want) => check(label, got === want, `${JSON.stringify(got)} !== ${JSON.stringify(want)}`);
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const en = JSON.parse(read('src/locales/en.json'));
const bash = (command, name = 'Bash') => L.label(name, { command });

// ---- description wins
eq('Bash description is the line', L.label('Bash', { command: 'rm -rf x', description: 'Clean the build folder' }), 'Clean the build folder');
eq('PowerShell description is the line', L.label('PowerShell', { command: 'Get-ChildItem', description: 'List the report pages.' }), 'List the report pages');
eq('Task description', L.label('Task', { description: 'Find the failing test', prompt: 'long' }), 'Find the failing test');
eq('Agent description', L.label('Agent', { description: 'Survey the repo' }), 'Survey the repo');
eq('Task without a description', L.label('Task', {}), 'Running a helper');
check('a long description is cut to about 70 characters', L.label('Bash', { command: 'x', description: 'word '.repeat(60) }).length <= 70, L.label('Bash', { command: 'x', description: 'word '.repeat(60) }));

// ---- per-tool labels
eq('Read shows the file name only', L.label('Read', { file_path: 'C:\\Users\\emah\\AppData\\Local\\Temp\\p1.png' }), 'Reading p1.png');
eq('Read with a posix path', L.label('Read', { file_path: '/home/me/notes/todo.md' }), 'Reading todo.md');
eq('Write', L.label('Write', { file_path: 'C:/a/b/report.docx' }), 'Writing report.docx');
eq('Edit', L.label('Edit', { file_path: '/a/b/main.js' }), 'Editing main.js');
eq('MultiEdit', L.label('MultiEdit', { file_path: '/a/b/main.js' }), 'Editing main.js');
eq('NotebookEdit', L.label('NotebookEdit', { notebook_path: '/a/lab.ipynb' }), 'Editing lab.ipynb');
eq('Grep with a folder', L.label('Grep', { pattern: 'TODO', path: 'C:/proj/src' }), 'Searching for ‘TODO’ in src');
eq('Glob without a folder', L.label('Glob', { pattern: '**/*.js' }), 'Searching for ‘**/*.js’');
eq('WebFetch shows the host', L.label('WebFetch', { url: 'https://www.example.com/a/very/long/path?q=1' }), 'Reading example.com');
eq('WebSearch', L.label('WebSearch', { query: 'electron 44 release notes' }), 'Searching the web for ‘electron 44 release notes’');
eq('TodoWrite', L.label('TodoWrite', { todos: [] }), 'Updating the plan');
eq('Skill', L.label('Skill', { skill: 'pdf' }), 'Using the pdf skill');
eq('another MCP server\'s tool: the server, never the raw tool name', L.label('mcp__github__create_issue', {}), 'Using github');
check('no label carries a raw tool name', !/create_issue|create issue/.test(L.label('mcp__github__create_issue', {})), '');
eq('a Lumen MCP tool has no label here (the UI names it)', L.label('mcp__lumen__navigate', { url: 'https://youtube.com' }), '');
eq('a shell tool with no command', L.label('PowerShell', {}), 'Using PowerShell');
eq('Read without a path', L.label('Read', {}), 'Reading a file');

// ---- shell commands: the ones from the report's screenshot first
const SCREENSHOT = [
  ['cd "C:/Users/emah/AppData/Local/Temp" && powershell -NoProfile -File pdf2png.ps1', 'Running pdf2png.ps1'],
  ['cd "C:/Users/emah/AppData/Local/Temp" && sed -i \'s/$t=[System.WindowsRuntimeSystemExtensions]/x/\' render.ps1', 'Editing render.ps1'],
  ['cat > "C:/Users/emah/AppData/Local/Temp/fmt.ps1" <<\'EOF\'\n$path=1\nEOF', 'Writing fmt.ps1'],
  ['cd "C:/Users/emah/OneDrive/School" && sed -i \'s/Mech of Mats Lab 1\\.docx"$/Mech Lab 1.docx"/\' "C:/Users/emah/OneDrive/School/index.txt"', 'Editing index.txt'],
];
for (const [cmd, want] of SCREENSHOT) eq(`screenshot: ${cmd.slice(0, 50).replace(/\n/g, ' ')}…`, bash(cmd), want);
const MORE = [
  ['python script.py', 'Running script.py'],
  ['python3 -u C:/tools/convert.py --in a.pdf', 'Running convert.py'],
  ['node scripts/build/build.js', 'Running build.js'],
  ['npm test', 'Running tests'],
  ['npm run test:units', 'Running tests'],
  ['npm run lint', 'Checking code style'],
  ['npm ci --ignore-scripts', 'Installing packages'],
  ['pnpm install', 'Installing packages'],
  ['npx eslint src', 'Running eslint'],
  ['pytest -q tests/', 'Running tests'],
  ['git status --short', 'Checking git status'],
  ['git diff HEAD~1', 'Comparing changes'],
  ['cd repo && git commit -m "fix it"', 'Committing changes'],
  ['git push -u origin feat/x', 'Pushing to GitHub'],
  ['gh pr create --title "x" --body "y"', 'Using GitHub: pr create'],
  ['ls -la src/renderer', 'Listing renderer'],
  ['cat package.json', 'Reading package.json'],
  ['head -n 20 /var/log/syslog', 'Reading syslog'],
  ['grep -rn "TODO" src', 'Searching for ‘TODO’'],
  ['rm -rf node_modules', 'Deleting node_modules'],
  ['mkdir -p out/reports', 'Creating reports'],
  ['cp report.docx backup/report.docx', 'Copying report.docx'],
  ['curl -s https://api.github.com/repos/x/y', 'Downloading from api.github.com'],
  ['powershell -NoProfile -Command "Get-ChildItem C:/x -Recurse | Measure-Object"', 'Listing x'],
  ['sleep 5', 'Waiting'],
  ['echo done', 'Printing a message'],
  ['./deploy.sh --fast', 'Running deploy.sh'],
  ['cargo build --release', 'Building the project'],
  ['pdftoppm -png -r 80 report.pdf out/page', 'Processing page'],
  ['frobnicate --now', 'Running frobnicate'],
];
for (const [cmd, want] of MORE) eq(`command: ${cmd.slice(0, 60)}`, bash(cmd), want);
check('at least 25 real-world commands covered', SCREENSHOT.length + MORE.length >= 25, String(SCREENSHOT.length + MORE.length));
check('no summary shows a raw path beyond a file name', [...SCREENSHOT, ...MORE].every(([cmd]) => !/[\\/]/.test(bash(cmd).replace(/‘[^’]*’/g, ''))), '');
check('a summary never exceeds 70 characters', bash(`python ${'a'.repeat(200)}.py`).length <= 70 && bash(`cat > ${'b'.repeat(200)}.txt <<EOF\nx\nEOF`).length <= 70, bash(`python ${'a'.repeat(200)}.py`));
check('the raw command is never the line', !/&&|<<|\$\(|\|\|/.test(bash('cd /x && foo.sh && bar | baz')), bash('cd /x && foo.sh && bar | baz'));
eq('PowerShell tool with a command', bash('Get-Content C:/x/notes.txt', 'PowerShell'), 'Reading notes.txt');

// ---- grouping
const g = (name, input) => L.groupInfo(name, input, L.label(name, input));
const r1 = g('Read', { file_path: 'C:/t/p1.png' });
const r2 = g('Read', { file_path: 'C:/t/p2.png' });
const r3 = g('Read', { file_path: 'C:/other/notes.md' });
check('reads in one folder share a key', r1.key === r2.key && r1.key !== r3.key, JSON.stringify([r1, r2, r3]));
eq('four page images read: "Read 4 pages"', L.groupLabel(r1, 4, ''), 'Read 4 pages');
eq('four other files read: "Read 4 files"', L.groupLabel(r3, 4, ''), 'Read 4 files');
const s1 = g('PowerShell', {});
eq('generic shell steps group as "Used PowerShell 3 times"', L.groupLabel(s1, 3, ''), 'Used PowerShell 3 times');
check('a described shell step is not grouped by tool', g('Bash', { command: 'x', description: 'Render pages' }).kind === 'same', JSON.stringify(g('Bash', { command: 'x', description: 'Render pages' })));
check('different tools never share a key', g('Edit', { file_path: 'a.js' }).key !== g('Write', { file_path: 'a.js' }).key, '');
// searches in a burst are one row
const ws = (q) => L.groupInfo('web_search', { query: q }, `Searching the web for “${q}”`);
check('web searches share one group key whatever they ask', ws('a').key === ws('b').key && ws('a').kind === 'search', JSON.stringify([ws('a'), ws('b')]));
check('the engines\' names group too (WebSearch, mcp__lumen__web_search), sources and pages each in their own group', L.groupInfo('WebSearch', { query: 'x' }, 'x').key === ws('a').key && L.groupInfo('mcp__lumen__web_search', { query: 'x' }, 'x').key === ws('a').key && L.groupInfo('find_sources', {}, 'x').key !== ws('a').key && L.groupInfo('read_urls', {}, 'x').key !== L.groupInfo('find_sources', {}, 'x').key, '');
eq('running: "Searching the web · 2 searches"', L.groupLabel(ws('a'), 2, '', true), 'Searching the web · 2 searches');
eq('done: "Searched the web · 2 searches"', L.groupLabel(ws('a'), 2, '', false), 'Searched the web · 2 searches');
eq('three searches done', L.groupLabel(ws('a'), 3, '', false), 'Searched the web · 3 searches');
eq('one search (the singular)', L.groupLabel(ws('a'), 1, '', false), 'Searched the web · 1 search');
eq('sources: "Searching sources · 2 searches"', L.groupLabel(L.groupInfo('find_sources', {}, 'x'), 2, '', true), 'Searching sources · 2 searches');
eq('pages: "Read pages · 2 pages"', L.groupLabel(L.groupInfo('read_urls', {}, 'x'), 2, '', false), 'Read pages · 2 pages');
check('the group strings use {n} and the one / other pair', ['web', 'sources', 'urls'].every((w) => ['running', 'done'].every((st) => ['one', 'other'].every((pl) => /\{n\}/.test(en[`step.group.${w}.${st}.${pl}`] || '')))), '');
eq('the same step again: a count', L.groupLabel(g('Edit', { file_path: '/a/main.js' }), 3, 'Editing main.js'), 'Editing main.js ×3');

// ---- failures
const f1 = L.failure('Read', { file_path: 'C:\\Users\\emah\\AppData\\Local\\Temp\\p2.png' }, 'Image file is empty: C:\\Users\\emah\\AppData\\Local\\Temp\\p2.png');
eq('failed read: plain sentence', `${f1.text}: ${f1.why}`, "Couldn't read p2.png: the file was empty");
const f2 = L.failure('Bash', { command: 'python missing.py' }, "python: can't open file 'C:\\x\\missing.py': [Errno 2] No such file or directory");
eq('failed command names what ran', f2.text, "Couldn't run missing.py");
eq('a missing file says so', f2.why, "it wasn't found");
eq('exit code', L.failure('Bash', { command: 'npm test' }, 'Exit code 1\nFAIL x').why, 'it exited with code 1');
eq('permission', L.failure('Write', { file_path: '/etc/x' }, 'EACCES: permission denied, open').why, 'permission was denied');
eq('timeout', L.failure('WebFetch', { url: 'https://a.com' }, 'Request timed out after 30s').why, 'it timed out');
check('an unknown error is cut and carries no full path', (() => { const w = L.failure('Bash', { command: 'x.sh' }, `Something odd happened in C:\\Users\\emah\\deep\\folder\\file.txt ${'blah '.repeat(40)}`).why; return w.length <= 60 && !/Users/.test(w); })(), '');
eq('a failed step with a description keeps it', L.failure('Bash', { command: 'x', description: 'Render the PDF' }, 'boom').text, "Render the PDF didn't finish");
eq('no error text: no reason', L.failure('Read', { file_path: 'a.txt' }, '').why, '');

// ---- every verb has its own whole sentence (no verb + rest builder)
check('the failure sentence is not built from pieces', !('step.failed' in en) && Object.keys(en).filter((k) => /^step\.failed\./.test(k)).every((k) => /\{what\}|\{label\}/.test(en[k])), '');
eq('failed search', L.failure('Grep', { pattern: 'x', path: '/a/src' }, 'boom').text, "Couldn't search for ‘x’ in src");
eq('failed download', L.failure('Bash', { command: 'curl -s https://a.com/x' }, 'boom').text, "Couldn't download from a.com");
eq('failed install', L.failure('Bash', { command: 'npm ci' }, 'boom').text, "Couldn't install packages");

// ---- secrets are masked before a command is shown or saved
const SECRETS = [
  ['curl -H "Authorization: Bearer abc123def456ghi" https://x.com', /abc123def456/],
  ['psql -U me --password hunter2 db', /hunter2/],
  ['export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx && gh pr list', /ghp_abcdef/],
  ['$env:API_KEY = "s3cretValue"; run.ps1', /s3cretValue/],
  ['git clone https://me:pw123456@github.com/a/b', /pw123456/],
  ['Connect-Thing -Password "my pass" -User bob', /my pass/],
  ['echo sk-abcdefghijklmnop', /sk-abcdefghijkl/],
  ['aws s3 ls --secret-access-key=AKIAABCDEFGHIJKLMNOP', /AKIAABCDEFGH/],
];
for (const [cmd, leak] of SECRETS) check(`redact: ${cmd.slice(0, 48)}`, !leak.test(sl.redact(cmd)) && sl.redact(cmd).includes('••••'), sl.redact(cmd));
eq('a command without secrets is unchanged', sl.redact('npm test -- --grep auth-flow'), 'npm test -- --grep auth-flow');
check('the saved input is masked', !/hunter2/.test(JSON.stringify(sl.compactInput('Bash', { command: 'tool --password hunter2', description: 'Sign in' }))), '');
check('text typed into a page is never saved', sl.compactInput('type_text', { text: 'my-password', tab_id: 3 }).text === undefined, '');

// ---- task names
eq('task name drops politeness and articles', L.taskName('Can you please find the lab TA on Canvas for me?'), 'Find lab TA');
eq('a short request stays', L.taskName('Open youtube'), 'Open youtube');
eq('empty', L.taskName(''), '');

// ---- saved input is bounded
check('compactInput keeps the naming fields and bounds them', (() => { const c = sl.compactInput('Bash', { command: 'x'.repeat(5000), description: 'd', timeout: 5, other: { deep: 1 } }); return c.command.length <= 600 && c.description === 'd' && !('other' in c) && !('timeout' in c); })(), '');

// ---- a tool with no line of its own: its name in plain words and its main argument, never "Using a tool"
eq('ToolSearch with its query', L.generic('ToolSearch', { query: 'calendar' }), 'Looking up a tool: calendar');
eq('a Lumen tool with no special line', L.generic('mcp__lumen__list_files', { folder: 'downloads' }), 'Looking at files: downloads');
eq('an unknown name is humanized', L.generic('SomethingNew', {}), 'Using something new');
eq('an unknown snake_case name with a path argument', L.generic('mcp__x__do_the_thing', { path: 'C:\\a\\b\\notes.txt' }), 'Using do the thing: notes.txt');
eq('no name at all is the last resort', L.generic('', {}), 'Using a tool');
const cc = require('../src/ai/claude-code');
check('Claude Code: an early row for a tool with no early label is not generic', cc.earlyLabel('list_tabs') === 'Listing the open tabs' && cc.earlyLabel('document') === 'Working on the document', cc.earlyLabel('list_tabs'));
check('Claude Code: its own tools get plain labels', cc.builtinLabel('ToolSearch', { query: 'x' }) === 'Looking up a tool: x' && cc.builtinLabel('TaskStop', {}) === 'Stopping a task', cc.builtinLabel('TaskStop', {}));

// ---- a skill's message never shows its <skill_request> markup
{
  const wrapped = (name, title, input, body = 'Do the research.\nUse the page.') => `<skill_request name="${name}" title="${title}" input="${input}">\n${body}\n</skill_request>`;
  const full = wrapped('research', 'Research', 'cats &#38; dogs');
  const forms = [full, full.slice(0, 60), full.slice(0, 31), '<skill_request name="research" …', `${full} and then more`, `before ${full.slice(0, 45)}…`, '</skill_request>'];
  const none = (label, v) => check(label, !/skill_request/.test(String(v)), JSON.stringify(v));
  eq('skillText: a whole message reads "Title skill: what was typed"', sl.skillText(full), 'Research skill: cats & dogs');
  eq('skillText: a cut-off tag still reads as the skill', sl.skillText('<skill_request name="research" …'), 'Research skill');
  eq('skillText: a tag cut inside the input keeps the words typed so far', sl.skillText('<skill_request name="research" title="Research" input="how do axol'), 'Research skill: how do axol');
  eq('skillText: no input -> just the skill', sl.skillText(wrapped('translate', 'Translate', '')), 'Translate skill');
  eq('skillText: text around the tag stays', sl.skillText(`Hi ${wrapped('x', 'X', 'y')} bye`), 'Hi X skill: y bye');
  eq('skillText: plain text is untouched', sl.skillText('Summarize this page'), 'Summarize this page');
  for (const f of forms) {
    none(`label clip: ${f.slice(0, 24)}…`, L.label('Task', { description: f }));
    none(`failure text: ${f.slice(0, 24)}…`, L.failure('Bash', { command: 'x' }, f).text);
    none(`taskName: ${f.slice(0, 24)}…`, L.taskName(f));
    none(`clip: ${f.slice(0, 24)}…`, sl.clip(f));
    none(`chat title: ${f.slice(0, 24)}…`, require('../src/features/chat-title').autoTitle({ messages: [{ role: 'user', content: [{ type: 'text', text: f }] }] }));
    none(`saved title: ${f.slice(0, 24)}…`, require('../src/features/chat-title').cleanSaved(f));
  }
  eq('taskName: the card subtitle is what was asked, not the tag', L.taskName(full), 'Cats & dogs');
  eq('chat title: a skill chat is titled by the skill and its input', require('../src/features/chat-title').autoTitle({ messages: [{ role: 'user', content: [{ type: 'text', text: full }] }] }), 'Research skill: cats & dogs');
  eq('saved title: an old title with the tag is made readable', require('../src/features/chat-title').cleanSaved('<skill_request name="research" title="Research" input="cats'), 'Research skill: cats');
  const { createChatStore } = require('../src/features/chat-store');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-search-'));
  const enc = (x) => Buffer.from(x).toString('base64');
  const dec = (x) => Buffer.from(x, 'base64').toString();
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec });
  const saved = { id: store.newId() };
  store.save(saved.id, { messages: [{ role: 'user', content: [{ type: 'text', text: wrapped('research', 'Research', 'axolotl habitats', 'PROMPTBODY') }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
  const hit = store.search('axolotl');
  check('search: what was typed after a skill is found', hit.length === 1 && hit[0].id === saved?.id, JSON.stringify(hit));
  check('search: the skill prompt and its tag are not searchable text', store.search('PROMPTBODY').length === 0 && store.search('skill_request').length === 0, '');
  check('the list shows the readable title', (store.list()[0]?.title || '') === 'Research skill: axolotl habitats', store.list()[0]?.title);
  fs.rmSync(dir, { recursive: true, force: true });
  check('en.json has the skill label strings', en['skill.label'] === '{title} skill: {input}' && en['skill.label.bare'] === '{title} skill', '');
  check('the chat shows a cut-off skill tag as words too (renderer/skills.js)', /skillText\?\.\(text\)/.test(read('src/renderer/skills.js')), '');
}

// ---- wiring
const page = read('src/renderer/chat-page.html');
const core = read('src/renderer/chat-core.js');
check('the full-page chat lists step-labels.js and step-ui.js before chat-core.js', page.indexOf('<script src="step-labels.js">') > -1 && page.indexOf('<script src="step-labels.js">') < page.indexOf('<script src="step-ui.js">') && page.indexOf('<script src="step-ui.js">') < page.indexOf('<script src="chat-core.js">') && /step-ui.css/.test(page), '');
check('the sidebar loads them after its start-up bundle (not inside it), and a step before then gets a plain row', !/step-ui|step-labels/.test(read('src/renderer/index.src.html')) && core.includes("script('step-labels.js')") && core.includes("script('step-ui.js')") && /function plainStep/.test(core), '');
const used = new Set([...read('src/renderer/step-labels.js').matchAll(/\bT?\(?'((?:step|card)\.[\w.]+)'/g)].map((m) => m[1]));
check('every step.* key the labeller uses is in en.json', [...used].every((k) => k in en), [...used].filter((k) => !(k in en)).join(','));

// ---- the card at the first step, and the background-reading line
eq('a web search starts a "web" card (browser look, no preview)', sl.weakSurfaceOf('web_search'), 'web');
eq('WebSearch (an engine) too', sl.weakSurfaceOf('WebSearch'), 'web');
eq('read_urls through the Lumen MCP too', sl.weakSurfaceOf('mcp__lumen__read_urls'), 'web');
eq('any other tool starts a "tool" card', sl.weakSurfaceOf('ToolSearch'), 'tool');
eq('a tool with no name too', sl.weakSurfaceOf(''), 'tool');
eq('the same host twice is named once, with the page count', sl.readUrlsLabel(['www.youtube.com', 'www.youtube.com']), 'Reading 2 pages on youtube.com in the background');
eq('one page', sl.readUrlsLabel(['https://www.youtube.com/watch?v=1']), 'Reading youtube.com in the background');
eq('hosts are not repeated', sl.readUrlsLabel(['https://a.com/1', 'https://b.com/2', 'https://a.com/3']), 'Reading a.com, b.com in the background');
eq('many sites are summed up', sl.readUrlsLabel(['a.com', 'b.com', 'c.com', 'd.com']), 'Reading a.com, b.com and 2 more sites in the background');
eq('signed in is said', sl.readUrlsLabel(['a.com'], true), 'Reading a.com in the background (signed in, if you allow it)');
check('the card title for a step on no surface is in en.json', 'card.tool' in en, '');
const ui0 = read('src/renderer/step-ui.js');
check('step-ui starts the card at the first step of any kind (weakSurfaceOf), and agent.js uses the deduped line', /weakSurfaceOf\(event\.name\)/.test(ui0) && /readUrlsLabel\(/.test(read('src/ai/agent.js')), '');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
